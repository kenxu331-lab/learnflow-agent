"""M2 step 1: native tools, bounded read access, real events and restoration."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from test_study_chat import HEADERS, FakeChatProvider, chat_payload, parse_events

from app.agent.readonly import ContextArguments, ReadonlyAgent, read_learning_context
from app.api import study as study_api
from app.core.config import Settings, get_settings
from app.learning_memory.store import LearningMemoryStore
from app.llm.base import LLMToolCall
from app.llm.errors import LLMProviderError
from app.llm.openai_compatible import OpenAICompatibleProvider
from app.main import app
from app.schemas.study import StudyChatRequest
from app.study_chat.service import StudyChatService


@pytest.fixture(autouse=True)
def local_token(monkeypatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", "test-local-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class ScriptedTools:
    model = "scripted-tools"

    def __init__(self, *rounds):
        self.rounds = list(rounds)
        self.calls = []
        self.closed = 0

    async def stream_agent(self, *, messages, tools, max_output_tokens):
        assert tools[0]["function"]["name"] == "read_learning_context"
        self.calls.append(list(messages))
        try:
            for item in self.rounds.pop(0):
                yield item
        finally:
            self.closed += 1


def request() -> StudyChatRequest:
    return StudyChatRequest.model_validate(
        {
            **chat_payload(question="结合原文解释代码"),
            "readonlyAgent": True,
        }
    )


def collect(agent, provider):
    async def run():
        return [
            item
            async for item in agent.stream(
                provider,
                [
                    {"role": "system", "content": "old"},
                    {"role": "user", "content": "解释"},
                ],
            )
        ]

    return asyncio.run(run())


def test_context_tool_is_scoped_and_bounded():
    req = request()
    result = read_learning_context(req, ContextArguments(kind="code"))
    assert [b["blockId"] for b in result["blocks"]] == ["code-1"]
    assert result["blocks"][0]["sourceUrl"] == req.sourceUrl
    assert result["blocks"][0]["language"] == "python"
    assert read_learning_context(req, ContextArguments(query="missing"))["blocks"] == []
    assert not read_learning_context(req, ContextArguments(blockIds=["other"]))["ok"]
    req.snapshot.blocks[1].text = "x" * 12_000
    result = read_learning_context(req, ContextArguments())
    assert sum(len(b["text"]) for b in result["blocks"]) <= 12_000
    assert result["blocks"][1]["truncated"]


def test_direct_answer_does_not_fabricate_tool_activity():
    provider = ScriptedTools(["这是直接解释"])
    assert collect(ReadonlyAgent(Settings(_env_file=None), request()), provider) == [
        "这是直接解释"
    ]
    assert provider.closed == 1


def test_agent_mode_does_not_silently_fall_back_to_plain_chat(tmp_path):
    provider = FakeChatProvider()
    service = StudyChatService(
        Settings(
            _env_file=None, learning_memory_db_path=str(tmp_path / "unsupported.db")
        ),
        provider=provider,
    )

    async def run():
        stream = await service.start_stream(request())
        return parse_events("".join([item async for item in stream]))

    events = asyncio.run(run())
    assert events[-1][0] == "error"
    assert events[-1][1]["code"] == "agent_provider_unsupported"
    assert provider.calls == []
    assert (
        service.conversation(request().conversationId).messages[-1].activities[-1].type
        == "task_failed"
    )
    service.memory.close()


@pytest.mark.parametrize(
    "name,arguments,code",
    [
        ("write_file", '{"path":"C:/private"}', "tool_not_allowed"),
        ("read_learning_context", '{"url":"https://other.com"}', "invalid_arguments"),
        ("read_learning_context", '{"kind":2}', "invalid_arguments"),
        ("read_learning_context", "{", "invalid_arguments"),
        ("read_learning_context", '{"blockIds":["other"]}', "block_not_found"),
    ],
)
def test_denied_or_invalid_calls_are_returned_to_model(name, arguments, code):
    provider = ScriptedTools([LLMToolCall("t1", name, arguments)], ["无法读取"])
    events = collect(ReadonlyAgent(Settings(_env_file=None), request()), provider)
    assert events[1].type == "tool_failed"
    observation = json.loads(provider.calls[1][-1]["content"])
    assert observation["code"] == code
    assert len(provider.calls) == 2


def test_repeated_tools_stop_at_step_limit():
    provider = ScriptedTools(
        *[[LLMToolCall(f"t{i}", "read_learning_context", "{}")] for i in range(6)]
    )
    with pytest.raises(LLMProviderError, match="步数限制"):
        collect(ReadonlyAgent(Settings(_env_file=None), request()), provider)
    assert len(provider.calls) == 6


def test_context_budget_stops_before_model_call():
    provider = ScriptedTools(["answer"])
    agent = ReadonlyAgent(
        Settings(_env_file=None, llm_max_context_characters=4096), request()
    )

    async def run():
        return [
            item
            async for item in agent.stream(
                provider,
                [
                    {"role": "system", "content": "old"},
                    {"role": "user", "content": "x" * 5000},
                ],
            )
        ]

    with pytest.raises(LLMProviderError, match="上下文"):
        asyncio.run(run())
    assert provider.calls == []


def test_duplicate_call_ids_are_rejected():
    provider = ScriptedTools(
        [LLMToolCall("t", "read_learning_context", "{}")],
        [LLMToolCall("t", "read_learning_context", "{}")],
    )
    with pytest.raises(LLMProviderError, match="无效"):
        collect(ReadonlyAgent(Settings(_env_file=None), request()), provider)


def test_service_streams_real_activity_and_restores_it(tmp_path, monkeypatch):
    provider = ScriptedTools(
        [LLMToolCall("call-1", "read_learning_context", '{"kind":"code"}')],
        ["依据 code-1，", "这是教程中的代码。"],
    )
    settings = Settings(
        _env_file=None,
        local_api_token="test-local-token",
        learning_memory_db_path=str(tmp_path / "memory.db"),
    )
    service = StudyChatService(settings, provider=provider)
    monkeypatch.setattr(study_api, "service", service)
    client = TestClient(app)
    payload = request().model_dump(mode="json")
    response = client.post("/api/v1/study/chat", json=payload, headers=HEADERS)
    events = parse_events(response.text)
    assert events[-1][0] == "done", events
    activities = [data for name, data in events if name == "activity"]
    assert [a["type"] for a in activities] == [
        "tool_started",
        "tool_finished",
        "task_completed",
    ]
    assert [a["sequence"] for a in activities] == [1, 2, 3]
    assert all(a["sourceUrl"] == payload["sourceUrl"] for a in activities)
    assert "tool_call_id" in provider.calls[1][-1]
    observation = json.loads(provider.calls[1][-1]["content"])
    assert observation["blocks"][0]["blockId"] == "code-1"
    # A new connection reads persisted facts, not an in-memory UI trace.
    restored = LearningMemoryStore(settings.learning_memory_db_path)
    message = restored.conversation(payload["conversationId"]).messages[-1]
    assert [a.model_dump() for a in message.activities] == activities
    assert message.source.sourceUrl == payload["sourceUrl"]
    assert message.content == "依据 code-1，这是教程中的代码。"
    with sqlite3.connect(settings.learning_memory_db_path) as connection:
        for table in ("extraction_jobs", "knowledge_items", "annotation_write_intents"):
            assert (
                connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
            )
    restored.close()
    service.memory.close()


def test_stop_closes_provider_and_persists_incomplete_status(tmp_path):
    provider = ScriptedTools(["部分答案", "后续答案"])
    settings = Settings(
        _env_file=None, learning_memory_db_path=str(tmp_path / "stop.db")
    )
    service = StudyChatService(settings, provider=provider)

    async def run():
        stream = await service.start_stream(request())
        assert "event: delta" in await anext(stream)
        await stream.aclose()

    asyncio.run(run())
    assert provider.closed == 1
    message = service.conversation(request().conversationId).messages[-1]
    assert message.content == "部分答案"
    assert message.activities[-1].type == "task_failed"
    assert not any(a.type == "task_completed" for a in message.activities)
    service.memory.close()


def test_timeout_stops_the_provider():
    class SlowProvider:
        closed = False

        async def stream_agent(self, **kwargs):
            try:
                await asyncio.sleep(2)
                yield "late"
            finally:
                self.closed = True

    provider = SlowProvider()
    with pytest.raises(LLMProviderError, match="超时"):
        collect(
            ReadonlyAgent(
                Settings(_env_file=None, study_agent_timeout_seconds=1), request()
            ),
            provider,
        )
    assert provider.closed


@pytest.mark.parametrize("end_reason", ["tool_calls", "length", None])
def test_native_stream_assembles_arguments_and_closes_client(monkeypatch, end_reason):
    import app.llm.openai_compatible as module

    captured = {}

    class Client:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=self)

        async def create(self, **kwargs):
            captured.update(kwargs)

            async def chunks():
                for name, arguments, call_id, finish in [
                    ("read_learning_", '{"kind":', "call-1", None),
                    ("context", '"code"}', None, None),
                    (None, None, None, end_reason),
                ]:
                    delta = SimpleNamespace(
                        index=0,
                        id=call_id,
                        function=SimpleNamespace(name=name, arguments=arguments),
                    )
                    yield SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                delta=SimpleNamespace(
                                    content=None, tool_calls=[] if finish else [delta]
                                ),
                                finish_reason=finish,
                            )
                        ]
                    )

            return chunks()

        async def close(self):
            captured["closed"] = True

    monkeypatch.setattr(module, "AsyncOpenAI", Client)
    provider = OpenAICompatibleProvider(Settings(_env_file=None, llm_api_key="test"))

    async def run():
        return [
            item
            async for item in provider.stream_agent(
                messages=[], tools=[{"type": "function"}], max_output_tokens=64
            )
        ]

    if end_reason == "tool_calls":
        assert asyncio.run(run()) == [
            LLMToolCall("call-1", "read_learning_context", '{"kind":"code"}')
        ]
    else:
        with pytest.raises(LLMProviderError, match="未完整结束"):
            asyncio.run(run())
    assert captured["tool_choice"] == "auto"
    assert captured["closed"]
