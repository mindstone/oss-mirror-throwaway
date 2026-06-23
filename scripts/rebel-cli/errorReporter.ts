import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';

const noopReporter: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
  captureExceptionWithScope: () => {},
};

let flushImpl: ((timeout?: number) => Promise<boolean>) | null = null;

type SentryNodeLike = {
  init(options: Record<string, unknown>): void;
  flush(timeout?: number): Promise<boolean>;
  captureException(error: unknown, context?: unknown): string;
  captureMessage(message: string, context?: unknown): string;
  addBreadcrumb(breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }): void;
  withScope(callback: (scope: unknown) => void): void;
};

const importOptionalSentryNode = async (): Promise<SentryNodeLike> => {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<SentryNodeLike>;
  return dynamicImport('@sentry/node');
};

export async function initializeStandaloneErrorReporter(): Promise<void> {
  const dsn = process.env.SENTRY_DSN || process.env.REBEL_SENTRY_DSN;
  if (!dsn) {
    setErrorReporter(noopReporter);
    return;
  }

  try {
    const Sentry = await importOptionalSentryNode();
    Sentry.init({
      dsn,
      environment: 'cli-standalone',
      release: `mindstone-rebel-cli@${process.env.REBEL_VERSION || __REBEL_VERSION__}`,
      tracesSampleRate: 0,
    });
    flushImpl = Sentry.flush;
    setErrorReporter({
      captureException: (error, context) => Sentry.captureException(error, context),
      captureMessage: (message, context) => Sentry.captureMessage(message, context),
      addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
      captureExceptionWithScope: (error, mutate) => {
        Sentry.withScope((scope) => {
          mutate(scope as Parameters<typeof mutate>[0]);
          Sentry.captureException(error);
        });
      },
    });
  } catch {
    setErrorReporter(noopReporter);
  }
}

export async function flushStandaloneErrorReporter(timeoutMs = 2_000): Promise<void> {
  if (flushImpl) {
    await flushImpl(timeoutMs).catch(() => false);
  }
}
