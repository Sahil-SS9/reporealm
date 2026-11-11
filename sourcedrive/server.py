"""Managed loopback game server.

Security posture, in the order the request path enforces it:

* binds ``127.0.0.1`` only — there is no host override;
* serves a **fixed route table** (``/``, ``/game.html``, ``/payload.json``,
  ``/healthz``); a request path is never joined onto a filesystem path, so
  traversal has no surface at all;
* serves only files inside the export directory (an explicit
  ``is_relative_to`` check on every read, even for table entries);
* no directory listing, no repository access, no source files;
* ``/healthz`` returns an identity document (app, version, pid, port,
  fingerprint) so a client can read back exactly what it is talking to.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__

HOST = "127.0.0.1"
IDENTITY_APP = "reporealm"
DEFAULT_PORT = 7788
PORT_SCAN = 20
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}
MAX_ARTEFACT_BYTES = 64 * 1024 * 1024

log = logging.getLogger(__name__)


class ServerError(Exception):
    """The server could not bind, or the artefact directory is unusable."""


def process_start(pid: int) -> str | None:
    """Linux process birth identity; fail closed when it cannot be established."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat.rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def identity_document(*, port: int, fingerprint: str, repo_name: str, modules: int,
                      levels: int, started: str | None = None, start_token: str | None = None) -> dict:
    return {
        "app": IDENTITY_APP,
        "version": __version__,
        "pid": os.getpid(),
        "process_start": process_start(os.getpid()),
        "start_token": start_token or secrets.token_hex(32),
        "host": HOST,
        "port": port,
        "fingerprint": fingerprint,
        "repo": repo_name,
        "module_count": modules,
        "level_count": levels,
        "started": started or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


class _Handler(BaseHTTPRequestHandler):
    server_version = f"reporealm/{__version__}"
    protocol_version = "HTTP/1.1"

    # Injected by :func:`make_server`.
    artefact_dir: Path
    identity: dict
    routes: dict[str, str]

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        log.debug("%s - %s", self.address_string(), format % args)

    # ── helpers ────────────────────────────────────────────────────────────
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data, sort_keys=True).encode("utf-8"), CONTENT_TYPES[".json"])

    def _not_found(self) -> None:
        # Deliberately identical for "unknown route" and "not in the export dir":
        # the server never confirms whether a path exists on this machine.
        self._send_json(404, {"error": "not_found"})

    def _serve_file(self, filename: str) -> None:
        target = (self.artefact_dir / filename).resolve()
        try:
            base = self.artefact_dir.resolve()
        except OSError:
            self._send_json(500, {"error": "artefact_dir_unreadable"})
            return
        if not target.is_relative_to(base) or not target.is_file():
            self._not_found()
            return
        try:
            size = target.stat().st_size
            if size > MAX_ARTEFACT_BYTES:
                self._send_json(500, {"error": "artefact_too_large"})
                return
            body = target.read_bytes()
        except OSError:
            self._send_json(500, {"error": "artefact_unreadable"})
            return
        content_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self._send(200, body, content_type)

    # ── verbs ──────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        authority = f"{HOST}:{self.identity['port']}"
        # Reject rebinding and cross-site reads before *any* route, including health.
        if (self.headers.get_all("Host", []) != [authority]
                or self.headers.get_all("Origin", []) not in ([], [f"http://{authority}"])
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self._send_json(403, {"error": "forbidden_origin"})
            return
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._send_json(200, self.identity)
            return
        if path == "/favicon.ico":
            self._send(204, b"", CONTENT_TYPES[".json"])
            return
        filename = self.routes.get(path)
        if filename is None:
            self._not_found()
            return
        self._serve_file(filename)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
        self.do_GET()


class ManagedServer:
    """Owns one bound socket and one serving thread."""

    def __init__(self, artefact_dir: Path, port: int, identity: dict) -> None:
        self.artefact_dir = Path(artefact_dir)
        if not self.artefact_dir.is_dir():
            raise ServerError(f"artefact directory does not exist: {self.artefact_dir}")
        handler = type(
            "RepoRealmHandler",
            (_Handler,),
            {
                "artefact_dir": self.artefact_dir,
                "identity": dict(identity),
                "routes": {"/": "game.html", "/game.html": "game.html", "/payload.json": "payload.json"},
            },
        )
        self._httpd = ThreadingHTTPServer((HOST, port), handler)
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self._identity = handler.identity
        self._identity["port"] = self.port
        self._thread: threading.Thread | None = None
        self._stopped = False

    @property
    def identity(self) -> dict:
        return dict(self._identity)

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}/"

    def start_background(self) -> None:
        if self._stopped:
            raise ServerError("cannot start a stopped server")
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self.serve_forever, name="reporealm-http", daemon=True)
        self._thread.start()

    def serve_forever(self) -> None:
        self._httpd.serve_forever(poll_interval=0.2)

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        try:
            # BaseServer.shutdown deadlocks if serve_forever was never entered.
            if self._thread is not None and self._thread.is_alive():
                self._httpd.shutdown()
        except Exception:  # pragma: no cover - shutdown on a dead loop
            pass
        try:
            self._httpd.server_close()
        except Exception:  # pragma: no cover
            pass
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> "ManagedServer":
        self.start_background()
        return self

    def __exit__(self, *exc_info) -> None:
        self.stop()


