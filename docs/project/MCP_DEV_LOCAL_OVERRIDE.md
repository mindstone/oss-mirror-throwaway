---
description: "Runbook for the pre-publish local MCP smoke test: pack an unpublished @mindstone/mcp-server-* candidate, install it into the same managed-install slot Rebel uses for published packages, smoke-test in the chat UI, then clean up before publishing."
last_updated: "2026-05-21"
---

# MCP Dev Local Override

A reusable, lightweight pre-publish smoke test for OSS MCP connectors. Use this when you're about to publish a behaviour-changing version of `@mindstone/mcp-server-<name>` and want to verify the candidate works inside dev Rebel **before** it hits npm and every user's next launch.

Inserts into [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) **Phase D step 19.5**.

## See also

- [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) — the parent publish runbook; step 19.5 is the entry point that signposts here.
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) — how `reconcileNpxPackageVersions()` propagates a catalog pin; explains why the `REBEL_CATALOG_OVERRIDE` env var must be set on every dev relaunch.
- [`scripts/dev-mcp-managed-install.ts`](../../scripts/dev-mcp-managed-install.ts) — the wrapper script.
- [`src/main/services/managedMcpInstallService.ts`](../../src/main/services/managedMcpInstallService.ts) — the install service this workflow consumes via the `source.localTarball` seam. The seam is dev-only by design; not a Cloud surface.
- [`docs/plans/260521_pre-publish-local-mcp-test/PLAN.md`](../plans/260521_pre-publish-local-mcp-test/PLAN.md) — design rationale (4-reviewer convergence, failure-mode matrix, decision log).

## Why this exists

[MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) Phase D step 19 already runs the candidate through `npx -y <tarball>` over MCP stdio. That catches publish-shape issues (broken `bin`, missing files in `files: []`, broken ESM/CJS resolution) but **cannot** exercise:

- Rebel's **catalog routing** (`bundledMcpManager`, `mcpService`, `connectorCatalogResolver`).
- The **chat-UI error surface** (what does the user actually see when a new tool returns a 400?).
- **OAuth-scope mirror drift** between the connector's `oauth.ts` and Rebel's `<connector>AuthService.ts` (a frequent regression class).
- The **spawn flags** `bundledMcpManager` injects (`MCP_LAUNCHED_FROM_REBEL_DESKTOP`, identity env vars, etc.).

Step 19.5 closes that gap by pre-populating the same on-disk slot Rebel uses after a successful `npm install <pkg>@<ver>`, so the candidate spawns under the production `node <managed-install-path>` code path.

**Scope:** desktop only. Cloud surface remains validated by [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) Phase F step 30 post-publish smoke. Cloud-only regressions (e.g., the host-side `microsoftApi` orchestrator misrouting after a scope change) cannot be caught here.

## STOP — same-version fixes need a throwaway version bump (version-collision trap)

The wrapper auto-generates a `REBEL_CATALOG_OVERRIDE` **only when the candidate version differs
from the catalog pin**. If you're fixing a bug **without** bumping the version (e.g. patching
`@mindstone/mcp-server-salesforce@0.1.2` in place), the wrapper prints *"No catalog override
needed (candidate version matches the pinned catalog version)"* and just stages the slot — and
you are now in a trap:

- Your slot and the **published** package share the same version string, so they are
  indistinguishable. A startup reconcile, a connector remove/re-add, or any `ManagedMcpInstallService.install`
  for that spec can silently **overwrite your slot with the published (unfixed) package** — you'll
  swear you're testing your fix while running the old npm code. (Observed 2026-06-12 on a Salesforce
  in-place patch: the live router entry correctly pointed at the slot, the slot had the fix, yet a
  re-add reinstalled published `0.1.2` over it.)

**Fix: give your local build a version that does not exist on npm**, so the only thing that can
satisfy it is your slot — there is nothing to fall back to. Steps (all while dev Rebel is stopped):

