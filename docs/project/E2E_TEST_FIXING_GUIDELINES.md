---
description: "Required process for fixing E2E test failures — diagnosis steps, root-cause categories, approval gate, and prohibited coverage weakening"
last_updated: "2026-04-02"
---

# E2E Test Fixing Guidelines

Instructions for AI agents fixing failing E2E tests. The goal is to fix tests without weakening the protections they provide.

## See also

- [TESTING_E2E.md](./TESTING_E2E.md) – How to run E2E tests, test suites, configuration, and troubleshooting (including Playwright debugging).
- [WHY_E2E_TESTS_ARE_HARD_TO_FIX.md](./WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) – **Read first.** Historical context on known hard problems and what fixes have been tried. Check before attempting a fix to avoid repeating failed approaches.

## Core Principles

**Diagnose before fixing. Report before implementing. Never weaken test coverage.**

**Clean, robust, root-cause fixes over bandaids.** We want fixes that address the underlying issue, not patches that mask symptoms. Consider rearchitecting the app to be more testable if that's the right long-term solution.

When a test fails, the failure is a signal. It might mean:
1. The UI changed and the test needs updating (selector/text mismatch)
2. A bug was introduced and the test caught it (test is working correctly)
3. The test was flaky or poorly written (test needs improvement)

Your job is to determine which case applies and act accordingly.

## Required Process

### Step 1: Diagnose the Failure

Before proposing any fix, you MUST:

1. **Read the test code** – Understand what the test is verifying and why it exists
2. **Read the error message** – Note the specific assertion or timeout that failed
3. **Check the error context** – Look at `test-results/*/error-context.md` for page snapshots
4. **Check screenshots** – Look at `test-results/*/*.png` for visual state at failure
5. **Check timing logs** – Look for `[E2E] [timing]` entries in test output for performance data
6. **Check WHY_E2E_TESTS_ARE_HARD_TO_FIX.md** – See if this failure matches a known hard problem or a previously attempted fix
7. **Compare with the actual UI** – Read the relevant component code to see current state

### Step 2: Identify the Root Cause

Classify the failure into one of these categories:

| Category | Example | Appropriate Fix |
|----------|---------|-----------------|
| **Selector mismatch** | Button text changed from "Get started" to "Let's check" | Update selector to match new UI |
| **Timing issue** | Element appears after animation but test doesn't wait | Add appropriate wait/timeout |
| **Test ID missing** | Component lacks `data-testid` attribute | Add test ID to component |
| **Actual bug** | Feature broke and test caught it | Fix the bug, not the test |
| **Test logic error** | Test makes incorrect assumptions | Fix test logic while preserving intent |
| **Flaky test** | Passes sometimes, fails others | Improve test reliability |

### Step 3: Report to User Before Implementing

Before making any changes, report:

1. **What the test protects** – What user-facing behavior or feature does this test verify?
2. **Why it failed** – Root cause from Step 2
3. **Proposed fix** – Specific changes you plan to make
4. **Coverage impact** – Will this fix change what the test covers?
5. **Trade-offs** – Any risks or compromises in the proposed fix

Example report:
```
## E2E Test Failure Analysis

**Test**: `Step 1: Welcome - shows introduction screen`
**File**: `tests/e2e/onboarding.spec.ts:133`

### What this test protects
Verifies the onboarding welcome screen appears with a working CTA button,
ensuring new users can begin the setup flow.

### Why it failed
Selector mismatch: Test looks for button "Get started" but UI now shows "Let's check".
The button exists and is functional - only the text changed.

### Proposed fix
Update the selector from `button:has-text("Get started")` to `button:has-text("Let's check")`.

### Coverage impact
None - test will still verify the welcome screen and CTA button functionality.

### Trade-offs
None - this is a straightforward selector update with no reduction in coverage.
```

### Step 4: Wait for User Approval

Do NOT implement the fix until the user confirms the approach is acceptable.

## Prohibited Actions

The following "fixes" are NOT acceptable without explicit user approval and justification:

| Prohibited Action | Why It's Dangerous |
|-------------------|-------------------|
| `test.skip()` or `.skip` | Disables the test entirely, removing protection |
| Deleting test cases | Removes coverage permanently |
| Removing assertions | Weakens what the test verifies |
| Loosening timeouts excessively | May hide real performance regressions |
| Catching and ignoring errors | Masks failures instead of fixing them |
| Using `{ force: true }` on clicks | Bypasses visibility/interactivity checks |
| Replacing specific selectors with overly broad ones | May match wrong elements |

