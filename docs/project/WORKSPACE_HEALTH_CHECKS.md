---
description: "Workspace-accessibility health probe: deadline budgets, iCloud Documents detection, and false-critical timeout-race fixes"
last_updated: "2026-06-18"
---

# Workspace health checks

## Intent

The **workspace accessible** health check verifies that the configured Library folder can be stat'd and read/written. Background health runs this probe alongside dozens of other checks; if its timeouts are incoherent with the outer wrapper, a legitimately slow cloud-synced folder can surface as a false **workspace health critical** glow even though the Library is fine.

This doc covers the **health-path** probe policy only. User-initiated validators (onboarding, `system:validate-workspace-access`) use the same `probeWorkspaceAccess` helper with a more permissive retry/escalation budget and no outer race.

## Overview

| Layer | Constant / symbol | Budget |
|-------|-------------------|--------|
| Outer `safeCheck` wrapper | `WORKSPACE_ACCESS_CHECK_TIMEOUT_MS` | 18s |
| Inner whole-call bound (attempts + backoffs + cleanup) | `WORKSPACE_HEALTH_OVERALL_BUDGET_MS` | 17s |
| Per-op base (local vs cloud / in-place iCloud) | `getTimeoutForPath` → `FS_TIMEOUT_LOCAL_MS` / `FS_TIMEOUT_CLOUD_MS` | 5s / 15s |

The wrapper in `systemHealthService.ts` passes an abort `signal` into `checkWorkspaceAccessible`; the inner probe treats `WORKSPACE_HEALTH_OVERALL_BUDGET_MS` as the primary bound and the signal as a backstop. Invariant: `computeHealthWorkspaceWorstCaseMs() < WORKSPACE_ACCESS_CHECK_TIMEOUT_MS` (regression-tested).

**Root cause fixed (2026-06):** an outer wrapper shorter than the inner probe's worst case (or unbounded post-attempt cleanup) aborted a still-running probe → abandoned fs work + false `critical`. The health path now bounds the **entire** `probeWorkspaceAccess` call — every attempt, backoff, and final `cleanupProbeFiles` — under one overall deadline, with budget-aware per-file cleanup caps.

## Health-path probe policy

`checkWorkspaceAccessible` (`src/main/services/health/checks/filesystem.ts`):

- Calls `probeWorkspaceAccess` with `retry: { enabled: true, maxAttempts: WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS }` (2) and **`retryOnTimeout: false`** — an `ETIMEDOUT` is terminal at the detection-informed budget; no second full 15s cloud attempt.
- Quick transients (`EBUSY`, `EPERM`, `DATA_MISMATCH`, `ENOENT` on read) still retry with a short follow-up budget.
- Threads the outer abort `signal` so retries and fs ops stop scheduling once the wrapper settles.

`probeWorkspaceAccess` (same file): shared stat → write → read → unlink probe used by health, onboarding, and IPC validators. Health-specific behaviour is gated on `retryOnTimeout: false` + `overallDeadlineAt`.

## iCloud Documents detection (timeout only)

`detectInPlaceCloudDocuments` in `src/core/utils/cloudStorageUtils.ts` recognises macOS **Desktop & Documents Folders in iCloud** (`~/Documents`, `~/Desktop` with the iCloud file-provider xattr on the root). These paths are physically local but can hydrate slowly.

**Wired into timeout selection and remediation copy only** — via `getTimeoutForPath` and `checkWorkspaceAccessible` failure messaging. It is **not** part of the `detectCloudStorage` / `CloudProvider` enum; folding it there would break migration copy, symlink-skip policy, and write-authority semantics (see the block comment above `detectInPlaceCloudDocuments` in source).

**Cold-xattr skip:** after a probe on a **known-cloud** path (`detectCloudStorage` → `isCloud: true`), `checkWorkspaceAccessible` does **not** call `detectInPlaceCloudDocuments` for remediation — `getTimeoutForPath` already short-circuits without a cold xattr read, and a post-probe xattr could push the check past the 18s wrapper. In-place `~/Documents` paths (`isCloud: false`) hit the cached detector result from the probe itself.

## Abort and fs-leak closure

When the outer signal aborts:

- The retry loop stops before scheduling new attempts.
- `withTimeout` invokes fs work as a **thunk** checked for `signal.aborted` first — no new `unlink` / `writeFile` queued after settlement.
- `cleanupProbeFiles` skips remaining unlinks with an observable debug log when budget is spent or aborted; leftover `.mindstonerebel-probe-*.tmp` files are reclaimed by a later probe.

`readFile` / `writeFile` forward `{ signal }` for in-flight cancellation; `stat` / `mkdir` / `unlink` are raced and abandoned best-effort.

## See also

- [DIAGNOSTICS.md](./DIAGNOSTICS.md) — health check tiers, categories table, diagnostic export
- `src/main/services/systemHealthService.ts` — `safeCheck` wrapper wiring for `workspaceAccessible`
- `src/main/services/health/checks/__tests__/filesystem.test.ts` — budget-math and timeout-race regression tests
- `src/core/utils/cloudStorageUtils.ts` — `detectCloudStorage`, `detectInPlaceCloudDocuments`, `getTimeoutForPath`
