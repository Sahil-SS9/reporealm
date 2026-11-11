"""RepoRealm - the public package name for the import-graph reading chamber.

The implementation stays in the internal :mod:`sourcedrive` package: one runtime,
not a duplicate. This module exists so the public module path, the ``reporealm``
console script and ``python -m reporealm`` all match the product name while the
private compatibility identifiers (``sourcedrive``, ``SD`` / ``SourceDrive`` game
globals, ``SOURCE_DRIVE_DATA``) keep working.

Public surface:

``__version__``
    The candidate version, shared with ``plugin.yaml`` and ``pyproject.toml``.
``main(argv=None) -> int``
    The command line entry point (same code path as ``python -m sourcedrive``).
"""

from __future__ import annotations

from sourcedrive import __version__
from sourcedrive.cli import main

__all__ = ["__version__", "main"]
