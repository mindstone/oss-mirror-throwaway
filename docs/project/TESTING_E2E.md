---
description: "Canonical E2E testing guide — Playwright Electron setup, packaged-app driving, test writing, maintenance, troubleshooting"
last_updated: "2026-05-31"
---

# E2E Testing

End-to-end tests for Mindstone Rebel using Playwright with Electron support.

> **Reading order for E2E docs:**
> 1. **This doc** — How to run, write, and maintain E2E tests (start here)
> 2. [E2E_TEST_FIXING_GUIDELINES.md](./E2E_TEST_FIXING_GUIDELINES.md) — **STOP: Read before fixing any failure.** Diagnosis process, prohibited actions, reporting template
> 3. [WHY_E2E_TESTS_ARE_HARD_TO_FIX.md](./WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) — Known hard problems and fix attempt history (check before repeating a failed approach)
> 4. [TESTING_E2E_GAP_ANALYSIS.md](./TESTING_E2E_GAP_ANALYSIS.md) — Repeatable approach for finding test gaps using multi-subagent analysis

## See Also

- [TESTING_E2E_GAP_ANALYSIS.md](./TESTING_E2E_GAP_ANALYSIS.md) - Repeatable approach for finding E2E test gaps and generating prioritized improvements
- [TESTING_AUTOMATION_OVERVIEW.md](./TESTING_AUTOMATION_OVERVIEW.md) - Unit/integration tests (Vitest) and where tests live
- [TESTING_AUTOMATION_OVERVIEW.md § UI testing in plans](./TESTING_AUTOMATION_OVERVIEW.md#when-to-include-ui-testing-in-feature-plans) - Including test verification stages in feature plans
- [AGENT_UI_TESTING.md](./AGENT_UI_TESTING.md) - Scenario router for agent UI verification paths
- [SCREENSHOTS.md](./SCREENSHOTS.md) - Automated screenshot capture (same Playwright infrastructure, separate project)
- [CHANGELOG_UPDATE_PROCESS.md](./CHANGELOG_UPDATE_PROCESS.md) - After updating changelog, consider E2E test coverage (see Appendix B)

## AI Agent Guidance

Use a subagent to run E2E tests (e.g., `time npm run test:e2e`) and report back in detail—output is verbose and benefits from summarization. Before fixing any failures, read `E2E_TEST_FIXING_GUIDELINES.md`.

**Keep these docs current.** After writing or fixing E2E tests, update the relevant doc if you learned something that would save a future agent time. Good additions: new patterns/gotchas, selector or timing lessons, CI-vs-local differences, test utility tips. Skip additions that just restate what's already documented or describe one-off issues unlikely to recur. Specifically:
- **This doc** — New test utilities, configuration tips, writing patterns, troubleshooting entries
- [E2E_TEST_FIXING_GUIDELINES.md](./E2E_TEST_FIXING_GUIDELINES.md) — New diagnosis techniques, prohibited/acceptable fix patterns
- [WHY_E2E_TESTS_ARE_HARD_TO_FIX.md](./WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) — New fix attempt entries (always), new TL;DR lessons (when broadly applicable)

## Driving the packaged app interactively (ad-hoc verification, no dev server)

This is **not** the test suite — it's how an agent or developer drives the *real* app to confirm a change works (click around, seed data, screenshot), reusing the same Playwright Electron primitive the E2E suite uses.

**When to use this instead of `electron-forge start`** (`.factory/commands/test-ui.md` / the `run-app` skill): use the dev-server path for fast HMR iteration. Use **this packaged-app path** when you need a *deterministic, resident* app — in particular from harnesses **without a persistent TTY** (e.g. Claude Code background tasks, CI), where `electron-forge start`'s interactive watch exits and tears down the Vite dev server + Electron. (Root cause: forge hardcoded interactive/TTY mode; fixed upstream in [electron/forge#4219](https://github.com/electron/forge/pull/4219), merged 2026-05-13.)

**Why it's robust:** a packaged build loads the renderer from disk via `loadFile` (`src/main/index.ts` dev-vs-file branch) — there is **no Vite dev server** and **no forge watch process** to die. The only process is Electron itself, and Playwright's `_electron.launch` owns its lifetime: the app stays up for exactly as long as your driver script runs (until `app.close()`). This is harness-agnostic — any harness that can run `node`/`npx tsx` can use it (Droid, Cursor, Codex CLI, Claude Code).

**Recipe:**

1. Build once (rebuild after **renderer** changes too — dev serves the renderer from Vite, so `out/renderer` is stale until you repackage):
   ```bash
   npm run package
   ```
2. Drive it from a Node script. Launch env/args mirror `tests/e2e/test-utils.ts` `launchWithIsolatedUserData()`; resolve the binary via `scripts/resolve-packaged-app.ts` `resolvePackagedAppPaths()` (channel/platform-aware) rather than hardcoding. Verified pattern (macOS):
   ```ts
   // Save as drive.ts, run from repo root: `npx tsx drive.ts`
   // Use a .ts file (NOT .mts): tsx runs it as CommonJS (package.json has no "type":"module"),
   // which is what the CJS `resolve-packaged-app` named import + __dirname need. CJS means no
   // top-level await — wrap the body in an async IIFE.
   import { _electron as electron } from 'playwright';
   import { resolvePackagedAppPaths } from './scripts/resolve-packaged-app';
   import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

   void (async () => {
     const p = resolvePackagedAppPaths();
     const bin = path.join(p.appPath, 'Contents', 'MacOS', p.productName); // darwin; use p.exePath / p.linuxExePath elsewhere
     const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-ui-'));
     const app = await electron.launch({
       executablePath: bin,
       args: [`--rebel-test-user-data-dir=${userDataDir}`],
       cwd: process.cwd(),
       timeout: 0,
       env: { ...process.env,
         REBEL_TEST_MODE: '1', REBEL_E2E_TEST_MODE: '1',
         REBEL_USER_DATA: userDataDir, REBEL_TEST_USER_DATA_DIR: userDataDir,
         REBEL_TEST_ALLOW_NON_TEMP_USERDATA: '' },
     });
     const win = await app.firstWindow({ timeout: 90_000 });   // rebel-test mode auto-bypasses onboarding + guest mode
     // drive: win.evaluate(...), navigate via #flow-tab-* clicks, win.screenshot(...)
     // seed data with no API key:  await win.evaluate(() => window.sessionsApi.upsert(session)); await win.reload();
     await app.close();
     fs.rmSync(userDataDir, { recursive: true, force: true });
   })();
   ```
   - `rebel-test` mode (via `REBEL_TEST_MODE=1`) hides the window, isolates `userData`, and bypasses onboarding/guest-login (see "How It Works" in `.factory/commands/test-ui.md`). The window renders offscreen; `win.screenshot()` still works.
   - **Seeding without an API key:** the isolated profile is empty and there's no LLM key for real turns. Inject sessions via `window.sessionsApi.upsert(session)` then `win.reload()` so the sidebar index picks them up. Minimal `AgentSession`: `{id,title,createdAt,updatedAt,messages:[{id,turnId,role,text,createdAt}],eventsByTurn:{},activeTurnId:null,isBusy:false,lastError:null,resolvedAt:null,deletedAt:<ts|null>,origin:'manual',isCorrupted:false}`.
   - **External CDP instead of the Playwright handle:** add `REMOTE_DEBUGGING_PORT: '9222'` to `env` (`src/main/index.ts` binds it to `127.0.0.1`) and connect with `chromium.connectOverCDP('http://127.0.0.1:9222')` — useful for Droid's `agent-browser` or `curl`-based driving while the launch script holds the process.

   Verified 2026-05: this exact snippet (binary resolved via `resolvePackagedAppPaths()`, launched as a `.ts` via `npx tsx`) boots the app (`e2eApi.getReadiness().appReady === true`, `window.sessionsApi` present); and a fuller version of it seeded soft-deleted conversations, navigated to Trash, and screenshotted the read-only view — the app stayed resident for the whole drive with no dev server to tear down.

### Reusable helper: `scripts/drive-packaged-app.ts`

Rather than re-derive the launch env / argv / shims / close gotchas each time, use the helper:

```ts
import { launchPackagedApp } from './scripts/drive-packaged-app';
const { win, close } = await launchPackagedApp();      // boots packaged app in rebel-test mode
await win.evaluate(() => window.e2eApi.seedStagedCall({ sessionId: 'automation-x', blockedBy: 'eval_error' }));
await win.reload();                                     // fetch-gated surfaces re-fetch on reload (see below)
await win.screenshot({ path: '/tmp/x.png', fullPage: true });
await close();                                          // quit→close watchdog + SIGKILL fallback; cleans userData
```

It also has a CLI smoke mode: `npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/card.png`.

It bakes in three things every hand-rolled driver otherwise gets wrong:
- **Launch env + argv for the e2e gates.** `window.e2eApi` is exposed only when the renderer process sees `--e2e-test-mode` AND `--e2e-test-user-data-dir=` argv (`src/preload/index.ts` `isE2EApiEnabled`), which is a *separate* gate from the main-process `REBEL_E2E_TEST_MODE` env. The helper passes both.
- **`globalThis.__name` shim.** `tsx`/esbuild `keepNames` injects `__name()` into the function strings you pass to `win.evaluate(...)`; without a `globalThis.__name` shim on the page you get `ReferenceError: __name is not defined`. The helper injects it via `addInitScript` (survives reloads) + an immediate eval.
- **Robust close.** `app.quit()` → `app.close()` inside a 12s `Promise.race` watchdog with a `SIGKILL` fallback, so a wedged renderer never leaves a leaked Electron process. (Bare `app.close()` exits cleanly in ~3s in practice — the watchdog is belt-and-braces.)

### Seeding approvals / staging surfaces (test-mode `window.e2eApi`)

In `REBEL_E2E_TEST_MODE` (which `--rebel-test` force-sets), `window.e2eApi` exposes seed hooks that inject state through the **real** services so the UI surfaces it — useful for driving surfaces that otherwise only appear during a live agent turn:

| `window.e2eApi.*` | Seeds | Renders in | Notes |
|---|---|---|---|
| `seedStagedCall(input)` | a staged tool call (`stageToolCall`) + `tool-safety:staged-call` broadcast | notification-bell drawer / in-conversation staged calls | `input` is a partial `StageToolCallInput`; defaults give a high-risk `eval_error` card. Returns `{success,id}`. |
| `seedStagedFile(input)` | a staged memory file (`writeToPending`) + `memory:staged-files-changed` | Pending-Changes panel / drawer | Returns `{success:false, reason:'no-workspace'}` unless a Chief-of-Staff workspace is configured (seed settings first). |
| `injectToolApproval` / `injectMemoryApproval` | legacy deny-then-retry approval requests | approval drawer | pre-existing; different code path from staging. |

**Gotcha — staged calls need an "available" session.** `usePendingApprovals` filters staged calls through `isApprovalSourceSessionAvailable` (`src/renderer/features/inbox/hooks/usePendingApprovals.ts:235`): a staged call only surfaces in the global approval UI if its `sessionId` is empty, a **known non-deleted session**, or an **`automation-*` / `automation-insight-*`** kind (`src/shared/sessionKind.ts`). A staged call for an arbitrary unknown `sessionId` is treated as orphaned and silently dropped (bell count stays 0). Two recipes:
- **Self-contained (no conversation):** seed with `sessionId: 'automation-<x>'` → surfaces in the **notification-bell drawer** after `win.reload()` (this is the "no-human/automation staged call → global drawer" path). Verified end-to-end 2026-05-31: a seeded `eval_error` automation staged call renders the approval card with honest copy and no trust-promotion options.
- **In-conversation:** seed a session via `window.sessionsApi.upsert(session)` first, then seed the staged call with that `sessionId`; open the conversation to see the in-conversation staged-call card.

**Push vs fetch — why `win.reload()` matters.** Renderer approval/notification surfaces ingest state two ways:
- **Fetch-gated** (render after an `invoke` resolves): the unified inbox (`usePendingApprovals` → `stagedGetAll`, `getStagedFiles`, `getPendingApprovals`), the Actions/Inbox panel. A seed that lands *after* the surface's initial fetch won't show until a re-fetch → **`win.reload()` after seeding** is the reliable trigger (the surface re-mounts and re-fetches).
- **Push-based** (update live from an IPC broadcast the renderer subscribes to): toasts (`cooldown:status-changed` → `useApiCooldownEvents`), live staged-call/​staged-file broadcasts. These update an already-open surface without a reload — but a cold driver that seeds before the surface mounts should still `reload()` to be safe.

The seed hooks do **both** (write-through + broadcast), so `reload()` is the robust catch-all.

## Prerequisites

- Node.js 18+
- macOS (tests currently target darwin only)
- A packaged app build (`npm run package`)

## Environment Setup

Create a `.env.test` file in the project root with your test credentials:

```bash
# Required: Claude API key
TEST_CLAUDE_API_KEY=<your-claude-api-key>

# Required: Voice provider (one of these)
TEST_OPENAI_API_KEY=<your-openai-api-key>
# OR
TEST_ELEVENLABS_API_KEY=<your-elevenlabs-api-key>

# Legacy note: `TEST_KLAVIS_CONFIG` used to exist for a Klavis onboarding step.
# Klavis has been removed; do not add this to new tests.

# Optional: Custom workspace directory (defaults to temp dir)
TEST_WORKSPACE_DIR=/path/to/test/workspace
```

> **Security**: The `.env.test` file is gitignored and should never be committed.

### Quick Setup from Existing App (macOS)

If you already have Rebel configured, you can extract API keys from your existing settings:

```bash
# Read keys from your Electron store (read-only, non-destructive)
SETTINGS_FILE="$HOME/Library/Application Support/mindstone-rebel/app-settings.json"

cat > .env.test << EOF
# E2E Test Credentials (extracted from app-settings.json)
TEST_CLAUDE_API_KEY=$(jq -r '.claude.apiKey // empty' "$SETTINGS_FILE")
TEST_OPENAI_API_KEY=$(jq -r '.voice.openaiApiKey // empty' "$SETTINGS_FILE")
TEST_ELEVENLABS_API_KEY=$(jq -r '.voice.elevenlabsApiKey // empty' "$SETTINGS_FILE")
EOF

echo "Created .env.test with keys from existing settings"
```

**Note:** This reads your existing keys—it does not modify your app settings.

## Running Tests

### 1. Build the packaged app

```bash
npm run package
```

### 2. Run all E2E tests

```bash
# Load env vars and run tests
set -a && source .env.test && set +a && npm run test:e2e
```

### 3. Run specific test file

```bash
set -a && source .env.test && set +a && npx playwright test onboarding.spec.ts
```

### 4. Run with verbose output

```bash
set -a && source .env.test && set +a && npx playwright test --reporter=list
```

### 5. Run in debug mode

```bash
set -a && source .env.test && set +a && npx playwright test --debug
```

## Test Suites

### Test File Organization

E2E tests are organized into **independent domain-based test files**. Each file manages its own app lifecycle with `beforeAll`/`afterAll` hooks.

| Test File | Tests | Domain |
|-----------|-------|--------|
| `electron-smoke.spec.ts` | 9 | App shell, navigation, connectors, automations |
| `approval-flows.spec.ts` | 12 | Tool safety, memory write approval bars |
| `conversation.spec.ts` | 10 | Multi-turn, editing, stop, copy |
| `message-queue.spec.ts` | 7 | Queue UI, queued message handling |
| `session-management.spec.ts` | 11 | Search, delete, @mentions, drafts |
| `session-persistence.spec.ts` | 1 | Session history (requires restart) |
| `settings.spec.ts` | 3 | Settings UI + theme persistence |
| `workspace.spec.ts` | 3 | Library panel, file operations |
| `onboarding.spec.ts` | 9 | First-run wizard |
| `tutorial-checklist.spec.ts` | 1 | Tutorial checklist widget |
| `voice-session-routing.spec.ts` | 1 | Voice session routing |

**Total: ~109 tests across 22 files** (some currently skipped; `screenshots.spec.ts` runs separately via `npm run capture:screenshots`).

**Performance regression tests** (`perf-*.spec.ts`) run separately via `npm run test:e2e:perf`. These test IPC payload sizes, memory leaks, CDP structural metrics, and timing signals. They use the same Playwright infrastructure but are isolated in a separate `perf` project. See [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) for full documentation.

### Onboarding Flow (`tests/e2e/onboarding.spec.ts`)

Tests the onboarding wizard (standalone - needs fresh first-run state):

| Step | Test | What it verifies |
|------|------|------------------|
| 1 | Welcome | Intro screen with "Let's check" CTA |
| 2 | Workspace | Save location directory selection |
| 5 | Skip | Escape hatch to skip remaining steps |
| - | Escape | Welcome screen escape hatch |

## Test Configuration

Configuration is in `playwright.config.ts`:

- **Workers**: 2 in CI, 4 locally (parallel execution enabled)
- **Timeout**: 120 seconds per test (default)
- **Retries**: 0 (Electron state hard to reset between retries)
- **globalSetup**: Cleans up orphaned test processes before workers start
- **globalTeardown**: Logs warnings if any test processes leak

### Timeout Guidance for Slow Tests

The 120s default is insufficient for tests involving LLM calls or multiple turns. Use `test.describe.configure()` at the describe level:

```typescript
// IMPORTANT: test.setTimeout() only affects individual tests, NOT beforeAll/afterAll hooks.
// Use describe-level config when hooks include slow operations (app launch + onboarding + LLM calls).

test.describe.serial('Multi-turn Conversations', () => {
  test.describe.configure({ timeout: 660_000 }); // 4 turns × 150s + buffer
  
  test.beforeAll(async () => {
    // This hook is now covered by the 660s timeout
  });
});
```

**Timeout recommendations from `WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`:**
- Simple UI tests: 120s (default)
- Tests with 1 LLM call: 300s
- Tests with onboarding + LLM: 420s
- Multi-turn (4 turns): 660s

### Electron Window Visibility

There is no true "headless" mode for Electron like there is for browsers. The `headless: true` setting in `playwright.config.ts` only applies to browser-based Playwright tests, not Electron.

**However, in E2E test mode (`isE2eTestMode()`), the window is never shown.** The app skips `mainWindow.maximize()` and `mainWindow.show()`, keeping the window hidden. This works because:
- Playwright uses CDP (Chrome DevTools Protocol), not native OS events, so interactions work on non-shown windows
- `webContents.backgroundThrottling = false` keeps `document.hidden` as `false` and prevents timer/RAF throttling, so all visibility-aware code (e.g. `useVisibilityAwareInterval`) runs normally
- Screenshots via CDP work because Chromium renders to an offscreen buffer regardless of show state
- On macOS, `app.dock.hide()` removes the dock icon to avoid visual noise

**Trade-off:** `mainWindow.on('focus')` never fires for a never-shown window, so focus-triggered behaviors (GPU unthrottling, `cloudRouter.onAppFocused()`, `clearUnreadDot()`) don't run. This is acceptable because GPU workers start unthrottled, cloud sync is mocked in E2E, and dock badge is suppressed in test mode. If future tests need focus-triggered refresh behavior, dispatch synthetic DOM focus events (see `clearPendingApprovalsViaIpc` in `test-utils.ts` for an example).

On CI (Linux), Xvfb provides a virtual framebuffer as an additional layer.

## Writing Tests

### Prefer Fewer, Longer Tests

E2E tests are expensive (app launch, isolated userData, cleanup). **Consolidate related assertions into fewer tests** rather than splitting into many small ones:

```typescript
// Good: One test exercises the full flow
test('Widget renders and interactions work', async () => {
  // Verify initial render
  await expect(widget).toBeVisible();
  await expect(widget.locator('text=Title')).toBeVisible();
  
  // Test interaction
  await widget.locator('button').click();
  await expect(widget.locator('text=Updated')).toBeVisible();
});

// Avoid: Many tiny tests with shared setup cost
test('Widget is visible', ...);
test('Widget has title', ...);
test('Button click works', ...);
```

Save granular "one assertion per test" for unit tests where setup is cheap.

### Using `test.step()` for Clarity in Longer Tests

When consolidating tests, use `test.step()` to label logical phases. This improves debugging by showing **which step failed** in reports and traces:

```typescript
test('Full conversation workflow', async () => {
  await test.step('Create new chat', async () => {
    await newChatButton.click();
    await expect(chatInput).toBeVisible();
  });

  await test.step('Send message and verify response', async () => {
    await chatInput.fill('Hello');
    await sendButton.click();
    await expect(response).toContainText('Hi');
  });

  await test.step('Edit message', async () => {
    await editButton.click();
    await chatInput.fill('Updated');
    await saveButton.click();
  });
});
```

**Benefits of `test.step()`:**
- Playwright reports show which step failed (not just line numbers)
- Trace viewer groups actions by step for easier navigation
- You can attach screenshots/files per step via `testStepInfo.attach()`

**Limitations (steps don't solve these):**
- Can't re-run just one step - the whole test retries
- Earlier step failures prevent later steps from running
- State accumulates across steps (no isolation between them)

**Best practice:** Use `test.step()` within tests, but keep separate `test()` blocks for logically distinct workflows within the same `describe()`. This balances clarity with the ability to run/debug individual flows.

### Using Test IDs

Prefer `data-testid` attributes for reliable selectors:

```typescript
// Good
await window.locator('[data-testid="landing-title"]').click();

// Avoid (fragile)
await window.locator('.landing-page h1').click();
```

### Existing Test IDs

See `src/renderer/components/ui/README.md` for the full list of available test IDs.

### Adding New Test IDs

Follow the naming convention: `{feature}-{element}`

```tsx
<button data-testid="settings-save-button">Save</button>
```

## Troubleshooting

### Tests fail with "Packaged app not found"

Run `npm run package` before running tests.

### Tests fail due to single-instance lock

Electron's `app.requestSingleInstanceLock()` can cause test failures when parallel workers or leaked processes hold the lock. The test isolation utilities in `tests/e2e/test-utils.ts` mitigate this by using unique `REBEL_USER_DATA` paths per test run, which gives each instance its own lock file. If you see lock-related failures, ensure no stale Electron processes are running (`pkill -f mindstone-rebel`) and that `REBEL_TEST_USER_DATA_DIR` is set to `auto` or a unique temp path.

### Tests timeout waiting for elements

1. Check if the app is launching correctly
2. Increase timeout in specific test: `{ timeout: 30000 }`
3. Check error context file in `test-results/` for page snapshot

### Space wizard rejects temp folders

The AddSpaceWizard validates paths and rejects temp folders with errors like "Cannot use a temporary folder as a space". Tests that create spaces use the project-local `tmp/e2e-test-spaces/` folder (already gitignored). Cleanup in `afterAll` removes these folders automatically on success.

### Debugging blank/white screens

If the app renders a blank white window during E2E runs:

1. **Reproduce with the built app**
   - Run `npm run build`.
   - Run `npm run test:e2e -- --headed --trace=on`.
   - If the test fails, open the generated trace/screenshot to see exactly what the renderer rendered (or what error occurred) at startup.

2. **If the built app passes but `npm run dev` is blank**
   - The dev code path uses `ELECTRON_RENDERER_URL` (dev server at `http://localhost:5173/`) instead of the built `index.html`.
   - Try pointing Playwright (or `playwright codegen`) at `http://localhost:5173/` in a regular browser context to inspect the renderer independently of Electron.
   - This separation reveals whether the blank screen is caused by the **renderer bundle** (e.g. runtime error in React) or by **Electron's window failing to load the dev URL**.

### Approval drawer lazy-mount regressions

If multiple approval-related tests fail simultaneously (e.g., 15+ failures across `approval-flows.spec.ts`), suspect an **approval drawer lazy-mount regression**. The approval drawer is lazily mounted — it only renders when there are pending approvals. If the renderer broadcasts an approval event before the approval state has been persisted to the main-process store, the drawer may not mount (because a re-query of the store returns no pending approvals), causing tests that wait for approval UI to time out.

**Root cause pattern:** Code that broadcasts `approval:pending` to the renderer *before* writing the approval to the store. The renderer receives the event, triggers a re-render, queries the store for pending approvals, gets an empty list, and never mounts the drawer.

**Fix:** Always persist approval state to the main-process store *before* broadcasting the event to the renderer. This ensures the store query returns the correct data when the lazy-mount check runs.

**Detection:** If you see a cluster of approval test failures with timeouts waiting for `[data-testid="approval-drawer"]` or similar approval UI selectors, check recent changes to approval event broadcasting order in the main process.

### Landing page overlay blocks interaction

Use the `ensureConversationPaneVisible()` pattern to dismiss the landing overlay:

```typescript
const landingWrapper = window.locator('.landing-wrapper');
const hasHidden = await landingWrapper.evaluate(n => n.classList.contains('hidden'));
if (!hasHidden) {
  await window.locator('[data-testid="landing-history-button"]').click();
}
```

## CI Integration

### Current Status (as of 2026-03-19)

E2E tests in the main release pipeline (`release.yml`) are **temporarily disabled** because they
were failing at 100% rate and burning expensive macOS runner minutes on every build. The
`e2e-auto-fix.yml` workflow was disabled at the same time.

### One-Off E2E Runs

To check which tests are currently passing/failing without re-enabling E2E in the release
pipeline, use the dedicated one-off workflow: `.github/workflows/e2e-one-off.yml`.

**From the GitHub Actions UI** (if the workflow file exists on `main`):
1. Go to **Actions > "E2E Tests (One-Off)" > Run workflow**
2. Select the branch to test
3. Click "Run workflow"

**From the CLI** (works even if the file only exists on `dev`):
```bash
# Trigger against dev branch
gh workflow run e2e-one-off.yml --ref dev

# Trigger against a specific branch
gh workflow run e2e-one-off.yml --ref dev -f branch=feature/my-branch

# Watch the run
gh run list --workflow=e2e-one-off.yml --limit 1
gh run watch
```

The workflow builds a macOS arm64 app (unsigned, to save time), runs the Playwright suite, and
uploads the Playwright report as an artifact. It automatically detects `BUILD_CHANNEL` from the
branch (`main` = stable, anything else = beta) so the app name and test paths stay consistent.

### Release Pipeline E2E (currently disabled)

When enabled in `release.yml`, E2E tests use **pre-built artifacts from the build job** (not a
local rebuild), ensuring they exercise the exact same binary that gets distributed. See
`docs/plans/finished/260201_e2e_use_production_artifacts.md` for rationale.

How it works:
1. `build-macos` job creates the signed, packaged app via `electron-forge make`
2. The packaged `.app` directory is **tar'd** before upload to preserve macOS symlinks
   (`actions/upload-artifact` destroys symlinks — see `WHY_E2E_TESTS_ARE_HARD_TO_FIX.md` entry #20)
3. `test-e2e` job downloads and extracts the tar, restoring the intact `.app` bundle
4. Tests run with `npm run test:e2e` against the production-identical binary
5. Test artifacts are uploaded on failure for debugging

### Local Development

Local E2E development continues to use `npm run package`:

```bash
npm run package
set -a && source .env.test && set +a && npm run test:e2e
```

The test utilities in `test-utils.ts` resolve app paths dynamically and work with both
CI-downloaded artifacts and locally-built packages.

### Required Secrets

The following secrets are configured in [GitHub Actions secrets](https://github.com/mindstone/rebel-app/settings/secrets/actions):

- `TEST_CLAUDE_API_KEY` - Claude API key for conversation tests
- `TEST_ELEVENLABS_API_KEY` - Voice provider key

**Note:** For tests to use these secrets, they must be explicitly passed via the `env:` block in the workflow step. See the "Run Playwright e2e tests" step in `release.yml`.

## Isolated UserData Testing

E2E tests run with **isolated userData directories** to protect real user settings from corruption.

### Why This Matters

Before isolation, tests used `backupSettings()`/`restoreSettings()` which directly manipulated `~/Library/Application Support/mindstone-rebel/`. If tests crashed mid-run, real settings could be lost or corrupted. With isolated userData, each test run uses a fresh temporary directory that cannot affect your real data.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `REBEL_TEST_USER_DATA_DIR` | Path to isolated userData directory (must be under `os.tmpdir()`) |
| `REBEL_TEST_USER_DATA_DIR=auto` | Auto-generate a unique temp directory |
| `REBEL_E2E_KEEP_USER_DATA` | Set to `1` to preserve userData after successful tests (for debugging) |
| `REBEL_TEST_ALLOW_NON_TEMP_USERDATA` | Escape hatch to allow non-temp paths (dangerous, use only for debugging) |

### Test Utilities

The test utilities in `tests/e2e/test-utils.ts` provide three main functions:

#### `createIsolatedUserData(testName?: string): IsolatedUserData`

Creates a unique temp directory for test userData. Returns an object with:
- `path` - The absolute path to the isolated directory
- `cleanup()` - Function to remove the directory when done

```typescript
const isolated = createIsolatedUserData('my-test');
// isolated.path = /var/folders/.../rebel-e2e-my-test-xxxxx
```

#### `launchWithIsolatedUserData(isolated, options): Promise<ElectronApplication>`

Launches the Electron app with the isolated userData directory. Automatically verifies isolation before returning.

```typescript
const isolated = createIsolatedUserData('settings-test');
const electronApp = await launchWithIsolatedUserData(isolated, {
  usePackagedApp: true,  // Use packaged app (default)
  additionalArgs: []     // Extra args to pass to Electron
});
```

#### `launchIsolatedApp(testName, options): Promise<{electronApp, cleanup, userDataPath}>`

Convenience function that combines creation and launch. Recommended for tests that need live LLM calls.

```typescript
const { electronApp, cleanup, userDataPath } = await launchIsolatedApp('onboarding');
// ... run tests ...
await electronApp.close();
cleanup();  // Remove temp directory
```

#### `launchWithMocking(testName, options): Promise<{electronApp, cleanup, userDataPath}>`

**Recommended for most UI tests.** Launches app with LLM mocking enabled, reducing test time from 60-150s to <30s per test.

```typescript
import { launchWithMocking, mockResponse, safeCloseApp } from './test-utils';

const { electronApp, cleanup, userDataPath } = await launchWithMocking('my-test', {
  mockResponses: [
    mockResponse(/hello/i, 'Hello! How can I help?'),
  ],
  voiceMocking: true,  // Optional: also mock TTS/STT
});
// ... run tests ...
await safeCloseApp(electronApp, 15000, userDataPath);
cleanup();
```

**Auth handling:** `launchWithMocking()` automatically seeds a dummy Claude API key (`sk-ant-e2e-mock-...`) when `TEST_CLAUDE_API_KEY` is not set. This satisfies the auth validation gate (which would otherwise disable the send button) while the mock intercepts `agent:turn` before any real API call is made. Tests that send messages through the composer need this to avoid "Authentication is missing" errors.

**When to use mocking vs live calls:**
- **Use `launchWithMocking()`** for UI flow tests, navigation, settings, workspace operations — no API key needed
- **Use `launchIsolatedApp()`** for integration tests that verify real LLM behavior — requires `TEST_CLAUDE_API_KEY`

See `tests/e2e/mocks/llm-mock.ts` and `tests/e2e/mocks/voice-mock.ts` for advanced options.

### Migration Pattern

**Before (unsafe):**
```typescript
test.beforeAll(async () => {
  await backupSettings();  // Risk: crash leaves settings corrupted
});

test.afterAll(async () => {
  await restoreSettings();  // May not run if test crashes
});
```

**After (safe):**
```typescript
let isolated: IsolatedUserData;
let electronApp: ElectronApplication;
let testFailed = false;

test.beforeAll(async () => {
  isolated = createIsolatedUserData('my-test');
  electronApp = await launchWithIsolatedUserData(isolated);
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') {
    testFailed = true;
  }
});

test.afterAll(async () => {
  await electronApp?.close();
  // Keep on failure for debugging, clean on success
  if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
    isolated?.cleanup();
  } else {
    console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
  }
});
```

### Writing Settings Before Launch

If your test needs specific settings pre-configured:

```typescript
import * as fs from 'fs';
import * as path from 'path';

const isolated = createIsolatedUserData('workspace-test');

// Write settings to isolated directory BEFORE launch
const settingsPath = path.join(isolated.path, 'app-settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({
  onboardingCompleted: true,
  coreDirectory: '/path/to/test/workspace'
  // ... other settings as needed
}));

const electronApp = await launchWithIsolatedUserData(isolated);
```

### Safety Verification

The isolation system has multiple tripwires that will **abort tests with clear errors** if something goes wrong:

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `CRITICAL: Test userData path must be under system temp directory!` | `REBEL_TEST_USER_DATA_DIR` points outside temp | Use `=auto` or a path under `os.tmpdir()` |
| `CRITICAL: Test isolation failed!` | Import ordering bug in main process | Check `src/main/index.ts` imports `ensureTestUserData` first |
| `SAFETY ABORT: userData isolation failed!` | Post-launch verification found wrong path | Check for cached paths in early imports |
| `SAFETY ABORT: Test is using REAL userData path!` | Somehow ended up at real userData | Report as bug - should be impossible |

**Key safety code locations:**
- `src/main/startup/ensureTestUserData.ts` - Enforces temp directory requirement
- `tests/e2e/test-utils.ts` - Post-launch verification in `launchWithIsolatedUserData()`
- `src/main/settingsStore.ts` - Defense-in-depth call to `assertTestIsolationIfRequired()`

### Known Limitations

**Logger may write to real userData if import ordering breaks:**

If the import ordering in `src/main/index.ts` is broken (e.g., something imports `logger.ts` before `ensureTestUserData.ts`), the logger may create log files in the real userData directory before the test fails. This is a known limitation because:

- Logs are not sensitive user data (settings/history are the protected data)
- The test WILL still fail with a clear error message
- Settings and conversation history are fully protected by the temp directory requirement

See `LOGGING.md` for more details on this limitation.

## Future Tests (TODO)

### Known Deferred Gaps (2026-04-12)

The following features were assessed for E2E coverage and deferred due to infrastructure barriers. See `docs/plans/260412_e2e_test_gap_coverage.md` for the full ease×value analysis.

- **Subscription cost UI** (`UsageTooltipContent`): No `data-testid` on tooltip trigger or content. Requires mock turn with `authMethod`/`costUsd` metadata that `launchWithMocking()` doesn't currently emit. Tooltip hover interactions are fragile in Playwright. Unit tests cover the business logic. **Unblock by:** adding `data-testid="turn-usage-trigger"` and `data-testid="usage-tooltip-content"`, plus extending the LLM mock to emit subscription-style usage metadata.
- **Focus goal alignment** (`FocusPanel`, `GoalsSidebar`, `goalAlignmentService`): Requires Focus feature flag, calendar mock data, goal seeding from workspace README frontmatter, and prep data assembly (LLM-dependent). No existing E2E infrastructure for any of this. **Unblock by:** creating `seedGoalData()`, `seedCalendarEvents()`, and `enableFocusFeature()` helpers in `test-utils.ts`.

### Context Overflow Handling

Test that the app gracefully handles context window overflow. Approaches to consider:

1. **Large messages** - Send extremely long prompts to trigger overflow
2. **Many turns** - Run many consecutive turns until context fills
3. **Mock threshold** - Lower the context limit for testing (requires code changes)

Option 2 is most realistic but slow/expensive. Option 3 is fastest but requires app modifications.

---

## Appendix A: Parallel Execution

Parallel test execution is **enabled by default** with `workers: 2` in CI and `workers: 4` locally.

### How It Works

- **globalSetup** (`tests/e2e/global-setup.ts`) runs once before any workers start, cleaning up orphaned `rebel-e2e-*` processes from previous runs
- Each test file gets its own **isolated userData directory** via `createIsolatedUserData()`
- **Super-MCP ports** are dynamically allocated via `findAvailablePort()` - each worker gets a unique port
- **globalTeardown** (`tests/e2e/global-teardown.ts`) logs warnings if any test processes are still running after the suite

### Resource Considerations

| Resource | How It's Handled |
|----------|------------------|
| **Super-MCP ports** | Dynamic allocation with retry loop (5s delay on collision) |
| **API rate limits** | Use `launchWithMocking()` for most tests |
| **System resources** | Limited to 2 workers in CI, 4 locally |
| **Test space folders** | Each test file uses unique `TEST_SPACE_BASE` paths |

### Scaling Workers

To increase parallelism (after validating stability):

```ts
// playwright.config.ts
workers: process.env.CI ? 3 : 6  // Increase from default 2/4
```

Monitor for API rate limit errors if using live LLM calls.

---

## Appendix B: E2E Test Maintenance Process

After updating the changelog (see `CHANGELOG_UPDATE_PROCESS.md`), follow this process to ensure E2E tests stay current and efficient.

### When to Run This Process

- After significant feature work (multiple changelog entries)
- Periodically (e.g., weekly) as part of test hygiene
- Before major releases

### Process Steps

1. **Review recent changelog entries** - Identify user-facing features from the last few days/weeks that deserve E2E coverage.

2. **Audit current test coverage** - Check what the existing test files cover and identify gaps.

3. **Identify improvements:**
   - **New coverage needed** - Features that are testable and important but untested
   - **Consolidation opportunities** - Small tests that share expensive setup (app launch) and could be merged into longer tests
   - **Redundant tests** - Tests covered elsewhere or no longer relevant
   - **Skipped tests** - Either fix them or remove if they can't be made reliable

4. **Implement changes:**
   - Add tests for important new features
   - Consolidate related tests to reduce app launches (see "Prefer Fewer, Longer Tests")
   - Remove truly redundant coverage

5. **Review changes** - Have a reviewer (human or AI) check that test intent is preserved.

6. **Verify** - Run `npm run package && npm run test:e2e` to confirm tests pass.

### Consolidation Principles

When merging tests:
- **Use `test.describe.serial()`** - Ensures all tests in a sequence run in a single worker, sharing the app session.
- **Merge describe blocks first** - The biggest win is reducing app launches. Merge related describe blocks that share setup requirements (API keys, onboarding, workspace) into one.
- **Keep separate `test()` blocks** for logically distinct workflows within a shared `describe()` - This preserves retry granularity and failure isolation.
- **Use `test.step()` within longer tests** to label logical phases - This improves debugging by showing which step failed in reports.
- **Use `resetAppState()` between tests** - Clears modals, stops agent turns, starts fresh chat, and verifies nav tabs are visible.
- Clear state between checks when merging validation cases (e.g., `textarea.clear()`)
- Document what was merged in comments (e.g., `// CONSOLIDATED: Merged X and Y to share app launch`)

### Adding Tests to Existing Sequences

When adding new E2E tests, prefer adding to an existing sequence rather than creating a new file:

1. **Identify the right sequence** - Match your test's requirements to the sequence's setup:
   - Sequence A: Tests that need seeded settings, no real API calls
   - Sequence B: Tests that need full app with API keys, can share session
   - Sequence C: Tests that require app restart to verify persistence

2. **Add to the appropriate phase** - Each sequence has logical phases (e.g., "Connectors Panel", "Settings Panel"). Add your test to a matching phase or create a new one.

3. **Use `resetAppState()` in beforeEach** - This ensures clean state between tests without app restart.

4. **Follow the numbering pattern** - Tests use sequential logging (`[1/test name]`, `[2/test name]`) for debugging.
