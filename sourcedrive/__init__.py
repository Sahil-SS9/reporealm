"""RepoRealm backend (internal package name: ``sourcedrive``).

Analyse a repository, then export or serve the game.

Public surface (everything else is internal):

``analyse(repo) -> Analysis``
    Scan and parse a repository, returning the analysis and its
    ``schema_version = 1`` payload. Read-only; repository code is never imported
    or executed.
``build_payload(repo) -> dict``
    The payload alone, as the exporter consumes it.
``validate_payload(payload) -> list[str]``
    Contract violations (empty list means sound).
``safe_json_for_script(obj) -> str``
    JSON that cannot terminate an inline ``<script>`` block.
``export_repo(repo, out, ...) -> ExportResult``
    Payload + the frontend exporter (``scripts/build_web.py``) -> single-file game.
``play_repo(repo, ...) -> PlayResult``
    Export into the runtime cache and serve it on loopback.
``stop_records`` / ``select_records``
    Verified shutdown of managed servers.
"""

from __future__ import annotations

__version__ = "0.3.0"

from .payload import (  # noqa: E402
    SCHEMA_VERSION,
    Analysis,
    analyse,
    build_payload,
    embed_script_assignment,
    payload_digest,
    safe_json_for_script,
    validate_payload,
)

__all__ = [
    "SCHEMA_VERSION",
    "Analysis",
    "__version__",
    "analyse",
    "build_payload",
    "embed_script_assignment",
    "payload_digest",
    "safe_json_for_script",
    "validate_payload",
]
