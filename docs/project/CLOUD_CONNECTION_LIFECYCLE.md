---
description: "Desktop cloud connect/disconnect lifecycle — connectionEpoch serialization, stale-pull invalidation, and cloud-startup Codex provider heal"
last_updated: "2026-06-18"
---

# Cloud Connection Lifecycle

**Intent:** When the desktop connects, reconnects, or disconnects from a cloud instance, setup and background pulls must not interleave or write data from a torn-down account into the local store. A separate cloud-only boot path heals users stranded on the wrong provider after ChatGPT/Codex reconnect (FOX-3494 F1 residual).

This doc covers the **desktop-side connection lifecycle** in `cloudRouter.ts` plus the **cloud-service startup heal**. For the full cloud/desktop split, routing, and reconciler UI state machine, see [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md). For the open backlog item on settings over-triggering reconnects, see [CLOUD_IMPROVEMENT_OPPORTUNITIES.md § #41](CLOUD_IMPROVEMENT_OPPORTUNITIES.md#41-settings-change-triggers-unnecessary-cloud-reconnection-p2).


## `updateConnection` setup serialization (`connectionEpoch`)

`CloudRouter.updateConnection()` (`src/main/services/cloud/cloudRouter.ts`) runs a multi-phase setup (HTTP client, event channel, outbox drain, initial pull). Rapid overlapping calls — or a disconnect mid-setup — used to let a stale setup finish after a newer call had already torn down the connection.

**Mechanism:** `disconnect()` increments a monotonic `connectionEpoch`. Every `updateConnection()` calls `disconnect()` first, captures `setupEpoch`, then re-checks `this.connectionEpoch === setupEpoch` after each `await` before mutating shared connection state. A superseded setup logs and returns early ("last requested wins").

| Symbol | Role |
|--------|------|
| `connectionEpoch` | Generation counter; bumped on every `disconnect()` |
| `updateConnection()` | Captures epoch post-disconnect; bails at phase guards if superseded |
| `disconnect()` | Bumps epoch, clears pull mutexes, tears down client/event channel |

Plans: [260618 updateconnection setup race](../plans/260618_updateconnection-setup-race/PLAN.md).


## In-flight cloud-pull invalidation on disconnect

Fire-and-forget pull cascades (`executePullSync`, `executePullInbox`) capture `connectionEpoch` at entry and re-check it before every local store write. If the user switches accounts, signs out, or a newer `updateConnection()` runs while a pull is in flight, results from the old connection are discarded instead of resurrecting stale-account sessions or inbox data.

`disconnect()` also releases `activeSyncPromise` / `activeInboxSyncPromise` so the next connection's initial pull starts fresh rather than riding an orphaned mutex.

Plan: [260618 cloudrouter disconnect race](../plans/260618_cloudrouter-disconnect-race/PLAN.md).


## Cloud-startup Codex provider heal (FOX-3494 residual)

Cloud-primary users with valid Codex tokens but `activeProvider` drifted off `codex` had no other heal trigger (desktop token-POST heal only fires on re-POST). Cloud boot now runs a one-shot, version-gated heal symmetric with desktop boot.

**Order matters:** `cloud-service/src/bootstrap.ts` calls `ensureNormalizedSettings()`, then `registerManagedKeyAvailability(() => false)` (managed-key seam wired before the heal reads it — verdict `false` until cloud DI-05 parity), then `runCodexProviderHealAtBoot()` from `src/core/services/settingsStore/index.ts` (→ `applyCodexProviderHeal`). Desktop symmetric entry: `src/main/index.ts` → `runCodexProviderHealAtBoot`.

Tests: `cloud-service/src/__tests__/codexProviderHealStartup.test.ts`.


## Still open: settings over-triggering `updateConnection`

The epoch guards make redundant reconnects **safe**, not **absent**. `settingsStore.onDidAnyChange` in `src/main/index.ts` still calls `cloudRouter.updateConnection(...)` on **every** settings mutation (not only `cloudInstance` field changes). Filtering that path is tracked as [#41](CLOUD_IMPROVEMENT_OPPORTUNITIES.md#41-settings-change-triggers-unnecessary-cloud-reconnection-p2) — do not treat the race fix as resolving the over-triggering itself.


## See also

- [CLOUD_ARCHITECTURE.md § Cloud error categories and connection reconciler](CLOUD_ARCHITECTURE.md#cloud-error-categories-and-connection-reconciler) — `CloudConnectionReconciler` UI/state machine and typed error categories
- [260504 cloud connection reconciler plan](../plans/260504_cloud_connection_reconciler.md)
- `src/core/services/cloud/cloudConnectionReconciler.ts` — disconnect recovery state machine
- `src/core/services/cloud/cloudErrorCategory.ts` — cross-process error classification
