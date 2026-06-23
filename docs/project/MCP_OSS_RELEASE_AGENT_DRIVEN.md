---
description: "Agent-driven OSS MCP release flow — the ONLY sanctioned path for version bumps/releases of existing @mindstone/mcp-server-* connectors. Single command (npm run mcp:release <connector>) drives a deterministic state machine across mcp-servers + Rebel catalog + submodule pointer with a durable ledger; --reconcile recovers bumps that landed outside the script. Manual runbook is bootstrap/emergency-only."
last_updated: "2026-06-11"
---

# OSS MCP Release — Agent-Driven Flow

The single-command release path for `@mindstone/mcp-server-*` connectors. AI agents (and humans) invoke `npm run mcp:release <connector> -- --bump=patch --description="..."` from the Rebel repo root and a deterministic state machine handles everything: script-driven semver bump across package.json + package-lock.json + server.json + CHANGELOG.md (plus STATUS.json sync and catalogue/install-links regeneration), build, push, npm publish (via Trusted Publishing), CDN propagation, smoke test, registry sync, catalog bump, submodule pointer advance, validate:fast, and final push.

## The landing rule (2026-06-11)

> **Code changes to `mcp-servers/` land code-only — via PR or direct push. Version bumps/releases land ONLY via `npm run mcp:release`. Never bundle a version bump into a PR.**

