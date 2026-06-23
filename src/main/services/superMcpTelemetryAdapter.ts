/**
 * Thin Electron-only adapter that bridges the core-safe
 * `SuperMcpHttpManager.subprocessEvents` into the main-side
 * `ramTelemetryService` named-PID registry.
 *
 * Kept deliberately small so the core/main boundary stays intact — `src/core/`
 * never imports from `src/main/`. Stage 4a of
 * `docs/plans/260423_secondary_process_cpu_observability.md`.
 */

import { superMcpHttpManager } from '@core/services/superMcpHttpManager';
import { createScopedLogger } from '@core/logger';
import { registerNamedPid, unregisterNamedPid } from './ramTelemetryService';

const log = createScopedLogger({ service: 'superMcpTelemetryAdapter' });

/** Label used for the super-mcp subprocess in the diagnostic's `processes[]`. */
export const SUPER_MCP_LABEL = 'super-mcp';

/**
 * Module-local guard so double-wiring is a no-op. Each call returns a disposer
 * that unwires THIS adapter's listeners — re-calling `wireSuperMcpTelemetry`
 * after a dispose re-arms the adapter normally.
 */
let wired = false;

/**
 * Module-local tracker for the currently-registered super-mcp PID. Updated
 * synchronously in both the `spawned` and `exited` event handlers (and
 * initialised at wire time if the manager is already running), so the
 * disposer can always unregister the *current* active PID rather than the
 * PID captured at wire time. This closes the M1 hazard where super-mcp
 * restarts or starts-after-wiring leaked stale registry entries on dispose.
 */
let currentPid: number | null = null;

/**
 * Subscribe to `superMcpHttpManager.subprocessEvents` and keep the named-PID
 * registry in sync. If the manager already has a running subprocess at wire
 * time, its PID is registered immediately so the very next diagnostic tick
 * includes a `super-mcp:PID` row.
 *
 * Returns a disposer that unsubscribes THIS adapter's listeners and
 * unregisters the wire-time PID (if any). The disposer is safe to call
 * multiple times.
 */
export function wireSuperMcpTelemetry(): () => void {
  if (wired) {
    log.warn({}, 'wireSuperMcpTelemetry: already wired; returning no-op disposer');
    return () => {};
  }
  wired = true;

  const onSpawned = ({ pid }: { pid: number; at: number }) => {
    currentPid = pid;
    registerNamedPid(pid, SUPER_MCP_LABEL);
  };
  const onExited = ({ pid }: {
    pid: number;
    at: number;
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => {
    if (pid === currentPid) {
      currentPid = null;
    }
    unregisterNamedPid(pid);
  };

  superMcpHttpManager.subprocessEvents.on('spawned', onSpawned);
  superMcpHttpManager.subprocessEvents.on('exited', onExited);

  // If the manager is already running when we wire, register its PID now so
  // the first diagnostic tick reflects it. This covers start-order races
  // (unlikely but possible if super-mcp started during app bootstrap before
  // this adapter was wired).
  const current = superMcpHttpManager.getSubprocessInfo();
  if (current.isRunning && current.pid !== null) {
    currentPid = current.pid;
    registerNamedPid(current.pid, SUPER_MCP_LABEL);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    superMcpHttpManager.subprocessEvents.off('spawned', onSpawned);
    superMcpHttpManager.subprocessEvents.off('exited', onExited);
    // Unregister the CURRENT active PID (not wire-time), mirroring the
    // live register/unregister event semantics. Best-effort — if exited
    // already fired, currentPid is null and this is a no-op.
    if (currentPid !== null) {
      unregisterNamedPid(currentPid);
      currentPid = null;
    }
    wired = false;
  };
}

/**
 * Read-only introspector that reports whether this adapter is currently
 * wired. Useful for diagnostics / smoke tests without exposing the internal
 * state. See Stage 4a refinement S1 — no production re-wire path is offered
 * yet; dispose + re-wire is the only supported flow (and re-wiring while
 * already wired returns a no-op disposer with a warn).
 */
export function isSuperMcpTelemetryWired(): boolean {
  return wired;
}

/** @internal Test-only: reset the module-local wired flag between tests. */
export function _resetWiredFlagForTesting(): void {
  wired = false;
  currentPid = null;
}
