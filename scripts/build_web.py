#!/usr/bin/env python3
"""Build the single-file RepoRealm game.

    python scripts/build_web.py --data payload.json --out game.html

The output is one offline HTML file: the vendored engine, the game modules and
the analyser payload are inlined. There is no CDN, no module loading, no fetch
and no network access at runtime, so it plays from file:// as well as from a
local server.

Every ``{{ASSET:<name>}}`` marker in the shell template is embedded here as a
``data:`` URL (the owner-supplied poster, the two OFL font families), and the
OFL licence texts are inlined behind ``{{FONT_NOTICES}}``. Discovery is generic:
the builder embeds whatever the template references, so the poster/font/notice
set can change in ``web/assets/reporealm/`` without editing this file, and a
marker with no file fails the build instead of shipping a broken reference.

The payload is embedded as::

    window.SOURCE_DRIVE_DATA = { ... };

before the game bundle. Because that JSON lives inside a <script> element, the
encoder escapes `<`, `>`, `&`, U+2028 and U+2029. A payload string containing
`</script>` therefore cannot end the script element early, and a Windows path or
a comment containing `<!--` cannot open an HTML comment.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = REPO_ROOT / "web"
SRC_DIR = WEB_DIR / "src"
VENDOR_DIR = WEB_DIR / "vendor"
SHELL_PATH = WEB_DIR / "shell.html"
THREE_PATH = VENDOR_DIR / "three.min.js"
LICENSE_PATH = VENDOR_DIR / "THREE-LICENSE.txt"
NOTICE_PATH = WEB_DIR / "NOTICE.md"

DATA_MARKER = "{{DATA}}"
BUNDLE_MARKER = "{{BUNDLE}}"
TITLE_MARKER = "{{TITLE}}"

# Asset embedding. Names in a marker are treated as untrusted input: only a plain
# file name inside ASSET_DIR is accepted, and only with a known content type.
ASSET_DIR = WEB_DIR / "assets" / "reporealm"
ASSET_MARKER_RE = re.compile(r"\{\{ASSET:([^{}]*)\}\}")
ASSET_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8",
}
FONT_NOTICES_MARKER = "{{FONT_NOTICES}}"
FONT_NOTICE_FILES = ("OFL-Space-Grotesk.txt", "OFL-JetBrains-Mono.txt")

# Script-terminator and line-separator escaping. Both are legal JSON and legal
# JavaScript, and neither can break out of the element or the string literal.
_ESC = chr(92)  # a single backslash, built explicitly so no editor can double it
_JSON_ESCAPES = {
    "<": _ESC + "u003c",
    ">": _ESC + "u003e",
    "&": _ESC + "u0026",
    "\u2028": _ESC + "u2028",
    "\u2029": _ESC + "u2029",
}


class BuildError(RuntimeError):
    """A build that must not silently produce a half-working file."""


# Attributes whose value the browser resolves into a fetch. `srcset`, CSS
# `url(...)` and `@import` count too: three.js mentions its own homepage in a
# comment, and that string must never be mistaken for a reference or a build
# would be rejected for a comment.
_URL_ATTR_RE = re.compile(
    r'(?:\b(?:src|href|srcset|poster|data|action|formaction|background)\s*=\s*["\']?)'
    r'\s*(?:https?:)?//',
    re.IGNORECASE,
)
_URL_CSS_RE = re.compile(r'url\(\s*["\']?\s*(?:https?:)?//', re.IGNORECASE)
_URL_IMPORT_RE = re.compile(r'@import\s+(?:url\()?\s*["\']?(?:https?:)?//', re.IGNORECASE)


def find_runtime_urls(document: str) -> list[str]:
    """Return absolute URL references the browser would actually fetch.

    Comments inside vendored code legitimately mention URLs, so this looks for
    references - attribute values, CSS `url()`, `@import` - not for the bare
    string ``http://``. A build and its test must agree on that distinction,
    which is why this lives here and not in the test file.
    """
    found: list[str] = []
    for label, pattern in (("attribute", _URL_ATTR_RE), ("css-url", _URL_CSS_RE),
                           ("css-import", _URL_IMPORT_RE)):
        for match in pattern.finditer(document):
            snippet = document[match.start():match.start() + 90].split("\n")[0]
            found.append(f"{label}: {snippet.strip()}")
    return found


def _escape_html(text: str) -> str:
    """Escape text for an HTML text node.

    The repository name comes from an untrusted payload and is rendered as the
    document title, so it is escaped rather than trusted. Without this a repo
    called ``</title><img src=x onerror=...>`` becomes live markup in <head>.
    """
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def encode_payload(payload: object) -> str:
    """Encode a payload object as JavaScript that is safe inside <script>."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    out = []
    for ch in raw:
        out.append(_JSON_ESCAPES.get(ch, ch))
    return "".join(out)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise BuildError(f"missing file: {path}") from exc


