import { expect } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';

export type Captured = Array<{ error: unknown; context?: Record<string, unknown> }>;

export function installCaptureRecorder(): Captured {
  const captured: Captured = [];
  setErrorReporter({
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
  return captured;
}

export type RecordedBreadcrumbs = Array<{
  category: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}>;

/**
 * Like {@link installCaptureRecorder} but also records breadcrumbs — needed
 * for ledger-only known conditions (Stage 4 of 260610 improve-sentry-noise),
 * where the wrapper's skip breadcrumb is the per-call observable instead of
 * a captureException call.
 */
export function installCaptureAndBreadcrumbRecorder(): {
  captured: Captured;
  breadcrumbs: RecordedBreadcrumbs;
} {
  const captured: Captured = [];
  const breadcrumbs: RecordedBreadcrumbs = [];
  setErrorReporter({
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
    },
  });
  return { captured, breadcrumbs };
}

export function resetErrorReporter(): void {
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
}

export function expectCodexBlockedLedgerOnly(
  captured: Captured,
  breadcrumbs: RecordedBreadcrumbs,
): void {
  // 260427 postmortem third pillar (level: 'info' for this user-actionable
  // expected condition) is superseded by the Stage-4 sink policy (260610
  // improve-sentry-noise): codex_disconnected_bts is `sink: 'ledger-only'`,
  // so NO Sentry event is minted at all — fragmentation and level are moot.
  // The wrapper's skip breadcrumb (riding on the next real Sentry event) is
  // the per-call observable; note the capture-context `tags` (caller/
  // category) are not threaded into the breadcrumb, only `extra` is.
  expect(captured).toHaveLength(0);
  expect(breadcrumbs).toHaveLength(1);
  expect(breadcrumbs[0]).toMatchObject({
    category: 'known_condition',
    message: 'codex_disconnected_bts',
    level: 'info',
    data: expect.objectContaining({
      condition: 'codex_disconnected_bts',
      sink: 'ledger-only',
      codexConnected: false,
    }),
  });
}
