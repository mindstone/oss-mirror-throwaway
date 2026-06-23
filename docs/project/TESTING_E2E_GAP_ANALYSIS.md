---
description: "Repeatable E2E coverage gap analysis process — subagent lenses, feature mapping, weak assertions, prioritised test plans"
last_updated: "2026-04-26"
---

# E2E Test Gap Analysis: How to Find and Fix Coverage Gaps

A repeatable approach for identifying where our E2E tests (and other tests) are weak, shallow, or missing -- and for generating prioritized improvement plans.

> **When to run this process:**
> - Quarterly, or when the app "feels buggy"
> - After major feature work or architectural changes
> - After a cluster of production bugs in a particular area
> - When re-enabling CI E2E after a period of disablement

## See Also

- [TESTING_E2E.md](./TESTING_E2E.md) -- How to run, write, and maintain E2E tests
- [E2E_TEST_FIXING_GUIDELINES.md](./E2E_TEST_FIXING_GUIDELINES.md) -- Diagnosis process for E2E failures
- [WHY_E2E_TESTS_ARE_HARD_TO_FIX.md](./WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) -- Known hard problems and fix attempt history
- [TESTING_AUTOMATION_OVERVIEW.md](./TESTING_AUTOMATION_OVERVIEW.md) -- Unit/integration tests (Vitest)
- [SENTRY_TRIAGE.md](./SENTRY_TRIAGE.md) -- Production bug triage (feeds into pattern analysis)
- [CHIEF_PATHOLOGIST_ANALYSIS](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST_ANALYSIS.md) -- Longitudinal bug analytics (feeds into systemic pattern detection)
- [WRITING_EVALS.md](./WRITING_EVALS.md) -- LLM eval harnesses

---

## Overview

This process uses multiple AI subagents with diverse prompting strategies to systematically discover test gaps that a single perspective would miss. The approach combines:

1. **Coverage gap analysis** -- comparing existing tests against the app's feature surface area
2. **Chaotic interaction brainstorming** -- imagining adversarial/rapid-fire user behavior
3. **Infrastructure analysis** -- identifying what our test machinery can't yet do
4. **Real-user workflow analysis** -- thinking from the perspective of non-technical users
5. **Existing test hardening** -- reviewing current tests for weak assertions and missing edge cases
6. **Production bug pattern mining** -- extracting test ideas from Sentry triage and postmortems

The output is a prioritized planning doc with concrete test scenarios, organized by ease and value.

---

## Phase 1: Understand the Current Landscape

Before launching subagents, build a mental model of what exists.

### 1a. Map the test inventory

```bash
# List all E2E spec files and their test counts
for f in tests/e2e/*.spec.ts; do
  echo "=== $f ==="
  grep -cE '^\s+test\(' "$f" || echo "0 tests"
done
```

Skim the test names to understand what each file covers. Note which tests are skipped (`test.skip`).

### 1b. Map the feature surface

Explore the renderer feature directories:
```
src/renderer/features/*/
```

Read `src/renderer/App.tsx` section comments (`// SECTION:`) to understand the full orchestration surface.

### 1c. Read the E2E docs

- [TESTING_E2E.md](./TESTING_E2E.md) -- especially the test suite table and "Future Tests (TODO)" section
- [WHY_E2E_TESTS_ARE_HARD_TO_FIX.md](./WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) -- especially the TL;DR and recent fix attempt entries

---

## Phase 2: Launch Parallel Subagents

Launch **5-6 subagents in parallel**, each with a distinct analytical lens. Use diverse model families (GPT, Claude, Gemini) for perspective diversity. Prompt each subagent with the specific context they need and a focused question.

### Subagent 1: Coverage Gap Analysis (GPT-5.5)

**Droid:** `researcher-gpt5.5-high`

**Prompt focus:** Compare existing E2E test coverage against the app's feature surface area. Read `App.tsx`, the renderer features directory structure, IPC contracts, and the existing spec files.

**Ask for:**
- Features with ZERO E2E coverage (list each with rationale)
- Features with SHALLOW coverage (only happy path, no error paths)
- Cross-feature interactions that are untested
- Skipped tests that represent real coverage gaps

### Subagent 2: Chaotic Interaction Edge Cases (GPT-5.5)

**Droid:** `researcher-gpt5.5-high`

**Prompt focus:** Brainstorm chaotic, rapid-fire, and adversarial user interaction sequences. Read the agent session engine, session store, message queue hook, tool approval hook, and auto-scroll hook.

**Ask for 20-30 scenarios grouped by:**
- Race conditions and timing (rapid actions, interrupts)
- State corruption (switching contexts mid-operation)
- Queue/approval edge cases (duplicates, stale data)
- Long conversation / scroll / virtualization edge cases
- Model switching / configuration changes mid-session
- Multi-session interactions (creating, switching, deleting while things are happening)

**Include these known problem patterns from user reports:**
- Edit a previous message while the agent is running, then hit stop, then edit again
- Change to use Haiku for both thinking and working models
- Ask the agent to create multiple new conversations
- Multiple duplicate approvals queuing up from repeated actions
- Switching back to a really long conversation -- does it auto-scroll correctly?
- Queuing messages sometimes loses intermediary agent output that was produced just prior to the queued input being sent
- Draft text phantom-reappearing after deletion when switching between conversations
- Deleted conversations reappearing in the sidebar after having had unsent draft text

