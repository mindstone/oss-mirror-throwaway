---
description: "Scenario router for agent UI testing: choose the cheapest reliable Rebel validation path before launching Electron"
last_updated: "2026-06-11"
---

# Agent UI Testing

This is the routing index for validating Rebel UI and runtime behavior with low token burn. "100% reliable" means first-attempt success on the validated paths below, and bounded failure cost everywhere else; it is not an absolute guarantee.

## Scope

This router covers **isolated / managed** run-and-capture mechanics: it spins up its own Rebel instance (standalone CLI, scripted dev-CDP, packaged drive, e2e) and screenshots that. It is *not* the authority on design judgment or on what counts as valid visual evidence.

For visible-UI work submitted for design review, the **source of truth is the user's live dev app**, not a managed instance — design review explicitly rejects isolated/spawned-app captures as evidence for the current dev-app UI. The live-app capture path (`electron_connect_existing_app` at `debug_port: 9222`, the bundled `scripts/capture-rebel-dev-screenshot.ts`, or in-app `rebel_navigate_app` / `rebel_get_app_screenshot`) and the evidence-validity rules (both themes, before/after, real surface) are owned by the design surfaces, not here: see the **Visual Evidence Rules** in [PROJECT_OVERRIDES](PROJECT_OVERRIDES.md) and the Chief Designer guidance in [`rebel-system/skills/ux/chief-designer/SKILL.md`](../../rebel-system/skills/ux/chief-designer/SKILL.md) (Cursor: `.cursor/rules/CHIEF_DESIGNER.mdc`).

## Hard Rules

1. Preflight first for launch-class recipes (full mode); `--quick` for CLI/static tiers. A preflight FAIL does not consume a launch attempt -- fix the finding first.
2. ONE launch attempt + ONE retry, then STOP and report. Before any retry: save/quote the failure payload's embedded output tail (the failure response already contains it); never call `logs` to re-fetch it; if the retry fails, report with BOTH tails.
3. Readiness polling: fixed 2s interval, max 60 polls (120s; matches the cold-start budget); then STOP and report. Scripted paths embed this; the rule binds MCP/Factory paths.
4. Max 2 screenshots per verification step (before/after); needing a third means stop and report.
5. Wall-clock breaker: elapsed > 2x the quoted budget for the recipe -> stop and report.
6. One bounded log read (tail ~20 lines); no progressive pulls.
7. Never kill processes you didn't start.
8. Temp `REBEL_USER_DATA` always (standalone CLI); isolated userData always (launch paths).
9. Max ONE ad-hoc real API turn per session without user approval -- scoped to ad-hoc verification turns; does not forbid self-budgeted suites (`npm run eval`, keyed e2e, `MCP_REBEL_CLI_TESTING` flows).

## Decision Tree

Ask at most these three questions, then run the leaf.

1. Can you validate without launching Electron?
   Static/contracts: `npm run -s test:preflight -- --quick` then `npm run -s validate:fast > /tmp/rebel-validate-fast.log 2>&1; tail -40 /tmp/rebel-validate-fast.log`.
   Targeted unit/integration: `npx vitest run <test-file>`, then `validate:fast` before handoff.
2. Is this a headless runtime, agent-turn, or MCP-shape check?
   Standalone Rebel CLI: build once, then use the one-liner below.
   MCP shape only: `npm run -s test:mcp:smoke`.
   Live connector smoke using real GUI OAuth: use [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) and the Electron-backed CLI; this path has never been live-validated by this guide's battery — treat its budget as an estimate.
