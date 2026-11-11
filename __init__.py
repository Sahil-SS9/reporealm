"""RepoRealm - a reading-comprehension chamber built from a real codebase.

Hermes plugin surface (nothing else is registered, nothing is written outside the
runtime cache):

* tool ``reporealm_chambers`` - read-only analysis of a repository, returning
  the ``schema_version = 1`` payload as a JSON string;
* command ``/reporealm`` - ``/reporealm <repo>`` analyses the repository,
  exports the game and starts a managed loopback server; ``/reporealm stop``
  and ``/reporealm status`` manage those servers.

The plugin owns no game logic: it calls :mod:`sourcedrive.cli` (the internal
implementation package), the same code path the CLI uses, so a behaviour verified
by the CLI tests is the behaviour the plugin gets.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent

TOOL_NAME = "reporealm_chambers"
TOOLSET = "reporealm"
COMMAND_NAME = "reporealm"
DEFAULT_PORT = 7788

TOOL_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Analyse a local git/working repository and return RepoRealm chambers grounded in "
        "its real import graph: the front door (entry manifest / __main__ guard), dependency "
        "routing (which modules import a subject), and the guard (which test module reaches a "
        "module). Read-only: repository code is parsed, never imported or executed. Returns the "
        "schema_version 1 payload as JSON. Static import evidence is not proof that a test "
        "detects a behavioural regression."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "repo": {
                "type": "string",
                "description": "Absolute path to the repository to analyse (read-only).",
            }
        },
        "required": ["repo"],
        "additionalProperties": False,
    },
}

_HELP = (
    "RepoRealm\n"
    "  /reporealm <repo>            analyse a repository and serve its chamber on loopback\n"
    "  /reporealm <repo> --port N   use a specific port (7788 by default)\n"
    "  /reporealm stop [--all]      stop managed servers (verified by /healthz identity)\n"
    "  /reporealm status            list known servers and whether they answer\n"
    "Offline export: python -m reporealm export <repo> --out game.html"
)


def _backend():
    """Import the backend package, whether the plugin is loaded as a package or a path.

    The submodules used by this plugin are imported explicitly so
    ``backend.cli`` / ``backend.toolapi`` work regardless of import order.
    """
    package = __package__ or ""
    module = None
    if package:
        try:
            module = importlib.import_module(f"{package}.sourcedrive")
        except ImportError:
            module = None
    if module is None:
        if str(_PLUGIN_DIR) not in sys.path:
            sys.path.insert(0, str(_PLUGIN_DIR))
        module = importlib.import_module("sourcedrive")
    for name in ("cli", "toolapi", "cache", "server"):
        importlib.import_module(f"{module.__name__}.{name}")
    return module


# ── tool ────────────────────────────────────────────────────────────────────


def handle_chambers(args, **_context):
    """Tool handler: always returns a JSON string, never raises into the agent loop."""
    try:
        payload = args if isinstance(args, dict) else {}
        repo = str(payload.get("repo") or "").strip()
        if not repo:
            return json.dumps(
                {"error": "repo is required: pass an absolute path to a local repository"}
            )
        backend = _backend()
        return backend.toolapi.chambers_json(repo)
    except Exception as exc:  # noqa: BLE001 - a tool must degrade, not explode
        return json.dumps({"error": f"reporealm analysis failed: {exc}"})


# ── command ─────────────────────────────────────────────────────────────────


def _parse_play_args(raw: str) -> tuple[str, int]:
    """Parse ``<repo> [--port N]`` strictly; any bad token is a ValueError.

    Quoted repository paths are supported (shlex). Unknown flags, extra
    positional words, missing/invalid port values and unterminated quotes all
    raise instead of silently defaulting.
    """
    import shlex

    raw = (raw or "").strip()
    if not raw:
        raise ValueError("a repository path is required")
    try:
        tokens = shlex.split(raw)
    except ValueError as exc:
        raise ValueError(f"could not parse command: {raw!r} ({exc})") from exc
    repo_parts: list[str] = []
    port = DEFAULT_PORT
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in {"--port", "-p"}:
            if index + 1 >= len(tokens):
                raise ValueError("--port requires a number")
            try:
                port = int(tokens[index + 1])
            except ValueError as exc:
                raise ValueError(f"invalid --port value: {tokens[index + 1]!r}") from exc
            if not 1 <= port <= 65535:
                raise ValueError(f"--port out of range 1..65535: {port}")
            index += 2
            continue
        if token.startswith("--port="):
            value = token.partition("=")[2]
            try:
                port = int(value)
            except ValueError as exc:
                raise ValueError(f"invalid --port value: {value!r}") from exc
            if not 1 <= port <= 65535:
                raise ValueError(f"--port out of range 1..65535: {port}")
            index += 1
            continue
        if token.startswith("-"):
            raise ValueError(f"unknown option: {token}")
        repo_parts.append(token)
        index += 1
    if not repo_parts:
        raise ValueError("a repository path is required")
    if len(repo_parts) > 1:
        raise ValueError(f"unexpected extra arguments: {' '.join(repo_parts[1:])!r}")
    repo = repo_parts[0]
    if not repo:
        repo = os.environ.get("TERMINAL_CWD") or os.getcwd()
    return repo, port


def _parse_stop_args(raw: str) -> tuple[int | None, bool]:
    """Parse ``stop [--all] [--port N]``; bad input raises ValueError."""
    import shlex

    try:
        tokens = shlex.split((raw or "").strip())
    except ValueError as exc:
        raise ValueError(f"could not parse stop command: {raw!r} ({exc})") from exc
    everything = False
    port: int | None = None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--all":
            everything = True
            index += 1
            continue
        if token in {"--port", "-p"}:
            if index + 1 >= len(tokens):
                raise ValueError("--port requires a number")
            try:
                port = int(tokens[index + 1])
            except ValueError as exc:
                raise ValueError(f"invalid --port value: {tokens[index + 1]!r}") from exc
            if not 1 <= port <= 65535:
                raise ValueError(f"--port out of range 1..65535: {port}")
            index += 2
            continue
        if token.startswith("--port="):
            value = token.partition("=")[2]
            try:
                port = int(value)
            except ValueError as exc:
                raise ValueError(f"invalid --port value: {value!r}") from exc
            if not 1 <= port <= 65535:
                raise ValueError(f"--port out of range 1..65535: {port}")
            index += 1
            continue
        if token.startswith("-"):
            raise ValueError(f"unknown option: {token}")
        raise ValueError(f"unexpected argument for stop: {token!r}")
    return port, everything


def handle_command(raw_args: str) -> str:
    """Slash-command handler: one positional string in, one message string out."""
    raw = (raw_args or "").strip()
    if raw in {"", "help", "--help", "-h"}:
        return _HELP
    try:
        head, _, tail = raw.partition(" ")
        if head == "stop":
            # Parse strictly before touching the backend: a bad stop spec must
            # never widen into "stop everything" or silence-parse to defaults.
            port, everything = _parse_stop_args(tail.strip())
            backend = _backend()
            return _handle_stop(backend, port, everything)
        if head == "status":
            return _handle_status(_backend())
        repo, port = _parse_play_args(raw)
        result = _backend().cli.play_repo(repo, port=port, background=True)
        return _format_play(result)
    except Exception as exc:  # noqa: BLE001 - a slash command reports, it does not crash
        return f"reporealm: {exc}"


def _format_play(result) -> str:
    state = "already running" if result.reused else "started"
    lines = [
        f"RepoRealm - {Path(result.repo).name} ({state})",
        f"  {result.level_count} levels from {result.module_count} modules",
        f"  fingerprint {result.fingerprint}",
        f"  URL: {result.url}",
    ]
    if result.background:
        lines.append(f"  stop: /reporealm stop --port {result.port}")
    return "\n".join(lines)


def _handle_stop(backend, port: int | None, everything: bool) -> str:
    root = backend.cache.cache_root(None)
    records = backend.cli.select_records(root, port=port, everything=everything)
    if not records:
        return "reporealm: no managed servers found"
    results = backend.cli.stop_records(records, timeout=5.0)
    return "\n".join(
        f"{entry['result']}: {entry['repo']} (port {entry['port']}, pid {entry['pid']})"
        for entry in results
    )


def _handle_status(backend) -> str:
    root = backend.cache.cache_root(None)
    records = backend.cache.iter_instances(root)
    if not records:
        return "reporealm: no managed servers"
    lines = []
    for _, record in records:
        port = int(record.get("port") or 0)
        identity = backend.server.probe_health(port) if port else None
        healthy = bool(identity) and identity.get("pid") == record.get("pid")
        lines.append(
            f"[{'healthy' if healthy else 'down'}] port {port} pid {record.get('pid')} {record.get('repo')}"
        )
    return "\n".join(lines)


# ── registration ────────────────────────────────────────────────────────────


def register(ctx) -> None:
    """Register the tool and the slash command with the real Hermes PluginContext."""
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema=TOOL_SCHEMA,
        handler=handle_chambers,
        description="Analyse a repository into RepoRealm chambers (read-only).",
        emoji="\U0001f9ea",
    )
    ctx.register_command(
        COMMAND_NAME,
        handle_command,
        description="Build a first-person reading chamber from a repository and serve it locally",
        args_hint="<repo | stop | status>",
    )
