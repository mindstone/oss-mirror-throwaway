import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setHandlerRegistry,
  getHandlerRegistry,
} from '@core/handlerRegistry';
import {
  setDiagnosticEventsLedgerReader,
  setDiagnosticEventsSurface,
  resetDiagnosticEventsLedgerForTests,
} from '@core/services/diagnosticEventsLedger';
import { MapHandlerRegistry } from '../mapHandlerRegistry';
import { registerDiagnosticsHandlers } from '../../../src/main/ipc/diagnosticsHandlers';

describe('cloud diagnostics:get-recent-context handler integration', () => {
  beforeEach(() => {
    resetDiagnosticEventsLedgerForTests();
    setHandlerRegistry(new MapHandlerRegistry());
    setDiagnosticEventsSurface('cloud');
  });

  it('registers a handler for diagnostics:get-recent-context', () => {
    registerDiagnosticsHandlers();
    expect(getHandlerRegistry().get('diagnostics:get-recent-context')).toBeTruthy();
  });

  it('reads from the cloud-side ledger via the wired reader (empty)', async () => {
    const readRecent = vi.fn(async () => []);
    setDiagnosticEventsLedgerReader({ readRecent });

    registerDiagnosticsHandlers();
    const handler = getHandlerRegistry().get('diagnostics:get-recent-context');
    expect(handler).toBeTruthy();

    const result = await handler!(null, {
      limit: 5,
      windowHours: 168,
    }) as { readerAvailable: boolean; totalEvents: number };

    expect(result.readerAvailable).toBe(true);
    expect(result.totalEvents).toBe(0);
    expect(readRecent).toHaveBeenCalled();
  });

  it('returns readerAvailable=false when no reader is wired', async () => {
    registerDiagnosticsHandlers();
    const handler = getHandlerRegistry().get('diagnostics:get-recent-context');

    const result = await handler!(null, {}) as { readerAvailable: boolean; totalEvents: number };
    expect(result.readerAvailable).toBe(false);
    expect(result.totalEvents).toBe(0);
  });
});
