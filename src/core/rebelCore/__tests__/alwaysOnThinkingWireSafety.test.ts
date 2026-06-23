/**
 * Runtime wire-shape assertion for sampling-forbidden / always-on-thinking models.
 *
 * The PROD arm (capture via errorReporter + strip + log, never throw) is
 * explicitly unit-tested with NODE_ENV forced — the dev-throw arm alone does
 * not prove the prod strip works (PLAN.md Stage 4 item 8 / Runtime Safety
 * confirmation watch-item).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlwaysOnThinkingWireSafetyError,
  assertWireSafeForAlwaysOnThinking,
} from '../alwaysOnThinkingWireSafety';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
}));

function makeReporterSpy(): { reporter: ErrorReporter; captureException: ReturnType<typeof vi.fn> } {
  const captureException = vi.fn();
  return {
    reporter: {
      captureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    },
    captureException,
  };
}

const SILENT: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

afterEach(() => {
  vi.unstubAllEnvs();
  setErrorReporter(SILENT);
  vi.clearAllMocks();
});

describe('assertWireSafeForAlwaysOnThinking — dev/test arm (throw)', () => {
  it('throws on temperature for claude-fable-5 (NODE_ENV=test)', () => {
    const body: Record<string, unknown> = { model: 'claude-fable-5', temperature: 0 };
    expect(() => assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'test.seam'))
      .toThrow(AlwaysOnThinkingWireSafetyError);
  });

  it('throws on temperature for claude-opus-4-8 (sampling forbidden, not always-on)', () => {
    const body: Record<string, unknown> = { model: 'claude-opus-4-8', temperature: 0 };
    expect(() => assertWireSafeForAlwaysOnThinking('claude-opus-4-8', body, 'test.seam'))
      .toThrow(AlwaysOnThinkingWireSafetyError);
  });

  it('throws on top_p / top_k and non-adaptive thinking', () => {
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', { top_p: 0.9 }, 'test.seam'),
    ).toThrow(/top_p/);
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', { top_k: 5 }, 'test.seam'),
    ).toThrow(/top_k/);
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'enabled', budget_tokens: 1024 } },
        'test.seam',
      ),
    ).toThrow(/thinking\(non-adaptive\)/);
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'disabled' } },
        'test.seam',
      ),
    ).toThrow(AlwaysOnThinkingWireSafetyError);
  });

  it('normalizes OpenRouter-prefixed and [1m]-suffixed forms', () => {
    expect(() =>
      assertWireSafeForAlwaysOnThinking('anthropic/claude-fable-5', { temperature: 0.2 }, 'test.seam'),
    ).toThrow(AlwaysOnThinkingWireSafetyError);
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5[1m]', { temperature: 0.2 }, 'test.seam'),
    ).toThrow(AlwaysOnThinkingWireSafetyError);
  });

  it('rejects budget_tokens even when type is adaptive (Fable 400s on it; GPT F2 tightening)', () => {
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'adaptive', budget_tokens: 1024 } },
        'test.seam',
      ),
    ).toThrow(/thinking\.budget_tokens/);
  });

  it('rejects unknown extra thinking keys and non-summarized display values on the adaptive shape', () => {
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'adaptive', interleaved: true } },
        'test.seam',
      ),
    ).toThrow(/thinking\.interleaved/);
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'adaptive', display: 'omitted' } },
        'test.seam',
      ),
    ).toThrow(/thinking\.display/);
  });

  it('passes a wire-safe body: no sampling params, thinking absent or exactly adaptive (+ optional display: summarized)', () => {
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', { model: 'claude-fable-5', max_tokens: 2048 }, 'test.seam'),
    ).not.toThrow();
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', { thinking: { type: 'adaptive' } }, 'test.seam'),
    ).not.toThrow();
    expect(() =>
      assertWireSafeForAlwaysOnThinking(
        'claude-fable-5',
        { thinking: { type: 'adaptive', display: 'summarized' } },
        'test.seam',
      ),
    ).not.toThrow();
  });

  it('does not reject disabled thinking for claude-opus-4-8', () => {
    const body: Record<string, unknown> = { thinking: { type: 'disabled' } };
    expect(() => assertWireSafeForAlwaysOnThinking('claude-opus-4-8', body, 'test.seam')).not.toThrow();
    expect(body).toEqual({ thinking: { type: 'disabled' } });
  });

  it('is a no-op for models that allow sampling params (invariant 3)', () => {
    const body: Record<string, unknown> = { temperature: 0, top_p: 0.9, thinking: { type: 'disabled' } };
    expect(() => assertWireSafeForAlwaysOnThinking('claude-opus-4-6', body, 'test.seam')).not.toThrow();
    expect(() => assertWireSafeForAlwaysOnThinking('gpt-5.4', body, 'test.seam')).not.toThrow();
    // Body untouched.
    expect(body).toEqual({ temperature: 0, top_p: 0.9, thinking: { type: 'disabled' } });
  });
});

describe('assertWireSafeForAlwaysOnThinking — PROD arm (capture + strip, no throw)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  it('strips temperature/top_p/top_k + non-adaptive thinking, captures via errorReporter, logs, does NOT throw', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const body: Record<string, unknown> = {
      model: 'claude-fable-5',
      max_tokens: 2048,
      temperature: 0,
      top_p: 0.9,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    };

    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'prod.seam'),
    ).not.toThrow();

    // Stripped — the request that goes out is wire-safe.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    // Everything else intact.
    expect(body.model).toBe('claude-fable-5');
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);

    // Captured through the errorReporter boundary with stable fingerprint.
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(error).toBeInstanceOf(AlwaysOnThinkingWireSafetyError);
    expect(context).toMatchObject({
      tags: { area: 'bts', invariant: 'always-on-thinking-wire-safe', seam: 'prod.seam' },
      fingerprint: ['always-on-thinking-wire-unsafe', 'prod.seam'],
    });

    // Structured log (pino arg order: object first).
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-fable-5',
        seam: 'prod.seam',
        violations: expect.arrayContaining(['temperature', 'top_p', 'thinking(non-adaptive)']),
      }),
      expect.any(String),
    );
  });

  it('strips sampling params for claude-opus-4-8 but preserves disabled thinking', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);
    const body: Record<string, unknown> = {
      temperature: 0,
      top_k: 40,
      thinking: { type: 'disabled' },
    };

    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-opus-4-8', body, 'prod.seam'),
    ).not.toThrow();

    expect(body.temperature).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-8',
        seam: 'prod.seam',
        violations: ['temperature', 'top_k'],
      }),
      expect.any(String),
    );
  });

  it('adaptive thinking survives the prod arm untouched when only sampling params violate', () => {
    setErrorReporter(makeReporterSpy().reporter);
    const body: Record<string, unknown> = {
      temperature: 0.2,
      thinking: { type: 'adaptive' },
    };
    assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'prod.seam');
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('surgically strips budget_tokens from an otherwise-valid adaptive shape, preserving type + display (GPT F2)', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);
    const body: Record<string, unknown> = {
      thinking: { type: 'adaptive', display: 'summarized', budget_tokens: 1024 },
    };

    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'prod.seam'),
    ).not.toThrow();

    // The whole thinking block is NOT deleted — only the offending key is.
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ violations: ['thinking.budget_tokens'] }),
      expect.any(String),
    );
  });

  it('reporter failure never breaks the request path (strip still happens)', () => {
    setErrorReporter({
      captureException: () => {
        throw new Error('sentry down');
      },
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    });
    const body: Record<string, unknown> = { temperature: 0 };
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'prod.seam'),
    ).not.toThrow();
    expect(body.temperature).toBeUndefined();
  });
});
