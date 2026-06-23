/**
 * Main-process diagnostics cluster.
 *
 * Extracted verbatim from `src/main/index.ts` (CHIEF_ENGINEER2 run
 * `260607_decompose-main-index`, Stage 1) to shrink the main entry module and
 * make this logic independently reviewable/testable. **Behaviour-preserving** —
 * the three pieces of module-private state below live here as singletons exactly
 * as they did at module scope in index.ts.
 *
 * Invariant preserved deliberately: the expiry timer self-reschedules
 * (`scheduleDiagnosticsExpiry`) and is **not** cleared on app quit — the previous
 * code relied on process-exit reaping. Do not "tidily" add a will-quit disposer
 * or drop the self-reschedule; that would be a behaviour change.
 */
import { app } from 'electron';
import { DEFAULT_DIAGNOSTICS_SETTINGS } from '@shared/types';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';
import { getDiagnosticsSnapshot, settingsStore } from '../settingsStore';

let diagnosticsExpiryTimer: NodeJS.Timeout | null = null;
let diagnosticsBroadcastPending = false;
let hasSurfacedFdExhaustionWarning = false;

/**
 * True if a diagnostics broadcast was requested before the app was ready and is
 * still pending. index.ts checks this once the app is ready to flush the
 * deferred broadcast (preserving the original module-level `let` read).
 */
export const isDiagnosticsBroadcastPending = (): boolean => diagnosticsBroadcastPending;

export const maybeSurfaceFdExhaustionWarning = (): void => {
  if (hasSurfacedFdExhaustionWarning) {
    return;
  }
  hasSurfacedFdExhaustionWarning = true;
  broadcastToAllWindows('system:resource-warning', {
    type: 'enfile',
    message: 'System resource constraints detected. Some features may be temporarily limited.'
  });
};

export const broadcastDiagnosticsUpdate = (): void => {
  if (!app.isReady()) {
    diagnosticsBroadcastPending = true;
    return;
  }
  diagnosticsBroadcastPending = false;
  const diagnostics = getDiagnosticsSnapshot();
  broadcastToAllWindows('diagnostics:update', diagnostics);
};

export const clearDiagnosticsExpiryTimer = (): void => {
  if (diagnosticsExpiryTimer) {
    clearTimeout(diagnosticsExpiryTimer);
    diagnosticsExpiryTimer = null;
  }
};

export const disableExpiredDebugBreadcrumbs = (): boolean => {
  const diagnostics = getDiagnosticsSnapshot();
  if (!diagnostics.debugBreadcrumbsUntil) {
    return false;
  }
  if (diagnostics.debugBreadcrumbsUntil > Date.now()) {
    return false;
  }
  settingsStore.store = {
    ...settingsStore.store,
    diagnostics: {
      ...diagnostics,
      debugBreadcrumbsUntil: null
    }
  };
  broadcastDiagnosticsUpdate();
  return true;
};

export const scheduleDiagnosticsExpiry = (): void => {
  disableExpiredDebugBreadcrumbs();
  clearDiagnosticsExpiryTimer();
  const diagnostics = settingsStore.store.diagnostics ?? { ...DEFAULT_DIAGNOSTICS_SETTINGS };
  const expiry = diagnostics.debugBreadcrumbsUntil;
  if (!expiry) {
    return;
  }
  const delay = Math.max(0, expiry - Date.now());
  diagnosticsExpiryTimer = setTimeout(() => {
    diagnosticsExpiryTimer = null;
    const changed = disableExpiredDebugBreadcrumbs();
    if (!changed) {
      scheduleDiagnosticsExpiry();
    }
  }, delay);
};
