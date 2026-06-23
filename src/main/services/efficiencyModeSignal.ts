/**
 * Efficiency Mode mid-flight cancellation signal.
 *
 * A single process-wide AbortController whose signal is handed to any LLM
 * call site that should be cancelled the moment the user transitions
 * Efficiency Mode from off → on. After firing we replace the controller so
 * subsequent call sites get a fresh signal.
 *
 * Wired in:
 *   - `src/main/ipc/settingsHandlers.ts` (settings:update, transition trigger)
 *   - `src/main/ipc/miscHandlers.ts` (quips:generate, consumer)
 *
 * See `docs/plans/260524_performance_mode.md`.
 */

let controller = new AbortController();

export function getEfficiencyModeAbortSignal(): AbortSignal {
  return controller.signal;
}

export function abortEfficiencyModeInFlight(): void {
  controller.abort();
  controller = new AbortController();
}