```bash
# 1. Bump the connector to an UNPUBLISHED version (package.json + package-lock.json + server.json
#    in lockstep — npm ci inside the wrapper fails on a package.json/lock version mismatch).
#    Use a clean semver with no pre-release suffix (ALLOWED_NPX_PACKAGE_RE rejects -rc.N etc.).
#    e.g. 0.1.2 -> 0.1.3
# 2. Point the catalog at the same unpublished version so a bare `npm run dev` resolves to it
#    (no REBEL_CATALOG_OVERRIDE env var needed on every relaunch):
#      resources/connector-catalog.json  ->  "@mindstone/mcp-server-<name>@0.1.3"
# 3. Stage the slot from source (now version-matches the catalog -> no override file generated):
npx tsx scripts/dev-mcp-managed-install.ts install <name>
# 4. Remove any stale same-named slot for the OLD version, and repoint the live router entry if it
#    still references it (or just let startup reconcile rebuild it from the bumped catalog).
# 5. Launch — bare, single instance:
npm run dev
```

Verify you're on the local build (the version is your tell — it can't be the published package):

```bash
ps aux | grep "[m]cp-server-<name>" | grep -o "<name>@[0-9.]*"   # must show the unpublished version
```

The bump + catalog pin are **throwaway test scaffolding**. Revert them before committing
(`git checkout` the version files + catalog); the real release bumps the version via
`npm run mcp:release` (see [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md)).

> A connector in `ALLOWED_NPX_PACKAGE_RE` (Slack, HubSpot, Salesforce, …) can also be tested via
> the wrapper's auto-generated `REBEL_CATALOG_OVERRIDE` if you keep the same version — but that
> requires the env var on **every** relaunch (invariant 4 below) and is easy to forget. The
> unpublished-version bump above makes bare `npm run dev` correct by construction; prefer it for
> same-version fixes.

## Quick start (one connector)

```bash
cd <rebel>

# 1. (Optional) Tell the wrapper where your mcp-servers clone lives.
#    Default is <repo>/mcp-servers (submodule) when initialized, else ../mcp-servers
#    (legacy sibling) — matches publish-mcp-to-registry.sh.
export MCP_SERVERS_REPO=<mcp-servers>

# 2. STOP dev Rebel first. The wrapper preflights but the failure UX is nicer.
#    (Cmd+Q on macOS / Ctrl+C the `npm run dev` shell.)

# 3. Build, pack, install, AND auto-generate the override file.
npx tsx scripts/dev-mcp-managed-install.ts install hubspot

# When versions differ, the wrapper writes a CatalogSchema-valid override
# to <userData>/mcp/dev-overrides/<connector>.json and prints the exact
# `REBEL_CATALOG_OVERRIDE=... npm run dev` invocation. Just copy-paste it.
#
# The override is the full bundled catalog with:
#  - Your candidate's args swapped in
#  - Connectors that fail the resolver's validateCommandArgs whitelist
#    dropped (Fathom, Gamma, etc. — see "Whitelist drift" below)
#  - Schema-rejected fields sanitized (annotations, maturity: preview, etc.)

# 4. Relaunch dev with the override active (use the exact path the wrapper prints).
REBEL_CATALOG_OVERRIDE='<path printed by wrapper>' npm run dev

# 5. Smoke-test in the chat UI. Invoke at least one tool whose behaviour
#    changed in this version. Check the dev log file for the startup banner:
#    "Dev pre-publish build active for @mindstone/mcp-server-hubspot@0.2.0".
#    See AGENTS.md § Debugging for the log path.

# 6. ALWAYS clean up before `npm publish`. Sentinel + banner is a safety
#    net, not a substitute.
npx tsx scripts/dev-mcp-managed-install.ts uninstall hubspot
```

## Subcommands

### `install <connector> [--source <path>]`

