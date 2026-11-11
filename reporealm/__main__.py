"""``python -m reporealm`` entry point.

Delegates to the internal implementation so a behaviour verified against
``sourcedrive.cli`` is exactly the behaviour this public entry point gets.
"""

from __future__ import annotations

from sourcedrive.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
