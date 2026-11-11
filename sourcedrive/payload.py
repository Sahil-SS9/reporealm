"""Assemble and validate the shared ``schema_version = 1`` payload.

The payload is the whole contract between the analyser and the game frontend.
:func:`validate_payload` re-checks it after assembly (and is used by the tests),
so a broken graph, a dangling evidence reference or a fake answer cannot reach
the exporter silently.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from . import entry as entry_mod
from . import jsgraph, levels as levels_mod, pygraph, scan as scan_mod

SCHEMA_VERSION = 1
LEVEL_KINDS = ("portals", "entry", "imports", "tests", "relay", "weighbridge")
LAYOUT_RANGES = {"width": (12, 24), "length": (20, 36), "height": (5, 9)}


@dataclass
class Analysis:
    scan: scan_mod.ScanResult
    py: pygraph.PyGraph
    js: jsgraph.JsGraph
    entries: entry_mod.EntryReport
    level_set: levels_mod.LevelSet
    fingerprint: str
    warnings: list[str] = field(default_factory=list)

    @property
    def payload(self) -> dict:
        return self._payload

    _payload: dict = field(default_factory=dict, repr=False)


def _languages(scan: scan_mod.ScanResult) -> list[str]:
    langs: set[str] = set()
    for f in scan.files:
        if f.kind == "python":
            langs.add("Python")
        elif f.kind == "js":
            suffix = "." + f.rel.rsplit(".", 1)[-1].lower()
            langs.add("TypeScript" if suffix in {".ts", ".tsx", ".mts", ".cts"} else "JavaScript")
    return sorted(langs)


def analyse(repo: str) -> Analysis:
    """Scan + parse *repo* and build the complete payload. Never executes repo code."""
    scanned = scan_mod.scan(repo)
    graph = pygraph.build_graph(scanned)
    js_graph = jsgraph.build_graph(scanned)
    entries = entry_mod.find_entries(scanned, graph, scanned.root.name)
    fingerprint = f"sha256:{scanned.fingerprint}"
    level_set = levels_mod.build_levels(scanned, graph, js_graph, entries, fingerprint)

    warnings: list[str] = []
    warnings.extend(scanned.warnings)
    warnings.extend(graph.warnings)
    warnings.extend(entries.warnings)
    warnings.extend(js_graph.warnings)
    if graph.parse_errors:
        first = graph.parse_errors[0]
        warnings.append(
            f"{len(graph.parse_errors)} Python file(s) could not be parsed "
            f"(first: {first['path']}: {first['error']})"
        )
    if graph.unresolved:
        warnings.append(
            f"{len(graph.unresolved)} import specifier(s) did not resolve to a file in this "
            "repository (third-party, stdlib or dynamic) and are not graph edges"
        )
    if js_graph.unresolved:
        warnings.append(
            f"{len(js_graph.unresolved)} local JavaScript/TypeScript specifier(s) did not resolve "
            "to a scanned file and are not graph edges"
        )
    if any(level.kind == "tests" for level in level_set.levels):
        warnings.append(levels_mod.TESTS_SCOPE_WARNING)
    warnings.extend(level_set.warnings)
    # De-duplicate while keeping the deterministic order.
    seen: set[str] = set()
    ordered: list[str] = []
    for warning in warnings:
        if warning and warning not in seen:
            seen.add(warning)
            ordered.append(warning)

    nodes: dict[str, dict] = {}
    for module in sorted(graph.modules.values(), key=lambda m: m.id):
        nodes[module.id] = {"id": module.id, "path": module.rel}
    js_conflicts: list[str] = []
    for module_id, rel in sorted(js_graph.modules.items()):
        if module_id in nodes:
            js_conflicts.append(module_id)
            continue
        nodes[module_id] = {"id": module_id, "path": rel}
    edges = [e.as_payload() for e in graph.edges] + list(js_graph.edges)
    edges.sort(key=lambda e: (e["source"], e["target"], e["path"], e["line"]))
    if js_conflicts:
        ordered.append(
            f"{len(js_conflicts)} JavaScript/TypeScript module id(s) collided with a Python module "
            f"id and were left out of the graph: {', '.join(js_conflicts[:5])}"
        )

    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "repo": {
            "name": scanned.root.name,
            "fingerprint": fingerprint,
            "languages": _languages(scanned),
            "module_count": len(nodes),
            "edge_count": len(edges),
            "warnings": ordered,
        },
        "graph": {
            "nodes": [nodes[key] for key in sorted(nodes)],
            "edges": edges,
        },
        "levels": [level.as_payload() for level in level_set.levels],
        "unavailable": [dict(item) for item in level_set.unavailable],
    }
    analysis = Analysis(
        scan=scanned,
        py=graph,
        js=js_graph,
        entries=entries,
        level_set=level_set,
        fingerprint=fingerprint,
        warnings=ordered,
    )
    analysis._payload = payload
    return analysis


def build_payload(repo: str) -> dict:
    return analyse(repo).payload


# ── validation ──────────────────────────────────────────────────────────────


def _is_pos_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_nonneg_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def validate_payload(payload: Any) -> list[str]:
    """Return a list of contract violations (empty list means the payload is sound)."""
    problems: list[str] = []
    if not isinstance(payload, dict):
        return ["payload is not a JSON object"]
    if payload.get("schema_version") != SCHEMA_VERSION:
        problems.append(f"schema_version must be {SCHEMA_VERSION}")

    repo = payload.get("repo")
    if not isinstance(repo, dict):
        problems.append("repo must be an object")
        repo = {}
    for key in ("name", "fingerprint"):
        if not isinstance(repo.get(key), str) or not repo.get(key):
            problems.append(f"repo.{key} must be a non-empty string")
    if not isinstance(repo.get("languages"), list) or not all(
        isinstance(x, str) for x in repo.get("languages") or []
    ):
        problems.append("repo.languages must be an array of strings")
    if not isinstance(repo.get("warnings"), list) or not all(
        isinstance(x, str) for x in repo.get("warnings") or []
    ):
        problems.append("repo.warnings must be an array of strings")

    graph = payload.get("graph")
    if not isinstance(graph, dict):
        problems.append("graph must be an object")
        graph = {}
    raw_nodes = graph.get("nodes")
    raw_edges = graph.get("edges")
    if not isinstance(raw_nodes, list):
        problems.append("graph.nodes must be an array")
        raw_nodes = []
    if not isinstance(raw_edges, list):
        problems.append("graph.edges must be an array")
        raw_edges = []

    node_ids: set[str] = set()
    for index, node in enumerate(raw_nodes):
        if not isinstance(node, dict):
            problems.append(f"graph.nodes[{index}] is not an object")
            continue
        nid = node.get("id")
        if not isinstance(nid, str) or not nid:
            problems.append(f"graph.nodes[{index}].id must be a non-empty string")
            continue
        if nid in node_ids:
            problems.append(f"graph.nodes has a duplicate id {nid!r}")
        node_ids.add(nid)
        if not isinstance(node.get("path"), str) or not node.get("path"):
            problems.append(f"graph.nodes[{index}].path must be a non-empty string")

    for index, edge in enumerate(raw_edges):
        if not isinstance(edge, dict):
            problems.append(f"graph.edges[{index}] is not an object")
            continue
        for key in ("source", "target"):
            value = edge.get(key)
            if value not in node_ids:
                problems.append(f"graph.edges[{index}].{key} {value!r} is not a graph node id")
        if not isinstance(edge.get("path"), str) or not edge.get("path"):
            problems.append(f"graph.edges[{index}].path must be a non-empty string")
        if not _is_pos_int(edge.get("line")):
            problems.append(f"graph.edges[{index}].line must be a positive integer")
        if not isinstance(edge.get("code"), str):
            problems.append(f"graph.edges[{index}].code must be a string")

    if repo.get("module_count") != len(node_ids):
        problems.append(
            f"repo.module_count ({repo.get('module_count')!r}) does not match "
            f"{len(node_ids)} graph nodes"
        )
    if repo.get("edge_count") != len(raw_edges):
        problems.append(
            f"repo.edge_count ({repo.get('edge_count')!r}) does not match "
            f"{len(raw_edges)} graph edges"
        )

    raw_levels = payload.get("levels")
    if not isinstance(raw_levels, list):
        problems.append("levels must be an array")
        raw_levels = []
    level_ids: set[str] = set()
    for index, level in enumerate(raw_levels):
        where = f"levels[{index}]"
        if not isinstance(level, dict):
            problems.append(f"{where} is not an object")
            continue
        lid = level.get("id")
        if not isinstance(lid, str) or not lid:
            problems.append(f"{where}.id must be a non-empty string")
        elif lid in level_ids:
            problems.append(f"{where}.id {lid!r} is duplicated")
        else:
            level_ids.add(lid)
        if level.get("kind") not in LEVEL_KINDS:
            problems.append(f"{where}.kind must be one of {LEVEL_KINDS}")
        for key in ("title", "objective", "subject"):
            if not isinstance(level.get(key), str) or not level.get(key):
                problems.append(f"{where}.{key} must be a non-empty string")

        raw_evidence = level.get("evidence")
        if not isinstance(raw_evidence, list):
            problems.append(f"{where}.evidence must be an array")
            raw_evidence = []
        evidence_ids: set[str] = set()
        for e_index, ev in enumerate(raw_evidence):
            ewhere = f"{where}.evidence[{e_index}]"
            if not isinstance(ev, dict):
                problems.append(f"{ewhere} is not an object")
                continue
            eid = ev.get("id")
            if not isinstance(eid, str) or not eid:
                problems.append(f"{ewhere}.id must be a non-empty string")
            elif eid in evidence_ids:
                problems.append(f"{ewhere}.id {eid!r} is duplicated")
            else:
                evidence_ids.add(eid)
            if not isinstance(ev.get("path"), str) or not ev.get("path"):
                problems.append(f"{ewhere}.path must be a non-empty string")
            if not _is_pos_int(ev.get("line")):
                problems.append(f"{ewhere}.line must be a positive integer")
            if not isinstance(ev.get("code"), str):
                problems.append(f"{ewhere}.code must be a string")
            if not isinstance(ev.get("summary"), str):
                problems.append(f"{ewhere}.summary must be a string")

        raw_cubes = level.get("cubes")
        if not isinstance(raw_cubes, list):
            problems.append(f"{where}.cubes must be an array")
            raw_cubes = []
        cube_ids: set[str] = set()
        correct_ids: set[str] = set()
        for c_index, cube in enumerate(raw_cubes):
            cwhere = f"{where}.cubes[{c_index}]"
            if not isinstance(cube, dict):
                problems.append(f"{cwhere} is not an object")
                continue
            cid = cube.get("id")
            if not isinstance(cid, str) or not cid:
                problems.append(f"{cwhere}.id must be a non-empty string")
                continue
            if cid in cube_ids:
                problems.append(f"{cwhere}.id {cid!r} is duplicated")
            cube_ids.add(cid)
            if not isinstance(cube.get("label"), str) or not cube.get("label"):
                problems.append(f"{cwhere}.label must be a non-empty string")
            if not isinstance(cube.get("correct"), bool):
                problems.append(f"{cwhere}.correct must be a boolean")
            elif cube["correct"]:
                correct_ids.add(cid)
            if not isinstance(cube.get("reason"), str):
                problems.append(f"{cwhere}.reason must be a string")
            refs = cube.get("evidence_ids")
            if not isinstance(refs, list):
                problems.append(f"{cwhere}.evidence_ids must be an array")
                continue
            for ref in refs:
                if ref not in evidence_ids:
                    problems.append(
                        f"{cwhere}.evidence_ids references {ref!r}, which is not in "
                        f"{where}.evidence"
                    )

        answer_ids = level.get("answer_ids")
        if not isinstance(answer_ids, list) or not all(isinstance(a, str) for a in answer_ids):
            problems.append(f"{where}.answer_ids must be an array of strings")
            answer_ids = []
        for answer in answer_ids:
            if answer not in cube_ids:
                problems.append(f"{where}.answer_ids references {answer!r}, which is not a cube")
        if set(answer_ids) != correct_ids:
            problems.append(
                f"{where}.answer_ids {sorted(set(answer_ids))} must equal the set of correct "
                f"cube ids {sorted(correct_ids)} (every correct cube is required)"
            )
        if len(answer_ids) != len(set(answer_ids)):
            problems.append(f"{where}.answer_ids contains duplicates")

        layout = level.get("layout")
        if not isinstance(layout, dict):
            problems.append(f"{where}.layout must be an object")
            continue
        if not _is_nonneg_int(layout.get("seed")):
            problems.append(f"{where}.layout.seed must be a non-negative integer")
        for key, (low, high) in LAYOUT_RANGES.items():
            value = layout.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                problems.append(f"{where}.layout.{key} must be an integer in {low}..{high}")

    raw_unavailable = payload.get("unavailable")
    if not isinstance(raw_unavailable, list):
        problems.append("unavailable must be an array")
        raw_unavailable = []
    for index, item in enumerate(raw_unavailable):
        if not isinstance(item, dict):
            problems.append(f"unavailable[{index}] is not an object")
            continue
        for key in ("kind", "reason"):
            if not isinstance(item.get(key), str) or not item.get(key):
                problems.append(f"unavailable[{index}].{key} must be a non-empty string")
    return problems


# ── export helpers ──────────────────────────────────────────────────────────

#: Characters that must never appear raw inside an inline ``<script>`` block.
#: The two line separators are written via ``chr`` so this file stays pure ASCII.
_SCRIPT_HAZARDS = (
    ("<", "\\u003c"),
    (">", "\\u003e"),
    ("&", "\\u0026"),
    (chr(0x2028), "\\u2028"),
    (chr(0x2029), "\\u2029"),
)


def safe_json_for_script(obj: Any) -> str:
    """JSON that is safe to inline in HTML ``<script>`` (no terminator escapes possible).

    ``"</script>"``, ``"<!--"``, ``"]]>"`` and the Unicode line separators cannot
    terminate or corrupt the script block because every ``<``, ``>`` and ``&`` is
    emitted as a JSON ``\\uXXXX`` escape, which parses back to the same string.
    """
    text = json.dumps(obj, ensure_ascii=True, sort_keys=False, allow_nan=False)
    for needle, replacement in _SCRIPT_HAZARDS:
        text = text.replace(needle, replacement)
    return text


def embed_script_assignment(payload: dict, variable: str = "SOURCE_DRIVE_DATA") -> str:
    """The exact line the frontend embeds, e.g. ``window.SOURCE_DRIVE_DATA = {...};``"""
    return f"window.{variable} = {safe_json_for_script(payload)};"


def payload_digest(payload: dict) -> str:
    """Stable digest of the payload bytes as they would be exported."""
    return hashlib.sha256(safe_json_for_script(payload).encode("utf-8")).hexdigest()
