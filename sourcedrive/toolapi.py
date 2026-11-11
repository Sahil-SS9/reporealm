"""Read-only view of an analysis result for agent tools.

The full payload can be large on a big repository, so the tool result is capped.
Trimming is explicit: the payload keeps its contract shape and gains a warning
that names what was dropped, instead of silently returning a partial graph.
"""

from __future__ import annotations

import json
from typing import Any

from . import payload as payload_mod

DEFAULT_MAX_CHARS = 180_000
TRUNCATION_WARNING = (
    "tool result trimmed to fit the agent context budget: graph edges were dropped, "
    "so repo.edge_count no longer matches the edges present here. Re-run the analyser "
    "with `python -m reporealm analyse <repo> --out payload.json` for the full graph."
)


def trim_payload(payload: dict, max_chars: int = DEFAULT_MAX_CHARS) -> dict:
    """Return *payload*, dropping graph edges (then nodes) until it fits *max_chars*."""
    encoded = payload_mod.safe_json_for_script(payload)
    if len(encoded) <= max_chars:
        return payload
    trimmed = json.loads(json.dumps(payload))  # deep copy, JSON-safe only
    warnings = trimmed.setdefault("repo", {}).setdefault("warnings", [])
    if TRUNCATION_WARNING not in warnings:
        warnings.append(TRUNCATION_WARNING)
    edges = trimmed.get("graph", {}).get("edges", [])
    # Halve the edge list until the document fits. Deterministic and simple.
    keep = len(edges)
    while keep > 0:
        keep //= 2
        trimmed["graph"]["edges"] = edges[:keep]
        if len(payload_mod.safe_json_for_script(trimmed)) <= max_chars:
            return trimmed
    trimmed["graph"]["edges"] = []
    trimmed["repo"]["truncated_edge_count"] = len(edges)
    return trimmed


def chambers_json(repo: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """The tool's answer: a JSON string with the schema_version 1 payload."""
    analysis = payload_mod.analyse(repo)
    data = analysis.payload
    problems = payload_mod.validate_payload(data)
    if problems:  # a contract violation is a bug here, not something to paper over
        return json.dumps(
            {"error": "analyser produced a payload that violates the shared contract",
             "problems": problems[:10]},
            indent=2,
        )
    return json.dumps(trim_payload(data, max_chars), ensure_ascii=True)


def summary_dict(payload: dict) -> dict[str, Any]:
    """Small, human-facing digest of a payload (used by the slash command)."""
    repo = payload.get("repo", {})
    return {
        "name": repo.get("name"),
        "fingerprint": repo.get("fingerprint"),
        "modules": repo.get("module_count"),
        "edges": repo.get("edge_count"),
        "languages": repo.get("languages", []),
        "levels": [
            {
                "id": level.get("id"),
                "kind": level.get("kind"),
                "title": level.get("title"),
                "subject": level.get("subject"),
                "cubes": len(level.get("cubes", [])),
                "required": len(level.get("answer_ids", [])),
            }
            for level in payload.get("levels", [])
        ],
        "unavailable": payload.get("unavailable", []),
        "warnings": repo.get("warnings", []),
    }
