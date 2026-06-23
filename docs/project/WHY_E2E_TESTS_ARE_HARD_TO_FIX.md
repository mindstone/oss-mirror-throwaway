---
description: "E2E testing failure playbook — selector rules, timing pitfalls, lifecycle issues, CI constraints, fix attempt history"
last_updated: "2026-06-09"
---

# Why E2E Tests Are Hard to Fix

> **IMPORTANT**: This doc is a source of truth, not a scratchpad. **Always** log a Fix Attempt after E2E work (success or failure) via `npx tsx scripts/append-e2e-fix-attempt.ts` (records live in [`e2e_fix_attempts.ndjson`](./e2e_fix_attempts.ndjson) — see the Fix Attempt History section). **Selectively** add to the TL;DR / Known Hard Problems when a lesson is broadly applicable. Only make changes you're confident in — minimal and high-signal.

> **UPDATE (2026-01-27)**: The sequenced test architecture (sequence-a/b/c.spec.ts) has been replaced with 9 independent domain-based test files as part of the E2E Architecture Overhaul (Stage 2). See `docs/plans/partway/260126_e2e_test_architecture_overhaul.md`. Historical references to sequence files below remain for context on past approaches.

---

## TL;DR - Key Lessons for Agents

**Before writing or fixing E2E tests, know these hard-won patterns:**

### Selectors
- **Always use `data-testid`** - Never use text-based (`button:has-text("Continue")`) or aria-based (`[aria-pressed]`) selectors. They break when UI text or state changes.
- **Avoid generic selectors** - `button[type="submit"]` can match multiple elements. Be specific.

### Timeouts & Timing
- **Use `test.describe.configure({ timeout })`** for slow beforeAll hooks - `test.setTimeout()` only affects the test itself, not hooks.
- **CI is slower than local** - What works in 5s locally may need 30s+ on CI. Windows is slower than macOS.
- **Debounced operations race with tests** - Wait for state to settle, not arbitrary timeouts.
- **Prefer web-first assertions over `waitForTimeout`** - Use `await expect(locator).toBeVisible()` or `.toHaveCount()` instead of fixed sleeps. For streaming completion, wait for stop button to disappear: `await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({ timeout: 30000 })`.
- **For new chat readiness, wait for empty message list** - `await expect(window.locator('article.agent-turn-message')).toHaveCount(0)` is more reliable than waiting for `interaction-strip` visibility (which may already be visible).

### Click Blocking
- **Overlays block clicks silently** - Banners, dialogs, and nav elements can intercept clicks. Add `pointer-events: none` to informational overlays.
- **Z-index conflicts** - Popovers must have higher z-index than navigation elements they overlap.
- **Check element state before clicking** - Buttons can be visible but disabled. Handle both "becomes enabled" and "disappears" as success paths.

### Guest Mode / Auth Bypass
- **Use preload-level guest mode** - Set `REBEL_TEST_MODE=1` in launch env. The preload sets `sessionStorage.guestMode=true` on `DOMContentLoaded`. React may mount before or during DOMContentLoaded, but `useAuth()` does a mount-time resync from sessionStorage AND listens for the `guestModeChange` event, so guest mode is reliably detected. Never inject auth state via CDP post-render — it's much slower and less reliable.
- **Guard onboarding tests against REBEL_TEST_MODE** - `ensureRebelTestMode.ts` auto-seeds `{onboardingCompleted: true}` when no settings exist. For `skipOnboarding: false`, write `{onboardingCompleted: false}` before launch.

### App Loading Detection
- **`#app-loading` may be absent from DOM** - After React mounts, `main.tsx` hides the spinner. Always handle null: `!htmlSpinner || htmlSpinner.classList.contains('hidden')`.
- **AuthGate has a loading blind spot** - Between settings-splash and login-screen, AuthGate renders a full-screen loading div with no test attributes. Use `data-testid="auth-gate-loading"` to detect it.
- **Add `data-testid` to any full-screen loading state** - If it fills the viewport during startup, E2E tests need a way to detect it.

### App Lifecycle
- **Shutdown is now reliable in test mode** - Stage 1 fix: Super-MCP spawns attached (not detached) when `REBEL_E2E_TEST_MODE=1`.
- **Each test file manages its own lifecycle** - Use `beforeAll`/`afterAll` with `launchWithIsolatedUserData()` and `safeCloseApp()`.
- **Use `resetAppState()` between tests** - Clean state without restarting the app.

