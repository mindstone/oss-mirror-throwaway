import { afterEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter, type ErrorReporter, type ErrorReporterEventScope } from '@core/errorReporter';
import {
  captureMigrationFailure,
  recordMigrationBreadcrumb,
  redactForMigrationTelemetry,
} from '../migrationObservability';

const noopReporter: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
  captureExceptionWithScope: () => {},
};

afterEach(() => {
  setErrorReporter(noopReporter);
});

describe('migration observability privacy', () => {
  it('redacts home dirs, paths, email addresses, and filenames before telemetry', () => {
    const redacted = redactForMigrationTelemetry(
      'Failed near /Users/you/Library/Application Support/Rebel/app-settings.json for greg@example.com',
    );

    expect(redacted).not.toContain('/Users/greg');
    expect(redacted).not.toContain('Application Support');
    expect(redacted).not.toContain('app-settings.json');
    expect(redacted).not.toContain('greg@example.com');
    expect(redacted).toContain('<path>');
    expect(redacted).toContain('***@***.***');
  });

  it('keeps breadcrumb and capture payloads free of representative PII/path substrings', () => {
    const breadcrumbs: unknown[] = [];
    const capturedContexts: unknown[] = [];
    const captureExceptionWithScope = vi.fn((_error: unknown, mutator: (scope: ErrorReporterEventScope) => void) => {
      const scope = {
        tags: {} as Record<string, string>,
        contexts: {} as Record<string, Record<string, unknown>>,
        setTag(key: string, value: string) {
          this.tags[key] = value;
        },
        setContext(name: string, context: Record<string, unknown>) {
          this.contexts[name] = context;
        },
      };
      mutator(scope);
      capturedContexts.push(scope);
    });

    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: (breadcrumb) => breadcrumbs.push(breadcrumb),
      captureExceptionWithScope,
    });

    const unsafe = {
      importId: 'a89ebd43-7c41-4a30-b81b-b8cc886b9824',
      path: '/Users/you/Library/Application Support/Rebel/app-settings.json',
      email: 'greg@example.com',
      nested: { fileName: 'customer-notes.md' },
    };

    recordMigrationBreadcrumb('failed', unsafe);
    captureMigrationFailure(new Error('raw error not forwarded'), {
      operation: 'import-validate',
      phase: 'failed',
      code: 'entry-checksum-mismatch',
      extra: unsafe,
    });

    const serialized = JSON.stringify({ breadcrumbs, capturedContexts });
    expect(serialized).not.toContain('/Users/greg');
    expect(serialized).not.toContain('Application Support');
    expect(serialized).not.toContain('app-settings.json');
    expect(serialized).not.toContain('customer-notes.md');
    expect(serialized).not.toContain('greg@example.com');
    expect(serialized).toContain('<path>');
    expect(serialized).toContain('***@***.***');
  });
});

describe('migration observability capture policy', () => {
  it('does not capture expected not-fresh or incompatible outcomes', () => {
    const captureExceptionWithScope = vi.fn();
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
      captureExceptionWithScope,
    });

    captureMigrationFailure(new Error('expected refusal'), {
      operation: 'import-validate',
      phase: 'failed',
      code: 'target-not-fresh',
    });
    captureMigrationFailure(new Error('expected refusal'), {
      operation: 'import-validate',
      phase: 'failed',
      code: 'bundle-incompatible',
    });

    expect(captureExceptionWithScope).not.toHaveBeenCalled();
  });

  it('captures corrupt and publish-failed outcomes', () => {
    const captureExceptionWithScope = vi.fn();
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
      captureExceptionWithScope,
    });

    captureMigrationFailure(new Error('corrupt'), {
      operation: 'import-validate',
      phase: 'failed',
      code: 'entry-checksum-mismatch',
    });
    captureMigrationFailure(new Error('publish'), {
      operation: 'import-adopt',
      phase: 'failed',
      code: 'publish-failed',
    });

    expect(captureExceptionWithScope).toHaveBeenCalledTimes(2);
  });
});
