"""Deterministic, read-only repository scanning.

Nothing here imports or executes repository code. Files are read as text and
parsed with :mod:`ast` (Python) or a deliberately small lexer (JS/TS), so a
hostile repository can at worst produce a parse error.

The scanner is the single source of truth for *which* files count. Every later
stage (module table, import graph, evidence) works from this list, which is what
makes two runs on the same tree byte-identical.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

PY_SUFFIXES = frozenset({".py"})
JS_SUFFIXES = frozenset({".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"})

#: Manifests are parsed as data only (TOML/INI/JSON, or ``ast`` for setup.py).
MANIFEST_NAMES = frozenset({"pyproject.toml", "setup.py", "setup.cfg", "package.json"})

#: Directories that are never the product's own code, or are dependency trees.
#: Matched case-insensitively against the directory name.
IGNORED_DIR_NAMES = frozenset(
    {
        ".git", ".hg", ".svn", ".bzr",
        "node_modules", "bower_components", "jspm_packages",
        ".venv", "venv", "env", ".env.d", "virtualenv", "site-packages",
        "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox",
        ".eggs", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".parcel-cache",
        "target", "vendor", "third_party", "thirdparty", "external",
        ".idea", ".vscode", ".gradle", "coverage", "htmlcov", ".cache",
    }
)

MAX_FILES = 12000
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 192 * 1024 * 1024
MAX_DEPTH = 24

#: Dot-directories worth scanning despite the leading dot (CI config lives here);
#: every other dot-directory is treated as metadata/toolchain state.
ALLOWED_DOT_DIRS = frozenset({".github", ".well-known", ".config"})


class ScanError(Exception):
    """The path cannot be scanned (missing, not a directory, unreadable)."""


@dataclass(frozen=True)
class ScannedFile:
    """One included file. ``rel`` is a POSIX path relative to the repo root."""

    rel: str
    path: Path
    size: int
    digest: str
    kind: str  # "python" | "js" | "manifest" | "other"

    def text(self) -> str:
        """Decode as UTF-8 with replacement. Never raises for a readable file."""
        try:
            return self.path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def lines(self) -> list[str]:
        return self.text().splitlines()


@dataclass
class ScanResult:
    root: Path
    files: list[ScannedFile]
    warnings: list[str]
    skipped_symlinks: int = 0
    skipped_ignored: int = 0
    skipped_oversize: int = 0
    truncated: bool = False

    @property
    def fingerprint(self) -> str:
        return self.fingerprint_of(self.files)

    @staticmethod
    def fingerprint_of(files: list[ScannedFile]) -> str:
        """sha256 over ``rel\\0digest`` lines, sorted. Content-sensitive and stable."""
        h = hashlib.sha256()
        for f in sorted(files, key=lambda s: s.rel):
            h.update(f.rel.encode("utf-8", "surrogateescape"))
            h.update(b"\0")
            h.update(f.digest.encode("ascii"))
            h.update(b"\n")
        return h.hexdigest()

    def by_rel(self) -> dict[str, ScannedFile]:
        return {f.rel: f for f in self.files}

    def python_files(self) -> list[ScannedFile]:
        return [f for f in self.files if f.kind == "python"]

    def js_files(self) -> list[ScannedFile]:
        return [f for f in self.files if f.kind == "js"]

    def manifest(self, name: str) -> ScannedFile | None:
        for f in self.files:
            if f.rel == name:
                return f
        return None


# ── .gitignore subset ────────────────────────────────────────────────────────
#
# Supported: comments, blank lines, ``!`` negation, trailing ``/`` (dir only),
# leading ``/`` (anchored at the .gitignore's directory), ``*`` and ``?`` within
# a path segment, ``**`` across segments, and bare names matching the basename
# at any depth below that directory.
#
# Not supported (documented limits, not silent guesses): ``.git/info/exclude``,
# the user's global excludes file, escaped trailing spaces, and ``[a-z]``
# character classes beyond what :mod:`fnmatch` provides per segment.

_TRAILING_SPACE = re.compile(r"(?<!\\) +$")


def _gitignore_regex(pattern: str) -> str:
    """Translate one gitignore glob to a regex body (``**``/``*``/``?``)."""
    out: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if pattern.startswith("**", i):
                # ``**/`` -> any number of directories; trailing ``**`` -> anything
                if pattern.startswith("**/", i):
                    out.append(r"(?:[^/]+/)*")
                    i += 3
                    continue
                out.append(r".*")
                i += 2
                continue
            out.append(r"[^/]*")
            i += 1
        elif ch == "?":
            out.append(r"[^/]")
            i += 1
        elif ch == "[":
            j = pattern.find("]", i + 1)
            if j == -1:
                out.append(re.escape(ch))
                i += 1
                continue
            body = pattern[i + 1 : j]
            if body.startswith("!"):
                body = "^" + body[1:]
            out.append("[" + body.replace("\\", "\\\\") + "]")
            i = j + 1
        else:
            out.append(re.escape(ch))
            i += 1
    return "".join(out)


class GitignoreRules:
    """Accumulated rules from every ``.gitignore`` above the current directory."""

    def __init__(self) -> None:
        self._rules: list[tuple[re.Pattern[str], bool, bool]] = []  # (regex, negated, dir_only)

    def clone(self) -> "GitignoreRules":
        """Copy of the accumulated rules (a child directory adds to its own copy)."""
        other = GitignoreRules()
        other._rules = list(self._rules)
        return other

    def extend(self, gitignore_text: str, base_rel: str) -> None:
        base = base_rel.strip("/")
        prefix = "" if not base else re.escape(base) + "/"
        for raw in gitignore_text.splitlines():
            line = raw.rstrip("\r")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            line = _TRAILING_SPACE.sub("", line)
            if not line:
                continue
            negated = line.startswith("!")
            if negated:
                line = line[1:]
            dir_only = line.endswith("/")
            line = line.rstrip("/")
            if not line:
                continue
            anchored = line.startswith("/")
            line = line.lstrip("/")
            body = _gitignore_regex(line)
            if anchored or "/" in line:
                regex = "^" + prefix + body + "$"
            else:
                regex = "^" + prefix + r"(?:[^/]+/)*" + body + "$"
            try:
                compiled = re.compile(regex)
            except re.error:
                continue
            self._rules.append((compiled, negated, dir_only))

    def ignored(self, rel: str, is_dir: bool) -> bool:
        rel = rel.strip("/")
        decision = False
        for regex, negated, dir_only in self._rules:
            if dir_only and not is_dir:
                continue
            if regex.match(rel):
                decision = not negated
        return decision


# ── scanning ────────────────────────────────────────────────────────────────


def _kind_of(name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in PY_SUFFIXES:
        return "python"
    if suffix in JS_SUFFIXES:
        return "js"
    if name in MANIFEST_NAMES:
        return "manifest"
    return "other"


def _digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_repo(repo: str | os.PathLike[str]) -> Path:
    """Resolve and validate a repository path. Never follows into a file."""
    path = Path(repo).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ScanError(f"repository path is not readable: {path} ({exc})") from exc
    if not resolved.is_dir():
        raise ScanError(f"not a directory: {resolved}")
    return resolved


def scan(repo: str | os.PathLike[str]) -> ScanResult:
    """Walk *repo* once and return the deterministic included-file set."""
    root = resolve_repo(repo)
    warnings: list[str] = []
    files: list[ScannedFile] = []
    skipped_symlinks = 0
    skipped_ignored = 0
    skipped_oversize = 0
    total_bytes = 0
    truncated = False

    def _walk(directory: Path, rel_dir: str, depth: int, rules: GitignoreRules) -> None:
        nonlocal skipped_symlinks, skipped_ignored, skipped_oversize, total_bytes, truncated
        if depth > MAX_DEPTH:
            return
        local = rules.clone()
        gitignore = directory / ".gitignore"
        if gitignore.is_file() and not gitignore.is_symlink():
            try:
                local.extend(gitignore.read_text(encoding="utf-8", errors="replace"), rel_dir)
            except OSError:
                pass
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name)
        except OSError as exc:
            warnings.append(f"unreadable directory skipped: {rel_dir or '.'} ({exc.strerror or exc})")
            return
        for entry in entries:
            if len(files) >= MAX_FILES:
                truncated = True
                return
            name = entry.name
            rel = f"{rel_dir}/{name}" if rel_dir else name
            try:
                is_symlink = entry.is_symlink()
                is_dir = entry.is_dir()
            except OSError:
                continue
            if is_symlink:
                skipped_symlinks += 1
                continue
            if is_dir:
                if name.lower() in IGNORED_DIR_NAMES:
                    skipped_ignored += 1
                    continue
                if name.startswith(".") and name not in ALLOWED_DOT_DIRS:
                    skipped_ignored += 1
                    continue
                if local.ignored(rel, is_dir=True):
                    skipped_ignored += 1
                    continue
                _walk(entry, rel, depth + 1, local)
                continue
            if local.ignored(rel, is_dir=False):
                skipped_ignored += 1
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            if not entry.is_file():
                continue
            if stat.st_size > MAX_FILE_BYTES:
                skipped_oversize += 1
                continue
            if total_bytes + stat.st_size > MAX_TOTAL_BYTES:
                truncated = True
                return
            try:
                digest = _digest_file(entry)
            except OSError:
                continue
            total_bytes += stat.st_size
            files.append(
                ScannedFile(
                    rel=rel,
                    path=entry,
                    size=stat.st_size,
                    digest=digest,
                    kind=_kind_of(name),
                )
            )

    _walk(root, "", 0, GitignoreRules())

    files.sort(key=lambda f: f.rel)
    if truncated:
        warnings.append(
            f"scan truncated at {len(files)} files / {MAX_TOTAL_BYTES // (1024 * 1024)} MiB; "
            "the graph describes only the scanned subset"
        )
    if skipped_symlinks:
        warnings.append(
            f"{skipped_symlinks} symlink(s) skipped: the graph never follows links out of the repository"
        )
    if skipped_oversize:
        warnings.append(f"{skipped_oversize} file(s) over {MAX_FILE_BYTES // 1024} KiB skipped")
    if not any(f.kind in {"python", "js", "manifest"} for f in files):
        warnings.append(
            "no source or manifest files found (only documentation and other files), so no "
            "module graph can be built"
        )
    return ScanResult(
        root=root,
        files=files,
        warnings=warnings,
        skipped_symlinks=skipped_symlinks,
        skipped_ignored=skipped_ignored,
        skipped_oversize=skipped_oversize,
        truncated=truncated,
    )


def is_test_path(rel: str) -> bool:
    """True for a file that a Python/JS test runner would collect."""
    parts = rel.split("/")
    name = parts[-1]
    stem = name.rsplit(".", 1)[0]
    if any(part in {"tests", "test", "__tests__", "spec", "testdata"} for part in parts[:-1]):
        return True
    if stem.startswith("test_") or stem.endswith("_test") or stem.endswith(".test") or stem.endswith(".spec"):
        return True
    return False


def matches_any(rel: str, globs: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(rel, g) for g in globs)