### Subagent 3: Infrastructure Improvements (Claude Opus)

**Droid:** `researcher-opus4.7`

**Prompt focus:** Analyze the E2E test infrastructure (`test-utils.ts`, `mocks/llm-mock.ts`, `playwright.config.ts`, global setup/teardown) and propose improvements to support richer testing.

**Ask for:**
- Missing testing capabilities (mid-turn event injection, error simulation, network interruption, scroll verification, conversation pre-population, concurrent IPC events)
- Mock system improvements (streaming delays, error types, tool use approval flow integration)
- New test helpers needed (rapid-fire actions, state assertions, race condition detection)
- CI reliability improvements

### Subagent 4: Non-Technical User Scenarios (Gemini)

**Droid:** `researcher-gemini3.1-pro`

**Prompt focus:** Think like a non-technical knowledge worker (executive, PM, sales, researcher) and identify realistic workflow scenarios that could break. Read the product vision doc, UI overview, and conversation UI doc.

**Ask for:**
- 10-15 realistic workflow scenarios (including the "messy" parts -- interruptions, context switches, mistakes)
- 5-10 error recovery scenarios from the user's perspective
- First-use and onboarding gaps
- Accessibility and usability edge cases

### Subagent 5: Existing Test Hardening (GPT-5.5 Reviewer)

**Droid:** `reviewer-gpt5.5-high`

**Prompt focus:** Read ALL existing spec files and identify ways to make them harder, more thorough, and more likely to catch real bugs.

**Ask for:**
- Per-file analysis of what's tested vs what's missing
- Top 10 "hardening" additions ranked by bug-catching potential
- Tests that should be unskipped with specific fixes
- Assertions that should be strengthened (with before/after examples)

### Subagent 6: Production Bug Pattern Mining (GPT-5.5)

**Droid:** `researcher-gpt5.5-high`

**Prompt focus:** Read Sentry triage docs, pathologist analysis workflow, recent postmortems, and triage logs. Extract patterns in production bugs that suggest missing tests.

**Ask for:**
- Production bug patterns that suggest missing E2E tests
- Pathologist analysis themes that reveal systematic test gaps
- Specific bugs from postmortems that could become test cases
- Patterns where unit tests exist but integration/E2E tests are missing

---

## Phase 3: Synthesize and Prioritize

After all subagents return, synthesize their findings into a single prioritized planning doc.

### 3a. Categorize by feasibility

| Category | Description |
|----------|-------------|
| **Now (existing machinery)** | Tests that can be written today with current `test-utils.ts`, `llm-mock.ts`, and `launchWithMocking()` |
| **Soon (small infra improvements)** | Tests that need one or two easy, high-value infrastructure additions (e.g., error mocking, concurrent IPC injection) |
| **Later (significant infra)** | Tests that need substantial infrastructure work (conversation pre-population, scroll verification helpers, CI re-enablement) |
| **To be discussed** | Tests we'd like to write but are blocked by fundamental infrastructure limitations |

### 3b. Score by value

For each test scenario, assess:
- **Bug likelihood:** How likely is this to catch a real bug? (High if it matches a known production bug pattern or a user-reported issue)
- **User impact:** How bad is it if this breaks? (Critical for data loss, session corruption, auth failures; Low for cosmetic issues)
- **Regression risk:** How likely is this to regress during normal development?

### 3c. Create the planning doc

Write `docs/plans/YYMMDD_e2e_test_gap_improvements.md` with:
- All test scenarios organized into stages by priority (ease x value)
- Early stages: high-value tests doable with existing machinery
- Middle stages: tests requiring small infrastructure improvements
- Late stages: infrastructure-heavy tests and "to be discussed" items
- Each scenario includes: exact action sequence, expected behavior, mock vs live requirement, which spec file to add it to

### 3d. Include reliability improvements

If the analysis reveals opportunities to make existing tests more reliable:
- Small code changes that improve testability (adding `data-testid`, exposing state via `e2eApi`)
- Assertion improvements (replacing silent-pass branches, strengthening weak checks)
- Flakiness fixes (better timing, state-driven waits instead of arbitrary sleeps)

---

## Phase 4: Implement

Follow the [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) workflow for implementation:

1. Start with the highest-value, easiest tests
2. Add tests to existing spec files where possible (fewer app launches)
3. Run the full E2E suite after each batch to verify no regressions
4. Update this doc and the planning doc with learnings

---

## Appendix: User-Reported Buggy Interactions to Test

These are specific interactions that users have reported as "feeling buggy." Each should be covered by an E2E test:

- **Queue loses intermediary output:** When queuing messages, the intermediary agent output (produced just before the queued input is sent) sometimes disappears from the transcript
- **Phantom draft reappearance:** Start typing in conversation A, switch to B, go back to A and delete the text, switch to B, then the deleted text in A phantom-reappears under certain circumstances
- **Deleted conversation reappears:** Start typing in conversation A, switch to B, right-click A in the sidebar to delete it -- it sometimes reappears later
- **Edit during active turn:** Edit a previous message while the agent is running, then hit stop, then edit again -- state can get corrupted
- **Multiple approval duplicates:** Performing the same action multiple times without approving can queue up duplicate approval requests
- **Long conversation scroll:** Switching back to a really long conversation doesn't always jump to the bottom correctly
- **Model switching mid-session:** Changing to Haiku for thinking and working models mid-conversation may not take effect as expected
