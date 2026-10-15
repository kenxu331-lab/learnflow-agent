"""Current-conversation tools; identifiers and permissions are application-owned."""

import json
from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError

from app.agent.knowledge_tasks import PENDING, KnowledgeTasks
from app.archive.confirmations import ArchiveConfirmations
from app.knowledge.errors import KnowledgeServiceError
from app.notes.resolver import NoteResolver
from app.schemas.archive import KnowledgeReference
from app.schemas.knowledge_view import KnowledgeTaskView
from app.schemas.study import StudyChatRequest


class SearchArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: StrictStr = Field(default="", max_length=200)


class ExtractArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    analysis: StrictStr = Field(
        default="",
        max_length=8_000,
        description="复合任务先对照教程给出的公开解释/纠正；仅整理已有对话时留空。不是内部思维链。",
    )


class ResultArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskId: StrictStr = Field(default="", max_length=200)


class ArchiveArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    references: list[KnowledgeReference] = Field(default_factory=list, max_length=10)


MODELS = {
    "search_knowledge": SearchArguments,
    "extract_knowledge": ExtractArguments,
    "get_extraction_result": ResultArguments,
    "prepare_archive": ArchiveArguments,
}
DESCRIPTIONS = {
    "search_knowledge": "查询本章知识与未提炼内容。先查再决定是否提炼。",
    "extract_knowledge": "提交未处理对话。先查询，复合任务先读原文并提供 analysis。",
    "get_extraction_result": "读取本会话任务真实进度；等待时由应用恢复，勿轮询。",
    "prepare_archive": "生成归档 Diff 和确认卡片；空列表使用已选知识，不能写入。",
}
KNOWLEDGE_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": name,
            "description": DESCRIPTIONS[name],
            "parameters": model.model_json_schema(),
        },
    }
    for name, model in MODELS.items()
    if name != "prepare_archive"
]


