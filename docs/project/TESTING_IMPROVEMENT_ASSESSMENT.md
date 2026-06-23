---
description: "Repeatable process for assessing and improving the automated test suite, using postmortem data, coverage analysis, and structured review."
last_updated: "2026-04-06"
---

# Testing Improvement Assessment

A repeatable process for periodically assessing the automated test suite's effectiveness at catching bugs, identifying gaps, and prioritizing improvements. Run quarterly or after significant architectural changes.

## See Also

- [TESTING_AUTOMATION_OVERVIEW](TESTING_AUTOMATION_OVERVIEW.md) — test runner config, workspace projects, running tests
- [CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md) — validation commands and baselines
- [CODE_HEALTH_STATUS](CODE_HEALTH_STATUS.md) — current health metrics
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) — longitudinal bug analytics from postmortem corpus
- [CHIEF_PATHOLOGIST](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) — individual bug postmortem format
- Planning docs from assessments:
  - `docs/plans/260406_test_suite_improvements.md` — first assessment (April 2026)
  - `docs/plans/260406_interface_based_test_doubles_migration.md` — DI migration feasibility report

## Principles

- **Bug-catching is the primary goal** — test improvements are measured by their ability to prevent production bugs, not by coverage percentages or mock counts
- **Data-driven prioritization** — use postmortem corpus and coverage data to target improvements where bugs actually happen, not where coverage is lowest
- **Incremental delivery** — improvements should ship in tiers, with the highest-leverage changes first
- **Pattern replication** — when the codebase has a "gold standard" test pattern (e.g., Rebel Core's `ModelClient` interface), extend it rather than inventing new patterns

## Success Criteria

When running this assessment, use this priority ordering for improvements:

1. **MUST** catch more bugs — coverage gaps, integration/contract tests, behavioral tests for bug-prone modules
2. **SHOULD** fewer false positive test failures — mock drift fixes, test isolation, infrastructure consolidation
3. **NICE** less test maintenance overhead — DI migration, DX improvements, test data builders

## Process (Step by Step)

### Step 1: Extract Bug Data from Pathologist Corpus

Extract all `[BUG-POSTMORTEM]` structured data from `docs-private/postmortems/`:

```bash
rg '^\[BUG-POSTMORTEM\] ' docs-private/postmortems/ --no-filename \
  | grep -v '<' | grep -v 'bug_id":"BUG-' \
  | while IFS= read -r line; do echo "${line#\[BUG-POSTMORTEM\] }"; done
```

Analyze the following distributions and cross-tabulations:

| Analysis | What It Reveals | Action |
|----------|----------------|--------|
| **Test gap distribution** | Which categories of missing tests produce the most bugs | Prioritize test types that close the biggest gaps |
| **Test gap x severity** | Which test gaps produce the most dangerous bugs | Weight high-severity gaps higher in prioritization |
| **Module hotspots** | Which modules have the most bugs | Focus coverage and contract tests on these modules |
| **Bug type distribution** | What kinds of mistakes are made | Choose test patterns that catch these mistake types |
| **Review miss categories** | Why reviewed code still ships bugs | Inform what tests should verify beyond what reviewers check |

### Step 2: Run Coverage Analysis

If coverage reporting is configured (`npm run test:coverage`), generate a baseline report. If not, configure it first:

```bash
# Check if coverage is configured
grep -q "coverage" vitest.config.ts && echo "Configured" || echo "Not configured"

# Generate coverage report
npm run test:coverage -- --reporter=json-summary
```

Focus on:
- `src/core/services/` — platform-agnostic business logic (affects all surfaces)
- `src/main/services/` — Electron-specific services (agent execution, MCP, safety)
- Modules flagged as hotspots in Step 1

### Step 3: Assess Current Test Infrastructure

Check the health of test infrastructure:

1. **Mock density**: `rg 'vi\.mock\(' src/ --glob '*.test.*' -c | sort -t: -k2 -n -r | head -20` — files with most mocks
2. **Duplicate infrastructure**: Check if `vitest.setup.ts` and `src/core/__tests__/testHelpers.ts` have divergent implementations
3. **Test tiering**: Are integration tests separated from fast unit tests?
4. **CI structure**: Is the CI pipeline parallel or serial?
5. **Test data builders**: Do shared builders exist in `src/core/__tests__/builders/`?
6. **Contract tests**: Do registry-derived wiring tests exist for IPC channels and cloud routes?

### Step 4: Cross-Reference Bug Data with Coverage Gaps

The key insight: **not all coverage gaps are equal**. Prioritize by:

```
Priority = (bug count in module from postmortems) × (1 - coverage%) × (severity weight)
```

Where severity weight: high=3, medium=2, low=1.

This ensures you write tests where bugs actually happen, not where coverage is arbitrarily low.

### Step 5: Generate Improvement Plan

Structure improvements into tiers:

| Tier | Goal | Typical Items |
|------|------|---------------|
| **Tier 0** | Prerequisites | Coverage config, test infra fixes, boundary interface initialization |
| **Tier 1** | Catch more bugs | Contract tests, coverage for bug-prone modules, pure logic extraction |
| **Tier 2** | Fewer false positives | Mock consolidation, redundant mock removal, test isolation |
| **Tier 3** | Less maintenance | DI migration, DX improvements, builder libraries |

For each item, document:
- What it is
- Which bug class it prevents (reference specific postmortem bug IDs)
- Effort estimate
- Dependencies on other items

### Step 6: Review Plan (CHIEF_ENGINEER)

Use the CHIEF_ENGINEER workflow with heavy review for the improvement plan. Key specialists:
- **Testability specialist** — validates proposed testing patterns
- **Structural Health specialist** — assesses whether structural changes (DI, decomposition) are the right approach
- **Documentation specialist** — identifies docs that need updating after implementation

### Step 7: Implement and Measure

After implementing improvements, measure effectiveness:

1. Run the bug data extraction again on new postmortems
2. Compare test gap distributions before/after
3. Track whether the same module hotspots continue producing bugs
4. Monitor CI speed and false positive rate

## Key Design Decisions (from April 2026 Assessment)

These decisions were made after 2 rounds of septuple review (7 reviewers + 3 specialists) and should be preserved unless explicitly revisited:

1. **Explicit interfaces, not `typeof`** — DI contracts define consumer-facing shapes, not mirror concrete implementations
2. **Decompose, don't containerize** — large modules (e.g., agentTurnExecutor with 43+ deps) should be split into smaller modules with small dep bags, not wrapped in a giant dependency container
3. **Config-level test tiering, not CLI --exclude** — CLI `--exclude` doesn't work in Vitest workspace mode (documented in `docs-private/investigations/260330_ci_failures_dev_checks.md`)
4. **Simple logger no-ops, not LoggerFactory** — tests need `{debug, info, warn, error}` no-ops, not a complex factory interface
5. **Use existing SettingsStoreAdapter** — `setSettingsStoreAdapter()` already exists; don't create parallel abstractions
6. **Registry-derived contract tests** — wiring tests should enumerate from `contracts.ts`/`cloudChannelPolicies.ts`, not hand-maintained channel lists
7. **Default wiring verification** — every DI migration needs a "default deps produce correct behavior" contract test
8. **Bug archaeology before coverage sprints** — validate coverage→bugs assumption with actual postmortem data before investing in coverage work
9. **Centralize, don't fork** — when extracting pure logic (e.g., cosineDistance exists in 2 files), centralize into one shared module

## Data from April 2026 Assessment

### Postmortem Corpus Summary (57 bugs)

**Test gap distribution:**
- `missing_coverage`: 20 bugs (4 high, 13 medium) — **largest gap**
- `integration_gap`: 13 bugs (3 high, 10 medium)
- `environment_gap`: 12 bugs (5 high, 3 medium)
- `timing_concurrency_gap`: 3 bugs
- Others: 9 bugs across 6 categories

**Module hotspots:**
1. `agentTurnExecutor.ts`: 7 bugs
2. `automationScheduler.ts`: 3 bugs
3. `cosPendingService.ts`: 3 bugs
4. 12 modules with 2 bugs each

**Review miss categories (12 reviewed bugs that still shipped):**
- `behavioral_semantic_gap`: 5 — code compiles, types check, but behavior is wrong
- `design_oversight`: 2
- `not_visible_in_diff`: 2

**Bug catchability by proposed improvements:**
- D.1 coverage sprint would address: 20 bugs (35%)
- D.3 contract/wiring tests would address: 13 bugs (23%)
- Combined Tier 1: 33 bugs (58%)

### Test Suite Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| Total test files | ~500+ | |
| Total tests | ~9,300+ | |
| Files using vi.mock() | 213 (40%) | High in src/main/services/ (87%) |
| Code coverage | Not measured | Critical gap |
| Vitest workspace projects | 4 | Well-structured |
| CI structure | Single serial job | Bottleneck |
| Mock-free test pattern | Rebel Core (26/33 files) | Gold standard |
