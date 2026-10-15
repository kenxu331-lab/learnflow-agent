"""Cross-process advisory locks shared by approved writes on this database."""

import hashlib
import os
import time
from contextlib import contextmanager
from pathlib import Path

from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError


@contextmanager
def archive_mutex(settings: Settings, key: str, timeout: float = 5):
    directory = (
        Path(settings.learning_memory_db_path).resolve().parent / ".archive-locks"
    )
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (hashlib.sha256(key.encode()).hexdigest() + ".lock")
    with path.open("a+b") as handle:
        # Windows permits byte locks beyond EOF. Do not initialize a sentinel:
        # another process may already hold that byte when this handle opens.
        started = time.monotonic()
        acquired = False
        while not acquired:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError as error:
                if time.monotonic() - started >= timeout:
                    raise KnowledgeServiceError(
                        "archive_busy", "该归档正在处理，请稍后查看结果。", 409
                    ) from error
                time.sleep(0.02)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