class KnowledgeTools:
    def __init__(
        self,
        tasks: KnowledgeTasks,
        request: StudyChatRequest,
        message_id: str,
        run_id: str,
        record_analysis: Callable[[str], None],
        archive: ArchiveConfirmations | None = None,
    ):
        self.tasks = tasks
        self.request = request
        self.chapter_id = (
            NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
        )
        self.scope_id = tasks.knowledge.store.resolve_scope().scope_id
        self.message_id = message_id
        self.run_id = run_id
        self.record_analysis = record_analysis
        self.used = False
        self.searched = False
        self.read_source = False
        self.observed_search = False
        self.observed_source = False
        self.waiting = False
        self.view: KnowledgeTaskView | None = None
        self.archive = archive
        self.confirmation = None
        self.exposed_refs: set[tuple[str, int]] = set()
        self.observed_refs: set[tuple[str, int]] = set()

    def definitions(self):
        return KNOWLEDGE_TOOL_DEFINITIONS + (
            [
                {
                    "type": "function",
                    "function": {
                        "name": "prepare_archive",
                        "description": DESCRIPTIONS["prepare_archive"],
                        "parameters": ArchiveArguments.model_json_schema(),
                    },
                }
            ]
            if self.archive
            else []
        )

    def begin_step(self) -> None:
        # Calls in one model batch cannot depend on unseen results in that batch.
        self.observed_search = self.searched
        self.observed_source = self.read_source
        self.observed_refs = set(self.exposed_refs)

    def validate(self, name: str, arguments: str):
        try:
            return MODELS[name].model_validate_json(arguments)
        except (ValidationError, KeyError):
            return None

    def invoke(self, name: str, arguments: str) -> dict:
        args = self.validate(name, arguments)
        if args is None:
            return {
                "ok": False,
                "message": "知识工具参数无效，不能指定其他章节或会话。",
            }
        if self.scope_id != self.tasks.knowledge.store.resolve_scope().scope_id:
            return {"ok": False, "message": "Vault 范围已变化，本次工具调用已停止。"}
        self.used = True
        try:
            if name == "prepare_archive":
                if self.archive is None:
                    return {"ok": False, "message": "本请求未启用归档预览。"}
                selected, _ = self.archive.selection(self.request.conversationId)
                selected_set = {(r.knowledgeId, r.version) for r in selected}
                requested = {(r.knowledgeId, r.version) for r in args.references}
                if requested and (
                    not requested.issubset(self.observed_refs)
                    or (selected_set and requested != selected_set)
                ):
                    return {
                        "ok": False,
                        "message": "不能猜测或替换选择，请先查询或重新勾选。",
                    }
                self.confirmation = self.archive.prepare(
                    self.request.conversationId, args.references, self.message_id
                )
                return {
                    "ok": True,
                    "confirmationId": self.confirmation.confirmationId,
                    "state": self.confirmation.state,
                    "message": self.confirmation.message,
                    "targetRelativePath": self.confirmation.targetRelativePath,
                    "knowledgeIds": [p.knowledgeId for p in self.confirmation.plans],
                    "instruction": "必须等待用户在真实确认卡片点击确认，尚未归档。",
                }
            if name == "search_knowledge":
                self.searched = True
                self.view = self.tasks.query(
                    self.request.conversationId,
                    self.chapter_id,
                    self.request.sourceUrl,
                    args.query,
                )
            elif name == "extract_knowledge":
                if not self.observed_search:
                    return {
                        "ok": False,
                        "message": "请先 search_knowledge，避免重复提炼已有内容。",
                    }
                if args.analysis:
                    if not self.observed_source:
                        return {
                            "ok": False,
                            "message": "请先读取教程核对理解，再提交公开分析。",
                        }
                    self.record_analysis(args.analysis)
                self.view = self.tasks.submit(
                    conversation_id=self.request.conversationId,
                    chapter_id=self.chapter_id,
                    source_url=self.request.sourceUrl,
                    message_id=self.message_id,
                    run_id=self.run_id,
                )
            else:
                with self.tasks.memory.transaction() as connection:
                    row = connection.execute(
                        "SELECT * FROM agent_knowledge_tasks WHERE scope_id=? "
                        "AND chapter_id=? AND conversation_id=? "
                        + ("AND task_id=? " if args.taskId else "")
                        + "ORDER BY created_at DESC LIMIT 1",
                        (
                            self.scope_id,
                            self.chapter_id,
                            self.request.conversationId,
                            args.taskId,
                        )
                        if args.taskId
                        else (
                            self.scope_id,
                            self.chapter_id,
                            self.request.conversationId,
                        ),
                    ).fetchone()
                if row is None:
                    return {"ok": False, "message": "当前会话没有对应的知识任务。"}
                self.tasks.refresh(row["task_id"])
                self.view = self.tasks.view(row["task_id"])
            self.tasks.save_view(self.message_id, self.view)
            self.waiting = self.view.state in PENDING
            state = self.tasks.input_state(self.request.conversationId, self.chapter_id)
            if (
                name == "search_knowledge"
                and not args.query
                and not self.view.items
                and not state["hasNewContent"]
            ):
                failed = self.tasks.current_failure(
                    self.request.conversationId, self.chapter_id, state["target"][1]
                )
                if failed:
                    self.view = failed
                else:
                    self.view.state = "no_new_events"
                    self.view.noNewContent = True
                    self.view.message = "没有新的可提炼内容，也没有已保存的知识候选。"
                self.tasks.save_view(self.message_id, self.view)
            # Bound model context; full bodies/claims remain in the real UI payload.
            data = self.view.model_dump(mode="json", exclude={"items"})
            data["items"] = [
                {
                    "knowledgeId": item.knowledgeId,
                    "version": item.version,
                    "topic": item.topic,
                    "body": item.body[:1200],
                    "verificationStatus": item.verificationStatus,
                    "publishStatus": item.publishStatus,
                    "archived": item.archived,
                    "duplicateIds": item.duplicateIds,
                    "similarTo": item.similarTo,
                    "claimReasons": [claim.verificationReason for claim in item.claims][
                        :8
                    ],
                }
                for item in self.view.items[:8]
            ]
            data.update(
                ok=True,
                hasNewContent=state["hasNewContent"],
                canExtract=state["bound"],
                waiting=self.waiting,
                instruction="等待状态由应用恢复，勿轮询；本工具没有归档权限。",
            )
            # Avoid a surprisingly large model tool result from long reasons.
            while len(json.dumps(data, ensure_ascii=False)) > 16_000 and data["items"]:
                data["items"].pop()
            data["itemsTruncated"] = len(data["items"]) < len(self.view.items)
            self.exposed_refs.update(
                (item["knowledgeId"], item["version"]) for item in data["items"]
            )
            if self.archive:
                data["selectedKnowledge"] = [
                    ref.model_dump()
                    for ref in self.archive.selection(self.request.conversationId)[0]
                ]
            return data
        except KnowledgeServiceError as error:
            return {"ok": False, "code": error.code, "message": error.message}
