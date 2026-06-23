---
description: "MCP update propagation reference — catalog version bumps, tool/schema refresh timing, cache invalidation, and env-var renames"
last_updated: 2026-06-11
---

# MCP Update Propagation

What happens **after** you ship an MCP change -- how version bumps, new tools, and schema changes propagate to users, and the caching edge cases to watch for. For **how** to build/migrate servers, see [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md). For the **process** (when/why/what order), see [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md).

## See Also

- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) -- Runtime config, connector catalog, auth patterns
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) -- Super-MCP HTTP mode lifecycle, health checks
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) -- 6-phase workflow, policies, checklists
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) -- SDK patterns, module architecture, security, distribution
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) -- **Mandatory pre-publish security review** that must complete before any new OSS connector version lands in `resources/connector-catalog.json` (which is what triggers the propagation mechanisms documented below)
- [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md) -- **Process** for shipping an OSS connector version bump to the catalog (`npm run mcp:release`; the counterpart to this doc's propagation mechanism). Bootstrap/first-publish only: [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md)
- [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) -- **Rerunnable runbook** for auditing `@mindstone/*` catalog pins against npm `latest`, the inverse of what this doc covers: this doc describes how a catalog bump propagates **to users**; the audit describes how we detect drift **before** bumping
- [TOOL_AWARENESS](TOOL_AWARENESS.md) -- Tool discovery, semantic search, tool index


## Key Concepts

Users **do not** need to disconnect/reconnect to pick up most MCP updates. The propagation mechanism depends on the type of MCP and the type of change.

### How tool discovery works

```
Agent Turn Start
       │
       ▼
  resolveMcpServers()        ← resolves Super-MCP HTTP URL per turn
       │
       ▼
  Rebel Core                   ← passes Super-MCP as single MCP server
       │
       ▼
  Super-MCP Router            ← exposes meta-tools: list_tool_packages,
       │                        list_tools, get_tool_details, use_tool,
       │                        search_tools, get_help, and others
       ▼
  Catalog (in-memory cache)   ← lazy-loads tool lists from upstream servers
       │                        on first list_tools call per package
       ▼
  Upstream MCP Servers        ← spawned on demand by Super-MCP
```

**Progressive disclosure**: Super-MCP doesn't expose upstream tools directly. Instead, the agent calls `list_tool_packages` to see available packages, then `list_tools(package_id)` to browse tools within a package, then `get_tool_details(tool_ids)` to fetch full schema before first use, then `use_tool` to execute. This means tool lists are fetched lazily from upstream servers.

**Rebel-side interception**: `search_tools` calls are intercepted by a PreToolUse hook before reaching Super-MCP, routing to LanceDB hybrid search for better relevance. The tool index refreshes on MCP config changes alongside Super-MCP reconfigure. See [TOOL_AWARENESS § Runtime Interception](TOOL_AWARENESS.md#runtime-interception-pretooluse-hook).

**Catalog caching**: Once Super-MCP fetches a package's tool list, it caches the result in memory. The cache has **no TTL** -- it persists until explicitly cleared (via `restart_package`, Super-MCP restart, or `clearPackage()`).


## Update Propagation by Scenario

| Scenario | User action needed? | Mechanism | When it takes effect |
|----------|-------------------|-----------|---------------------|
| **Bump npx package version in catalog** | No | Startup migration (`reconcileNpxPackageVersions`) rewrites user config to match catalog | Next app launch |
| **Change HTTP/SSE URL in catalog** (e.g., vendor deprecates an endpoint) | No | Startup migration (`reconcileHttpUrls`) rewrites user config URL to match catalog, same-origin-only | Next app launch |
| **Add tools to a bundled MCP** | No | Bundled MCPs are compiled into the app binary | Next app update |
| **Add tools to an npx-based MCP** | No | Version bump propagates via startup migration; Super-MCP spawns fresh server | Next app launch after catalog update ships |
| **User connects/disconnects a connector** | No | `reconfigureSuperMcpWithCacheRefresh()` restarts Super-MCP, clears all caches | Immediate |
| **Change tool schemas in a running MCP** | Restart needed | Catalog cache is stale until Super-MCP restarts or `restart_package` is called | App restart or `restart_package` call |
| **Server-side change to remote MCP** | Restart needed | Same as above -- cached tool list won't refresh mid-session | App restart |
| **Rename/retire a host→child env-var** (e.g. `MCP_HOST_BRIDGE_STATE`) | No | Spawn payload rebuilt from `bundledMcpManager` payload builders; `coreStartup` REPLACE-semantics overwrites stale entries | Next app launch — but **must dual-write** during transition, see § Cross-process env-var renames |


## Detailed Mechanisms

### npx version reconciliation (startup migration)

> **STOP — Pre-publish security review is mandatory before any catalog version bump.** The reconciliation below is the mechanism that pushes the new catalog version to every Rebel user on their next app launch — there is no soft launch and no kill switch. For `provider: "rebel-oss"` connectors, no version may land in `resources/connector-catalog.json` without a completed sign-off per [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13 Mandatory Pre-Publish Security Review](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review). This applies to first publish AND every subsequent version bump.

When an app update ships a new version of an npx-based connector in `connector-catalog.json`, users who already have the connector installed still have the old version pinned in their config. The startup migration fixes this:

1. Runs at app launch (`reconcileNpxPackageVersions()` in `mcpConfigManager.ts`)
2. Iterates user's MCP config entries that have a `catalogId`
3. Compares the npm package specifier against the catalog
4. If the package name matches but version differs, rewrites the version in user config
5. On next MCP spawn, npx sees the new version specifier and fetches the update

**The catalog is the source of truth** for managed connectors (those with a `catalogId`). If a user manually pins a different version, it will be reverted to the catalog version on next startup.

### HTTP URL reconciliation (startup migration)

Analogous to npx version reconciliation, but for direct HTTP/SSE connectors. When a vendor deprecates an endpoint and we ship an updated catalog URL, existing users' stored URLs won't match. The migration fixes this at launch:

1. Runs at app launch (`reconcileHttpUrls()` in `mcpConfigManager.ts`), right after `reconcileNpxPackageVersions()`
2. Iterates user's MCP config entries that have a `catalogId` matching a catalog entry with an `mcpConfig.url`
3. If the stored URL differs from the catalog URL, **and the origins match (scheme+host+port)**, rewrites the URL to the catalog value
4. Preserves everything else (oauth flag, tokens, email, type, headers)

**Same-origin guard:** a catalog mis-edit cannot silently redirect a user's connector to a different origin. Only the path (and query) can change. This protects users from a malicious or broken catalog update.

**OAuth tokens:** stored per-packageId under `~/.super-mcp/oauth-tokens/${packageId}_tokens.json`, not tied to the URL. Same-origin URL change keeps existing tokens working.

**Trigger example:** Webflow moved off their unstable `/beta/mcp` endpoint onto the stable `/mcp` endpoint — see Sentry REBEL-17G and the postmortem at `docs-private/postmortems/260417_webflow_beta_mcp_method_not_found_postmortem.md`.

### Cross-process env-var renames

Spawn payloads in `src/main/services/bundledMcpManager.ts` carry env vars that bundled child scripts under `resources/mcp/rebel-*/server.cjs` and `resources/mcp-generated/{slack,microsoft-mail,microsoft-sharepoint}/server.cjs` read at startup (e.g. `MCP_HOST_BRIDGE_STATE`, `MS_CONFIG_DIR`, `MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH`). Renaming one of these keys is a **two-sided change**: the payload builder and every reader move together, or the bridge silently breaks.

**The May-2026 incident.** The host renamed `MINDSTONE_REBEL_BRIDGE_STATE` to `MCP_HOST_BRIDGE_STATE` in payload builders without updating the bundled child scripts that still read the old name. Fresh spawns received `undefined` for the bridge path, the bridge call no-op'd, and super-mcp surfaced `-33004 PACKAGE_UNAVAILABLE` for every rebel-internal MCP. See `docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md`.

**Required process for any host→child env-var rename:**

1. **Enumerate every reader.** Search `resources/mcp/` and `resources/mcp-generated/` for `process.env.<OLD_KEY>`. Don't trust a partial list — every catalog entry that has the env var in its payload is a candidate reader, including OSS bridges in compiled `.cjs` form.
2. **Dual-write during transition.** Add the new key to the payload builder; keep emitting the old key. The shared helper for the bridge-state path lives in `bundledMcpManager.ts` as `bridgeStateEnv()` and is the canonical pattern for these transitions.
3. **Update readers to prefer the new key with the old one as fallback** (`process.env.NEW ?? process.env.OLD`). Ship the reader update in the same release as the writer update, or earlier.
4. **Verify with the CI gate**: `scripts/check-bridge-state-readers.ts` parses the writer set out of `bridgeStateEnv()` and fails if any reader requests a key the writer doesn't emit. Wired into `validate:fast`. Use this pattern for any new env-var contract you introduce.
5. **Verify with the integration test**: `src/main/services/__tests__/bundledMcpSpawnContract.test.ts` builds the payload, reads the target script, and asserts every read key is in the spawn env. Extend it for new bridge-state-bearing payloads.
6. **Retire the old key** only after every reader is on the new key (and ideally one release after that, to absorb in-flight user configs). The retirement checklist for the bridge state path is documented inline in the JSDoc above `bridgeStateEnv()`.

**Why startup migration is not enough.** Existing user configs are repaired on launch via `coreStartup.upsertMcpServersBatch` REPLACE-semantics, which rebuilds rebel-internal entries from the current payload builders. But that only fixes the **writer side** — it cannot help if a child script reads a key the writer no longer emits. Both sides have to converge.

### Super-MCP reconfigure flow

When config changes occur (connect/disconnect, settings change), `reconfigureSuperMcpWithCacheRefresh()` runs:

1. **Stop** Super-MCP (process-tree kill)
2. **Re-acquire port** (previous port may have been taken)
3. **Start** fresh Super-MCP with new config
4. **Invalidate** connected packages cache (affects system prompt tool awareness)
5. **Refresh** tool index — **incremental**: only changed/added/removed packages are re-embedded. Unchanged packages are fast-pathed via per-package SHA-256 hash comparison (no embedding cost). A typical single-package add/remove takes <5s instead of the previous ~150s full rebuild. See [TOOL_AWARENESS § Architecture](TOOL_AWARENESS.md#architecture) for details.

All catalog caches are cleared on restart since they're in-memory.

### Connected packages cache

The system prompt includes a list of connected packages for tool awareness. This is cached in-process (`connectedPackagesResult` in `mcpService.ts`) and only invalidated when `invalidateConnectedPackagesCache()` is called (which happens during `reconfigureSuperMcpWithCacheRefresh()`). This cache reads from the config file, not from Super-MCP, so it reflects config-level changes immediately after reconfigure.


## Edge Cases and Gotchas

### npx package caching

npx aggressively caches downloaded packages. The version reconciliation works by changing the version specifier (e.g., `@0.0.14-fix.1` → `@0.0.14-fix.3`), which forces npx to fetch fresh. However:

- If you publish different content under the **same version** (bad practice), npx will serve the stale cached copy.
- Users on slow/offline networks may see delays before the new version is available.
- **ESM-only packages** (built via `prepare` script per [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md#5-packaging--distribution)) are only updated after a version bump + reinstall. Publishing new `dist/` contents without bumping the version won't propagate due to npx caching.

### Tool annotations and schema caching

Tool **annotations** (`readOnlyHint`, `destructiveHint`, etc.) are part of the tool definition and subject to the same catalog caching as tool schemas. Changes to annotations require Super-MCP restart or `restart_package` to take effect mid-session.

### Stale catalog cache mid-session

The Super-MCP catalog cache has **no TTL or automatic invalidation**. If an upstream MCP server's tools change while Super-MCP is running and the package has already been `list_tools`-ed, the cached tools will be stale.

**Workarounds:**
- The agent can call `restart_package(package_id)` to restart the upstream server and clear its cache entry.
- The user can restart the app (Super-MCP restarts, clearing all caches).
- A connect/disconnect cycle triggers `reconfigureSuperMcpWithCacheRefresh()`.

### Error retry behavior

If an MCP server fails to load (auth error, crash, timeout), Super-MCP caches the error state. It retries after **60 seconds** (`ERROR_RETRY_INTERVAL_MS`). Transient failures don't permanently block a package, but there's a 60-second window where the package appears unavailable.

### Windows app updates (Squirrel)

On Windows, Squirrel updates change the install folder path (e.g., `app-0.2.35` → `app-0.3.8`). This breaks absolute paths to bundled MCP scripts stored in user config. The startup migration `repairBundledMcpScriptPaths()` rewrites stale paths to the current `resourcesPath`. If this migration fails, bundled MCPs won't load until a clean install.

### System resume from sleep

When the OS resumes from sleep, the Super-MCP process may have been killed. `ensureRunningAfterResume()` detects this and restarts Super-MCP, re-acquiring a port (the old port may have been claimed by another app during sleep). All catalog caches are cleared on restart.


## Code References

| File | Key functions | Relevance |
|------|---------------|-----------|
| `src/core/services/mcpConfigManager.ts` | `reconcileNpxPackageVersions()`, `reconcileHttpUrls()`, `splitPackageSpecifier()` | Startup version and URL migrations |
| `src/main/services/mcpService.ts` | `reconfigureSuperMcpWithCacheRefresh()`, `invalidateConnectedPackagesCache()`, `buildConnectedPackages()` | Cache management, reconfigure orchestration |
| `src/main/services/superMcpHttpManager.ts` | `reconfigure()`, `restart()`, `ensureRunningAfterResume()` | Super-MCP process lifecycle |
| `super-mcp/src/catalog.ts` | `Catalog.refreshPackage()`, `ensurePackageLoaded()`, `clearPackage()` | Tool list caching and lazy loading |
| `super-mcp/src/handlers/restartPackage.ts` | `handleRestartPackage()` | Mid-session cache invalidation escape hatch |
| `resources/connector-catalog.json` | -- | Source of truth for managed connector versions |
| `src/main/services/bundledMcpManager.ts` | `bridgeStateEnv()`, `buildSplitRebel*Payload()` | Writer side of the host→child env-var contract; retirement checklist inline in JSDoc |
| `scripts/check-bridge-state-readers.ts` | -- | CI gate (in `validate:fast`) that enforces writer ⊇ readers for `*_BRIDGE_STATE` keys |
| `src/main/services/__tests__/bundledMcpSpawnContract.test.ts` | -- | Per-MCP integration test asserting payload env carries every key the child script reads |


## Maintenance

When changing MCP caching, startup migrations, or Super-MCP catalog behavior, update this doc as part of the same change.
