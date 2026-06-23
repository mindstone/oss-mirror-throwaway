---
description: "Google Drive path resolution for Mindstone scripts and evals — shared-drive discovery, fallbacks, consumers, and CLI usage"
last_updated: "2026-05-12"
---

# Google Drive Path Resolution

How scripts and eval harnesses find the Mindstone Google Shared Drive on macOS.

## See Also

- `coding-agent-instructions/scripts/drive_resolver.py` — canonical Python implementation (importable + CLI)
- `scripts/resolve_mindstone_drive.py` — re-export shim for backwards compatibility
- `evals/shared.ts` → `resolveMindstoneProductDrive()` — canonical TypeScript implementation
- `scripts/lib/mindstone-drive.ts` — standalone TypeScript shim for `scripts/` tooling (no `@core/*` imports, safe to use from plain `npx tsx`)
- [TESTING_EVALS_KNOWLEDGE_WORK](TESTING_EVALS_KNOWLEDGE_WORK.md) — eval runner that writes results to the drive
- [TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS](TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md) — analyzer that reads from the drive
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — pathologist HTML reports written to the drive
- [CHIEF_ENGINEER_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_ENGINEER_ANALYSIS.md) — performance reports written to the drive

## The Problem

Multiple Google Drive accounts can be synced simultaneously on macOS. Each gets a folder at `~/Library/CloudStorage/GoogleDrive-<email>`. When scripts iterate alphabetically and pick the first match with `Shared drives/Product`, they may write to the wrong account (e.g. a personal `@personal.example` drive instead of the team `@example.com` drive).

## Resolution Logic

Both Python and TypeScript implementations use the same fallback chain:

1. **`MINDSTONE_PRODUCT_DRIVE` env var** — explicit override, checked first
2. **`@example.com` preference** — scan `GoogleDrive-*` entries, prefer any containing `@example.com`
3. **Legacy fallback** — first `GoogleDrive-*` with `Shared drives/Product` (for non-Mindstone setups)

The resolved path points to: `~/Library/CloudStorage/GoogleDrive-<email>/Shared drives/Product`

## Usage

### Python

```python
# From within coding-agent-instructions/hooks/:
from drive_resolver import resolve_mindstone_product_drive, resolve_mindstone_product_subdir

# From elsewhere in the repo:
import sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[N] / "scripts"))  # adjust N for depth
from resolve_mindstone_drive import resolve_mindstone_product_drive, resolve_mindstone_product_subdir

# Get the Product root
drive = resolve_mindstone_product_drive()  # -> str | None

# Get a subdirectory (optionally create it)
results = resolve_mindstone_product_subdir("evals", "results", "knowledge-work")
reports = resolve_mindstone_product_subdir("droid-pathologist-reports", create=True)
```

### TypeScript

```typescript
import { resolveMindstoneProductDrive } from './shared';

const drive = resolveMindstoneProductDrive();  // -> string | null
```

### CLI

```bash
python3 scripts/resolve_mindstone_drive.py                     # prints Product path
python3 scripts/resolve_mindstone_drive.py evals/results       # prints subdirectory
python3 scripts/resolve_mindstone_drive.py --check             # exits 0/1
```

## Consumers

All of these use the shared resolution (not their own copy-pasted logic):

| Script | What it writes | Subdirectory |
|--------|---------------|--------------|
| `evals/shared.ts` | Eval results JSON + markdown | `evals/results/<category>/` |
| `evals/analyze-knowledge-work.ts` | Analysis HTML reports | `evals/analysis/` |
| `coding-agent-instructions/hooks/export_transcript.py` | Conversation transcripts | `droid-conversations/<repo-slug>/` |
| `coding-agent-instructions/scripts/analyze_chief_performance.py` | Reads conversations | `droid-conversations/` (scans all repo subfolders) |
| `coding-agent-instructions/scripts/analyze_bug_postmortems.py` | Reads conversations | `droid-conversations/` (scans all repo subfolders) |
| `coding-agent-instructions/scripts/backfill_transcript_owner.py` | Backfills transcript owners | `droid-conversations/` |
| `coding-agent-instructions/scripts/generate_pathologist_html.py` | Pathology HTML reports | `droid-pathologist-reports/` |
| `coding-agent-instructions/scripts/generate_fix_commit_taxonomy.py` | Fix-commit taxonomy JSONL + markdown + meta | `droid-pathologist-reports/fix-taxonomy/` |
| `coding-agent-instructions/scripts/generate_chief_performance_html.py` | Performance HTML reports | `droid-performance-reports/` |
| `coding-agent-instructions/scripts/extract_user_messages.py` | Reads conversations | `droid-conversations/` |
| `scripts/lib/sync-timing.ts` (via `scripts/lib/mindstone-drive.ts`) | git-safe-sync timing logs + `--trace-git` sidecars | `git-safe-sync-logs/<repo>/YYYY-MM/` |

## Google Drive Folder Name Convention

On macOS, Google Drive for Desktop always names sync folders `GoogleDrive-<email>`. When the same account is re-added, macOS appends a timestamp: `GoogleDrive-<email> (YYYY-MM-DD HH:MM)`. The email is always present regardless of how many accounts are connected.

## Adding a New Consumer

1. Import from `coding-agent-instructions/scripts/drive_resolver.py` (within hooks) or `scripts/resolve_mindstone_drive.py` (from parent repo). For TypeScript, call `resolveMindstoneProductDrive()`.
2. Do NOT copy-paste the resolution logic
3. Add your script to the consumers table above