def probe_health(port: int, timeout: float = 1.5, host: str = HOST) -> dict | None:
    """Return the identity document from ``/healthz`` on *port*, or ``None``."""
    url = f"http://{host}:{port}/healthz"
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=timeout) as response:  # loopback only, never an env proxy
            if response.status != 200:
                return None
            raw = response.read(65536)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("app") != IDENTITY_APP:
        return None
    return data


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HOST, port))
        except OSError:
            return False
    return True


def choose_port(preferred: int = DEFAULT_PORT, scan: int = PORT_SCAN) -> tuple[int, dict | None]:
    """Pick a loopback port.

    Returns ``(port, existing_identity)``. ``existing_identity`` is set when a
    managed RepoRealm server already answers on *preferred*; the caller
    decides whether that instance can be reused (same repository) or must be
    replaced. A port occupied by something that is not ours is skipped, never
    probed further.
    """
    if not 0 < int(preferred) < 65536:
        raise ServerError(f"port out of range: {preferred}")
    identity = probe_health(preferred)
    if identity is not None:
        return preferred, identity
    for candidate in [preferred] + [preferred + offset for offset in range(1, scan + 1)]:
        if candidate > 65535:
            break
        if _port_free(candidate):
            return candidate, None
    raise ServerError(
        f"no free loopback port in {preferred}..{min(65535, preferred + scan)}; "
        "stop the process holding it or pass --port"
    )


def bind_server(artefact_dir: Path, port: int, identity: dict) -> ManagedServer:
    try:
        return ManagedServer(artefact_dir, port, identity)
    except OSError as exc:
        raise ServerError(
            f"cannot bind {HOST}:{port} ({exc.strerror or exc}); "
            "another process is using that port"
        ) from exc


def wait_until_ready(port: int, timeout: float = 10.0, expect: dict | None = None) -> dict | None:
    """Poll ``/healthz`` until it answers (optionally matching *expect*), or ``None``."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        identity = probe_health(port, timeout=min(0.25, max(0.01, deadline - time.monotonic())))
        if identity is not None:
            if expect is None:
                return identity
            if all(identity.get(key) == value for key, value in expect.items()):
                return identity
        time.sleep(0.05)
    return None


def wait_until_closed(port: int, timeout: float = 5.0, host: str = HOST) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.25)
            if sock.connect_ex((host, port)) != 0:
                return True
        time.sleep(0.05)
    # A non-HTTP listener is still live. Missing health is not a closed socket.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((host, port)) != 0
