---
description: "How rebel-oss connectors work: npm distribution, managed installs, startup lifecycle, cross-surface handling, migrated-OSS connectors, and the mandatory pre-publish security review gate"
last_updated: "2026-05-22"
---

# OSS Connector Architecture

How Rebel distributes, installs, and executes open-source MCP connectors (`provider: "rebel-oss"`).

## See Also

- [MCP_BUNDLED_TO_OSS_MIGRATION](MCP_BUNDLED_TO_OSS_MIGRATION.md) — End-to-end process for migrating a bundled connector into an OSS npm package, including the mandatory pre-publish live-API test gate (Phase C5)
- [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md) — Per-connector testing/validation status: which migrated connectors are user-tested, which aren't, and which bundled connectors are still awaiting migration
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) — Provider types, transports, catalog schema
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — Building and shipping connectors
- [MCP_CONNECTOR_CONTRIBUTION_FLOW](MCP_CONNECTOR_CONTRIBUTION_FLOW.md) — End-to-end pipeline for **user-contributed** connectors inside Rebel: agent state reporting, fork + Git Data API upload, PR status polling, post-publish catalog swap
- [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) — Reviewer-side workflow once a contributed PR reaches mindstone/mcp-servers
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — SDK patterns, module architecture
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) — How version bumps reach users
- [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) — Rerunnable runbook for detecting catalog-vs-npm drift on `@mindstone/*` pins and safely applying bumps
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) — Auth modes for externalized connectors **and the canonical [§ 13 Mandatory Pre-Publish Security Review](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) gate** that every `rebel-oss` connector (OAuth or not) must pass before publish
- Planning doc: `docs/plans/260416_managed_mcp_install_replace_npx.md`
- Benchmarks: `docs-private/reports/benchmarks/mcp-spawn-comparison-260417.md`


## What Is a rebel-oss Connector?

A `rebel-oss` connector is a Mindstone-authored MCP server published to npm as a scoped package (e.g., `@mindstone-engineering/mcp-server-gamma@0.2.0`). It's open-source, externally distributed, and version-pinned in the connector catalog that ships with the app.

This is distinct from:
- **bundled** — compiled into `resources/mcp/`, shipped inside the app binary
- **direct** — vendor-hosted HTTP endpoints
- **community** — third-party npm/uvx packages users add themselves

### Migrated-OSS Connectors

Five connectors migrated from bundled to OSS in the 260429 window:
- **Salesforce** (`@mindstone-engineering/mcp-server-salesforce`) — CRM; VAL-SF-003/006/009 known issues in testing status
- **Outreach** (`@mindstone-engineering/mcp-server-outreach`) — Sales engagement; VAL-OUTREACH-006 bridge-state hygiene known
- **Retell AI** (`@mindstone-engineering/mcp-server-retell-ai@0.1.3`) — Voice/Telephony; post-publish live stdio probe passed in 0.1.3
- **Browser Automation** (`@mindstone-engineering/mcp-server-browser-automation`) — Browser control; user-tested PASS (12/12)
- **Office** (`@mindstone-engineering/mcp-server-office`) — Microsoft Office integration

