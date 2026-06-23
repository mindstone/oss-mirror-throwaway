/**
 * Startup-dialog gate — the ONLY sanctioned way to show a native message box
 * during app startup (the `whenReady` phase, before/around first-window
 * creation).
 *
 * THE HAZARD this kills (the `startup_modal_blocks_automated_boot` class — two
 * prior incidents, see docs-private/postmortems/260102_* and 260619_chronic_*):
 * a PARENT-LESS `dialog.showMessageBox(options)` on macOS becomes an app-modal
 * `[NSAlert runModal]` — a nested run-loop on the shared Electron/Chromium main
 * thread. With no user to dismiss it (automation/headless) it blocks window
 * creation AND starves the browser-CDP pump, so Playwright's `electron.launch`
 * never attaches → the chronic-E2E publish gate hangs (~6h blocked beta). It
 * blocks even when the call is fire-and-forget (`void …then`) because runModal
 * blocks the main thread regardless of JS `await` semantics.
 *
 * In an automated/headless context this returns a no-op default (the dialog's
 * `cancelId`) WITHOUT showing the modal; otherwise it delegates to
 * `dialog.showMessageBox`. `showStartupErrorBox` (below) is the matching wrapper
 * for the startup-FAILURE path's `dialog.showErrorBox`. The companion lint rule
 * `eslint-rules/no-raw-startup-dialog.js` forbids raw `dialog.showMessageBox` /
 * `dialog.showErrorBox` in the startup surface, so a new startup dialog can't
 * silently reopen the class (that "forgot the guard" failure produced both prior incidents).
 *
 * Class boundary (what MUST route through here vs what must NOT):
 *  - IN: parent-less, startup-phase, main-thread-blocking `showMessageBox`.
 *  - OUT: window-PARENTED message boxes (passing a BrowserWindow → a window
 *    sheet, not an app-modal `[NSAlert runModal]`) and post-startup dialogs —
 *    those are not the hazard and need not route through here.
 */

import { dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isAutomatedOrHeadlessContext } from '../utils/testIsolation';

const log = createScopedLogger({ service: 'startupDialog' });

export async function showStartupMessageBox(
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  if (isAutomatedOrHeadlessContext()) {
    // No human to click it → never run a native modal (would wedge the boot).
    // Default to the dialog's own cancel/decline response.
    const response = options.cancelId ?? 0;
    log.info(
      { title: options.title, response },
      'Suppressed startup dialog in automated/headless context (no-op default)',
    );
    return { response, checkboxChecked: false };
  }
  return dialog.showMessageBox(options);
}

/**
 * Startup-FAILURE error box — the sanctioned way to show a native `dialog.showErrorBox`
 * during app startup. Same hazard as `showStartupMessageBox`: a parent-less
 * `dialog.showErrorBox` is an app-modal `[NSAlert runModal]` that wedges the automated/headless
 * boot (the `startup_modal_blocks_automated_boot` class). Unlike `showMessageBox`, `showErrorBox`
 * is reliable even BEFORE `app` is ready, which is why the startup-failure path uses it.
 *
 * No-ops in an automated/headless context (keyed on the same `isAutomatedOrHeadlessContext()`
 * SSOT as `showStartupMessageBox` — so a `--rebel-test` run is suppressed too, which the old
 * bootstrap-local `shouldShowStartupDialogs()` predicate missed). Best-effort: a failing error
 * dialog must never mask the original startup failure.
 */
export function showStartupErrorBox(title: string, content: string): void {
  if (isAutomatedOrHeadlessContext()) {
    log.info({ title }, 'Suppressed startup error box in automated/headless context (no-op)');
    return;
  }
  try {
    dialog.showErrorBox(title, content);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'startupDialog.showStartupErrorBox',
      reason: 'a failing startup-failure error dialog must not mask the original startup failure',
    });
  }
}
