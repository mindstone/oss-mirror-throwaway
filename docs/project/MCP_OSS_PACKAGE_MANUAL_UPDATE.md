---
description: "Manual runbook for OSS connector first-publish/bootstrap (and genuine emergencies) — code change → mcp-servers PR → npm publish handoff → resources/connector-catalog.json version bump. Normal version bumps are NOT this doc: they go through npm run mcp:release (MCP_OSS_RELEASE_AGENT_DRIVEN)."
last_updated: "2026-06-11"
---

# OSS MCP Package Manual Update Process

> **STOP — is this really a manual release?** Since 2026-06-11 this runbook is for **first-publish/bootstrap only** (a brand-new connector's 0.0.1 + Trusted Publishing setup), plus genuine emergencies where the script path is unavailable. **Normal updates to an existing connector go through `npm run mcp:release <name>`** — see [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md), including its landing rule: *never bundle a version bump into a PR*. A required mcp-servers CI guard (as of its version-bump-guard change, paired with the 2026-06-11 landing rule) fails any PR that changes an existing connector's `package.json` version, so the PR-with-bump recipe below structurally cannot land for existing connectors. If an emergency forces a manual bump onto `main`, reconcile afterwards with `npm run mcp:release -- --reconcile <name>`.

The manual sequence for **first-publish/bootstrap** of a `@mindstone/mcp-server-<name>` connector (plus genuine emergencies where `mcp:release` is unavailable) — from local code edit through to a catalog version bump that propagates to every Rebel user on next launch.

This doc is the **manual** counterpart to [MCP_BUNDLED_TO_OSS_MIGRATION](MCP_BUNDLED_TO_OSS_MIGRATION.md) (which covers the **first** publish). Legitimate uses:

- First-publish bootstrap: a package that still needs its 0.0.1 manual publish and Trusted Publishing setup (those steps are human-only).
- A package that has not yet had Trusted Publishing enabled at npmjs.com.
- A genuine emergency where `mcp:release` is unavailable — document why, and reconcile afterwards.

## See Also

- [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) — How to **detect** drift between the catalog and npm `latest`. Run that audit to discover what needs updating; ship normal updates via `npm run mcp:release` ([MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md)) — this doc applies only to bootstrap/emergency cases.
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) — How a catalog version bump reaches every user on next launch (`reconcileNpxPackageVersions()`). **A catalog pin is a production deployment with no soft launch and no kill switch.**
- [MCP_BUNDLED_TO_OSS_MIGRATION](MCP_BUNDLED_TO_OSS_MIGRATION.md) — First-time migration of a bundled connector to OSS (use that doc for the initial 0.1.0 publish; subsequent bumps go through `npm run mcp:release`).
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) — **Mandatory pre-publish security review** for behaviour-changing publishes. Hard gate.
- [MCP_RELEASE_SECURITY_REVIEW_TEMPLATE](../../docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md) — machine-readable review block required by the agent-driven release script.
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — SDK patterns, request-timeout pattern, registry submission, version-sync invariant.
- `mindstone/mcp-servers` repo: [`AGENTS.md`](https://github.com/mindstone/mcp-servers/blob/main/AGENTS.md), [`CONTRIBUTING.md`](https://github.com/mindstone/mcp-servers/blob/main/CONTRIBUTING.md), [`docs/PUBLISH_APPROVAL_PROCESS.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/PUBLISH_APPROVAL_PROCESS.md), [`docs/EMERGENCY_REVOKE.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/EMERGENCY_REVOKE.md) — repo-side rules; read these for the version-sync invariant, CI gates, and the WebAuthn publish flow.
- [`scripts/test-oss-connectors.ts`](../../scripts/test-oss-connectors.ts) — catalog-driven runner that exercises the **currently-pinned** version against real APIs. Used as a regression check; see Phase D for the candidate-version smoke procedure.
- [docs/plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md](../plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md) — deferred-work roadmap + improvement ideas for the OSS processes, including the SuperMCP/mcp-servers items (§5)
- [mcp-servers/docs/plans/260609_catalogue_drift_prevention.md](../../mcp-servers/docs/plans/260609_catalogue_drift_prevention.md) — root-cause analysis of the recurring mcp-servers generated-artifact drift (red main / catalogue / STATUS.json)

> **Conventions used below.** Throughout this doc, `<mcp-servers>` is your local clone of `github.com/mindstone/mcp-servers`, and `<rebel>` is your local clone of `rebel-app-1`. Both clones live wherever you keep your repos — the runbook only assumes you can `cd` to each. Replace these placeholders with your real paths once.

---

## Intent

Three non-negotiables drive this process:

1. **A catalog pin is a production deployment to every Rebel user on their next app launch.** Startup migration (`reconcileNpxPackageVersions()`) rewrites every user's pinned version to whatever the catalog says. There is no soft launch and no kill switch short of shipping a new app build. § 13 (security review) and Phase D (live verification) are the only chokepoints for behaviour-changing publishes.
2. **Version-sync is an invariant, not a checklist.** `package.json` (1 field), `package-lock.json` (2 fields), and `server.json` (2 fields) must all carry the same version on the same commit. **Three of those five are CI-enforced; the two lockfile fields are the human's responsibility** (`mcp-servers/docs/PUBLISH_APPROVAL_PROCESS.md` is explicit about this).
3. **One connector per PR.** Cross-connector harmonisation is a separate change. Bumping multiple connectors in the same PR makes review, rollback, and security-review attribution ambiguous.

---

## Roles

| Role | Who | What they do |
|---|---|---|
| **Contributor** | You, in most cases — anyone landing a connector change | Phases A → E (PR + reviews + tracking issue) and Phase G (Rebel catalog bump after publish lands). |
| **Reviewer** | A second engineer, not the PR author | Phase E — code-reviews the PR and leaves the `LGTM — approve publish` comment on the tracking issue. |
| **Wave-lead** | The single named maintainer with the `mindstone-engineering` npm session and the enrolled WebAuthn hardware key | Phase F (the actual `npm publish`). Who currently holds this role is recorded in the active wave's tracking issue in [`mcp-servers/docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md). **You are not the wave-lead unless you've been told you are.** |

The Contributor / Wave-lead split is load-bearing for the supply-chain protection (one shared publisher account, one hardware key, one accountable human per release). If you're a colleague making your first MCP change, you're a Contributor — you do not need an `@mindstone` npm org seat, a hardware key, or a personal publish credential. You hand off to the wave-lead at Phase F.

---

## Phase 0 — First-time contributor setup (one-off per machine)

Skip this phase if you've already contributed an MCP update from this machine. **Read it end-to-end before your first contribution** — some items (GitHub access, 1Password vault access) involve other humans and cannot be sorted out mid-runbook.

### 0.1. Clone both repos

```bash
git clone https://github.com/mindstone/mcp-servers.git
# (`<mcp-servers>` in this doc means whatever path you cloned to.)
# `<rebel>` is your existing rebel-app-1 clone.
```

### 0.2. Install Node, npm ≥ 11.10, and the publisher CLI

- **Node**: 20 or 22 (matches the mcp-servers CI matrix). `node --version`.
- **npm**: 11.10 or newer. The mcp-servers repo's `.npmrc` uses `min-release-age=7`, which silently no-ops on older npm and starts gating installs on newer npm. `npm --version`. If you're on an older `npm`, run `npm install -g npm@latest`.
- **`mcp-publisher`**: CLI used to validate the registry manifest in Phase B and to publish to the registry in Phase F.
  - macOS: `brew install mcp-publisher`
  - Linux: download the SHA-pinned binary from https://github.com/modelcontextprotocol/registry/releases (CI uses `v1.7.7` with SHA-256 verification; match that pin).
  - Windows: download the same binary, or run inside WSL.
  - Verify: `mcp-publisher --version` (expect `v1.7.7` to match CI).
  - **First-time auth, once per shell session:** `mcp-publisher login github` (device-flow; visit the URL it prints, enter the code, approve). The `github-oidc` variant only works inside a GitHub Actions runner — do not use it locally.

### 0.3. Confirm GitHub access

You should be able to:

- View and clone `mindstone/mcp-servers` (private repo).
- Open issues and PRs in both `mindstone/mcp-servers` and `mindstone/rebel-app`.
- (Optional but helpful) `gh auth status` showing you're logged into the GitHub CLI as the same account.

If any of those fail, ask the wave-lead to add you to the right GitHub team before continuing.

### 0.4. Personal npm account is optional

As a Contributor you **do not need** a personal npm account, an `@mindstone` org seat, a hardware security key, or an `npm login` session. The wave-lead handles the actual `npm publish` from a single shared account. If you want one for general npm use, that's fine; just don't bind anything in this workflow to it.

### 0.5. Populate `NPM_TOKEN` in `<mcp-servers>/.env.local`

Local mcp-servers tooling reads `NPM_TOKEN` from a gitignored `.env.local` file at the **repo root** (equivalent path to `<rebel>/.env.local` — same convention, different repo). The token is a low-privilege registry credential. **It is not the publish credential** — publishing goes through the wave-lead's WebAuthn 2FA.

> **TODO for the team**: name the local script(s) that consume `<mcp-servers>/.env.local`'s `NPM_TOKEN` and link them here, so a Contributor can verify the dependency rather than take it on faith.

Run this snippet to create the file with a placeholder if it doesn't exist (works in bash and zsh; replace `<mcp-servers>` with your actual path first):

```bash
ENV_FILE="<mcp-servers>/.env.local"   # e.g. ~/development/mcp-servers/.env.local

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# gitignored — never commit this file.
# NPM_TOKEN below is a low-privilege registry credential used by local
# mcp-servers tooling. Get the real value from 1Password:
#   vault: Engineering shared / Mindstone OSS
#   item:  search "NPM mindstone open source"
# Replace the placeholder string with the real token from 1Password.
NPM_TOKEN=REPLACE_ME_WITH_TOKEN_FROM_1PASSWORD
EOF
  printf '%s\n' \
    "Created $ENV_FILE with a placeholder." \
    "Next: open 1Password, search 'NPM mindstone open source' (Engineering" \
    "shared / Mindstone OSS vault), copy the token, and replace the line" \
    "starting with NPM_TOKEN= in $ENV_FILE."
elif ! grep -qE '^NPM_TOKEN=[^[:space:]]' "$ENV_FILE"; then
  # File exists but no non-empty NPM_TOKEN line; append a placeholder.
  printf '%s\n' \
    "" \
    "# gitignored — never commit this file." \
    "# NPM_TOKEN is required by local mcp-servers tooling. Get the real" \
    "# value from 1Password: search 'NPM mindstone open source'." \
    "NPM_TOKEN=REPLACE_ME_WITH_TOKEN_FROM_1PASSWORD" \
    >> "$ENV_FILE"
  echo "Appended NPM_TOKEN placeholder to $ENV_FILE. Replace with the real"
  echo "value from 1Password (search 'NPM mindstone open source')."
else
  echo "$ENV_FILE already has a populated NPM_TOKEN — no change."
fi
```

After running the snippet, open `<mcp-servers>/.env.local` in your editor and replace `REPLACE_ME_WITH_TOKEN_FROM_1PASSWORD` with the real token. If you can't access the **Engineering shared / Mindstone OSS** 1Password vault, ask the wave-lead to grant access or to share the token over a one-shot secure channel.

**If you don't use 1Password (CLI or web)**, the wave-lead is the fallback — ping them in your team chat with "Need NPM_TOKEN for mcp-servers tooling, no 1Password access" and they'll arrange a handoff.

### 0.6. Smoke check

All of these must succeed before Phase A:

```bash
node --version                                        # >= 20
npm --version                                         # >= 11.10
mcp-publisher --version                               # v1.7.7 (matches CI)
ls <mcp-servers> >/dev/null && ls <rebel> >/dev/null  # both clones reachable
test -f <mcp-servers>/.env.local \
  && grep -qE '^NPM_TOKEN=[^[:space:]]' <mcp-servers>/.env.local \
  && ! grep -q 'REPLACE_ME_WITH_TOKEN_FROM_1PASSWORD' <mcp-servers>/.env.local \
  && echo "NPM_TOKEN populated"
```

If anything fails, fix it before moving on.

---

## Phase A — Pre-flight (every contribution)

1. **Decide the change class.** Doc-only / README-only / pure-metadata updates skip § 13 (security review, Phase C) and the candidate live-smoke (Phase D step 19). Anything that touches `src/`, `test/`, dependency versions, auth handling, request shape, response shape, error handling, or tool annotations is **behaviour-changing** and pulls in the full process. **When in doubt, classify as behaviour-changing** — the cost of a redundant security review is one engineer's day; the cost of a skipped one is every Rebel user.
2. **Working tree state — `<mcp-servers>` must be clean; `<rebel>` may be dirty.**
   ```bash
   cd <mcp-servers> && git status --porcelain     # MUST be empty
   cd <rebel>      && git status --porcelain     # may show concurrent work
   ```
   - **`<mcp-servers>` clean is non-negotiable.** Every PR is one connector and the policy in `AGENTS.md` is one logical change per PR; an unclean tree here means another change is in flight, finish it first or coordinate with the other author.
   - **`<rebel>` dirty is fine** — Rebel actively supports concurrent feature work. You'll only be touching `resources/connector-catalog.json`, a small number of `bundledMcpManager.ts` / `bundledMcpCloudRegistration.ts` lines, and a handful of test fixtures in Phase G. Before staging the catalog bump, confirm those specific files don't appear in `git status` for another agent's WIP. If they do, follow the multi-agent guard in [AGENTS.md § Git & Change Management](../../AGENTS.md) — coordinate with the other author rather than autostashing or capturing their work.
3. **Refresh `main` in `<mcp-servers>`** (the OSS repo runs everything off `main`, not `dev` like Rebel):
   ```bash
   cd <mcp-servers>
   git checkout main && git pull --ff-only
   git checkout -b <type>/<connector>-<short-summary>
   ```
4. **Spot-check `NPM_TOKEN` is populated** (per Phase 0.5):
   ```bash
   test -f <mcp-servers>/.env.local \
     && grep -qE '^NPM_TOKEN=[^[:space:]]' <mcp-servers>/.env.local \
     && ! grep -q 'REPLACE_ME_WITH_TOKEN_FROM_1PASSWORD' <mcp-servers>/.env.local \
     && echo "NPM_TOKEN populated" || echo "MISSING — re-run Phase 0 step 0.5"
   ```
5. **Identify the exact connector directory.** All work scopes to `connectors/<name>/`. Do not edit `connectors/_template/` and do not touch sibling connectors.

---

## Phase B — Make the change in `mcp-servers`

Single connector, single coherent change.

6. **Edit code / docs / dependencies inside `connectors/<name>/`** following the patterns in existing connectors. TypeScript strict mode; Zod for every input and external response; `@modelcontextprotocol/sdk` only — no parallel protocol layer.
7. **Add or update tests under `connectors/<name>/test/`.** Every new tool ships with smoke + happy-path + error tests. For request-shape changes, update the request-manifest fixture.
8. **Bump the version in lockstep — five fields, all in this PR:**
   - `connectors/<name>/package.json` → `version` (1 field) — **CI-enforced** by `.github/workflows/server-json-check.yml`
   - `connectors/<name>/package-lock.json` → top-level `version` **and** `packages[""].version` (2 fields) — **human-verified, not CI-enforced**
   - `connectors/<name>/server.json` → top-level `version` **and** `packages[0].version` (2 fields) — **CI-enforced** by `server-json-check.yml`

   The lockfile is the silent failure path: CI green is necessary but not sufficient. After bumping, eyeball the lockfile yourself.
9. **Update `connectors/<name>/CHANGELOG.md`:**
   - Promote `## [Unreleased]` to `## [<new-version>] - YYYY-MM-DD`.
   - Re-insert an empty `## [Unreleased]` block above it.
   - Use only standard headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
   - The `changelog-check.yml` workflow fails the PR if a `## [<new-version>] - <date>` header is not introduced in this PR (carrying it from `main` does not count).
10. **If behaviour changed:** update `connectors/<name>/README.md` in the same PR.

### Local validation

11. From inside `connectors/<name>/`, run the same gates CI will run, in this order:
    ```bash
    npm ci --ignore-scripts
    npm audit --audit-level=high --omit=dev   # 0 critical / 0 high
    npm run build
    npm test
    npm pack --dry-run --ignore-scripts        # then scan output
    mcp-publisher validate server.json         # registry manifest gate
    ```
    The pack scan must show no `.map`, no `.test.` / `__tests__/`, no nested `.tgz`, no `.env*`, no `.npmrc`, no raw `.ts` source. **CI today only checks `.map` and test files** — the full forbidden-file scan (env files, npmrc leakage, nested tarballs, raw TS) is a human responsibility, copied from `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` § "G6 procedure" in the mcp-servers repo. Run it locally even when CI is green.

### Open the PR

12. Conventional Commits format with the connector name as scope:
    ```
    <type>(<connector>): <Summary sentence 1. Summary sentence 2.>

    <bullet points or detail>
    ```
    Examples: `fix(zendesk): ...`, `feat(slack): ...`, `chore(release): bump zendesk to 0.3.3`. Do not name AI tools or models in commit messages, PR titles, PR bodies, branch names, or `Co-authored-by:` lines.
13. Open the PR against `main`. Branch protection eventually requires CODEOWNERS approval (`@mindstone/oss-maintainers`); until the team is large enough for the formal `>=2` rule, an out-of-band acknowledgement counts per [`PUBLISH_APPROVAL_PROCESS.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/PUBLISH_APPROVAL_PROCESS.md). CI must pass:
    - `build-and-test` (matrix: connector × Node 20/22) — build, audit, test, pack-scan for `.map` / test files
    - `discover-connectors` + `status-check` (STATUS.json drift per connector)
    - `catalogue-check` (committed `docs/catalogue/` matches generator)
    - `server-json-check.yml` (3-field version sync + `mcpName` ↔ `server.json.name`)
    - `changelog-check.yml` (new version header introduced this PR)

---

## Phase C — Pre-publish security review (behaviour-changing only)

14. **Skip this phase** for doc-only / README-only / pure-metadata publishes. The PR description must explicitly state "doc-only, no § 13 review required" with a link to the upstream commits proving it.
15. **For behaviour-changing publishes**, run the [§ 13 mandatory pre-publish security review](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review):
    - AI-only (§ 13.2): agent-authored security review (`lens-security` or equivalent) + **mandatory cross-family adversarial pass** (different model family; model / session / confidence / verdict recorded in the artifact; verdict `UPHELD` or `UPHELD-WITH-ADDENDA`) + `Release-Authorized-By` recorded in the Release Gate block (an authorization act, not a review — there is no human reviewer stage).
    - Write the report to `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md` in the **rebel-app** repo (the report is referenced from the catalog bump commit in Phase G, not the mcp-servers PR). Use [MCP_RELEASE_SECURITY_REVIEW_TEMPLATE](../../docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md) so the same artifact can satisfy the agent-driven release gate later.
    - All CRITICAL and HIGH findings either resolved or explicitly accepted with a named risk owner.
    - **If post-review the PR gains new commits**, rerun (or explicitly amend) the security review — the review and its Release Gate authorization must cover the actually-shipped tree, not a stale snapshot.

---

## Phase D — Pre-publish live verification (behaviour-changing only)

> **Important: the two probes in this phase exercise different versions.** Step 17 ("regression probe") spawns the **currently-published** version from npm, because `scripts/test-oss-connectors.ts` reads `resources/connector-catalog.json` and the catalog still points at the old pin until Phase G. Step 19 ("candidate smoke") exercises the **packed tarball you are about to publish**. Both matter; neither substitutes for the other.

16. **Skip this phase** for doc-only publishes.
17. **Regression probe (current published version).** Confirms the version currently in production still works against the real API; flags an upstream-side regression that would otherwise be blamed on your change.
    First-time set-up of the credentials file (one-off):
    ```bash
    cd <rebel>
    npx tsx scripts/test-oss-connectors.ts --generate-env-example
    cp .env.oss-test.example .env.oss-test    # gitignored; populate with creds
    ```
    The `.env.oss-test` file lives at `<rebel>/.env.oss-test` (not the same as `<rebel>/.env.local`). Get any test-account credentials you don't have from 1Password (search for the connector name + "test account", e.g. "Slack test account"). If the connector has **no** test account and no one on the team has live credentials, note this in the tracking issue (Phase E) — the regression probe is skipped and Phase D rests entirely on step 19.

    Run for the connector being published:
    ```bash
    mkdir -p reports
    npm run test:oss-connectors -- \
      --env-file .env.oss-test \
      --connector <connector-id> \
      --json reports/live-probe-<connector>-currentversion.json
    ```
    Exit 0 is required. The runner skips connectors with missing env vars rather than failing — eyeball the output to make sure the connector actually ran (not "SKIPPED: missing OSS_TEST_..."). Attach the JSON to the publish-tracking issue created in Phase E.
18. **For connectors with a per-package `test/live.test.ts`** (Slack, write-tool-bearing connectors), run that suite from the **packed tarball you're about to publish** — `npm pack` first, then exercise the extracted entry point. See [MCP_BUNDLED_TO_OSS_MIGRATION § C5.2](MCP_BUNDLED_TO_OSS_MIGRATION.md#c52-per-package-live-test-richer-coverage). This is the strongest pre-publish gate that exists today.
19. **Candidate-version smoke (manual, ~5 minutes, best-effort for connectors without a `test/live.test.ts`).** Run the packed tarball through `npx` and call at least one read-only tool over MCP stdio. Catches publish-side breakage that doesn't show up in `npm test`: missing files in `files: []`, broken `bin`, tsconfig include drift, ESM/CJS resolution surprises.
    ```bash
    cd <mcp-servers>/connectors/<name>
    npm pack --ignore-scripts                                   # produces <pkg>-<ver>.tgz
    TARBALL="$(pwd)/$(ls *.tgz | head -1)"                       # full path
    TMP="$(mktemp -d)" && cd "$TMP"
    # Spawn the candidate via npx and verify it lists tools:
    cat <<JSON | npx -y "$TARBALL"
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}
    {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
    JSON
    cd <mcp-servers>/connectors/<name> && rm -- *.tgz
    ```
    A passing run prints two JSON responses — `initialize` ack plus a non-empty `tools` list. If `npx` 404s, the tarball is malformed (re-pack). If `tools/list` is empty, the connector registered no tools (broken `bin` or `dist/`). Record outcome in the tracking issue.

19.5. **In-Rebel candidate smoke (strongly recommended for behaviour-changing publishes; desktop only).** Step 19's stdio smoke proves the published tarball can spawn and list tools, but cannot exercise Rebel's catalog routing, error UX in the chat UI, OAuth-scope mirror drift between mcp-servers and `<connector>AuthService.ts`, or the spawn flags that `bundledMcpManager` injects. Step 19.5 fills that gap by pre-populating the same managed-install slot Rebel uses after a successful `npm install <pkg>@<ver>` — so the candidate runs under the production spawn code path.

    **Cloud parity:** this workflow validates **desktop only**. Cloud surface remains validated by Phase F step 30 post-publish smoke. Cloud-only regressions cannot be caught here.

    **Stop dev Rebel first.** The wrapper races with the in-flight auto-upgrade scan otherwise; it preflights for a running dev process and refuses with a hint.

    ```bash
    cd <rebel>
    # Optional: tell the wrapper where your mcp-servers clone lives.
    # Default is <repo>/mcp-servers (submodule) when initialized, else ../mcp-servers
    # (legacy sibling) — matching publish-mcp-to-registry.sh.
    export MCP_SERVERS_REPO=<mcp-servers>

    npx tsx scripts/dev-mcp-managed-install.ts install <connector>
    # The wrapper builds + packs + installs into the managed slot, then
    # prints either "no catalog override needed" or a JSON stub for
    # REBEL_CATALOG_OVERRIDE — when your candidate version differs from
    # the currently-pinned catalog version.

    # Save that JSON to a file, then relaunch dev with the override active.
    # Without it, reconcileNpxPackageVersions reverts your slot at startup.
    REBEL_CATALOG_OVERRIDE=/tmp/rebel-catalog-override.json npm run dev
    ```

    Smoke-test in the chat UI: invoke at least one tool whose behaviour
    changed in this version. Check the log file for a `Dev pre-publish
    build active for <pkg>` banner at startup (sanity gate that the slot
    is actually being used).

    **When done, ALWAYS run uninstall before `npm publish`** — the sentinel
    + startup banner is a safety net, NOT a substitute:

    ```bash
    npx tsx scripts/dev-mcp-managed-install.ts uninstall <connector>
    ```

    Forgetting this leaves a phantom local build shadowing the published
    package; you'll spend hours debugging fixes against the wrong code.

    See [MCP_DEV_LOCAL_OVERRIDE](MCP_DEV_LOCAL_OVERRIDE.md) for the full
    runbook, troubleshooting, and multi-connector overrides.

---

## Phase E — Approval, merge, and hand-off (Contributor + Reviewer)

20. **Open (or comment on) a tracking issue** in `mindstone/mcp-servers` titled `Publish approval: <connector> v<X.Y.Z>`. Body includes every item from [`PUBLISH_APPROVAL_PROCESS.md` § Pre-publish checklist](https://github.com/mindstone/mcp-servers/blob/main/docs/PUBLISH_APPROVAL_PROCESS.md):
    - PR link
    - Change class (doc-only or behaviour-changing) + one-line justification
    - Source-level security review (Phase C) — link to report or "N/A doc-only"
    - Phase D step 17 regression-probe JSON (attached) or "no test account exists"
    - Phase D step 18 per-package live test results, if applicable
    - Phase D step 19 candidate-smoke output (attached or pasted)
    - Tarball clean (`npm pack --dry-run --ignore-scripts` log, with forbidden-file scan results)
    - `npm audit --omit=dev` 0 critical / 0 high; remaining moderate findings each have a named risk owner per source policy
    - CHANGELOG entry honest and present
    - Version sync across the five fields (3 CI-enforced + 2 lockfile fields)
    - Package-name binding intact (`package.json.name` is `@mindstone/mcp-server-<connector>`)
    - **Publisher set documented**: `npm view @mindstone/mcp-server-<connector> maintainers` shows the expected maintainers + at least one backup. (Wave-lead runs this in Phase F, but flag if you know it's stale.)
    - Named maintainer on call for 7 days (matches `min-release-age=7` cool-down)
    - **Registry publish output**: paste the `publish-mcp-to-registry.sh` log after Phase F step 29 (or `N/A — see follow-up` with a reason).
    - **Assignee: the wave-lead** who will do Phase F — explicit so two maintainers can't race on the same version.
21. **Reviewer**: code-reviews the PR and leaves the `LGTM — approve publish` comment on the **tracking issue** (not the PR). This is the policy artefact that replaces the old `npm-publish` GitHub environment reviewer step. The reviewer must be someone other than the PR author.
22. **Merge the PR** once CI is green and the reviewer's LGTM is on the tracking issue. Either the Contributor or the Wave-lead can hit Merge.
23. **Hand-off**: Contributor pings the wave-lead in the tracking issue: "Ready for publish — PR merged at SHA `<sha>`, candidate is `@mindstone/mcp-server-<name>@<X.Y.Z>`, Phase D artefacts attached above." The wave-lead picks up from Phase F. **Stop here as a Contributor** — do not run `npm publish`.

---

## Phase F — Publish to npm (Wave-lead only)

> **You are the wave-lead only if you've been told you are, hold the `mindstone-engineering` npm session, and have a registered WebAuthn hardware key.** If that's not you, return to Phase E step 23 and wait for the wave-lead.

24. From the wave-lead's machine, refresh `main` and `cd` into the connector:
    ```bash
    cd <mcp-servers>
    git checkout main && git pull --ff-only
    cd connectors/<name>
    ```
25. Sanity check the slice — confirm name and version match the tracking issue:
    ```bash
    node -e "const p=require('./package.json'); console.log(p.name+'@'+p.version)"
    # expect: @mindstone/mcp-server-<name>@<X.Y.Z>
    npm view @mindstone/mcp-server-<name> maintainers   # publisher set documented
    ```
26. Build, test, audit, pack-scan from a clean state — this is intentionally a repeat of the contributor's Phase B step 11, because it runs after the merge against `main`'s current state and gives you confidence that what gets published matches the merged tree, not the contributor's working copy:
    ```bash
    cd <mcp-servers>/connectors/<name> || { echo "wrong dir"; exit 1; }
    rm -rf node_modules dist
    npm ci --ignore-scripts
    npm run build
    npm test
    npm audit --audit-level=high --omit=dev
    npm pack --dry-run --ignore-scripts | tee /tmp/pack-output.txt
    # Run the forbidden-file scan from docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md § G6
    ```
27. **Publish.** This triggers a system-browser WebAuthn challenge requiring physical presence with the registered hardware key:
    ```bash
    npm publish --access=public
    ```
    The browser will pop open and ask you to touch your hardware key. Expect a 30-60 second pause before the prompt on first publish of a session — npm is verifying org membership + 2FA enrolment.

    **Note on `--provenance`.** The repo's `.npmrc` sets `provenance=true`, but provenance attestations require a Trusted Publisher OIDC context, which manual publishes don't have. Modern npm versions hard-error with `EUSAGE` ("Provenance is not supported outside of GitHub Actions or GitLab CI"). If you hit `EUSAGE`, retry with `--provenance=false`:
    ```bash
    npm publish --access=public --provenance=false
    ```
    Consumers verifying via `npm audit signatures` will see npm's own registry signature but no Sigstore attestation — that's the documented trade-off of the manual-publish architecture (see [`PUBLISH_APPROVAL_PROCESS.md` § "What we get and don't get without OIDC provenance"](https://github.com/mindstone/mcp-servers/blob/main/docs/PUBLISH_APPROVAL_PROCESS.md)).

    **Common first-publish failure modes:**
    - `403 Forbidden` → not in the `@mindstone` npm org (you shouldn't see this as wave-lead; if you do, your session has logged out or you're on the wrong account — `npm whoami` and `npm login` again).
    - `EOTP` / `One-Time Password is required` → CLI thinks you have TOTP not WebAuthn. Visit https://www.npmjs.com/settings/~/profile and confirm WebAuthn is enrolled.
    - `EPUBLISHCONFLICT` / version already exists → someone else already published this version, or the bump was forgotten. `npm view @mindstone/mcp-server-<name> versions --json` shows the registry's current state. If a race: stop, comment on the tracking issue, coordinate before re-bumping.
    - Browser challenge never appears → your system default browser is signed into a different npm account than the CLI. Either change default browser or sign the npm web account in the correct browser.
28. **Confirm the publish landed.** Beware: regional CDN replication can lag ~1 minute, so retry if the first call returns the old version:
    ```bash
    npm view @mindstone/mcp-server-<name>@<X.Y.Z> version
    # expect: <X.Y.Z>
    npm view @mindstone/mcp-server-<name> dist-tags.latest
    # expect: <X.Y.Z>
    ```
29. **Publish to the MCP Registry** so the published version is discoverable in the official registry. **Non-optional for behaviour-changing publishes; strongly recommended for doc-only.** Use the wrapper script in `<rebel>`, which preflights (`mcp-publisher validate`, `npm view <pkg>@<ver> mcpName` matches `server.json.name`, version not deprecated), publishes, treats "already exists" idempotently (re-queries the registry to confirm a matching entry), and verifies visibility:
    ```bash
    cd <rebel>
    mcp-publisher login github                          # once per shell session
    ./scripts/publish-mcp-to-registry.sh <connector> --mcp-servers=<mcp-servers>
    ```
    `--mcp-servers` defaults to `<repo>/mcp-servers` when the submodule is initialized (`connectors/` present), else `../mcp-servers` (legacy sibling); pass an explicit path (or set `MCP_SERVERS_REPO`) if your checkout layout differs. Paste the script output into the tracking issue. Do not call `mcp-publisher publish` by hand — the script encodes preflight gates that protect against publishing a deprecated version, a version whose npm tarball is missing `mcpName`, or one whose `server.json` is malformed.
30. **Post-publish candidate smoke from a fresh shell.** Catches CDN-propagation, `bin`, `files`, or `exports` bugs that escape Phase D:
    ```bash
    cd "$(mktemp -d)"
    npm cache clean --force >/dev/null
    npx -y @mindstone/mcp-server-<name>@<X.Y.Z> --help 2>&1 | head -20
    # No --help? Run the JSON-RPC smoke from Phase D step 19 against the published version.
    ```
31. **Update the tracking issue** with: published version, `npm view` output confirming the version, post-publish smoke outcome, "next: handing over to <Contributor handle> for Phase G catalog bump."

> **`min-release-age=7` implication.** The `mcp-servers` `.npmrc` enforces a 7-day cool-down on installs from that repo. Rebel **users** are not affected — they don't typically set `min-release-age` in their personal `~/.npmrc`, and `<rebel>/.npmrc` doesn't set it either, so `npx -y` against the user's npm cache resolves the new version immediately. **Anyone with their own `min-release-age` policy (some enterprises set this for supply-chain hygiene) will be blocked until day 7** — flag this explicitly if you're shipping to such a deployment. The 7-day on-call window for the named maintainer (Phase E checklist) is calibrated to this cool-down: the worst case for a forced recall lands within the window.

### Catching up if the registry drifts

If you suspect step 29 was skipped for a recent publish, or you want to backfill many connectors at once, run the bulk variant from `<rebel>`:

```bash
cd <rebel>
mcp-publisher login github                              # if not already logged in
./scripts/publish-mcp-to-registry-bulk.sh --dry-run --mcp-servers=<mcp-servers>
# review the WOULD-PUB / PASS / SKIP table, then drop --dry-run
./scripts/publish-mcp-to-registry-bulk.sh --mcp-servers=<mcp-servers>
```

The bulk script enumerates every `<mcp-servers>/connectors/*/server.json`, runs the same preflights as the per-connector script, and skips (rather than aborts) on per-connector failure. A `SKIP: mcpName not in npm@<version> (needs no-op bump)` row means the connector's `mcpName` was added to source but never published to npm — cut a no-op patch bump per Phase B and re-run. `--connector=<name>` runs against a single connector if you want to retry one specifically.

---

## Phase G — Bump the Rebel catalog (Contributor)

This is what propagates the new version to every Rebel user on next launch. Wait until Phase F has completed and `npm view @mindstone/mcp-server-<name> dist-tags.latest` returns the new version — otherwise users will hit `404 Not Found` on first install.

32. **Branch off `dev` in `<rebel>` — concurrent feature work is fine, just don't carry it into your branch.** Rebel actively supports concurrent feature work; this runbook only requires that the files you're about to edit aren't being touched by another in-flight branch. **Never use raw `git pull` in `<rebel>`** — `pull.ff=only` is set and you'd skip the submodule + integrity verification. Use the sync helper:
    ```bash
    cd <rebel>
    git status --porcelain                              # see what else is in flight
    # If unrelated WIP exists in files you're about to touch (catalog,
    # bundledMcpManager.ts, bundledMcpCloudRegistration.ts, test fixtures,
    # officePackage.ts), stash or branch it off first per AGENTS.md.
    npx tsx scripts/git-safe-sync.ts --no-push          # safe dev refresh
    git checkout -b <type>/bump-<connector>-<version>
    ```
33. **Update every occurrence in `resources/connector-catalog.json`.** Some packages appear under multiple connector ids (e.g. `@mindstone/mcp-server-email-imap` is referenced by three entries). Enumerate before editing — copy-pasting the literal `<name>` placeholder will not work:
    ```bash
    # Replace <name> with the literal slug, e.g. zendesk
    rg -n -o '@mindstone/mcp-server-zendesk@[0-9][0-9A-Za-z.\-+]*' \
      resources/connector-catalog.json
    ```
    Replace each line with the new pin. **Pin exact semver — no `@latest`, no ranges.** This is non-negotiable per postmortem [`260429_oss_connector_catalog_unpinned_versions`](../../docs-private/postmortems/260429_oss_connector_catalog_unpinned_versions_postmortem.md).
34. **Update every hardcoded fallback in the Rebel source.** The catalog isn't the only place that pins a verbatim version — multiple services carry literal pins as defensive fallbacks when the catalog lookup fails. **Enumerate via `rg` before editing** — the list below is the known set as of this doc's `last_updated`, but new fallbacks accrete:
    ```bash
    rg -n "@mindstone/mcp-server-<name>@" src/ \
      | grep -v __tests__   # tests are handled in step 35
    ```
    Currently-known fallback sites (verified at this doc's `last_updated`; verify with the `rg` command above when bumping — the source moves):
    - **Slack** → `src/main/services/bundledMcpManager.ts` ~line 744 (`buildSlackInstancePayload`, literal in `?? [...]` fallback)
    - **Google Workspace** → `src/main/services/bundledMcpManager.ts` ~line 670 (`buildGoogleWorkspaceInstancePayload`, literal in `?? [...]` fallback)
    - **Microsoft 365 family** (`microsoft-mail`, `microsoft-calendar`, `microsoft-files`, `microsoft-teams`, `microsoft-sharepoint`) → `src/main/services/bundledMcpManager.ts` ~line 59 (`MICROSOFT_REBEL_OSS_DEFS`, ~5 literal `packageSpec` strings, one per Microsoft connector)
    - **HubSpot** → two sites, both must be updated:
        - `src/main/services/bundledMcpCloudRegistration.ts` (~line 406, literal in `args: [...]`)
        - `src/main/services/managedMcpInstallService.ts` (~lines 1631 + 1665, version-aware `includes(...)` checks; usually safe to leave but verify the prefix)
    - **Office** (the `office` connector specifically) → `src/shared/sidecar/officePackage.ts` (and `scripts/check-office-package-version.ts` validates this at `validate:fast` time — it will fail loudly if you miss the bump)

    Update only the entries for the package you're bumping. Missing a fallback ships a catalog that diverges from the defensive path; the divergence only surfaces on user devices when the catalog lookup fails, which is the worst time to discover it.
35. **Update test fixtures.** These assert the catalog/fallback values verbatim and will go red otherwise. Enumerate first; the known minimum is below:
    ```bash
    rg -l "@mindstone/mcp-server-<name>@" src/ \
      | grep -E '__tests__|\.test\.'
    ```
    Known minimum (verify with `rg`):
    - `src/main/services/__tests__/bundledMcpCloudRegistration.test.ts`
    - `src/main/services/__tests__/bundledMcpManager.googleMigration.test.ts`
    - `src/main/services/__tests__/bundledMcpManager.test.ts`
    - `src/main/services/__tests__/connectorCatalogResolver.test.ts`
    - `src/main/services/__tests__/officeSidecarManager.test.ts` (Office only)
    - `src/main/ipc/__tests__/settingsHandlers.test.ts`
    - `src/shared/__tests__/connectorCatalog.test.ts`
36. **Eval snapshots:** if the bump changed the tool surface (new tools, removed tools, schema changes), regenerate the relevant `evals/mcp-twins/<name>-tools.ts` snapshot. README-only and pure-metadata bumps do not require regeneration; note that explicitly in the bump commit.
37. **Validate locally:**
    ```bash
    npm run validate:fast
    # Then run the connector-pinning test files surfaced by the rg in step 35:
    npm test -- --run \
      src/main/services/__tests__/bundledMcpCloudRegistration.test.ts \
      src/main/services/__tests__/bundledMcpManager.googleMigration.test.ts \
      src/main/services/__tests__/bundledMcpManager.test.ts \
      src/main/services/__tests__/connectorCatalogResolver.test.ts \
      src/main/ipc/__tests__/settingsHandlers.test.ts \
      src/shared/__tests__/connectorCatalog.test.ts
      # Plus officeSidecarManager.test.ts if you bumped Office.
    ```
38. **Update changelogs** if the bump has user-facing impact (new tools, fixed bugs users could hit, behaviour changes):
    - `CHANGELOG.md` (internal)
    - `rebel-system/help-for-humans/changelog.md` (user-facing — see [CHANGELOG_UPDATE_PROCESS](CHANGELOG_UPDATE_PROCESS.md))
39. **Commit using the structured format with provenance trailers** (`AI-Workflow` is `direct` only if you didn't use a named workflow — if you used `CHIEF_ENGINEER`, say so):
    ```
    chore(catalog): Bump <connector> to <X.Y.Z>. <One-line why>.

    - @mindstone/mcp-server-<name>: <old> → <X.Y.Z> (<doc-only|behaviour-change>; upstream <sha>)

    Synced fallbacks in <bundledMcpManager.ts | bundledMcpCloudRegistration.ts |
    officePackage.ts> as applicable, and the test fixtures that pin the package
    spec verbatim.

    § 13 security review: <N/A doc-only | docs-private/reports/security-reviews/<file>.md>
    Live-probe results: <reports/live-probe-<connector>-currentversion.json>
    Candidate smoke: <pass | see tracking issue #N>
    Tracking issue: <link>

    AI-Workflow: <direct | chief_engineer | chief_bugfixer>
    AI-Implementer: <model>
    AI-Review-Mode: <light | heavy>
    ```
40. **Push and deploy decision.** Pushing to `dev` is **not** automatic deployment — explicitly ask the user "Would you like to deploy this to beta?" before adding `[deploy-beta]` to the commit message. **Never push without per-turn user authorisation** — see [AGENTS.md § Git & Change Management](../../AGENTS.md). Use `/git-safe-sync-and-push` (or its underlying `npx tsx scripts/git-safe-sync.ts`) — never raw `git push`.

---

## Phase H — Post-publish hygiene

41. **Update [MCP_OSS_CONNECTORS_TESTING_STATUS](MCP_OSS_CONNECTORS_TESTING_STATUS.md)** if the bump moves the connector between status buckets (e.g. validated round increases).
42. **Update the publish tracker** in [`mcp-servers/docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md).
43. **7-day on-call window** for the named maintainer (see Phase E checklist). The on-call watches Sentry for spikes on the bumped connector, monitors GitHub issues filed against it, and is the point of contact for emergency revoke. Maps to `min-release-age=7` so the cool-down provides recall room. If the catalog bump (Phase G) lags the publish by N days, the on-call window starts at publish but the user-facing impact starts at catalog merge — flag this gap in the tracking issue.
44. **If something goes wrong**, see Recovery below.

---

## Recovery — when things go wrong

| Failure | Recovery |
|---|---|
| Phase F step 27 `npm publish` failed mid-way (`5xx` from registry, network drop after upload) | Run `npm view @mindstone/mcp-server-<name> versions --json` to check whether the version actually landed. If it did, skip ahead to step 28. If not, retry `npm publish`. Re-running after a successful upload yields `EPUBLISHCONFLICT` — that's the recovery signal, not a fresh error. |
| Phase F step 27 fails with `EPUBLISHCONFLICT` and you didn't publish it | Another wave-lead beat you to the version (or an earlier failed attempt did land). Stop, do not bump and republish. Confirm via tracking-issue assignee + `npm view ... versions --json`, then coordinate. |
| Catalog-bump PR (Phase G) review finds an issue **after** Phase F published | You cannot unpublish past 72 hours. Two branches: |
| ↳ Cosmetic / doc-only fix | Land the catalog bump with the published pin; file a follow-up patch bump (`<X.Y.Z+1>`) for the cosmetic issue, then bump the catalog again. |
| ↳ Functional regression | Do not land the catalog bump for `<X.Y.Z>`. Run the full process again for `<X.Y.Z+1>` containing the fix, then bump the catalog directly to `<X.Y.Z+1>`, skipping `<X.Y.Z>`. The published `<X.Y.Z>` stays on npm but no Rebel user ever pins it. Consider `npm deprecate` on `<X.Y.Z>` per [`EMERGENCY_REVOKE.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/EMERGENCY_REVOKE.md). |
| Regression found **after** the catalog bump merged to `dev` but before app build ships | Revert the catalog commit: `git revert <sha>` on `dev`, push via `/git-safe-sync-and-push`. Catalog returns to the previous pin; users on next app launch get the old version back. Then run the supersede-then-deprecate flow above. |
| Regression found **after** the app build shipped to users | Two things in parallel: (1) publish a fixed `<X.Y.Z+1>` and bump the catalog (next app build will deliver it on next user launch), (2) `npm deprecate` `<X.Y.Z>` with a message pointing to the fixed version. Users with the bad pin already running don't get fixed until the next app build delivers the catalog update — this is the failure mode the security and live-probe gates exist to prevent. See [`EMERGENCY_REVOKE.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/EMERGENCY_REVOKE.md) for the full decision tree. |
| Live-probe credentials don't exist for the connector | The regression probe (step 17) is skipped; Phase D rests on the candidate smoke (step 19) and any per-package `test/live.test.ts` (step 18). Document the gap in the tracking issue. File a follow-up task to provision a test account. |
| Lockfile drift discovered post-publish | `package.json` and `server.json` were CI-validated, but `package-lock.json` slipped. The published tarball is what it is — lockfile drift in the source repo doesn't affect what was published. Fix on `main` in a follow-up `chore(lockfile)` PR. |
| `publish-mcp-to-registry.sh` fails: `mcpName not in npm@<version>` | The published version predates the `mcpName` addition. Cut a no-op patch bump per Phase B (so the new tarball carries `mcpName`), re-publish to npm (Phase F 24–28), then re-run step 29. |
| `publish-mcp-to-registry.sh` fails post-npm-publish for other reasons | Re-run the script — it's idempotent. If `mcp-publisher publish` errored with "already exists", the script falls back to a registry query to confirm whether the entry actually landed. If it errors with anything else, the script surfaces the stderr; common causes are transient registry 5xx (retry) or login expiry (`mcp-publisher login github` again). |
| Multiple recent versions never published to registry (drift) | Run `./scripts/publish-mcp-to-registry-bulk.sh --dry-run` from `<rebel>` to see what's missing, then drop `--dry-run` to publish them all. See "Catching up if the registry drifts" above. |

---

## Key invariants (do not break)

| Invariant | Source |
|---|---|
| One connector per PR | [`mcp-servers/AGENTS.md` § Scope discipline](https://github.com/mindstone/mcp-servers/blob/main/AGENTS.md) |
| Five-field version sync per bump (3 CI-enforced + 2 lockfile fields the human verifies) | [`mcp-servers/AGENTS.md` § Version-sync invariant](https://github.com/mindstone/mcp-servers/blob/main/AGENTS.md); `server-json-check.yml` |
| `## [<version>] - <date>` introduced in the PR, not carried from `main` | `changelog-check.yml` |
| Pinned exact semver in `resources/connector-catalog.json` (no `@latest`, no ranges) | Postmortem [260429](../../docs-private/postmortems/260429_oss_connector_catalog_unpinned_versions_postmortem.md) |
| `bundledConfig` block preserved through every bump (it is reused even for OSS entries) | Postmortem [260417](../../docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md) |
| Every hardcoded fallback in `bundledMcpManager.ts`, `bundledMcpCloudRegistration.ts`, and `officePackage.ts` updated alongside the catalog | This doc, Phase G step 34 |
| Security review (§ 13) is mandatory for **every** behaviour-changing publish, not just the first | [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) |
| Pre-publish live verification (Phase D) for every behaviour-changing publish — regression probe + candidate smoke + per-package live test if it exists | This doc, Phase D |
| `npm publish` is run **only** by the wave-lead, from the `mindstone-engineering` npm session, behind WebAuthn 2FA on a registered hardware key | [`PUBLISH_APPROVAL_PROCESS.md`](https://github.com/mindstone/mcp-servers/blob/main/docs/PUBLISH_APPROVAL_PROCESS.md); this doc's Roles table |
| Tracking issue with `LGTM — approve publish` from a separate human (not the PR author) | Same |
| Rebel commit on `dev`, not `main`; explicit per-turn push authorisation; via `git-safe-sync.ts` not raw `git push` | [AGENTS.md § Git & Change Management](../../AGENTS.md) |
| `[deploy-beta]` only when user explicitly opts in | [AGENTS.md § Beta deploy opt-in](../../AGENTS.md) |
| `NPM_TOKEN` in `<mcp-servers>/.env.local` is a low-privilege registry credential, NOT a publish token | Phase 0.5; publish auth is exclusively WebAuthn-gated |
| Registry publish completes for every npm publish — wave-lead runs `<rebel>/scripts/publish-mcp-to-registry.sh <connector>` after step 28. Drift correctable via `publish-mcp-to-registry-bulk.sh`. | Phase F step 29; this doc's recovery table |

---

## Specialist droids that automate parts of this

Use the Task tool with these custom droids when the phase fits:

- **`oss-port-worker`** — Originally for first-time ports; also useful when a bump pulls in cohort fixes (request-timeout pattern, recovery-guidance contract, internal-reference stripping).
- **`migration-worker`** — Updates startup migration ordering, reconnect UI flows, and tests when a bump changes auth or response shape.
- **`reviewer-gpt5.5-high`** + **`reviewer-opus4.7-thinking`** — Cross-model review on the version-bump PR (independent perspectives reduce single-model blind spots).

Phase C (security review), Phase D (live verification), and Phase F (publish) are deliberately not delegated to autonomous droids — they are the chokepoints and must be reviewed/executed by a human.
