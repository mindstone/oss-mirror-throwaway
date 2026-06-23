---
description: "CI UI smoke-test guide for MCP-driven Electron testing — GitHub Actions triggers, dynamic regression prompts, and artifacts"
last_updated: "2026-04-02"
---

# MCP Cloud Tester (CI UI Smoke Tests via GitHub Actions)

This doc explains how to trigger the **Daily UI Smoke Test** workflow from GitHub Actions with custom prompts for on-demand UI testing. Unlike local agent UI testing (see [AGENT_UI_TESTING.md](AGENT_UI_TESTING.md)), this runs in CI on a fresh `macos-latest` runner using the Droid CLI + `rebel-electron` MCP server.

**Use this when:** You want to validate UI behavior on a clean CI environment -- feature verification, regression testing after recent commits, or ad-hoc smoke tests without launching the app locally.

---

## How It Works

The workflow (`.github/workflows/ui-smoke-test.yml`) does the following:

1. **Checks out `dev`** branch (full history), initialises submodules, installs deps
2. **Installs the Droid CLI** via Factory's install script
3. **Finds the last successful run** via the GitHub API to determine what changed since then
4. **Generates commit context**: commit messages, changed files, diff stats, truncated code diffs, risk categorisation, and affected UI area mapping
5. **Generates a prompt file** (`/tmp/ui-smoke-prompt.md`) with either:
   - **Default mode** (3-part dynamic structure): Baseline sanity checks, commit-driven regression tests, and final checks
   - **Custom mode**: Your custom prompt between setup and cleanup
6. **Runs `droid exec`** with the generated prompt -- the Droid uses MCP tools to drive the Electron app
7. **Parses results**: Extracts the `=== UI SMOKE TEST RESULTS ===` block, checks for FAIL lines
8. **Uploads artifacts**: Full log, summary, prompt, commit context, code diffs, and risk summary (retained 7 days)
9. **Writes GitHub step summary** with results and commit context
10. **Notifies Slack** on failure

### Default Mode: Dynamic Regression Testing

The default mode runs a 3-part test structure driven by recent commits:

| Part | What | Details |
|------|------|---------|
| **Baseline Sanity** (3 checks) | Always runs | App renders, all 5 tabs navigate, no console errors |
| **Dynamic Regression** (3-8 journeys) | Commit-driven | LLM analyses git history and designs targeted tests |
| **Final Checks** (2 checks) | Always runs | Console errors, app stability |

The dynamic regression system:
- Finds the SHA of the last successful workflow run
- Extracts commit messages, changed file lists, diff stats, and truncated code diffs for UI-relevant paths (`src/renderer/`, `src/shared/`, `src/core/`, `src/preload/`)
- Maps changed files to UI areas (homepage, conversations, settings, composer, etc.)
- Categorises commits by risk: `fix:` = HIGH, `refactor:` = MEDIUM-HIGH, `feat:` = MEDIUM, `chore/docs/style/test:` = LOW
- Instructs the LLM to discover real selectors via `get_page_state` before designing tests
- Requires a JSON test plan before execution (auditable in artifacts)
- Includes a retry policy for failed selectors and known-flaky area awareness

### Default vs Custom Mode

| Mode | Trigger | What runs |
|------|---------|-----------|
| **Default** | Scheduled (weekdays 08:00 UTC) or manual with no prompt | Baseline + dynamic regression + final checks |
| **Custom** | Manual with a `prompt` input | Only your custom prompt (dynamic regression is skipped) |

When you provide a custom prompt, the setup and cleanup are still included -- you only need to describe what to test.

---

## Quick Start

### Via GitHub CLI (`gh`)

```bash
# Run the default 14 journeys
gh workflow run "Daily UI Smoke Test" --ref dev

# Run with a custom test prompt
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="Your test instructions here"
```

### Via GitHub Actions UI

1. Go to **Actions** > **Daily UI Smoke Test**
2. Click **Run workflow**
3. Select `dev` branch
4. Paste your custom prompt in the text box (or leave blank for defaults)
5. Click **Run workflow**

### Watching Results

```bash
# Watch the most recent run in real-time
gh run watch

# List recent runs
gh run list --workflow="Daily UI Smoke Test" --limit 5

# View a specific run
gh run view <run-id>

# Download artifacts (logs, summary, prompt)
gh run download <run-id>
```

---

## Writing Custom Prompts

Your prompt is injected between the fixed setup (app launch + guest mode) and cleanup (stop server + summary). You don't need to handle app startup or shutdown.

### Prompt Writing Tips

- **Be specific about selectors**: Use `#flow-tab-settings`, `data-testid` attributes, or visible text
- **Use `electron_evaluate` for DOM inspection**: Check dropdown contents, text presence, element counts
- **Use `get_page_state` after navigation**: Verify the page changed and `testIdCount > 0`
- **State PASS/FAIL criteria clearly**: The Droid needs unambiguous success/failure conditions
- **Reference `processId: "dev-server"`**: All MCP tool calls must include this

