"""Python module table and exact import resolution.

Two bugs in the previous analyser are fixed here and covered by tests:

1. qualified imports were truncated to their first segment
   (``import pkg.sub.mod`` became ``pkg``), and
2. relative imports (``from . import x``, ``from ..a import b``) produced no
   relationship at all.

Resolution is longest-prefix over the repository's own module table, so an edge
only exists when a real file backs both ends. A specifier that resolves to
nothing in the repository (third-party, stdlib, dynamic) is recorded as
unresolved instead of being invented.

Files are parsed with :mod:`ast`; nothing is imported or executed.
"""

from __future__ import annotations

import ast
import warnings
from dataclasses import dataclass, field

from .scan import ScanResult, ScannedFile

#: Directories that commonly hold the import root instead of the repo root.
SRC_ROOTS = ("src", "lib", "python", "source")

MAX_EDGE_CODE = 240


def parse_source(text: str, filename: str) -> ast.Module:
    """``ast.parse`` with interpreter warnings silenced.

    A scanned repository's own ``SyntaxWarning``s (invalid escape sequences are
    common) must not leak onto the game's stdout or a tool result.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return ast.parse(text, filename=filename)


@dataclass(frozen=True)
class Module:
    id: str
    rel: str
    is_package: bool


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    path: str
    line: int
    code: str

    def as_payload(self) -> dict:
        return {
            "source": self.source,
            "target": self.target,
            "path": self.path,
            "line": self.line,
            "code": self.code,
        }


@dataclass
class PyGraph:
    modules: dict[str, Module] = field(default_factory=dict)
    aliases: dict[str, str] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    guards: dict[str, int] = field(default_factory=dict)  # module id -> __main__ guard line
    #: module id -> line of a statement that runs code when the module is executed
    #: as a script (a top-level call, or a top-level ``raise``/``sys.exit``). Only
    #: module-level statements are inspected, so a call inside a function is not
    #: counted. Used to keep entry claims honest, never as an entry point itself.
    top_level_runs: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    unresolved: list[dict] = field(default_factory=list)
    parse_errors: list[dict] = field(default_factory=list)

    def resolve(self, dotted: str) -> str | None:
        """Longest resolvable prefix of *dotted*, as a canonical module id."""
        if not dotted:
            return None
        parts = dotted.split(".")
        for i in range(len(parts), 0, -1):
            hit = self.aliases.get(".".join(parts[:i]))
            if hit is not None:
                return hit
        return None

    def resolve_exact(self, dotted: str) -> str | None:
        return self.aliases.get(dotted)

    def importers(self, target: str) -> list[str]:
        return sorted({e.source for e in self.edges if e.target == target})

    def targets(self, source: str) -> list[str]:
        return sorted({e.target for e in self.edges if e.source == source})

    def edge_dict(self) -> dict[tuple[str, str], list[Edge]]:
        out: dict[tuple[str, str], list[Edge]] = {}
        for e in self.edges:
            out.setdefault((e.source, e.target), []).append(e)
        return out


def _module_path_parts(rel: str) -> tuple[list[str], bool, list[str]]:
    """(dotted parts, is_package, warnings) for a repo-relative ``.py`` path."""
    warnings: list[str] = []
    parts = rel.split("/")
    name = parts[-1]
    stem = name[: -len(".py")]
    if stem == "__init__":
        mod_parts = parts[:-1]
        is_package = True
    else:
        mod_parts = parts[:-1] + [stem]
        is_package = False
    if any("." in p for p in mod_parts):
        warnings.append(
            f"{rel}: module path segment contains a dot; analyser id uses '_' for that segment"
        )
        mod_parts = [p.replace(".", "_") for p in mod_parts]
    return mod_parts, is_package, warnings


def build_graph(scan: ScanResult) -> PyGraph:
    graph = PyGraph()
    taken: dict[str, str] = {}

    for sf in scan.python_files():
        mod_parts, is_package, warns = _module_path_parts(sf.rel)
        graph.warnings.extend(warns)
        if not mod_parts:  # a top-level __init__.py: the repo root is a package
            mod_id = sf.rel[: -len(".py")].strip("/").replace("/", ".") or "__init__"
            candidates = [mod_id]
        else:
            root_relative = ".".join(mod_parts)
            stripped = ".".join(mod_parts[1:]) if mod_parts[0] in SRC_ROOTS and len(mod_parts) > 1 else ""
            # src layout: ``src/pkg/mod.py`` is imported as ``pkg.mod``.
            candidates = [stripped, root_relative] if stripped else [root_relative]

        chosen = None
        for cand in candidates:
            if cand and cand not in taken:
                chosen = cand
                break
        if chosen is None:
            graph.warnings.append(
                f"{sf.rel}: module id {'/'.join(candidates)} already used by {taken.get(candidates[0], '?')}; "
                "file excluded from the module table"
            )
            continue
        taken[chosen] = sf.rel
        graph.modules[chosen] = Module(id=chosen, rel=sf.rel, is_package=is_package)
        for cand in candidates:
            if cand and cand not in graph.aliases:
                graph.aliases[cand] = chosen

    for module in list(graph.modules.values()):
        _parse_module(graph, module, scan.by_rel()[module.rel])
    graph.edges.sort(key=lambda e: (e.source, e.target, e.path, e.line))
    graph.unresolved.sort(key=lambda u: (u["source"], u["line"], u["specifier"]))
    graph.parse_errors.sort(key=lambda p: p["path"])
    return graph


def _package_of(module: Module) -> list[str]:
    parts = module.id.split(".")
    return parts if module.is_package else parts[:-1]


def _line_text(lines: list[str], lineno: int) -> str:
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1].strip()[:MAX_EDGE_CODE]
    return ""


def _is_main_guard(node: ast.If) -> bool:
    test = node.test
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return False
    if not isinstance(test.ops[0], ast.Eq):
        return False
    left, right = test.left, test.comparators[0]

    def is_name(n: ast.AST) -> bool:
        return isinstance(n, ast.Name) and n.id == "__name__"

    def is_main(n: ast.AST) -> bool:
        return isinstance(n, ast.Constant) and n.value == "__main__"

    return (is_name(left) and is_main(right)) or (is_main(left) and is_name(right))


def _parse_module(graph: PyGraph, module: Module, sf: ScannedFile) -> None:
    text = sf.text()
    try:
        tree = parse_source(text, module.rel)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
        graph.parse_errors.append({"path": module.rel, "error": str(exc)[:200]})
        return
    lines = text.splitlines()
    seen: set[tuple[str, str, int]] = set()
    pkg_parts = _package_of(module)

    def add_edge(target_id: str, lineno: int) -> None:
        if target_id == module.id:
            return
        key = (module.id, target_id, lineno)
        if key in seen:
            return
        seen.add(key)
        graph.edges.append(
            Edge(
                source=module.id,
                target=target_id,
                path=module.rel,
                line=lineno,
                code=_line_text(lines, lineno),
            )
        )

    def note_unresolved(specifier: str, lineno: int) -> None:
        graph.unresolved.append(
            {"source": module.id, "line": lineno, "specifier": specifier}
        )

    for node in ast.walk(tree):
        if isinstance(node, ast.If) and _is_main_guard(node):
            graph.guards.setdefault(module.id, node.lineno)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                target = graph.resolve(alias.name)
                if target is None:
                    note_unresolved(alias.name, node.lineno)
                else:
                    add_edge(target, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            if node.module == "__future__" and node.level == 0:
                continue
            if node.level:
                base_parts = list(pkg_parts)
                up = node.level - 1
                if up:
                    base_parts = base_parts[: max(0, len(base_parts) - up)]
                if node.module:
                    base_parts = base_parts + node.module.split(".")
                base = ".".join(base_parts)
            else:
                base = node.module or ""
            if base:
                target = graph.resolve(base)
                if target is None:
                    note_unresolved(base, node.lineno)
                else:
                    add_edge(target, node.lineno)
            for alias in node.names:
                if alias.name == "*":
                    continue
                child = f"{base}.{alias.name}" if base else alias.name
                target = graph.resolve_exact(child)
                if target is not None:
                    add_edge(target, node.lineno)

    # Module-level statements that do something when the file is executed. This is
    # deliberately narrow: only direct children of the module body count, so a call
    # inside a function or a guard block is not mistaken for "this file runs".
    for statement in tree.body:
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
            graph.top_level_runs.setdefault(module.id, statement.lineno)
            break