Recent OAuth/package migrations:
- **OpenAI Image** (`openai-image-generation` → `@mindstone/mcp-server-openai-image@0.1.2`; v0.4.41 migration landed at `0.1.0`) — image generation/editing via provider-key env injection. The OpenAI-specific host lifecycle was removed in favour of the generic `findRebelOssConnectorsUsingProviderKey` rotation path.
- **Google Workspace** (`bundled-google` → `@mindstone/mcp-server-google-workspace@0.1.3`; v0.4.41 Stage 5 cleanup landed at `0.1.0`) — Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Tasks, and Forms; catalog flipped 2026-05-19 and bundled source deleted in Stage 5. `0.1.3` adds `supportsAllDrives: true` for Shared Drive support (REBEL-H3). See [`260519_google_workspace_oss_migration`](../plans/260519_google_workspace_oss_migration.md).
- **Replit SSH** (`bundled-replit-ssh` → `@mindstone/mcp-server-replit-ssh@0.1.2`; v0.4.41 migration landed at `0.1.0`) — Replit project SFTP management over SSH; legacy bundled tree deleted after the catalog flip.
- **Microsoft 365 / Office cohort** (all `provider: "rebel-oss"` as of v0.4.41):
  - Outlook Mail (`bundled-microsoft-mail` → `@mindstone/mcp-server-microsoft-mail@0.1.1`)
  - Outlook Calendar (`bundled-microsoft-calendar` → `@mindstone/mcp-server-microsoft-calendar@0.1.1`)
  - OneDrive (`bundled-microsoft-files` → `@mindstone/mcp-server-microsoft-files@0.1.1`)
  - Teams (`bundled-microsoft-teams` → `@mindstone/mcp-server-microsoft-teams@0.1.1`)
  - SharePoint (`bundled-microsoft-sharepoint` → `@mindstone/mcp-server-microsoft-sharepoint@0.1.1`)
  - Word / Office add-in (`bundled-office` → `@mindstone/mcp-server-office@0.2.0`)
- **HubSpot** (`bundled-hubspot` → `@mindstone/mcp-server-hubspot@0.2.0`) — OAuth CRM connector with the `conversations.read` scope mirrored into the host catalog; v0.2.0 adds FOX-3354 `line_items` → `deals` reads and FOX-3376 Conversations Inbox tools.

Generic rebel-oss provider-key rotation now lives in the core centralized inbox bridge state machine: `/settings/set-api-key` routes through the same state transition used by TurnPipeline/HandlerRegistry-hosted flows, so future API-key ports inherit key-rotation restarts without connector-specific host code (commits `50fcd98fd4`, `495ad4fbac`).

For per-connector validation status, see [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md). For the security-review-gate requirement that applies to every OSS publish, see [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review).


## STOP — Mandatory Pre-Publish Security Review

**No `rebel-oss` connector — OAuth, API key, or otherwise — may be published to npm or pinned in `resources/connector-catalog.json` without first passing the pre-publish security review.** This is a hard gate, not a recommendation.

The canonical specification lives in [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13 Mandatory Pre-Publish Security Review](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review). It defines:

- **Review (AI-only since 2026-06-11)**: agent-authored security review + mandatory cross-family adversarial pass (different model family; model/session/confidence/verdict recorded in the artifact); `Release-Authorized-By` records release authorization (an authorization act, not a review)
- **Artifacts**: threat model, callback-server tests, file-permission audit, atomic-write evidence, internal-reference scan, secrets scan, `npm audit` report, SBOM, full reviewer findings — all committed to `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md`
- **Blocking conditions**: any open Critical / High finding, missing 2FA, present bridge code, non-atomic token writes, missing `chmod` after credential write, etc.
- **Sign-off** record format and cross-linking from the catalog entry, CHANGELOG, and the release commit's machine-validated `Release-Gate: <repo-relative-review-path>#<sha256>` trailer (stamped by `mcp:release`)
- **Triggers**: full review for first publish + every catalog version bump + any auth / network / IPC / persistence / dependency change; abbreviated review allowed only under strict criteria; re-review when dependencies, providers, or embedded credentials policy change

