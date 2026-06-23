---
description: Launch the Electron app via MCP and test UI changes by clicking around and verifying behavior
argument-hint: <optional: specific area to test, e.g. "settings panel" or "navigation tabs">
---

# UI Test

> **Router:** Start at [`docs/project/AGENT_UI_TESTING.md`](../../docs/project/AGENT_UI_TESTING.md) to choose the cheapest reliable path. Claude Code users arrive here through [`.claude/skills/run-app/SKILL.md`](../../.claude/skills/run-app/SKILL.md). This file remains the Factory launch SSOT.

Test the Electron app interactively to verify UI behavior. Three paths:

- **Manual CDP** (default for Droid agents) — uses `agent-browser` with Chrome DevTools Protocol against `electron-forge start` (HMR dev server)
- **MCP** (when `rebel-electron` MCP server is connected) — uses MCP tools directly
- **Packaged-app** (deterministic; **no persistent TTY required**) — `npm run package` + Playwright `_electron.launch`. See [Packaged-App Path](#packaged-app-path-deterministic--no-tty) below.

Droid agents: MCP is typically unavailable in Factory Droid sessions. Use Manual CDP. Both CDP paths above launch via `electron-forge start`, which keeps a Vite dev server alive for HMR — great when your harness has a persistent TTY (Droid's `Execute`). If your harness backgrounds commands **without** a persistent TTY (e.g. Claude Code background tasks, some CI), forge's interactive watch can exit and tear down the dev server + Electron; use the **Packaged-App Path** instead.

**Key feature:** The app window is **never shown on screen** in `--rebel-test` mode. CDP interactions (clicks, screenshots, eval) still work because Chromium renders to an offscreen buffer. Guest mode and onboarding bypass are automatic.

**Platform note:** The Manual CDP path assumes macOS/Linux shell semantics (`rm -rf`, `mkdir -p`, `grep`, `lsof`, `pgrep`). On Windows, use Git Bash or WSL.

## Pre-flight

Run preflight first — if it fails, don't launch the app:

```bash
npm run test:preflight
```

Source the API key if available (needed for real agent turns — file is gitignored):

```bash
source .env.local 2>/dev/null || true
```

## Manual CDP (Droid Default)

**Prerequisite:** `agent-browser` is a Factory skill. Invoke `Skill: agent-browser` before running any `agent-browser` commands.

**Note:** The checked-in script below owns launch, seeding, readiness, guest/onboarding canaries, and cleanup. Use the flags instead of copying old shell snippets.

### Launch

The `--rebel-test` flag handles test isolation automatically:
- **Hidden window** — skips `mainWindow.maximize()` and `mainWindow.show()`, hides dock icon on macOS. CDP still works (offscreen buffer rendering).
- **Guest mode** — auto-activates via preload (sets `sessionStorage.guestMode=true` on DOMContentLoaded)
- **Onboarding bypass** — seeds `onboardingCompleted: true` in settings
- **Instance lock skip** — no need to kill the installed app
- **Isolated userData** — creates temp dir under `os.tmpdir()` (NOT `/tmp`)
- **CDP bound to localhost** — safe, no network exposure

```bash
npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive
```

Useful flags: `--seed-onboarding-incomplete`, `--cdp-port <n>`, `--renderer-port <n>`, `--test-dir <path>`, `--timeout-ms <n>`. First run can take 55-90s while `predev` builds bundles; the script prints the CDP port, PID, test dir, log path, and exact cleanup command when it leaves the app running.

### Wait for CDP

No separate poll is required. `launch-rebel-test.ts` polls `http://127.0.0.1:<port>/json/list` every 2s for a non-DevTools page, fails with one bounded log tail, and cleans up failed launches.

If launch fails, stop after one retry and report both failure tails.

### Connect

```bash
agent-browser connect 9222 && agent-browser tab 1
```

Tab 0 is DevTools, tab 1 is the renderer.

### Verify Guest Mode & Readiness

`--rebel-test` auto-activates guest mode via preload. The launch script already checks guest mode, readiness, and whether the onboarding wizard is visible. To inspect manually after connecting:

```js
// agent-browser eval — run this immediately after connect
(() => {
  // Suppress PermissionOnboardingDialog (blocks clicks on fresh profiles)
  localStorage.setItem('permission-onboarding-shown', 'true');

  // Canary: verify guest mode is active
  const guestMode = sessionStorage.getItem('guestMode') === 'true';

  // Check app readiness via e2eApi (exposed in rebel-test mode)
  const readiness = window.e2eApi?.getReadiness?.() ?? null;

  return { guestMode, readiness };
})()
```

If `guestMode` is `false` or the app shows a login screen unexpectedly, treat the launch as failed and use the script's log tail rather than patching state in place.

### Test the UI

**If `$ARGUMENTS` is provided**, navigate to that area and test it.

**If no arguments**, run a smoke test:

1. **Navigate flow tabs** — tabs use `id="flow-tab-{name}"` selectors:
   ```js
   // agent-browser eval — click each tab and screenshot after
   document.querySelector('#flow-tab-home')?.click()
   document.querySelector('#flow-tab-sessions')?.click()
   document.querySelector('#flow-tab-usecases')?.click()
   document.querySelector('#flow-tab-library')?.click()
   document.querySelector('#flow-tab-automations')?.click()
   document.querySelector('#flow-tab-tasks')?.click()
   ```
   Tab IDs from `FLOW_SURFACES`: home, sessions, usecases, library, automations, tasks, settings.

2. **Test settings** — open and verify:
   ```js
   // agent-browser eval
   document.querySelector('#flow-tab-settings')?.click()
   ```
   Verify `data-testid="settings-panel"` is visible.

3. **Screenshot before/after the area under test only** (max 2 per verification step — see the hard rules in docs/project/AGENT_UI_TESTING.md).

### Screenshots

```bash
npx tsx scripts/ui-test/screenshot.ts --out /tmp/rebel-ui-home.png
```

The screenshot helper connects over CDP, picks the first non-DevTools page, writes the image, and disconnects without closing the app.

### Check for Errors

```bash
tail -20 <log-path-printed-by-launch-script>
```

### Cleanup (ALWAYS)

For failed launches the script cleans up automatically. For `--keep-alive` success, run the exact cleanup command printed by `launch-rebel-test.ts`; it targets only the process group it started.

Do not kill unrelated ports or user-owned app processes.

### Report Results

Summarize:
- **App launched:** yes/no (window should NOT appear on screen)
- **Guest mode:** auto-activated/manual-fallback/failed
- **Readiness:** e2eApi result if available
- **Navigation:** which tabs worked
- **Target area** (if `$ARGUMENTS`): tested and result
- **Errors:** any found?
- **Overall:** PASS / FAIL with details

## MCP Path (When Available)

> **These steps have not been validated in a real Droid session.** The `rebel-electron` MCP server is typically unavailable in Factory Droid. If MCP is connected, these steps should work but may need adjustment.

### Step 0: Kill Installed App

> **Note:** With `--rebel-test` mode (used in Manual CDP above), the single-instance lock is skipped automatically. This step is only needed when launching via MCP without `--rebel-test`.

```bash
ps aux | grep "Mindstone Rebel.app" | grep -v grep && osascript -e 'quit app "Mindstone Rebel"' && sleep 2
```

### Step 1: Preflight

```bash
npm run test:preflight
```

Run static validation (`npm run validate:fast`, redirected to a file) only if the router's static tier calls for it.

### Step 2: Launch

```
spawn_dev_server { "action": "start", "waitForReadyMs": 90000 }
```

If it fails with a port conflict:
```
spawn_dev_server { "action": "stop" }
spawn_dev_server { "action": "start", "waitForReadyMs": 90000 }
```

### Step 3: Verify Readiness

```
get_page_state { "processId": "dev-server" }
```

If `testIdCount > 0`, the app is ready. If not, retry at a fixed 2s interval with a hard cap of 60 polls (120s), then STOP and report — no open-ended retrying.

### Step 4: Enable Guest Mode

```
electron_evaluate {
  "processId": "dev-server",
  "expression": "(() => { localStorage.setItem('permission-onboarding-shown', 'true'); const gm = sessionStorage.getItem('guestMode') === 'true'; if (!gm) { sessionStorage.setItem('guestMode', 'true'); window.dispatchEvent(new Event('guestModeChange')); } return { guestMode: gm || 'injected', readiness: window.e2eApi?.getReadiness?.() ?? null }; })()"
}
```

### Step 5: Test the UI

**If `$ARGUMENTS` is provided**, navigate to that area.

**If no arguments**, smoke test — flow tabs use HTML `id` attributes (not `data-testid`):

```
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-home')?.click()" }
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-sessions')?.click()" }
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-usecases')?.click()" }
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-library')?.click()" }
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-automations')?.click()" }
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-tasks')?.click()" }
```

After each click, call `get_page_state` to verify navigation. Open settings:
```
electron_evaluate { "processId": "dev-server", "expression": "document.querySelector('#flow-tab-settings')?.click()" }
```
Verify `data-testid="settings-panel"` in `get_page_state` output.

### Step 6: Console Errors

```
electron_evaluate {
  "processId": "dev-server",
  "expression": "(() => { const errors = []; const origError = console.error; console.error = (...args) => { errors.push(args.map(a => String(a)).join(' ')); origError.apply(console, args); }; setTimeout(() => { console.error = origError; }, 100); return errors.length > 0 ? errors : 'No console errors detected'; })()"
}
```

### Step 7: Cleanup (ALWAYS)

```
spawn_dev_server { "action": "stop" }
```

### Step 8: Report Results

Same format as Manual CDP report above.

## Packaged-App Path (deterministic / no-TTY)

Use this when you need a **resident, deterministic** app rather than HMR — especially from a harness that backgrounds commands without a persistent TTY (Claude Code background tasks, CI), where `electron-forge start` exits and tears down the Vite dev server. It is **harness-agnostic** (any runner with `node`/`npx tsx`) and is the same Playwright Electron primitive the E2E suite uses.

Why it's reliable: a packaged build loads the renderer from disk via `loadFile` (no Vite dev server, no forge watch process). Playwright's `_electron.launch` owns the Electron process for the lifetime of your driver script — it stays up until `app.close()`.

```bash
npm run package          # rebuild — needed even for renderer-only changes (dev serves renderer from Vite)
```

```ts
// Save as drive.ts, run from repo root: `npx tsx drive.ts`
// MUST be .ts (not .mts): tsx runs .ts as CommonJS here (no "type":"module"), which the CJS
// `resolve-packaged-app` import + __dirname need; CJS has no top-level await, so use an async IIFE.
import { _electron as electron } from 'playwright';
import { resolvePackagedAppPaths } from './scripts/resolve-packaged-app'; // SSOT, channel/platform-aware
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

void (async () => {
  const p = resolvePackagedAppPaths();
  const bin = path.join(p.appPath, 'Contents', 'MacOS', p.productName);   // darwin; p.exePath / p.linuxExePath elsewhere
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-ui-'));
  const app = await electron.launch({
    executablePath: bin,
    args: [`--rebel-test-user-data-dir=${userDataDir}`],
    cwd: process.cwd(), timeout: 0,
    env: { ...process.env, REBEL_TEST_MODE: '1', REBEL_E2E_TEST_MODE: '1',
           REBEL_USER_DATA: userDataDir, REBEL_TEST_USER_DATA_DIR: userDataDir,
           REBEL_TEST_ALLOW_NON_TEMP_USERDATA: '' /*, REMOTE_DEBUGGING_PORT: '9222' to also expose CDP */ },
  });
  const win = await app.firstWindow({ timeout: 90_000 });  // rebel-test auto-bypasses onboarding + guest mode
  // drive: win.evaluate(...), navigate via #flow-tab-* clicks, win.screenshot(...)
  // seed w/o API key: await win.evaluate(() => window.sessionsApi.upsert(session)); await win.reload();
  await app.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
})();
```

Add `REMOTE_DEBUGGING_PORT: '9222'` to `env` if you'd rather drive over CDP (e.g. `agent-browser connect 9222`) while this script holds the process alive. Full rationale, the data-seeding `AgentSession` shape, and CDP details: [`docs/project/TESTING_E2E.md` § Driving the packaged app interactively](../../docs/project/TESTING_E2E.md#driving-the-packaged-app-interactively-ad-hoc-verification-no-dev-server). (`_electron.launch` env/args mirror `tests/e2e/test-utils.ts`.)

## Reminders: Manual CDP

- **`agent-browser` requires skill activation** — invoke `Skill: agent-browser` before using any commands
- **Theme switching**: use `document.body.classList.replace('light', 'dark')` via eval — do NOT use `agent-browser --color-scheme` (disconnects CDP)
- **Fast repeat runs**: use `npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive --test-dir <same-temp-dir>` with warm caches; keep launch, readiness, and cleanup inside the script.

## Reminders: MCP

- **Use `waitForReadyMs: 90000`** — first cold start takes 60-90s
- **`click_button` uses JS `.click()`** which bypasses overlays — a "successful" click doesn't mean a real user could click it
- **Step 6 console error capture is forward-only** — only catches errors after the snippet runs; for startup errors, check renderer log files

## Reminders: Both Paths

- **Re-inject guest mode after any full page reload** — sessionStorage resets on reload; `--rebel-test` auto-injects on initial load only. For Manual CDP: `agent-browser eval 'sessionStorage.setItem("guestMode", "true"); window.dispatchEvent(new Event("guestModeChange")); localStorage.setItem("permission-onboarding-shown", "true")'`
- **Login screen = guest mode failed** — retry guest mode injection, check logs for preload errors
- **Wait 2-3s after HMR** before interacting (code change -> hot reload -> brief instability)
- **Window is hidden** — the app runs but does not appear on screen. This is expected behavior in `--rebel-test` mode. Screenshots via CDP still work.
- **No focus events** — `mainWindow.on('focus')` never fires for a hidden window. Focus-triggered behaviors (GPU unthrottling, cloud sync refresh, dock badge) won't run. This is acceptable for smoke tests.

## How It Works (Architecture)

The hidden-window + guest-mode mechanism chains through several modules:

1. **`--rebel-test` flag** -> `src/main/startup/ensureRebelTestMode.ts` sets `REBEL_TEST_MODE=1`, `REBEL_E2E_TEST_MODE=1`, resolves userData dir, binds CDP to localhost, seeds minimal settings
2. **`isE2eTestMode()`** -> `src/main/utils/testIsolation.ts` returns true when both env vars are set
3. **Window hiding** -> `src/main/index.ts` checks `isE2eTestMode()` and skips `maximize()`/`show()`, hides dock
4. **Guest mode** -> `src/preload/index.ts` checks `--rebel-test-mode` argv and sets `sessionStorage.guestMode` on DOMContentLoaded
5. **Settings pre-seeding** -> Written to `$TEST_DIR/app-settings.json` before launch; `ensureRebelTestMode.ts` also seeds if missing (but our richer file takes precedence since it checks `!fs.existsSync`)
6. **Safety guard** -> `src/main/startup/ensureTestUserData.ts` enforces userData must be under `os.tmpdir()` (rejects `/tmp` on macOS where tmpdir is `/var/folders/...`)

**Maintenance note:** `dismissedAnnouncements` in the pre-seeded settings must be updated when new announcement banners are added (they use `position:fixed` and block click targets). Check `tests/e2e/test-utils.ts` `writeMinimalSettings()` for the current list.

Patterns borrowed from `tests/e2e/test-utils.ts` (`writeMinimalSettings`):
- `indexingEnabled: false` — prevents embedding model crashes in fresh profiles
- `memoryUpdateEnabled: false` — prevents background memory turns interfering with tests
- `dismissedAnnouncements` — prevents fixed-position banners blocking click targets
- `coreDirectory` pointing to test workspace — prevents "Core directory not configured" errors
- `permission-onboarding-shown` localStorage — suppresses PermissionOnboardingDialog
