"""DeepSeek/OpenAI-compatible async JSON provider."""

from __future__ import annotations

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
from app.llm.base import LLMCompletion
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