### Available MCP Tools in CI

| Tool | Purpose |
|------|---------|
| `get_page_state` | Get page title, URL, visible testIds |
| `click_button` | Click by testId, text, or CSS selector |
| `fill_input` | Fill input/textarea fields |
| `electron_evaluate` | Run arbitrary JS in the renderer |
| `spawn_dev_server` | Already called in setup; available for restart if needed |

---

## Usage Examples

### Example 1: Verify a Specific Dropdown Option

Test that GPT-4o mini appears in a settings dropdown:

```bash
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="Navigate to Settings by clicking #flow-tab-settings. \
Look for a model selection dropdown or the Voice sub-tab. \
Use electron_evaluate to inspect all select/dropdown elements and their options. \
PASS if any dropdown contains 'GPT-4o mini' or 'gpt-4o-mini' as an option. \
FAIL if no dropdown contains this model."
```

### Example 2: Regression Test for Recent Changes

Broad regression sweep after a day of commits:

```bash
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="Run a regression sweep across all major surfaces:

### Test 1: Main Navigation
Navigate to each tab (Conversations, Actions, Automations, Library, Settings) by clicking their selectors. After each click, call get_page_state and verify testIdCount > 0.
PASS if all tabs render. FAIL if any tab is blank or errors.

### Test 2: Settings Sub-Tabs
Open Settings, then click through each sub-tab (General, Voice, Connectors, Spaces, Agents).
Use get_page_state after each to verify content renders.
PASS if all sub-tabs have content. FAIL if any is blank.

### Test 3: Composer Interaction
Navigate to Conversations. Use electron_evaluate to find the composer textarea and type 'test message'. Verify the text appears. Then click the new-chat button and verify the composer clears.
PASS if composer accepts input and resets on new chat.

### Test 4: Console Errors
Check window.__smokeTestErrors for any captured console errors.
PASS if no errors. FAIL if errors found (list them)."
```

### Example 3: Test a Specific Feature You Just Built

Verify the Agents settings tab and local model configuration:

```bash
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="Navigate to Settings (#flow-tab-settings). \
Click the Agents sub-tab. \
Use get_page_state to verify the tab rendered. \
Use electron_evaluate to check that local model configuration elements are present in the DOM. \
Look for text containing 'Local' or 'Ollama' or model provider references. \
PASS if the Agents tab renders with local model settings visible. \
FAIL if the tab is blank or local model section is missing."
```

### Example 4: Verify Connectors Catalog Data

```bash
gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="Navigate to Settings > Connectors. \
Use electron_evaluate to extract all visible text on the page. \
Verify at least 3 of these connectors appear: Slack, Google Workspace, Notion, Outlook Mail, Linear, GitHub. \
Also verify the connector list is not empty (count > 0). \
PASS if real connector data is displayed with at least 3 flagship names. \
FAIL if the section is empty or missing flagship entries."
```

### Example 5: Multi-line Prompt from a File

For complex test scenarios, write the prompt to a file first:

```bash
cat > /tmp/my-test.txt << 'EOF'
### Test the full settings flow

1. Open Settings (#flow-tab-settings)
2. Verify General tab is shown by default
3. Click each sub-tab and verify it renders:
   - Voice: check for transcription model dropdowns
   - Connectors: check for connector names
   - Spaces: check for Add Space button
   - Agents: check for model configuration
4. Return to General, verify no console errors accumulated

Report PASS/FAIL for each sub-tab independently.
EOF

gh workflow run "Daily UI Smoke Test" --ref dev \
  -f prompt="$(cat /tmp/my-test.txt)"
```

---

## Understanding Results

### Artifacts

Every run uploads these files (retained 7 days):

| File | Contents |
|------|----------|
| `ui-smoke-output.log` | Full Droid CLI output (last 120 lines shown in the workflow log) |
| `ui-smoke-summary.txt` | Extracted PASS/FAIL summary block |
| `ui-smoke-prompt.md` | The complete generated prompt (useful for debugging what the LLM was told) |
| `commit-messages.txt` | One-line summaries of UI-relevant commits since last successful run |
| `changed-files.txt` | List of changed files in UI-relevant paths |
| `diff-stat.txt` | Insertions/deletions per file |
| `code-diffs.txt` | Truncated actual code diffs (~200 lines) |
| `risk-summary.txt` | Risk categorisation of commits by type |

### Summary Format

