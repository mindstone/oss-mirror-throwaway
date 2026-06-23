---
description: "Super-MCP subprocess lifecycle, owner identity, cleanup, and concurrency contracts."
last_updated: "2026-06-12"
---

# Super-MCP Lifecycle

## Overview

Super-MCP is Rebel's local MCP router subprocess. Desktop and eval flows start it
in HTTP mode so Rebel Core can route connector tool calls through a stable local
endpoint.

Lifecycle management matters because several Rebel processes can run on the same
machine: the desktop app, one or more eval orchestrators, and eval workers. A
cleanup pass must remove truly stale Super-MCP children without killing a live
child owned by another Rebel process.

Canonical implementation:

- [`src/core/services/superMcpHttpManager.ts`](../../src/core/services/superMcpHttpManager.ts) — spawn, port selection, PID files, health checks, cleanup call sites.
- [`src/core/services/superMcpOwnershipClassifier.ts`](../../src/core/services/superMcpOwnershipClassifier.ts) — owner-aware tri-state classifier and pre-kill identity recheck.
- [`docs/plans/260429_super_mcp_owner_aware_orphan_cleanup.md`](../plans/260429_super_mcp_owner_aware_orphan_cleanup.md) — design rationale and failure-mode matrix.

## See also

- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) — runtime / HTTP-mode architecture, config, startup lifecycle, troubleshooting.
- [SUPER_MCP_EDITING](SUPER_MCP_EDITING.md) — how to edit, build, version, and ship a change to the super-mcp submodule (incl. § Step 3, the automatic npm publish — and its **known provenance-on-private-repo red job**).
- [MCP_OVERVIEW](MCP_OVERVIEW.md) — MCP territory hub routing to development, testing, OSS release, and security docs.
- [`docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md`](../../docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md) § Other OSS-ops debt — why `Publish super-mcp-router to npm` fails (non-gating) on every stable release (`--provenance` requires a public source repo) + the open decision.

## Owner identity contract

When Super-MCP is spawned and the owner's OS start time is available, the manager
appends three argv tokens to the child process:

```text
--rebel-owner-id <owner-id>
--rebel-owner-pid <owner-pid>
--rebel-owner-start <owner-start-time-ms>
```

The contract lives in:

- [`buildOwnerTagArgs()`](../../src/core/services/superMcpOwnerTag.ts)
- [`parseOwnerTagFromCmdline()`](../../src/core/services/superMcpOwnerTag.ts)
- the spawn site in [`SuperMcpHttpManager`](../../src/core/services/superMcpHttpManager.ts)
- the Super-MCP CLI entry point, currently [`super-mcp/src/cli.ts`](../../super-mcp/src/cli.ts)

The owner start time is OS-derived via
[`getProcessStartTimeMs()`](../../src/core/utils/processStartTime.ts). It is an
identity value, not an elapsed-time measurement. The classifier compares two
reads of the same PID on the same machine to avoid PID-reuse mistakes.

If the owner start time is `null`, the manager does **not** emit owner-tag argv
tokens. It still registers an owner record with `ownerStartTimeMs: null`, and
downstream consumers treat that state as fail-closed: `unknown`, not dead.

Invariant: if Rebel cannot prove a Super-MCP child is killable, Rebel leaves it
alone.

## Owner registry

The owner registry is a secondary signal stored under:

```text
<userData>/mcp/active-owners/<owner-id>.json
```

The implementation is
[`SuperMcpOwnerRegistry`](../../src/core/services/superMcpOwnerRegistry.ts);
the runtime singleton is
[`superMcpOwnerRegistrySingleton.ts`](../../src/core/services/superMcpOwnerRegistrySingleton.ts).

Owner records contain:

```ts
interface OwnerRecord {
  ownerId: string;
  ownerKind: 'desktop' | 'eval-orchestrator' | 'eval-worker' | 'sweep-cli';
  ownerPid: number;
  ownerStartTimeMs: number | null;
  childPid: number | null;
  childStartTimeMs: number | null;
  childPort: number | null;
  spawnedAt: number;
  lastHeartbeatAt: number;
}
```

Registry writes use same-directory atomic replace semantics (write temp file,
then rename into place). This is atomic for readers but not fsync-durable.
Readers skip temp files and malformed records with structured warn logs. On
Windows, rename can fail under file locks / antivirus contention; heartbeat
paths surface warn logs and an `owner-registry-degraded` breadcrumb.

Heartbeat defaults:

- cadence: 5 seconds
- freshness window: 30 seconds
- env override: `REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS` (clamped to
  `[5000, 600000]`; invalid non-empty values fall back to `30000` with a warn)

Heartbeat freshness is consumed by the classifier as a defensive demotion: if
the registry record's heartbeat is older than `freshnessWindowMs` (default
30000ms; tunable via `REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS`), the
registry-lookup branch returns `unknown` instead of `protected`. Heartbeat
staleness MUST NEVER drive a `killable` decision (see §"Tri-state classifier"
step 7); only positive owner-death evidence may auto-kill.

Cleanup must never delete PID-file evidence for an `unknown` decision. PID files
are deleted only when the PID file is invalid, the PID is already dead, or a
killable process was successfully killed. Keeping unknown PID files preserves
mtime evidence for the untagged grace window.

## Tri-state classifier

The classifier returns one of:

| Decision | Meaning | Cleanup action |
|---|---|---|
| `protected` | The child belongs to a live owner. | Never kill. |
| `killable` | The owner is provably dead, or the PID is already dead. | May kill after identity recheck. |
| `unknown` | Rebel cannot prove ownership or death. | Leave running; report/log. |

