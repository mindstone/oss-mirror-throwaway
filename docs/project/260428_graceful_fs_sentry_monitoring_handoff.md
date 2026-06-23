---
description: "Operational Sentry monitoring handoff for the graceful-fs EMFILE fix — queries, success criteria, escalation signals"
last_updated: "2026-04-28"
---

# Sentry Monitoring Handoff — EMFILE Fix (REBEL-500 / REBEL-1C8)

Created: 2026-04-28
Status: active-monitoring
Audience: engineer confirming release outcomes

This doc is the operational companion to the fix implemented in
`docs/plans/260428_graceful_fs_emfile_fix.md`. It tells you what queries
to run, what the signals mean, and when to escalate or roll back.

---

## Removal Criteria

The fix is considered validated and eligible for removal planning when BOTH
conditions hold simultaneously:

1. **`fs_exhaustion`-tagged events drop by ≥99%** relative to the 28-day
   pre-rollout baseline (0.4.27–0.4.33 crash window).

2. **Queue-overflow breadcrumb events stay below 10/release** for two
   consecutive stable releases.

Source: `src/core/utils/emfileRetry.ts` JSDoc on `withRetryOnEmfile` and
`docs/plans/260428_graceful_fs_emfile_fix.md` § Defence-in-depth preservation.

---

## Sentry Queries

Run these after the first stable release lands (allow 48h for event ingestion).

### 1. Source breakdown (primary signal)

```
tag:fs_exhaustion.source
```

Group by `fs_exhaustion.source` to see which path is surfacing EMFILE.
Expected outcome post-fix: the majority of events have
`source=graceful_fs_queue` (graceful-fs is queuing but not yet at threshold)
or `source=emfile_retry_final` (graceful-fs queued, retried, still failed).
`source=native_bypass` should be rare (LanceDB / native module paths).

If you see `source=native_bypass`, see Decision Matrix below.

### 2. Pre-rollout EMFILE baseline

```
error.code:EMFILE OR error.code:ENFILE OR error.code:UV_EMFILE
```

Time range: 28 days before this release tag. Export the event count — this
is your baseline for the ≥99% reduction check. If the release tag is
`0.4.38`, the baseline window is 28 days before the tag date.

### 3. Post-rollout volume (same filter, last 7 days)

```
error.code:EMFILE OR error.code:ENFILE OR error.code:UV_EMFILE
```

Time range: last 7 days. Compare to the baseline number. Target: ≤1% of
baseline volume.

### 4. Queue overflow breadcrumb signal

```
breadcrumb.category:fs.queue
```

These are the 60s-cadaver breadcrumbs from
`src/core/utils/gracefulFsObservability.ts` — only appear if the observability
module loaded. If this query returns zero after the release, either (a) the
module didn't load or (b) the queue was genuinely never active (good news,
but verify with the patch-loaded check below).

Count should be below 10/release for removal criterion #2.

### 5. Per-release breakdown

```
tag:fs_exhaustion.source
release:<expected-release-tag>
```

For example: `release:0.4.38`. Use this to compare release-over-release
volume and confirm the drop is durable, not a single-release anomaly.

---

## Decision Matrix

| Signal | Interpretation | Action |
|--------|---------------|--------|
| `source=graceful_fs_queue` dominates, total volume ≤1% of baseline | Fix is working as designed — graceful-fs is absorbing the cascade | Continue monitoring; no action |
| `source=emfile_retry_final` appears alongside `graceful_fs_queue` | graceful-fs queued and retried, but the operation still failed after all attempts — retry helpers are functioning | Continue monitoring; these events are expected to be rare |
| `source=native_bypass` appears | A callsite is hitting a native module path (LanceDB, sherpa-onnx, fsevents) that graceful-fs cannot patch. Check `src/core/utils/gracefulFsObservability.ts` `FsExhaustionSource` docs — this is the LanceDB N-API bypass case | Investigate which service is emitting this. Check `conversationIndexService.ts`, `fileIndexService.ts`, `toolIndexService.ts` — the three LanceDB consumers that call `markEnfileDetected()`. File a focused follow-up to wrap the offending path. Do NOT roll back. |
| `source=native_bypass` grows over successive releases | Native-module FD exhaustion is worsening — the underlying FD leak (tracked separately in `docs-private/investigations/260428_emfile_fd_leak.md`) may be accelerating | Escalate to CHIEF_BUGFIXER for the FD-leak hunt; do not roll back the graceful-fs layer |
| Total EMFILE volume unchanged or worse vs baseline | Fix is not effective — either the patch isn't loaded or the crash path is entirely outside graceful-fs's surface | Verify patch is loaded (see below). If patch loaded, escalate immediately |
| `breadcrumb.category:fs.queue` absent after first stable release | Observability module may not have loaded | Run patch-loaded check below; check `REBEL_DEBUG_BOOTSTRAP=1` logs |

---

## Confirming the Patch Is Loaded in Production