This is enforced by mcp-servers CI as of its version-bump-guard change (paired with this 2026-06-11 revision): any PR that changes an existing connector's `package.json` version fails the version-bump guard check (see mcp-servers `docs/security/BRANCH_PROTECTION.md` for its branch-protection status; first-adds of brand-new connectors are exempt). This kills "PR merge = surprise npm publish" by construction — even if a bump merges, release.yml's trailer gate refuses to publish it, and the §13 security gate stays anchored in `mcp:release`, the only remaining publish-capable path. If a bump nonetheless reaches mcp-servers `main` outside the script (emergency direct push, historical PR), recover with [`--reconcile`](#reconcile--recovering-a-bump-that-landed-outside-the-script).

The manual flow ([MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md)) is for **first-publish/bootstrap only** (plus genuine emergencies):

- Publishing a brand-new connector (first 0.0.1) and bootstrapping Trusted Publishing — that setup step is human-only.
- A connector that has not yet had Trusted Publishing enabled at npmjs.com.
- A genuine emergency where the script path is unavailable (document why; reconcile afterwards).

## See Also

- [docs/plans/260525_oss_release_automation.md](../plans/260525_oss_release_automation.md) — full design, state machine spec, decisions, risk register
- [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) — the manual runbook (first-publish/bootstrap + genuine emergencies only)
- [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) — drift detection (mostly obsoleted by the agent-driven flow keeping things in sync, but useful for ad-hoc audits of unmigrated packages)
- [MCP_DEV_LOCAL_OVERRIDE](MCP_DEV_LOCAL_OVERRIDE.md) — pre-release local smoke testing inside dev Rebel via the existing managed-install path (Phase D analogue)
- [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) — live Rebel CLI verification against whichever MCP connectors are authenticated in a real Rebel instance
- [MCP_RELEASE_SECURITY_REVIEW_TEMPLATE](../../docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md) — machine-readable security review template consumed by `mcp:release`
- [docs/plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md](../plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md) — deferred-work roadmap + improvement ideas for the OSS processes, including the SuperMCP/mcp-servers items (§5)
- [mcp-servers/docs/plans/260609_catalogue_drift_prevention.md](../../mcp-servers/docs/plans/260609_catalogue_drift_prevention.md) — root-cause analysis of the recurring mcp-servers generated-artifact drift (red main / catalogue / STATUS.json)

## Status

| Date | Status |
|---|---|
| 2026-05-25 | Initial design + synthetic proof connector in progress |
| 2026-05-29 | Synthetic proof release published end-to-end through GitHub Actions, npm Trusted Publishing, and MCP Registry OIDC. The proof connector was removed from the Rebel connector catalog after proving the path. npm Trusted Publishing has now been configured for all existing `@mindstone/mcp-server-*` packages, and the `mcp-servers` workflow publishes any existing connector whose package version is bumped. MCP Registry OIDC authorization is namespace-based; all current connector `server.json` names use `io.github.mindstone/*`, matching the `mindstone/mcp-servers` GitHub org. |
| 2026-06-11 | retell-ai 0.2.3 shipped: first release under the **AI-only §13** policy (agent-authored review + cross-family adversarial pass, no human reviewer stage) and first reconcile-mode-shaped recovery (the bump landed via PR #85 before the landing rule existed; a seeded-ledger `--resume` re-ran all script gates end-to-end — the experience that shaped `--reconcile`). The same run shipped the landing rule, `--reconcile`, the `Release-Gate` trailer stamping + Rebel-side audit, and — via the paired mcp-servers release.yml change — the no-bumps-in-PRs CI guard, the trailer gate, and publish alerting. See `docs/plans/260611_mcp-landing-process/PLAN.md`. |

Use this flow for real connectors only after that connector has completed the one-off package setup below. Until then, use the manual runbook.

## npm Account Model

Normal connector releases should not require individual engineers to log in to npm. Once a package has Trusted Publishing configured, the publish happens from GitHub Actions through OIDC:

- The engineer or agent needs GitHub permissions to land the release commit in `mindstone/mcp-servers` and the catalog/submodule update in Rebel.
- GitHub Actions publishes the package with npm Trusted Publishing from `mindstone/mcp-servers/.github/workflows/release.yml`.
- No `NPM_TOKEN`, shared npm password, or per-release npm 2FA prompt is used for the publish job.

npm accounts are still required for people who administer the packages themselves. Keep those as named personal accounts, not a shared admin login. npm organizations have three member roles: `owner`, `admin`, and `member`; package write access is normally granted through org teams with read/write access to packages. For unscoped or directly owned packages, `npm owner` can add maintainers, but org-scoped packages should be managed through the npm organization and teams.

Recommended Mindstone setup:

1. Keep at least two real people as npm organization owners for account recovery and billing continuity.
2. Put day-to-day package administrators in an npm team with read/write access to `@mindstone/mcp-server-*` packages.
3. Do not require every engineer to have npm package write access; GitHub release permissions are enough for normal releases after Trusted Publishing is configured.
4. Use the npm CLI for repeatable setup where possible:
   ```bash
   npm trust github @mindstone/mcp-server-slack \
     --repo mindstone/mcp-servers \
     --file release.yml \
     --env npm-publish \
     --allow-publish \
     --yes
   ```
5. Verify or replace trust configuration with:
   ```bash
   npm trust list @mindstone/mcp-server-slack --json
   npm trust revoke @mindstone/mcp-server-slack --id <trust-id>
   ```

See npm docs:

- `npm trust`: https://docs.npmjs.com/cli/v11/commands/npm-trust/
- Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- Organization roles: https://docs.npmjs.com/org-roles-and-permissions/
- Package/team access: https://docs.npmjs.com/managing-team-access-to-organization-packages/

## Prerequisites

Per machine:

1. The Rebel repo cloned with submodules initialized:
   ```bash
   git submodule update --init --recursive
   ```
   The `mcp-servers` submodule lives at `<rebel>/mcp-servers/`. The `predev` script also handles this on first `npm run dev`.

2. GitHub CLI authenticated for both `mindstone/mcp-servers` and `mindstone/mindstone-rebel-1`:
   ```bash
   gh auth status
   ```
   You need push access to `mcp-servers/main` and `mindstone-rebel-1/dev`.

3. Standard local toolchain (Node 20+, npm 11+) — same as the manual runbook's Phase 0.

Per connector (one-off, before its first agent-driven release):

4. **Trusted Publishing enabled** for the package. Prefer the npm CLI:
   ```bash
   npm trust github @mindstone/mcp-server-<name> \
     --repo mindstone/mcp-servers \
     --file release.yml \
     --env npm-publish \
     --allow-publish \
     --yes
   ```
   This requires an npm account with package write/admin access and account-level 2FA. It is one-off setup, not a per-release step.

5. **First 0.0.1 manually published** so the package exists. Required because Trusted Publishing on npm only kicks in for v2+ of an existing package.

6. **MCP Registry namespace check passed.** The connector's `server.json.name` must be under the GitHub namespace that the workflow can prove through OIDC. For this repo that means `io.github.mindstone/*`, because the workflow runs in `mindstone/mcp-servers`. No per-package MCP Registry secret is needed for GitHub OIDC.

## When to use this flow

| Scenario | Use this flow? |
|---|---|
| Bumping an existing OSS connector with npm Trusted Publishing, an `io.github.mindstone/*` registry name, and a completed § 13 security review artifact | Yes — this is the **only** sanctioned bump path (see the landing rule above) |
| A version bump already landed on mcp-servers `main` outside the script (emergency direct push, historical PR) | Yes — `npm run mcp:release -- --reconcile <name>` (see Recovery) |
| First-time publish of a brand new connector | No — use manual flow for 0.0.1, agent-driven for 0.0.2+ |
| Emergency rollback / yank | No — use manual `npm deprecate` + catalog revert; rollback subcommand is on the deferred list |

## Invocation

From the Rebel repo root, on the `dev` branch (or a feature branch):

1. **Edit the connector code.** Inside `<rebel>/mcp-servers/connectors/<name>/`, make your changes. The submodule is a real working copy; you can run tests, builds, all the same `mcp-servers` repo workflows as you would in a sibling clone.

2. **Local smoke test** with `dev-mcp-managed-install.ts`. Same as today, just with the submodule path:
   ```bash
   npx tsx scripts/dev-mcp-managed-install.ts install <name>
   npm run dev
   # ... verify the change ...
   npx tsx scripts/dev-mcp-managed-install.ts uninstall <name>
   ```
   See [MCP_DEV_LOCAL_OVERRIDE](MCP_DEV_LOCAL_OVERRIDE.md) for the full local-override workflow.

3. **Confirm the connector has a `## [Unreleased]` section** in its `CHANGELOG.md`. The release script's Stage 1 inserts the new release block under that header per Keep-a-Changelog convention; if the file is missing or the header is absent, Stage 1 fails closed (per `mcp-servers/AGENTS.md`).

4. **Write the security review for every agent-driven connector release.** Even a small patch needs a written artifact because the catalog pin deploys to every Rebel user:
   ```bash
   cp docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md \
     docs-private/reports/security-reviews/<yyMMdd>_<connector>_<toVersion>.md
   # Author the review, run the MANDATORY cross-family adversarial pass,
   # and record release authorization in the Release Gate block.
   ```
   See [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) — the review is **AI-only**: the releasing agent authors it, an adversarial reviewer from a **different model family** reads the diff + source and records its model ID / session ID / confidence / verdict in the artifact, and `Release-Authorized-By` records the authorization (an act distinct from review). The release script verifies the review's `Release Gate` block before proceeding. The default path is `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<toVersion>.md`; pass `--security-review=<path>` if the filename is different.

5. **Invoke the release**:
   ```bash
   npm run mcp:release <name> -- --bump=patch --description="What changed in this release"
   ```
   The `--bump` flag accepts `patch|minor|major` (defaults to `patch` when omitted; explicit value recommended for clarity). The `--description` flag is required and becomes the CHANGELOG entry under the new version block (max 200 chars). `--security-review=<path>` is optional when the review uses the default filename.

   The script will (v2, 9 stages):
   1. **Stage 0** — Verify preconditions (clean tree, valid `--bump`/`--description`, TTY check, required security review).
   2. **Stage 1** — Script-driven semver bump: compute the next version from `--bump`, atomically update `package.json`, regenerate `package-lock.json` via `npm install --package-lock-only`, sync `server.json` (top-level + `packages[0].version`) and `STATUS.json`, regenerate the catalogue + install links (so the release commit cannot redden mcp-servers main's drift checks), insert the new release block into `CHANGELOG.md` under `## [Unreleased]`, run build + tests, commit one atomic release commit in the submodule — stamped with the [`Release-Gate` trailer](#the-release-gate-commit-trailer). (Idempotent: skipped if the working tree already shows the target version.)
   3. **Stage 2** — **Prompt for push authorisation** to `mcp-servers/main`. Approve. This push triggers npm Trusted Publishing — the GitHub `npm-publish` environment **deliberately has no required reviewers** under the AI-only policy (see § 13 below), so this approval is the publish authorization and `MCP_RELEASE_AUTO_APPROVE=1` is deliberately ignored here.
   4. **Stages 3–4** — Watch the GitHub Actions release.yml workflow until success.
   5. **Stage 5** — One bounded retry loop with three sub-checks: (a) npm CDN propagation + `npm audit signatures` for Sigstore verification, (b) real `npx -y @mindstone/mcp-server-<name>@<version>` initialize smoke, (c) registry sync confirmation (with `--skip-registry-confirm` escape hatch if release.yml's mcp-publisher step is having known issues).
   6. **Stage 6** — Verify the submodule HEAD still equals the release commit, then update `connector-catalog.json` pin(s) + advance submodule pointer atomically. (Microsoft 5 are now treated uniformly via the catalog — no separate const update.)
   7. **Stage 7** — Run `validate:fast` locally.
   8. **Stage 8** — **Prompt for push authorisation** to `mindstone-rebel-1/dev`. Approve. The actual push uses `git-safe-sync.ts --no-advance-submodules` per AGENTS.md (mcp-servers was already pushed in Stage 2; `--no-advance-submodules` avoids bundling unrelated submodule changes into the release push). `MCP_RELEASE_AUTO_APPROVE=1` is also ignored here.
   9. **Stage 9** — Print the final summary and exit clean.

Total wall-clock: 10-20 minutes, depending on npm CDN propagation. Two interactive push approvals (Stages 2 and 8) — release-authorization acts performed by the operator, whether human or an agent acting under explicit per-turn user authorization.

### Push approval and non-interactive runs

`MCP_RELEASE_AUTO_APPROVE=1` only approves local, non-push prompts. It does **not** approve Stage 2 or Stage 8, because those pushes move release-capable state.

When running without a TTY, the script fails at a push stage and prints an exact one-use approval value:

```bash
MCP_RELEASE_PUSH_APPROVAL="<ledger-id>:submodule-pushed:<release-sha>" \
  npm run mcp:release -- --resume <ledger-id>
```

Use that only when you have verified the ledger, commit SHA, security review, and target branch. The `npm-publish` GitHub environment deliberately has no required reviewers (AI-only policy — see § 13 below), so the Stage 2 approval is the last authorization before npm publish.

## Recovery

The script writes a durable ledger to `<rebel>/.cache/mcp-releases/<id>.json` after every state transition. If the script crashes, the agent runs out of context, your laptop sleeps, or a CI step transient-fails — resume:

```bash
npm run mcp:release -- --resume <id>
# Or, to find the most recent ledger:
ls -t .cache/mcp-releases/*.json | head -1
```

The script reads the ledger, identifies the last completed stage, and continues from there. Every stage is idempotent — resuming after a successful stage is a no-op for that stage.

If the ledger is corrupted or you want to abandon it:

```bash
rm <rebel>/.cache/mcp-releases/<id>.json
```

If you abandon a ledger after the mcp-servers push has gone through but before the catalog bump, **the catalog will drift** until you either (a) re-invoke `mcp:release <name>` and let it complete the catalog half, or (b) run `--reconcile` (below). The pre-push hook should catch this on subsequent pushes via the parity test; CI will too.

### Reconcile — recovering a bump that landed outside the script

```bash
npm run mcp:release -- --reconcile <connector>
```

`--reconcile` is the **sanctioned recovery** when a version bump has already reached mcp-servers `main` outside the script (emergency direct push, a historical bundled-bump PR, or an abandoned ledger after the Stage 2 push). It verifies the published state, seeds a fresh ledger pointing at the landed release commit, and enters the proven `--resume` path — so every gate the normal flow runs (§13 gate, npm/Sigstore/registry verification, atomic catalog+submodule commit, validate:fast) still runs. It replaces the earlier hand-seeded-ledger recipe entirely; do not hand-author ledger files.

**It handles the clean-tip case only, and fails loud on everything else:** the mcp-servers submodule HEAD must equal `origin/main`'s tip, the landed release commit must be contained in `origin/main`, and Stage 1's regen must be a no-op (any catalogue/STATUS/install-links drift aborts the reconcile and routes to [MCP_OSS_PACKAGE_MANUAL_UPDATE](MCP_OSS_PACKAGE_MANUAL_UPDATE.md) — `--reconcile` never creates drift-fix commits). The already-landed submodule push is skipped rather than retried. Reconcile promptly after the out-of-band bump; the longer main moves on, the likelier you fall out of the clean-tip case.

It specifically encodes the three traps the first manual recovery (retell-ai 0.2.3, 2026-06-11) hit:

1. **Ledger ID format** — ledger IDs must match `<name>-<ISO-dashed>-<hex4>` (`assertSafeLedgerId`); hand-seeded IDs in any other shape are rejected. `--reconcile` generates a valid ID.
2. **Artifact-commit ordering** — the dev-push stage refuses when Rebel HEAD has diverged from the catalog commit; it now tolerates HEAD being a *descendant* of the catalog commit (e.g. the committed §13 artifact), so the script's own push path closes the run instead of forcing a manual `git-safe-sync --no-advance-submodules`.
3. **Terminal stage advance** — after an out-of-band push, marking the ledger complete used to be a hand-edit. With descendant HEADs tolerated, the in-script push path advances the ledger to `complete` itself.

Scope limit: `--reconcile` recovers **published-but-unreconciled** states. It cannot rescue a bump that release.yml refused (missing/invalid `Release-Gate` trailer) — revert that commit and rerun the proper release path.

## § 13 — Pre-publish security review

For all agent-driven connector releases, [§ 13 of OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) requires a security review. This is stricter than trying to classify "behaviour-changing" at release time; the cost of one redundant review is lower than the cost of shipping an unsafe catalog pin to every user.

The review is **AI-only** (policy revision 2026-06-11; no human reviewer stage): the releasing agent authors the review, and a **mandatory cross-family adversarial pass** (different model family; reads diff + source; records model ID / session ID / confidence / verdict in the artifact) must return `UPHELD` (or `UPHELD-WITH-ADDENDA`, when its addenda are incorporated). Release authorization (`Release-Authorized-By`) is a separate authorization act. The script verifies:

1. A file exists at `<rebel>/docs-private/reports/security-reviews/<yyMMdd>_<connector>_<toVersion>.md`, or the operator passed `--security-review=<path>`.
2. The file lives under `docs-private/reports/security-reviews/`.
3. The file contains the machine-readable `Release Gate` block from [MCP_RELEASE_SECURITY_REVIEW_TEMPLATE](../../docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md).
4. `Security-Review-Gate` is `Approved` or `Approved-with-deferred-findings`.
5. `Connector`, `Package`, and `Version` match the release.
6. `Critical-Findings-Open: 0`, `High-Findings-Open: 0`.
7. For new-format artifacts: `Author-Model` and `Adversarial-Model` are present and from different model families, `Adversarial-Verdict` is `UPHELD` or `UPHELD-WITH-ADDENDA`, and `Release-Authorized-By` is non-empty. Legacy artifacts predating the AI-only fields carry `Human-Signoff` instead (accepted as an alias for `Release-Authorized-By`) and remain valid **without** the model / verdict fields.

If any check fails, the script refuses to proceed. The agent must address the finding (or document a waiver) and re-invoke.

The former synthetic proof-connector exception has been removed from Rebel. `MCP_RELEASE_SKIP_SECURITY_REVIEW=1` is no longer supported; the script rejects it for every connector.

**Why the `npm-publish` GitHub environment has no required reviewers:** adding a human environment reviewer was considered and deliberately rejected (2026-06-11) — the policy is a careful, trustworthy, consistent AI-only process, not a human-keystroke gate. Gate-completeness comes instead from the landing rule, the §13 gate chain, and the paired mcp-servers release.yml change (the PR bump-guard — leaving no publish-capable path except `mcp:release` — plus the `Release-Gate` trailer check and publish alerting).

## The `Release-Gate` commit trailer

`mcp:release` stamps every release commit in mcp-servers with a machine-validated trailer binding the commit to its §13 artifact:

```
Release-Gate: <repo-relative-review-path>#<sha256-hex64>
```

(path relative to the Rebel repo root, e.g. `docs-private/reports/security-reviews/260611_retell-ai_0.2.3.md`; hash = SHA-256 of the artifact contents.)

Enforcement is two-layered, and honestly bounded:

- **Public side (mcp-servers release.yml, as of its trailer-gate change — paired with this revision):** the detect job refuses to publish any version bump whose commit lacks a well-formed `Release-Gate` trailer — fail-closed, with an error pointing at this runbook. Validation is **format-only**: the public repo cannot read `docs-private/` (by design — no secrets on the hardened public repo).
- **Rebel side (audit):** `mcp:release` verifies the trailer's path + SHA-256 against the actual `docs-private` artifact for the pinned release commit, closing the forgeability gap as far as possible without secrets.

Honest framing: this is an **accident/consistency gate, not adversarial security** — someone with push access could forge a trailer. The adversarial layer is Trusted Publishing + Sigstore verification + exact catalog pinning (see [§ 13.8.1](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#1381-residual-risk-posture-honest-read)). A trailer-refused bump is recovered by **revert + rerun the proper release path** — `--reconcile` cannot rescue a refused bump (it is for published-but-unreconciled states).

## Publish alerting

As of the paired mcp-servers workflow change, release.yml posts every npm publish to Slack — connector@version, the triggering commit, and the actor — so an unexpected publish is noticed same-day rather than at the next audit. If you see a publish notification you can't account for, treat it as an incident: check the commit's `Release-Gate` trailer and the §13 artifact first.

## Failure modes (most common)

(Stage numbers refer to the v2 9-stage state machine documented in [docs/plans/260525_oss_release_automation.md](../plans/260525_oss_release_automation.md).)

| Symptom | Most likely cause | Fix |
|---|---|---|
| Stage 0 fails: "catalog says X, connector says Y" | Forgot to update package.json version OR forgot to bump catalog after a previous release | `npm run mcp:release -- --reconcile <name>` (see Recovery) |
| Stage 0 fails: "Missing security review" | The review artifact is absent or not named with the default `<yyMMdd>_<connector>_<version>.md` pattern | Write the review from `docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md`, or resume with `--security-review=<path>` |
| Stage 0 fails: "stdin is not a TTY" | Running in a non-interactive context | Set `MCP_RELEASE_AUTO_APPROVE=1` only for non-push prompts if you trust this context |
| Stage 2/8 fails: "Cannot prompt" | Push approval requires a TTY or exact one-use approval token | Verify the SHA and resume with the printed `MCP_RELEASE_PUSH_APPROVAL=...` value |
| Stage 1 fails: build/test errors | Real bug in the change | Fix, commit nothing yet, resume — script's idempotency check skips the version bump if already applied, re-runs build/test/commit |
| Stage 2 prompt times out / declined | User wasn't ready or lost the terminal | `--resume <id>` |
| Stage 3 fails: workflow run not found within 60s | GitHub Actions registration latency | Wait + `--resume` |
| Stage 4 fails: workflow red | TruffleHog hit, test regression, TP misconfigured | Read the failed job logs, fix, push fix, `--resume` |
| Stage 5 sub-check A timeout (npm propagation, 10 min) | CDN slow that day | `--resume` after waiting |
| Stage 5 sub-check A signature failure | Critical — unexpected with Trusted Publishing OIDC | Investigation required; do not auto-resume |
| Stage 5 sub-check B fails: `npx initialize` errored | Real runtime bug not caught in CI | Hard problem — possibly `npm deprecate` and bump again |
| Stage 5 sub-check C fails: registry 404 (5 min retry) | Registry sync didn't fire, misconfigured OIDC, or the registry read API changed | First check `https://registry.modelcontextprotocol.io/v0.1/servers/<url-encoded server.json name>/versions/<version>`. If that works, fix the verifier and resume. If it does not, fix the `mcp-publisher` job in release.yml, or re-invoke with `--skip-registry-confirm` only after manual verification |
| Stage 6 fails: submodule pointer integrity | Someone advanced the mcp-servers submodule between Stages 2 and 6 (e.g. by checking out a different commit) | Reset the submodule to `ledger.releaseCommitSha`, then `--resume` |
| Stage 6 fails: parity test triggers | A new `?? ['-y', '@mindstone/mcp-server-...']` fallback was introduced in some unrelated code path | Drop the fallback, commit, `--resume` |
| Stage 7 fails: validate:fast errors | New code triggered an unrelated lint/contract check | Fix, commit on top of Stage 6's commit, `--resume` |
| Stage 8 push fails: branch protection / merge conflict | Someone pushed to dev between validate and push | `git-safe-sync.ts` handles the merge; if conflict in submodule pointer, manual reconciliation needed |
| Stage 8 push fails: no tracking branch or dirty unrelated submodule | First push of a local feature branch, or existing `rebel-system`/`super-mcp` working-tree edits | Set the branch upstream before release, and start from a clean superproject/submodule worktree except for the intended `mcp-servers` release changes |

## Working with the submodule

The `mcp-servers` directory inside Rebel is a real submodule. Treat it like any other:

- `git status` from inside the submodule shows the submodule's own working tree.
- `git status` from `<rebel>` shows the submodule pointer state (modified, ahead/behind upstream, etc.).
- After the agent-driven flow commits a release, the submodule will be at a specific commit (the release commit). Switching `<rebel>` branches will move the pointer.
- Per [AGENTS.md submodule guidance](../../AGENTS.md), `git reset` in `<rebel>` unstages submodule pointer changes — be deliberate when running reset.

If you need to do submodule work outside of `mcp:release` (e.g. exploring, cherry-picking), the standard submodule workflow applies. To advance the submodule manually after someone else's mcp-servers push, use `git-safe-sync.ts` per [AGENTS.md](../../AGENTS.md) — never raw `git pull` or `git submodule update --remote`.

## Multi-agent / colleague safety

If `mcp-servers` has uncommitted changes from another agent or colleague (visible via `cd mcp-servers && git status --porcelain`), the script refuses to proceed at Stage 0. Reasoning: a release commit must include only the intended changes; piggy-backing on someone else's WIP is a recipe for accidentally publishing unfinished work.

To proceed in that situation: coordinate with the other agent / colleague to land their changes first, or work in a separate sibling clone of mcp-servers and use the legacy manual flow for this release.

## Telemetry

The script logs structured events to its ledger and to stdout. No external telemetry pipeline yet. The ledger files at `.cache/mcp-releases/` are the sole durable record; they're gitignored but useful for postmortems.