Builds the connector source (`npm ci --ignore-scripts && npm run build && npm pack`), then installs the resulting tarball into `<userData>/mcp/managed-installs/<scope>/<name>@<version>/` via the production-blessed `ManagedMcpInstallService.install({ source: { localTarball } })` API seam.

When the candidate version differs from the catalog pin, the wrapper ALSO auto-generates a `CatalogSchema`-valid override file at `<userData>/mcp/dev-overrides/<connectorId>.json` and prints the exact `REBEL_CATALOG_OVERRIDE=... npm run dev` launch line. The auto-generation:
- Copies the bundled catalog wholesale
- Drops connectors that would fail `validateCommandArgs` (non-whitelisted npx packages or `node`-command connectors the wrapper can't synthesize absolute paths for)
- Swaps the target connector's `mcpConfig.args` to the candidate spec
- Sanitizes schema-rejected metadata (`annotations` on tools, `maturity: preview/deprecated` coerced to `beta`, etc.)

The dropped connectors disappear from the app's connector picker during the smoke session. Acceptable trade-off — the alternative is silent override rejection with the WHOLE catalog falling back to the bundled pin (including your candidate's old version).

- `<connector>` accepts either the full catalog id (`bundled-hubspot`) or the short folder name from `mcp-servers/connectors/` (`hubspot`).
- `--source <path>` overrides the auto-detected source path; useful when iterating on a clone in a non-standard location.
- The install is force-equivalent: each invocation produces a fresh slot, atomically replacing any previous version. The iteration loop (rebuild + reinstall + relaunch) does NOT silently reuse the previous build's bytes when the version string is unchanged.
- The wrapper writes a `.dev-pre-publish-build.json` sentinel beside `.install-meta.json` so Rebel's startup banner can flag the slot. This is the safety net for forgetting `uninstall`.

### `uninstall <connector>`

Removes every managed-install slot whose package name matches the connector AND deletes the auto-generated override file at `<userData>/mcp/dev-overrides/<connectorId>.json`. Idempotent — missing slots/files are silent. Run this **before `npm publish`**; the sentinel + startup banner is a safety net, not a substitute for cleanup. After running, also unset `REBEL_CATALOG_OVERRIDE` in any shell that exported it.

### `list`

Enumerates every managed-install slot. Slots with the dev sentinel are flagged `[DEV BUILD — run uninstall before relying on this!]` and print the source tarball path. Run this if you suspect a stale dev build is shadowing the published package.

## Multi-connector overrides

The auto-generated override targets ONE connector. To smoke-test multiple candidates simultaneously, either:

1. **Run the wrapper for each candidate** — each writes a separate `<userData>/mcp/dev-overrides/<connectorId>.json`. Then hand-merge them: copy connectors from the second file's array into the first file's array, overwriting any duplicates by id. Set `REBEL_CATALOG_OVERRIDE` to the merged file.
2. **Live-edit the auto-generated override** — `install` then open the printed override path in an editor and tweak additional connectors' `mcpConfig.args`. Re-validate by relaunching dev and checking for `Catalog override activated` in the log.

The resolver replaces the whole connectors array (not a partial merge). The auto-generated override already includes every whitelist-passing connector, so multi-connector tests usually only need args edits, not connector adds.

## Whitelist drift

`ALLOWED_NPX_PACKAGE_RE` in [`src/shared/connectorCatalogSchema.ts`](../../src/shared/connectorCatalogSchema.ts) enumerates the `@mindstone/mcp-server-*` packages the resolver accepts in overrides. Currently: `slack | hubspot | google-drive | google-workspace | replit-ssh | microsoft-365 | microsoft-mail | microsoft-calendar | microsoft-files | microsoft-teams | microsoft-sharepoint | imagegen | canary | salesforce | xero`.

