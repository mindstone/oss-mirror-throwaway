import { createScopedLogger } from '@core/logger';
import { createFsDiagnosticEventsLedger } from '@core/services/diagnostics/createFsDiagnosticEventsLedger';
import { getDataPath } from '@core/utils/dataPaths';

const log = createScopedLogger({ service: 'cloudDiagnosticEventsLedger' });

const cloudLedger = createFsDiagnosticEventsLedger({
  resolveDir: () => getDataPath(),
  logger: log,
});

export const cloudDiagnosticEventsLedgerWriter = cloudLedger.writer;
export const cloudDiagnosticEventsLedgerReader = cloudLedger.reader;

export async function shutdownCloudDiagnosticEventsLedger(): Promise<void> {
  await cloudLedger.shutdown();
}
