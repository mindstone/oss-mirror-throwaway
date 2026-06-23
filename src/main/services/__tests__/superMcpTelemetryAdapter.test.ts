/**
 * Tests for `superMcpTelemetryAdapter` (Stage 4a of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * The adapter bridges `superMcpHttpManager.subprocessEvents` into
 * `ramTelemetryService`'s named-PID registry. These tests exercise the
 * subscription flow, double-wire guard, disposer behaviour, and the
 * wire-at-running-time registration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Stub the core-safe superMcpHttpManager singleton ─────────────────
// The adapter imports the singleton (not the class), so we mock the module
// and provide our own emitter + mutable subprocessInfo.

const hoisted = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as { EventEmitter: new () => EventEmitter };
  return {
    mockSubprocessEvents: new EventEmitter(),
    mockSubprocessInfoRef: {
      current: {
        pid: null as number | null,
        startTime: null as number | null,
        uptime: null as number | null,
        isRunning: false,
        startCount: 0,
        restartCount: 0,
        lastStartupFailureAt: null,
        lastStartupError: null,
        circuitBreakerActive: false,
        cooldownRemainingMs: null,
        lastRestartReason: null,
      },
    },
    registerNamedPid: vi.fn(),
    unregisterNamedPid: vi.fn(),
    warnLog: vi.fn(),
  };
});

 
vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    subprocessEvents: hoisted.mockSubprocessEvents,
    getSubprocessInfo: () => hoisted.mockSubprocessInfoRef.current,
  },
}));

 
vi.mock('../ramTelemetryService', () => ({
  registerNamedPid: hoisted.registerNamedPid,
  unregisterNamedPid: hoisted.unregisterNamedPid,
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: hoisted.warnLog,
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mockSubprocessEvents, mockSubprocessInfoRef, registerNamedPid, unregisterNamedPid, warnLog } = hoisted;

import {
  wireSuperMcpTelemetry,
  SUPER_MCP_LABEL,
  _resetWiredFlagForTesting,
  isSuperMcpTelemetryWired,
} from '../superMcpTelemetryAdapter';

// ── Helpers ──────────────────────────────────────────────────────────

function resetMockSubprocessInfo(): void {
  mockSubprocessInfoRef.current = {
    pid: null,
    startTime: null,
    uptime: null,
    isRunning: false,
    startCount: 0,
    restartCount: 0,
    lastStartupFailureAt: null,
    lastStartupError: null,
    circuitBreakerActive: false,
    cooldownRemainingMs: null,
    lastRestartReason: null,
  };
}

beforeEach(() => {
  registerNamedPid.mockClear();
  unregisterNamedPid.mockClear();
  warnLog.mockClear();
  mockSubprocessEvents.removeAllListeners();
  resetMockSubprocessInfo();
  _resetWiredFlagForTesting();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('wireSuperMcpTelemetry', () => {
  it('subscribes to spawned/exited and calls register/unregister with the label', () => {
    wireSuperMcpTelemetry();

    mockSubprocessEvents.emit('spawned', { pid: 4242, at: 1_700_000_000_000 });
    expect(registerNamedPid).toHaveBeenCalledWith(4242, SUPER_MCP_LABEL);

    mockSubprocessEvents.emit('exited', {
      pid: 4242,
      at: 1_700_000_001_000,
      code: 0,
      signal: null,
    });
    expect(unregisterNamedPid).toHaveBeenCalledWith(4242);
  });

  it('returns a disposer that unsubscribes listeners (post-dispose events are ignored)', () => {
    const dispose = wireSuperMcpTelemetry();

    mockSubprocessEvents.emit('spawned', { pid: 5000, at: 0 });
    expect(registerNamedPid).toHaveBeenCalledTimes(1);

    dispose();
    // M1: disposer unregisters the CURRENT active PID captured from the
    // last `spawned` event. Baseline for the post-dispose assertion below.
    expect(unregisterNamedPid).toHaveBeenCalledTimes(1);
    expect(unregisterNamedPid).toHaveBeenCalledWith(5000);
    unregisterNamedPid.mockClear();
    registerNamedPid.mockClear();

    // Events fired after dispose must not reach the adapter.
    mockSubprocessEvents.emit('spawned', { pid: 5001, at: 0 });
    mockSubprocessEvents.emit('exited', { pid: 5001, at: 0, code: 0, signal: null });
    expect(registerNamedPid).not.toHaveBeenCalled();
    expect(unregisterNamedPid).not.toHaveBeenCalled();
  });

  it('double-wire returns a no-op disposer and logs a warn', () => {
    wireSuperMcpTelemetry();
    const secondDisposer = wireSuperMcpTelemetry();

    expect(warnLog).toHaveBeenCalledWith(
      {},
      'wireSuperMcpTelemetry: already wired; returning no-op disposer',
    );

    // Second disposer must not unsubscribe the first adapter's listeners.
    secondDisposer();

    mockSubprocessEvents.emit('spawned', { pid: 111, at: 0 });
    expect(registerNamedPid).toHaveBeenCalledWith(111, SUPER_MCP_LABEL);
  });

  it('registers the current PID immediately if the manager is already running at wire time', () => {
    mockSubprocessInfoRef.current = {
      ...mockSubprocessInfoRef.current,
      isRunning: true,
      pid: 9876,
    };

    wireSuperMcpTelemetry();

    expect(registerNamedPid).toHaveBeenCalledWith(9876, SUPER_MCP_LABEL);
  });

  it('disposer unregisters the current PID when the manager was already running at wire time', () => {
    mockSubprocessInfoRef.current = {
      ...mockSubprocessInfoRef.current,
      isRunning: true,
      pid: 222,
    };

    const dispose = wireSuperMcpTelemetry();
    expect(registerNamedPid).toHaveBeenCalledWith(222, SUPER_MCP_LABEL);

    dispose();
    expect(unregisterNamedPid).toHaveBeenCalledWith(222);
  });

  // ── M1 refinement: disposer unregisters the CURRENT PID, not the wire-time PID ──

  it('disposer unregisters the current PID after a post-wiring spawn (wire-idle → spawned → dispose)', () => {
    // Manager is idle at wire time — nothing to register yet.
    mockSubprocessInfoRef.current = {
      ...mockSubprocessInfoRef.current,
      isRunning: false,
      pid: null,
    };

    const dispose = wireSuperMcpTelemetry();
    expect(registerNamedPid).not.toHaveBeenCalled();

    // Later: super-mcp spawns → adapter registers the live PID.
    mockSubprocessEvents.emit('spawned', { pid: 777, at: 0 });
    expect(registerNamedPid).toHaveBeenCalledWith(777, SUPER_MCP_LABEL);

    // Dispose BEFORE exit fires — disposer must unregister the current PID.
    dispose();
    expect(unregisterNamedPid).toHaveBeenCalledWith(777);
    expect(unregisterNamedPid).toHaveBeenCalledTimes(1);
  });

  it('disposer unregisters the latest PID after a restart (wire → spawn A → exit A → spawn B → dispose)', () => {
    const dispose = wireSuperMcpTelemetry();

    mockSubprocessEvents.emit('spawned', { pid: 100, at: 0 });
    mockSubprocessEvents.emit('exited', { pid: 100, at: 1, code: 0, signal: null });
    mockSubprocessEvents.emit('spawned', { pid: 101, at: 2 });

    // The PID live at dispose time is 101 — the disposer must target it,
    // NOT the wire-time PID (null in this scenario) and NOT a stale prior
    // PID (100, which already exited).
    unregisterNamedPid.mockClear();
    dispose();
    expect(unregisterNamedPid).toHaveBeenCalledWith(101);
    expect(unregisterNamedPid).toHaveBeenCalledTimes(1);
  });

  it('disposer is a no-op when the child has already exited before dispose', () => {
    const dispose = wireSuperMcpTelemetry();

    mockSubprocessEvents.emit('spawned', { pid: 555, at: 0 });
    mockSubprocessEvents.emit('exited', { pid: 555, at: 1, code: 0, signal: null });

    // After exit: currentPid is cleared internally. Disposer must not
    // re-unregister the already-unregistered PID.
    unregisterNamedPid.mockClear();
    dispose();
    expect(unregisterNamedPid).not.toHaveBeenCalled();
  });

  // ── S1 refinement: isSuperMcpTelemetryWired introspection ──

  it('isSuperMcpTelemetryWired() reflects wire / dispose transitions', () => {
    expect(isSuperMcpTelemetryWired()).toBe(false);

    const dispose = wireSuperMcpTelemetry();
    expect(isSuperMcpTelemetryWired()).toBe(true);

    dispose();
    expect(isSuperMcpTelemetryWired()).toBe(false);
  });

  it('does not register a wire-time PID when manager is not running', () => {
    mockSubprocessInfoRef.current = {
      ...mockSubprocessInfoRef.current,
      isRunning: false,
      pid: null,
    };

    wireSuperMcpTelemetry();
    expect(registerNamedPid).not.toHaveBeenCalled();
  });

  it('disposer is idempotent (safe to call twice)', () => {
    mockSubprocessInfoRef.current = {
      ...mockSubprocessInfoRef.current,
      isRunning: true,
      pid: 333,
    };

    const dispose = wireSuperMcpTelemetry();
    dispose();
    dispose();

    // Wire-time unregister fires exactly once.
    expect(unregisterNamedPid).toHaveBeenCalledTimes(1);
  });

  it('wires cleanly again after a disposer is called (state reset)', () => {
    const dispose1 = wireSuperMcpTelemetry();
    dispose1();

    // Fresh wire should NOT log the "already wired" warn.
    warnLog.mockClear();
    const dispose2 = wireSuperMcpTelemetry();
    expect(warnLog).not.toHaveBeenCalled();

    mockSubprocessEvents.emit('spawned', { pid: 444, at: 0 });
    expect(registerNamedPid).toHaveBeenCalledWith(444, SUPER_MCP_LABEL);

    dispose2();
  });
});
