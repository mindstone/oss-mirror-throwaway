import { getErrorReporter } from '@core/errorReporter';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';

export function pairedContinuityBreadcrumb(): void {
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    message: 'stuck-outbox',
    data: { reason: 'stuck-outbox' },
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'outbox_stall',
    category: 'continuity.continuity-state',
    message: 'stuck-outbox',
    data: { reason: 'stuck-outbox' },
  }));
}
