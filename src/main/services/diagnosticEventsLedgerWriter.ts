/**
 * Diagnostic Events Ledger — main-process fs wrapper.
 *
 * Thin desktop adapter around the core
 * `createFsDiagnosticEventsLedger` factory. The factory owns queue, timer,
 * rotation, and read budget; this module just constructs one instance with
 * desktop-specific resolution and re-exports the writer/reader shapes that
 * existing call-sites consume.
 *
 * Constraints (delegated to the factory):
 *   - Emit-side calls (`append`) MUST be non-blocking and MUST NOT throw.
 *   - 50 ms / 32-entry batching keeps fs throughput bounded under bursts.
 *   - Rotation at MAX_DIAGNOSTIC_EVENTS keeps a single `.old` companion.
 *   - Reads cap total bytes via MAX_DIAGNOSTIC_EVENTS_BYTES.
 */

import { createScopedLogger } from '@core/logger';
import { createFsDiagnosticEventsLedger } from '@core/services/diagnostics/createFsDiagnosticEventsLedger';
import { getDataPath } from '@core/utils/dataPaths';

const log = createScopedLogger({ service: 'diagnosticEventsLedgerWriter' });

let pathOverride: string | null = null;

export const setDiagnosticEventsLedgerPathOverride = (override: string | null): void => {
  pathOverride = override;
};

const desktopLedger = createFsDiagnosticEventsLedger({
  resolveDir: () => pathOverride ?? getDataPath(),
  logger: log,
});

export const desktopDiagnosticEventsLedgerWriter = desktopLedger.writer;
export const desktopDiagnosticEventsLedgerReader = desktopLedger.reader;

export async function flushDiagnosticEventsLedger(): Promise<void> {
  await desktopLedger.flush();
}

export const resetDiagnosticEventsLedgerWriterForTests = (): void => {
  desktopLedger.resetForTests();
};
