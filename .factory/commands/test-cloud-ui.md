---
description: Trigger the CI UI smoke test workflow with an optional custom test prompt
argument-hint: <optional: custom test prompt, e.g. "Verify GPT-4o mini is in the voice settings dropdown">
---

# Cloud UI Test

Trigger the **Daily UI Smoke Test** GitHub Actions workflow on the `dev` branch. This runs on a clean CI runner using the Droid CLI + `rebel-electron` MCP server.

**Full documentation:** [MCP_CLOUD_TESTER.md](docs/project/MCP_CLOUD_TESTER.md)

## What to Do

### Step 1: Determine the Test Prompt

**If `$ARGUMENTS` is provided**, use it as the custom test prompt.

**If no arguments provided**, ask the user what they want to test. Offer these common options:

1. **Default dynamic regression** -- Run baseline sanity + commit-driven regression tests + final checks (no custom prompt needed). The workflow automatically analyses git history since the last successful run and generates targeted tests.
2. **Feature verification** -- Test a specific UI area (e.g., settings dropdown, new tab, model selection)
3. **Custom regression sweep** -- Broad check across specific surfaces with your own test instructions

### Step 2: Build the Prompt (for custom tests only)

When writing a custom prompt, remember:
- App launch, guest mode, and cleanup are handled automatically by the workflow
- You only need to describe what to navigate and verify
- Use `#flow-tab-settings`, `data-testid` attributes, or visible text for selectors
- Use `electron_evaluate` for DOM inspection (dropdown contents, text presence)
- Use `get_page_state` after navigation to verify page changed
- State PASS/FAIL criteria clearly
- Always reference `processId: "dev-server"` in MCP tool calls
- Known flaky areas in guest mode: connectors catalog (may be empty), voice model dropdowns (may not populate), automations model selection (depends on backend), library content (may be empty)

### Step 3: Trigger the Workflow

```bash
# Default dynamic regression (analyses commits since last successful run)
gh workflow run "Daily UI Smoke Test" --ref dev

# Custom prompt
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="<THE CUSTOM PROMPT>"
```

### Step 4: Monitor and Report

```bash
# Watch the run
gh run watch

# Or list recent smoke test runs
gh run list --workflow="Daily UI Smoke Test" --limit 5
```

Once the run completes, report:
- **Status**: Pass/Fail (note: SKIP results don't cause failure)
- **Link**: The GitHub Actions run URL
- **Summary**: Key findings from the PASS/FAIL/SKIP output
- **Artifacts**: Remind the user that full logs, prompt, commit context, code diffs, and risk summary are available for 7 days via `gh run download <run-id>`

## How Default Mode Works

The default mode (no custom prompt) runs a 3-part dynamic test:

1. **Baseline Sanity** (3 checks): App renders, all 5 tabs navigate, no console errors
2. **Dynamic Regression** (3-8 journeys): The LLM analyses commits since the last successful run -- commit messages, changed files, code diffs, risk categorisation -- discovers real selectors via `get_page_state`, outputs a JSON test plan, then executes targeted regression tests proportional to risk (more tests for `fix:` and `refactor:` commits, fewer for `chore:`)
3. **Final Checks** (2 checks): Console errors accumulated during testing, app stability

The LLM retries failed selectors once before marking FAIL, and marks known-flaky areas as SKIP instead of FAIL.

## Example Custom Prompts

### Verify a dropdown option exists
```
Navigate to Settings by clicking #flow-tab-settings.
Click the Voice sub-tab.
Use electron_evaluate to inspect all select/dropdown elements and their options.
PASS if any dropdown contains 'GPT-4o mini' or 'gpt-4o-mini'.
FAIL if no dropdown contains this model.
```

### Broad regression sweep
```
Test all major surfaces:
1. Navigate to each tab (Conversations, Actions, Automations, Library, Settings) and verify testIdCount > 0.
2. Open Settings sub-tabs (General, Voice, Connectors, Spaces, Agents) and verify each renders content.
3. Test composer: type text, click new chat, verify it clears.
4. Check window.__smokeTestErrors for console errors.
Report PASS/FAIL for each area.
```

### Test a specific feature
```
Navigate to Settings (#flow-tab-settings).
Click the Agents sub-tab.
Use electron_evaluate to verify local model configuration elements are present.
PASS if the Agents tab renders with local model settings visible.
FAIL if blank or missing.
```
