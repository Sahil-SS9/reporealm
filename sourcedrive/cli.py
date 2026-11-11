"""Command line interface: ``python -m reporealm <command>``.

The implementation package is still ``sourcedrive`` (an internal compatibility
identifier); ``python -m sourcedrive`` remains a valid alias for the same CLI.

Commands
--------
``analyse <repo>``   print (or write) the schema_version 1 payload
``export <repo>``    analyse, then build the single-file game via the frontend exporter
``play <repo>``      export into the runtime cache and serve it on loopback
``serve``            internal: serve an already-exported artefact directory
``stop``             terminate managed servers (verified by /healthz identity)
``status``           show known instances and their live health
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from . import __version__, cache, payload as payload_mod, scan as scan_mod, server as server_mod

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
EXPORTER_RELATIVE = Path("scripts") / "build_web.py"
EXPORTER_MARKER = "window.SOURCE_DRIVE_DATA"
# The exporter embeds the payload as an object literal assigned to the marker.
# Requiring the assignment, not the bare name, is what separates a page that
# carries a payload from one that merely mentions it: the game bundle itself reads
# `window.SOURCE_DRIVE_DATA` at boot, so a name match proves nothing on its own.
EXPORTER_ASSIGNMENT_RE = re.compile(
    re.escape(EXPORTER_MARKER) + r"\s*=\s*(?!=)\s*\{(?!\s*\})"
)
SCAN_CHUNK_BYTES = 1024 * 1024
EXPORT_TIMEOUT_S = 300


class CliError(Exception):
    """A user-facing failure (message goes to stderr, exit code 1)."""

    exit_code = 1


class ExporterMissing(CliError):
    exit_code = 2


@dataclass
class ExportResult:
    out_path: Path
    payload: dict
    payload_path: Path | None
    out_bytes: int
    exporter: Path | None


# ── export ──────────────────────────────────────────────────────────────────


def resolve_exporter(explicit: str | None = None) -> Path:
    path = Path(explicit).expanduser() if explicit else PLUGIN_ROOT / EXPORTER_RELATIVE
    if not path.is_file():
        raise ExporterMissing(
            f"frontend exporter not found at {path}. The backend refuses to write a game page "
            "it does not own; re-run with --payload-only to emit just the payload, or --exporter "
            "to point at the exporter."
        )
    return path


def _dump_payload(payload: dict) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=True, allow_nan=False) + "\n"


def write_payload_file(payload: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(_dump_payload(payload), encoding="utf-8")
    os.replace(tmp, path)
    return path


def _page_carries_payload(path: Path) -> bool:
    """Does *path* assign the payload marker an object, anywhere in the page?

    The payload is written after the inlined poster and the OFL fonts, so its
    offset is whatever those assets happen to weigh. Inspecting a fixed opening
    window therefore rejects a good export as soon as an asset grows past it, and
    the limit has to move with the assets. The whole page is scanned instead, in
    bounded chunks so a large export is never held in memory twice.
    """
    overlap = len(EXPORTER_MARKER) + 64
    carry = ""
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(SCAN_CHUNK_BYTES)
            if not chunk:
                return False
            window = carry + chunk.decode("utf-8", "replace")
            if EXPORTER_ASSIGNMENT_RE.search(window):
                return True
            carry = window[-overlap:]


def _run_exporter(exporter: Path, payload_path: Path, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(exporter), "--data", str(payload_path), "--out", str(out_path)]
    try:
        completed = subprocess.run(
            cmd, capture_output=True, text=True, timeout=EXPORT_TIMEOUT_S, cwd=str(PLUGIN_ROOT)
        )
    except subprocess.TimeoutExpired as exc:
        raise CliError(f"exporter timed out after {EXPORT_TIMEOUT_S}s: {' '.join(cmd)}") from exc
    except OSError as exc:
        raise CliError(f"cannot run exporter {exporter}: {exc}") from exc
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-12:]
        raise CliError(
            f"exporter failed (exit {completed.returncode}): " + (" | ".join(tail) or "no output")
        )
    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise CliError(f"exporter reported success but wrote no page at {out_path}")
    if not _page_carries_payload(out_path):
        raise CliError(
            f"exported page at {out_path} does not embed {EXPORTER_MARKER}; "
            "refusing to hand back a page that would not load the repository payload"
        )


def export_repo(
    repo: str,
    out: str | Path,
    *,
    exporter: str | None = None,
    payload_out: str | Path | None = None,
    payload_only: bool = False,
) -> ExportResult:
    analysis = payload_mod.analyse(repo)
    data = analysis.payload
    problems = payload_mod.validate_payload(data)
    if problems:
        raise CliError("internal payload validation failed: " + "; ".join(problems[:5]))
    out_path = Path(out).expanduser()
    kept_payload: Path | None = None
    if payload_out:
        kept_payload = write_payload_file(data, Path(payload_out).expanduser())
    if payload_only:
        if kept_payload is None:
            kept_payload = write_payload_file(data, out_path.with_suffix(".payload.json"))
        return ExportResult(
            out_path=kept_payload,
            payload=data,
            payload_path=kept_payload,
            out_bytes=kept_payload.stat().st_size,
            exporter=None,
        )
    exporter_path = resolve_exporter(exporter)
    with tempfile.TemporaryDirectory(prefix="reporealm-export-") as tmpdir:
        payload_path = write_payload_file(data, Path(tmpdir) / "payload.json")
        _run_exporter(exporter_path, payload_path, out_path)
    return ExportResult(
        out_path=out_path,
        payload=data,
        payload_path=kept_payload,
        out_bytes=out_path.stat().st_size,
        exporter=exporter_path,
    )


# ── play / serve ────────────────────────────────────────────────────────────


@dataclass
class PlayResult:
    url: str
    port: int
    fingerprint: str
    artefact_dir: Path
    identity: dict
    reused: bool
    background: bool
    repo: str
    level_count: int
    module_count: int


def _export_into(analysis, artefact_dir: Path, exporter: str | None) -> Path:
    artefact_dir.mkdir(parents=True, exist_ok=True)
    write_payload_file(analysis.payload, artefact_dir / "payload.json")
    game = artefact_dir / "game.html"
    exporter_path = resolve_exporter(exporter)
    _run_exporter(exporter_path, artefact_dir / "payload.json", game)
    return game


def _pid_is_ours(pid: int) -> bool:
    """Best-effort: does *pid* look like a managed RepoRealm server process?"""
    proc = Path(f"/proc/{pid}/cmdline")
    try:
        raw = proc.read_bytes()
    except OSError:
        # No procfs (or no permission): rely on the /healthz identity match.
        return True
    cmdline = raw.replace(b"\0", b" ").decode("utf-8", "replace")
    return "reporealm" in cmdline or "sourcedrive" in cmdline


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _matches(identity: dict | None, record: dict) -> bool:
    """A live probe must agree with the full record, not just app and pid.

    app+pid equality alone can be spoofed by any process that reuses the pid:
    the bound port, fingerprint and (when the record carries one) repo must
    agree too before a stop may act on it.
    """
    if not identity or not isinstance(record, dict):
        return False
    if not (identity.get("app") == server_mod.IDENTITY_APP
            and identity.get("pid") == record.get("pid")
            and identity.get("port") == record.get("port")
            and identity.get("fingerprint")
            and identity.get("fingerprint") == record.get("fingerprint")):
        return False
    # record["repo"] is the scanned path while /healthz["repo"] is a display
    # name; they are different fields on purpose, so they are not compared.
    return True


def _write_state(root: Path, record: dict) -> Path:
    path = cache.state_path(root, record["fingerprint"])
    cache.write_json_atomic(path, record)
    return path


def play_repo(
    repo: str,
    *,
    port: int = server_mod.DEFAULT_PORT,
    background: bool = False,
    cache_dir: str | None = None,
    exporter: str | None = None,
) -> PlayResult:
    analysis = payload_mod.analyse(repo)
    data = analysis.payload
    problems = payload_mod.validate_payload(data)
    if problems:
        raise CliError("internal payload validation failed: " + "; ".join(problems[:5]))
    root = cache.cache_root(cache_dir)
    artefact_dir = cache.export_dir(root, analysis.fingerprint)
    _export_into(analysis, artefact_dir, exporter)
    level_count = len(data["levels"])
    module_count = data["repo"]["module_count"]

    state_file = cache.state_path(root, analysis.fingerprint)
    existing = cache.read_json(state_file)
    if existing:
        identity = server_mod.probe_health(int(existing.get("port") or 0)) if existing.get("port") else None
        if _matches(identity, existing):
            return PlayResult(
                url=f"http://{server_mod.HOST}:{existing['port']}/",
                port=int(existing["port"]),
                fingerprint=analysis.fingerprint,
                artefact_dir=artefact_dir,
                identity=identity or {},
                reused=True,
                background=bool(existing.get("background", False)),
                repo=str(analysis.scan.root),
                level_count=level_count,
                module_count=module_count,
            )
        stop_records([(state_file, existing)], timeout=5.0)

    chosen, foreign = server_mod.choose_port(port)
    if foreign is not None:
        if foreign.get("fingerprint") == analysis.fingerprint:
            record = {
                "pid": foreign.get("pid"),
                "port": foreign.get("port"),
                "fingerprint": analysis.fingerprint,
                "repo": str(analysis.scan.root),
                "artefact_dir": str(artefact_dir),
                "url": f"http://{server_mod.HOST}:{foreign.get('port')}/",
                "background": True,
                "started": foreign.get("started"),
            }
            _write_state(root, record)
            return PlayResult(
                url=record["url"],
                port=int(record["port"]),
                fingerprint=analysis.fingerprint,
                artefact_dir=artefact_dir,
                identity=foreign,
                reused=True,
                background=True,
                repo=str(analysis.scan.root),
                level_count=level_count,
                module_count=module_count,
            )
        raise CliError(
            f"port {port} is held by another RepoRealm instance for a different repository "
            f"({foreign.get('repo')}). Run `python -m reporealm stop --port {port}` or pass --port."
        )

    identity = server_mod.identity_document(
        port=chosen,
        fingerprint=analysis.fingerprint,
        repo_name=data["repo"]["name"],
        modules=module_count,
        levels=level_count,
    )
    if background:
        return _play_background(root, analysis, artefact_dir, chosen, identity, level_count, module_count)
    return _play_foreground(root, analysis, artefact_dir, chosen, identity, level_count, module_count)


def _play_background(root, analysis, artefact_dir, port, identity, level_count, module_count) -> PlayResult:
    log_path = cache.log_path(root, analysis.fingerprint)
    cmd = [
        sys.executable,
        "-m",
        "reporealm",
        "serve",
        "--artefact-dir",
        str(artefact_dir),
        "--port",
        str(port),
        "--fingerprint",
        analysis.fingerprint,
        "--repo-name",
        analysis.payload["repo"]["name"],
        "--module-count",
        str(module_count),
        "--level-count",
        str(level_count),
        "--cache-dir",
        str(root),
    ]
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(PLUGIN_ROOT)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    with open(log_path, "ab") as log_file:
        process = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(PLUGIN_ROOT),
            env=env,
        )
    ready = server_mod.wait_until_ready(port, timeout=15.0, expect={"fingerprint": analysis.fingerprint})
    if ready is None:
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-8:]
        except OSError:
            pass
        try:
            process.terminate()
        except OSError:
            pass
        raise CliError(
            f"server for {server_mod.HOST}:{port} did not answer /healthz "
            f"within 15s (log: {log_path})" + (": " + " | ".join(tail) if tail else "")
        )
    record = {
        "pid": process.pid,
        "port": ready["port"],
        "fingerprint": analysis.fingerprint,
        "repo": str(analysis.scan.root),
        "artefact_dir": str(artefact_dir),
        "url": f"http://{server_mod.HOST}:{ready['port']}/",
        "background": True,
        "started": ready.get("started"),
        "log": str(log_path),
    }
    _write_state(root, record)
    return PlayResult(
        url=record["url"],
        port=int(record["port"]),
        fingerprint=analysis.fingerprint,
        artefact_dir=artefact_dir,
        identity=ready,
        reused=False,
        background=True,
        repo=str(analysis.scan.root),
        level_count=level_count,
        module_count=module_count,
    )


def _play_foreground(root, analysis, artefact_dir, port, identity, level_count, module_count) -> PlayResult:
    managed = server_mod.bind_server(artefact_dir, port, identity)
    # The serving thread must exist before we probe /healthz: shutdown() on a
    # server whose serve_forever loop never started blocks forever.
    managed.start_background()
    readback = server_mod.wait_until_ready(port, timeout=10.0, expect={"fingerprint": analysis.fingerprint})
    if readback is None:
        managed.stop()
        raise CliError("server bound but /healthz never answered; stopped it again")
    record = {
        "pid": readback["pid"],
        "port": readback["port"],
        "fingerprint": analysis.fingerprint,
        "repo": str(analysis.scan.root),
        "artefact_dir": str(artefact_dir),
        "url": f"http://{server_mod.HOST}:{readback['port']}/",
        "background": False,
        "started": readback.get("started"),
    }
    state_file = _write_state(root, record)
    print(f"URL: {record['url']}", flush=True)
    stop_event = threading.Event()

    def _handle(signum, frame):  # noqa: ARG001 - signal signature
        stop_event.set()

    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[sig] = signal.signal(sig, _handle)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            pass
    managed.start_background()
    try:
        stop_event.wait()
    finally:
        managed.stop()
        try:
            state_file.unlink()
        except OSError:
            pass
        for sig, handler in previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):  # pragma: no cover
                pass
    return PlayResult(
        url=record["url"],
        port=int(record["port"]),
        fingerprint=analysis.fingerprint,
        artefact_dir=artefact_dir,
        identity=readback,
        reused=False,
        background=False,
        repo=str(analysis.scan.root),
        level_count=level_count,
        module_count=module_count,
    )


def serve_artefacts(
    artefact_dir: str | Path,
    *,
    port: int,
    fingerprint: str,
    repo_name: str,
    module_count: int = 0,
    level_count: int = 0,
) -> int:
    """Serve an exported directory until SIGTERM/SIGINT (internal command)."""
    identity = server_mod.identity_document(
        port=port,
        fingerprint=fingerprint,
        repo_name=repo_name,
        modules=module_count,
        levels=level_count,
    )
    managed = server_mod.bind_server(Path(artefact_dir), port, identity)
    # Start serving before probing: shutdown() on a never-started loop blocks.
    managed.start_background()
    readback = server_mod.wait_until_ready(port, timeout=10.0, expect={"fingerprint": fingerprint})
    if readback is None:
        managed.stop()
        raise CliError("server bound but /healthz never answered")
    stop_event = threading.Event()

    def _handle(signum, frame):  # noqa: ARG001
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle)
        except (ValueError, OSError):  # pragma: no cover
            pass
    print(f"RepoRealm serving {readback['repo']} at http://{server_mod.HOST}:{readback['port']}/", flush=True)
    try:
        stop_event.wait()
    finally:
        managed.stop()
    return 0


# ── stop / status ───────────────────────────────────────────────────────────


def stop_records(records: list[tuple[Path, dict]], timeout: float = 5.0) -> list[dict]:
    """Stop the given instances. Never kills a process it cannot identify."""
    results: list[dict] = []
    for state_file, record in records:
        # A state file that was removed after selection (or never existed) reads
        # back as None; that instance is already gone, not a crash.
        if not isinstance(record, dict):
            results.append({"state_file": str(state_file), "result": "already removed"})
            continue
        port = int(record.get("port") or 0)
        pid = int(record.get("pid") or 0)
        identity = server_mod.probe_health(port) if port else None
        entry = {
            "repo": record.get("repo"),
            "port": port,
            "pid": pid,
            "fingerprint": record.get("fingerprint"),
        }
        if not _matches(identity, record):
            if pid and not _pid_alive(pid):
                entry["result"] = "stale record removed"
            else:
                entry["result"] = "skipped: no matching /healthz identity"
            results.append(entry)
            if entry["result"].startswith("stale"):
                try:
                    state_file.unlink()
                except OSError:
                    pass
            continue
        if pid and not _pid_is_ours(pid):
            entry["result"] = "refused: pid does not look like a RepoRealm server"
            results.append(entry)
            continue
        if pid and pid == os.getpid():
            # The record points at the calling process itself. Whatever wrote
            # it, we are not a detached server; never signal our own pid.
            entry["result"] = "refused: record pid is the caller, not a managed server"
            results.append(entry)
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as exc:
            entry["result"] = f"signal failed: {exc}"
            results.append(entry)
            continue
        closed = server_mod.wait_until_closed(port, timeout=timeout)
        if not closed:
            try:
                os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
            except OSError:
                pass
            closed = server_mod.wait_until_closed(port, timeout=2.0)
        if not closed:
            # The state stays so a later stop can try again; removing it would
            # strand a live server with no record of it.
            entry["result"] = "signal sent but port still answers"
            results.append(entry)
            continue
        try:
            state_file.unlink()
        except OSError:
            pass
        entry["result"] = "stopped"
        results.append(entry)
    return results


def select_records(root: Path, *, repo: str | None = None, port: int | None = None,
                   everything: bool = False) -> list[tuple[Path, dict]]:
    records = cache.iter_instances(root)
    if everything or (repo is None and port is None):
        return records
    selected: list[tuple[Path, dict]] = []
    wanted_repo = str(Path(repo).expanduser().resolve()) if repo else None
    for path, data in records:
        if wanted_repo is not None and data.get("repo") != wanted_repo:
            continue
        if port is not None and int(data.get("port") or 0) != int(port):
            continue
        selected.append((path, data))
    return selected


# ── output helpers ──────────────────────────────────────────────────────────


def _describe_export(result: ExportResult, repo: str) -> str:
    data = result.payload
    kinds = ", ".join(level["kind"] for level in data["levels"]) or "none"
    lines = [
        f"RepoRealm  {data['repo']['name']}",
        f"  repository : {repo}",
        f"  fingerprint: {data['repo']['fingerprint']}",
        f"  graph      : {data['repo']['module_count']} modules, {data['repo']['edge_count']} edges",
        f"  levels     : {len(data['levels'])} ({kinds})",
    ]
    for item in data["unavailable"]:
        lines.append(f"  unavailable: {item['kind']} - {item['reason']}")
    lines.append(f"  exported   : {result.out_path} ({result.out_bytes} bytes)")
    return "\n".join(lines)


def _describe_play(result: PlayResult, repo: str) -> str:
    state = "reused" if result.reused else "started"
    lines = [
        f"RepoRealm  {Path(repo).name}  ({state}, {'background' if result.background else 'foreground'})",
        f"  fingerprint: {result.fingerprint}",
        f"  levels     : {result.level_count} from {result.module_count} modules",
        f"  artefacts  : {result.artefact_dir}",
        f"URL: {result.url}",
    ]
    if result.background:
        lines.append(f"  stop with : python -m reporealm stop --port {result.port}")
    else:
        lines.append("  serving until Ctrl+C (SIGTERM also stops it)")
    return "\n".join(lines)


# ── argparse ────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m reporealm",
        description="Turn a repository into playable reading-comprehension chambers.",
    )
    parser.add_argument("--version", action="version", version=f"reporealm {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyse = sub.add_parser("analyse", help="analyse a repository and emit the payload")
    p_analyse.add_argument("repo")
    p_analyse.add_argument("--out", default="", help="write the payload JSON here instead of stdout")
    p_analyse.add_argument("--check", action="store_true", help="validate the payload and exit non-zero on problems")
    p_analyse.add_argument("--json", action="store_true", help="emit a machine-readable summary")

    p_export = sub.add_parser("export", help="build the single-file game for a repository")
    p_export.add_argument("repo")
    p_export.add_argument("--out", required=True, help="output .html file")
    p_export.add_argument("--payload-out", default="", help="also keep the payload JSON at this path")
    p_export.add_argument("--payload-only", action="store_true", help="emit only the payload JSON")
    p_export.add_argument("--exporter", default="", help="path to scripts/build_web.py (defaults to the packaged one)")
    p_export.add_argument("--json", action="store_true", help="emit a machine-readable summary")

    p_play = sub.add_parser("play", help="export and serve the game on loopback")
    p_play.add_argument("repo")
    p_play.add_argument("--port", type=int, default=server_mod.DEFAULT_PORT)
    p_play.add_argument("--background", action="store_true", help="detach the server and return the URL")
    p_play.add_argument("--cache-dir", default="", help="runtime cache directory (default: $SOURCE_DRIVE_CACHE)")
    p_play.add_argument("--exporter", default="", help="path to scripts/build_web.py")
    p_play.add_argument("--json", action="store_true", help="emit a machine-readable summary")

    p_serve = sub.add_parser("serve", help=argparse.SUPPRESS)
    p_serve.add_argument("--artefact-dir", required=True)
    p_serve.add_argument("--port", type=int, required=True)
    p_serve.add_argument("--fingerprint", required=True)
    p_serve.add_argument("--repo-name", required=True)
    p_serve.add_argument("--module-count", type=int, default=0)
    p_serve.add_argument("--level-count", type=int, default=0)
    p_serve.add_argument("--cache-dir", default="")

    p_stop = sub.add_parser("stop", help="stop managed servers")
    p_stop.add_argument("--repo", default="", help="only the instance for this repository")
    p_stop.add_argument("--port", type=int, default=None, help="only the instance on this port")
    p_stop.add_argument("--all", action="store_true", help="stop every known instance")
    p_stop.add_argument("--cache-dir", default="")
    p_stop.add_argument("--timeout", type=float, default=5.0)
    p_stop.add_argument("--json", action="store_true")

    p_status = sub.add_parser("status", help="list known instances")
    p_status.add_argument("--cache-dir", default="")
    p_status.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "analyse":
            analysis = payload_mod.analyse(args.repo)
            data = analysis.payload
            problems = payload_mod.validate_payload(data)
            text = _dump_payload(data)
            if args.out:
                write_payload_file(data, Path(args.out).expanduser())
            elif not args.json:
                sys.stdout.write(text)
            if args.json or args.check:
                summary = {
                    "repo": str(analysis.scan.root),
                    "fingerprint": data["repo"]["fingerprint"],
                    "module_count": data["repo"]["module_count"],
                    "edge_count": data["repo"]["edge_count"],
                    "levels": [level["id"] for level in data["levels"]],
                    "unavailable": data["unavailable"],
                    "problems": problems,
                }
                if args.json:
                    print(json.dumps(summary, indent=2))
            if problems:
                for problem in problems:
                    print(f"payload problem: {problem}", file=sys.stderr)
                return 1
            return 0

        if args.command == "export":
            result = export_repo(
                args.repo,
                args.out,
                exporter=args.exporter or None,
                payload_out=args.payload_out or None,
                payload_only=args.payload_only,
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "out": str(result.out_path),
                            "payload": str(result.payload_path) if result.payload_path else None,
                            "bytes": result.out_bytes,
                            "fingerprint": result.payload["repo"]["fingerprint"],
                            "levels": [level["id"] for level in result.payload["levels"]],
                        },
                        indent=2,
                    )
                )
            else:
                print(_describe_export(result, args.repo))
            return 0

        if args.command == "play":
            result = play_repo(
                args.repo,
                port=args.port,
                background=args.background,
                cache_dir=args.cache_dir or None,
                exporter=args.exporter or None,
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "url": result.url,
                            "port": result.port,
                            "fingerprint": result.fingerprint,
                            "reused": result.reused,
                            "background": result.background,
                            "artefact_dir": str(result.artefact_dir),
                            "levels": result.level_count,
                            "modules": result.module_count,
                        },
                        indent=2,
                    )
                )
            else:
                print(_describe_play(result, args.repo))
            return 0

        if args.command == "serve":
            return serve_artefacts(
                args.artefact_dir,
                port=args.port,
                fingerprint=args.fingerprint,
                repo_name=args.repo_name,
                module_count=args.module_count,
                level_count=args.level_count,
            )

        if args.command == "stop":
            root = cache.cache_root(args.cache_dir or None)
            records = select_records(
                root,
                repo=args.repo or None,
                port=args.port,
                everything=args.all,
            )
            if not records:
                print("no managed RepoRealm instances found")
                return 0
            results = stop_records(records, timeout=args.timeout)
            if args.json:
                print(json.dumps(results, indent=2))
            else:
                for entry in results:
                    print(f"{entry['result']}: {entry['repo']} (port {entry['port']}, pid {entry['pid']})")
            return 0

        if args.command == "status":
            root = cache.cache_root(args.cache_dir or None)
            rows = []
            for _, record in cache.iter_instances(root):
                port = int(record.get("port") or 0)
                identity = server_mod.probe_health(port) if port else None
                rows.append(
                    {
                        "repo": record.get("repo"),
                        "port": port,
                        "pid": record.get("pid"),
                        "fingerprint": record.get("fingerprint"),
                        "healthy": _matches(identity, record),
                        "url": record.get("url"),
                    }
                )
            if args.json:
                print(json.dumps(rows, indent=2))
            elif not rows:
                print("no managed RepoRealm instances")
            else:
                for row in rows:
                    state = "healthy" if row["healthy"] else "down"
                    print(f"[{state}] port {row['port']} pid {row['pid']} {row['repo']}")
            return 0
    except CliError as exc:
        print(f"reporealm: {exc}", file=sys.stderr)
        return exc.exit_code
    except scan_mod.ScanError as exc:
        print(f"reporealm: {exc}", file=sys.stderr)
        return 1
    except cache.CacheError as exc:
        print(f"reporealm: {exc}", file=sys.stderr)
        return 1
    except server_mod.ServerError as exc:
        print(f"reporealm: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
