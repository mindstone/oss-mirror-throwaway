---
description: "End-to-end process for migrating a bundled MCP connector (resources/mcp/<name>) into an open-source npm package (@mindstone or @mindstone-engineering/mcp-server-<name>), including the mandatory pre-publish live-API test gate"
last_updated: "2026-06-11"
---

# Bundled → OSS Connector Migration Process

The canonical end-to-end sequence for moving a connector from `resources/mcp/<name>` (bundled, shipped inside the app binary) to `@mindstone/mcp-server-<name>` or legacy `@mindstone-engineering/mcp-server-<name>` (open-source npm package, `provider: "rebel-oss"` in the catalog).

This doc is **process-only** — it stitches together the architecture, principle, and exemplar docs into one ordered sequence and adds the **mandatory pre-publish live-API test gate** that exemplar plans (Slack, Retell AI) discovered the hard way.

## See Also

Canonical sources — read these first, this doc only sequences them:

- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — Architecture: how `rebel-oss` works, managed installs, startup migration chain
- [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md) — Per-connector status, recommended migration order (credential-led tiers)
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) — Auth modes, capability matrix; **§ 13 Mandatory Pre-Publish Security Review** (hard gate)
- [MCP_CONNECTOR_WORKFLOW § Critical: OSS Connector Security](MCP_CONNECTOR_WORKFLOW.md#critical-oss-connector-security) — Internal-reference stripping, bridge-pattern prohibition, host validation, license/SECURITY.md, supply chain
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — SDK patterns (`McpServer` + `registerTool` + Zod), OSS Readiness, **Registry Submission** (`server.json`, `mcpName`, `mcp-publisher`)
- [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) — Reviewer-side workflow once a PR reaches `mindstone/mcp-servers`
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) — How a catalog version bump reaches users
- [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) — First-publish/bootstrap and genuine emergencies **only**; every subsequent version bump goes through `npm run mcp:release` — see [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md)

Exemplar planning docs (read at least one before drafting your own):

- [`docs/plans/260429_slack_mcp_oss_migration.md`](../plans/260429_slack_mcp_oss_migration.md) — Most thorough OAuth migration template, 5 stages, cohort fixes, cross-surface refresh-token race
- [`docs/plans/260503_hubspot_mcp_oss_migration.md`](../plans/260503_hubspot_mcp_oss_migration.md)
- [`docs/plans/260503_openai_image_oss_migration.md`](../plans/260503_openai_image_oss_migration.md)
- [`docs/plans/260422_rebeloffice_oss_migration.md`](../plans/260422_rebeloffice_oss_migration.md)
- [`docs/plans/260409_generalize_bundled_to_npx_migration.md`](../plans/260409_generalize_bundled_to_npx_migration.md) — Why the catalog flip alone triggers migration; no per-connector migration code needed
- [`docs/plans/260423_publish_oss_connectors_v030_and_catalog_sync.md`](../plans/260423_publish_oss_connectors_v030_and_catalog_sync.md) — Publish + catalog sync mechanics

Tooling:

- [`scripts/test-oss-connectors.ts`](../../scripts/test-oss-connectors.ts) — Catalog-driven real-API runner for Phase C5 (run with `npm run test:oss-connectors`). See [`scripts/lib/ossConnectorSmokeTests.ts`](../../scripts/lib/ossConnectorSmokeTests.ts) for the per-connector smoke registry and [`.env.oss-test.example`](../../.env.oss-test.example) for credential conventions.

Postmortems that shaped the playbook:

- [`260417_rebel_oss_bundledconfig_regression_postmortem.md`](../../docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md) — `bundledConfig` block MUST survive the flip
- [`260424_oss_catalog_sync_automation_never_worked_postmortem.md`](../../docs-private/postmortems/260424_oss_catalog_sync_automation_never_worked_postmortem.md)
- [`260429_oss_connector_catalog_unpinned_versions_postmortem.md`](../../docs-private/postmortems/260429_oss_connector_catalog_unpinned_versions_postmortem.md) — Pinned exact semver is non-negotiable

---

## Intent

Two non-negotiables drive this process:

1. **A catalog pin is a production deployment to every Rebel user on next launch.** There is no soft launch and no kill switch short of shipping a new app build. The pre-publish security review (§ 13) and the pre-publish live-API test (Phase C5 below) are the only chokepoints.
2. **Migration is catalog-driven, not code-driven.** `migrateBundledConnectorsToNpx()` auto-detects any catalog entry where `provider: "rebel-oss"` + `mcpConfig.command: "npx"`. Adding new connectors requires zero migration code (see [260409 plan](../plans/260409_generalize_bundled_to_npx_migration.md)).

---

## Completed migration ledger

| Date | Connector | OSS package | Version | Planning doc | Commit chain summary |
|---|---|---|---|---|---|
| 2026-05-19 | OpenAI Image (`openai-image-generation`) | `@mindstone/mcp-server-openai-image` | `0.1.0` at migration; current catalog pin `0.1.2` | [`260503_openai_image_oss_migration`](../plans/260503_openai_image_oss_migration.md) | `260519_1300`: catalog flipped to `rebel-oss`, provider-key env resolution moved to generic host/core paths, structured recovery and timeout contracts shipped, and the § 13 security-review skeleton was linked from the release notes. |
| 2026-05-19 | Google Workspace (`bundled-google`) | `@mindstone/mcp-server-google-workspace` | `0.1.0` at migration; current catalog pin `0.1.2` | [`260519_google_workspace_oss_migration`](../plans/260519_google_workspace_oss_migration.md) | `260519_1500`: Stages 0-3 prepared host auth, ported/published the OSS package, and recorded § 13 evidence; Stage 4 flipped the catalog at `dd00a300a`; Stage 5 deleted the bundled tree and repointed eval/docs references. |
| 2026-05-19 | Replit SSH (`bundled-replit-ssh`) | `@mindstone/mcp-server-replit-ssh` | `0.1.0` at migration; current catalog pin `0.1.2` | [`260519_replit_ssh_oss_migration`](../plans/260519_replit_ssh_oss_migration.md) | `260519_1700`: catalog flipped to `rebel-oss`, the legacy `resources/mcp/replit-ssh/` tree was deleted in cleanup, recovery/timeout/atomic-write contracts were ported, and security review was recorded at `docs-private/reports/security-reviews/260519_bundled-replit-ssh_0.1.0.md`. |
| 2026-05-19 | Microsoft 365 / Office cohort (`bundled-microsoft-*`, `bundled-office`) | `@mindstone/mcp-server-microsoft-{mail,calendar,files,teams,sharepoint}`; `@mindstone/mcp-server-office` | Microsoft packages `0.1.1`; Office `0.2.0` | [`260519_microsoft_365_oss_migration`](../plans/260519_microsoft_365_oss_migration.md), [`260422_rebeloffice_oss_migration`](../plans/260422_rebeloffice_oss_migration.md) | `260519_2339`: Mail, Calendar, OneDrive, Teams, and SharePoint flipped to `rebel-oss` npx catalog entries; bundled-manager fallback paths were removed while preserving per-account instance migration across desktop and cloud. |
| 2026-05-22 | HubSpot (`bundled-hubspot`) | `@mindstone/mcp-server-hubspot` | `0.2.0` | [`260503_hubspot_mcp_oss_migration`](../plans/260503_hubspot_mcp_oss_migration.md) | `260522_0830`: host catalog pin bumped to `0.2.0`, `conversations.read` was mirrored into scopes, existing `0.1.2` users keep working, and FOX-3354/FOX-3376 tool coverage reached the app catalog. |

---

## Phase A — Pre-work