Default mode produces a 3-part structured report:
```
=== UI SMOKE TEST RESULTS ===
BASELINE:
Baseline 1 (App renders):              PASS - Homepage rendered with greeting
Baseline 2 (Tab navigation):           PASS - All 5 tabs loaded
Baseline 3 (No early console errors):  PASS - No errors

REGRESSION (commit-driven):
Journey 1 (Settings model dropdown):   PASS - Dropdown renders with options
Journey 2 (Composer input reset):      PASS (retried) - Fixed selector on retry
Journey 3 (Voice settings):            SKIP - Model dropdown empty in guest mode (known flaky)

FINAL:
Console errors:                        PASS - No errors accumulated
App stability:                         PASS - App responsive

OVERALL: PASS (6 passed, 0 failed, 1 skipped out of 7 total)
=== END RESULTS ===
```

Custom mode produces a simpler report:
```
=== UI SMOKE TEST RESULTS ===
Custom Journey: PASS - GPT-4o mini found in voice settings dropdown
OVERALL: PASS
=== END RESULTS ===
```

### Status Meanings

| Status | Meaning |
|--------|---------|
| **PASS** | Journey succeeded on first attempt |
| **PASS (retried)** | Failed initially but passed after the LLM corrected the selector |
| **FAIL** | Journey failed (after retry if applicable) |
| **SKIP** | Skipped due to known flaky area -- expected element not found in guest/CI mode |

SKIP and PASS (retried) do **not** cause OVERALL FAIL. Only FAIL results in baseline, regression, or final checks trigger an overall failure.

### Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `droid exec` exits non-zero | Droid CLI or MCP error | Check `ui-smoke-output.log` |
| Missing summary block | Droid didn't produce structured output | Check log for errors mid-run |
| `OVERALL: FAIL` | One or more journeys failed | Read summary for specific failures |
| No dynamic journeys generated | No UI-relevant commits found or LLM skipped regression section | Check `commit-messages.txt` in artifacts |
| Timeout (20min) | App hung or Droid stuck in a loop | Check if app launched; may need longer `waitForReadyMs` |

---

## How Dynamic Regression Works (Technical Detail)

The default mode's dynamic regression system uses these shell steps:

1. **Find last successful run**: Queries the GitHub API for the most recent successful run of this workflow on the `dev` branch. Falls back to `HEAD~20` if no prior run exists.

2. **Generate commit summary**: Runs `git log`, `git diff --name-only`, `git diff --stat`, and `git diff` (truncated to ~200 lines) between the last successful SHA and current SHA, filtered to UI-relevant paths.

3. **Map files to UI areas**: Greps changed file paths against feature directories to determine affected areas (e.g., `features/settings` -> "settings", `features/composer` -> "composer").

4. **Risk categorisation**: Parses conventional commit prefixes:
   - `fix:` / `fix(...)` = **HIGH** (bugs were found here, test heavily)
   - `refactor:` = **MEDIUM-HIGH** (restructuring can break things)
   - `feat:` = **MEDIUM** (new surface area to verify)
   - `chore:` / `docs:` / `style:` / `test:` / `ci:` / `build:` = **LOW**

5. **Prompt assembly**: All context (commits, files, diffs, risk summary, areas) is injected into the prompt. The LLM is instructed to:
   - Discover real selectors via `get_page_state` on affected areas
   - Output a structured JSON test plan before executing
   - Allocate more tests to high-risk areas
   - Retry failed selectors once before marking FAIL
   - Mark known-flaky areas as SKIP instead of FAIL

### Known Flaky Areas

These areas behave differently in guest/CI mode and are documented in the prompt:

- **Connectors catalog**: May be empty in guest mode (no API keys)
- **Voice settings**: Model dropdowns may not populate without API keys
- **Automations model selection**: Depends on backend configuration
- **Library content**: May be empty if no knowledge items exist
- **Onboarding wizards**: May not appear in guest mode

---

## Comparison: Local vs Cloud Testing

| Aspect | Local (`/test-ui`) | Cloud (`/test-cloud-ui`) |
|--------|-------------------|-------------------------|
| Environment | Your machine | Clean CI runner (macos-latest) |
| Speed | Faster (warm cache) | Slower (cold build every time) |
| State | May have local config/data | Clean slate (guest mode) |
| Interactive | Yes (can retry, inspect) | No (fire-and-forget, read logs after) |
| Test strategy | Manual / ad-hoc | Dynamic regression based on git history |
| Best for | Iterating on UI changes | Verifying on clean env, regression sweeps, async checks |

---

## See Also

- [AGENT_UI_TESTING.md](AGENT_UI_TESTING.md) -- Local agent UI testing router (CLI, packaged, dev-CDP, MCP, and E2E paths)
- [TESTING_E2E.md](TESTING_E2E.md) -- Playwright E2E tests (deterministic, no LLM involved)
- Planning doc: `docs/plans/260318_ui_smoke_test_prompt_improvements.md` -- design rationale for the dynamic regression system
- Workflow source: `.github/workflows/ui-smoke-test.yml`
- Droid slash command: `.factory/commands/test-cloud-ui.md`