def _module_sources() -> list[Path]:
    files = sorted(p for p in SRC_DIR.glob("*.js") if p.is_file())
    if not files:
        raise BuildError(f"no game modules found in {SRC_DIR}")
    names = [p.name for p in files]
    for required in ("01-core.js", "02-payload.js", "03-physics.js", "04-portals.js",
                     "05-player.js", "06-levelgen.js", "07-sim.js", "08-render.js",
                     "09-ui.js", "10-audio.js", "11-main.js"):
        if required not in names:
            raise BuildError(f"game module {required} is missing from {SRC_DIR}")
    return files


def _asset_path(assets_dir: Path, name: str) -> tuple[Path, str]:
    """Resolve one ``{{ASSET:name}}`` marker to ``(path, mime)`` inside *assets_dir*.

    The marker is a plain file name only. Anything else - a directory separator,
    ``..``, an absolute or hidden name - is refused, and the resolved path must
    still be inside the asset directory. A missing file or an unknown suffix is a
    build error: a half-embedded page is worse than a failed build.
    """
    plain = name.strip()
    if (
        not plain
        or plain != Path(plain).name
        or plain.startswith(".")
        or plain != name
        or "/" in plain
        or "\\" in plain
        or ".." in plain
    ):
        raise BuildError(f"asset marker {{{{ASSET:{name}}}}} is not a plain file name")
    try:
        base = assets_dir.resolve()
    except OSError as exc:  # pragma: no cover - defensive
        raise BuildError(f"asset directory is unreadable: {assets_dir} ({exc})") from exc
    candidate = (assets_dir / plain).resolve()
    if not candidate.is_relative_to(base):
        raise BuildError(
            f"asset {plain!r} resolves outside {assets_dir}; embedded assets must live there"
        )
    if not candidate.is_file():
        raise BuildError(f"missing embedded asset: {plain} (looked in {assets_dir})")
    mime = ASSET_MIME_BY_SUFFIX.get(candidate.suffix.lower())
    if mime is None:
        raise BuildError(
            f"asset {plain!r} has no known content type "
            f"({candidate.suffix or 'no suffix'}); add it to ASSET_MIME_BY_SUFFIX"
        )
    return candidate, mime


def embed_assets(document: str, assets_dir: Path = ASSET_DIR) -> tuple[str, list[str]]:
    """Inline every ``{{ASSET:...}}`` marker as a ``data:`` URL.

    Returns the rewritten document and the asset names embedded. After
    substitution no marker may remain: a leftover marker means the shell
    references something the builder did not decode, and the page would ship a
    broken image or font reference.
    """
    names = sorted(set(ASSET_MARKER_RE.findall(document)))
    for name in names:
        path, mime = _asset_path(assets_dir, name)
        try:
            payload = path.read_bytes()
        except OSError as exc:
            raise BuildError(f"cannot read embedded asset {name}: {exc}") from exc
        encoded = base64.b64encode(payload).decode("ascii")
        document = document.replace("{{ASSET:" + name + "}}", "data:" + mime + ";base64," + encoded)
    leftover = ASSET_MARKER_RE.search(document)
    if leftover is not None:
        raise BuildError(f"unfilled asset marker in the shell template: {leftover.group(0)}")
    return document, names


