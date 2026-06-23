---
description: "Manual migration tool for legacy inline-base64 session screenshots — asset-store rewrite, backups, dry runs, and verification"
last_updated: "2026-05-17"
---

# Operator Migration: Legacy Inline-Base64 Sessions

One-shot CLI for rewriting a legacy session JSON whose tool events still carry
inline `imageContent[].data` (base64) into the Stage 2 asset-store layout. Ships
as part of the image-asset architecture (`docs/plans/260516_image_asset_architecture.md`,
Stage 10).

**Status:** operator-grade tool. **Not** auto-run, **not** part of the normal
upgrade path. Run it manually only when a specific session is too large to open
normally.

## Why this exists

A handful of pre-Stage-4 conversations grew to 100+ MB (in one user-reported
case, ~205 MB) because every tool screenshot was persisted as inline base64
inside the session JSON. Restarting Rebel parsed the whole file before the UI
could render and froze the renderer for several seconds. After Stage 4 ships,
all new sessions write image refs instead; this script is the same rewrite
applied to a single legacy session on demand.

## When to run it

Run only when a specific session is causing problems — typically a freeze or
multi-second hang on Rebel restart with that session pinned, or a `sessions/*.json`
file > 50 MB. Other sessions are left as-is; their inline-base64 payload still
renders correctly via the legacy path.

## How to run it

```bash
# Inspect-only: report what the script would do, but write nothing.
node scripts/rewrite-session-images.mjs \
  --session 1f1d079b-dd16-4c23-9f8d-fda7a05162ee \
  --dry-run

# Real migration. Backs up the session JSON before any write.
node scripts/rewrite-session-images.mjs \
  --session 1f1d079b-dd16-4c23-9f8d-fda7a05162ee
```

**Required flags:**

- `--session <id>` — the session UUID to migrate (the `id` in the session JSON
  filename, e.g. `1f1d079b-dd16-4c23-9f8d-fda7a05162ee.json`).

**Optional flags:**

- `--dry-run` — report planned changes; create no backup, write no assets,
  modify no JSON.
- `--user-data <path>` — point at a non-default userData directory (e.g. a
  copy of a user's data folder for offline migration). Defaults to
  `$REBEL_USER_DATA` or the platform default
  (`~/Library/Application Support/mindstone-rebel` on macOS).
- `--verbose` — log every successfully migrated image with its turn and index.

## What it changes on disk

For each tool event with inline `imageContent[i]` that does not already have a
matching `imageRef[i]`, the script:

1. Decodes the base64 payload into bytes.
2. Verifies the MIME type is in the allowlist (`image/png`, `image/jpeg`,
   `image/gif`, `image/webp`) and that the magic bytes match the declared
   MIME.
3. Writes the bytes atomically to
   `${userData}/sessions/${sessionId}.assets/legacy-${turnId}-${eventSeq}-${i}.${ext}`
   (`tmp` file + `fs.link`; deterministic conflict on race, idempotent on
   identical-byte re-runs).
4. Updates `${sessionId}.assets/_manifest.json` to record `uploadStatus: 'pending'`
   so the desktop→cloud outbox (Stage 7a) will push the bytes to cloud on next
   launch.
5. Sets `event.imageRef[i] = { assetId, mimeType, byteSize, uploadStatus: 'pending' }`.
6. Strips `event.imageContent[i].data` (and the parallel
   `event.toolResult.content[]` image block, if present), matching the
   sanitization the runtime would apply (`src/shared/utils/eventSanitization.ts`).

Before any of that happens, the session JSON is copied verbatim to
`${sessionId}.json.backup-<unix-ms>` in the same folder. The script prints the
exact backup path on success.

The script writes a positional `(ImageRef | null)[]` — failed images stay as
`null` slots so the corresponding `imageContent[i]` is preserved as a legacy
fallback. The renderer still has bytes to show for those positions.

## How to verify success

1. The script prints a `Session JSON: X MB -> Y MB` line; `Y` should be a
   small fraction of `X` for a heavy session.
2. `${sessionId}.json.backup-<unix-ms>` should exist next to the rewritten
   session JSON.
3. The `${sessionId}.assets/` folder should contain one image file per
   migrated image plus a `_manifest.json`.
4. Open the conversation in Rebel; it should render normally and **not**
   freeze the renderer on switch / restart.

## How to roll back

If anything looks wrong, restore the backup:

```bash
# (Stop Rebel first.)
cd ~/Library/Application\ Support/mindstone-rebel/sessions
mv 1f1d079b-dd16-4c23-9f8d-fda7a05162ee.json 1f1d079b-dd16-4c23-9f8d-fda7a05162ee.json.broken
mv 1f1d079b-dd16-4c23-9f8d-fda7a05162ee.json.backup-1738152034 \
   1f1d079b-dd16-4c23-9f8d-fda7a05162ee.json
# Optionally remove the asset folder if you want to retry from scratch:
rm -r 1f1d079b-dd16-4c23-9f8d-fda7a05162ee.assets
```

The original JSON includes every inline base64 payload, so restoring is
lossless. The asset folder is a derived artifact and safe to delete and
regenerate.

## Idempotency

The script is safe to re-run. It only writes refs (and asset bytes) for image
slots that don't already have a `imageRef[i]`. If every image in the session
already has a ref, the second invocation reports `Images migrated: 0` and
`Events touched: 0/N`. The session JSON is not rewritten in that case.

Images that fail magic-byte validation (corrupt base64, mislabeled MIME) stay
as inline bytes with a `null` positional ref. The script logs a `warn` for
each such slot and continues. Re-running the script will attempt those slots
again; if the bytes are still corrupt, they fail again with the same warning.

## See also

- `docs/plans/260516_image_asset_architecture.md` — full architecture plan;
  Stage 10 covers this script.
- `src/main/services/assetStoreDesktop.ts` — the production write path the
  script mirrors (atomic publish via `fs.link`, MIME allowlist, magic-byte
  sniff). Thumbnail generation is intentionally NOT mirrored here: the script
  cannot run Electron, and `nativeImage` isn't available outside Electron.
  The renderer protocol falls back to serving the full-size asset when no
  thumbnail file is present.
- `src/shared/utils/eventSanitization.ts` — the in-process sanitization that
  this script's persisted output is expected to match.
