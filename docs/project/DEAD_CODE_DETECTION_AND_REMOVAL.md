---
description: "How we detect dead/removable code (knip + madge + jscpd), the knip-health gate that stops dead exports/deps/files from accumulating (incl. the production leg for tested-only exports), and the safe process for removing dead code and lowering the baseline."
last_updated: "2026-06-18"
---

# Dead Code Detection & Removal

How Rebel finds dead/removable code and — more importantly — stops it accumulating by construction. The tooling isn't the hard part (the landscape consolidated on Knip); the gate coverage and the *removal process* are.

## See also

- `knip.json` — Knip config (entry points, project globs, and the documented `ignore` / `ignoreDependencies` false-positive allowlist). The single source of truth for "Knip flags this but it's actually used via <path Knip can't trace>".
- `scripts/check-knip-health.ts` — the gate (`validate:knip-health`). Unused files + deps + the export/duplicate **count ratchet** + types telemetry, and it calls the diff guard.
- `scripts/lib/knip-diff-guard.ts` — the **diff-scoped new-finding guard** (`computeNewFindings`, `createDefaultBaseKnipRunner`).
- `scripts/check-eslint-new-warnings.ts` — the sibling diff-scoped gate the knip guard reuses (`resolveBaseSha`, `GitRunner`, `BASE_SHA` semantics). As of 2026-06-12 the **silent-swallow gate follows this same diff-scoped, new-finding-only model** (its count baseline was retired) — see [CODE_HEALTH_TOOLS § Silent-swallow gate](CODE_HEALTH_TOOLS.md) and `docs/plans/260612_silent-swallow-gate/PLAN.md`. Same base-fallback + loud-non-fatal-skip contract as the knip diff guard.
- `docs/research/tools/251230_Knip_Dead_Code_Detection.md` — Knip detection categories + false-positive policy.
- `docs/plans/260607_dead-code-export-ratchet/` — the planning folder where this gate was designed (GPT/Claude critique + arbitration; the count-vs-identity-vs-diff-scoped decision and why).
- `docs/project/PROJECT_OVERRIDES2.md` § Static Analysis Tooling / Impact Analysis — `generate-impact-map.ts`, `check-circular-deps.ts` (madge).

## Why this exists

Dead code costs context budget, misleads agents and humans, and rots into false confidence. We already gated unused **files** and **dependencies** — but unused **exports**, **types**, and **duplicate exports** grew unchecked (≈1,353 / 2,451 / 45 as of 2026-06-07). The fix is a gate that makes the *accumulation* impossible, not a one-off cleanup of a long, false-positive-prone tail.

## The toolkit (what to run)