1. **Pick a candidate** from [MCP_OSS_CONNECTORS_TESTING_STATUS § Bundled NOT Yet Migrated](MCP_OSS_CONNECTORS_TESTING_STATUS.md#bundled-connectors-not-yet-migrated). Honour the credential-led Tier 1 / 2 / 3 order — Tier 1 (no creds needed) is cheapest to validate, Tier 2 (OAuth) is highest learning value, Tier 3 has explicit deferral reasons.
2. **Decide auth mode** per [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 1](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#1-auth-mode-architecture). API-key connectors skip most OAuth-specific work and have a much simpler Phase B / C.
3. **Confirm credentials are available** for Phase C5 live-API testing (see below). If no usable test account or key exists, defer the migration — pre-publish live-API testing is mandatory.
4. **Write a planning doc** at `docs/plans/YYMMDD_<connector>_oss_migration.md` using the Slack plan as template. Run the multi-model `CHIEF_ENGINEER` review.

---

## Phase B — Host-side preparation (Stage 0)

These changes land in the Rebel app **before** the OSS publish so the host environment is ready to integrate with the new package.

5. Extend `invokeStdioAuthenticateTool` in `src/main/services/mcpService.ts` if changing the auth-tool response contract (e.g., new `auth_required` structured shape).
6. Strengthen `src/shared/__tests__/connectorCatalog.test.ts` so the migrated entry is still covered by the host's auth/setup routing tests (the postmortem 260417 silent-skip class).
7. Wire cloud registration (`bundledMcpCloudRegistration.discover<Connector>`) to inject credentials or set disable-refresh flags so cross-surface still works (e.g., `SLACK_DISABLE_REFRESH=1` for cloud — desktop is sole refresh authority).

---

## Phase C — Port to `mindstone/mcp-servers`, test, and publish

This is where the OSS package is created. **Each numbered sub-stage is required, in order.**

### C1. Port source

8. Copy `resources/mcp/<name>/src/` into `mcp-servers/packages/mcp-server-<name>/src/`.
9. If not already on the standard, port to `McpServer + registerTool + Zod` per [MCP_SERVER_STANDARD § 1](MCP_SERVER_STANDARD.md#1-sdk-construction-standard).

### C2. Apply cohort fixes

10. `SERVER_VERSION` read from `package.json` via `createRequire(import.meta.url)('../package.json').version` (failure class 8 — stale `SERVER_VERSION` is the most common drift class).
11. `destructiveHint: true` on every mutating tool; `openWorldHint: true` on every API-touching tool. See [MCP_ARCHITECTURE § ToolAnnotations](MCP_ARCHITECTURE.md#toolannotations).
12. **Recovery-guidance contract** on every error: `{ ok: false, action_required, next_step }` with host-neutral messaging.
13. **Request-timeout pattern**: split `DEFAULT_<X>_REQUEST_TIMEOUT_MS` from any bridge timeout, default to a measured value (typically 60 s), expose env override with validation, compose caller `AbortSignal` with built-in timeout via `AbortSignal.any()`. Per postmortem [`260421_nano_banana_request_timeout`](../../docs-private/postmortems/260421_nano_banana_request_timeout_postmortem.md).

### C3. Strip internal references (hard gate, scriptable)

14. Run `grep -ri 'Mindstone\|Rebel\|nspr\|MINDSTONE_REBEL_BRIDGE_STATE\|MCP_HOST_BRIDGE_STATE'` over `src/`, `test/`, docs, `package.json` (excluding LICENSE and `package.json` author/scope). **Zero matches required.**
15. No `bridge.ts`, no localhost bridge calls, no internal env vars (e.g., `REBEL_WORKSPACE_PATH`). Branded User-Agents replaced with `mcp-server-<name>/<version>`.
16. Add LICENSE (full FSL-1.1-MIT text), README.md, repo-level SECURITY.md.
17. Host validation: any user-supplied hostname/subdomain must pass a service-specific allowlist/pattern before credentials are sent (e.g., Freshdesk subdomain regex, `*.workday.com`).

### C4. Mock-API tests

18. Add `__tests__/test-mcp.test.ts` using `createMcpTestClientWithMockApi()` (see [MCP_CONNECTOR_WORKFLOW § Phase 5.1](MCP_CONNECTOR_WORKFLOW.md#51-mock-api-tests-preferred-for-rest-apis)). Cover response shaping, pagination, error handling, input validation, edge cases.
19. **Request-manifest fixture**: assert every MSW handler URL matches a corresponding production code-path string. Prevents the retell-ai-0.1.2 class of bug where MSW handlers and production HTTP calls drift.
20. Mock tests must run in default CI with no credentials.

### C5. Pre-publish live-API verification — **mandatory, automated, against real APIs**

This stage runs the published package against the real upstream service using real credentials. It is the only chokepoint that catches the class of bugs mock tests cannot: real auth handshakes, real rate-limit handling, real response shapes, real pagination edges, real timezone drift, real schema evolution between SDK release and connector publish.

The retell-ai 0.1.2 → 0.1.3 incident (three real bugs only surfaced by post-publish live probe) is why this is now a **pre-publish** gate rather than a post-publish discovery.

#### C5.1. The catalog-driven runner — `scripts/test-oss-connectors.ts`

The canonical entry point is the catalog-driven runner at [`scripts/test-oss-connectors.ts`](../../scripts/test-oss-connectors.ts), runnable via `npm run test:oss-connectors`.

It:

- Loads every `provider: "rebel-oss"` entry from `resources/connector-catalog.json`.
- Spawns the published package via `npx -y <pkg>@<version>` using **the exact `mcpConfig.args` users will run** — no fork between what we test and what ships.
- Reads credentials from `OSS_TEST_<CONNECTOR_ID>__<FIELD_ID>` env vars (with fallback to the catalog's `setupFields[].envVar` legacy names — see the auto-generated [`.env.oss-test.example`](../../.env.oss-test.example) for the full list).
- Skips connectors whose required env is missing (unless `--require-all`), so partial credential coverage is OK.
- Verifies `listTools()` returns ≥ 1 tool — mandatory for every connector.
- Runs a single safe smoke probe per connector from an **explicit, hand-curated registry** at [`scripts/lib/ossConnectorSmokeTests.ts`](../../scripts/lib/ossConnectorSmokeTests.ts). The registry deliberately avoids auto-discovery — write tools are never called.
- Reports pass/fail per connector with timings and a machine-readable JSON option (`--json <path>`) for CI consumption.

Typical usage:

```bash
# One-time: generate or refresh the example env file.
npx tsx scripts/test-oss-connectors.ts --generate-env-example
cp .env.oss-test.example .env.oss-test  # gitignored
# Fill in credentials you have, then:
npm run test:oss-connectors -- --env-file .env.oss-test

# Single connector before publish:
npm run test:oss-connectors -- --env-file .env.oss-test --connector bundled-fathom

# List-only (verify the server boots and lists tools; skip live smoke probes):
npm run test:oss-connectors -- --list-only
```

#### C5.2. Per-package live test (richer coverage)

For connectors that need richer pre-publish coverage than a single read probe — write tools, token rotation, pagination edges, P95 latency — also add `test/live.test.ts` (or `test/live-probe.ts`) inside the OSS package itself:

- Runs `npm pack` on the package, extracts the tarball into a temp dir, and spawns the extracted entry point — **never the workspace source**. This catches missing files in `files: []`, broken `bin`/`main` paths, and tsconfig include drift.
- Connects via the MCP SDK stdio client.
- Asserts `initialize` + `tools/list` succeed and tool annotations match the catalog.
- Calls **at least 3 read-only tools** with diverse parameter shapes (list, get-by-id, search/filter) and asserts response shape, not exact values.
- Calls **at least 1 write tool** against a designated **scratch resource** (a test channel, test list, test workspace, test record) that is safe to mutate. Asserts the write succeeded by reading back via a read-only tool in the same test run.
- For OAuth connectors: backdates `expiresAt` and asserts token refresh + atomic file write + mode 0600 round-trip works through the OSS server.
- Logs P95 latency for the slowest tool so the request-timeout default (C2 step 13) is measurement-grounded.

The catalog-driven runner (C5.1) is mandatory for all connectors. The per-package `test/live.test.ts` (C5.2) is mandatory for any connector with write tools, OAuth, or non-trivial pagination.

#### C5.3. Credentials

- Real credentials enter via env vars, never committed. `.env.oss-test` is gitignored; `.env.oss-test.example` is the committed reference, auto-generated from the catalog.
- The catalog-driven runner skips cleanly when env is missing — it must not silently no-op nor fail the default CI run.
- For OAuth connectors, the test reads tokens from a scratch token file in a temp dir that mirrors the production schema. The OAuth flow itself is not automated — credentials are supplied by the human operator running the probe.

#### C5.4. Execution

The live-API suite runs in **three** places:

1. **Local developer**: `npm run test:oss-connectors -- --env-file .env.oss-test` before opening the publish PR. Output committed to the PR description (use `--json reports/live-probe-<connector>.json` to attach).
2. **CI (manual)**: a GitHub Actions workflow with `workflow_dispatch` and secrets-scoped credentials, triggered by the publisher before merging the version bump. **Not** part of default CI (real-API calls are non-deterministic and rate-limited).
3. **Pre-publish gate (process requirement, enforcement pending)**: the human publisher must attach a recent live-probe results file (`status: "pass"`, timestamp within 24 hours) to the publish PR. Mechanical enforcement via a publish script that refuses `npm publish` without such a file is planned but not yet implemented — until then, this is a process check enforced by reviewer sign-off.

#### C5.5. Acceptance gates

- The catalog-driven runner (`npm run test:oss-connectors -- --connector <id>`) exits 0 for the connector being published.
- For connectors with a per-package `test/live.test.ts`: all listed tools return successful responses, write tool's effect is observable via a follow-up read, OAuth token refresh round-trip succeeds, P95 latency ≤ the configured `REQUEST_TIMEOUT_MS`.
- Zero matches for internal-reference strings in the **packed tarball** (`npm pack && tar -tzf … && grep …`), repeating C3 step 14 against the artifact rather than source.

#### C5.6. On failure

- **Do not publish.** File a fix, re-run C4 + C5. Update the planning doc with the discovered bug class for future cohort fixes.

> **Why the packed tarball, not workspace source?** Workspace tests pass through `tsconfig.json` paths, `node_modules` resolution, and a populated `dist/`. The published tarball goes through `files: []`, `bin`, `main`, `exports`, and only ships what's listed. Bugs of the form "works locally, breaks for users" live in this gap. The catalog-driven runner inherently tests the published artifact (it `npx`-pulls the live package); a per-package `test/live.test.ts` should also `npm pack` rather than import workspace source.

### C6. Mandatory pre-publish security review (hard gate)

21. Pass [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) (AI-only): agent-authored security review + mandatory cross-family adversarial pass (different model family, verdict `UPHELD` or `UPHELD-WITH-ADDENDA`) + `Release-Authorized-By` in the Release Gate block. Write report to `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md` and link from the publish commit via the `Release-Gate: <repo-relative-review-path>#<sha256>` trailer (stamped automatically by `mcp:release`; see [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md#the-release-gate-commit-trailer)).

### C7. Publish

22. Write `server.json`, run `mcp-publisher validate`, confirm `mcpName` matches `io.github.mindstone/mcp-server-<name>` and that bridge-only env vars are excluded from `environmentVariables[]`.
23. Publish `@mindstone-engineering/mcp-server-<name>@0.1.0` to npm using OIDC trusted publishing with provenance attestations. Commit trailer must reference both the security-review report and the live-probe results.

---

## Phase D — Catalog flip in the Rebel app (Stage 2)

24. In `resources/connector-catalog.json`: flip `provider: "bundled"` → `"rebel-oss"`, **preserve the entire `bundledConfig` block** (postmortem 260417), add `mcpConfig: { command: "npx", args: ["-y", "@mindstone-engineering/mcp-server-<name>@<exact-semver>"] }`. Pinned exact semver — no `@latest`, no ranges.
25. In `src/main/services/bundledMcpManager.ts`: drop the entry from `BUNDLED_MCP_CATALOG`, delete `build<Name>Payload` / `resolve<Name>ServerScript` / `resolve<Name>NodeModules`. Keep per-instance payload builders if multi-account is supported (Slack, Google) but rewrite them to emit npx form.
26. Remove `<name>` from `bundledMcps` in `scripts/mcp-config.json`.
27. **Verify catalog-driven auto-migration** picks up the flip. `migrateBundledConnectorsToNpx()` and `upgradeRebelOssEntriesToManaged()` need no per-connector code. For multi-instance OAuth connectors, add a per-instance branch so per-workspace entries (e.g., `Slack-mindstone`, `Slack-acme`) aren't collapsed.

---

## Phase E — Cross-surface verification (Stages 3-4)

28. **Desktop**: live test ≥ 5 read-only + ≥ 2 write tools against a real account through the running Rebel app (not just the OSS package's own probe).
29. **Cloud**: verify `cloudMigrationService.rewriteManagedMcpEntriesToNpxForCloud()` rewrites `node <managedPath>` back to `npx <pkg>` and credentials propagate via `CLOUD_CHANNEL_POLICIES` per [CROSS_SURFACE_PARITY_CHECKLIST](CROSS_SURFACE_PARITY_CHECKLIST.md).
30. **Token rotation E2E (OAuth only)**: backdate `expiresAt` in the live user profile, invoke a tool, assert refresh + persist + atomic write + mode 0600.
31. **Bridge-state hygiene grep on the published tarball**: `npm pack` from registry, `tar -tzf` and grep for `MINDSTONE_REBEL_BRIDGE_STATE` / `MCP_HOST_BRIDGE_STATE`. Zero matches required (audit step that the cleanup-worker pattern previously missed — failure class 4).

---

## Phase F — Cleanup, validation flow, docs (Stage 5)

32. Land `.factory/validation/<connector>/user-testing/synthesis.json` round 1 covering connect → authenticate → read → write → disconnect.
33. Update [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md): move row from "Bundled NOT Yet Migrated" to "Validated via user-testing flow", bump status-summary counts.
34. **Delete `resources/mcp/<name>/`** — only after Phase E passes (irreversible).
35. Update `evals/mcp-twins/<name>-tools.ts` (delete or repoint), `evals/mcp-twins/__tests__/twin-fidelity.test.ts`, `rebel-system/help-for-humans/connectors/<name>.md`, both changelogs (`CHANGELOG.md` + `rebel-system/help-for-humans/changelog.md`) per [CHANGELOG_UPDATE_PROCESS](CHANGELOG_UPDATE_PROCESS.md).

---

## Key invariants (do not break)

| Invariant | Source |
|---|---|
| Pinned exact semver in `mcpConfig.args` (no `@latest`, no ranges) | [MCP_CONNECTOR_WORKFLOW § Version Pinning](MCP_CONNECTOR_WORKFLOW.md#version-pinning-for-npx-mcps) |
| `bundledConfig` block preserved through the flip | Postmortem 260417 |
| No `MINDSTONE_REBEL_BRIDGE_STATE` / `MCP_HOST_BRIDGE_STATE` strings in the published tarball | [MCP_CONNECTOR_WORKFLOW § Critical: OSS Connector Security](MCP_CONNECTOR_WORKFLOW.md#critical-oss-connector-security) |
| `migrateBundledConnectorsToNpx()` stays catalog-driven — adding `provider: "rebel-oss"` is what triggers migration | [260409 plan](../plans/260409_generalize_bundled_to_npx_migration.md) |
| Security review (§ 13) is mandatory and blocking — first publish AND every version bump | [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) |
| **Pre-publish live-API test (Phase C5) is mandatory** — every connector must show a passing `scripts/test-oss-connectors.ts` run before publish (mechanical publish-script enforcement pending) | This doc; runner: `scripts/test-oss-connectors.ts` |
| Live-API tests run against the **packed tarball** or the **published npm package**, never workspace source | This doc, Phase C5 |
| **Smoke probes are hand-curated, never auto-discovered** — preventing accidental write-tool calls | [`scripts/lib/ossConnectorSmokeTests.ts`](../../scripts/lib/ossConnectorSmokeTests.ts) |
| `npm publish` uses OIDC trusted publishing with provenance attestations | [MCP_CONNECTOR_WORKFLOW § F. Supply Chain Security](MCP_CONNECTOR_WORKFLOW.md#f-supply-chain-security) |

---

## Specialist droids that automate parts of this

Use the Task tool with these custom droids when the phase fits:

- **`oss-port-worker`** — Ports a bundled connector to the `mcp-servers` repo as an OSS npm package (covers C1-C3).
- **`migration-worker`** — Fixes startup migration ordering, reconnect UI flows, and updates tests for migrated connectors (covers parts of B and D).
- **`contribution-worker`** — Implements OSS contribution flow features using `CHIEF_ENGINEER` workflow patterns.
- **`bundled-cleanup-worker`** — Removes bundled MCP connector infrastructure from rebel-app and updates catalog (covers F step 34).
- **`cleanup-worker`** — Removes dead bundled MCP connector code and updates build/package configuration.

Phase C5 (pre-publish live-API testing) and C6 (security review) are deliberately not delegated — they are the chokepoints and must be reviewed by a human before publish.
