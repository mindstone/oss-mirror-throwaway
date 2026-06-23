---
description: "Local cloud-sync harness guide — real cloud-service tests, DriveSim conflict copies, sync machines, integration and CLI use"
last_updated: "2026-06-06"
---

# Local Cloud-Sync Harness

A **real (not mocked) local "cloud" instance** that spikes and tests can sync against, to
replicate and debug cloud-sync bugs — especially the Google Drive conflict-copy duplication class
(REBEL-62A file-level + REBEL-5QS folder-level, both now suppressed at the sync chokepoints; the
harness reproduces the fan-out and verifies the suppression end-to-end).

> **Why this exists.** Before this, cloud-sync coverage was split between two things that each
> hid the real bug: `cloudWorkspaceSync.driveAware.test.ts` runs two instances but **mocks the
> cloud client** (an in-memory `SyncClient`), and `cloudContinuityE2E.test.ts` spawns a **real
> cloud-service** but never drives the desktop conflict-filter path or models a Drive that mints
> conflict copies. This harness closes that gap: the **real `cloudWorkspaceSync` push/pull of ≥2
> simulated desktop instances against a real spawned cloud-service**, plus a **DriveSim** that
> generates Google-Drive-style conflict artifacts (files *and* folders) the way the real Drive
> daemon does.

## The three layers (only one is fake)

| Layer | Real or fake | What plays it |
| --- | --- | --- |
| Desktop sync | **real** | `new CloudWorkspaceSync({ dataPath })` per machine |
| Cloud transport + storage | **real** | spawned `cloud-service/dist/server.mjs`, real `/api/library/*` |
| Google Drive provider behaviour | **simulated** | `DriveSim` — the only thing we fake, because we can't mount real Drive locally |

The HTTP client is the **production** `CloudServiceClient` (it already satisfies the
`SyncClient` interface), so failures in manifest/upload/read/delete are *real* cloud-service
failures. The only deliberate simulation is Drive's artifact generation.

## Library — `src/test-utils/cloudHarness/`

| File | Exports | Purpose |
| --- | --- | --- |
| `localCloudServiceFixture.ts` | `startLocalCloudService()`, `ensureCloudServiceBuilt()`, `LocalCloudService` | Build / spawn / health-poll / teardown a real cloud-service on a dynamic port. Reuses the `cloudContinuityE2E` spawn pattern. **This is the shared SSOT for "spawn + await-ready a local cloud-service"** — other suites (e.g. Playwright E2E) should consume it rather than hand-rolling a spawn. |
| `syncMachine.ts` | `createSyncMachine()`, `SyncMachine` | One simulated desktop = a real `CloudWorkspaceSync` (with an isolated `dataPath`) + a real `CloudServiceClient` pointed at the local service. |
| `driveSim.ts` | `DriveSim`, `DriveMount` | Models the Drive sync daemon over the two machine mounts. **Generates** conflict copies; never hard-coded. |
| `bootstrapDesktopPlatform.ts` | `bootstrapDesktopPlatform()` | Idempotent `setPlatformConfig` + in-memory `setStoreFactory` for **standalone** (non-Vitest) contexts (the CLI/scripts). Vitest already does this via `vitest.setup.ts`, so it's a no-op there. |

### Minimal usage (test or script)

```ts
// Import paths are relative — there is no `@test-utils` alias. Adjust the depth to your file.
import { startLocalCloudService } from '../../src/test-utils/cloudHarness/localCloudServiceFixture';
import { createSyncMachine } from '../../src/test-utils/cloudHarness/syncMachine';
import { DriveSim } from '../../src/test-utils/cloudHarness/driveSim';
// In a standalone script (NOT under Vitest), first: bootstrapDesktopPlatform();

const cloud = await startLocalCloudService();
const drive = await DriveSim.create({ rootDir });          // mounts live under "<root>/Google Drive/Machine <name>/Rebel"
const mountA = await drive.mount('A');
const a = await createSyncMachine({ name: 'A', cloud, workspaceDir: mountA.dir });

await drive.seedFile('memory/topics/foo.md', 'base');
await drive.settle({ to: ['A'] });
await a.sync.forceSync(a.client, a.workspaceDir);          // real push+pull over HTTP
// ... assert against `await a.client.post('/api/library/manifest', {})`
await cloud.cleanup();
```

### Generating conflict copies with DriveSim

- **File conflict (automatic):** two mounts write the *same* path with divergent content in one
  `drive.concurrent([...])` window; on `drive.settle()` the first writer keeps the path and the
  later writer's content is minted as `foo (1).md` (escalating `(2)`, …).
