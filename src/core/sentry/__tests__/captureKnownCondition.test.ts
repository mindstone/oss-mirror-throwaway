import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReporterCaptureContext, ErrorReporter } from '@core/errorReporter';
import type { ConditionContextFor } from '@core/sentry/captureKnownCondition';
import type { KnownCondition } from '@core/sentry/knownConditions';
import type { DiagnosticEventsLedgerWriter } from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import { setErrorReporter } from '@core/errorReporter';
import { captureKnownCondition as captureKnownConditionStatic } from '@core/sentry/captureKnownCondition';
import {
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
  resetDiagnosticEventsLedgerForTests,
} from '@core/services/diagnosticEventsLedger';

const warnMock = vi.hoisted(() => vi.fn());

 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    warn: warnMock,
  })),
  getTurnContext: vi.fn(() => undefined),
}));

const KILL_SWITCH_WARNING =
  'KNOWN_CONDITION_WRAPPER_DISABLED is set — captureKnownCondition is operating as no-op pass-through. Known fingerprint stability is lost — fragmentation regression risk.';

type CaptureException = (error: unknown, context?: ErrorReporterCaptureContext) => void;

async function loadSubject() {
  vi.resetModules();
  vi.doUnmock('@core/sentry/knownConditions');
  warnMock.mockClear();
  delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

  const errorReporterModule = await import('@core/errorReporter');
  const captureException = vi.fn<CaptureException>();
  const captureMessage = vi.fn<(message: string, context?: ErrorReporterCaptureContext) => void>();
  const addBreadcrumb = vi.fn<
    (breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }) => void
  >();

  errorReporterModule.setErrorReporter({
    captureException,
    captureMessage,
    addBreadcrumb,
  });

  const captureModule = await import('@core/sentry/captureKnownCondition');
  const knownConditionsModule = await import('@core/sentry/knownConditions');

  return {
    ...captureModule,
    ...knownConditionsModule,
    captureException,
    addBreadcrumb,
  };
}

function latestContext(captureException: ReturnType<typeof vi.fn<CaptureException>>): Record<string, unknown> {
  const context = captureException.mock.calls.at(-1)?.[1];
  expect(context).toBeDefined();
  return context as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;
  vi.doUnmock('@core/sentry/knownConditions');
  vi.restoreAllMocks();
});

