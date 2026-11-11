"""Runtime cache: exports, instance records and logs.

Nothing is ever written inside the plugin package. The runtime directory is
chosen by ``REPOREALM_CACHE`` (or ``$XDG_CACHE_HOME/reporealm``, or
``~/.cache/reporealm``), so the checkout stays read-only at run time. The former
``SOURCE_DRIVE_CACHE`` name is still honoured as an internal legacy alias.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

ENV_CACHE = "REPOREALM_CACHE"
ENV_CACHE_LEGACY = "SOURCE_DRIVE_CACHE"
APP_DIR_NAME = "reporealm"


class CacheError(Exception):
    """The runtime cache directory cannot be created or written."""


def cache_root(explicit: str | os.PathLike[str] | None = None) -> Path:
    if explicit:
        root = Path(explicit).expanduser()
    elif os.environ.get(ENV_CACHE):
        root = Path(os.environ[ENV_CACHE]).expanduser()
    elif os.environ.get(ENV_CACHE_LEGACY):
        root = Path(os.environ[ENV_CACHE_LEGACY]).expanduser()
    elif os.environ.get("XDG_CACHE_HOME"):
        root = Path(os.environ["XDG_CACHE_HOME"]).expanduser() / APP_DIR_NAME
    else:
        root = Path.home() / ".cache" / APP_DIR_NAME
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise CacheError(f"cannot create runtime cache {root}: {exc}") from exc
    if not os.access(root, os.W_OK):
        raise CacheError(f"runtime cache is not writable: {root}")
    return root.resolve()


def _key(fingerprint: str) -> str:
    return fingerprint.split(":", 1)[-1] or "unknown"


def export_dir(root: Path, fingerprint: str) -> Path:
    path = root / "exports" / _key(fingerprint)[:32]
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def instance_dir(root: Path) -> Path:
    path = root / "instances"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def log_dir(root: Path) -> Path:
    path = root / "logs"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def state_path(root: Path, fingerprint: str) -> Path:
    return instance_dir(root) / f"{_key(fingerprint)[:32]}.json"


def log_path(root: Path, fingerprint: str) -> Path:
    return log_dir(root) / f"{_key(fingerprint)[:32]}.log"


def write_json_atomic(path: Path, data: dict) -> None:
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    tmp = None
    try:
        fd, name = tempfile.mkstemp(prefix=".state-", dir=path.parent)
        tmp = Path(name)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError as exc:
        raise CacheError(f"cannot write {path}: {exc}") from exc
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


@contextmanager
def lifecycle_lock(root: Path, timeout: float = 30):
    """Serialise launch/export/state transitions across CLI and plugin callers.

    Foreground callers release after publishing readiness, not after termination.
    Locks are kernel-owned and vanish on process exit, so no stale lock recovery.
    """
    try:
        import fcntl
    except ImportError as exc:
        raise CacheError("managed play currently requires POSIX file locking") from exc
    with (root / ".lifecycle.lock").open("a") as handle:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise CacheError("another RepoRealm lifecycle operation is still running")
                time.sleep(0.05)
        def release():
            fcntl.flock(handle, fcntl.LOCK_UN)
        try:
            yield release
        finally:
            release()


def read_json(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def iter_instances(root: Path) -> list[tuple[Path, dict]]:
    directory = instance_dir(root)
    out: list[tuple[Path, dict]] = []
    for entry in sorted(directory.glob("*.json")):
        data = read_json(entry)
        if data is not None:
            out.append((entry, data))
    return out
