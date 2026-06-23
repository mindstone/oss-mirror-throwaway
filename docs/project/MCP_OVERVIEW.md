---
description: "Territory hub for MCP/connector work — architecture, connector workflow, OSS distribution & release, testing, MCP Apps; routes to every MCP doc"
last_updated: "2026-06-11"
---

# MCP Overview

Territory hub for all MCP/connector work in Rebel. This doc routes; the leaves it points at are the canonical sources. If you're about to build, release, test, secure, or debug anything MCP-shaped, find your task below and go straight to the owning doc — don't reconstruct the process from memory.

## "I want to…"

| Task | Start here |
|------|------------|
| Add a connector to the catalog (1-click setup for users) | [MCP_ARCHITECTURE § Connector Catalog](MCP_ARCHITECTURE.md#connector-catalog) |
| Build or improve a bundled MCP server | [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) (workflow phases + critical policies) |
| Understand how MCPs work in Rebel | [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) |
| Migrate a bundled connector to OSS | [MCP_BUNDLED_TO_OSS_MIGRATION](MCP_BUNDLED_TO_OSS_MIGRATION.md) |
| **Release / version-bump an existing OSS connector** | **[MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md)** (`npm run mcp:release <name>`) — the only sanctioned path |
| First-publish a brand-new OSS package (0.0.1 + Trusted Publishing) | [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) (bootstrap/emergency only) |
| Audit catalog pins against npm `latest` | [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) |
| Smoke-test an OSS candidate locally before publish | [MCP_DEV_LOCAL_OVERRIDE](MCP_DEV_LOCAL_OVERRIDE.md) |
| Security-review one of **our own** OSS packages (pre-publish gate) | [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) |
| Security-review a **3rd-party** (non-owned) MCP server | [MCP_SECURITY_REVIEW](MCP_SECURITY_REVIEW.md) |
| Test bundled MCPs (smoke / integration harness) | [MCP_TESTING](MCP_TESTING.md) |
| Live-probe MCPs against a real Rebel instance | [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) |
| Debug Super-MCP / HTTP mode issues | [SUPERMCP_OVERVIEW § Troubleshooting](SUPERMCP_OVERVIEW.md#troubleshooting) |
| Ship a super-mcp submodule change | [SUPER_MCP_EDITING](SUPER_MCP_EDITING.md) |
| Build interactive tool-result UI (MCP Apps) | [MCP_UI_APPS](MCP_UI_APPS.md) |
| Understand how an update reaches users | [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) |
| Review a community PR to `mindstone/mcp-servers` | [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) |

## Doc map

### Core architecture & runtime

| Doc | Purpose |
|-----|---------|
| [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) | Runtime architecture: provider types, transports, auth patterns, catalog schema, connector UI |
| [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) | Super-MCP HTTP mode lifecycle, health checks, troubleshooting |
| [SUPER_MCP_LIFECYCLE](SUPER_MCP_LIFECYCLE.md) | Subprocess lifecycle, owner identity, orphan cleanup, concurrency contracts |
| [SUPER_MCP_EDITING](SUPER_MCP_EDITING.md) | Shipping changes to the super-mcp submodule (distinct from runtime doc above) |
| [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) | How version bumps, new tools, and schema changes propagate to users; caching edge cases |
| [MCP_CATALOG_PLACEHOLDERS](MCP_CATALOG_PLACEHOLDERS.md) | `{{TOKEN}}` placeholder resolution in the connector catalog |
| [TOOL_AWARENESS](TOOL_AWARENESS.md) | Tool discovery, semantic search, tool index |
| [use_tool arg-validation & schema salience](../research/260615_mcp_use_tool_schema_salience_and_arg_validation.md) | Why weak models fail use_tool arg-validation (−33003); super-mcp schema-driven auto-repair + the `REBEL_ENFORCE_SCHEMA_GATE` (A1) enforcing gate (default-ON since 2026-06-19; `=0` for telemetry-only, `REBEL_SKIP_SCHEMA_GATE=1` to disable) |
| [PYTHON_RUNTIME](PYTHON_RUNTIME.md) | Python runtime detection, uvx invocation |
| [BOUNDARY_REGISTRY](BOUNDARY_REGISTRY.md) | MCP boundary contracts, drift-protection registry, hints script |

### Building & improving connectors

| Doc | Purpose |
|-----|---------|
| [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) | **Start here to build/improve**: when/why/what order, workflow phases, critical policies |
| [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) | **How** to implement: SDK patterns, module architecture, security, Registry submission |
| [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) | Tool design best practices, error formats, response patterns |
| [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) | OAuth auth modes, security, per-provider capability rules |
| [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md) | Refresh-token ownership, failure handling, reconnect UX |
| [MCP_CONNECTOR_CONTRIBUTION_FLOW](MCP_CONNECTOR_CONTRIBUTION_FLOW.md) | User-contribution pipeline (carries a known-stale heads-up banner) |
| [BUILDING § Bundled MCP Servers](BUILDING.md#bundled-mcp-servers) | Build pipeline, esbuild bundling, packaging |
| [docs/project/mcps/](mcps/) | Per-connector docs (architecture, tools, setup) — 60+ leaves |
| `rebel-system/help-for-humans/connectors/` | User-facing connector docs |

### OSS distribution & release

> **Landing rule** (2026-06-11): code changes to `mcp-servers/` land code-only; version bumps/releases land **only** via `npm run mcp:release` — never bundled into a PR.

| Doc | Purpose |
|-----|---------|
| [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) | Cluster anchor: rebel-oss architecture, managed installs, startup lifecycle |
| [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md) | **THE release path** for existing packages: `npm run mcp:release`, `--reconcile` recovery, landing rule |
| [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) | **Bootstrap/emergency only**: first publish of a new package, Trusted Publishing setup |
| [MCP_BUNDLED_TO_OSS_MIGRATION](MCP_BUNDLED_TO_OSS_MIGRATION.md) | End-to-end sequence for the *first* migration of a bundled connector to OSS |
| [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) | Rerunnable drift audit: catalog pins vs npm `dist-tags.latest` |
| [MCP_DEV_LOCAL_OVERRIDE](MCP_DEV_LOCAL_OVERRIDE.md) | Pre-publish local smoke via the `source.localTarball` seam |
| [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md) | Per-connector validation ledger (point-in-time snapshots; rows dated individually) |
| [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) | **Hard gate**: mandatory pre-publish security review for our own OSS packages |
| [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) | Reviewer-side workflow for community PRs to `mindstone/mcp-servers` |
| [`mcp-servers/AGENTS.md`](../../mcp-servers/AGENTS.md) + [`CONTRIBUTING.md`](../../mcp-servers/CONTRIBUTING.md) | Public repo docs — **external-contributor audience**, different rules; read before editing anything in the submodule |

### Testing & verification

| Doc | Purpose |
|-----|---------|
| [MCP_TESTING](MCP_TESTING.md) | Bundled-MCP test harness: smoke + integration levels, maintenance, debugging |
| [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) | Live headless-CLI smoke against a real, authenticated Rebel instance |
| [MCP_CLOUD_TESTER](MCP_CLOUD_TESTER.md) | CI UI smoke via GitHub Actions |
| [TESTING_EVALS_OSS_CONNECTOR_FLOW](TESTING_EVALS_OSS_CONNECTOR_FLOW.md) | OSS connector eval harness (build flow, not per-connector behaviour) |
| [TOOL_SAFETY](TOOL_SAFETY.md) | Runtime tool safety evaluation, approval flow |

### Security reviews (two distinct gates — don't conflate)

| Scope | Doc |
|-------|-----|
| **Our own** `@mindstone/mcp-server-*` packages, pre-publish | [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) |
| **3rd-party / non-owned** MCP servers, before shipping or on bump | [MCP_SECURITY_REVIEW](MCP_SECURITY_REVIEW.md) |

### MCP Apps (interactive UI)

| Doc | Purpose |
|-----|---------|
| [MCP_UI_APPS](MCP_UI_APPS.md) | Interactive tool-result views; primary/inline presentation contract |
| [MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT](MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT.md) | iframe ↔ host trust boundary contract |
| [MCP_APP_SUPER_MCP_SEAM](MCP_APP_SUPER_MCP_SEAM.md) | Authoritative app-consumed Super-MCP seam table |

### Dev tooling

| Doc | Purpose |
|-----|---------|
| [MCP_ELECTRON_CONTROLLER](MCP_ELECTRON_CONTROLLER.md) | The `rebel-electron` MCP server for driving the app during development |
