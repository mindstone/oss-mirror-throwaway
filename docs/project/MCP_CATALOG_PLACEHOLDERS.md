---
description: "Internal catalog placeholder tokens used in resources/connector-catalog.json mcpConfig.env / mcpConfig.headers, resolved host-side at MCP spawn time."
last_updated: "2026-05-21"
---

# MCP Catalog Placeholders

This doc enumerates the **Rebel-internal** placeholder tokens (`{{TOKEN}}`) that may appear in `resources/connector-catalog.json` `mcpConfig.env` and `mcpConfig.headers` blocks. They are resolved **host-side at MCP spawn time** (or by post-write / boot-time backfill on cloud) — never by the connector itself. OSS connector authors writing standalone npm packages cannot read these; they should follow [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) instead.

## Resolution site

`resolveEnvPlaceholders()` in [`src/main/services/bundledMcpManager.ts`](../../src/main/services/bundledMcpManager.ts) is the single substitution function. Every catalog-derived spawn-env build path (six in-file callers in `bundledMcpManager.ts`, plus `contributionSwapService.ts` and `scripts/benchmark-mcp-spawn.ts`) routes through it. The `opts` parameter is required — the compiler enforces enumeration of every call site that needs to pass the resolved sandbox ancestor.

## Canonical placeholder list

