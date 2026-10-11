"""Local bearer-token authentication."""

from hmac import compare_digest

from fastapi import Depends, HTTPException, Request

from app.core.config import Settings, get_settings


def require_local_token(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> None:
    """Require a configured local token without logging its value."""

    configured_token = settings.local_api_token
    if not configured_token:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "local_token_not_configured",
                "message": "本地服务尚未配置访问密钥。",
            },
        )

    authorization = request.headers.get("authorization", "")
    scheme, separator, provided_token = authorization.partition(" ")
    try:
        token_matches = bool(provided_token) and compare_digest(
            provided_token,
            configured_token,
        )
    except (TypeError, UnicodeError):
        token_matches = False

    if separator != " " or scheme.lower() != "bearer" or not token_matches:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_local_token", "message": "本地访问密钥无效。"},
        )