def embed_font_notices(document: str, assets_dir: Path = ASSET_DIR) -> tuple[str, list[str]]:
    """Inline the embedded font licence texts behind ``{{FONT_NOTICES}}``.

    The OFL notices travel inside the standalone game file because a single
    ``.html`` is what a player is handed. The placeholder is required: silently
    dropping the notices would strip attribution from every export.
    """
    if FONT_NOTICES_MARKER not in document:
        raise BuildError(
            f"shell template has no {FONT_NOTICES_MARKER} placeholder; the OFL notices must ship"
        )
    blocks: list[str] = []
    for name in FONT_NOTICE_FILES:
        path, _ = _asset_path(assets_dir, name)
        try:
            blocks.append(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise BuildError(f"cannot read font notice {name}: {exc}") from exc
    notices = "\n".join(blocks)
    if "<!--" in notices or "-->" in notices:
        raise BuildError("font notices contain HTML comment delimiters")
    return document.replace(FONT_NOTICES_MARKER, notices), list(FONT_NOTICE_FILES)


def _notice_block() -> str:
    """The full third-party notice, verbatim, ready to sit inside a comment.

    The attribution used to name `web/NOTICE.md` in a file that did not exist and
    in an export that only carried the three.js licence. The upstream MIT notice
    has to travel with the standalone game file, because a single .html is what
    gets handed to a player.
    """
    notice = _read(NOTICE_PATH)
    if "<!--" in notice or "-->" in notice:
        raise BuildError(
            f"{NOTICE_PATH} contains an HTML comment delimiter and cannot be "
            "inlined as a comment"
        )
    indented = "\n".join(("  " + line).rstrip() for line in notice.splitlines())
    return indented


def _attribution() -> str:
    licence = ""
    if LICENSE_PATH.exists():
        licence = _read(LICENSE_PATH).strip()
    return (
        "<!--\n"
        "  RepoRealm - a first-person portal puzzle built from a repository's import graph.\n"
        "  Rendering: three.js r137, MIT licence (vendored, see web/vendor/THREE-LICENSE.txt).\n"
        + ("  " + licence.replace("\n", "\n  ") + "\n" if licence else "")
        + "  Portal traversal, aperture fitting and held-object transforms are adapted from\n"
        "  mwpenny/portal64-still-alive (MIT), rewritten in JavaScript. No Valve assets, voices,\n"
        "  maps, names or logos are used or reproduced.\n"
        "  ---- web/NOTICE.md, in full ----\n"
        + _notice_block() + "\n"
        "  ---- end of web/NOTICE.md ----\n"
        "  Owner-supplied RepoRealm poster; procedural world art; embedded OFL fonts.\n"
        "-->\n"
    )


def build_bundle() -> str:
    """Vendor engine + every game module, in load order, as one script body."""
    three = _read(THREE_PATH)
    if "</script" in three.lower():
        raise BuildError("the vendored engine contains a script terminator and cannot be inlined")
    parts = [
        "/* three.js r137 - MIT - vendored, no network */",
        three.rstrip(),
        "/* RepoRealm game modules */",
    ]
    for path in _module_sources():
        source = _read(path)
        if "</script" in source.lower():
            raise BuildError(f"{path.name} contains a script terminator")
        parts.append(f"/* ---- {path.name} ---- */")
        parts.append(source.rstrip())
    return "\n".join(parts)


def build(data_path: Path, out_path: Path, title: str | None = None) -> dict:
    """Render one offline game file. Returns a small report for the caller."""
    data_text = _read(data_path)
    try:
        payload = json.loads(data_text)
    except json.JSONDecodeError as exc:
        raise BuildError(f"{data_path} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise BuildError(f"{data_path} must contain a JSON object, got {type(payload).__name__}")

    shell = _read(SHELL_PATH)
    shell, embedded_assets = embed_assets(shell, ASSET_DIR)
    shell, embedded_notices = embed_font_notices(shell, ASSET_DIR)
    for marker in (DATA_MARKER, BUNDLE_MARKER, TITLE_MARKER):
        if marker not in shell:
            raise BuildError(f"shell template has no {marker} placeholder")

    schema = payload.get("schema_version")
    repo_raw = payload.get("repo")
    repo: dict = repo_raw if isinstance(repo_raw, dict) else {}
    repo_name = str(repo.get("name") or "repository")
    levels_raw = payload.get("levels")
    levels: list = levels_raw if isinstance(levels_raw, list) else []

    document = shell.replace(TITLE_MARKER, _escape_html(title or f"RepoRealm - {repo_name}"))
    document = document.replace(DATA_MARKER, encode_payload(payload))
    document = document.replace(BUNDLE_MARKER, build_bundle())

    # The title is the one place an untrusted string lands in markup, so prove
    # it stayed a text node instead of hoping the escape covered every case.
    if document.count("<title>") != 1 or document.count("</title>") != 1:
        raise BuildError("the document title escaped its element")

    # Cheap structural guards: the export must stay offline and self-contained.
    # Comments inside the vendored engine legitimately mention URLs, so the check
    # is about *references* the browser would fetch, not string content.
    lowered = document.lower()
    for forbidden in ('<script src', 'type="module"', '<link rel="stylesheet"',
                      'cdn.', 'unpkg.com', 'jsdelivr'):
        if forbidden in lowered:
            raise BuildError(f"export contains an external reference: {forbidden!r}")
    runtime_urls = find_runtime_urls(document)
    if runtime_urls:
        raise BuildError(
            "export contains an absolute URL reference; nothing may be fetched at "
            f"runtime: {runtime_urls[0]}"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not document.lstrip().startswith("<!DOCTYPE html>"):
        raise BuildError("shell template does not start with a doctype")
    if _attribution() not in document:
        document = document.replace("</title>", "</title>\n" + _attribution(), 1)

    out_path.write_text(document, encoding="utf-8")
    blob = out_path.read_bytes()
    return {
        "path": str(out_path),
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "schema_version": schema,
        "repo": repo_name,
        "levels": len(levels),
        "title": title or f"RepoRealm - {repo_name}",
        "embedded_assets": embedded_assets,
        "embedded_notices": embedded_notices,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="build_web.py",
        description="Build the single-file, offline RepoRealm chamber.",
    )
    parser.add_argument("--data", required=True, help="analyser payload JSON (schema_version 1)")
    parser.add_argument("--out", required=True, help="destination .html file")
    parser.add_argument("--title", default=None, help="document title override")
    parser.add_argument("--quiet", action="store_true", help="only report failures")
    args = parser.parse_args(argv)

    try:
        report = build(Path(args.data), Path(args.out), args.title)
    except BuildError as exc:
        print(f"build_web: {exc}", file=sys.stderr)
        return 2

    if report["schema_version"] != 1:
        print(
            f"build_web: warning: payload schema_version is {report['schema_version']!r}, "
            "this frontend speaks 1; the game will show its unsupported-schema card",
            file=sys.stderr,
        )
    if not args.quiet:
        print(f"built {report['path']}")
        print(f"  repo    {report['repo']}  ({report['levels']} level(s), schema {report['schema_version']})")
        print(f"  bytes   {report['bytes']:,}")
        print(f"  sha256  {report['sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