| Placeholder | Resolved value | Notes |
|---|---|---|
| `{{MCP_CONFIG_DIR}}` | The per-server config dir | Per-spawn, derived from `userData/mcp/<server>/`. |
| `{{MCP_BASE_DIR}}` | The shared MCP base dir | Per-spawn, derived from `userData/mcp/`. |
| `{{BRIDGE_STATE_PATH}}` | The app-bridge state file path | `bridgeStatePath()` in `bundledMcpManager.ts`. |
| `{{ALLOWED_ROOTS_ANCESTOR}}` | Deepest common ancestor of the user's trusted filesystem roots | Falls back to `os.tmpdir()` when no ancestor exists (root collapse, no settings, helper threw). Used for connector sandbox boundaries (e.g. Runway's `RUNWAY_ALLOWED_ROOT`). |
| `{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}` | `path.join(ancestor, 'runway-mcp')` | Joined via `path.join`, not JSON string concat — correct across POSIX, Windows drive roots, and UNC roots. Used for connector download dirs (e.g. Runway's `RUNWAY_DOWNLOAD_ROOT`). |

## Trusted-roots ancestor selector

The deepest common ancestor for `{{ALLOWED_ROOTS_ANCESTOR}}` is computed from the same trust-list inputs that feed the agent's built-in `Read`/`Write`/`Edit` tools. Two shape-specific helpers (one source of truth):

- [`src/core/services/workspace/trustedFilesystemRoots.ts`](../../src/core/services/workspace/trustedFilesystemRoots.ts):
  - `getMcpSandboxAncestorRoots(settings, { homePath, coreDirectory })` — filesystem-aware: trims, drops empties + non-existent paths, realpath-canonicalises (matching the connector's own canonicalisation), dedups (case-sensitive on POSIX, case-insensitive on Windows). Inputs: `coreDirectory`, `<homePath>/mcp-servers`, Space `sourcePath` symlink targets. NOTE: `rebelSystemRoot` is intentionally excluded here — in packaged installs it lives at `/Applications/<App>.app/Contents/Resources/rebel-system`, which combined with user workspace paths under `/Users/...` would collapse the DCA to filesystem root. Connectors don't need access to bundled rebel-system files; only the agent built-in tools do (via `getAllowedSymlinkTargets`).
  - `getDeepestCommonAncestor(paths, { pathStyle? })` — pure: returns `null` on empty input or filesystem-root collapse (POSIX `/`, drive root `C:\`, UNC share root). Walks segments via `path[pathStyle]` exclusively.
- `resolveSandboxAncestor()` in `bundledMcpManager.ts` is the spawn-time wrapper. Returns a `SandboxAncestorResolution` with `ancestor`, `rootCount`, `dcaStatus` (`resolved | empty | root-collapse | fallback-tmpdir`), and optional `fallbackReason` for structured logging.

The MCP-side helper is intentionally wider than the agent-side `getAllowedSymlinkTargets` in the same file (which is byte-identical to the inline literal at `rebelCoreQuery.ts:1300-1318`). The connector has no `verifyNoSymlinkEscape`-style self-augmentation, so the MCP helper bakes `coreDirectory` and `<homePath>/mcp-servers` in explicitly.

## Backfill (existing entries)

Catalog placeholder values added after a connector is already installed don't get retroactively re-applied at spawn — the spawn-time resolution only fires on catalog-derived env keys, not on user/migration-derived router-config keys. Two surfaces handle that:

- [`src/main/services/catalogEnvBackfillMigration.ts`](../../src/main/services/catalogEnvBackfillMigration.ts) — `backfillCatalogEnvForExistingServers()`. Adds missing catalog env/header keys onto existing router-config entries. Resolves default-only sandbox env keys via the same `resolveSandboxAncestor()` + `resolveEnvPlaceholders()` machinery the spawn path uses.
- The `scrubStaleDefaultOnlyEnvKeys` option (cloud only) detects stale concrete sandbox values whose realpath throws (typically a desktop path baked in by an earlier desktop→cloud migration that no longer exists on the cloud machine) and strips them so the backfill pass re-injects surface-coherent values. Keyed off the primary key (`RUNWAY_ALLOWED_ROOT`); paired keys (`RUNWAY_DOWNLOAD_ROOT`) follow the primary's stale-status to avoid scrub→re-add loops on subdirs the runtime creates lazily.

## Cross-surface

Cloud has its own MCP-config write path that does NOT go through `bundledMcpManager.resolveEnvPlaceholders` directly:

- [`cloud-service/src/bootstrap.ts`](../../cloud-service/src/bootstrap.ts) — wires `bundledMcpManager` (so `resolveSandboxAncestor()` reads cloud `getSettings()` + `dataPath`-derived `homePath`) and runs the boot-time backfill with `scrubStaleDefaultOnlyEnvKeys: true` once per process.
- [`cloud-service/src/routes/mcp.ts`](../../cloud-service/src/routes/mcp.ts) — `handleMcpConfig()` re-runs the same backfill after every desktop→cloud sync write, before scheduling Super-MCP restart. Catches sandbox-key drift carried in by post-boot writes.

Mobile is N/A (no local MCPs).

## Validator gate

Adding a new placeholder requires updating the validator allowlist:

- [`scripts/lib/validateCatalogImport.ts`](../../scripts/lib/validateCatalogImport.ts) — `SYSTEM_RESOLVED_TOKENS`. The shared catalog test at `src/shared/__tests__/connectorCatalog.test.ts` enforces this via `validateEnvPlaceholderResolvability` over every catalog entry; an unknown `{{TOKEN}}` throws `unresolvable placeholder` and breaks `npm run validate:fast`.

For runtime-injected (per-instance) tokens that aren't system-resolved (e.g. `HUBSPOT_SCOPE_TIER`), use `RUNTIME_INJECTED_TOKENS` in the same file and inject the value at server-start time in `bundledMcpManager.ts`.

## Default-only env keys

Some catalog-resolved env keys are "default-only": when a user sets a non-blank value via advanced config, the user's value MUST win over the catalog default — even after the catalog placeholder has been resolved into a concrete path.

- [`src/main/services/mcpSandboxEnvKeys.ts`](../../src/main/services/mcpSandboxEnvKeys.ts) defines `DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY` and `DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS`. Override-preservation is implemented in `mergePreservedUserEnv` (`bundledMcpManager.ts`) and `mergeUpdateModePayload.ts`: any non-blank existing user value for a key in `DEFAULT_ONLY_SANDBOX_ENV_KEYS` survives, regardless of whether the catalog value still contains a `{{...}}` slot.
- These keys MUST NOT be added to `INTERNAL_ENV_KEYS` (`@core/mcpInternalEnvKeys`). Doing so would make `mergePreservedUserEnv` skip them entirely before any preservation logic runs, silently breaking user override.

## What NOT to use these for

This is internal Rebel host tooling. OSS connector authors writing standalone npm packages (`@mindstone/mcp-server-*`, etc.) cannot read these placeholders — the substitution happens host-side before the connector is spawned. OSS connectors should consume their input via standard `process.env.*` and document their env contract per [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md).

## Known limitations

- **SF-9 — settings-change restart race.** When `coreDirectory` or Spaces change while a placeholder-consuming connector (e.g. Runway) is connected, the new sandbox env only takes effect after `superMcpHttpManager.debouncedRestart()` fires (3s debounce). A tool call landing inside that window may still be served by the old subprocess with stale env. This matches the existing `MCP_WORKSPACE_PATH` propagation pattern documented in `docs/plans/260418_nano_banana_workspace_path_injection.md`. A future `preRestartHook` could close the gap; out of scope for the trusted-roots plan.
- **Soft sandbox regression for Runway.** With `RUNWAY_ALLOWED_ROOT = DCA(trustedRoots)` (typically `os.homedir()`), the connector accepts any path inside the DCA — wider than the agent's strict trust list. The agent's own `Read` still enforces the strict list, so an LLM that goes through `Read` first hits the strict gate. Direct tool-arg paths to non-trust-zone files inside the DCA are accepted; closing this requires router-level pre-validation. See `docs/plans/260520_runway_sandbox_central_trusted_roots.md` § Security.

## See also

- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — public OSS-author contract; this doc is the internal counterpart for catalog templating
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) — overall MCP integration architecture
- [DECISION_LOG_BUNDLED_MCP_CONFIGURATION](DECISION_LOG_BUNDLED_MCP_CONFIGURATION.md) — bundled connector configuration decisions
- [`docs/plans/260520_runway_sandbox_central_trusted_roots.md`](../plans/260520_runway_sandbox_central_trusted_roots.md) — origin plan for the `{{ALLOWED_ROOTS_ANCESTOR}}` / `{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}` placeholders
- [`docs/plans/260503_bridge_state_path_and_oss_migration_credential_preservation.md`](../plans/260503_bridge_state_path_and_oss_migration_credential_preservation.md) — origin context for `{{BRIDGE_STATE_PATH}}`
- [`docs/plans/260418_nano_banana_workspace_path_injection.md`](../plans/260418_nano_banana_workspace_path_injection.md) — `MCP_WORKSPACE_PATH` propagation precedent (separate, non-catalog channel)
