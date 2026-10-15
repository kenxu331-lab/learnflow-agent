"""Application settings loaded from environment variables and .env."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the backend service."""

    app_name: str = "LearnFlow Agent"
    app_version: str = "0.1.0"
    environment: str = "development"
    debug: bool = False
    local_host: str = "127.0.0.1"
    local_port: int = 8000
    local_api_token: str | None = None
    max_request_bytes: int = 512 * 1024
    vault_path: str | None = None
    llm_provider: str = "openai_compatible"
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-flash"
    llm_api_key: str | None = None
    llm_timeout_seconds: float = 60.0
    llm_max_output_tokens: int = 2048
    llm_max_context_characters: int = 48_000
    learning_memory_db_path: str = "data/learning_memory.sqlite3"
    study_chat_max_history_messages: int = 20
    study_agent_max_steps: int = 6
    study_agent_timeout_seconds: float = 120.0
    knowledge_profile_id: str = "local-default"
    knowledge_extraction_max_input_tokens: int = 8_000
    knowledge_extraction_max_output_tokens: int = 3_000
    knowledge_extraction_idle_seconds: int = 10
    knowledge_worker_poll_seconds: float = 15.0
    knowledge_network_retry_limit: int = 1
    knowledge_verifier_max_claims: int = 8

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="LEARNFLOW_",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Return the cached application settings instance."""

    return Settings()
