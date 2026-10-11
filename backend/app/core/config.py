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
