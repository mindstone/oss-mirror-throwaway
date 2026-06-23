---
description: "Guide for running code health tools and systematic sweeps. Covers routine checks (every PR), periodic analysis (weekly/monthly), and deep sweeps (quarterly)."
last_updated: "2026-06-20"
---

# Code Health Tools

Tools and workflows for maintaining codebase hygiene: linting, type safety, dead code, circular dependencies, and bundle analysis.

## See Also

- [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md) -- the weekly runbook that sequences these tools + the bug-feedback loop (point a scheduled agent at it)
- [TESTING_AUTOMATION_OVERVIEW](TESTING_AUTOMATION_OVERVIEW.md) -- unit/integration tests, validation commands
- [CODING_PRINCIPLES](CODING_PRINCIPLES.md) -- coding standards that these tools enforce
- [CODE_METRICS](CODE_METRICS.md) -- quantitative codebase metrics
- [BIG_FILE_REFACTOR_CANDIDATES](BIG_FILE_REFACTOR_CANDIDATES.md) -- ease×value-ranked shortlist of oversized files worth refactoring (size×churn methodology + which big files to leave alone)
- [DEAD_CODE_DETECTION_AND_REMOVAL](DEAD_CODE_DETECTION_AND_REMOVAL.md) -- the dead-code gate (export/duplicate count ratchet + diff-scoped new-finding guard + types telemetry), the safe removal process, and how to lower baselines
- `docs/research/tools/251230_Knip_Dead_Code_Detection.md` -- deep-dive on Knip
- `docs/research/tools/251230_Madge_Circular_Dependencies.md` -- deep-dive on Madge
- `docs/research/tools/251230_Rollup_Plugin_Visualizer.md` -- deep-dive on bundle analysis
- `docs-private/reports/code-health/` -- historical scan reports
- `knip.json` -- Knip configuration

## Quick Reference

