"""B/D integration using real S2 storage, scheduler and verifier contracts."""

import asyncio
import json
from unittest.mock import patch

from test_knowledge_s2a import (
    FakeProvider,
    create_event,
    make_settings,
    snapshot_payload,
)
from test_knowledge_s2b import VerificationProvider
from test_readonly_agent import ScriptedTools
from test_study_chat import parse_events

from app.agent.knowledge_tasks import deduplicate
from app.agent.knowledge_tools import KnowledgeTools
from app.knowledge.extractor import KnowledgeExtractor
from app.knowledge.verifier import KnowledgeVerifier
from app.llm.base import LLMToolCall
from app.schemas.knowledge_view import KnowledgeItemView
from app.schemas.study import StudyChatRequest
from app.study_chat.service import StudyChatService


def make_request(question="刚才有哪些知识值得记住？", conversation="conversation-a"):
    snapshot = snapshot_payload()
    return StudyChatRequest.model_validate(
        {
            "schemaVersion": 1,
            "conversationId": conversation,
            "sessionId": "session-a",
            "sourceUrl": snapshot["url"],
            "pageTitle": snapshot["title"],
            "question": question,
            "cloudConsent": True,
            "readonlyAgent": True,
            "knowledgeTools": True,
            "snapshot": snapshot,
        }
    )


async def chat(service, request):
    stream = await service.start_stream(request)
    return parse_events("".join([part async for part in stream]))


def wire_services(settings, provider, verdict="supported"):
    service = StudyChatService(settings, provider=provider)
    knowledge = service.knowledge_tasks.knowledge
    knowledge.extractor = KnowledgeExtractor(settings, FakeProvider())
    knowledge.verifier = KnowledgeVerifier(settings, VerificationProvider(verdict))
    return service


def count(service, table):
    with service.memory.transaction() as connection:
        return connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


async def finish(service):
    knowledge = service.knowledge_tasks.knowledge
    assert await knowledge.run_once()
    service.knowledge_tasks.refresh_pending()
    for row in knowledge.store.unverified_knowledge():
        await knowledge.verify_knowledge(row["knowledge_id"], row["active_version"])
    service.knowledge_tasks.refresh_pending()


