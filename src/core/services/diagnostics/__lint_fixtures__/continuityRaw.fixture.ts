import { getErrorReporter } from '@core/errorReporter';

export function rawContinuityBreadcrumb(): void {
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    message: 'stuck-outbox',
    data: { reason: 'stuck-outbox' },
  });
}
