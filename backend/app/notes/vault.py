"""Vault path, symlink and atomic file operations."""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
from pathlib import Path, PurePosixPath

from app.core.config import Settings
from app.notes.errors import NoteServiceError


def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(
        getattr(metadata, "st_file_attributes", 0) & reparse_flag
    )


class VaultGuard:
    """Constrain all service access to the configured Vault/LearnFlow subtree."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def root(self) -> Path:
        raw_path = self.settings.vault_path
        if not raw_path:
            raise NoteServiceError(
                "vault_not_configured",
                "未配置 LEARNFLOW_VAULT_PATH，请配置一个测试 Obsidian Vault。",
                503,
            )
        root = Path(raw_path)
        if not root.is_absolute() or not root.exists() or not root.is_dir():
            raise NoteServiceError(
                "vault_invalid",
                "LEARNFLOW_VAULT_PATH 必须是已有且可访问的绝对目录。",
                503,
            )
        if _is_reparse_or_symlink(root):
            raise NoteServiceError(
                "vault_unsafe",
                "Vault 根目录不能是符号链接或重解析点。",
                503,
            )
        obsidian = root / ".obsidian"
        if not obsidian.is_dir() or _is_reparse_or_symlink(obsidian):
            raise NoteServiceError(
                "vault_invalid",
                "目标目录不是可识别的 Obsidian Vault；请先在测试目录创建 .obsidian。",
                503,
            )
        return root.resolve()

    def target_path(self, relative_path: str, *, create_parent: bool = False) -> Path:
        root = self.root()
        if "\\" in relative_path or "\x00" in relative_path:
            raise NoteServiceError(
                "unsafe_note_path",
                "目标路径包含不受支持的路径分隔符。",
                422,
            )
        pure = PurePosixPath(relative_path)
        if pure.is_absolute() or not pure.parts or pure.parts[0] != "LearnFlow":
            raise NoteServiceError(
                "unsafe_note_path",
                "目标路径不在 LearnFlow 受控目录内。",
                422,
            )
        if any(part in {"", ".", ".."} for part in pure.parts):
            raise NoteServiceError(
                "unsafe_note_path",
                "目标路径包含非法路径片段。",
                422,
            )
        candidate = root.joinpath(*pure.parts)
        parent = candidate.parent
        self._validate_existing_components(root, candidate)
        resolved_parent = parent.resolve()
        try:
            resolved_parent.relative_to(root)
        except ValueError as exc:
            raise NoteServiceError(
                "unsafe_note_path",
                "目标路径越出 Vault 范围。",
                422,
            ) from exc
        if create_parent:
            try:
                parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise NoteServiceError(
                    "vault_write_failed",
                    "无法创建受控笔记目录。",
                    500,
                ) from exc
            self._validate_existing_components(root, candidate)
        return candidate

    @staticmethod
    def _validate_existing_components(root: Path, candidate: Path) -> None:
        relative = candidate.relative_to(root)
        current = root
        for part in relative.parts:
            current = current / part
            try:
                current.lstat()
            except FileNotFoundError:
                continue
            if _is_reparse_or_symlink(current):
                raise NoteServiceError(
                    "unsafe_note_path",
                    "目标路径包含符号链接或 Windows 重解析点。",
                    422,
                )

    def read_text(self, relative_path: str) -> tuple[Path, str | None, str | None]:
        path = self.target_path(relative_path)
        if not path.exists():
            return path, None, None
        if not path.is_file():
            raise NoteServiceError("note_conflict", "目标路径不是普通文件。", 409)
        try:
            raw = path.read_bytes()
            return path, raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()
        except (OSError, UnicodeDecodeError) as exc:
            raise NoteServiceError(
                "note_unreadable",
                "目标笔记无法安全读取。",
                409,
            ) from exc

    def create(self, relative_path: str, content: str) -> str:
        path = self.target_path(relative_path, create_parent=True)
        temporary_path: str | None = None
        published = False
        try:
            temporary_path = self._write_temporary(path.parent, content)
            # A hard link publishes the completed file without replacing a
            # file that appeared after preview. NTFS supports this within the
            # same directory/volume; failure is reported instead of falling
            # back to an overwrite-capable replace operation.
            os.link(temporary_path, path)
            published = True
            try:
                os.unlink(temporary_path)
            except OSError:
                # The target is already safely published. Keep the hidden,
                # same-directory temporary residue rather than reporting a
                # false write failure or deleting the published note.
                pass
            temporary_path = None
            return hashlib.sha256(content.encode("utf-8")).hexdigest()
        except FileExistsError as exc:
            raise NoteServiceError(
                "note_conflict",
                "目标笔记在预览后已存在。",
                409,
            ) from exc
        except OSError as exc:
            raise NoteServiceError(
                "vault_write_failed",
                "无法创建目标笔记。",
                500,
            ) from exc
        finally:
            if not published:
                self._cleanup_temporary(temporary_path)

    @staticmethod
    def _write_temporary(parent: Path, content: str) -> str:
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="",
                dir=parent,
                prefix=".learnflow-",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_path = handle.name
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            return temporary_path
        except OSError:
            VaultGuard._cleanup_temporary(temporary_path)
            raise

    @staticmethod
    def _cleanup_temporary(temporary_path: str | None) -> None:
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass

    def replace(self, relative_path: str, content: str) -> str:
        path = self.target_path(relative_path)
        if not path.exists() or not path.is_file():
            raise NoteServiceError("note_conflict", "目标笔记在预览后已不存在。", 409)
        temporary_path: str | None = None
        try:
            temporary_path = self._write_temporary(path.parent, content)
            os.replace(temporary_path, path)
            temporary_path = None
            return hashlib.sha256(content.encode("utf-8")).hexdigest()
        except OSError as exc:
            raise NoteServiceError(
                "vault_write_failed",
                "无法安全更新目标笔记。",
                500,
            ) from exc
        finally:
            self._cleanup_temporary(temporary_path)
