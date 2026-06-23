/**
 * App-Relocation Service (macOS-only).
 *
 * Root-cause prevention for the "update won't install" bricked-beta problem.
 * When Rebel launches from OUTSIDE /Applications — a Gatekeeper-translocated
 * path, the DMG, or the Downloads folder — Squirrel.Mac can't reliably authorize
 * an in-place update later (Apple Authorization Services failure, surfaced as
 * REBEL-68D "command is disabled"). The fix is to move the app into
 * /Applications on first run (Electron's built-in `moveToApplicationsFolder`),
 * which also CONSOLIDATES a pre-existing duplicate copy there.
 *
 * Behaviour: offer once (never nag), one-click move + automatic relaunch, clear
 * opt-out. Never throws — any failure falls through to normal startup (the
 * duplicate-warning dialog and the fail-loud update-failure path are the safety
 * nets). Must run BEFORE the main window, because a successful move relaunches.
 */

import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getDataPath } from '@core/utils/dataPaths';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isAutomatedOrHeadlessContext } from '../utils/testIsolation';
import { isRunningFromLocalForgeBuild } from './appInstallProvenance';
import { showStartupMessageBox } from '../startup/startupDialog';

const log = createScopedLogger({ service: 'appRelocation' });
const OPTED_OUT_FILENAME = 'app-relocation-opted-out.json';

export interface ShouldOfferRelocationInput {
  platform: NodeJS.Platform;
  /** Only prompt the real packaged app — never the dev Electron bundle. */
  isPackaged: boolean;
  isInApplicationsFolder: boolean;
  /** The user explicitly chose "Don't ask again". */
  optedOut: boolean;
  /**
   * The running app is a local developer build launched straight from the forge
   * `out/` tree (`npm run package:run`). Such a build is ALWAYS outside
   * /Applications, so without this it would be offered relocation on every launch
   * — and accepting would relocate the dev build out of `out/`. Suppress it.
   */
  isLocalForgeBuild: boolean;
}

/**
 * Pure decision: offer to move only for the packaged macOS app, when running
 * outside /Applications, only if the user hasn't explicitly opted out, and never
 * for a local developer (`package:run`) build.
 */
export function shouldOfferRelocation(input: ShouldOfferRelocationInput): boolean {
  return (
    input.platform === 'darwin' &&
    input.isPackaged &&
    !input.isInApplicationsFolder &&
    !input.optedOut &&
    !input.isLocalForgeBuild
  );
}

/**
 * Pure decision for `moveToApplicationsFolder`'s conflict handler.
 * - `'exists'`: a non-running copy already sits in /Applications → overwrite it
 *   (consolidate the duplicate; same app, so not data loss).
 * - `'existsAndRunning'`: that copy is currently running → we must NOT overwrite
 *   it; halt the move and fall back to the warning path.
 */
export function resolveMoveConflict(conflictType: 'exists' | 'existsAndRunning'): boolean {
  return conflictType === 'exists';
}

async function readOptedOut(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(getDataPath(), OPTED_OUT_FILENAME), 'utf-8');
    return (JSON.parse(raw) as { optedOut?: boolean }).optedOut === true;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'appRelocation.readOptedOut',
      reason: 'No prior relocation opt-out marker; treat as not-opted-out',
    });
    return false;
  }
}

async function markOptedOut(): Promise<void> {
  try {
    const filePath = path.join(getDataPath(), OPTED_OUT_FILENAME);
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ optedOut: true, at: Date.now() }, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    log.warn({ err }, 'Failed to persist relocation opt-out marker');
  }
}

/**
 * Offer to move Rebel into /Applications when it's running from elsewhere.
 * Packaged macOS app only; never throws. On acceptance the app moves +
 * relaunches (this process exits). A plain "Not Now" re-offers next launch (the
 * update path stays broken until fixed); the "Don't ask again" checkbox
 * suppresses future offers.
 */
export async function maybeOfferMoveToApplications(): Promise<void> {
  // Never prompt in automated/test contexts. The offer shows a parent-less
  // native dialog, which on macOS becomes an APP-MODAL `[NSAlert runModal]` —
  // a nested run-loop on the shared Electron/Chromium main thread. Awaited at
  // the top of whenReady, it blocks the window from ever opening AND starves
  // the browser CDP pump, so Playwright's `electron.launch` never attaches.
  // That deterministically wedged the chronic-E2E publish gate. No user to click
  // the dialog in automation, so skipping it is always correct here. This proven
  // pre-whenReady early-return is KEPT (beta-critical); the broader SSOT predicate
  // also covers headless-CLI, and the dialog itself additionally routes through
  // showStartupMessageBox below (defense-in-depth + the lint-enforced convention).
  if (isAutomatedOrHeadlessContext()) return;
  // Never prompt the unpackaged dev bundle (it isn't in /Applications either).
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    // Defensive: app.isInApplicationsFolder is macOS-only and needs the app ready.
    if (app.isInApplicationsFolder()) return;

    const optedOut = await readOptedOut();
    // Never offer to relocate a developer's `npm run package:run` build (it runs
    // from the forge `out/` tree, always outside /Applications). Accepting would
    // move the build out of `out/` and break the dev iteration loop.
    const isLocalForgeBuild = await isRunningFromLocalForgeBuild();
    if (
      !shouldOfferRelocation({
        platform: process.platform,
        isPackaged: app.isPackaged,
        isInApplicationsFolder: false,
        optedOut,
        isLocalForgeBuild,
      })
    ) {
      return;
    }

    await app.whenReady();

    const choice = await showStartupMessageBox({
      type: 'question',
      title: 'Move Rebel to your Applications folder?',
      message: 'Rebel is running from outside your Applications folder.',
      detail:
        "Apps outside Applications can't update themselves reliably, so you'd eventually get stuck on " +
        "an old version. Moving Rebel there fixes it, and it'll reopen automatically.",
      buttons: ['Move and Relaunch', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't ask again",
      checkboxChecked: false,
    });

    if (choice.response !== 0) {
      // Only suppress future offers if the user explicitly opted out.
      if (choice.checkboxChecked) await markOptedOut();
      log.info({ optedOut: choice.checkboxChecked }, 'User declined move-to-Applications offer');
      return;
    }

    try {
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (conflictType) => resolveMoveConflict(conflictType),
      });
      // On success Electron relaunches from /Applications and this process exits,
      // so reaching here with `moved === false` means the move did not happen.
      if (!moved) {
        log.warn('moveToApplicationsFolder returned false (move did not occur)');
        getErrorReporter().addBreadcrumb({
          category: 'app-relocation',
          message: 'move-to-applications declined-by-conflict-or-failed',
          level: 'warning',
        });
      }
    } catch (err) {
      // e.g. the existing /Applications copy is running (existsAndRunning → halt),
      // or a permission error. Non-fatal: continue startup.
      log.warn({ err }, 'moveToApplicationsFolder threw; continuing startup');
    }
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'appRelocation.maybeOffer',
      reason: 'Relocation offer is best-effort; never block startup on it',
      severity: 'warn',
    });
  }
}
