/**
 * Enhancement Service Health Checks
 *
 * Checks for background contextual retrieval enhancement status.
 *
 * Status semantics — this check mirrors the worker's startup gate logic in
 * `enhancementService.startEnhancement()` and the auto-start gates in
 * `fileWatcherService.ts` (post-scan finalization and restart paths). The
 * `warn` status is reserved for cases where the worker logic implies it
 * SHOULD be running but isn't. Deliberate not-running states (disabled in
 * settings, paused by user, awaiting opt-in for large workspaces) are
 * reported as `pass` with informative messages so System Health doesn't show
 * DEGRADED for expected behavior.
 *
 * Worker gate order is mirrored here:
 *   1. settings.backgroundEnhancement === false       → disabled
 *   2. settings.enhancementUserRequested === false    → paused by user
 *   3. large workspace + not opted in                 → awaiting opt-in
 *   4. otherwise (worker should be running)           → warn if not running
 */

import type { CheckResult } from '../types';
import { isEnhancementRunning, isEnhancementPaused } from '../../enhancementService';
import { getEnhancementState } from '../../fileIndexService';
import { getWatcherStatus, AUTO_ENHANCE_FILE_THRESHOLD } from '../../fileWatcherService';
import { getSettings } from '@core/services/settingsStore';

// System Health is an English-only diagnostic surface. Force a stable locale
// so digit grouping is consistent across host machines (e.g. fr-FR's narrow
// no-break space, de-DE's '.', or Indian-locale 7,05,210 wouldn't help users
// reading the report).
const REPORT_LOCALE = 'en-US';

/**
 * Check enhancement service health.
 * Reports whether background enhancement is running, paused, or stopped.
 */
export function checkEnhancementHealth(): CheckResult {
  const isRunning = isEnhancementRunning();
  const isPaused = isEnhancementPaused();
  const state = getEnhancementState();

  if (isPaused) {
    return {
      id: 'enhancementHealth',
      name: 'Background Enhancement',
      status: 'warn',
      message: 'Enhancement service is paused',
      details: {
        isRunning,
        isPaused,
        totalChunks: state.totalChunks,
        enhancedChunks: state.enhancedChunks,
      },
      remediation: 'Enhancement pauses during low-power mode. Resume by using the app normally.',
    };
  }

  if (!isRunning && state.totalChunks > 0 && state.enhancedChunks < state.totalChunks) {
    const remaining = state.totalChunks - state.enhancedChunks;
    const remainingFormatted = remaining.toLocaleString(REPORT_LOCALE);
    const settings = getSettings();
    const baseDetails = {
      isRunning,
      isPaused,
      totalChunks: state.totalChunks,
      enhancedChunks: state.enhancedChunks,
      remaining,
    };

    // Branch 1: explicitly disabled in settings — most explicit kill switch, wins over opt-in.
    if (settings.backgroundEnhancement === false) {
      return {
        id: 'enhancementHealth',
        name: 'Background Enhancement',
        status: 'pass',
        message: 'Background enhancement disabled in settings',
        details: { ...baseDetails, reason: 'disabled-in-settings' },
      };
    }

    // Branch 2: user explicitly paused via Library "Pause".
    if (settings.enhancementUserRequested === false) {
      return {
        id: 'enhancementHealth',
        name: 'Background Enhancement',
        status: 'pass',
        message: `Background enhancement paused (${remainingFormatted} chunks pending)`,
        details: { ...baseDetails, reason: 'paused-by-user' },
      };
    }

    // Branch 3: large-workspace auto-skip awaiting opt-in.
    // Mirrors fileWatcherService gate: `totalFilesDiscovered > AUTO_ENHANCE_FILE_THRESHOLD
    // && enhancementUserRequested !== true`. For small workspaces (<= threshold) the
    // worker auto-starts regardless of the opt-in setting, so a not-running state there
    // is a real problem and should fall through to the warn branch below.
    const watcher = getWatcherStatus();
    const isLargeWorkspace = watcher.totalFiles > AUTO_ENHANCE_FILE_THRESHOLD;
    if (isLargeWorkspace && settings.enhancementUserRequested !== true) {
      return {
        id: 'enhancementHealth',
        name: 'Background Enhancement',
        status: 'pass',
        message: `Background enhancement available (${remainingFormatted} chunks)`,
        details: {
          ...baseDetails,
          reason: 'awaiting-opt-in',
          totalFiles: watcher.totalFiles,
          autoEnhanceFileThreshold: AUTO_ENHANCE_FILE_THRESHOLD,
        },
      };
    }

    // Branch 4: worker logic implies it SHOULD be running but isn't.
    // This is the only genuinely degraded not-running state. Reasons range from
    // missing/expired auth (covered by separate authHealth check) to a worker
    // crash to startup throwing. Remediation copy points to logs as a generic
    // catch-all; for a more specific message we'd need to consult auth state
    // or have the worker stamp `intendedToRun` on enhancementState — left as a
    // follow-up improvement.
    return {
      id: 'enhancementHealth',
      name: 'Background Enhancement',
      status: 'warn',
      message: `Enhancement stopped with ${remainingFormatted} chunks remaining`,
      details: { ...baseDetails, reason: 'unexpected-stop' },
      remediation: 'Enhancement may have stopped due to errors. Check logs for details.',
    };
  }

  if (isRunning) {
    const progress = state.totalChunks > 0
      ? Math.round((state.enhancedChunks / state.totalChunks) * 100)
      : 0;
    return {
      id: 'enhancementHealth',
      name: 'Background Enhancement',
      status: 'pass',
      message: `Enhancement running (${progress}% complete)`,
      details: {
        isRunning,
        isPaused,
        totalChunks: state.totalChunks,
        enhancedChunks: state.enhancedChunks,
        progress,
      },
    };
  }

  // Not running, not paused, nothing to enhance or all done
  return {
    id: 'enhancementHealth',
    name: 'Background Enhancement',
    status: 'pass',
    message: state.totalChunks === 0
      ? 'No chunks to enhance'
      : 'Enhancement complete',
    details: {
      isRunning,
      isPaused,
      totalChunks: state.totalChunks,
      enhancedChunks: state.enhancedChunks,
    },
  };
}