**Why this gate is here:** A catalog pin is a production deployment to every Rebel user on next launch via the [Startup Migration Chain](#startup-migration-chain) below. There is no soft launch and no kill switch short of shipping a new app build — this gate is the only chokepoint.

See also [MCP_SERVER_STANDARD § Pre-Merge Checklist](MCP_SERVER_STANDARD.md#7-pre-merge-checklist) and [MCP_CONNECTOR_WORKFLOW § Critical: OSS Connector Security](MCP_CONNECTOR_WORKFLOW.md#critical-oss-connector-security) for the substantive technical requirements that the review verifies.


## Lifecycle Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         App Startup                                      │
│                                                                          │
│  1. configureManagedMcpInstallService()    ← singleton + temp cleanup    │
│  2. migrateBundledConnectorsToNpx()        ← skips managed entries       │
│  3. upgradeRebelOssEntriesToManaged()      ← npx → managed install       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      User Connects a Connector                           │
│                                                                          │
│  buildPayloadFromCatalog() resolves command + args:                       │
│    1. Check managed install metadata on disk                             │
│    2. If valid → command: "node", args: [entryPath]                      │
│    3. If not   → command: "npx",  args: ["-y", "pkg@version"]           │
│                                                                          │
│  upsertMcpServerEntry() writes to super-mcp-router.json                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         Runtime Spawn                                    │
│                                                                          │
│  Super-MCP spawns:  node /Users/.../managed-installs/pkg@ver/.../dist/   │
│  Single process, no npm/npx wrapper, no network, ~140ms                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```


## How Managed Install Works

### Step 1: Catalog provides the spec

`resources/connector-catalog.json` declares each rebel-oss connector with a pinned npm spec. The canonical shape carries every field the schema-and-invariant gate (Step 1.5) enforces:

```json
{
  "id": "bundled-gamma",
  "provider": "rebel-oss",
  "verified": true,
  "verifiedSource": "https://github.com/mindstone/mcp-servers",
  "maturity": "stable",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@mindstone-engineering/mcp-server-gamma@0.2.0"]
  },
  "tools": [
    { "name": "create_presentation", "description": "..." }
  ]
}
```

The pinned version is the source of truth. Updating a connector version requires a catalog change (i.e., an app release).

### Step 1.5: Schema-and-invariant gate

`scripts/check-connector-catalog-schema.ts` runs in `validate:fast` (and therefore in the pre-push hook + CI) and validates `resources/connector-catalog.json` against:

1. The full Zod `CatalogSchema` in `src/shared/connectorCatalogSchema.ts` (the same schema that gates runtime override catalogs in `connectorCatalogResolver.ts`). Failing here means a runtime override with the same shape would also be rejected — i.e., schema/catalog drift.
2. **rebel-oss invariants**, applied to every entry where `provider: "rebel-oss"` and `hidden !== true`:
   - `mcpConfig.transport === 'stdio'`
   - `mcpConfig.command === 'npx'`
   - `verifiedSource` is a non-empty `https?://...` URL (e.g. `https://github.com/mindstone/mcp-servers`)
   - `tools` is a non-empty array (extract real tool definitions from the published package's stdio `tools/list` reply or its `dist/tools/` `registerTool(...)` calls — the same pattern used in [§ 4 of `260519_opus_mcp_oss_connector.md`](../plans/260519_opus_mcp_oss_connector.md))
3. Maturity allow-list (`stable | beta | deprecated | preview`) per the runtime Zod enum.

Run it locally any time you edit a `rebel-oss` catalog entry (it's cheap):

```bash
npx tsx scripts/check-connector-catalog-schema.ts
```

These invariants are not aesthetic — each one is the contract production code relies on. Missing `transport` causes super-mcp to fall back to its own default; missing `verifiedSource` strips the verified-publisher pill from the renderer; an empty `tools[]` defeats the catalog tool index that the BTS layer uses for cold-start search. The Stage 1 sweep wired this gate after a sweep across the catalog found 8 latent drift cases (see [`260525_test-failures-sweep/PLAN_EXTENDED.md`](../plans/260525_test-failures-sweep/PLAN_EXTENDED.md)).

### Step 2: First connect triggers install

When the startup auto-upgrade runs (or on first user connect), the package spec is parsed and validated — must be exact pinned semver, no ranges or tags.

### Step 3: Temp directory + container package.json

A temp dir is created inside `<userData>/mcp/managed-installs/.tmp-<random>/`. A minimal dummy `package.json` is written so `npm install` has a valid project root:

```json
{ "name": "mcp-server-gamma-container", "version": "1.0.0", "private": true }
```

### Step 4: npm install

The service resolves npm (bundled with the app, or system npm as fallback) and runs:

```
npm install @mindstone-engineering/mcp-server-gamma@0.2.0 --no-audit --no-fund --no-progress
```

User/global npmrc is cleared to avoid environment interference. This creates a full `node_modules/` tree in the temp dir.

### Step 5: Entry point resolution

The installed package's `package.json` is read to resolve the executable entry point:

1. `bin` field (string or object, matching package basename first)
2. `main` field
3. `index.js` fallback

For Gamma this resolves to `node_modules/@mindstone-engineering/mcp-server-gamma/dist/index.js`.

### Step 6: Metadata + atomic promotion

`.install-meta.json` is written to the temp dir:

```json
{
  "packageSpec": "@mindstone-engineering/mcp-server-gamma@0.2.0",
  "packageName": "@mindstone-engineering/mcp-server-gamma",
  "version": "0.2.0",
  "entryPath": "/Users/.../managed-installs/@mindstone-engineering/mcp-server-gamma@0.2.0/node_modules/.../dist/index.js",
  "installRoot": "/Users/.../managed-installs/@mindstone-engineering/mcp-server-gamma@0.2.0",
  "installedAt": "2026-04-17T07:52:21.338Z",
  "platform": "darwin",
  "nodeVersion": "v22.22.1",
  "metaVersion": 1
}
```

The temp dir is atomically renamed to the final path. Concurrent installs are deduplicated (single in-flight promise per spec).

### Step 7: Router config rewrite

The MCP router config entry is updated from npx to managed:

```
Before: { "command": "npx",  "args": ["-y", "@mindstone-engineering/mcp-server-gamma@0.2.0"] }
After:  { "command": "node", "args": ["/Users/.../managed-installs/.../dist/index.js"] }
```

Env vars, credentials, catalogId, email, and all identity fields are preserved.

### Step 8: Subsequent spawns

Super-MCP spawns with `node <entryPath>` — single process, no npm wrapper, no network, no registry check.


## Startup Migration Chain

Three migrations run in sequence during app startup (`src/main/index.ts`):

1. **`migrateBundledConnectorsToNpx()`** — Converts legacy `command: "node"` bundled entries to npx form. **Gated**: skips any entry that's already a managed install (checks if `args[0]` is inside the managed installs root).

2. **`upgradeRebelOssEntriesToManaged()`** — Scans all npx-shaped rebel-oss entries and upgrades them to managed installs. Also **reconciles** existing managed entries: if the entry file is missing (AV quarantine, manual deletion), it reinstalls. After 3 failed reinstall attempts within an hour, it **quarantines** the spec and reverts to npx.

3. **Reconnect preservation** — `buildPayloadFromCatalog()` checks for valid managed install metadata before falling back to catalog npx config. Without this, every disconnect/reconnect would revert to npx.


## Contribution submission in OSS-scrubbed builds

Stage 5 of the OSS content scrub removed the contribution-specific GitHub OAuth service and direct GitHub contribution transport. The remaining contribution IPC surface fails closed for GitHub-attributed submissions instead of launching a dedicated OAuth flow.

## Cross-Surface Handling

| Surface | Command | Why |
|---------|---------|-----|
| **Desktop** | `node <absolute-path>` | Local filesystem, managed installs available |
| **Cloud** | `npx <pkg@version>` | No local filesystem; `rewriteManagedMcpEntriesToNpxForCloud()` converts managed paths back to catalog npx form |
| **Mobile** | N/A | Connectors run server-side via cloud |


## Safety Mechanisms

- **Atomic installs**: temp-dir + rename prevents partial installs from being visible
- **Concurrent dedup**: in-flight install promises are shared per spec
- **Quarantine detection**: if AV keeps deleting the entry file, reverts to npx after 3 attempts
- **Windows MAX_PATH preflight**: rejects installs where root path exceeds 140 chars
- **Validation on read**: `getMetadata()` checks entry file existence, not just metadata presence
- **npx fallback**: if managed install is missing, corrupt, or singleton not configured, falls back to catalog npx config transparently

## Emergency Catalog Override Runbook

`REBEL_CATALOG_OVERRIDE=/absolute/path/to/connector-catalog.json` is an operator rollback lever for testing or support-issued downgrades. The override file is schema-validated, command-allowlisted, and fail-closed by `src/main/services/connectorCatalogResolver.ts`.

- Development builds accept a valid override without extra flags.
- Packaged builds reject overrides unless `REBEL_CATALOG_OVERRIDE_ALLOW_PROD=1` and `REBEL_CATALOG_OVERRIDE_SHA256=<sha256>` match the override file exactly (case-insensitive hex compare).
- Rejections surface `Catalog override rejected: <reason>`, set Sentry context, and continue with the bundled catalog visibly rather than silently.
- Allowed commands are intentionally narrow: `npx -y @(mindstone|mindstone-engineering)/mcp-server-{slack,hubspot,google-drive,google-workspace,microsoft-365,imagegen}@x.y.z`, or `node` with one absolute script path under app resources or the managed-MCP root. Node flags such as `-e`, `--eval`, `-r`, and arbitrary npm packages are rejected.

Future hardening: replace checksum-gated production overrides with a signed manifest verified by an embedded public key (deferred to the v0.2.x rollback tooling track).


## Performance

From benchmarks on Apple Silicon (M-series), 48GB RAM, bundled Node v25.8.2:

| Metric | npx | Managed | Improvement |
|--------|----:|--------:|-------------|
| Warm spawn p50 | 1,061 ms | 140 ms | 7.6x faster |
| Burst-5 spawn p50 | 3,299 ms | 591 ms | 5.6x faster |
| Slow spawns (>2s) | 100% | 0% | Eliminated |
| Subsequent cold spawn | 2,730 ms | 164 ms | 16.6x faster |
| Process count | 2 | 1 | 50% fewer |
| Peak RSS (warm) | 322 MB | 80 MB | 75% less |

First-use install costs ~10-30s (one-time `npm install`). All subsequent spawns are instant and work offline.


## Key Code Locations

| What | File |
|------|------|
| Install service (install, validate, metadata, cleanup) | `src/main/services/managedMcpInstallService.ts` |
| Singleton accessor | `src/main/services/managedMcpInstallServiceInstance.ts` |
| Startup auto-upgrade (npx → managed) | `src/main/services/managedMcpAutoUpgrade.ts` |
| Reconnect managed-install preference | `src/main/services/bundledMcpManager.ts` → `buildPayloadFromCatalog()` |
| Legacy migration (bundled → npx, gated) | `src/main/services/bundledMcpManager.ts` → `migrateBundledConnectorsToNpx()` |
| Cloud rewrite (managed → npx) | `src/main/services/cloud/cloudMigrationService.ts` |
| Startup wiring | `src/main/index.ts` (search for `managedMcpInstallService`) |
| Connector catalog | `resources/connector-catalog.json` |
| Benchmark harness | `scripts/benchmark-mcp-spawn.ts` |


## Known Limitations

1. **Version updates require app releases** — the catalog is shipped with the app; no out-of-band connector updates.
2. **Enterprise proxy/registry not inherited** — installer clears user npmrc to avoid interference, which means corporate proxy settings are ignored during install.
3. **No Node ABI mismatch detection** — if the bundled Node version changes across app updates, native dependencies in existing managed installs may break. A version check + forced reinstall is planned.
4. **Old version directories not cleaned up** — when a catalog bumps a connector version, the previous install directory remains on disk. Cleanup is planned.
5. **Entry point resolution is heuristic** — uses `bin` → `main` → `index.js`; packages using only `exports` without `main`/`bin` may fail.