All Knip runs need a heap bump — `--reporter json` OOMs at the default ~4 GB (peak RSS ~3.3 GB):

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx knip --include exports,types,duplicates --no-progress --reporter json
# single categories, compact (faster to eyeball):
NODE_OPTIONS=--max-old-space-size=8192 npx knip --include exports --reporter compact
```

- **Knip** — unused files, exports, types, enum/class members, duplicate exports, unused deps. The workhorse. (Note: `--include classMembers` **times out** on this repo, so it's not gated.)
- **madge** — circular deps + orphan modules (`scripts/check-circular-deps.ts`). Knip doesn't do circulars.
- **jscpd** — duplication (`npx jscpd <path>`), for *simplifiable* (not just deletable) code.
- **`scripts/generate-impact-map.ts`** — producer/consumer + IPC + switch-dispatch map; complements Knip for boundary tracing.

The `--reporter json` shape: top-level `{ files: string[], issues: Issue[] }`; each issue `{ file, exports[], types[], duplicates[] }`; export/type entries are `{name,line,col,pos}`; `duplicates` is an array of groups.

## The gate (`validate:knip-health`)

Runs in CI (`.github/workflows/dev-checks.yml` → `knip-health` job), in `verify:agent` / `verify:agent:full`, and — since **2026-06-19** — **pre-push** via a fast leg. `.husky/pre-push` runs `validate:knip-health:fast` (`check-knip-health.ts --no-diff-guard`) **concurrently with the vitest phase** and joins it fail-closed before the push proceeds. The fast leg runs layers 1–3 (the HEAD absolute ratchets) only; the **diff-scoped guard (layer 4) stays CI-only** because its base-worktree spawn costs minutes. So a count regression now fails at the **author's** push (the recurring "dev red until a later agent reconciles" loop), while the under-baseline-but-new case is still CI-caught. Design notes: it is slotted against the *light* vitest phase rather than the `tsc`-heavy `validate:fast` phase so it adds ~0 wall-clock and does **not** raise the gate's peak RAM (knip peaks ~3.8GB, graph-bound; measured `validate:fast` window peak > `knip+vitest` window peak — a lower heap cap was measured ineffective); path-filtered to skip docs-only pushes; bypassed by the test-skip escape hatch like the test tiers (CI remains the backstop). See [PREPUSH_GATE_AND_RECEIPTS.md](PREPUSH_GATE_AND_RECEIPTS.md) and `docs/plans/260619_knip-prepush-parallel/PLAN.md`. As of **2026-06-18 the gate is green** on `dev` (mirror CLI scripts registered as `knip.json` entries; shipped-ahead `sourceCapture` kernel ignored; production-leg baselines at floor — see commit trail in `scripts/check-knip-health.ts`). Five layers, two Knip HEAD runs (default + `--production`):

> **Sibling ESLint ratchet note (same `validate:fast` family, not knip):** `validate:eslint-warnings` / `validate:eslint-new-warnings` share `scripts/lib/eslint-warning-audit.ts`, which passes `--no-warn-ignored` so ESLint **"File ignored"** meta-warnings on paths deliberately outside the lint config (fixtures, `scripts/__tests__/**`) do not inflate the warning ratchet or trip the diff-scoped new-warnings guard. See [PREPUSH_GATE_AND_RECEIPTS.md](PREPUSH_GATE_AND_RECEIPTS.md).

1. **Unused files / dependencies** — must stay at zero (pre-existing behaviour).
2. **Count ratchet** (exports, duplicate-export groups) — fails if the count exceeds the committed baseline constant (`KNIP_EXPORT_BASELINE`, `KNIP_DUPLICATE_EXPORT_BASELINE` in `check-knip-health.ts`); warns when below (nudging you to lower it). Catches global net debt growth — including cross-file deaths (deleting the last consumer of an export elsewhere). Mirrors the TS-error ratchet (`check-typescript-errors.ts`).
3. **Production leg** (tested-only export detection) — a second `knip --production` run that sees the **production import graph only** (test files and the `!`-suffixed `entry`/`project` globs in `knip.json` define the production surface). An export or file whose **only consumers are tests** is invisible to the default leg (a test import counts as usage) but flagged here — the `clearForSlug` class from the 260611 calendar-cache postmortem: a doc-commented "recovery path" that no production code ever called. Ratcheted via `KNIP_PROD_EXPORT_BASELINE` / `KNIP_PROD_UNUSED_FILE_BASELINE` (CI-confirmed 453/35 at flip, 2026-06-12), same above-fails/below-warns semantics as layer 2. Two pre-count exemption filters (defined in `knip-diff-guard.ts`, shared with layer 4): seam-**name** pattern (`*ForTesting`/`*ForTests`/`*ForTest`, `_reset*`/`__reset*`, `_testing*`/`_testOnly`/`__test*`) and test-**path** pattern (`__tests__`, `__mocks__`, `test-utils`, `__test_helpers__`, `__fixtures__`, `fixtures`, `*_harness` segments). Types are excluded entirely; duplicates are telemetry-only. `KNIP_PROD_ENFORCEMENT_ENABLED` in `check-knip-health.ts` is the kill switch (flipping it back to WARN mode needs a documented reason).
4. **Diff-scoped new-finding guard** — when a base SHA is available (`BASE_SHA` env or `--base=<ref>`), fails if HEAD introduces a **new** finding **in a changed file**: default-mode unused exports/duplicates AND production-mode unused exports/files (so the next `clearForSlug` fails the gate even while counts stay under baseline). The "before" is *derived* by running Knip at the base commit (both modes in ONE isolated detached worktree with `node_modules` symlinked), **never stored** — so there's no big snapshot to merge-conflict across worktrees. Identity is `kind+file+symbol` (line/col stripped), rename-aware, multiset; the seam/test-path filters apply **symmetrically** to head and base, and default/production findings never cross-cancel (kind is part of the identity). Sentinel: an *empty-by-construction* base production report (0 issues + 0 files = a base `knip.json` without `!` glob suffixes) skips just the production comparison with a loud warning instead of flagging everything as new. This is the kill-by-construction layer for the real accumulation vector: dead code authored in actively-edited files.
5. **Types telemetry** — unused-type count + top files, **report-only**. Not gated: 2,451 findings dominated by barrels and IPC schema surfaces (`src/shared/ipc/schemas/plugins.ts`, `contracts.ts`, `*/index.ts`) — too noisy to gate without config tuning first.

### Production-leg escape hatches (deliberately-not-production-consumed exports)

When the production leg flags an export you are *keeping on purpose*, pick the narrowest hatch — in this order:

- **`/** @internal */`** on the export — for **intentional test seams** (reset/inject/clock hooks consumed only by tests). Knip ignores it in production mode **only**; the default leg keeps tracking it, so the seam still can't go fully dead unnoticed. This is the long-term replacement for the seam-name filter: prefer the tag over contorting a name to match the pattern.
- **`/** @public */`** on the export — for **genuinely-public API** consumed outside the repo's project globs (published packages, plugin surfaces, OSS-mirror consumers). Ignored in **both** modes, so use it sparingly: a `@public` export is invisible to every layer of the gate forever.
- **`knip.json` `ignore`** with a one-line reason — for whole files reachable only via paths Knip can't trace (dynamic dispatch, bundler aliases). Same SSOT-for-false-positives rule as the default leg.

When **NOT** to exempt: an export that production code *should* be calling but isn't (a wired-up-nowhere recovery path, a feature flag's dead branch, an API "for later") — that is precisely the bug class this leg exists to catch. Either wire it to a production caller, or delete it and let the test die with it. Don't `@internal`-tag production API to silence the gate, and never inflate the baselines to absorb a new finding.

**Why count + diff-scoped, not a stored identity manifest:** a count ratchet alone is gameable (remove-1-add-1 nets zero); a full ~3,849-entry identity allowlist would merge-conflict constantly across our 5–7 concurrent worktrees (the `_index_recommendations.yaml` pain). The hybrid gets by-construction prevention for touched code without the snapshot. Full rationale: the planning folder's Decision Log.

**Base-prep failures degrade to a loud non-fatal skip** (not fail-closed): a flaky base-worktree step must not block the whole team's PRs. Real new-finding detection still fails hard; the count ratchet is the always-on floor. (Deliberate operational deviation from the design arbitration — logged in the planning folder.)

## Removing dead code (the safe process)

Knip findings have a high false-positive density. **Never bulk-delete.** Per batch:

1. **Pick a bounded slice** (one subtree / one category). Prefer leaf modules; avoid the false-positive classes below for a first pass.
2. **Classify false positives** — a finding is NOT safe to remove if the symbol is reached by something Knip can't trace:
   - **Barrels / public API** — `*/index.ts` re-exports, `src/shared/ipc/*` contracts, anything that's an intentional external surface.
   - **Dynamic dispatch** — IPC string channels, `import(variable)`, `React.lazy`, registry/string-keyed maps, preload bridges, `vi.mock` targets, ESLint shell-out fixtures, bundler-alias targets. Many are already in `knip.json` `ignore`/`entry`.
   - **Test helpers** — `__test`, `*ForTesting`, builders used only via dynamic wiring.
3. **Grep each symbol** for *all* references, including string literals, before deleting.
4. **Remove**, then **verify end-to-end**: `npm run lint:ts` + targeted `npx vitest run --project=<p> <dirs>` (NOT `vitest related` — it false-greens in this multi-project workspace) + a build (`verify:agent:full`) if anything reachable could be affected.
5. **Lower the baseline** — drop `KNIP_EXPORT_BASELINE` / `KNIP_DUPLICATE_EXPORT_BASELINE` / `KNIP_PROD_EXPORT_BASELINE` / `KNIP_PROD_UNUSED_FILE_BASELINE` to the new count (the gate warns you of the exact number). This ratchets the cleanup in so it can't regress.
6. If a finding is a confirmed false positive (real dynamic consumer), **suppress it in `knip.json`** with a one-line reason — *not* by inflating the baseline. `knip.json` is the SSOT for false positives.

## Follow-ups (deferred, not done here)

- **Production-leg drain** — the production leg's baseline holds ~35 production-path files with zero production consumers (e.g. `src/main/services/toolAliasCache.ts`, a legacy `authTokenStorage.ts` duplicate, `routeEligibility.ts`, `smartGroup.ts`, `tryItPrompts.ts`) and ~453 tested-only/unconsumed exports. Drain incrementally per the process above (high false-positive care: some are dynamic-dispatch surfaces) and gradually `@internal`-tag the ~160-export seam corpus so the seam-name filter can shrink. The ratchet holds the line meanwhile.
- **Knip config noise-tuning** — evaluate `ignoreExportsUsedInFile` (types used only in their own file are a classic FP) and per-surface ignores to improve export/type signal, then re-baseline. This is the natural companion to a burn-down.
- **Gate `types`** once tuning makes the signal actionable (currently report-only).
- **Burn-down** — incremental, following the process above; lower the baselines as you go. A broad one-shot removal was deliberately ruled out (long-tail/false-positive risk).