| Tool | Purpose | Command | Frequency |
|------|---------|---------|-----------|
| ESLint (preflight) | Lint, blocks on errors only; a `--max-warnings 3000` cap (`package.json` `lint`) — mostly a sanity ceiling (the per-rule ratchet below is the real warning gate) but it ALSO serves as the coarse mass-regression backstop for `rebel-silent-swallow/no-silent-swallow` since that rule's count baseline was retired (Stage 3, `docs/plans/260612_silent-swallow-gate/PLAN.md`). **Never ratchet this cap DOWN on drift** — it must keep headroom over the live total so a silent-swallow mass-spike trips it. | `npm run lint` | Every PR (in validate:fast) |
| ESLint warning ratchet (per-rule) | Blocks if any tracked rule's warning count exceeds its baseline. Scope: `src/`, `cloud-service/src/`, `cloud-client/src/`, `mobile/src/`, `mobile/app/`, `evals/`. See `scripts/check-eslint-warnings.ts` for baselines. **Note:** `rebel-silent-swallow/no-silent-swallow` is NO LONGER count-baselined here (retired 2026-06-12) — see the silent-swallow gate row below | `npm run validate:eslint-warnings` | Every PR (in validate:fast) |
| Silent-swallow gate (diff-scoped) | Blocks on a **new** `rebel-silent-swallow/no-silent-swallow` warning in a **changed file** vs a base SHA. NO count baseline (retired 2026-06-12); base-fallback chain `--base` > `BASE_SHA` > `merge-base @{upstream}` > `merge-base origin/dev` > **loud non-fatal skip**; `--max-warnings 3000` cap is the mass-regression backstop; rule presence asserted by a smoke test. Mirrors the knip diff-guard model. See the **Silent-swallow gate** section below | `npm run validate:eslint-new-warnings` | Every PR (in validate:fast) + blocking CI job |
| Fast validation | The pre-push / CI gate — many steps (lint, type ratchet, parity, schema, dead-code, postmortem-index, …). Authoritative current list + rerun hints: `npx tsx scripts/run-validate-fast.ts --list` (the script is the SSOT — don't copy the step list here) | `npm run validate:fast` | Every PR + pre-push + CI gate |
| Husky pre-push fast-tier contract | Hard-asserts `VITEST_FAST=1` precedes every `vitest related --run` in `.husky/pre-push` | `npx tsx scripts/check-husky-pre-push-fast-tier.ts` | Every PR (in validate:fast) |
| Integration-test provider-gate | AST check that `**/*.integration.test.ts` gates compose `isDirectAnthropicConfig` alongside any auth-shape helper or raw auth-field reference (260419 misuse class) | `npx tsx scripts/check-integration-test-provider-gates.ts` | Every PR (in validate:fast) |
| Agent verification | validate:fast + dead-code (knip) health + unit/perf tests (exact chain in the `verify:agent` script in `package.json`) | `npm run verify:agent` | Every PR |
| TypeScript ratchet | Type error regression gate | `npm run validate:ts-ratchet` | Every PR (in validate:fast) |
| TypeScript strict (raw) | Full type checking output | `npm run lint:ts` | Diagnostic |
| Unit tests | Correctness | `npm run test` | Every PR |
| Circular deps | Renderer 0, Main ratchet 10 | `npm run validate:circular-deps` | Every PR (in validate:fast) |
| Knip health gate | Unused files + (dev)deps (=0) **+ unused export/duplicate count ratchet + diff-scoped new-finding guard** (needs `BASE_SHA`/`--base`) + types telemetry. Needs `NODE_OPTIONS=--max-old-space-size=8192`. See [DEAD_CODE_DETECTION_AND_REMOVAL](DEAD_CODE_DETECTION_AND_REMOVAL.md) | `npm run validate:knip-health` | Every PR (in verify:agent + dev-checks CI) |
| Knip (full) | Dead code/deps/exports/types | `NODE_OPTIONS=--max-old-space-size=8192 npx knip` | Periodic sweep |
| Madge (full) | All circular dep detail | See commands below | Periodic |
| Bundle visualizer | Bundle size | See manual setup below | Before releases |
| Renderer bundle singletons | Duplicate-React smoke in packaged renderer | `npm run validate:renderer-bundle-singletons -- --bundle-dir <path>` | Manual, post-`npm run package` (see below) |
| Boundary forbidden terms | CI enforcement of registry `forbidden_terms` on changed lines | `npm run validate:boundary-forbidden-terms` | Every PR (in validate:fast) |
| Cloud channel parity | Verifies cloud routes exist for all `CLOUD_CHANNEL_POLICIES` channels | `npm run validate:cloud-channel-parity` | Every PR (in validate:fast) |
| IPC handler parity | Verifies every IPC contract has a handler and vice versa (blocking both directions) | `npm run validate:ipc-handler-parity` | Every PR (in validate:fast) |
| Escape-hatch ratchet | Tracks `as any`, `@ts-ignore`/`@ts-expect-error`, `eslint-disable` — blocks on increases. Scope: `src/`, `cloud-service/src/`, `cloud-client/src/` (narrower than the ESLint warning ratchet; does not scan `mobile/` or `evals/`) | `npm run validate:escape-hatches` | Every PR (in validate:fast) |
| IPC schema strictness | Ratchets on `z.any()` / `z.unknown()` in IPC schemas — blocks on increases | `npm run validate:ipc-schema-strictness` | Every PR (in validate:fast) |
| Deferred-cleanup ledger | Surfaces deferred cleanup that is due/overdue (replaces the old per-push deadline gate; **not** a push blocker) | `npm run cleanup:list` | Periodic sweep (weekly/monthly) |

---

## Routine Checks (Every PR)

Run these before every commit or PR. They're fast and catch the most common issues.

### ESLint

```bash
npm run lint          # ESLint only (~10s)
```

### Fast Validation

The every-PR / pre-push / CI gate. It runs many steps; for the current list and per-step rerun hints, run `npx tsx scripts/run-validate-fast.ts --list` (the script is the single source of truth — don't maintain a copy of the step list here):

```bash
npm run validate:fast
```

`validate:fast` also emits reporting-only timing markers on stderr after each
step (`[PREPUSH_TIMING] step=<name> duration_ms=<ms> ...`) and writes the latest
run summary to `.local/validate-fast-timings.json`. Each step entry includes a
`resolved_command` field — the command actually spawned, since the runner
resolves simple `npm run` steps to direct `node --import tsx` spawns at runtime
(see [PREPUSH_GATE_AND_RECEIPTS](PREPUSH_GATE_AND_RECEIPTS.md#what-shipped-2026-06-11);
step identities are baselined in `scripts/validate-fast-step-baseline.json`, so
a guard can't be silently dropped). The local artefact is gitignored; it is for
diagnosing validation wall-time drift and does not gate the command.

> **Adding a new `validate:fast` check?** Four steps, each enforced by another gate (miss one and CI reds even though it passed locally):
> 1. Add the `validate:<name>` script to `package.json` **and** register the step in `scripts/run-validate-fast.ts` `STEPS`, then regenerate the identity baseline: `npx tsx scripts/run-validate-fast.ts --write-step-baseline`.
> 2. Add the check's `.ts` to `tsconfig.node.json` `"include"` — otherwise `check-typecheck-coverage` fails (new validate:fast-wired scripts must be type-checked, not grandfathered).
> 3. Adding/changing **any** `package.json` script shifts the `validate-fast-step-registry` snapshot (it classifies *every* script) — run `npx vitest run scripts/__tests__/validate-fast-step-registry.test.ts -u` and commit the `.snap`. A `dev` merge that touches `package.json` can require this same reconcile, or the pre-push vitest reds.
> 4. Commit the baseline + snapshot in the **same** commit as the check (reviewers expect the diff together).

> **`validate:fast` and pre-push do NOT run integration tests.** Pre-push (Tier 1/2 = `VITEST_FAST=1 vitest related`) and the fast tiers exclude `**/*.integration.test.ts` — `vitest.config.ts` applies the `**/*.integration.*` exclude only when `VITEST_FAST=1`. Integration tests run only in the **full** suite: `npm test` / `verify:agent` and the blocking `dev-checks` desktop job (`npx vitest run --project=desktop`). **Consequence:** a cross-cutting refactor that breaks an integration test in an *unrelated* file passes pre-push and lands, then reds CI post-merge until fixed — and that red won't show in a local `validate:fast`. So a green `validate:fast` is **not** proof integration tests pass; run `verify:agent` (or watch the `dev-checks` run) to confirm. (Surfaced 2026-06-07: `modelIdLifecycle.integration.test.ts` sat red on `dev` after the models-namespace auth refactor; fixture-drift follow-up tracked in the deferred-cleanup ledger as `integration-test-settings-fixture-builder`.)

### Agent Verification

Fast validation + full unit test suite -- the standard "am I good to commit?" check:

```bash
npm run verify:agent  # ~30-60s
```

### Full Agent Verification (with build)

Includes a full electron-vite build on top of verify:agent:

```bash
npm run verify:agent:full
```

---

## Periodic Analysis (Weekly/Monthly)

Run these regularly to catch drift. Results should be saved to `docs-private/reports/code-health/` for baseline comparison.

### Deferred-Cleanup Ledger

When cleanup is intentionally deferred (e.g. removing a legacy fallback only after a migration soaks), record it in the NDJSON ledger at `docs/project/deferred-cleanup.ndjson` instead of relying on a per-push gate or a buried TODO. Review it during this sweep:

```bash
npm run cleanup:list            # open items, with overdue ones first (exit 2 if any overdue)
npm run cleanup:list -- --all   # include later + done items
```

For any **overdue** item: either execute the cut-over (the full checklist lives in the linked `provenance.plan`) or re-defer with rationale. The ledger is **not** a push blocker — the only always-on guard is the schema test (`scripts/__tests__/deferred-cleanup.test.ts`), which validates the committed file so it can't silently rot. (If teeth are ever wanted without taxing pushes, wire `cleanup:list --overdue` into a weekly cron modelled on `.github/workflows/docs-link-check.yml` — it already exits non-zero on overdue.)

Agents append/update entries via the helper (never hand-edit the NDJSON):

```bash
npx tsx scripts/deferred-cleanup.ts add \
  --id my-cleanup --title "..." --owner some-owner \
  --deadline 2026-07-01 --plan docs/plans/260601_foo.md \
  --ease easy --value high [--description "..." --branch dev --commit abc123 \
  --pr "#42" --link docs/plans/bar.md --tag settings --note "..."]
npx tsx scripts/deferred-cleanup.ts defer --id my-cleanup --deadline 2026-08-01 --reason "soak not elapsed"
npx tsx scripts/deferred-cleanup.ts done  --id my-cleanup --reason "cut over in #51"
```

Each record carries provenance (`plan` + optional branch/commit/PR/links), an `ease`/`value` rating (list output sorts high-value/low-effort first), and an append-only `history` of defer/done events — so it's cheap for an agent to trawl with `jq` and decide what to pick up.

### TypeScript Strict Type Checking

```bash
npm run lint:ts       # Strict checking via -p tsconfig.node.json and -p tsconfig.renderer.json
```

**Background**: The project uses Vite (via electron-vite) for bundling, which uses esbuild for transpilation. esbuild strips types without checking them, so builds succeed even with type errors. `npm run lint` catches style/lint issues only; `npm run lint:ts` catches actual type errors.

**Known type debt**: Existing TS errors don't block the build but represent type safety gaps. **Enforced via ratchet** in `validate:fast` — new errors fail validation. Run `npm run validate:ts-ratchet` to check, or `npm run lint:ts` for raw tsc output. Baselines are in `scripts/check-typescript-errors.ts` — lower them when you fix errors! For current counts, baselines, error categories, and milestones, see [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md).

> **Unresolved-module errors (TS2307) hard-fail — they are NOT baseline-able (2026-06-14).** A missing sub-project dependency (e.g. an un-installed `node_modules` in a sub-package) makes `tsc` emit TS2307 *and suppresses the downstream diagnostics* that would otherwise depend on the missing module — so the visible error count can drop **below** a non-zero baseline and the ratchet falsely passes locally while CI (with deps installed) goes red. The ratchet now treats any TS2307 as an environment/deps failure and fails loud rather than counting it; remediation is `npm ci` in the affected package, not a baseline bump. Commit `b900f56c`.

> **Gotcha — a new top-level `scripts/*.ts` is NOT type-checked until you add it to `tsconfig.node.json`.** The `node`-project tsconfig's `include` globs only a few script *subdirs* (`scripts/rebel-cli/**`, `scripts/backport/**`, `scripts/lib/**`); every other top-level `scripts/*.ts` is type-checked **only if listed explicitly**. A check/gate script left off the list runs fine (`tsx` strips types) and its unit tests pass, so the gap is silent — `lint:ts` never sees it and the ratchet can't catch a type error in it (a false pass). **When you add a `scripts/*.ts` that's wired into `validate:fast`/CI, add it (and its `__tests__/*.test.ts`) to `tsconfig.node.json` `include`.** Surfaced 2026-06-12 / -13 when parallel recs-drain agents shipped new gate scripts un-type-covered (one carried a real `string[]`-vs-`string` error that slipped through).
>
> **This recurrence is now gated** by `scripts/check-typecheck-coverage.ts` (`validate:typecheck-coverage`, wired into `validate:fast`) — option **(b)** above, shipped 2026-06-13 (`docs/plans/260613_tsconfig-typecheck-coverage-gate/`). It enumerates the validate-wired script set (parsing `run-validate-fast.ts` STEPS + resolving `npm run` through `package.json`), computes the type-checked set from `tsconfig.node.json` `include` minus `exclude`, and **fails when a NEW wired script is un-type-checked**. The large legacy backlog (127 scripts at creation) is grandfathered in `scripts/typecheck-coverage-baseline.json`, a **shrink-only** ratchet (enforced by mechanics: `--write-baseline` refuses to add new entries without `--allow-baseline-growth`): drain it by adding a script to `include`, fixing its real errors to zero, and rerunning `npx tsx scripts/check-typecheck-coverage.ts --write-baseline`. Draining surfaces errors that feed the Scripts TS-error ratchet (this doc's "Known type debt"), so coordinate larger drains with whoever owns the baselines. Option (a) — a blanket `scripts/*.ts` glob — remains rejected: it pulls ~195 top-level scripts (many with import-not-listed cascades + real errors) into the ratchet at once.

**ESLint warnings**: Enforced via a **per-rule ratchet** in `scripts/check-eslint-warnings.ts` (run inside `validate:fast` as `validate:eslint-warnings`), not via `--max-warnings 0`. The bare `npm run lint` script uses a high `--max-warnings` sanity cap (value in `package.json`); the real enforcement is per-rule baselines (e.g., `no-unused-vars`, `no-explicit-any`, `no-non-null-assertion`, `no-console`, `no-use-before-define`, `naming-convention`). Specific rules are also promoted to **error** (`react-hooks/exhaustive-deps`, `react-hooks/rules-of-hooks`, `no-restricted-syntax`, `no-restricted-properties`, `no-empty` with `allowEmptyCatch: false` for `src/**` only, `@typescript-eslint/switch-exhaustiveness-check` for `src/main/**` + `src/core/**` + `cloud-service/src/**`, `@typescript-eslint/no-misused-promises` (DI-24, 260606), `@typescript-eslint/await-thenable` (DI-25, 260606), and the custom `bts-flow-shape/no-model-error-catch-clobber` (260606)) — those block the bare `lint` step at zero. The `switch-exhaustiveness-check` promotion (DI-22, 260603 / v0.4.46) makes a non-exhaustive switch over a closed union (the recurring `incomplete_implementation` bug class) fail the build instead of warning; see the `error`-severity rule blocks in `eslint.config.mjs`. Switches whose discriminant is genuinely **open at runtime** (e.g. `AgentEvent`/`RebelCoreEvent` arriving over IPC/stream/CLI, the `switch(true)` dispatch idiom) legitimately need a `default` case and carry an inline `eslint-disable` with justification — an exhaustive `assertNever` there would throw on valid unknown/future values; this is why the escape-hatch `eslint-disable` baseline was raised (244 → 251). The async-safety promotions (260606) followed the same clear-then-flip pattern: `@typescript-eslint/no-misused-promises` (DI-24, 34 fixes cleared first) and `@typescript-eslint/await-thenable` (DI-25, 25 behaviour-preserving fixes cleared first) both went `warn` → `error`. The `no-empty` promotion (260525) followed the Stage 1 drain of all 16 bare-`catch {}` sites in `src/**` via the canonical `ignoreBestEffortCleanup(error, { operation, reason })` helper in `src/shared/utils/intentionalSwallow.ts`; the matching `BASELINE_NO_EMPTY = 0` entry in the warning ratchet is now a belt-and-suspenders backstop (would catch regressions if anyone reverts the severity to `warn`). Test files have relaxed rules for `no-non-null-assertion` and `no-explicit-any` (see `eslint.config.mjs`). Workers, bootstrap, sentry, and preload files have file-level `eslint-disable no-console` with reasons (no structured logger available in those contexts). For current baselines and counts, see [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md). Lower baselines when you fix warnings.

**ESLint heap budget**: the `lint` script in `package.json` sets `NODE_OPTIONS=--max-old-space-size=8192` because the cold-cache run on `src/` + `cloud-service/src/` + `cloud-client/src/` + `mobile/src/` + `mobile/app/` + `evals/` exceeds the default 4GB heap on macOS and OOMs in the Husky pre-push hook (observed 260525). Mirrors the same pattern used by `build`/`package`/`analyze:bundle`. If lint OOMs at 8GB in future, bump again or investigate the lint cache / plugin retention.

**Targeted lint guards** (zero-tolerance error-level rules in `eslint.config.mjs`, each derived from a postmortem):

- **`sdkExtractorGuardSelectors`** — bans direct `.message.content` reads on OpenAI response shapes outside the canonical `extractOpenAITextFields()` helper. Scoped to SDK-boundary files (`src/core/rebelCore/clients/**`, `src/main/services/behindTheScenesClient.ts`, `src/core/services/behindTheScenesClient.ts`, `src/main/services/localModelProxyServer.ts`). Allowlists the helper itself and `src/main/ipc/settingsHandlers.ts` (provider-profile JSON validation). Originating postmortem: `260427_bts_reasoning_content_direct_profile_postmortem.md`.
- **`nodeEngineFloorGuardEntries`** — bans `fs.globSync` and `fs.promises.glob` (Node 22+ APIs) while `package.json` `engines.node` is `>=20`. Scoped to `src/**`, `cloud-service/**`, `cloud-client/**`, `evals/**`, `mobile/**`. Drop the rule when engine floor bumps to `>=22`. Originating postmortem: `260521_outcome_shape_globsync_node20_postmortem.md`.
- **`bts-flow-shape/no-model-error-catch-clobber`** — bans a `catch` block from re-wrapping an already-classified error (e.g. a `ModelError`) as a fixed/generic kind, which silently clobbers the original classification. Catches that need to reclassify must route through the sanctioned `reclassifyOrRethrow` helper in `src/core/rebelCore/modelErrors.ts`. Rule source: `eslint-rules/no-model-error-catch-clobber.js`. Added 260606 (commits `6c65d65a4`, `5d0711fbb`).
- **`pinoArgOrderSelectors`** — pre-existing; bans `log.warn('message', { data })` (incorrect arg order silently drops the object) and enforces `log.warn({ data }, 'message')`. Originating postmortem: `260329_pino_logger_arg_order_postmortem.md`.
- **`no-raw-startup-dialog`** — bans raw `dialog.showMessageBox` in the startup surface; startup native dialogs must route through `showStartupMessageBox` (`src/main/startup/startupDialog.ts`), which no-ops in automated/headless contexts. A parent-less startup modal wedges the automated/E2E boot (the chronic-E2E launch-hang class). Rule source: `eslint-rules/no-raw-startup-dialog.js`. Added 260619.
- **`no-raw-headless-check`** — bans re-inlining the headless-CLI check; the single source of truth is `isHeadlessCli()` (`src/core/utils/headlessCli.ts`, re-exported from `src/main/utils/testIsolation.ts`). Re-inlining reintroduces the drift the consolidation removed. Rule source: `eslint-rules/no-raw-headless-check.js`. Added 260619.
- Plus other selector-array guards: `clientFactoryGuardSelectors`, `fireAndForgetGuardSelectors`, `timezoneUnsafeSelectors`, `navigationUrlGuardSelectors`, `agentEventConstructionGuardSelectors`, `cleanupBypassGuardSelectors`, `providerFeatureGateGuardSelectors`, and others — see `eslint.config.mjs` for the full list.

**Startup IPC ordering check** (`validate:startup-ipc-ordering`): scans `src/main/index.ts` and `src/main/bootstrap.ts` for `ipcMain.handle()` registrations textually after the first executable `createWindow()` call. Late registrations race renderer `invoke()` calls and cause "no handler for channel" startup failures (5 high-severity postmortems in this class). Exempts registrations inside `app.on('activate'|'second-instance', ...)` callbacks and lines preceded by `// STARTUP_LATE_REGISTRATION_OK: <reason>`. Script: `scripts/check-startup-ipc-ordering.ts`. Originating postmortem cluster: `251120`, `251210`, `251219`, `260430`, `260220` startup-race postmortems.

**Circular dependencies**: Renderer: 0 cycles (enforced at zero). Main: ratcheted (see [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md) for current count). Enforced via `validate:fast`. See `scripts/check-circular-deps.ts`.

**Knip health gate**: `validate:knip-health` (in `verify:agent` + dev-checks CI) enforces unused files AND unused dependencies/devDependencies at zero; documented KEEPs live in `knip.json` `ignoreDependencies`. As of 2026-06-07 it **also** gates unused **exports** and **duplicate exports** via a count ratchet (baselines in `scripts/check-knip-health.ts`) plus a diff-scoped guard that fails on a *new* unused-export/duplicate finding in a changed file (when a base SHA is available). Unused **types** are emitted as report-only telemetry (too noisy to gate — dominated by barrels + IPC schemas). Full detail + the safe removal/burn-down process: [DEAD_CODE_DETECTION_AND_REMOVAL](DEAD_CODE_DETECTION_AND_REMOVAL.md).

**Silent-swallow gate** (`rebel-silent-swallow/no-silent-swallow`): the AST rule (`eslint-rules/no-silent-swallow.js`) flags empty/console-only/sentinel-return catches and `.catch(() => …)` swallows across `src/`, `private/mindstone/src/`, `cloud-service/src/`, `cloud-client/src/`, `mobile/src/`, `mobile/app/` (test files ignored); the sanctioned observable opt-out is `ignoreBestEffortCleanup()` in `src/shared/utils/intentionalSwallow.ts`. **It is enforced diff-scoped, not by a count baseline** (the global `BASELINE_SILENT_SWALLOW` + per-surface baselines + per-file budgets were RETIRED 2026-06-12 — `docs/plans/260612_silent-swallow-gate/PLAN.md` — because the hot count drifted on nearly every merge and a count ratchet is blind to remove-one-add-one). The enforcement end-state is three layers:

1. **Diff-scoped new-finding gate** (`validate:eslint-new-warnings`, `scripts/check-eslint-new-warnings.ts`) — fails (blocking) on a **new** swallow signature `(ruleId, message)` in a **changed file** vs a base SHA. This is *stronger* than the old ratchet and inherently non-fungible: it compares per changed file, so a fix in `src` can never license a new swallow in `cloud-service`. Mirrors the knip diff-guard model. Base resolves via the fallback chain `--base=<ref>` > `BASE_SHA` env > `git merge-base @{upstream} HEAD` > `git merge-base origin/dev HEAD`; when no base resolves **or** a base-prep *infrastructure* op fails (git/ESLint error), it degrades to a **loud non-fatal skip** (visible on stderr + a CI `::warning::`, exit 0) so flaky git/ESLint can't block the team — never a silent pass. A genuine new finding (not a thrown error) always fails; a comparator/usage bug fails closed. Runs in `validate:fast` (so pre-push enforces tightly whenever a base derives) and as a blocking `eslint-new-warnings` CI job.
   - **What "new" means + accepted residual:** the gate catches a *net-new warning signature per changed file* — it compares a **multiset of `(ruleId, message)`** (line/column-insensitive, so merge/rebase line-shifts don't false-positive). Consequence: a same-file **remove-one-swallow / add-one-swallow swap** that yields an identical message signature nets out (base count == head count for that signature) and **passes**. This is an accepted, documented residual — far narrower than the old global count ratchet's blind spot (which netted across the *whole* codebase, not one file), and we deliberately do NOT make the shared gate line/diff-aware for a single rule (that would diverge its semantics for every consumer). Pinned by the same-signature-swap tests in `scripts/__tests__/check-eslint-new-warnings.test.ts`. Backstops that still apply: the `--max-warnings 3000` cap (layer 2, mass growth) and the rule-presence smoke (layer 3, disablement).
   - **Known limitation (D5):** a coverage-surface-changing rename (a file moved from an exempt path like `evals/` into a covered path like `src/`) absorbs its pre-existing swallows as baseline on the rename commit — documented and pinned by a test, not silently closed (see the rename-edge tests in `scripts/__tests__/check-eslint-new-warnings.test.ts`).
2. **Mass-regression backstop** — the existing `npm run lint --max-warnings 3000` total cap (`package.json` `lint`). It covers the skip window against a bulk regression. **Never ratchet this cap DOWN on drift** — it must keep headroom over the live total so a silent-swallow mass-spike trips it. No new dedicated ceiling was minted (a second hot number would just re-create the merge contention).
3. **Rule-presence smoke** (`scripts/__tests__/silent-swallow-rule-presence.test.ts`) — the cap is blind to a *disabled* rule (count drops to 0, under any ceiling), so this fail-closed test asserts the rule is configured AND actually fires on a known-bad fixture across every covered surface.

**Local noise convenience (`npm run lint:scan`)**: the rule stays at `'warn'` everywhere (single ESLint truth — there is NO second config and the rule is never turned off), so `npm run lint` still prints the ~2,200 pre-existing swallows. `npm run lint:scan` (`scripts/lint-scan.mjs`) runs the **exact same** `npm run lint` and filters only the `rebel-silent-swallow/no-silent-swallow` lines out of the **displayed** output (and preserves lint's real exit code) so a human/agent can spot a new finding of any other rule. It changes display only — never enforcement; the diff gate above is the real new-silent-swallow signal. Equivalent ad-hoc recipe (cross-platform caveat — works in a POSIX shell): `npm run lint 2>&1 | grep -v 'no-silent-swallow'` (but this drops lint's exit code — prefer `lint:scan`).

See `docs/plans/260328_eslint_ts_warning_sweep.md` for the latest sweep plan, `docs/plans/260329_code_health_next_steps.md` for the TS7006/circular-deps/bundledInboxBridge sweep, and `docs/plans/260325_codebase_health_sweep.md` for earlier triage notes.

### Knip: Dead Code Detection

Detects unused files, exports, dependencies, and types.

```bash
npx knip
```

| Finding | Action |
|---------|--------|
| Unused files | Verify not dynamically imported, then delete |
| Unused dependencies | Verify not in workers/dynamic imports, then `npm uninstall` |
| Unused exports | Low priority -- many are intentional API surface |
| Unlisted dependencies | Add to package.json or remove usage |

**Config**: `knip.json` -- entry points, ignore patterns, platform-specific dep exclusions.

**Common false positives**: Worker files (dynamically loaded), preload scripts (Electron-loaded), platform-specific deps, Pino transports (dynamic targets).

### Madge: Circular Dependency Detection

```bash
# Renderer
npx madge --circular --ts-config tsconfig.renderer.json --extensions ts,tsx src/renderer

# Main process
npx madge --circular --ts-config tsconfig.node.json --extensions ts src/main
```

| Pattern | Severity | Risk |
|---------|----------|------|
| Core service cycles (logger<->sentry) | HIGH | Initialization failures |
| Barrel file cycles (index.ts loops) | MEDIUM | Tree-shaking issues |
| Component cycles (A<->B within feature) | LOW | Refactoring friction |

**Fixes**: Extract shared code to neutral module, use lazy `import()`, import from file not barrel, or use dependency injection.

### Renderer Bundle Singleton Smoke

Scans a packaged renderer bundle for duplicate-React / duplicate-`useState` regressions and exits non-zero if more than one React copy (or more than one `useState` dispatcher) ships in production. Defends against the failure mode behind the v0.4.32 renderer crash (`ERR_NULL_USESTATE`), where a transitive `cloud-client/node_modules/react` leaked into the bundle despite dev-time alias-integrity checks.

```bash
npm run package
# then point the script at the unpacked renderer assets:
npm run validate:renderer-bundle-singletons -- --bundle-dir <path-to-renderer-assets>
# e.g. /tmp/asar_extract/.vite/renderer/main_window/assets
```

Counts distinct `(file, identifier)` pairs (not identifier-only) so it's immune to cross-chunk minifier collisions. Thresholds: `--max-version-objects N` (default 3) and `--max-usestate N` (default 1). Both the expected React version (read from `react/package.json`) and a full (file, identifier) listing are printed on failure.

**Not wired into `validate:fast` yet** — CI wiring is deferred Stage 4d in [260422_renderer_dedupe_followups.md](../plans/260422_renderer_dedupe_followups.md) (needs either `asar.unpack` or an explicit `@electron/asar extract` step in release.yml). Dev-time drift is still caught by the complementary `validate:alias-integrity` script, which enforces the shared `RENDERER_SINGLETON_DEPS` constant across Storybook, web-companion, vitest desktop, and the two Vite renderer configs.

---

## Deep Analysis (Before Releases / Quarterly)

### Bundle Visualizer

Shows what's in the bundle and where the bytes go.

1. **Temporarily add to Vite config** (`vite.renderer.config.mjs`):
```javascript
import { visualizer } from 'rollup-plugin-visualizer'

export default {
  plugins: [
    visualizer({
      filename: 'docs-private/reports/code-health/bundle-stats.html',
      open: true,
      gzipSize: true,
      brotliSize: true
    })
  ]
}
```

2. Run `npm run package` (or just the Vite build portion)
3. Open the generated HTML -- interactive treemap shows module sizes
4. **Remove the visualizer plugin** after analysis

**What to look for**: Large deps that could be lighter, duplicates, unused code from partial imports, code-splitting gaps.

### Systematic Health Sweep

A comprehensive, repeatable workflow for triaging and fixing all diagnostic findings. Run quarterly or when technical debt feels heavy.

#### Prerequisites

- Clean working tree (`git status` shows no uncommitted changes)
- On the `dev` branch, up to date with `origin/dev`
- `npm ci` recently run

#### Step 1: Capture Diagnostics

Run all tools and save output to dated report files:

```bash
DATE=$(date +%y%m%d)
mkdir -p docs-private/reports/code-health

# Lint
npm run lint 2>&1 | tee "docs-private/reports/code-health/${DATE}_eslint.md"

# TypeScript strict
npm run lint:ts 2>&1 | tee "docs-private/reports/code-health/${DATE}_typescript.md"

# Unit tests
npm run test 2>&1 | tee "docs-private/reports/code-health/${DATE}_unit_tests.md"

# Full validation
npm run validate:fast 2>&1 | tee "docs-private/reports/code-health/${DATE}_validate_fast.md"

# Knip
npx knip 2>&1 | tee "docs-private/reports/code-health/${DATE}_knip_scan.md"

# Madge
npx madge --circular --ts-config tsconfig.renderer.json --extensions ts,tsx src/renderer \
  > "docs-private/reports/code-health/${DATE}_madge_renderer.md" 2>&1
npx madge --circular --ts-config tsconfig.node.json --extensions ts src/main \
  > "docs-private/reports/code-health/${DATE}_madge_main.md" 2>&1
```

**With AI agents**: Use subagents to run each diagnostic in parallel and write results to files. The orchestrator reads only summaries, not raw output, to preserve context.

#### Step 2: Triage & Prioritize

Create a planning doc (`docs/plans/YYMMDD_codebase_health_sweep.md`) with:

1. **Summary stats** -- error counts by category
2. **Grouped findings** -- clustered by file/module and category
3. **Priority ranking** -- each group scored by `(ease x value)`:
   - **High-value, easy**: Auto-fixable lint, unused imports, simple type narrowing
   - **High-value, medium**: Type errors indicating real bugs, failing tests
   - **Low-value, easy**: Style-only lint warnings
   - **Deferred**: Anything touching runtime behavior without test coverage
4. **Deferred items** -- risky/ambiguous items with rationale for deferral. Anything deferred with a date to revisit (not just "not now") should also be appended to the **deferred-cleanup ledger** (`docs/project/deferred-cleanup.ndjson` via `scripts/deferred-cleanup.ts add`) so it resurfaces in future sweeps — the per-sweep planning doc is not durable across sweeps. The ledger's `ease`/`value` fields mirror the `(ease x value)` ranking above.

#### Step 3: Fix in Batches

Work through groups in priority order:

1. **Batch 0 -- Auto-fixable**: Run `npx eslint --fix` on targeted files, review diff, commit
2. **Batch 1-N -- Manual fixes**: Per-cluster fixes, each reviewed before commit
3. **After each batch**: Run `npm run verify:agent` (or targeted test subset)
4. **If tests break**: Revert the batch and investigate

**With AI agents — Codex→Opus subagent pairs**: Break work into many small pieces (3-5 files per batch). For each batch:
1. **Codex** (`reviewer-gpt5.3-codex`) analyzes the warnings and proposes specific fixes with rationale
2. **Opus** (`implementer-opus4.7-thinking`) makes the final decision on each fix, implements, and validates

For **production code**: cap at 3-5 files per batch, run targeted tests after each, and verify with `npx eslint <file>`. For **test code**: prefer config-level fixes (e.g., relaxing rules in `eslint.config.mjs`) over modifying hundreds of test files — see the test override block in `eslint.config.mjs` for the pattern.

**Commit strategy**: Group commits by logical unit -- separate mechanical auto-fixes from judgment-call fixes. Each commit should leave the codebase in a working state.

#### Step 4: Final Validation

```bash
npm run verify:agent:full   # lint + tests + build
npm run lint:ts              # type check (may have remaining known debt)
```

Update the planning doc with final results and the deferred items list.

---

## Generating Reports

Save outputs for baseline comparison using the convention:

```
docs-private/reports/code-health/
├── YYMMDD_eslint.md
├── YYMMDD_typescript.md
├── YYMMDD_unit_tests.md
├── YYMMDD_validate_fast.md
├── YYMMDD_knip_scan.md
├── YYMMDD_madge_renderer.md
├── YYMMDD_madge_main.md
├── YYMMDD_recommendations.md
└── bundle-stats.html (gitignored)
```

---

## Gotchas

### Electron-Specific
- **Multiple tsconfigs** -- run Madge separately for renderer vs main
- **Preload scripts** -- must be in Knip entry points
- **Workers** -- dynamically loaded; add to Knip entry points
- **Native modules** -- may show as unused if platform-specific

### TypeScript Path Aliases
Madge needs `--ts-config` to resolve `@renderer/*`, `@main/*`, `@shared/*` aliases.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Knip too many false positives | Check `knip.json` entry points; add dynamic files; use `ignoreDependencies` for optional deps |
| Madge can't resolve imports | Verify correct tsconfig; check `--extensions` includes ts,tsx |
| Bundle visualizer not generating | Ensure plugin in renderer config (not main); check build completes; look for stats.html in project root |