def test_b_queues_once_suspends_then_resumes_to_real_verified_candidates(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        provider = ScriptedTools(
            [LLMToolCall("s", "search_knowledge", "{}")],
            [LLMToolCall("e", "extract_knowledge", "{}")],
        )
        service = wire_services(settings, provider)
        events = await chat(service, make_request())
        assert events[-1][0] == "done", events
        first = events[-1][1]["message"]
        assert first["knowledge"]["state"] == "queued"
        assert first["activities"][-1]["type"] == "task_waiting"
        assert len(provider.calls) == 2  # No model polling or extra final call.
        assert count(service, "learning_events") == 1  # Administrative B excluded.
        assert count(service, "extraction_jobs") == 1
        await service.knowledge_tasks.knowledge.run_once()
        service.knowledge_tasks.refresh_pending()
        assert (
            service.knowledge_tasks.view(first["knowledge"]["taskId"]).state
            == "verifying"
        )
        for row in service.knowledge.unverified_knowledge():
            await service.knowledge_tasks.knowledge.verify_knowledge(
                row["knowledge_id"]
            )
        service.knowledge_tasks.refresh_pending()
        restored = service.conversation(make_request().conversationId).messages[-1]
        assert restored.knowledge.state == "completed"
        assert restored.knowledge.items[0].claims[0].verificationStatus == "supported"
        assert restored.knowledge.items[0].publishCandidate is not None
        assert restored.knowledge.items[0].archived is False
        assert count(service, "annotation_write_intents") == 0
        assert not list((tmp_path / "vault").rglob("*.md"))
        assert len(provider.calls) == 2
        before = restored.content
        service.knowledge_tasks.refresh_pending()
        assert (
            service.conversation(make_request().conversationId).messages[-1].content
            == before
        )

    asyncio.run(run())


def test_repeated_b_has_no_new_content_and_does_not_reextract(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        provider = ScriptedTools(
            [LLMToolCall("s", "search_knowledge", "{}")],
            [LLMToolCall("e", "extract_knowledge", "{}")],
        )
        service = wire_services(settings, provider)
        await chat(service, make_request())
        await finish(service)
        provider.rounds = [
            [LLMToolCall("s2", "search_knowledge", "{}")],
            [LLMToolCall("e2", "extract_knowledge", "{}")],
            ["没有新增内容，可查看已有成果。"],
        ]
        events = await chat(service, make_request())
        view = events[-1][1]["message"]["knowledge"]
        assert view["state"] == "no_new_events" and view["noNewContent"]
        assert view["items"]
        assert count(service, "extraction_jobs") == 1
        assert count(service, "learning_events") == 1

    asyncio.run(run())


def test_d_includes_current_understanding_and_public_correction_and_dedupes_retry(
    tmp_path,
):
    settings = make_settings(tmp_path)
    correction = "中间件包装请求与响应处理，并非单纯传递返回值。依据 block-3。"
    question = "中间件就是传递返回值吗？请对照教程检查，再提炼值得保存的内容。"

    async def run():
        provider = ScriptedTools(
            [LLMToolCall("r", "read_learning_context", '{"blockIds":["block-3"]}')],
            [LLMToolCall("s", "search_knowledge", "{}")],
            [
                LLMToolCall(
                    "e", "extract_knowledge", json.dumps({"analysis": correction})
                )
            ],
        )
        service = wire_services(settings, provider)
        events = await chat(service, make_request(question))
        assert events[-1][0] == "done", events
        assert correction in events[-1][1]["message"]["content"]
        job = service.knowledge.list_jobs()[0]
        rows = service.knowledge.job_rows(job["job_id"])
        assert len(rows) == 1 and rows[0]["user_question"] == question
        assert rows[0]["assistant_answer"] == correction
        provider.rounds = [
            [LLMToolCall("r2", "read_learning_context", '{"blockIds":["block-3"]}')],
            [LLMToolCall("s2", "search_knowledge", "{}")],
            [
                LLMToolCall(
                    "e2", "extract_knowledge", json.dumps({"analysis": correction})
                )
            ],
        ]
        repeat = await chat(service, make_request(question))
        assert repeat[-1][0] == "done"
        assert count(service, "learning_events") == 1
        assert count(service, "extraction_jobs") == 1
        assert count(service, "agent_knowledge_tasks") == 1
        await finish(service)
        result = (
            service.conversation(make_request(question).conversationId)
            .messages[-1]
            .knowledge
        )
        assert result.state == "completed"
        assert result.items and result.items[0].publishCandidate is not None
        assert count(service, "annotation_write_intents") == 0

    asyncio.run(run())


def test_restart_recovers_task_reference_without_model_or_resubmitting_job(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
        )
        events = await chat(service, make_request())
        task_id = events[-1][1]["message"]["knowledge"]["taskId"]
        # Crash window after S2 submission but before recording the job reference.
        with service.memory.transaction() as connection:
            connection.execute(
                "UPDATE agent_knowledge_tasks SET state='submitting', job_id=NULL "
                "WHERE task_id=?",
                (task_id,),
            )
        service.memory.close()
        provider = ScriptedTools()
        restarted = wire_services(settings, provider)
        with patch.object(
            restarted.knowledge_tasks.knowledge,
            "trigger",
            wraps=restarted.knowledge_tasks.knowledge.trigger,
        ) as trigger:
            restarted.knowledge_tasks.refresh_pending()
            assert trigger.call_count == 0
        assert count(restarted, "extraction_jobs") == 1
        await finish(restarted)
        message = restarted.conversation(make_request().conversationId).messages[-1]
        assert message.knowledge.taskId == task_id
        assert message.knowledge.state == "completed"
        assert not provider.calls
        assert sum(a.type == "task_completed" for a in message.activities) == 1

    asyncio.run(run())


def test_verification_failure_is_review_not_fake_success(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
            verdict="insufficient_evidence",
        )
        await chat(service, make_request())
        await finish(service)
        view = (
            service.conversation(make_request().conversationId).messages[-1].knowledge
        )
        assert view.state == "needs_review"
        assert view.items[0].publishCandidate is None
        assert view.items[0].claims[0].verificationReason
        assert count(service, "annotation_write_intents") == 0

    asyncio.run(run())


def test_scoped_task_lookup_and_parameters_fail_closed(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
        )
        events = await chat(service, make_request())
        task_id = events[-1][1]["message"]["knowledge"]["taskId"]
        other = make_request(conversation="other")
        tools = KnowledgeTools(
            service.knowledge_tasks, other, "unused", "run", lambda _: None
        )
        assert not tools.invoke(
            "get_extraction_result", json.dumps({"taskId": task_id})
        )["ok"]
        assert not tools.invoke("search_knowledge", '{"chapterId":"other"}')["ok"]
        assert not tools.invoke("extract_knowledge", "{}")["ok"]

    asyncio.run(run())


def test_exact_dedup_keeps_code_distinctions_and_only_marks_similar():
    def item(key, body, archived=False):
        return KnowledgeItemView(
            knowledgeId=key,
            version=1,
            topic="概念",
            kind="concept",
            body=body,
            sourceUrl="https://example.com",
            verificationStatus="supported",
            publishStatus="eligible",
            archived=archived,
        )

    text = "依赖由框架解析调用，并把结果注入参数，复用声明以减少重复代码。" * 3
    items, duplicates = deduplicate(
        [
            item("a", text),
            item("b", text + "\r\n", True),
            item("c", text + "但存在例外。"),
            item("d", "a != b"),
            item("e", "a == b"),
        ]
    )
    assert duplicates == 1 and len(items) == 4
    assert next(i for i in items if i.knowledgeId == "b").duplicateIds == ["a"]
    assert next(i for i in items if i.knowledgeId == "c").similarTo
    assert {i.body for i in items} >= {"a != b", "a == b"}


def test_clicking_again_during_verification_reuses_waiting_task(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        provider = ScriptedTools(
            [LLMToolCall("s", "search_knowledge", "{}")],
            [LLMToolCall("e", "extract_knowledge", "{}")],
        )
        service = wire_services(settings, provider)
        first = await chat(service, make_request())
        task_id = first[-1][1]["message"]["knowledge"]["taskId"]
        await service.knowledge_tasks.knowledge.run_once()
        provider.rounds = [
            [LLMToolCall("s2", "search_knowledge", "{}")],
            [LLMToolCall("e2", "extract_knowledge", "{}")],
        ]
        second = await chat(service, make_request())
        view = second[-1][1]["message"]["knowledge"]
        assert view["taskId"] == task_id and view["state"] == "verifying"
        assert not view["noNewContent"]
        assert count(service, "extraction_jobs") == 1

    asyncio.run(run())


def test_failed_extraction_reports_real_error_without_publishing(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
        )
        service.knowledge_tasks.knowledge.extractor = KnowledgeExtractor(
            settings, FakeProvider(fake_evidence=True)
        )
        await chat(service, make_request())
        await service.knowledge_tasks.knowledge.run_once()
        service.knowledge_tasks.refresh_pending()
        result = (
            service.conversation(make_request().conversationId).messages[-1].knowledge
        )
        assert result.state == "failed"
        assert "证据" in result.message
        assert not result.items
        assert count(service, "annotation_write_intents") == 0

    asyncio.run(run())


def test_new_batch_waits_for_older_batch_instead_of_overlapping_jobs(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        provider = ScriptedTools(
            [LLMToolCall("s", "search_knowledge", "{}")],
            [LLMToolCall("e", "extract_knowledge", "{}")],
        )
        service = wire_services(settings, provider)
        await chat(service, make_request())
        provider.rounds = [
            [LLMToolCall("r2", "read_learning_context", "{}")],
            [LLMToolCall("s2", "search_knowledge", "{}")],
            [
                LLMToolCall(
                    "e2",
                    "extract_knowledge",
                    json.dumps(
                        {"analysis": "中间件包装请求与响应处理，依据 block-3。"}
                    ),
                )
            ],
        ]
        second = await chat(service, make_request("再检查当前理解并提炼"))
        assert second[-1][1]["message"]["knowledge"]["state"] == "waiting_previous"
        assert count(service, "extraction_jobs") == 1
        await finish(service)
        jobs = service.knowledge.list_jobs()
        assert len(jobs) == 2
        assert sum(job["state"] == "queued" for job in jobs) == 1
        assert count(service, "agent_knowledge_tasks") == 2

    asyncio.run(run())


def test_registered_submission_survives_a_crash_before_queueing(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
        )
        with patch.object(
            service.knowledge_tasks.knowledge,
            "trigger",
            side_effect=RuntimeError("simulated crash"),
        ):
            events = await chat(service, make_request())
            assert events[-1][0] == "error"
        assert count(service, "extraction_jobs") == 0
        service.memory.close()
        provider = ScriptedTools()
        restarted = wire_services(settings, provider)
        message = restarted.conversation(make_request().conversationId).messages[-1]
        assert message.knowledge.state == "queued"
        assert count(restarted, "extraction_jobs") == 1
        assert not provider.calls

    asyncio.run(run())


def test_vault_change_fails_pending_task_without_cross_scope_results(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        service = wire_services(
            settings,
            ScriptedTools(
                [LLMToolCall("s", "search_knowledge", "{}")],
                [LLMToolCall("e", "extract_knowledge", "{}")],
            ),
        )
        await chat(service, make_request())
        other_vault = tmp_path / "other-vault"
        (other_vault / ".obsidian").mkdir(parents=True)
        settings.vault_path = str(other_vault)
        service.knowledge_tasks.refresh_pending()
        result = (
            service.memory.conversation(make_request().conversationId)
            .messages[-1]
            .knowledge
        )
        assert result.state == "failed" and "范围" in result.message
        assert not result.items
        assert count(service, "annotation_write_intents") == 0

    asyncio.run(run())


def test_extract_cannot_depend_on_unseen_results_in_same_model_batch(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        provider = ScriptedTools(
            [
                LLMToolCall("r", "read_learning_context", "{}"),
                LLMToolCall("s", "search_knowledge", "{}"),
                LLMToolCall(
                    "e",
                    "extract_knowledge",
                    '{"analysis":"依据原文，中间件包装请求。"}',
                ),
            ],
            [
                LLMToolCall(
                    "e2",
                    "extract_knowledge",
                    '{"analysis":"依据原文，中间件包装请求。"}',
                )
            ],
        )
        service = wire_services(settings, provider)
        events = await chat(service, make_request("检查理解并提炼"))
        assert events[-1][0] == "done"
        observation = json.loads(provider.calls[1][-1]["content"])
        assert not observation["ok"]
        assert count(service, "learning_events") == 1
        assert count(service, "extraction_jobs") == 1

    asyncio.run(run())


def test_failed_batch_is_not_misreported_as_no_new_content_or_resubmitted(tmp_path):
    settings = make_settings(tmp_path)

    async def run():
        await create_event(settings, FakeProvider())
        provider = ScriptedTools(
            [LLMToolCall("s", "search_knowledge", "{}")],
            [LLMToolCall("e", "extract_knowledge", "{}")],
        )
        service = wire_services(settings, provider)
        service.knowledge_tasks.knowledge.extractor = KnowledgeExtractor(
            settings, FakeProvider(fake_evidence=True)
        )
        await chat(service, make_request())
        await service.knowledge_tasks.knowledge.run_once()
        service.knowledge_tasks.refresh_pending()
        assert (
            service.conversation(make_request().conversationId)
            .messages[-1]
            .knowledge.state
            == "failed"
        )
        service.knowledge_tasks.knowledge.extractor = KnowledgeExtractor(
            settings, FakeProvider()
        )
        provider.rounds = [
            [LLMToolCall("s2", "search_knowledge", "{}")],
            [LLMToolCall("e2", "extract_knowledge", "{}")],
            ["上批提炼失败，请先检查原文证据；未重新提交，未归档。"],
        ]
        second = await chat(service, make_request("请重新提炼刚才的知识"))
        assert second[-1][0] == "done", second
        assert second[-1][1]["message"]["knowledge"]["state"] == "failed"
        assert not second[-1][1]["message"]["knowledge"]["noNewContent"]
        assert json.loads(provider.calls[-2][-1]["content"])["state"] == "failed"
        assert count(service, "extraction_jobs") == 1
        assert count(service, "annotation_write_intents") == 0

    asyncio.run(run())