- **Folder conflict:** `drive.mintFolderConflict('Projects/Client', 'B')` copies the whole subtree
  to `Projects/Client (1)/…`, modelling Drive's folder-level conflict outcome (REBEL-5QS). Now
  suppressed at the sync chokepoints (directory-aware matcher, sibling-gated) — directory suppression
  is deliberately narrower than file suppression (numbered-copy + Dropbox conflicted-copy only; NOT
  the generic `Copy of …`/`… copy` which are legitimate user folder names).
  - **Fidelity note:** unlike the file case (which emerges automatically from two racing same-path
    writes), the folder copy is minted *by fiat* via this explicit call — it models the *outcome*
    (a `Folder (1)/` subtree Rebel must cope with), not the precise concurrency that makes real
    Drive mint a folder copy. That's sufficient for the suppression-gap goal (which is
    provider-independent), but don't read it as "we reproduced exactly how Drive decides to copy a folder."
- `drive.withhold(...)` / partial `settle({ to })` let you prove that a peer received a file *via
  the cloud* rather than via local Drive replication.

## Real seams it faithfully exercises

- **Drive-settle deferral:** because mounts sit under a literal `Google Drive` path segment,
  `resolveWorkspaceWriteAuthority` returns `desktop_fs_authoritative` (no mock), so a peer's first
  pulls of a new file are *deferred* (`driveSettleDeferral.ts`, `DRIVE_SETTLE_MAX_DEFERRALS`). Loop
  `forceSync` up to `DRIVE_SETTLE_MAX_DEFERRALS + 1` times before asserting a peer received a file.
- **Per-machine state isolation:** each machine's `dataPath` isolates its
  `sessions/cloud-workspace-manifest.json` and module-globals — two desktops don't clobber each other.
- **Conflict-copy suppression on push *and* pull**, sibling-gated — files (REBEL-62A) AND directories
  (REBEL-5QS; pull uses ancestor-segment gating with immediate-sibling derivation).

## Integration test

`src/main/services/cloud/__tests__/cloudWorkspaceSync.localCloud.integration.test.ts` (`.integration.`
⇒ excluded from `VITEST_FAST`). Three cases against the real spawned service:
1. **File conflict = negative control:** `foo (1).md` is suppressed on push and never reaches the
   cloud or the peer — the REBEL-62A fix **holds**.
2. **Folder conflict = REBEL-5QS regression guard:** a generated `Projects/Client (1)/notes.md` is
   **suppressed** — never reaches the cloud or the peer (the folder-level fix). Plus a standalone
   `Standalone (1)/` (no original sibling) is **retained** (sibling-gate), and a nested
   `A (1)/B (1)/c.md` with `A/` present is suppressed.
3. **Per-machine manifest isolation.**

Run it (spawns a real server, so it needs real network — outside the sandbox):

```bash
npx vitest run --project=desktop \
  src/main/services/cloud/__tests__/cloudWorkspaceSync.localCloud.integration.test.ts
```

## Interactive operator CLI

`scripts/cloud-sync-harness.ts` runs a scenario against the real spawned service and prints what
propagated where — useful for hands-on diagnosis without writing a test. It needs real network, so
run it **outside the sandbox**.

```bash
node --import tsx scripts/cloud-sync-harness.ts --scenario folder-conflict
```

Flags:
- `--scenario <file-conflict|folder-conflict|concurrent-edit>` (default `file-conflict`):
  - `file-conflict` — REBEL-62A negative control: a generated `foo (1).md` should be suppressed
    (NOT reach cloud/peer).
  - `folder-conflict` — REBEL-5QS regression guard: `Projects/Client (1)/notes.md` is suppressed (does NOT reach cloud/peer).
  - `concurrent-edit` — both machines edit the same path; shows the resulting local conflict copies
    + that the cloud stays clean.
- `--print <tree|cloud-manifest|machine-state|all>` (default `all`) — what to dump after the run.
- `--step` — print a labeled state snapshot after each seed/settle/push/pull operation.
- `--keep` — preserve temp dirs (prints their paths) instead of cleaning up.
- `--port <n>` — pin the cloud-service port (else dynamic).

Each run prints the cloud `baseUrl`, both machines' workspace + data dirs, and a labeled summary of
the expected-vs-actual propagation. Exit 0 on success.

There is also `scripts/cloud-sync-harness-smoke.ts` — a minimal A-push→B-pull round-trip used as a
quick "does the real loop work" check.

## What this does NOT exercise (faithfulness boundaries)

- Real Google Drive file IDs, partial uploads, trash/metadata, case-normalisation, or Drive's exact
  timing — `DriveSim` models the *artifact outcome*, not the provider internals.
- Real Fly networking/TLS/volumes/deploy restarts or multiple cloud machines.
- The desktop `CloudRouter` outbox/watcher/debounce path — the harness calls `CloudWorkspaceSync`
  directly. Use it for *workspace-sync correctness*, not for proving watcher/debounce behaviour.
- Mobile sync (the mobile/cloud-client surface) — the harness is general enough to extend there, but
  the first cut targets desktop workspace sync.

## Related

- `docs/postmortems/260601_rebel62a_drive_conflict_copy_fanout_postmortem.md` — the bug, why the fix
  is containment-only, and the open folder/`single-writer-authority` residuals.
- `docs/project/TESTING_AUTOMATION_OVERVIEW.md` — testing hub.
- `cloud-service/src/__tests__/cloudContinuityE2E.test.ts` — the spawn pattern this harness generalises.
