#!/usr/bin/env python3
"""Compatibility entry point for the pre-package analyser.

Kept so ``python analyse.py <repo>`` (and anything that shelled out to it) keeps
working. It now writes the shared ``schema_version = 1`` payload and shares one
implementation with the package and the plugin.

usage: analyse.py <repo> [--out payload.json] [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # executed as a script: make the package importable
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from sourcedrive import payload as payload_mod  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyse a repository into the RepoRealm payload.")
    parser.add_argument("repo")
    parser.add_argument("--out", default="", help="write the payload here instead of stdout")
    parser.add_argument("--check", action="store_true", help="exit non-zero if the payload breaks the contract")
    args = parser.parse_args(argv)

    analysis = payload_mod.analyse(args.repo)
    data = analysis.payload
    problems = payload_mod.validate_payload(data)

    text = json.dumps(data, indent=2, ensure_ascii=True) + "\n"
    if args.out:
        Path(args.out).expanduser().write_text(text, encoding="utf-8")
        print(
            f"{len(data['levels'])} levels from {data['repo']['module_count']} modules "
            f"({data['repo']['edge_count']} edges) -> {args.out}",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(text)

    if problems:
        for problem in problems:
            print(f"payload problem: {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
