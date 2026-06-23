import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReporterCaptureContext, InternalCaptureContext } from '@core/errorReporter';

const warnMock = vi.hoisted(() => vi.fn());

const _validPublicContext: ErrorReporterCaptureContext = {
  fingerprint: ['type-only-check'],
  level: 'warning',
};
void _validPublicContext;
// @ts-expect-error _knownConditionWrapped is reserved for internal wrapper plumbing.
const _invalidPublicContext: ErrorReporterCaptureContext = { _knownConditionWrapped: true };
void _invalidPublicContext;

describe('errorReporter', () => {
  const adapterCaptureException = vi.fn<
    (error: unknown, context?: ErrorReporterCaptureContext) => void
  >();
  const adapterCaptureMessage = vi.fn<
    (message: string, context?: ErrorReporterCaptureContext) => void
  >();
  const adapterAddBreadcrumb = vi.fn<
    (breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }) => void
  >();

  let getErrorReporter: typeof import('@core/errorReporter').getErrorReporter;
  let setErrorReporter: typeof import('@core/errorReporter').setErrorReporter;
  let KnownStructuredErrorBase: typeof import('@core/sentry/knownStructuredError').KnownStructuredError;
  let KnownConditionGuardErrorClass: typeof import('@core/errorReporter').KnownConditionGuardError;
  let resetGuardLatchesForTesting: typeof import('@core/errorReporter').__resetGuardLatchesForTesting;

  beforeEach(async () => {
    // Wave 2c Stage 2: pin the guard to warn-mode by default for the existing
    // 8 it-blocks that legitimately drive the warn path. The new throw-mode
    // suite below overrides this per-case via vi.stubEnv. vi.stubEnv (rather
    // than direct process.env mutation) avoids same-worker leakage across
    // vitest cases.
    vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'warn');
    vi.resetModules();
    vi.clearAllMocks();
    // errorReporter now routes Layer-2 guard warns through console.warn so
    // src/core/ stays platform-agnostic for the React Native bundle. Spy on
    // console.warn and adapt the captured arguments back to the (payload, msg)
    // shape the tests assert against.
    vi.spyOn(console, 'warn').mockImplementation((message: unknown, payload?: unknown) => {
      const stripped = typeof message === 'string' ? message.replace(/^\[errorReporter\] /, '') : message;
      warnMock(payload, stripped);
    });

    const errorReporterModule = await import('@core/errorReporter');
    const knownStructuredErrorModule = await import('@core/sentry/knownStructuredError');
    getErrorReporter = errorReporterModule.getErrorReporter;
    setErrorReporter = errorReporterModule.setErrorReporter;
    KnownConditionGuardErrorClass = errorReporterModule.KnownConditionGuardError;
    resetGuardLatchesForTesting = errorReporterModule.__resetGuardLatchesForTesting;
    KnownStructuredErrorBase = knownStructuredErrorModule.KnownStructuredError;

    resetGuardLatchesForTesting();

    setErrorReporter({
      captureException: adapterCaptureException,
      captureMessage: adapterCaptureMessage,
      addBreadcrumb: adapterAddBreadcrumb,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function createKnownStructuredError(): Error {
    class TestKnownStructuredError extends KnownStructuredErrorBase {
      constructor() {
        super('known');
        this.name = 'TestKnownStructuredError';
      }
    }

    return new TestKnownStructuredError();
  }

  it('passes captureException context through without wrapping under extra', () => {
    const error = new Error('boom');
    const context: ErrorReporterCaptureContext = {
      fingerprint: ['x'],
      level: 'warning',
    };

    getErrorReporter().captureException(error, context);

    expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
  });

  it('warns when KnownStructuredError is captured without wrapper sentinel', () => {
    const error = createKnownStructuredError();
    const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

    getErrorReporter().captureException(error, context);

    expect(warnMock).toHaveBeenCalledWith(
      { errorClass: 'TestKnownStructuredError', hasContext: true },
      'unwrapped known structured error capture — use captureKnownCondition',
    );
    expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
  });

  it('does not warn when KnownStructuredError carries wrapper sentinel', () => {
    const error = createKnownStructuredError();
    const internalContext = {
      fingerprint: ['known-error'],
      _knownConditionWrapped: true,
    } as unknown as ErrorReporterCaptureContext;

    getErrorReporter().captureException(error, internalContext);

    expect(warnMock).not.toHaveBeenCalled();
    expect(adapterCaptureException).toHaveBeenCalledWith(error, internalContext);
  });

  it('does not warn for plain Error captures', () => {
    const error = new Error('plain');

    getErrorReporter().captureException(error, { fingerprint: ['plain'] });

    expect(warnMock).not.toHaveBeenCalled();
    expect(adapterCaptureException).toHaveBeenCalledWith(error, { fingerprint: ['plain'] });
  });

  it('Phase 7 fix: capture still proceeds when Layer-2 guard log.warn throws', () => {
    // The runtime guard must never block the underlying capture, even if the
    // logging transport itself throws (circular-reference serialization,
    // transport down, etc.).
    const error = createKnownStructuredError();
    warnMock.mockImplementationOnce(() => {
      throw new Error('pino transport down');
    });

    expect(() =>
      getErrorReporter().captureException(error, { fingerprint: ['known'] }),
    ).not.toThrow();

    expect(adapterCaptureException).toHaveBeenCalledWith(error, { fingerprint: ['known'] });
  });

  it('Wave 2: warns on variable-driven tags.condition matching a KnownCondition', () => {
    const conditionTag: string = ['runtime_activity_mapper_failure'].join('');
    const error = new Error('mapper boom');
    const context: ErrorReporterCaptureContext = {
      tags: { condition: conditionTag, area: 'runtime-activity', provider: 'openai-chat' },
    };

    getErrorReporter().captureException(error, context);

    expect(warnMock).toHaveBeenCalledWith(
      { conditionTag: 'runtime_activity_mapper_failure', errorClass: 'Error' },
      'unwrapped known-condition capture (variable-driven) — use captureKnownCondition',
    );
    expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
  });

  it('Wave 2: does not warn when tags.condition is not in KNOWN_CONDITIONS', () => {
    const error = new Error('plain');
    const context: ErrorReporterCaptureContext = {
      tags: { condition: 'unknown_string_not_in_KnownCondition', area: 'mcp' },
    };

    getErrorReporter().captureException(error, context);

    expect(warnMock).not.toHaveBeenCalled();
    expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
  });

  it('Wave 2: does not warn when sentinel is set even with KnownCondition tags.condition', () => {
    const error = new Error('wrapper-routed');
    const internalContext = {
      tags: { condition: 'runtime_activity_mapper_failure', area: 'runtime-activity' },
      _knownConditionWrapped: true,
    } as InternalCaptureContext as ErrorReporterCaptureContext;

    getErrorReporter().captureException(error, internalContext);

    expect(warnMock).not.toHaveBeenCalled();
    expect(adapterCaptureException).toHaveBeenCalledWith(error, internalContext);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'Wave 2: does not warn when tags.condition is the prototype-key %j (Object.hasOwn check)',
    (prototypeKey) => {
      const error = new Error('plain');
      const context: ErrorReporterCaptureContext = {
        tags: { condition: prototypeKey },
      };

      getErrorReporter().captureException(error, context);

      expect(warnMock).not.toHaveBeenCalled();
      expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
    },
  );

  describe('Wave 2c: test-mode hard-fail', () => {
    it('throws when NODE_ENV=test and KnownStructuredError captured without wrapper', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'test');

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      expect(() => getErrorReporter().captureException(error, context)).toThrow(
        KnownConditionGuardErrorClass,
      );

      expect(adapterCaptureException).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('throws on variable-driven tags.condition match in throw mode', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'test');

      const conditionTag: string = ['runtime_activity_mapper_failure'].join('');
      const error = new Error('mapper boom');
      const context: ErrorReporterCaptureContext = {
        tags: { condition: conditionTag, area: 'runtime-activity' },
      };

      expect(() => getErrorReporter().captureException(error, context)).toThrow(
        KnownConditionGuardErrorClass,
      );

      expect(adapterCaptureException).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('KNOWN_CONDITION_GUARD_LEVEL=off completely silences the guard with latched-warn observability', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'off');

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      expect(() => getErrorReporter().captureException(error, context)).not.toThrow();
      expect(adapterCaptureException).toHaveBeenCalledWith(error, context);

      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(
        { envKnob: 'KNOWN_CONDITION_GUARD_LEVEL=off' },
        'KNOWN_CONDITION_GUARD_LEVEL=off — Layer-2 known-condition guard fully disabled',
      );

      adapterCaptureException.mockClear();
      warnMock.mockClear();

      const error2 = createKnownStructuredError();
      expect(() => getErrorReporter().captureException(error2, context)).not.toThrow();
      expect(adapterCaptureException).toHaveBeenCalledWith(error2, context);
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('KNOWN_CONDITION_GUARD_LEVEL=warn overrides NODE_ENV=test default', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'warn');
      vi.stubEnv('NODE_ENV', 'test');

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      expect(() => getErrorReporter().captureException(error, context)).not.toThrow();

      expect(warnMock).toHaveBeenCalledWith(
        { errorClass: 'TestKnownStructuredError', hasContext: true },
        'unwrapped known structured error capture — use captureKnownCondition',
      );
      expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
    });

    it('KNOWN_CONDITION_GUARD_LEVEL=throw outside NODE_ENV=test downgrades to warn (synthesis fix #3 — production safety)', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'production');

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      expect(() => getErrorReporter().captureException(error, context)).not.toThrow();

      expect(warnMock).toHaveBeenCalledWith(
        { errorClass: 'TestKnownStructuredError', hasContext: true },
        'unwrapped known structured error capture — use captureKnownCondition',
      );
      expect(warnMock).toHaveBeenCalledWith(
        { envKnob: 'KNOWN_CONDITION_GUARD_LEVEL=throw', nodeEnv: 'production' },
        'KNOWN_CONDITION_GUARD_LEVEL=throw ignored: throw mode requires NODE_ENV=test; falling back to warn',
      );
      expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
    });

    it('thrown KnownConditionGuardError carries the diagnostic payload and is instanceof', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'test');

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      let thrown: unknown;
      try {
        getErrorReporter().captureException(error, context);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(KnownConditionGuardErrorClass);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe('KnownConditionGuardError');
      expect((thrown as InstanceType<typeof KnownConditionGuardErrorClass>).payload).toMatchObject({
        errorClass: 'TestKnownStructuredError',
        hasContext: true,
      });
    });
  });

  describe('Wave 2d: env-knob edge cases + with-scope guard', () => {
    const adapterCaptureExceptionWithScope = vi.fn<
      (
        error: unknown,
        scopeMutator: (scope: import('@core/errorReporter').ErrorReporterEventScope) => void,
      ) => void
    >();

    beforeEach(() => {
      adapterCaptureExceptionWithScope.mockReset();
      setErrorReporter({
        captureException: adapterCaptureException,
        captureMessage: adapterCaptureMessage,
        addBreadcrumb: adapterAddBreadcrumb,
        captureExceptionWithScope: adapterCaptureExceptionWithScope,
      });
    });

    it('W2D-11: unset env-knob + NODE_ENV=production → warn (default branch coverage)', () => {
      vi.unstubAllEnvs();
      vi.stubEnv('NODE_ENV', 'production');
      resetGuardLatchesForTesting();

      const error = createKnownStructuredError();
      const context: ErrorReporterCaptureContext = { fingerprint: ['known-error'] };

      expect(() => getErrorReporter().captureException(error, context)).not.toThrow();

      expect(warnMock).toHaveBeenCalledWith(
        { errorClass: 'TestKnownStructuredError', hasContext: true },
        'unwrapped known structured error capture — use captureKnownCondition',
      );
      expect(adapterCaptureException).toHaveBeenCalledWith(error, context);
    });

    it('W2D-11: unrecognized env-knob value latches warn on first observation, silent on second', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'thrown');
      vi.stubEnv('NODE_ENV', 'production');
      resetGuardLatchesForTesting();

      const unrecognizedMessage =
        'KNOWN_CONDITION_GUARD_LEVEL=thrown not recognized; expected throw|warn|off; falling back to default';

      const error1 = createKnownStructuredError();
      getErrorReporter().captureException(error1, { fingerprint: ['known-1'] });

      expect(warnMock).toHaveBeenCalledWith(
        { envKnob: 'KNOWN_CONDITION_GUARD_LEVEL=thrown' },
        unrecognizedMessage,
      );

      const firstCallCount = warnMock.mock.calls.filter(
        (call) => call[1] === unrecognizedMessage,
      ).length;
      expect(firstCallCount).toBe(1);

      const error2 = createKnownStructuredError();
      getErrorReporter().captureException(error2, { fingerprint: ['known-2'] });

      const secondCallCount = warnMock.mock.calls.filter(
        (call) => call[1] === unrecognizedMessage,
      ).length;
      expect(secondCallCount).toBe(1);
    });

    it('W2D-11: second observation of throw-outside-test latches the warn flag (silent)', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'production');
      resetGuardLatchesForTesting();

      const throwIgnoredMessage =
        'KNOWN_CONDITION_GUARD_LEVEL=throw ignored: throw mode requires NODE_ENV=test; falling back to warn';

      const error1 = createKnownStructuredError();
      getErrorReporter().captureException(error1, { fingerprint: ['known-1'] });

      const firstCallCount = warnMock.mock.calls.filter(
        (call) => call[1] === throwIgnoredMessage,
      ).length;
      expect(firstCallCount).toBe(1);

      const error2 = createKnownStructuredError();
      getErrorReporter().captureException(error2, { fingerprint: ['known-2'] });

      const secondCallCount = warnMock.mock.calls.filter(
        (call) => call[1] === throwIgnoredMessage,
      ).length;
      expect(secondCallCount).toBe(1);

      const unwrappedKnownMessage =
        'unwrapped known structured error capture — use captureKnownCondition';
      const unwrappedCallCount = warnMock.mock.calls.filter(
        (call) => call[1] === unwrappedKnownMessage,
      ).length;
      expect(unwrappedCallCount).toBe(2);
    });

    it('W2D-7: captureExceptionWithScope fires Layer-2 guard for KnownStructuredError (warn mode)', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'warn');

      const error = createKnownStructuredError();

      expect(() =>
        getErrorReporter().captureExceptionWithScope?.(error, () => {}),
      ).not.toThrow();

      expect(warnMock).toHaveBeenCalledWith(
        { errorClass: 'TestKnownStructuredError', hasContext: false },
        'unwrapped known structured error capture — use captureKnownCondition',
      );
      expect(adapterCaptureExceptionWithScope).toHaveBeenCalledTimes(1);
    });

    it('W2D-7: captureExceptionWithScope throws KnownConditionGuardError in test mode', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'test');

      const error = createKnownStructuredError();

      expect(() =>
        getErrorReporter().captureExceptionWithScope?.(error, () => {}),
      ).toThrow(KnownConditionGuardErrorClass);

      expect(adapterCaptureExceptionWithScope).not.toHaveBeenCalled();
    });

    it('W2D-7: captureExceptionWithScope does NOT fire guard for plain Error + non-known tags (regression coverage)', () => {
      vi.stubEnv('KNOWN_CONDITION_GUARD_LEVEL', 'throw');
      vi.stubEnv('NODE_ENV', 'test');

      const error = new Error('whatever');

      expect(() =>
        getErrorReporter().captureExceptionWithScope?.(error, (scope) => {
          scope.setTag('fs_exhaustion.source', 'graceful-fs');
        }),
      ).not.toThrow();

      const guardWarnCalls = warnMock.mock.calls.filter(
        (call) =>
          call[1] === 'unwrapped known structured error capture — use captureKnownCondition' ||
          call[1] === 'unwrapped known-condition capture (variable-driven) — use captureKnownCondition',
      );
      expect(guardWarnCalls).toHaveLength(0);
      expect(adapterCaptureExceptionWithScope).toHaveBeenCalledTimes(1);
    });
  });
});
