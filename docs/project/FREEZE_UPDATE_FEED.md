---
description: "Runbook: freeze the stable auto-update feed at a previous good version (PROD_INCIDENT_ROLLBACK Option B) — the concrete GCS procedure, gotchas, verification, and how a forward release lifts it"
last_updated: "2026-06-16"
---

# Freeze the Auto-Update Feed (stop-the-bleed)

The concrete, validated procedure for **capping the spread of a bad stable build** by repointing the GCS update feeds back at the last good version. This is the executable detail behind **Option B** of [PROD_INCIDENT_ROLLBACK.md](./PROD_INCIDENT_ROLLBACK.md) — read that first for the doctrine; read this when you're about to run the freeze.

## See also

- [PROD_INCIDENT_ROLLBACK.md](./PROD_INCIDENT_ROLLBACK.md) — the territory doc: forward-only constraint, Option B (this) vs Option C (roll forward).
- [AUTO_UPDATE.md](./AUTO_UPDATE.md) — feed URLs, hourly poll, the `Cache-Control` propagation gotcha. Source: `src/main/services/autoUpdateService.ts`.
- [CI_PIPELINE.md](./CI_PIPELINE.md) — channel/feed-URL matrix; the publish steps a forward release runs (`.github/workflows/release.yml`).
- [RELEASE_TO_PRODUCTION.md](./RELEASE_TO_PRODUCTION.md) / [PROMOTE_BETA_TO_PRODUCTION.md](./PROMOTE_BETA_TO_PRODUCTION.md) — the roll-forward that actually fixes affected users.
- Worked example: `docs/plans/260616_freeze-stable-feed-046/` (0.4.47→0.4.46 freeze, with the cross-model review that found the must-fixes below).

## What this does — and the three things it does NOT do

A freeze repoints the feed so clients that **haven't yet updated** to the bad version stop being offered it. That's all. It is **not**:

1. **Not a downgrade of existing clients.** Auto-update is forward-only (`electronUpdater.allowDowngrade = false`; Squirrel.Mac is intrinsically forward-only). Clients already on the bad version stay there until a higher-versioned fix ships. Clients that already *downloaded* the bad version may still install it from local updater state.
2. **Not a fix.** If the bug also exists in the version you're freezing to, freezing changes nothing for anyone — confirm the target version is actually good first.
3. **Not instant.** Clients poll hourly and the feeds default to `max-age=3600`; even with no-cache headers, in-flight/edge-cached responses can lag up to ~1h.

If the bad build is already widespread, freezing is low-value — go straight to **Option C (roll forward)**.

## The two feeds (the #1 mistake to avoid)

There are **two separate "latest version" surfaces**. Editing the wrong one does nothing for auto-update:

| File | Drives | Read by |
|------|--------|---------|
| `gs://mindstone-rebel/releases/latest.json` | Website/manual downloads + the "you're N behind" banner | `versionCheckService.ts` (banner); download page. **NOT the in-app updater.** |
| `gs://mindstone-rebel/updates/darwin/{arm64,x64}/RELEASES.json` | **Mac auto-update** (Squirrel.Mac) | electron / `update-electron-app` |
| `gs://mindstone-rebel/updates/win32/x64/latest.yml` | **Windows auto-update** | electron-updater |

To stop the **auto-update** spread you MUST edit the `updates/...` feeds. Editing `releases/latest.json` only affects new website downloads + the banner. A full freeze does both. (Beta channel is the same layout under `updates-beta/` / `releases-beta/`.)

## Prerequisites

- `gsutil` authenticated with **write** access to `gs://mindstone-rebel` (release-owner Google account).
- Confirm the **target version's artifacts still exist** in the bucket (see Step 1/3 checks) — old binaries are not garbage-collected, but verify.
- *(AI agents)* prod-bucket writes are blocked by the Claude Code auto-mode classifier until the user explicitly authorises in-conversation, or adds a `Bash(gsutil:*)` permission rule.

## Pre-flight interlock (MUST)

Do **not** run a freeze while a production release is publishing — it clobbers `releases/latest.json` and corrupts the release's own GCS-verify poll (`scripts/release-to-production.ts` polls that object for the just-released version).

```bash
gh run list --workflow release.yml --limit 6   # confirm none in-progress
# also: nobody running scripts/release-to-production.ts; no imminent publish
```

## Procedure

Set the target (last known-good) version once. All commands assume macOS (`stat -f%z`).

```bash
set -euo pipefail
FREEZE_TO="0.4.46"                                   # <-- last good version
NC="Cache-Control:no-cache,no-store,max-age=0,must-revalidate"
TS=$(date +%Y%m%d-%H%M%S); echo "freeze stamp: $TS"  # RECORD — needed to abort
```

### Step 0 — back up the 4 live feed objects (abort-only; see Undo)
```bash
gsutil cp gs://mindstone-rebel/releases/latest.json               "gs://mindstone-rebel/releases/_freeze-backup-$TS-latest.json"
gsutil cp gs://mindstone-rebel/updates/darwin/arm64/RELEASES.json "gs://mindstone-rebel/updates/darwin/arm64/_freeze-backup-$TS.json"
gsutil cp gs://mindstone-rebel/updates/darwin/x64/RELEASES.json   "gs://mindstone-rebel/updates/darwin/x64/_freeze-backup-$TS.json"
gsutil cp gs://mindstone-rebel/updates/win32/x64/latest.yml       "gs://mindstone-rebel/updates/win32/x64/_freeze-backup-$TS.yml"
```

