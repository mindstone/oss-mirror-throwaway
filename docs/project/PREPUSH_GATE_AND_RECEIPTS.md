---
description: "The pre-push gate, the canonical `npm run gate` command, the shipped speedup levers (validate:fast spawn-tax kill + same-host sync lock + submodule pointer-lag auto-align + push-race auto-retry + knip/vitest overlap), and why the gate-pass nonce is shelved (it doesn't fix the push race)"
last_updated: "2026-06-20"
---

# The pre-push gate, `npm run gate`, and the shelved gate-pass nonce

> **TL;DR**
> - **Run `npm run gate` before you sync.** It is the *exact* pre-push gate. "Green on `npm run gate`" == "green at push time" by construction — no more discovering a gate failure 4 minutes into a push.
> - **2026-06-11: two levers shipped** — the `validate:fast` runner now spawns guard scripts directly (`node --import tsx`) instead of via `npm run` (−~30s, with a committed step-registry baseline so no guard can be silently dropped), and `git-safe-sync` gained a **same-host advisory sync lock** so concurrent local agents queue instead of racing each other's push windows. See [What shipped](#what-shipped-2026-06-11). **Same-day follow-ups**: submodule pointer-lag auto-align + push-race auto-retry — see [Follow-ups](#follow-ups-2026-06-11).
> - The **gate-pass nonce** (`scripts/lib/gate-nonce.ts`) is **shelved/dormant**: built and tested, but **not wired** and **not a push-race fix**. It's kept only as the verification primitive a future **merge-queue** would use. See [Why the nonce is shelved](#why-the-nonce-is-shelved).
> - The push race is now *partially* fixed: same-host races become queued waits, and a **classified cross-machine race auto-retries once** in a fresh run (≤28 of June's 46 losses were cross-machine). A race-shaped exit 40 now means the retry leg also lost, or retry was disabled. Remaining levers are [below](#what-actually-fixes-the-push-race).

This doc is the SSOT for how the pre-push gate is structured and why. Background: this is an AI-first team with **no human PR gate** — `.husky/pre-push` is the only safety net before code lands on the hot shared `dev` branch.

## The gate

Every push to `dev` runs `.husky/pre-push`, in order:

1. **merge-integrity** — detect changes silently dropped by a merge (always runs).
2. **submodule-availability** — every submodule pin is reachable on its remote (always runs).
3. **`validate:fast`** — 136 steps: lint, the per-package `tsc` ratchet (`validate:ts-ratchet`, covering node/renderer/evals/cloud-service/cloud-client/web-companion/mobile/browser-extension), ~115 bespoke `check-*.ts` invariant guards, a few small vitest suites, sub-package builds. The runner resolves `npm run <name>` steps to direct `node --import tsx` spawns at runtime (see [Lever A](#lever-a)); ~110–135s warm on the 2026-06-11 measuring machine (was ~145–165s; machine-dependent, longer cold). Authoritative step list: `npx tsx scripts/run-validate-fast.ts --list`.
4. **tiered `vitest related --run`** — Tier 1 (default) = your own commits' touched files; Tier 2 (`[deploy-beta]`) adds upstream-merged files; Tier 3 (`main`) adds the full fast suite. `[skip-tests]` skips vitest only; the always-on gates (1–3) still run.

### What the gate does *not* cover (align with [CI_PIPELINE.md](CI_PIPELINE.md))

- **Chronic E2E (`npm run test:e2e:chronic`) — not in `.husky/pre-push` / `npm run gate`.** The three chronic packaged specs (`settings`, `quality-tier-selector`, `onboarding-organisation-grouping`) are single-sourced in the `test:e2e:chronic` npm script and **block beta publish in CI** (`release.yml` → `chronic-e2e-staleness` is in `publish-to-gcs.needs` since 2026-06-12 — a failure skips the artifact). Locally they are **runbook-mandatory before a beta push**, not husky-blocking: [RELEASE_TO_BETA.md §5.1](RELEASE_TO_BETA.md#51-pre-push) (run after `preflight:desktop-packaged-boot` so the subset reuses the packaged `out/` build). The full `test-e2e` job still does not block publish.
- **`validate:knip-health` — CI / `verify:agent`, not pre-push.** See [DEAD_CODE_DETECTION_AND_REMOVAL.md](DEAD_CODE_DETECTION_AND_REMOVAL.md).
- **Packaged boot-smoke, live-API tier, platform builds, Windows signing** — release-only; see [RELEASE_TO_BETA.md §5.1](RELEASE_TO_BETA.md#51-pre-push) and [CI_PIPELINE.md § E2E gating criteria](CI_PIPELINE.md#e2e-gating-criteria).

**Inside `validate:fast` (relevant 2026-06-18 hardening):**
- **ESLint audits** (`validate:eslint-warnings`, `validate:eslint-new-warnings`) pass `--no-warn-ignored` via `scripts/lib/eslint-warning-audit.ts` (`ESLINT_AUDIT_ARGS`) so ESLint's benign **"File ignored because no matching configuration was supplied"** meta-warnings on intentionally out-of-scope paths (e.g. `scripts/__tests__/**`, `__lint_fixtures__`) are not counted in the warning ratchet or diff-scoped new-warnings guard.
- **Session-store fs fan-out bounds** — defense-in-depth against libuv-threadpool saturation: the four formerly unbounded `Promise.all` filesystem fan-outs in `src/core/services/incrementalSessionStore.ts` (load, prep, write, asset-quota) now use `mapWithConcurrencyLimit` capped by `SESSION_STORE_FS_CONCURRENCY` (8). Complements the DNS-off-pool fix documented in [RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md](RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md); plan: `docs/plans/260617_session-store-fanout-bound/PLAN.md`.

> **Reading a `validate:fast` failure during sync (2026-06-14).** When `validate:fast` fails inside `git-safe-sync`, the runner now prints a `validate:fast FAILED` banner naming the **failing step** plus its rerun hint, and git-safe-sync surfaces that step instead of the old opaque "incomplete" message (commit `5c888190`). On a validator failure, scroll for that banner to get the step name + the `npm run …` command to reproduce it locally — don't treat the sync as a mysterious hang. (Captures from these guards must route through `scripts/lib/git-exec.ts` `gitCapture`, or git-safe-sync mislabels the hook failure as "validate:fast incomplete".)

## `npm run gate` — the canonical command (run this before you sync)

```bash
npm run gate
```

`gate` is literally `sh -e .husky/pre-push </dev/null` — it runs the **identical** gate the hook runs at push time, against your current `HEAD` vs `@{u}`. There is exactly one implementation (the hook); `gate` invokes it, so the two can never drift.

**Why this exists.** Agents used to run *lighter* local checks during development (`vitest related`, `tsc -p tsconfig.node.json`) that did not match the full gate. Failures only the gate catches — e.g. a `cloud-client` *test*-tsconfig error caught solely by `validate:ts-ratchet`, or a `no-silent-swallow`/escape-hatch ratchet — then surfaced only at push time, ~4 minutes in, often after also losing a push race. Running `npm run gate` (or letting the [CHIEF_ENGINEER2 Closer](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/specialists/closer.md) run it) surfaces those *before* the sync.

The CE2 Phase 8 Closer should run `npm run gate` as its full-validation step.

<a id="what-shipped-2026-06-11"></a>
## What shipped (2026-06-11): spawn-tax kill + same-host sync lock

Two levers from the deferred list below landed via CHIEF_ENGINEER2 (heavy; plan + full decision log: `docs/plans/260611_prepush-gate-speedup/PLAN.md`). They were sized against measured data, per this doc's own "measure first" instruction:

**June baseline (git-safe-sync timing logs, 208 syncs / 11 days / ~5 machines):**
- Gate (`push:validate-fast`) median **140s solo, 182s when another sync overlapped on the same host** — same-host contention alone inflated the gate ~30%.
- **46/208 syncs (22%) lost the push race after full validation** (exit 40), burning ~12h of wall-clock in 11 days. Attribution: **18/46 had a same-host overlapping sync** (a lower bound — hostname aliasing and unlogged winners undercount), 28 cross-machine or unknown.
- A successful sync averaged 189s end-to-end — the gate is essentially the whole sync.

<a id="lever-a"></a>
### Lever A — `validate:fast` cheap-spawn resolution + step-registry baseline

The step runner (`scripts/run-validate-fast.ts`) resolves each `npm run <name>` step against `package.json` **at runtime**: if the script body matches a conservative argv-token classifier (exactly `[npx] tsx scripts/<x>.ts [simple args]` / `node --import tsx …`; tool/flag denylists; no shell operators; no `pre`/`post` lifecycle hooks), it spawns `node --import tsx scripts/<x>.ts` directly — skipping the npm+npx launch tax (~0.9–1.3s/step → ~0.4s). Everything unclassifiable runs verbatim through the old path (fail-open to today's behavior). **127/136 steps transform**; the 9 fallbacks are exactly the flagged/vitest/build commands. `package.json` stays the single source of truth — rerun hints are unchanged, so `npm run validate:<x>` still works standalone; `node_modules/.bin` is prepended to the spawn PATH for env parity. Failure banners print a `ran:` line with the actual executed command, and the timing artifact (`.local/validate-fast-timings.json`) records `resolved_command` per step.

**Measured (same machine, same worktree, warm): 165.4s → 134.1s (113.7s fully warm); per-step median 739ms → 379ms.**

**The protection net — step-registry + classifier baselines (always-on, live inside `validate:fast`).** Two committed baselines guard against drift:

- `scripts/validate-fast-step-baseline.json` — step identities (`script` file, literal `command`, or `group-member` for guards inside `validate:testing-guards`). A vitest test (`scripts/__tests__/validate-fast-step-registry.test.ts`) asserts **set-equality both directions** between the live STEPS and the baseline.
- `scripts/validate-fast-classifier-baseline.json` — per-script classifier verdicts for every `package.json` script (`"transform → node --import tsx …"` / `"fallback (<reason>)"`).

Both baselines are checked by `validate:step-registry` (= `--check-step-baseline`), which is **wired as a step inside `validate:fast`** itself. This means:
- **No snapshot file, no vitest** — the check runs directly via the `run-validate-fast.ts` runner, making it reachable on every push regardless of which files changed.
- **Silently dropping, renaming, or repointing a guard** OR **adding/changing a `package.json` script without regenerating the classifier baseline** fails the gate by construction.
- The `--check-step-baseline` mode is an early-return path (never enters the `STEPS` loop), so the self-referential wiring is safe — no recursion.

> **Baseline-edit protocol (when intentionally adding/removing/repointing a guard or changing a `package.json` script):** regenerate both baselines **in the same commit as the change**, so reviewers see the diff lines next to what justifies them:
> ```
> npx tsx scripts/run-validate-fast.ts --write-step-baseline
> npx tsx scripts/run-validate-fast.ts --write-classifier-baseline
> ```
> A red `validate:step-registry` step means a guard identity or classifier verdict changed — never rubber-stamp the baseline without stating which guard and why; removing a line from the step baseline means an invariant that was checked on every push is checked no longer.

### Lever B — same-host advisory sync lock in `git-safe-sync`

`scripts/lib/same-host-sync-lock.ts`, wired into `scripts/git-safe-sync.ts`. One lock per machine per remote: `~/.cache/rebel-git-safe-sync/<sha256(normalized origin URL)>.lock`. Acquired **immediately before `gatherDiagnostics()`** — the sync's only fetch happens after acquisition, so the "re-fetch for freshness after waiting" requirement (deferred lever 4 below) holds **by construction**, with zero extra round-trips. Released ownership-checked (UUID match) in `execute()`'s `finally`.

- **Staleness = PID-liveness, not mtime**: holder is live iff `kill(pid, 0)` succeeds ∧ `ps` stat ≠ zombie ∧ the command line contains the `git-safe-sync` token (covers SIGKILL, zombies, and PID reuse). An mtime-heartbeat lock (e.g. `proper-lockfile`) was rejected because git-safe-sync blocks its event loop for **minutes** inside `execSync('git push …')` — it would go falsely stale and be stolen mid-push, exactly when protection matters most. Takeover of a stale lock is rename-arbitrated **and identity-verified** (a fresh winner's live lock can't be displaced; mismatches restore it).
- **Wait UX**: polls ~2s; every ~15s prints the holder's pid, argv, lock age, and the lock-file path, plus recovery hints (`kill <pid>` / delete the file / `--no-lock`). Sitting minutes in `sync-lock: waiting for pid N …` is the lock **working**, not a hang.
- **Budgets & escape hatches**: max wait 20 min ±10% jitter (`GIT_SAFE_SYNC_LOCK_MAX_WAIT_MS`); `--no-push` runs get a short ~90s cap (`GIT_SAFE_SYNC_LOCK_NOPUSH_WAIT_MS`) — prophylactic merges shouldn't queue behind a pushing peer's gate; `--dry-run` / `--diagnostics-only` skip the lock entirely; `--no-lock` / `GIT_SAFE_SYNC_NO_LOCK=1` opt out. **Every failure path fails open** (timeout, lock-module error, unresolvable remote): the lock is advisory — it degrades to pre-lock racy behavior and can never block a sync or lose work.
- **Signal handling is scoped to the lock-wait phase only**: a SIGINT/SIGTERM while *waiting* releases the lock, writes a timing log, and exits 130/143 (so a Bash-tool timeout killing a queued sync is safe and observable). Once acquired, default disposition is restored — a mid-sync kill behaves exactly as before the lock existed (immediate death, no timing log; the dead holder's lock is reclaimed by staleness within ~one poll).
- **Telemetry**: a `lock-wait` span lands in the sync timing log on every path (acquired / skipped / timeout / error), so the next measurement pass can quantify queueing directly.

**Known residuals (deliberate, documented — not bugs):**
- Takeover has a narrowed (microsecond-scale) TOCTOU window plus a restore-collision path: **rare under production polling** (2s poll, multi-minute holds; even a deliberately adversarial 25ms-poll stress harness reproduces it only occasionally), and **loud when it happens** — the displacing waiter logs `RESTORE COLLIDED` and the displaced holder runs that one sync unserialized (advisory degradation only). **Tripwire**: `RESTORE COLLIDED` in a sync transcript, or `restore collision(s)` in a `lock-wait` span note in the timing logs. **On recurrence**: don't bump test bounds — the recorded next step is takeover-intent arbitration (a `wx`-created `.takeover` marker serializing the verify→rename section); design note in the Stage-4 round-3/4 implementer reports under `docs/plans/260611_prepush-gate-speedup/subagent_reports/`.
- A SIGKILLed holder's `git push` child can outlive it; the waiter that takes over is warned a lost-race exit 40 remains possible.
- Old checkouts run the old script and don't lock — effectiveness converges as worktrees pull (rollout caveat).
- The lock home is in the invoking user's homedir, so it serializes **per user-account per machine** — multiple users on a shared VM won't contend with each other, by design.
- Cross-machine races are untouched by the lock — the [auto-retry follow-up](#follow-ups-2026-06-11) absorbs most of their cost; the structural levers remain below.

**End-to-end validation (2026-06-11, two-real-push concurrency spike):** two concurrent real syncs pushed to `dev` from the same machine. The loser queued **231s** behind the winner with correct holder telemetry in its wait output, then merged the winner's freshly-landed commit in **0.4s** and pushed. **Both commits landed; zero exit-40.** This closes the "first real contended sync" verification the Phase 7 review left outstanding.

<a id="follow-ups-2026-06-11"></a>
### Same-day follow-ups — submodule pointer-lag auto-align + push-race auto-retry

Two `git-safe-sync` behaviors landed the same day via a CHIEF_ENGINEER2 amendment (spec + critique record: `docs/plans/260611_prepush-gate-speedup/PLAN.md` Stages 6–7).

**Submodule pointer-lag auto-align (pre-safety phase).** Kills a recurring friction class: after a *manual* conflict-resolution merge commit, submodule checkouts lag the newly-committed pins and the next sync used to abort "Superproject has uncommitted changes" until a human ran `git submodule update --init --recursive`. Now an explicit pre-safety phase (Step 4b in `runSyncBody`; classifier in `scripts/lib/submodulePointerLag.ts`) auto-aligns when — and only when — **every** dirty superproject entry is a provably-safe pointer-lag, meaning ALL of:

- the path is a `.gitmodules` submodule whose index entry is gitlink (mode 160000), with **no staged pointer change**;
- the submodule worktree is **clean** (untracked included) with **no merge/rebase/cherry-pick in progress**;
- the checkout HEAD is a **strict ancestor** of the committed pin (the pin moved *forward* past a lagging checkout — the manual-merge signature; checkout-AHEAD, backward-moved pin, and diverged all block, each with its own abort copy);
- the submodule is detached or on its expected `.gitmodules` branch;
- the committed pin is **verifiably reachable from the submodule's tracked remote branch** (shared `classifyPin` logic, offline against the sync's own seconds-old fetch; unverifiable = blocked, fail-closed).

On align: one loud note per submodule (`path`, `fromSha → toSha`), diagnostics re-gathered once, and strategy/safety computed from the fresh state. The phase runs **at most once** (straight-line, no loop). **Anything failing any condition aborts as today — with corrected copy**: a lag entry is never told "commit your changes" (committing a lagging pointer is a pin regression); a checkout-AHEAD entry is explicitly told *not* to run `submodule update` and to commit the pointer bump instead. `--dry-run` classifies (so the copy is right) but never mutates. Telemetry: a `submodule-lag-align` span + aligned-paths note in the timing log.

**Push-race auto-retry (self-respawned retry leg).** Automates what the runbook used to instruct manually on a lost cross-machine push race. Classification is **structural, never substring** (`scripts/lib/push-race-retry.ts`): a race requires BOTH (a) a qualifying per-ref rejection status-line shape — either git's plain non-FF `! [rejected] … (non-fast-forward|fetch first)`, OR a `! [remote rejected] … cannot lock ref … is at X but expected Y` compare-and-swap (CAS) miss (the protected-branch race GitHub routes through `[remote rejected]` when the branch has a PR ruleset we bypass). Generic `[remote rejected]` (push-protection / hook / GH013 policy declines) stays **non-race**; the CAS exception is anchored to its own status line so pre-push hook stderr that merely echoes the phrase can't trip it. AND (b) **verified remote-moved evidence**: for non-FF, the untouched remote-tracking ref vs one post-failure `ls-remote`; for CAS, the SHAs embedded in the reason (`is at` vs `expected`) are preferred (atomic, no TOCTOU), falling back to `ls-remote`. Either tip unresolvable ⇒ unknown ⇒ no retry (fail-closed). On a classified race the script prints a loud `LOST PUSH RACE — RETRYING ONCE IN A FRESH RUN` banner (old → new tips) and **re-execs itself once** with `--retry-leg`: leg 1 releases the lock and finalizes its timing log normally first, so the retry leg is an ordinary fresh sync — fresh lock acquire, fresh diagnostics (including the alignment phase above), fresh autostash semantics; re-merge conflicts exit 20 as today. Depth-guarded (`GIT_SAFE_SYNC_RETRY_DEPTH`); **default-ON** with opt-outs `--no-retry` / `GIT_SAFE_SYNC_NO_RETRY` (any non-empty value); a run that created an autostash never retries (conservative). **Exit codes unchanged**: the retry leg losing again exits 40 with today's guidance.

> **Tripwire accounting (important):** a retried-and-won race **no longer appears as exit 40**. Leg 1 records a `push-retry: lost race <old>→<new>; spawning retry leg` note (and a `NOT retrying (<reason>)` note when the decision declines), and the retry leg is tagged via `--retry-leg` in its logged argv. Any cross-machine race analysis — including the w/c 2026-06-18 tripwire pass — must count **residual exit-40s PLUS `push-retry` notes** in the timing logs: a retried-won race is still a cross-machine race event. Counting raw exit-40s alone undercounts races from 2026-06-11 onward.

In-process batching of trivial guards (recovering the remaining ~0.35s/step tsx-boot floor) was specced and **deferred behind a tripwire**: after ~1 week of lock telemetry, if same-host `lock-wait` p75 > ~90s OR the quiesced gate median is still > ~110s, arm it. **Compute that p75 over push runs only** (exclude runs whose timing-log `args` contain `--no-push`): no-push syncs deliberately cap their wait at ~90s, so including them would false-arm the tripwire on designed behavior. The same tripwire pass also measures the **cross-machine race residue** — count residual **exit-40s PLUS `push-retry` notes** (see [Tripwire accounting](#follow-ups-2026-06-11)); a retried-won race is still a race event, just one that no longer costs a manual re-run. Spec + extra requirements (ordering audit, flattened group-member baseline): `docs/plans/260611_prepush-gate-speedup/PLAN.md` Stages 2–3 + Amendments.

> **Tripwire evaluated + armed 2026-06-18** (`docs/plans/260618_git-safe-sync-speedup/`): same-host `lock-wait` p75 (push runs) measured **~0–18s** (does NOT trip — the 06-11 lock + auto-retry largely fixed same-host contention; exit-40s fell 43→2 over June), but the **quiesced gate-median arm IS met** (real-world aggregate ~150s > 110s). Guard batching shipped as a **pilot**: a shared in-process group runner (`scripts/lib/guard-group-runner.ts`) + the first themed group `validate:source-policy-chokepoints` (11 import-safe guards, ~8s saved). The remaining themed tranches (registry-parity / mcp-connector / docs-process / hygiene; ~107 more guards, incl. the Bucket-B `run()` refactors and the B1 flag-coupled trio) are a follow-up using the proven runner + the batchability audit in that folder.

## Why the nonce is shelved

The intuition was: run the gate **once before** the push (outside the push "lock"), record a tree-bound proof, and let the in-lock hook fast-path. We built it (`scripts/lib/gate-nonce.ts`, `scripts/check-gate-nonce.ts`, 18 unit tests; the hook consults it only when `$REBEL_PREPUSH_GATE_OK` is set). Then we realised it **does not shrink the race**:

- The push-race window is `[fetch origin/dev] → [our ref lands]`. A push is rejected non-fast-forward if origin/dev moves inside that window.
- Safety requires validating the **exact merged tree** = *our work + latest origin/dev*. That tree exists only **after** the post-fetch merge — so the ~4-min validation is **irreducibly inside the window**.
- The nonce merely moves those 4 minutes from "inside the hook" to "inside git-safe-sync's pre-validate" — both inside the same window. Window length and per-retry cost are unchanged.
- On a hot branch every push re-merges the latest origin/dev, so the pushed tree differs from any earlier-validated tree → the nonce misses. A lost race forces a re-merge (new tree) → full re-validate.

So the nonce only "helps" the no-merge / no-contention push — exactly the case with no race. It is therefore **dormant**: the hook skips the check entirely unless `$REBEL_PREPUSH_GATE_OK` is set (nothing sets it), so normal pushes pay zero extra cost. The verified code stays in-tree because it is precisely the verification primitive a **merge-queue** needs.

*(This reversed an earlier confident "receipts shrink the lock to seconds" claim. The Devil's Advocate flagged it during plan critique; an Arbitrator and two GPT-5.5 final reviews confirmed it. Full reasoning: `docs/plans/260607_prepush-receipt-gate/PLAN.md`.)*

> **⏳ Time-box (review F1, GPT-5.5 arch).** Dormant code inside the only safety net ages poorly. This nonce is justified *only* as a merge-queue primitive. **If a merge-queue plan has not started by ~2026-09 (≈3 months), delete the fast-path block from `.husky/pre-push` and the `gate-nonce.ts`/`check-gate-nonce.ts` files** — the design lives here and in git history and can be rebuilt when a queue actually owns it. Don't let an unowned dormant fast-path linger indefinitely.

## What actually fixes the push race

Originally written 2026-06-07 as an all-deferred list (Greg: "write it up… but let's not do it right now"). **Status 2026-06-11: partially executed** — [What shipped](#what-shipped-2026-06-11) above delivered two levers: **same-host serialization** (a per-machine scope of lever 2, killing the 18+/46 same-host losses and the 140s→182s same-host gate inflation) and a **by-construction variant of lever 4** (the lock is acquired before the sync's only fetch, so every validated tree is post-lock-fresh). The spawn-tax kill additionally shrank the race window itself (~–30s of gate). What remains below is the spec for the **cross-machine** residue (≤28 of June's 46 losses) and further gate-time cuts. In rough leverage-to-effort order:

### 1. Cut gate time — incremental `tsc` for `validate:ts-ratchet` — **SHIPPED 2026-06-18**

`validate:ts-ratchet` was the single largest gate slice (cold full-project `tsc` per project, no cache). It now uses a defensively-keyed `.tsbuildinfo` cache for **local** runs (`scripts/check-typescript-errors.ts` `tsBuildInfoPathFor`). **Measured: full ratchet cold 47.3s → warm-reuse 17.3s (~30s); node project 31.6s → 4.7s.** Plan + reviews: `docs/plans/260618_git-safe-sync-speedup/`.

**The trap (the whole risk):** a `.tsbuildinfo` cache mis-keyed or shared across worktrees / branches / lockfile changes would let `tsc` skip files it should re-check → **silently weaken the type gate**. How the shipped design closes it:
- **TypeScript's own invalidation is the primary defense:** the `.tsbuildinfo` records a per-file hash + compilerOptions + the compiler version, re-checks any changed file (and dependents), and discards an incompatible cache. A make-or-break regression test (`scripts/__tests__/ts-ratchet-incremental.test.ts`) proves an error injected into a previously-clean file with a WARM cache present is still caught.
- **Defensive keying (belt-and-suspenders):** cache path = `sha256(tsconfig abs path + TS version + lockfile hash)` under gitignored, per-worktree **`.local/ts-ratchet/`**. Distinct projects/lockfiles ⇒ distinct files. (tsc's own option/version embedding makes filename-keying the resolved compilerOptions unnecessary.)
- **CI stays COLD** (`tsBuildInfoPathFor` returns null under `CI`/`GITHUB_ACTIONS`): CI is the authoritative cold backstop on every dev push, so local incremental is a speed optimization, never the last line of defense. A killed mid-write `.tsbuildinfo` is not trusted (tsc rebuilds; a no-error non-zero exit fails closed). Escape hatch: `TS_RATCHET_NO_CACHE=1`.
- Shipped via CHIEF_ENGINEER2 (heavy); GPT-5.5 cross-family review traced tsc's build-info invalidation in node_modules: SHIP, conf 90, regression_risk low.
- Route through CHIEF_ENGINEER2 (heavy) with **adversarial review focused on the invalidation logic**, and a test that proves a stale cache cannot hide a real error (introduce an error in an un-touched file, confirm the gate still catches it).

### 1a. Per-guard hot-spot fixed; `validate:fast` parallelism evaluated + **SHELVED** (2026-06-19)

A heavy CHIEF_ENGINEER2 pass (full record + 5 subagent reports: `docs/plans/260619_validate-fast-parallel/`) chased further gate-time cuts. Outcome:

- **SHIPPED — `validate:bts-prefix-decoder-rule` minimal-config fix.** That guard (a self-test for the `bts-flow-shape/no-raw-bts-model-read` rule) was booting the **entire** repo ESLint config (`new ESLint({ overrideConfigFile: eslint.config.mjs })`) just to `lintText` 4 tiny snippets — **2.2 GB RSS / 5.4s**, the single hungriest guard (it ballooned to ~37s under concurrent load). It now builds a minimal flat config registering only that one plugin+rule, with `files`/`ignores`/severity/parser sourced from a shared SSOT (`eslint-rules/bts-raw-read-config.mjs`) that `eslint.config.mjs` also consumes → **0.3 GB / 0.6s**. Detection preserved by construction (reference-identity drift test asserting the production block uses the SSOT objects + a full-vs-minimal verdict-parity test + exact-allowlist snapshot). Lesson for future per-guard hot-spots: a guard that constructs a full `ESLint`/`tsc`/`madge` engine to check a tiny input is the pattern to look for.
- **SHELVED — lane-classified bounded parallelism of `validate:fast` (do not re-propose without new evidence).** The design was sound (declared-order barrier scheduling preserves first-failing-step-in-declared-order), but **~45–48% of the gate is an unparallelizable serial lane** (the eslint set sharing `node_modules/.cache/eslint`, `validate:ts-ratchet`'s `.tsbuildinfo`, `validate:circular-deps`/madge, builds, the vitest steps, `check:oss-surface`). Barrier scheduling therefore tops out at a realistic **~1.3x (≈25%), saturating at N≈3** — not the "~halve" first hypothesised. Net-new concurrency machinery (worker pool, per-step output capture, child-registry signal handling) in the **only** pre-merge gate was judged not worth a ~25% win.
- **DROPPED — batching the remaining import-safe guard tranches** (the line-110 "remaining themed tranches… follow-up"). Attempted: only ~16 of the candidate ~48 were genuinely batchable (the rest hit a TS6307 cascade — `scripts/groups/**` is type-checked, so a batched guard's whole import closure must live in `tsconfig.node.json` — plus open-handle / flag-coupling constraints). Measured win **~3.5s, within run-to-run noise**, for 18 files of churn including two safety meta-gates. Not worth it; the line-110 follow-up is considered closed unless a future measurement justifies revisiting.
- **DEFERRED — diff-scoping the two fattest repo-wide steps.** `validate:circular-deps`: a deletion/rename can make an *unchanged* import resolve into a new cycle with no edited file in the changed set, so a local diff-scope is a local-green/CI-red soundness hole on a no-PR gate. `check:oss-surface`: it is the OSS **leak** gate — a false-green leaks private data publicly, an asymmetric failure mode ~12s doesn't justify. Both would need their own focused effort with a provably-complete full-mode trigger set (incl. the file-operation class for circular-deps).

### 1b. knip dead-code gate overlapped with vitest at push time — **SHIPPED 2026-06-19**

`validate:knip-health:fast` (the dead-file/unused-export check) now runs **concurrently with the tiered `vitest related` phase** in `.husky/pre-push` rather than serially, recovering its wall-clock when the vitest scope is small. It is spawned in the background just before the vitest phase and **joined right after** — fail-closed (a non-zero knip exit fails the push). It is deliberately overlapped with the **light** vitest phase, not the tsc-heavy `validate:fast` phase: knip peaks ~3.8 GB (whole-repo TS import graph), and `validate:fast`'s parallel-`tsc` peak already exceeds vitest+knip, so overlapping vitest does **not** raise the gate's peak RAM on low-RAM machines (overlapping `validate:fast` would). It is **path-filtered** — knip only runs when the push touched `*.ts`/`*.tsx`/`knip.json`/`package.json` (CI's `knip-health` job is the backstop) — and the background process + its temp log are reaped via an `EXIT` trap if the hook exits early (e.g. vitest fails under `sh -e`). Plan: `docs/plans/260619_knip-prepush-parallel/PLAN.md`.

> Note: knip dead-code is still a **dev-checks / `verify:agent` CI** gate, not a hard pre-push blocker for unchanged-path pushes (see [DEAD_CODE_DETECTION_AND_REMOVAL.md](DEAD_CODE_DETECTION_AND_REMOVAL.md)) — the overlap above is the in-hook fast variant gated on relevant path changes.

### 1c. Subject-line commit-marker detection + stacked dual-retry guard — **SHIPPED 2026-06-19**

Two correctness hardenings that ride in `validate:fast` / the hook:

- **Subject-line-only marker detection.** `[deploy-beta]` / `[skip-tests]`-style markers in `.husky/pre-push` (which pick the vitest tier / skip vitest) are now matched against the commit **subject** line only, never the body — so a prose mention in a commit body can't skip tests or pick the wrong tier (the matching `beta-deploy-trigger.yml` fix prevents a body mention triggering a real beta deploy). An anti-rot guard (`scripts/check-commit-marker-detection.ts`, batched into `validate:fast`) asserts the gating sites read `--pretty=%s` / subject-only and fails if "simplified" back to whole-message matching. See [CI_PIPELINE.md § Beta builds](CI_PIPELINE.md#beta-builds-opt-in).
- **Stacked dual-retry anti-pattern guard.** `scripts/check-provider-proxy-retry-stacking.ts` (in `validate:fast`) requires every provider-proxy client construction in `clientFactory.ts` to make an **explicit, reviewed `maxRetries` decision** — either participate in a `maxRetries: 0` decision (delegating retries to our own `runWithRetry`) or carry a documented exemption. It prevents silently re-creating the offline-hang retry storm where an SDK client inherited the default `maxRetries` (~2) *on top of* `runWithRetry`'s retries. A new `is<Name>Proxy` discriminator fails the gate until the author makes (and documents) that decision.

### 2. Merge-queue / cross-machine serialization (the structural fix — option (b))

Eliminates the race by construction: one validated writer advances `dev` at a time. Biggest change — and **where the shelved nonce finally earns its place** (serialize → validate the queue-head tree once → use the nonce to fast-path that one push). The 2026-06-11 same-host lock is the per-machine scope of this lever; the cross-machine version (remote lock or true queue) is the reserve lever if cross-machine race events persist in the lock telemetry (count exit-40s **plus** `push-retry` notes — auto-retried races still burn a full re-validate each). *(The nonce's ~2026-09 delete-by time-box above is unaffected by the same-host lock — only a real merge-queue plan stops that clock.)*

### 3 / 4. Cheaper backstops

- **Accept races + retry** — **AUTOMATED 2026-06-11**: the script itself retries once on a classified cross-machine race (see [Follow-ups](#follow-ups-2026-06-11)); a manual re-run is needed only when the retry leg also loses or retry was disabled. Same-host losses queue instead.
- **Cheap freshness pre-check** in `git-safe-sync` — **SHIPPED 2026-06-11** as a stronger by-construction variant: the same-host lock is acquired *before* the sync's only fetch, so a waiter that queued for minutes always validates against the just-pushed tip rather than a stale one. No separate pre-fetch needed.

**Before investing further: measure (done once, repeat after soak).** The git-safe-sync timing logs (`<Shared drives/Product>/git-safe-sync-logs/`) record push outcomes + spans — the June 2026 analysis above is the worked example, and the new `lock-wait` span makes same-host queueing directly measurable. Re-run the analysis after ~a week of lock soak before reaching for (1) or cross-machine (2).