If any of these actions seem necessary, you MUST:
1. Explain why no alternative exists
2. Quantify the coverage loss
3. Suggest compensating measures (e.g., a different test)
4. Get explicit user approval

## Acceptable Fixes

These fixes generally preserve test intent:

| Fix Type | When Appropriate |
|----------|------------------|
| Update selector text | UI copy changed but element still exists |
| Update `data-testid` value | Test ID was renamed in component |
| Add `await` or increase timeout | Element needs time to render |
| Add `waitFor` conditions | Test needs to wait for async state |
| Add missing `data-testid` to component | Improves test reliability |
| Fix test setup/teardown | Test state wasn't properly isolated |
| Update expected values | Intentional behavior change was made |

## Checking Test Intent

Before modifying any test, answer these questions:

1. **What user action does this test simulate?**
2. **What should the user see/experience?**
3. **What would break for users if this test didn't exist?**
4. **Does my fix preserve all of the above?**

If you can't answer these questions, read more context (component code, related tests, git history) before proceeding.

## Flaky vs Recently Broken Tests

Different strategies apply depending on the test failure pattern:

### Flaky Tests (Pass Sometimes, Fail Others)
- **Root cause**: Usually timing, race conditions, or environmental factors
- **Approach**: May require test rewrite or app rearchitecting to be more testable
- **Common fixes**: Better waits, state-driven assertions, deterministic setup

### Recently Broken Tests (Consistently Failing After Change)
- **First question**: Did the app break, or did the test break?
- **App broke**: Fix the app, not the test - the test is working correctly
- **Test broke**: The app intentionally changed; update the test to match
- **If in doubt**: Defer and discuss with the user before implementing

### Identifying the Pattern
1. Check git history for recent changes to both test and tested component
2. Look at CI run history - did this test pass before a specific commit?
3. Check `WHY_E2E_TESTS_ARE_HARD_TO_FIX.md` for similar failure patterns
4. If the test passes locally but fails in CI, it's likely flaky (timing-sensitive)
5. **Identical-signature failures in two or more consecutive runs are deterministic-under-environment regressions, not flakes** - diff the environment before blaming timing. A spec that fails in-file but passes solo means *ordering* is the repro: distill it into a dedicated seeded spec before discarding
6. **Three or more tests in the same module failing after a merge requires an explicit bisect against the merge parent** before any test is reclassified as stale-mock and deferred

## Test Consolidation and Overlap

When reviewing E2E tests, consider:

1. **Overlapping tests**: Multiple tests exercising the same flow can be consolidated
2. **Shared expensive setup**: Tests with identical `beforeAll` can share an app session
3. **Use `test.describe.serial()`** for tests that can share state
4. **Use `resetAppState()` between tests** instead of app restart

See `TESTING_E2E.md` Appendix B for the full consolidation process.

## After Fixing

Once a fix is implemented, ask the user:

> **Would you like me to create a packaged build and run the E2E tests locally to verify the fix?**
>
> This requires:
> 1. `npm run package` (creates app bundle, ~2-3 minutes)
> 2. `set -a && source .env.test && set +a && npm run test:e2e` (runs full E2E suite)
>
> I can run just the specific failing test first, or the full suite.

If the user approves, run the verification:

1. **Run `npm run package`** to create a fresh packaged build
2. **Run the specific test** to verify it passes
3. **Run the full E2E suite** to check for regressions
4. **Summarize changes** including what was fixed and why
5. **Note any follow-ups** (e.g., "The UI copy changed; TESTING_E2E.md table should be updated")
6. **Update WHY_E2E_TESTS_ARE_HARD_TO_FIX.md** – Add an entry under "What We've Tried" documenting: what you did, the outcome, error signatures that led to the fix, and files changed. This preserves knowledge for future fix attempts.
7. **Update E2E docs with lessons learned** – If you discovered a new pattern, gotcha, or technique that would save a future agent time, add it to the relevant doc (this file, `TESTING_E2E.md`, or the TL;DR in `WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`). Skip if it just restates existing content or is a one-off issue unlikely to recur.