### Step 1 — Mac: flip `currentRelease` (no whole-file to copy — the feed is a single cumulative file)
The `releases[]` array already contains every shipped version, so freezing = pointing `currentRelease` at the good one. Abort loudly if the target isn't in the array or the JSON is malformed.
```bash
for arch in arm64 x64; do
  gsutil cp "gs://mindstone-rebel/updates/darwin/$arch/RELEASES.json" "/tmp/REL-$arch.json"
  jq -e --arg v "$FREEZE_TO" 'has("currentRelease") and ([.releases[].version]|index($v))' "/tmp/REL-$arch.json" >/dev/null \
    || { echo "ABORT $arch: $FREEZE_TO not present / malformed"; exit 1; }
  jq --arg v "$FREEZE_TO" '.currentRelease=$v' "/tmp/REL-$arch.json" > "/tmp/REL-$arch.frozen.json"
  jq -e . "/tmp/REL-$arch.frozen.json" >/dev/null || { echo "ABORT $arch: bad JSON"; exit 1; }
  gsutil -h "$NC" cp "/tmp/REL-$arch.frozen.json" "gs://mindstone-rebel/updates/darwin/$arch/RELEASES.json"
done
```

### Step 2 — Website/manual download manifest (whole-file copy — simplest)
```bash
gsutil -h "$NC" cp "gs://mindstone-rebel/releases/$FREEZE_TO/manifest.json" gs://mindstone-rebel/releases/latest.json
```

### Step 3 — Windows: reconstruct `latest.yml` (no archive exists; recompute sha512)
**Never pipe `curl` straight into `openssl`** — a 404/HTML body would still yield a valid-looking but wrong hash and break Windows updates. Download to a file, verify the byte size, then hash the file.
```bash
EXE="/tmp/rebel-app-Setup-$FREEZE_TO.exe"
curl -fL --retry 3 --retry-delay 2 -o "$EXE" \
  "https://storage.googleapis.com/mindstone-rebel/updates/win32/x64/rebel-app-Setup-$FREEZE_TO.exe"
SIZE=$(stat -f%z "$EXE")                              # cross-check against the known artifact size
SHA=$(openssl dgst -sha512 -binary "$EXE" | openssl base64 -A)
cat > /tmp/latest.yml <<EOF
version: $FREEZE_TO
files:
  - url: rebel-app-Setup-$FREEZE_TO.exe
    sha512: $SHA
    size: $SIZE
path: rebel-app-Setup-$FREEZE_TO.exe
sha512: $SHA
releaseDate: '<the target version's build timestamp>'
EOF
cat /tmp/latest.yml                                   # eyeball before upload
gsutil -h "$NC" cp /tmp/latest.yml gs://mindstone-rebel/updates/win32/x64/latest.yml
gsutil setmeta -h "Content-Type:application/yaml" gs://mindstone-rebel/updates/win32/x64/latest.yml
```
A missing `.exe.blockmap` (we don't generate them) is harmless — electron-updater falls back to a full download.

### Step 4 — verify (MUST — catches half-applied / typo failures)
```bash
CB="?cb=$(date +%s%N)"
curl -s "https://storage.googleapis.com/mindstone-rebel/releases/latest.json$CB" | jq -r .version
for a in arm64 x64; do curl -s "https://storage.googleapis.com/mindstone-rebel/updates/darwin/$a/RELEASES.json$CB" | jq -r .currentRelease; done
curl -s "https://storage.googleapis.com/mindstone-rebel/updates/win32/x64/latest.yml$CB" | head -1
# all four must read $FREEZE_TO. Confirm no-cache via gsutil stat (AUTHORITATIVE — an HTTP HEAD
# can show a stale max-age=3600 from an edge cache even when the object metadata is correct):
for o in releases/latest.json updates/darwin/arm64/RELEASES.json updates/darwin/x64/RELEASES.json updates/win32/x64/latest.yml; do
  gsutil stat "gs://mindstone-rebel/$o" | grep -iE "Cache-Control|Content-Type"
done
```

## Undo / how the freeze is lifted

- **To ABORT the freeze itself** (before any fix ships) — restore the four `_freeze-backup-$TS-*` objects over their live counterparts (with `$NC`). This re-exposes the bad version, so only do it if you're aborting the freeze decision.
- **When the fixed forward release (e.g. the next patch) ships — do NOTHING manual to undo.** The release pipeline overwrites all four objects automatically: `releases/latest.json` (`release.yml` ~L2440, **with** no-cache), Mac `RELEASES.json` (~L2219) and Win `latest.yml` (~L2254). **Do NOT restore the backups** — they hold the *bad* version; restoring after the fix ships would re-break the feed.
- **One recommended manual step after a forward release:** CI uploads the two **updater** feeds *without* no-cache (only `releases/latest.json` gets it), so they revert to `max-age=3600` and the fix can take ~1h to propagate. To push a hotfix out fast, re-apply no-cache:
  ```bash
  NC="Cache-Control:no-cache,no-store,max-age=0,must-revalidate"
  for a in arm64 x64; do gsutil setmeta -h "$NC" gs://mindstone-rebel/updates/darwin/$a/RELEASES.json; done
  gsutil setmeta -h "$NC" gs://mindstone-rebel/updates/win32/x64/latest.yml
  ```
- **Cleanup:** once the forward release is confirmed live, the `_freeze-backup-*` objects can be deleted (harmless to leave).

## Gotchas (learned the hard way — see the worked example)

- **Wrong feed:** editing only `releases/latest.json` does not stop auto-update spread (see the two-feed table).
- **Windows hash:** download-to-file + size-check; never `curl | openssl`. A bad hash breaks Windows updates non-retryably.
- **`gsutil stat` is authoritative for cache-control**, not an HTTP HEAD (edge caches serve stale headers).
- **Atomicity:** the Mac loop is per-arch; verify all four objects in Step 4 — a half-applied freeze (one arch frozen, one not) is the quiet failure mode.
- **Linux** is manual-download only (no feed) — those users need separate comms.
