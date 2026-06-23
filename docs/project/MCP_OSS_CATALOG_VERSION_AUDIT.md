---
description: "Runbook for auditing rebel-oss connector pins in resources/connector-catalog.json against the latest published versions on npm, and applying drift fixes safely."
last_updated: "2026-05-20"
---

# OSS Connector Catalog Version Audit

A rerunnable runbook for confirming that every `provider: "rebel-oss"` pin in `resources/connector-catalog.json` matches the latest version published to npm under `@mindstone/*`. Run it on a regular cadence (suggested: weekly, plus on demand after a publish wave in [`mindstone/mcp-servers`](https://github.com/mindstone/mcp-servers)).

## See Also

- [MCP_UPDATE_LIFECYCLE](MCP_UPDATE_LIFECYCLE.md) — How a catalog version bump propagates to users (`reconcileNpxPackageVersions()` at app launch). **Read this first** to understand what shipping a bump actually does.
- [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md) — Ship a bump via `npm run mcp:release` once drift is detected (`--reconcile <name>` when the bump already reached mcp-servers main). [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) is bootstrap/emergency-only.
- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — What rebel-oss connectors are and how they're distributed.
- [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md) — Per-connector validation status; cross-reference before bumping.
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) — **Mandatory pre-publish security review** gate; behaviour-changing version bumps must clear this before they reach the catalog.
- Source-of-truth repo for OSS packages: `/Users/you/development/mcp-servers` (`mindstone/mcp-servers` on GitHub).
- Catalog source of truth: [`resources/connector-catalog.json`](../../resources/connector-catalog.json).
- Fallback used when the catalog lookup fails: `buildGoogleWorkspaceInstancePayload()` in [`src/main/services/bundledMcpManager.ts`](../../src/main/services/bundledMcpManager.ts).


## When to Run

- **Routine cadence:** weekly, or whenever upstream `mcp-servers` has had recent publish activity.
- **After a known publish wave:** when an OSS connector PR lands in `mcp-servers` and CI publishes a new tarball.
- **Before a release cut:** part of the pre-release MCP hygiene pass.
- **After a postmortem:** if a user reports stale behaviour from a connector, audit first before deeper diagnosis.


## STOP Gates

Two hard gates apply before any drift fix lands in the catalog:

1. **§ 13 Pre-Publish Security Review** — see [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review). Required for any **behaviour-changing** publish, including new tools, new dependencies, auth-flow changes, or response-shape changes. A doc-only / README-only patch publish does **not** require a fresh review, but the bump commit must state that explicitly and link to the upstream commits to prove it.
2. **MCP_UPDATE_LIFECYCLE awareness** — a catalog bump propagates to **every** existing user on their next app launch via `reconcileNpxPackageVersions()`. There is no soft launch, no kill switch. If you're not confident the upstream version is safe for every user with the connector already installed, do not bump.


## Audit Procedure

### 1. Enumerate every `@mindstone/*` pin currently in the catalog

```bash
rg -n --no-heading -o '@mindstone/mcp-server-[a-z0-9-]+@[0-9][0-9A-Za-z.\-+]*' \
  resources/connector-catalog.json \
  | sort -u
```

This yields the catalog-pinned `<package>@<version>` list. Each line is one occurrence; some packages (e.g. `email-imap`) appear under multiple connector entries — the version must be identical across all of them.

### 2. Resolve the npm `latest` dist-tag for each unique package

```bash
PKGS=$(rg -o '@mindstone/mcp-server-[a-z0-9-]+' resources/connector-catalog.json \
  | sort -u \
  | sed 's|@mindstone/mcp-server-||')

for pkg in $PKGS; do
  latest=$(npm view "@mindstone/mcp-server-$pkg" dist-tags.latest 2>/dev/null || echo NOT-PUBLISHED)
  echo "@mindstone/mcp-server-$pkg latest=$latest"
done
```

Compare against the output of step 1. Anything where the catalog version trails `latest` is a drift candidate.

### 3. (Optional) Cross-check the local `mcp-servers` checkout

```bash
cd /Users/you/development/mcp-servers \
  && git fetch --tags origin \
  && for d in connectors/*/; do
       [ -f "$d/package.json" ] && node -e "const p=require('./$d/package.json'); console.log(p.name+'@'+p.version)"
     done
```

This catches the case where a publish workflow failed mid-flight and the npm `latest` tag is older than the repo `HEAD` (suggests an upstream operational issue, not a catalog drift).

### 4. Confirm the upstream commit set behind each new version

For each drift candidate, run:

```bash
cd /Users/you/development/mcp-servers
git log --all --oneline -20 -- connectors/<connector>
```

You want to know whether the publish was:
- **Doc-only / README-only / metadata-only** — safe to bump without a fresh security review; cite the upstream commits in the bump commit body.
- **Behaviour-changing** — STOP. Confirm the § 13 security review for that version is on file under `docs-private/reports/security-reviews/` before bumping the catalog.


## Applying a Bump

Once a bump is justified, change every place that hardcodes the pin:

1. **Catalog (required):** `resources/connector-catalog.json` — every `mcpConfig.args` occurrence for that package.
2. **Fallback (required when bumping `google-workspace`):** `src/main/services/bundledMcpManager.ts` — `buildGoogleWorkspaceInstancePayload()` carries a literal `@mindstone/mcp-server-google-workspace@<version>` used when the catalog entry lookup fails. Keep it in sync with the catalog.
3. **Test fixtures (required):** these assert against the catalog/fallback values and will go red otherwise:
   - `src/main/services/__tests__/bundledMcpCloudRegistration.test.ts`
   - `src/main/services/__tests__/bundledMcpManager.googleMigration.test.ts`
   - `src/main/services/__tests__/bundledMcpManager.test.ts`
   - `src/main/ipc/__tests__/settingsHandlers.test.ts`
   - `src/shared/__tests__/connectorCatalog.test.ts`
4. **Eval snapshots (only when the tool surface changed):** `evals/mcp-twins/*` files comment that they snapshot a specific package version. If the bump is README-only the snapshot is still accurate and the comment can stay (audit notes will document why). If the bump changed tools/schemas, regenerate the snapshot.
5. **Allowed npx package regex (rarely):** `ALLOWED_NPX_PACKAGE_RE` in `src/main/services/connectorCatalogResolver.ts` accepts any exact semver under `@mindstone/` already, so no edit is normally required. Only touch this if you add a new scope.

What you should **not** edit:
- Time-stamped historical records: `docs-private/reports/security-reviews/*`, `docs/plans/*`, `CHANGELOG.md`, `rebel-system/help-for-humans/changelog.md`. These pin the version that was current at the time and must remain accurate.
- Evergreen connector docs (`docs/project/mcps/*.md`, `docs/project/MCP_OSS_CONNECTORS*.md`) — these refer to the connector as a concept. If you update the catalog version, also update these only if they document the runtime pin verbatim and a reader would otherwise be misled.


## Validation

Run before committing:

```bash
npm run validate:fast
npm test -- --run \
  src/main/services/__tests__/bundledMcpCloudRegistration.test.ts \
  src/main/services/__tests__/bundledMcpManager.googleMigration.test.ts \
  src/main/services/__tests__/bundledMcpManager.test.ts \
  src/main/ipc/__tests__/settingsHandlers.test.ts \
  src/shared/__tests__/connectorCatalog.test.ts
```

`validate:fast` checks IPC contracts, store versions, MCP bundle drift, circular deps, and TypeScript error ratchet. The targeted vitest run confirms the test fixtures match the new pin.


## Commit Message Template

```
chore(catalog): Bump <connectors> to latest npm versions. <One-line why>.

- @mindstone/mcp-server-<a>: 0.x.y → 0.x.z (<doc-only|behaviour-change>; upstream <sha>)
- @mindstone/mcp-server-<b>: 0.x.y → 0.x.z (<doc-only|behaviour-change>; upstream <sha>)

Synced fallback in bundledMcpManager.ts and the five test fixtures that pin
the package spec verbatim. § 13 security review status: <N/A doc-only | file
under docs-private/reports/security-reviews/<file>.md>.

AI-Workflow: direct
AI-Implementer: <model>
AI-Review-Mode: light
```


## Known Edge Cases

- **npx caches by version specifier.** Changing the catalog from `@0.1.0` to `@0.1.1` forces a fresh fetch on the user's side. Publishing different content under the **same** version does not propagate via this audit (and is a publish-side anti-pattern; see [MCP_UPDATE_LIFECYCLE § npx package caching](MCP_UPDATE_LIFECYCLE.md#npx-package-caching)).
- **`NOT-PUBLISHED` results.** A package present in the local `mcp-servers` checkout but missing from npm is in-flight. Do **not** add it to the catalog as `rebel-oss` until the publish completes and the NPX reachability gate (cohort C7) passes from a clean shell.
- **Multiple entries for the same package.** A handful of catalog entries share a package (e.g. `@mindstone/mcp-server-email-imap` appears under three connector ids). The audit must update **all** occurrences or the cohort goes inconsistent; the `rg`-based enumeration in step 1 surfaces every line.


## Future Automation

The procedure above is shell-driven on purpose so the next maintainer can read every step. If we run it often enough to justify it, the natural next step is a `scripts/check-mcp-catalog-versions.ts (path removed — verify)` script that:

1. Parses `resources/connector-catalog.json` for `@mindstone/*` pins.
2. Queries npm for each `dist-tags.latest`.
3. Prints a drift table and exits non-zero on any drift.
4. Optionally wires into `validate:fast` as an advisory (non-blocking) check.

Until that exists, the runbook here is the single source of truth.