The canonical algorithm is implemented in
[`classifyByPid()`](../../src/core/services/superMcpOwnershipClassifier.ts).
At a high level:

1. Check whether the child PID exists. `ESRCH` becomes `killable/pid-dead`.
2. Read the child command line.
3. If the command line is unreadable or does not look like Super-MCP, return
   `unknown`.
4. Read the child start time for later pre-kill identity recheck.
5. Parse the `--rebel-owner-*` argv tag, if present.
6. If the tag proves the owner PID + start time is alive, return `protected`.
   If it proves the owner is dead or reused, return `killable`.
7. Look up the child PID in the owner registry (matched by child PID +
   start-time tolerance) and repeat the same owner liveness check. If owner
   liveness is `alive` and heartbeat freshness passes
   (`Date.now() - record.lastHeartbeatAt <= freshnessWindowMs`), return
   `protected`. Stale heartbeat returns
   `unknown/owner-alive-heartbeat-stale` (defensive demotion only; never
   `killable`). The cmdline-tag branch is OS-truth and is not gated by
   heartbeat freshness.
8. If an owner identity exists but liveness is unreadable, return `unknown`.
9. For untagged children, all PID-file evidence is treated conservatively.
   Older than the grace window: `unknown/untagged-grace-expired` — surfaced
   via sweep CLI for `--include-unknown` cleanup. Missing or fresh evidence:
   `unknown/untagged-no-mtime-evidence`.

The old binary "string match means orphan" shape must not be reintroduced. The
boundary registry entry
[`super-mcp-owner-tag-contract`](boundary-registry.yaml) exists to make plans
touching this area read this contract first.

### PID-file deletion contract

PID files are evidence. Cleanup paths in
[`superMcpHttpManager.ts`](../../src/core/services/superMcpHttpManager.ts) keep
them unless the file is invalid, the PID is gone, or a killable process was
actually killed.

### Pre-kill identity recheck

Every kill site must call
[`killProcessTreeIfStillIdentity()`](../../src/core/services/superMcpOwnershipClassifier.ts)
with the classifier's observed child start time. If the PID has gone away, been
reused, or cannot be re-read, the kill is aborted.

## Concurrency

Eval orchestrators coordinate Super-MCP port ranges with
[`evals/lib/portBaselineLease.ts`](../../evals/lib/portBaselineLease.ts).

The lease file layout is:

```text
<userData>/mcp/port-baseline-leases/port-baseline-<baseline>.json
<userData>/mcp/port-baseline-leases/port-baseline-<baseline>.lock
```

The lease algorithm uses create-with-`wx`, write-temp-then-rename, CAS readback,
and a reclaim lock for stale owners. Defaults:

- first baseline: `3100`
- port window: `25`
- max concurrent orchestrators: `4` unless `REBEL_EVAL_MAX_CONCURRENT_ORCHESTRATORS` is set

The lease prevents concurrent eval orchestrators from choosing the same port
window. The owner-aware classifier is still the safety net if processes collide
or stale children are discovered by port scanning.

### Env-var propagation contract

`REBEL_SUPER_MCP_PORT_BASELINE` is the eval-side handoff for concurrent
orchestrator port windows: the orchestrator acquires a lease via
[`acquirePortBaseline()`](../../evals/lib/portBaselineLease.ts), writes the
baseline to `process.env.REBEL_SUPER_MCP_PORT_BASELINE`, spawned workers inherit
that env var, and each worker computes `portBase = baseline + workerIndex * 25`.
Changing any side of that flow must preserve the same owner-safe cleanup
contract.

## Operator tooling

Use the sweep CLI for inspection and operator-driven cleanup:

```bash
npm run sweep:supermcp
npm run sweep:supermcp -- --kill
npm run sweep:supermcp -- --kill --include-unknown
npm run sweep:supermcp -- --json
```

Implementation: [`scripts/sweep-supermcp.ts`](../../scripts/sweep-supermcp.ts).

Use cases:

- inspect all Super-MCP processes in the default range
- clean up old killable children after a crashed eval or app run
- produce JSON output for diagnostics
- explicitly include `unknown` decisions only when an operator accepts that risk

The CLI uses the same classifier and pre-kill identity recheck as automatic
cleanup.

## Migration / first run

Existing untagged children may predate the owner-tag contract. Automatic cleanup
treats them conservatively:

- untagged with PID-file mtime older than 24 hours:
  `unknown/untagged-grace-expired` (surfaced as operator-actionable via
  `npm run sweep:supermcp -- --kill --include-unknown`)
- untagged with fresh or missing mtime evidence:
  `unknown/untagged-no-mtime-evidence`

The first-run migration path is operator-driven:

```bash
npm run sweep:supermcp -- --kill --include-unknown
```

Run it when no live evals or desktop sessions are relying on those processes.

## Failure modes

The failure-mode matrix is maintained in the planning doc:

- [`docs/plans/260429_super_mcp_owner_aware_orphan_cleanup.md`](../plans/260429_super_mcp_owner_aware_orphan_cleanup.md#failure-mode-matrix)
- [`docs-private/postmortems/260429_super_mcp_orphan_collateral_damage_postmortem.md`](../../docs-private/postmortems/260429_super_mcp_orphan_collateral_damage_postmortem.md)
  documents the original live-process collateral-damage incident.

When changing spawn arguments, argv parsing, owner registry semantics, PID-file
cleanup, port-baseline leases, or the sweep CLI, read that matrix and this doc
before approving the change.
