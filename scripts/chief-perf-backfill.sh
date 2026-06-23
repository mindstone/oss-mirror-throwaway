#!/usr/bin/env bash
# Chief-perf backfill helper. Stages allowlisted outputs; never auto-uploads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"

# Resolve a Google Drive subdir under ~/Library/CloudStorage/. When the user has
# not pinned a specific mount via env var, glob for any GoogleDrive-* mount that
# contains "Shared drives/Product/<subdir>"; if exactly one matches, use it;
# otherwise fail loud with concrete instructions. The previous default was a
# hardcoded [external-email] path that no longer matched anyone's primary
# email and silently steered new colleagues into a missing-prefix error.
_resolve_drive_subdir() {
  local subdir="$1" env_value="$2"
  if [[ -n "$env_value" ]]; then
    printf '%s\n' "$env_value"
    return 0
  fi
  local cloud_root="${HOME}/Library/CloudStorage"
  if [[ ! -d "$cloud_root" ]]; then
    printf '\n'
    return 0
  fi
  local match
  local matches=()
  shopt -s nullglob
  for match in "$cloud_root"/GoogleDrive-*/"Shared drives/Product/${subdir}"; do
    [[ -d "$match" ]] && matches+=("$match")
  done
  shopt -u nullglob
  if (( ${#matches[@]} == 1 )); then
    printf '%s\n' "${matches[0]}"
  else
    printf '\n'
  fi
}

REPORTS_PREFIX="$(_resolve_drive_subdir "droid-performance-reports" "${CHIEF_PERF_REPORTS_PREFIX:-}")"
DRIVE_UPLOAD_PREFIX="$(_resolve_drive_subdir "droid-performance-backfills" "${CHIEF_PERF_DRIVE_PREFIX:-}")"
AUTO_DISCOVER=false; ANALYSIS_RUN_DIR=""; WITH_REPLAY=false; DRY_RUN=false; DEV_HANDLE="${CHIEF_PERF_DEV_HANDLE:-}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/chief-perf-backfill.sh [options]

Runs chief_perf_v2 Stage 1 locally, stages only allowlisted files, and prints
(but never runs) the Drive sync command.

Options:
  --auto-discover         Use latest report under CHIEF_PERF_REPORTS_PREFIX.
  --analysis-run-dir DIR  Existing chief_perf_v2 analysis report directory.
  --with-replay           Phase B forward-compat; Phase A does not run replay.
  --dev-handle HANDLE     Override upload handle.
  --dry-run               Run extractor dry-run; do not write or stage outputs.
  --help, -h              Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --auto-discover) AUTO_DISCOVER=true; shift ;;
    --analysis-run-dir) [[ $# -ge 2 ]] || { echo "Error: --analysis-run-dir requires a directory." >&2; exit 2; }; ANALYSIS_RUN_DIR="$2"; shift 2 ;;
    --with-replay) WITH_REPLAY=true; shift ;;
    --dev-handle) [[ $# -ge 2 ]] || { echo "Error: --dev-handle requires a value." >&2; exit 2; }; DEV_HANDLE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

printf '%s\n%s\n%s\n\n' \
  "Privacy notice: raw Factory session JSONLs stay local. Only allowlisted" \
  "output files (NDJSONs + metadata + README) are staged for upload. Do not" \
  "touch the staging dir between staging and rsync; review it before syncing."
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "Error: Python executable not found: $PYTHON_BIN" >&2; exit 2; }
export PYTHONPATH="${REPO_ROOT}/coding-agent-instructions/scripts:${PYTHONPATH:-}"

if [[ -z "$ANALYSIS_RUN_DIR" ]]; then
  [[ "$AUTO_DISCOVER" == true ]] || { echo "Error: pass --analysis-run-dir DIR or --auto-discover." >&2; exit 2; }
  if [[ -z "$REPORTS_PREFIX" ]]; then
    cat >&2 <<EOF_REPORTS
Error: could not auto-detect the Drive analysis-reports prefix.

Set CHIEF_PERF_REPORTS_PREFIX to the directory containing dated
chief_perf_v2 run dirs (e.g. 260514_1328_chief_perf_32d/). Typical location:
  \${HOME}/Library/CloudStorage/GoogleDrive-<your email>/Shared drives/Product/droid-performance-reports
EOF_REPORTS
    exit 2
  fi
  ANALYSIS_RUN_DIR="$("$PYTHON_BIN" -c 'from pathlib import Path; import sys
root = Path(sys.argv[1]).expanduser()
if not root.is_dir(): raise SystemExit(f"reports prefix does not exist: {root}")
runs = sorted(p for p in root.iterdir() if p.is_dir())
if not runs: raise SystemExit(f"no analysis run dirs found under: {root}")
print(runs[-1])' "$REPORTS_PREFIX")"
fi
[[ -d "$ANALYSIS_RUN_DIR" ]] || { echo "Error: analysis run dir does not exist or is not a directory: $ANALYSIS_RUN_DIR" >&2; exit 2; }

if [[ -z "$DEV_HANDLE" ]]; then
  email="$(git -C "$REPO_ROOT" config user.email || true)"
  [[ -n "$email" ]] && DEV_HANDLE="${email%@*}" || DEV_HANDLE="$(whoami)"
fi
DEV_HANDLE="$(printf '%s' "$DEV_HANDLE" | tr -c 'A-Za-z0-9._-' '_')"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-${DEV_HANDLE}"
OUTPUT_DIR="${HOME}/.factory/chief-perf-backfills/${RUN_ID}"
STAGING_DIR="${OUTPUT_DIR}/upload_staging"
DRIVE_TARGET="${DRIVE_UPLOAD_PREFIX}/${DEV_HANDLE}/${RUN_ID}"
ALLOWLIST="$("$PYTHON_BIN" -c 'from chief_perf_v2.upload_allowlist import COPY_ALLOWLIST; print(", ".join(COPY_ALLOWLIST))')"

cat <<EOF_CONFIG
Resolved configuration:
  repo:             $REPO_ROOT
  analysis run dir: $ANALYSIS_RUN_DIR
  dev handle:       $DEV_HANDLE
  output dir:       $OUTPUT_DIR
  staging dir:      $STAGING_DIR
  allowlist:        $ALLOWLIST
EOF_CONFIG
[[ "$WITH_REPLAY" == false ]] || echo "Note: --with-replay is reserved for Phase B; Phase A runs Stage 1 only."

if [[ "$DRY_RUN" != true ]]; then
  mkdir -p "$OUTPUT_DIR"
  "$PYTHON_BIN" -c 'import json, sys; from pathlib import Path
analysis=Path(sys.argv[1]); out=Path(sys.argv[2]); data=analysis/"data"
files=sorted(({"name": p.name, "size": p.stat().st_size} for p in data.iterdir() if p.is_file()), key=lambda x: x["name"]) if data.is_dir() else []
(out/"pre_write_inventory.json").write_text(json.dumps({"helper":"scripts/chief-perf-backfill.sh","analysis_run_dir":str(analysis),"data_dir":str(data),"data_dir_exists":data.is_dir(),"files":files}, indent=2, sort_keys=True)+"\n", encoding="utf-8")' "$ANALYSIS_RUN_DIR" "$OUTPUT_DIR"
fi

BACKFILL_ARGS=(-m chief_perf_v2.backfill_from_factory --analysis-run-dir "$ANALYSIS_RUN_DIR" --output "$OUTPUT_DIR/review_scores_backfilled.ndjson" --metadata "$OUTPUT_DIR/backfill_metadata.json" --skip-if-unchanged)
[[ "$DRY_RUN" == false ]] || BACKFILL_ARGS+=(--dry-run)
"$PYTHON_BIN" "${BACKFILL_ARGS[@]}"

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete. No output files were written, no staging dir was created, and nothing was uploaded."
  exit 0
fi

"$PYTHON_BIN" -c 'import sys; from pathlib import Path
analysis=Path(sys.argv[1]); out=Path(sys.argv[2]); run_id=sys.argv[3]; dev=sys.argv[4]
(out/"README.md").write_text(f"# Chief-perf backfill run\n\n- Run ID: `{run_id}`\n- Developer handle: `{dev}`\n- Source analysis run: `{analysis}`\n\nCreated by `scripts/chief-perf-backfill.sh`. Raw Factory session JSONLs remain local.\n", encoding="utf-8")' "$ANALYSIS_RUN_DIR" "$OUTPUT_DIR" "$RUN_ID" "$DEV_HANDLE"
"$PYTHON_BIN" -c 'import sys; from pathlib import Path
from chief_perf_v2.upload_staging import list_skipped_files, stage_for_upload
copied=stage_for_upload(Path(sys.argv[1]), Path(sys.argv[2])); skipped=list_skipped_files(Path(sys.argv[1]))
print("Staged allowlisted files:"); print("\n".join(f"  - {x}" for x in copied) if copied else "  (none)")
print("Found but not staged:"); print("\n".join(f"  - {x}" for x in skipped) if skipped else "  (none)")' "$OUTPUT_DIR" "$STAGING_DIR"

echo "Not uploading automatically. Review the staging dir, then copy this command if it looks right:"
if [[ -z "$DRIVE_UPLOAD_PREFIX" ]]; then
  cat <<EOF_UPLOAD
Note: could not auto-detect the Drive upload prefix. Set CHIEF_PERF_DRIVE_PREFIX
to your Drive backfills root (e.g. \${HOME}/Library/CloudStorage/GoogleDrive-<your email>/Shared drives/Product/droid-performance-backfills),
then rsync the staging dir there:
EOF_UPLOAD
  printf 'Drive sync: rsync -a %q/ <CHIEF_PERF_DRIVE_PREFIX>/%q/%q/\n' "$STAGING_DIR" "$DEV_HANDLE" "$RUN_ID"
else
  printf 'Drive sync: rsync -a %q/ %q/\n' "$STAGING_DIR" "$DRIVE_TARGET"
fi