The observability module (`src/core/utils/gracefulFsObservability.ts`) will not
emit `fs.queue` breadcrumbs unless the graceful-fs patch is live. If
`breadcrumb.category:fs.queue` is returning zero events, confirm:

### 1. Debug bootstrap logs

If `REBEL_DEBUG_BOOTSTRAP=1` is set, the banner and leaf module emit
`[installGracefulFs]` warnings on failure. In production, these are off by
default. To collect them, temporarily set `REBEL_DEBUG_BOOTSTRAP=1` in the
app's environment and trigger a restart. Look for:

```
[installGracefulFs] failed: <error>
[bootstrap-banner] graceful-fs failed to load: <error>
```

Healthy output: no warnings (patch installed silently).

### 2. Check the global stash

On a healthy boot, `globalThis.__REBEL_BOOTSTRAP_BANNER_ERROR__` and
`globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__` are both unset. If either is set,
the corresponding install stage failed and Sentry will have captured a
`captureMessage` about it (see `drainBootstrapStash` in
`src/core/utils/gracefulFsObservability.ts`).

Search Sentry for:
```
message:graceful-fs install failed
```

Any hit means the patch did not load in that process.

### 3. `fs.queue` breadcrumbs as a loaded indicator

`breadcrumb.category:fs.queue` will not appear at all unless
`installGracefulFsObservability` has been called and the 500ms sampler is
running. If the app has been up for more than 60s and this breadcrumb
category has never appeared, either:

- The observability module was not wired (check `src/main/index.ts` or
  `cloud-service/src/bootstrap.ts` for the `installGracefulFsObservability`
  call), or
- The queue was genuinely never active (possible on low-FD-pressure
  surfaces — desktop Windows is the primary target; cloud is lower-risk)

On Windows desktop with heavy MCP usage, the queue should be active
immediately on startup if any EMFILE pressure exists.

---

## Follow-up Work Gating

### Removal planning (blocked until both removal criteria are met)

Once the ≥99% reduction and queue-overflow thresholds are confirmed, file a
removal planning doc per the instruction in `src/core/utils/emfileRetry.ts`
JSDoc: _A dedicated removal planning doc will be created once those criteria
are met; do not delete this helper preemptively._

The removal doc should address:

- Which existing `withRetryOnEmfile` call sites to keep (LanceDB consumers
  via `enfileState` — these solve a different problem, see Failure Mode #5
  in the planning doc)
- Which call sites to remove first (`libraryHandlers.ts:942` and `libraryHandlers.ts:1113`
  — both use `node:fs/promises`, which graceful-fs does not patch, so they
  are NOT queued today but remain as belt-and-braces)
- The 13 `withRetryOnEmfile` callsites in `conversationIndexService`,
  `toolIndexService`, and `fileIndexService` — these are the primary candidates
  for removal once graceful-fs is confirmed to be absorbing the load

### Open question: sync-path callsites

`settingsStore.ts` uses `withSingleSyncRetryOnEmfile` for the cache-miss read,
bootstrap migration, and Proxy set paths. These are the only sync-path wraps
added in this fix. The JSDoc in `src/core/utils/emfileRetry.ts` states:
_Used by: src/main/settingsStore.ts (REBEL-1C8 crash site). Do not promote for
general use without Sentry data confirming other sync sites are hot._

If no other sync-path EMFILE surfaces in the next two stable releases, the
`withSingleSyncRetryOnEmfile` calls in `settingsStore.ts` can be considered
for removal alongside the main helper.

---

## Cross-References

| Doc | Role |
|-----|------|
| `docs/plans/260428_graceful_fs_emfile_fix.md` | Canonical fix plan — scope, failure modes, staged implementation |
| `docs-private/investigations/260417_REBEL-1C8_EMFILE_crash.md` | Pre-fix diagnosis — REBEL-1C8 crash timeline, FD-leak hypothesis |
| `src/core/utils/emfileRetry.ts` | `withRetryOnEmfile` + `withSingleSyncRetryOnEmfile` source — removal criteria in JSDoc |
| `src/core/utils/gracefulFsObservability.ts` | Queue sampler + Sentry tagging source — `installGracefulFsObservability` + `tagFsExhaustion` |
| `docs-private/investigations/260428_emfile_fd_leak.md` | Separate CHIEF_BUGFIXER mission — root-cause FD-leak hunt (not fixed by graceful-fs) |

---

## Quick Reference: Source Values

| `fs_exhaustion.source` | Meaning |
|------------------------|---------|
| `graceful_fs_queue` | EMFILE hit, graceful-fs is queuing and retrying it |
| `emfile_retry_final` | graceful-fs queued and retried, but all attempts failed — caught by `withRetryOnEmfile` final rethrow path |
| `native_bypass` | EMFILE hit a native-module path (LanceDB N-API, sherpa-onnx, fsevents) that graceful-fs cannot reach |
| `unknown` | Sentinel value — no capture performed (preserves prior no-tag behaviour) |
