"""DeepSeek/OpenAI-compatible async JSON provider."""

from __future__ import annotations

from collections.abc import AsyncIterator

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)

from app.core.config import Settings
from app.llm.base import LLMCompletion, LLMToolCall
from app.llm.errors import LLMProviderError


class OpenAICompatibleProvider:
    """Call a fixed, configured OpenAI-compatible endpoint in JSON mode."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = settings.llm_model

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int,
    ) -> LLMCompletion:
        if self.settings.llm_provider != "openai_compatible":
            raise LLMProviderError(
                "llm_not_configured",
                "当前 LLM Provider 配置不受支持。",
                503,
            )
        if not self.settings.llm_api_key:
            raise LLMProviderError(
                "llm_not_configured",
                "未配置 LLM API Key，请在后端环境中配置。",
                503,
            )

        client: AsyncOpenAI | None = None
        try:
            try:
                client = AsyncOpenAI(
                    api_key=self.settings.llm_api_key,
                    base_url=self.settings.llm_base_url,
                    timeout=self.settings.llm_timeout_seconds,
                    max_retries=0,
                )
            except (TypeError, ValueError) as error:
                raise LLMProviderError(
                    "llm_invalid_config",
                    "LLM Provider 配置无效，请检查 Base URL 和超时设置。",
                    503,
                ) from error
            response = await client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                extra_body={"thinking": {"type": "disabled"}},
                max_tokens=max_output_tokens,
            )
        except LLMProviderError:
            raise
        except (AuthenticationError, PermissionDeniedError) as error:
            raise LLMProviderError(
                "llm_auth_failed",
                "LLM API 鉴权失败，请检查后端 API Key。",
                502,
            ) from error
        except RateLimitError as error:
            raise LLMProviderError(
                "llm_rate_limited",
                "LLM 服务当前受到限流，请稍后重试。",
                429,
            ) from error
        except APITimeoutError as error:
            raise LLMProviderError(
                "llm_timeout",
                "LLM 服务请求超时，请稍后重试。",
                504,
            ) from error
        except APIConnectionError as error:
            raise LLMProviderError(
                "llm_unavailable",
                "无法连接 LLM 服务，请检查网络或服务地址。",
                503,
            ) from error
        except APIStatusError as error:
            status_code = getattr(error, "status_code", None)
            if isinstance(status_code, int) and status_code == 429:
                raise LLMProviderError(
                    "llm_rate_limited",
                    "LLM 服务当前受到限流，请稍后重试。",
                    429,
                ) from error
            raise LLMProviderError(
                "llm_upstream_error",
                "LLM 服务暂时不可用，请稍后重试。",
                502,
            ) from error
        except Exception as error:
            raise LLMProviderError(
                "llm_upstream_error",
                "LLM 服务处理失败，请稍后重试。",
                502,
            ) from error
        finally:
            if client is not None:
                try:
                    await client.close()
                except Exception:
                    pass

        if not response.choices:
            raise LLMProviderError(
                "llm_empty_response",
                "LLM 返回了空响应。",
                502,
            )
        choice = response.choices[0]
        content = choice.message.content
        if not isinstance(content, str) or not content.strip():
            raise LLMProviderError(
                "llm_empty_response",
                "LLM 返回了空内容。",
                502,
            )
        usage = None
        if response.usage is not None:
            usage = {
                key: int(value)
                for key, value in {
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                }.items()
                if value is not None
            }
        return LLMCompletion(
            content=content,
            finish_reason=choice.finish_reason,
            usage=usage,
        )

    async def stream_chat(
        self,
        *,
        messages: list[dict[str, str]],
        max_output_tokens: int,
    ) -> AsyncIterator[str]:
        """Stream a normal DeepSeek/OpenAI-compatible chat completion."""

        async for item in self._stream_completion(
            messages=messages, max_output_tokens=max_output_tokens
        ):
            if isinstance(item, str):
                yield item

    def stream_agent(
        self, *, messages: list[dict], tools: list[dict], max_output_tokens: int
    ) -> AsyncIterator[str | LLMToolCall]:
        return self._stream_completion(
            messages=messages, tools=tools, max_output_tokens=max_output_tokens
        )

    async def _stream_completion(
        self,
        *,
        messages: list[dict],
        max_output_tokens: int,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[str | LLMToolCall]:

        if self.settings.llm_provider != "openai_compatible":
            raise LLMProviderError(
                "llm_not_configured",
                "当前 LLM Provider 配置不受支持。",
                503,
            )
        if not self.settings.llm_api_key:
            raise LLMProviderError(
                "llm_not_configured",
                "未配置 LLM API Key，请在后端环境中配置。",
                503,
            )

        client: AsyncOpenAI | None = None
        try:
            try:
                client = AsyncOpenAI(
                    api_key=self.settings.llm_api_key,
                    base_url=self.settings.llm_base_url,
                    timeout=self.settings.llm_timeout_seconds,
                    max_retries=0,
                )
            except (TypeError, ValueError) as error:
                raise LLMProviderError(
                    "llm_invalid_config",
                    "LLM Provider 配置无效，请检查 Base URL 和超时设置。",
                    503,
                ) from error

            response = await client.chat.completions.create(
                model=self.model,
                messages=messages,
                stream=True,
                extra_body={"thinking": {"type": "disabled"}},
                max_tokens=max_output_tokens,
                **({"tools": tools, "tool_choice": "auto"} if tools else {}),
            )
            calls: dict[int, dict[str, str]] = {}
            finish_reason = None
            async for chunk in response:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                content = choice.delta.content
                if isinstance(content, str) and content:
                    yield content
                if tools:
                    for delta in getattr(choice.delta, "tool_calls", None) or []:
                        if delta.index not in calls:
                            if len(calls) >= 4:
                                raise LLMProviderError(
                                    "agent_invalid_call", "模型单步工具调用过多。", 502
                                )
                            calls[delta.index] = {"id": "", "name": "", "arguments": ""}
                        call = calls[delta.index]
                        call["id"] += delta.id or ""
                        if delta.function:
                            call["name"] += delta.function.name or ""
                            call["arguments"] += delta.function.arguments or ""
                        if (
                            len(call["arguments"]) > 8192
                            or len(call["name"]) > 100
                            or len(call["id"]) > 200
                        ):
                            raise LLMProviderError(
                                "agent_invalid_call", "模型工具参数超过限制。", 502
                            )
            if tools:
                if finish_reason not in {"stop", "tool_calls"}:
                    raise LLMProviderError(
                        "agent_incomplete_response",
                        "模型响应未完整结束，未执行工具。",
                        502,
                    )
                if calls and finish_reason != "tool_calls":
                    raise LLMProviderError(
                        "agent_invalid_call", "模型工具调用未完整结束。", 502
                    )
                for call in calls.values():
                    if not call["id"] or not call["name"]:
                        raise LLMProviderError(
                            "agent_invalid_call", "模型返回了无效工具调用。", 502
                        )
                    yield LLMToolCall(call["id"], call["name"], call["arguments"])
        except LLMProviderError:
            raise
        except (AuthenticationError, PermissionDeniedError) as error:
            raise LLMProviderError(
                "llm_auth_failed",
                "LLM API 鉴权失败，请检查后端 API Key。",
                502,
            ) from error
        except RateLimitError as error:
            raise LLMProviderError(
                "llm_rate_limited",
                "LLM 服务当前受到限流，请稍后重试。",
                429,
            ) from error
        except APITimeoutError as error:
            raise LLMProviderError(
                "llm_timeout",
                "LLM 服务请求超时，请稍后重试。",
                504,
            ) from error
        except APIConnectionError as error:
            raise LLMProviderError(
                "llm_unavailable",
                "无法连接 LLM 服务，请检查网络或服务地址。",
                503,
            ) from error
        except APIStatusError as error:
            status_code = getattr(error, "status_code", None)
            if isinstance(status_code, int) and status_code == 429:
                raise LLMProviderError(
                    "llm_rate_limited",
                    "LLM 服务当前受到限流，请稍后重试。",
                    429,
                ) from error
            raise LLMProviderError(
                "llm_upstream_error",
                "LLM 服务暂时不可用，请稍后重试。",
                502,
            ) from error
        except Exception as error:
            raise LLMProviderError(
                "llm_upstream_error",
                "LLM 服务处理失败，请稍后重试。",
                502,
            ) from error
        finally:
            if client is not None:
                try:
                    await client.close()
                except Exception:
                    pass
