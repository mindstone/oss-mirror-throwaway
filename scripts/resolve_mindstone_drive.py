#!/usr/bin/env python3
"""Resolve the Mindstone Google Shared Drive path on macOS.

Re-exports from coding-agent-instructions/scripts/drive_resolver.py (canonical source).
This shim exists for backwards compatibility with scripts that import from here.

Usage as library:
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
    from resolve_mindstone_drive import resolve_mindstone_product_drive

Usage as CLI:
    python3 scripts/resolve_mindstone_drive.py                    # prints Product path
    python3 scripts/resolve_mindstone_drive.py evals/results      # prints subdirectory
    python3 scripts/resolve_mindstone_drive.py --check            # exits 0 if found, 1 if not

TypeScript equivalent: resolveMindstoneProductDrive() in evals/shared.ts

See also: docs/project/GOOGLE_DRIVE_PATH_RESOLUTION.md
"""

import sys
from pathlib import Path

# Import from canonical source in submodule
_resolver_dir = Path(__file__).resolve().parent.parent / "coding-agent-instructions" / "scripts"
if str(_resolver_dir) not in sys.path:
    sys.path.insert(0, str(_resolver_dir))

try:
    from drive_resolver import (  # noqa: E402
        resolve_mindstone_product_drive,
        resolve_mindstone_product_subdir,
        detect_repo_slug,
        validate_repo_slug,
    )

    # Re-export constants for any direct consumers
    from drive_resolver import MINDSTONE_DOMAIN, SHARED_DRIVE_NAME  # noqa: E402
except ImportError as exc:  # pragma: no cover - environmental
    print(
        f"[resolve_mindstone_drive] CRITICAL: drive_resolver module not importable "
        f"from {_resolver_dir} ({exc}). This is a packaging regression; "
        "verify the coding-agent-instructions submodule is up to date.",
        file=sys.stderr,
    )
    raise


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Resolve Mindstone Google Drive Product path")
    parser.add_argument("subdir", nargs="?", help="Subdirectory under Product (e.g. evals/results)")
    parser.add_argument("--check", action="store_true", help="Exit 0 if found, 1 if not")
    args = parser.parse_args()

    if args.subdir:
        parts = args.subdir.replace("\\", "/").split("/")
        result = resolve_mindstone_product_subdir(*parts)
    else:
        result = resolve_mindstone_product_drive()

    if args.check:
        import os
        sys.exit(0 if result and os.path.isdir(result) else 1)

    if result:
        print(result)
    else:
        print("ERROR: Mindstone Google Drive not found", file=sys.stderr)
        sys.exit(1)
