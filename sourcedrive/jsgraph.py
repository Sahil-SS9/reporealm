"""JavaScript / TypeScript local import edges, with explicit lexical limits.

Only *local, statically resolvable* specifiers become edges:

* ``import x from "./mod"``, ``import "./mod"``, ``export * from "./mod"``,
  ``export { a } from "../mod"`` — including multi-line brace lists, because the
  match is on the ``from "<specifier>"`` clause rather than the line start.

Deliberately **not** modelled (no guess is better than a wrong edge):

* dynamic ``import("./mod")`` and ``require("./mod")`` calls,
* ``tsconfig`` ``paths`` aliases, ``package.json`` ``exports``/``imports`` maps,
* bare package specifiers (``react``, ``@scope/pkg``),
* anything the resolver cannot find on disk with the extension candidates below.

Matching runs on a comment-blanked copy of the file so a commented-out import is
not an edge. Strings are preserved (the specifier lives in one), which means a
``from "./x"`` sequence *inside a template literal* would still match — that is
the one documented false-positive path, and it cannot fabricate a target that
does not exist on disk.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field

from .scan import ScanResult

RESOLVE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
MAX_EDGE_CODE = 240

_FROM_RE = re.compile(r"""\bfrom\s*(['"])(\.{1,2}/[^'"]*)\1""")
_BARE_IMPORT_RE = re.compile(r"""\bimport\s*(['"])(\.{1,2}/[^'"]*)\1""")


@dataclass
class JsGraph:
    modules: dict[str, str] = field(default_factory=dict)  # id -> rel path
    edges: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unresolved: list[dict] = field(default_factory=list)


def _blank_comments(text: str) -> str:
    """Replace comment bodies with spaces, preserving length and newlines."""
    out: list[str] = []
    i = 0
    n = len(text)
    state = "code"
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line"
                out.append("  ")
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block"
                out.append("  ")
                i += 2
                continue
            if ch in "'\"":
                state = ch
                out.append(ch)
                i += 1
                continue
            if ch == "`":
                state = "template"
                out.append(ch)
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if state == "line":
            if ch == "\n":
                state = "code"
                out.append("\n")
            else:
                out.append(" ")
            i += 1
            continue
        if state == "block":
            if ch == "*" and nxt == "/":
                state = "code"
                out.append("  ")
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if state in ("'", '"'):
            if ch == "\\" and nxt:
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            if ch == state:
                state = "code"
            out.append(ch)
            i += 1
            continue
        # template literal
        if ch == "\\" and nxt:
            out.append(ch)
            out.append(nxt)
            i += 2
            continue
        if ch == "`":
            state = "code"
        out.append(ch)
        i += 1
    return "".join(out)


def _module_id(rel: str) -> str:
    """Repo-relative path without its single JS/TS extension (slashes kept)."""
    for ext in sorted(RESOLVE_EXTENSIONS, key=len, reverse=True):
        if rel.endswith(ext):
            return rel[: -len(ext)]
    return rel


def _candidates(base: str) -> list[str]:
    """Ordered on-disk candidates for a normalised specifier path."""
    out = [base]
    for ext in RESOLVE_EXTENSIONS:
        out.append(base + ext)
    for ext in RESOLVE_EXTENSIONS:
        out.append(posixpath.join(base, "index" + ext))
    return out


def build_graph(scan: ScanResult) -> JsGraph:
    graph = JsGraph()
    files = {f.rel: f for f in scan.js_files()}
    rel_to_id: dict[str, str] = {}
    for rel in sorted(files):
        module_id = _module_id(rel)
        if module_id in graph.modules:  # e.g. foo.ts and foo.tsx both want "foo"
            module_id = rel
            graph.warnings.append(
                f"{rel}: module id collides with {graph.modules[_module_id(rel)]}; "
                "using the full path as its id"
            )
        graph.modules[module_id] = rel
        rel_to_id[rel] = module_id

    seen: set[tuple[str, str, int]] = set()

    for rel in sorted(files):
        sf = files[rel]
        source_id = rel_to_id[rel]
        raw = sf.text()
        blanked = _blank_comments(raw)
        raw_lines = raw.splitlines()
        line_starts = [0]
        for idx, ch in enumerate(blanked):
            if ch == "\n":
                line_starts.append(idx + 1)

        def line_of(offset: int) -> int:
            lo, hi = 0, len(line_starts) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if line_starts[mid] <= offset:
                    lo = mid
                else:
                    hi = mid - 1
            return lo + 1

        for regex in (_FROM_RE, _BARE_IMPORT_RE):
            for match in regex.finditer(blanked):
                spec = match.group(2)
                lineno = line_of(match.start())
                normalised = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
                if normalised.startswith("..") or normalised == ".":
                    graph.unresolved.append(
                        {"source": source_id, "path": rel, "line": lineno, "specifier": spec}
                    )
                    continue
                target_rel = None
                for cand in _candidates(normalised):
                    if cand in files:
                        target_rel = cand
                        break
                if target_rel is None:
                    graph.unresolved.append(
                        {"source": source_id, "path": rel, "line": lineno, "specifier": spec}
                    )
                    continue
                target_id = rel_to_id[target_rel]
                if target_id == source_id:
                    continue
                key = (source_id, target_id, lineno)
                if key in seen:
                    continue
                seen.add(key)
                code = raw_lines[lineno - 1].strip()[:MAX_EDGE_CODE] if lineno <= len(raw_lines) else ""
                graph.edges.append(
                    {
                        "source": source_id,
                        "target": target_id,
                        "path": rel,
                        "line": lineno,
                        "code": code,
                    }
                )

    graph.edges.sort(key=lambda e: (e["source"], e["target"], e["path"], e["line"]))
    graph.unresolved.sort(key=lambda u: (u["path"], u["line"], u["specifier"]))
    return graph