describe('captureKnownCondition', () => {
  it('Stage 4 sink policy: ledger-only info conditions write the ledger + a breadcrumb and NEVER reach Sentry', () => {
    delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

    resetDiagnosticEventsLedgerForTests();
    setDiagnosticEventsSurface('desktop');

    const captureException = vi.fn<(error: unknown, context?: ErrorReporterCaptureContext) => void>();
    const addBreadcrumb = vi.fn();
    const reporter: ErrorReporter = {
      captureException,
      captureMessage: () => {},
      addBreadcrumb,
    };
    setErrorReporter(reporter);

    const ledgerEntries: DiagnosticEventEntry[] = [];
    const writer: DiagnosticEventsLedgerWriter = {
      append: (entry) => {
        ledgerEntries.push(entry);
      },
    };
    setDiagnosticEventsLedgerWriter(writer);

    const conditions = [
      'conversation_title_unavailable',
      'time_saved_unavailable',
      'bts_structured_output_fallback',
    ] as const;

    try {
      for (const condition of conditions) {
        captureKnownConditionStatic(
          condition,
          { extra: { probe: condition } },
          new Error(`${condition} happened`),
        );
      }

      // The whole point of the sink policy: no issue-stream delivery.
      expect(captureException).not.toHaveBeenCalled();

      // Ledger mirror still happens for every wrapped call.
      const knownConditionEntries = ledgerEntries.filter((entry) => entry.kind === 'known_condition');
      expect(knownConditionEntries).toHaveLength(conditions.length);

      // Breadcrumb on skip carries the condition + extras (the ledger drops
      // extras) onto the next real Sentry event.
      expect(addBreadcrumb).toHaveBeenCalledTimes(conditions.length);

      for (const [index, condition] of conditions.entries()) {
        const ledgerEntry = knownConditionEntries[index] as {
          kind: 'known_condition';
          data: { condition: string; level: string };
        };
        expect(ledgerEntry.data).toMatchObject({ condition, level: 'info' });

        expect(addBreadcrumb.mock.calls[index]?.[0]).toEqual({
          category: 'known_condition',
          message: condition,
          level: 'info',
          data: { probe: condition, condition, sink: 'ledger-only' },
        });
      }
    } finally {
      setDiagnosticEventsLedgerWriter(null);
      resetDiagnosticEventsLedgerForTests();
    }
  });

  it('still dual-writes warning-level conditions to both Sentry and the diagnostic-events ledger', () => {
    delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

    resetDiagnosticEventsLedgerForTests();
    setDiagnosticEventsSurface('desktop');

    const captureException = vi.fn<(error: unknown, context?: ErrorReporterCaptureContext) => void>();
    const reporter: ErrorReporter = {
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    };
    setErrorReporter(reporter);

    const ledgerEntries: DiagnosticEventEntry[] = [];
    setDiagnosticEventsLedgerWriter({
      append: (entry) => {
        ledgerEntries.push(entry);
      },
    });

    try {
      captureKnownConditionStatic('cloud_outbox_stuck', {}, new Error('outbox stuck'));

      expect(captureException).toHaveBeenCalledTimes(1);
      expect((captureException.mock.calls[0]?.[1] as Record<string, unknown>)).toMatchObject({
        fingerprint: ['cloud-outbox-stuck'],
        level: 'warning',
        _knownConditionWrapped: true,
      });

      const knownConditionEntries = ledgerEntries.filter((entry) => entry.kind === 'known_condition');
      expect(knownConditionEntries).toHaveLength(1);
      expect((knownConditionEntries[0] as { data: unknown }).data).toMatchObject({
        condition: 'cloud_outbox_stuck',
        level: 'warning',
      });
    } finally {
      setDiagnosticEventsLedgerWriter(null);
      resetDiagnosticEventsLedgerForTests();
    }
  });

  it('captures a static fingerprint condition with level and internal sentinel', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    const error = new Error('bts summary failed');

    captureKnownCondition('bts_summary_failure', {}, error);

    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(latestContext(captureException)).toMatchObject({
      fingerprint: ['bts-summary-failure'],
      level: 'warning',
      tags: { condition: 'bts_summary_failure' },
      _knownConditionWrapped: true,
    });
  });

  it('skips the Sentry capture for ledger-only info conditions and records a skip breadcrumb', async () => {
    const { captureKnownCondition, captureException, addBreadcrumb } = await loadSubject();

    captureKnownCondition(
      'codex_disconnected_bts',
      { extra: { sessionId: 'session-1' } },
      new Error('codex disconnected'),
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'known_condition',
      message: 'codex_disconnected_bts',
      level: 'info',
      data: { sessionId: 'session-1', condition: 'codex_disconnected_bts', sink: 'ledger-only' },
    });
    expect(warnMock).toHaveBeenCalledWith(
      { condition: 'codex_disconnected_bts', sink: 'ledger-only' },
      'sentry capture skipped — ledger-only sink',
    );
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'codex_disconnected_bts' }),
      'sentry capture',
    );
  });

  it('keeps the skip (no capture, no throw) when the skip breadcrumb sink fails', async () => {
    const { captureKnownCondition, captureException, addBreadcrumb } = await loadSubject();
    addBreadcrumb.mockImplementation(() => {
      throw new Error('breadcrumb sink down');
    });

    expect(() => captureKnownCondition('bts_quip_failure', {}, new Error('quip'))).not.toThrow();

    expect(captureException).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'bts_quip_failure', err: expect.any(Error) }),
      'captureKnownCondition ledger-only skip breadcrumb emit failed',
    );
  });

  it('captures issue-stream info conditions to Sentry (explicit sink adjudication)', async () => {
    vi.resetModules();
    warnMock.mockClear();
    delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

    vi.doMock('@core/sentry/knownConditions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@core/sentry/knownConditions')>();
      return {
        ...actual,
        KNOWN_CONDITIONS: {
          ...actual.KNOWN_CONDITIONS,
          bts_quip_failure: { ...actual.KNOWN_CONDITIONS.bts_quip_failure, sink: 'issue-stream' },
        },
      };
    });

    const errorReporterModule = await import('@core/errorReporter');
    const captureException = vi.fn<CaptureException>();
    errorReporterModule.setErrorReporter({
      captureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    });
    const { captureKnownCondition } = await import('@core/sentry/captureKnownCondition');
    const error = new Error('quip failed');

    captureKnownCondition('bts_quip_failure', {}, error);

    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(latestContext(captureException)).toMatchObject({
      fingerprint: ['bts-quip-failure'],
      level: 'info',
      _knownConditionWrapped: true,
    });
  });

  it('fails open to a wrapped capture when the sink-policy check throws', async () => {
    vi.resetModules();
    warnMock.mockClear();
    delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

    vi.doMock('@core/sentry/knownConditions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@core/sentry/knownConditions')>();
      const meta = { ...actual.KNOWN_CONDITIONS.bts_quip_failure };
      Object.defineProperty(meta, 'sink', {
        get() {
          throw new Error('sink exploded');
        },
      });
      return {
        ...actual,
        KNOWN_CONDITIONS: {
          ...actual.KNOWN_CONDITIONS,
          bts_quip_failure: meta,
        },
      };
    });

    const errorReporterModule = await import('@core/errorReporter');
    const captureException = vi.fn<CaptureException>();
    errorReporterModule.setErrorReporter({
      captureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    });
    const { captureKnownCondition } = await import('@core/sentry/captureKnownCondition');
    const error = new Error('quip failed');

    expect(() => captureKnownCondition('bts_quip_failure', {}, error)).not.toThrow();

    // Fail-open: the wrapped capture (fingerprint + registry level) goes out.
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(latestContext(captureException)).toMatchObject({
      fingerprint: ['bts-quip-failure'],
      level: 'info',
      _knownConditionWrapped: true,
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'captureKnownCondition sink-policy check threw — failing open to capture',
    );
  });

  it('evaluates the model_error dynamic fingerprint callback', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();

    captureKnownCondition(
      'model_error',
      {
        kind: 'rate_limit',
        provider: 'anthropic',
        upstreamProvider: 'aws-bedrock',
      },
      new Error('model failed'),
    );

    expect(latestContext(captureException).fingerprint).toEqual([
      'model-error',
      'rate_limit',
      'anthropic',
      'aws-bedrock',
    ]);
    expect(latestContext(captureException).tags).toMatchObject({ condition: 'model_error' });
  });

  it('uses model_error dynamic fingerprint defaults for missing optional fields', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();

    captureKnownCondition(
      'model_error',
      {
        kind: 'auth',
        provider: undefined,
        upstreamProvider: undefined,
      } as ConditionContextFor<'model_error'>,
      new Error('model auth failed'),
    );

    expect(latestContext(captureException).fingerprint).toEqual([
      'model-error',
      'auth',
      'unknown',
      'none',
    ]);
  });

  it('passes valid schema-checked context through to the Sentry context', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();

    captureKnownCondition(
      'model_error',
      {
        kind: 'invalid_request',
        provider: 'openrouter',
        tags: { source: 'turnErrorRecovery' },
        extra: { turnId: 'turn-1' },
      },
      new Error('invalid request'),
    );

    expect(latestContext(captureException)).toMatchObject({
      fingerprint: ['model-error', 'invalid_request', 'openrouter', 'none'],
      tags: { source: 'turnErrorRecovery', condition: 'model_error' },
      extra: { turnId: 'turn-1' },
      _knownConditionWrapped: true,
    });
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'captureKnownCondition schema validation failed',
    );
  });

  it('falls back to vanilla captureException when schema validation fails', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    const error = new Error('bad model context');
    const invalidContext: ErrorReporterCaptureContext = { kind: 123 };
    const captureKnownConditionForInvalidContext = captureKnownCondition as (
      condition: KnownCondition,
      context: ErrorReporterCaptureContext,
      error?: Error,
    ) => void;

    expect(() => captureKnownConditionForInvalidContext('model_error', invalidContext, error)).not.toThrow();

    expect(captureException).toHaveBeenCalledWith(error, invalidContext);
    expect(latestContext(captureException).fingerprint).toBeUndefined();
    expect(latestContext(captureException)._knownConditionWrapped).toBeUndefined();
    expect((latestContext(captureException).tags as Record<string, unknown> | undefined)?.condition).toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'model_error',
        issues: expect.arrayContaining([expect.objectContaining({ path: ['kind'] })]),
      }),
      'captureKnownCondition schema validation failed',
    );
  });

  it('falls back to vanilla captureException when schema validation throws', async () => {
    const { captureKnownCondition, captureException, KNOWN_CONDITIONS } = await loadSubject();
    const schema = KNOWN_CONDITIONS.model_error.contextSchema;
    expect(schema).toBeDefined();
    vi.spyOn(schema, 'safeParse').mockImplementation(() => {
      throw new Error('schema exploded');
    });
    const error = new Error('schema throw');

    expect(() => captureKnownCondition('model_error', { kind: 'auth' }, error)).not.toThrow();

    expect(captureException).toHaveBeenCalledWith(error, { kind: 'auth' });
    expect(latestContext(captureException).fingerprint).toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'model_error', err: expect.any(Error) }),
      'captureKnownCondition schema validation threw',
    );
  });

  it('falls back to vanilla captureException on registry miss', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    const error = new Error('unknown condition');
    const context = { extra: { detail: 'kept' } };

    expect(() => captureKnownCondition('nonexistent' as KnownCondition, context, error)).not.toThrow();

    expect(captureException).toHaveBeenCalledWith(error, context);
    expect(latestContext(captureException).fingerprint).toBeUndefined();
    expect((latestContext(captureException).tags as Record<string, unknown> | undefined)?.condition).toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      { condition: 'nonexistent' },
      'unknown condition: nonexistent',
    );
  });

  it('uses a condition-level fallback fingerprint when the dynamic callback throws', async () => {
    const { captureKnownCondition, captureException, KNOWN_CONDITIONS } = await loadSubject();
    Object.defineProperty(KNOWN_CONDITIONS.model_error, 'fingerprint', {
      configurable: true,
      value: () => {
        throw new Error('fingerprint exploded');
      },
    });

    expect(() => captureKnownCondition('model_error', { kind: 'rate_limit' }, new Error('model'))).not.toThrow();

    expect(latestContext(captureException)).toMatchObject({
      fingerprint: ['model_error'],
      level: 'warning',
      _knownConditionWrapped: true,
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'model_error', err: expect.any(Error) }),
      'captureKnownCondition dynamic fingerprint callback threw',
    );
  });

  it('swallows reporter throws and logs the adapter error', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    const adapterError = new Error('adapter exploded');
    captureException.mockImplementation(() => {
      throw adapterError;
    });

    expect(() => captureKnownCondition('bts_summary_failure', {}, new Error('summary'))).not.toThrow();

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'bts_summary_failure', err: adapterError }),
      'captureKnownCondition reporter threw',
    );
  });

  it('W2D-6: safeCaptureException re-throws KnownConditionGuardError in test mode (fallback path)', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    process.env.KNOWN_CONDITION_WRAPPER_DISABLED = '1';
    const guardError = Object.assign(new Error('Layer-2 guard tripped'), {
      name: 'KnownConditionGuardError',
    });
    captureException.mockImplementation(() => {
      throw guardError;
    });

    expect(() =>
      captureKnownCondition('codex_disconnected_bts', {}, new Error('codex')),
    ).toThrow(/Layer-2 guard tripped/);
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'codex_disconnected_bts', err: guardError }),
      'captureKnownCondition reporter threw during fallback capture',
    );
  });

  // Note: codex_disconnected_bts is a ledger-only condition — this test also
  // proves the kill-switch pass-through bypasses the Stage-4 sink skip
  // (operational escape hatch: setting the env var restores Sentry delivery).
  it('honors the kill-switch as a vanilla pass-through and warns once per process', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    process.env.KNOWN_CONDITION_WRAPPER_DISABLED = '1';
    const firstContext = { extra: { attempt: 1 } };
    const secondContext = { extra: { attempt: 2 } };

    captureKnownCondition('codex_disconnected_bts', firstContext, new Error('first'));
    captureKnownCondition('codex_disconnected_bts', secondContext, new Error('second'));

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException.mock.calls[0]?.[1]).toBe(firstContext);
    expect(captureException.mock.calls[1]?.[1]).toBe(secondContext);
    expect(
      warnMock.mock.calls.filter((call) => call[1] === KILL_SWITCH_WARNING),
    ).toHaveLength(1);
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'codex_disconnected_bts' }),
      'sentry capture',
    );
  });

  it('emits a structured Pino log on the success path', async () => {
    const { captureKnownCondition } = await loadSubject();

    captureKnownCondition('bts_summary_failure', {}, new Error('summary'));

    expect(warnMock).toHaveBeenCalledWith(
      {
        condition: 'bts_summary_failure',
        fingerprint: ['bts-summary-failure'],
      },
      'sentry capture',
    );
  });

  it('sets the internal wrapper sentinel on captured context', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();

    captureKnownCondition('cloud_outbox_stuck', { tags: { source: 'outbox' } }, new Error('stuck'));

    expect(latestContext(captureException)._knownConditionWrapped).toBe(true);
    expect(latestContext(captureException).tags).toMatchObject({
      source: 'outbox',
      condition: 'cloud_outbox_stuck',
    });
  });

  it('never throws when registry lookup itself crashes', async () => {
    vi.resetModules();
    warnMock.mockClear();
    delete process.env.KNOWN_CONDITION_WRAPPER_DISABLED;

     
    vi.doMock('@core/sentry/knownConditions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@core/sentry/knownConditions')>();
      return {
        ...actual,
        KNOWN_CONDITIONS: new Proxy(
          {},
          {
            get() {
              throw new Error('registry exploded');
            },
          },
        ),
      };
    });

    const errorReporterModule = await import('@core/errorReporter');
    const captureException = vi.fn<CaptureException>();
    errorReporterModule.setErrorReporter({
      captureException,
      captureMessage: vi.fn<(message: string, context?: ErrorReporterCaptureContext) => void>(),
      addBreadcrumb: vi.fn<
        (breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }) => void
      >(),
    });
    const { captureKnownCondition } = await import('@core/sentry/captureKnownCondition');
    const error = new Error('registry lookup crash');

    expect(() => captureKnownCondition('codex_disconnected_bts', {}, error)).not.toThrow();

    expect(captureException).toHaveBeenCalledWith(error, undefined);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'codex_disconnected_bts',
        err: expect.any(Error),
      }),
      'captureKnownCondition unexpected failure; falling back to vanilla captureException',
    );
  });

  it('allows re-entry using wrapper-constructed context without unbounded recursion', async () => {
    const { captureKnownCondition, captureException } = await loadSubject();
    let reentered = false;
    captureException.mockImplementation((error, context) => {
      if (reentered) {
        return;
      }
      reentered = true;
      captureKnownCondition(
        'bts_summary_failure',
        (context ?? {}) as ConditionContextFor<'bts_summary_failure'>,
        error instanceof Error ? error : undefined,
      );
    });

    expect(() => captureKnownCondition('bts_summary_failure', {}, new Error('summary'))).not.toThrow();

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(
      warnMock.mock.calls.filter((call) => call[1] === 'sentry capture'),
    ).toHaveLength(2);
  });
});