### CI-Specific Issues
- **Env vars don't cross process boundaries** - `REBEL_E2E_TEST_MODE` set on Electron isn't available in Playwright test process.
- **Headless mode differs from headed** - Window visibility checks fail, focus behavior differs.
- **Resource contention causes timeouts** - Extend timeouts rather than adding complex retry logic.

### Silent Suite-Disabling Annotations
- **A static `annotation: { type: 'skip', ... }` object SKIPS the whole describe/test on every platform** — Playwright treats the metadata-looking details object as execution-affecting (`processAnnotation` in the worker). It is NOT just a label alongside a runtime `test.skip(condition)` gate. Discovered 2026-06-11: the with-keys `Onboarding Flow` describe in `tests/e2e/onboarding.spec.ts` had been silently skipped on ALL platforms for months while everyone believed only Windows was gated (fix-attempt log #34 in `e2e_fix_attempts.ndjson`; postmortem `docs-private/postmortems/260611_relaunch_onboarding_coach_signal_drift_postmortem.md`). If you need platform gating, use runtime `test.skip(condition, reason)` only; if you see a static skip annotation, assume the suite under it has not been running and verify before trusting its coverage.

---

## Before Attempting to Fix E2E Tests

**STOP and check this first:**

**First — is this failure even worth fixing right now?** E2E is **not** publish-gated on either channel ([`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §3) — a beta/production build ships even when E2E is red. So before investing, classify the failure (see [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §6's three buckets): a CI-load **infra flake** (startup/teardown timeouts) that doesn't gate publish often should **not** consume a push's autonomy budget — record it here and push on. Reserve real fix effort for **stale tests** (a since-changed DOM/test-id — cheap and correct to fix) and **real regressions** (product actually broke). Don't reflexively fix a red E2E just because it's red.

1. **Is this a subsequent fix attempt?** Check the fix-attempt log (`npx tsx scripts/append-e2e-fix-attempt.ts --list 10`, or `jq` over [`e2e_fix_attempts.ndjson`](./e2e_fix_attempts.ndjson)). If similar fixes have been attempted before:
   - Review what was tried and why it didn't work (FAILED/PARTIAL outcomes + insights)
   - Consider whether prior code changes should be reverted
   - Don't repeat approaches that have already failed

2. **After your fix attempt**, log it via `npx tsx scripts/append-e2e-fix-attempt.ts` (`--title`, `--outcome`, `--symptom`, `--fix`, `--insight`):
   - Record the outcome (SUCCESS / PARTIAL / FAILED / PENDING / …) and the reusable insight
   - Promote any broadly-applicable lesson up into the TL;DR / Known Hard Problems

3. **Reference the planning doc** at `docs/plans/finished/260115_windows_e2e_test_stability.md` for detailed investigation history.

---

## Known Hard Problems

These are **fundamental challenges** that make E2E tests difficult. They're not bugs to fix - they're constraints to work around.

### 1. App Shutdown Doesn't Complete Reliably

**Symptom**: `afterAll` hook timeouts (120s exceeded), orphaned processes.

**What we know**:
- `safeCloseApp()` has a 15-second timeout, then attempts force-quit
- Force-quit also fails on CI runners
- Background processes (Super-MCP, GPU embedding backend) don't terminate cleanly
- This causes test failures even when the actual test logic passes

**Error signature**:
```
[E2E] App close timed out or failed: Error: App close timeout. Attempting force quit...
[E2E] Force quit also failed. Process may be orphaned.
Worker teardown timeout of 120000ms exceeded.
```

### 2. CI Runners Have Different Timing Than Local Dev

**What we know**:
- macOS CI runners (GitHub Actions) have unpredictable timing
- Tests pass locally but fail on CI, or pass on some CI runs but not others
- Windows CI runners are consistently slower than macOS

### 3. Readiness Detection Is Fragile — MOSTLY RESOLVED

**Status**: Largely resolved by entry #26 (preload-level guest mode). The complex readiness
detection in `enableGuestMode()` was replaced with a simple canary assertion + fallback.
Readiness waiting is now handled solely by `waitForMainAppReady()`.

**What we know**:
- `waitForMainAppReady()` uses `window.e2eApi.getReadiness()` with DOM polling fallback
- Readiness phases: `booting` → `login` → `onboarding` → `main`
- Guest mode is now set via preload (before React mounts), so the `login` phase is bypassed
- If renderer startup stalls before settings load, tests timeout (this part is unchanged)

### 4. Debounced State vs Test Timing

**What we know**:
- Many UI operations are debounced for performance (draft sync: 1000ms, autosave: 2000ms)
- Tests that perform rapid actions can race against debounced writes
- Example: Draft Persistence - typing then immediately switching sessions loses the draft because the debounced write hasn't fired yet, and `composerRef.clear()` cancels pending writes
- Fix requires flushing debounced operations before state snapshots, not just longer test waits

### 5. Preload Bundler Replaces process.env - RESOLVED

**Status**: Fixed in Stage 6 of E2E Architecture Overhaul (Jan 2026).

**The problem was**:
- Vite bundler replaced `process.env` in packaged preload builds
- `isE2EApiEnabled` was always `false` in packaged apps

**The fix**:
- E2E mode flags (`--e2e-test-mode`, `--e2e-test-user-data-dir`) are now passed via `additionalArguments` in `webPreferences`
- Preload parses these from `process.argv` (runtime) instead of `process.env` (bundle-time)
- This follows the existing pattern for `--anonymous-id`, `--app-version`, etc.

### 6. Local cloud-service readiness times out in CI under load

**Symptom**: `inbound-author-policy.spec.ts` and `messaging.spec.ts` (Slack listener) fail with
`Timed out waiting for local cloud service. Logs:\n…` — recurring across beta runs (e.g. Jun 5/7).

**What we know**:
- These specs spawn the bundled cloud-service and wait for its `READY_MARKER` log line. The wait lives
  in `tests/e2e/helpers/localCloudService.ts` (timeout `process.env.CI ? 90_000 : 30_000`) — with
  **two near-duplicate inline copies** in `inbound-author-policy.spec.ts` (~line 192) and
  `messaging.spec.ts` (~line 100), so a single timeout bump must touch all three.
- It's a **CI-load** problem (the service is slow to log ready under runner contention), not a selector
  or DOM issue — so it usually does **not** reproduce on a developer's macOS. Bumping the timeout is a
  guess you can't verify locally; the three-copy duplication is the cheaper real fix to unify first.
- **Not publish-gating** (E2E is ungated) — see the gating triage in "Before Attempting to Fix" above.

## Historical Context

- The Release Build workflow has had 200+ consecutive failures (as of Jan 2025)
- macOS E2E tests are intermittently passing/failing (flaky, not consistently broken)
- Multiple "Windows E2E stability" fixes have been attempted without resolving the underlying issues

---

## Fix Attempt History

> Per-attempt records now live as terse NDJSON in [`e2e_fix_attempts.ndjson`](./e2e_fix_attempts.ndjson). The verbose prose for entries #1–#32 was moved out (2026-06-09) to keep this doc focused on the durable, reusable content above (TL;DR + Known Hard Problems). **Full original prose for any entry is in git history**: `git log -p -- docs/project/WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`.
>
> **Outcome key:** SUCCESS = resolved · PARTIAL = improved, not fully fixed · FAILED = didn't help · SUPERSEDED = approach later replaced · PENDING = awaiting CI verification · INVESTIGATION = triage/decision, no code change.

**Read recent attempts (and avoid repeating failed approaches):**

```bash
npx tsx scripts/append-e2e-fix-attempt.ts --list 10        # last 10, each with its key insight
jq -r 'select(.outcome=="FAILED") | "#\(.n) \(.title) — \(.insight)"' docs/project/e2e_fix_attempts.ndjson
```

**Append after E2E work (always — success or failure), via the script so the format stays consistent:**

```bash
npx tsx scripts/append-e2e-fix-attempt.ts \
  --title "Short title" --outcome PARTIAL \
  --symptom "what failed" --fix "what you tried" --insight "the reusable lesson"
```

It auto-increments `n` and stamps today's date (`--json '{...}'` is also accepted; see the script header for all fields). Then promote any broadly-applicable lesson up into the TL;DR / Known Hard Problems above — that distillation, not the raw log, is what saves the next agent time.