3. Is this UI behavior?
   Design-review evidence (visible UI you'll submit for design judgment): the source of truth is the user's live dev app, not a managed launch — see Scope above and CHIEF_DESIGNER. The leaves below are for isolated/managed verification only.
   Deterministic packaged surface or approval seed: `npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/x.png`.
   Interactive HMR/CDP: `npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive`, then `npx tsx scripts/ui-test/screenshot.ts --out /tmp/x.png`.
   Factory session with `rebel-electron` MCP registered: MCP tools are allowed; otherwise use the scripted CDP tier.
   Regression suite: `npm run test:e2e`.
   Onboarding/first-run regression: `tests/e2e/onboarding.spec.ts`; interactive: `npx tsx scripts/ui-test/launch-rebel-test.ts --seed-onboarding-incomplete --keep-alive`. Onboarding schema is in flux; cross-check `docs/plans/260611_coach-chat-onboarding-regression/`.

Stop and escalate, because no reliable recipe exists here: licensing-gated behavior, BTS managed-key routing, embedding quality, live microphone/STT, deeplink cold-launch, auto-update, GUI OAuth acquisition, window/dock/tray lifecycle.

Standalone CLI live-turn one-liner, with temp profile, `coreDirectory`, and exact auth export:

```bash
node scripts/rebel-cli/build.mjs && TMP_UD="$(mktemp -d)" && mkdir -p "$TMP_UD/test-workspace" && TMP_UD="$TMP_UD" node -e 'const fs=require("fs");const p=process.env.TMP_UD;fs.writeFileSync(`${p}/app-settings.json`,JSON.stringify({coreDirectory:`${p}/test-workspace`,onboardingCompleted:true,indexingEnabled:false,memoryUpdateEnabled:false},null,2))' && source .env.local && export REBEL_ANTHROPIC_API_KEY="${REBEL_ANTHROPIC_API_KEY:-$ANTHROPIC_API_KEY}" && REBEL_USER_DATA="$TMP_UD" node scripts/rebel-cli/dist/rebel.js run --no-mcp --json -p "Reply with exactly one word: pong"
```

## Human Quick Start

```bash
npm run test:preflight
node scripts/rebel-cli/build.mjs && TMP_UD="$(mktemp -d)" && mkdir -p "$TMP_UD/test-workspace" && TMP_UD="$TMP_UD" node -e 'const fs=require("fs");const p=process.env.TMP_UD;fs.writeFileSync(`${p}/app-settings.json`,JSON.stringify({coreDirectory:`${p}/test-workspace`,onboardingCompleted:true,indexingEnabled:false,memoryUpdateEnabled:false},null,2))' && source .env.local && export REBEL_ANTHROPIC_API_KEY="${REBEL_ANTHROPIC_API_KEY:-$ANTHROPIC_API_KEY}" && REBEL_USER_DATA="$TMP_UD" node scripts/rebel-cli/dist/rebel.js run --no-mcp --json -p "Reply with exactly one word: pong"
npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive
npx tsx scripts/ui-test/screenshot.ts --out /tmp/rebel-dev.png
npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/x.png
npm run test:e2e
```

## Budget Table

Measured 2026-06-11 on a dev machine with warm caches, Node v25.8.2. Budgets older than 90 days are estimates.

| Path | Command | Warm budget | Cold budget | Validated | Notes |
|---|---|---:|---:|---|---|
| Preflight | `npm run test:preflight`; `npm run test:preflight -- --quick` | full 0.4s; quick 0.3s | same | 2026-06-11 | Full exit 0 can include WARN and ~13KB; quick is a 1-line summary plus any WARN details. |
| Static tier | `npm run validate:fast` | 3m20s | same | 2026-06-11 | 684KB output; redirect to file and tail. |
| CLI build/free | `node scripts/rebel-cli/build.mjs`; `REBEL_USER_DATA=$(mktemp -d) node scripts/rebel-cli/dist/rebel.js --no-mcp sessions list` | 0.8s; 0.5-0.6s | few s; same | 2026-06-11 | Temp `REBEL_USER_DATA` mandatory. |
| CLI + Super-MCP free | same without `--no-mcp` | 1.0s | ~2s | 2026-06-11 | Spawns on a free port, tears down, zero API spend. |
| CLI live turn | one-liner above | 5.6s | same | 2026-06-11 | Requires seeded `coreDirectory`; assert NDJSON `assistant` + `result`. |
| MCP shape | `npm run test:mcp:smoke` | 10.0s | same | 2026-06-11 | 13 passed / 1 skipped baseline. |
| Packaged build | `npm run package` | not measured | - | skipped | Do not run while anything is running from `out/`; `clean:out` deletes the bundle. |
| Packaged drive | `npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/x.png` | 17.2s | - | 2026-06-11 | Also exercised by e2e suite. |
| Dev CDP managed/keep-alive | `npx tsx scripts/ui-test/launch-rebel-test.ts`; `--keep-alive` + screenshot | 25s, ready ~17s; +2.4s shot | +55-90s predev | 2026-06-11 | Auto-cleanup unless keep-alive; stop with printed TERM -> wait -> KILL sequence. |
| Onboarding variant | `npx tsx scripts/ui-test/launch-rebel-test.ts --seed-onboarding-incomplete --keep-alive` | 27s, ready ~19s | same as above | 2026-06-11 | Canary reports `onboardingWizard=true`. |
| MCP tools | `rebel-electron` MCP | - | - | not available/validated in Claude Code; exercised daily by `.github/workflows/ui-smoke-test.yml` (Droid, macos-latest) | Factory sessions only. |
| Electron-backed CLI | packaged app `--headless-cli run --json ...` | doc-claim only | doc-claim only | never spiked (real-profile migrations) | Use for live connector OAuth smoke only. |

## Recommended Paths

**Static / targeted tests.** Start with `npm run -s test:preflight -- --quick`. For `validate:fast`, always redirect: `npm run -s validate:fast > /tmp/rebel-validate-fast.log 2>&1; tail -40 /tmp/rebel-validate-fast.log`.

**Standalone CLI.** Use a temp `REBEL_USER_DATA` even for read-only commands, because the CLI writes config/session files. `smoke-test` is a process probe only; use `run -p` for agent health. `--json` auto-denies approvals unless you use `--bypass-safety`, and denied approvals exit 2.

**Packaged drive.** Use this for deterministic UI surfaces and seeded approvals. Check for an app running from `out/` before `npm run package`; packaging starts with `clean:out`.

**Dev CDP launch.** Use `scripts/ui-test/launch-rebel-test.ts` for interactive HMR. The window is hidden by design; screenshot via `scripts/ui-test/screenshot.ts`. For clicks/eval, copy `screenshot.ts`'s `connectOverCDP` pattern into a one-shot, e.g.:

```ts
const page = /* non-DevTools page per screenshot.ts */;
await page.click('#flow-tab-settings');
await page.evaluate(() => document.querySelector('[data-testid="settings-panel"]') !== null);
```

**E2E suite.** Use [TESTING_E2E](TESTING_E2E.md) for packaged Playwright regression coverage and seeding helpers. Read [E2E_TEST_FIXING_GUIDELINES](E2E_TEST_FIXING_GUIDELINES.md) before changing failing e2e tests.

**MCP tools.** Repo-root `mcp.json` is Playwright-only; `rebel-electron` lives in `.factory/mcp.json` for Factory sessions only. If those tools are absent, use the dev CDP script instead.

## CLI Caveats

- License stubs default to `free`; BTS managed-key paths fail closed; embeddings are stubbed. Route those scenarios to explicit specialist testing, not this CLI tier.
- CLI sessions appear in the GUI after reload because the store is shared.
- Use `source .env.local && export REBEL_ANTHROPIC_API_KEY="${REBEL_ANTHROPIC_API_KEY:-$ANTHROPIC_API_KEY}"`; the standalone CLI does not seed auth from plain `ANTHROPIC_API_KEY`.
- Keep the one-real-turn rule unless the user approves more spend.

## Ownership

| Mechanic | Owning file |
|---|---|
| Dev CDP launch, flags, exit codes | `scripts/ui-test/launch-rebel-test.ts` |
| Manual CDP / Factory flow | `.factory/commands/test-ui.md` |
| Packaged drive, e2e seeding, suite guidance | `docs/project/TESTING_E2E.md` |
| Standalone and Electron-backed CLI flags | `docs/project/HEADLESS_CLI_ENTRYPOINT_REFERENCE.md` |
| Live connector smoke through real Rebel auth | `docs/project/MCP_REBEL_CLI_TESTING.md` |
| E2E seed blob and isolated userData helpers | `tests/e2e/test-utils.ts` |
| Live-app source-of-truth capture + visual-evidence rules (design review) | `docs/project/PROJECT_OVERRIDES.md` (Visual Evidence Rules) + `rebel-system/skills/ux/chief-designer/SKILL.md`; capture via `scripts/capture-rebel-dev-screenshot.ts` |

## Drift Check

This grep is a manual drift check, not a CI gate:

```bash
rg -n "UI_MCP_TESTER|MCP-first UI testing|Agent UI Testing via MCP" \
  --glob '!docs/project/UI_MCP_TESTER.md' --glob '!docs/project/AGENT_UI_TESTING.md' \
  --glob '!docs/plans/**' --glob '!docs/postmortems/**' --glob '!docs/tutorials/**' --glob '!docs/project/MCP_*' .
```

Expected result: no matches. Any hit is a reference that should point at this router instead.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Login screen appears in a test launch | Guest-mode injection failed or was lost after reload | Re-inject `sessionStorage.guestMode='true'` and dispatch `guestModeChange`; if using scripted launch, capture the printed tail and retry once. |
| Onboarding appears when you expected the app shell | You used `--seed-onboarding-incomplete` or seeded only `{"onboardingCompleted": false}` | This is correct for first-run testing; otherwise delete the test dir and relaunch without the flag. |
| Dev CDP launch fails during readiness | Vite/Forge HMR rebuilt or reloaded during the canary | Use the script's failure tail; retry once. The shipped canary polls `document.readyState` and reconnects around reloads. |
| Window never shows on screen | `--rebel-test` hides it intentionally | Drive via CDP or Playwright and take screenshots; do not treat the hidden window as a failure. |
| `npm run package` would run while Rebel is open from `out/` | `clean:out` would delete the running bundle | Stop and report the contention; do not kill the user's app or package over it. |
| Screenshot captures DevTools | Wrong CDP target | Use `scripts/ui-test/screenshot.ts`; it selects the first non-DevTools page. |
| CLI says `Core directory is not configured.` | Temp profile lacks `coreDirectory` | Seed `app-settings.json` before `run`; the one-liner above does this. |
| CLI turn exits 2 after `approval_required` | `--json` auto-denied a safety approval | Revise to a read-only prompt or get user approval for `--bypass-safety` in an isolated environment. |