Connectors NOT in this whitelist (Fathom, Gamma, Browser-automation, Email-IMAP, Google-Analytics, etc.) can be installed via the wrapper but **cannot appear in an override** — the auto-generator drops them, and they revert to whatever the bundled catalog pins. To test such a connector's candidate inside Rebel, either:

- Bump the connector into the whitelist (single-line PR to `src/shared/connectorCatalogSchema.ts`, requires security review per the comment on the constant), OR
- Skip the in-Rebel smoke entirely for that connector and rely on Phase D step 19 (stdio smoke) + per-package live tests.

Single source of truth: that one regex is consumed both by the resolver (rejects overrides at startup) and by the wrapper (filters before writing). Updating one updates both.

## Iteration loop

After editing the connector source:

```bash
# 1. Rebuild + reinstall (force semantics — overwrites the previous slot
#    AND regenerates the override file with whatever the source version is now).
npx tsx scripts/dev-mcp-managed-install.ts install hubspot

# 2. Restart dev Rebel using the override path printed by the wrapper.
REBEL_CATALOG_OVERRIDE='<path printed by wrapper>' npm run dev

# 3. Retest in the chat UI.
```

Rebel does NOT hot-reload managed-install slots; you must restart dev to pick up the new build.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Dev Rebel appears to be running` | The wrapper detected an `electron` process matching this repo. | Stop dev (Cmd+Q on macOS / Ctrl+C the dev shell). The wrapper races with auto-upgrade otherwise. |
| `Source path does not exist` | `MCP_SERVERS_REPO` not set and the resolved default (`<repo>/mcp-servers` submodule when initialized, else `../mcp-servers` legacy sibling) is missing `connectors/<name>/`. | Initialize the submodule (`git submodule update --init mcp-servers`), or set `MCP_SERVERS_REPO=<path>`, or pass `--source <path>`. |
| `Local tarball version mismatch` | The tarball that `npm pack` produced has a different version than the spec the wrapper computed. | Check that the source's `package.json` and `package-lock.json` versions agree. Fix the version-sync invariant (see [MCP_OSS_PACKAGE_MANUAL_UPDATE § Intent](MCP_OSS_PACKAGE_MANUAL_UPDATE.md#intent)). |
| Override rejected at startup; banner says `Catalog override rejected: <reason>` | The override JSON failed `CatalogSchema` validation or strict command/args validation. | The auto-generated override should not hit this. If it does, it means the bundled catalog gained a new schema-incompatible field the wrapper's sanitizer doesn't know about — file an issue and check `sanitizeForCatalogSchema` in the wrapper. The schema lives in [`src/shared/connectorCatalogSchema.ts`](../../src/shared/connectorCatalogSchema.ts). |
| `After filter, target connector "<id>" not present in override` | Your target connector's npx package is not in `ALLOWED_NPX_PACKAGE_RE`. | See "Whitelist drift" above. Either widen the regex (security-reviewed PR) or rely on Phase D step 19 stdio smoke instead. |
| Tool calls behave like the OLD version | `REBEL_CATALOG_OVERRIDE` not set on this relaunch (or set to a different file). | Verify with `echo $REBEL_CATALOG_OVERRIDE` in the dev shell BEFORE launching. `reconcileNpxPackageVersions` reverts unsigned overrides on every startup. |
| `list` shows `[DEV BUILD]` for a connector you don't recognise | A previous pre-publish test left a sentinel. | Run `npx tsx scripts/dev-mcp-managed-install.ts uninstall <connector>` to clean up. |
| Auto-upgrade reinstalls your slot from the registry at startup | The wrapper-installed metadata was corrupted (sentinel survived, `.install-meta.json` didn't). | Run `uninstall`, then `install` again. The atomic-replace path in the service makes this rare; if it happens repeatedly, file an issue. |

## Hard invariants

These four rules are non-negotiable. The wrapper enforces (1) where it can; (2)-(4) are the engineer's responsibility.

1. **Stop dev Rebel BEFORE running `install`.** Wrapper preflights with `pgrep` on macOS/Linux; Windows is best-effort warning only. Running the wrapper while dev is up races with the in-flight auto-upgrade scan.

2. **This workflow validates DESKTOP ONLY.** Cloud parity remains validated by [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) Phase F step 30 post-publish. Do not assume a green pre-publish smoke means cloud is safe.

3. **ALWAYS run `uninstall` after the smoke test passes, before `npm publish`.** The sentinel + startup banner is a safety net for forgetting, NOT a substitute. A forgotten slot keeps the engineer running against stale local code for days while shipping fixes against a phantom repro.

4. **`REBEL_CATALOG_OVERRIDE` must be present on EVERY relaunch.** `reconcileNpxPackageVersions` reverts to the bundled catalog on startup otherwise. Set it in the same shell as `npm run dev`, or export it from your dotfiles for the duration of the test. The wrapper prints the exact path on every install so you don't have to remember it.

5. **The auto-generated override hides ~60 connectors.** Anything not in `ALLOWED_NPX_PACKAGE_RE` (Fathom, Gamma, browser-automation, OAuth-direct connectors, etc.) disappears from the connector picker during the smoke session. They reappear as soon as you unset `REBEL_CATALOG_OVERRIDE`. Plan smoke tests accordingly — don't try to verify a workflow that also uses Fathom in the same session.

## Scope-mirror reminder

When a publish changes OAuth scopes for a `bundledConfig.authApi`-routed connector (HubSpot, Google Workspace, Slack, Microsoft 365 cohort), the scope set also lives in `src/main/services/<connector>AuthService.ts`. Pre-publish testing exercises ONLY the connector's view; the host-side mirror has to be updated in the working tree separately (Phase G of the publish runbook covers this). If your smoke test fails with `SCOPE_MISSING` errors after a known-good scope change in the connector, the mirror needs re-applying.

## Dev vs stable userdata caveat

Rebel intentionally shares its userData directory across dev / beta / stable installs (see [`src/main/startup/ensureAppIdentity.ts`](../../src/main/startup/ensureAppIdentity.ts) — all variants resolve to `<appData>/mindstone-rebel/`). This means a dev pre-publish slot is visible to your installed stable Rebel too. If you happen to launch stable Rebel after running `install` and before `uninstall`, stable will spawn the dev candidate. The startup banner fires equally in stable, so you'll see the warning — but it's a real risk if you ignore the banner.

The escape hatch: pass `--user-data-dir <path>` to dev Rebel to use an isolated profile. Useful for keeping pre-publish experiments fully off your stable install.

## Limits and follow-ups

- **Production builds are blocked by SHA256+ALLOW_PROD.** `REBEL_CATALOG_OVERRIDE` in a packaged build requires `REBEL_CATALOG_OVERRIDE_ALLOW_PROD=1 REBEL_CATALOG_OVERRIDE_SHA256=<hex>` for security; the dev workflow bypasses this because `app.isPackaged === false`. Don't try to use this script against a production install.
- **Bundled-npm vs system-npm.** The wrapper passes `npmPath: 'npm'` so it uses your shell's `npm`, not the Rebel-bundled copy. Production install does use the bundled copy (per `resolveBundledNpmRunner` in the install service). Differences in npm version can hide flag-incompatibility bugs; rare but possible.
- **No verdaccio.** A future enhancement could close the residual gap (full `npm install @scope/pkg@version` registry-fetch path). Step 19 (stdio smoke via `npx -y <tarball>`) already covers most of that; not currently blocking.
- **No pre-release versions.** `ALLOWED_NPX_PACKAGE_RE` in [`src/shared/connectorCatalogSchema.ts`](../../src/shared/connectorCatalogSchema.ts) rejects pre-release suffixes (`0.2.0-rc.1`). If you need to test a pre-release-versioned candidate, bump to the final version locally for the smoke test, then revert in your working tree before opening the PR.
