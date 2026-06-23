/**
 * Plugin IPC error shaping — classification-first humanization regression tests.
 *
 * Stage 6b of docs/plans/260421_classification_driven_error_humanizer.md.
 *
 * The motivating v1 bug: a plugin calling `useAi()` on OpenAI quota-exhausted
 * would surface "That request was too large" via the legacy classification-
 * blind `humanizeError(string)` ladder. After Stage 6b the plugin IPC surface
 * uses classification-first `humanizeAgentError({kind:'classified', ...})`
 * and passes the provider context extracted from the thrown `ModelError`, so
 * the user now sees the correct subtype+provider-aware copy.
 *
 * Also covers:
 *   - Unclassified errors route to the `'unclassified'` branch (parity with pre-migration).
 *   - Plugin IPC contract preserved: humanized message still lives on `err.message`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

const registeredHandlers = new Map<
  string,
  (event: unknown, request?: unknown) => Promise<unknown>
>();
const mockCallBehindTheScenesWithAuth = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('../../utils/registerHandler', () => ({
  registerHandler: vi.fn(
    (channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureException: mockCaptureException }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({} as unknown),
}));

vi.mock('@core/services/pluginAiRateLimiter', () => ({
  checkRateLimit: () => ({ allowed: true }),
  recordCall: vi.fn(),
}));

vi.mock('../../../services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

vi.mock('../../../services/pluginPreTurnContextStore', () => ({
  getPluginPreTurnContexts: () => ({}),
  setPluginPreTurnContexts: vi.fn(),
}));

vi.mock('../shared', () => ({
  hasPluginPermission: vi.fn(() => true),
  getPluginExternalDomains: vi.fn(() => []),
}));

import { registerPluginFetchHandlers } from '../pluginFetchHandlers';

describe('pluginFetchHandlers humanizer — classification-first (Stage 6b)', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockCallBehindTheScenesWithAuth.mockReset();
    mockCaptureException.mockReset();
    registerPluginFetchHandlers();
  });

  it('billing ModelError with OpenAI insufficient_quota: err.message is subtype+provider-aware (v1 bug regression)', async () => {
    // v1 bug: this exact rawMessage previously produced "That request was too large"
    // via the legacy classification-blind humanizer ladder.
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'You exceeded your current quota, please check your plan and billing details.',
        429,
        'OpenAI',
        {
          rawMessage:
            'You exceeded your current quota, please check your plan and billing details. insufficient_quota',
        },
      ),
    );

    const handler = registeredHandlers.get('plugins:ai-summarize');
    await expect(
      handler?.({}, { pluginId: 'some-plugin', text: 'hello', maxLength: 100 }),
    ).rejects.toThrow(/OpenAI/);

    // err.message must NOT be "That request was too large" (the v1 bug copy).
    try {
      await handler?.({}, { pluginId: 'some-plugin', text: 'hello', maxLength: 100 });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).not.toContain('That request was too large');
      // Provider-aware subtype copy — the bug fix.
      expect(message).toContain('OpenAI');
      expect(message.toLowerCase()).toMatch(/usage limit|quota|credits/);
    }
  });

  it('billing ModelError on OpenRouter with credits subtype: provider-aware copy + auto-topup hint', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
        {
          rawMessage:
            '402 {"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
        },
      ),
    );

    const handler = registeredHandlers.get('plugins:ai-extract');
    try {
      await handler?.(
        {},
        {
          pluginId: 'some-plugin',
          text: 'hello',
          schema: { name: 'thing', description: 'desc', properties: {} },
        },
      );
      expect.fail('expected handler to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toBe(
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      );
    }
  });

  it('auth ModelError produces API-key-aware humanized copy', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError('auth', 'Invalid API key', 401, 'Anthropic'),
    );

    const handler = registeredHandlers.get('plugins:ai-generate');
    try {
      await handler?.({}, { pluginId: 'some-plugin', prompt: 'hello', maxTokens: 500 });
      expect.fail('expected handler to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message.toLowerCase()).toContain('api key');
      expect(message.toLowerCase()).toContain('settings');
    }
  });

  it('non-ModelError falls through to unclassified humanizer branch (parity with pre-migration)', async () => {
    // A plain network error has no classification metadata. Routes to
    // humanizeAgentError({kind:'unclassified', ...}) which delegates to the
    // legacy humanizeError ladder.
    mockCallBehindTheScenesWithAuth.mockRejectedValue(new Error('ETIMEDOUT'));

    const handler = registeredHandlers.get('plugins:ai-summarize');
    try {
      await handler?.({}, { pluginId: 'some-plugin', text: 'hello', maxLength: 100 });
      expect.fail('expected handler to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Should be humanized (not the raw ETIMEDOUT token). humanizeError('ETIMEDOUT')
      // produces the "longer than usual" network-timeout copy.
      const message = (err as Error).message;
      expect(message).not.toBe('');
      expect(message).not.toBe('ETIMEDOUT');
      expect(message.toLowerCase()).toContain('longer than usual');
    }
  });

  it('Sentry capture still receives errorKind tag (observability preserved)', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError('rate_limit', 'HTTP 429', 429, 'OpenAI'),
    );

    const handler = registeredHandlers.get('plugins:ai-summarize');
    try {
      await handler?.({}, { pluginId: 'plug-1', text: 'hello', maxLength: 100 });
    } catch {
      /* expected */
    }

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          plugin_id: 'plug-1',
          operation: 'summarize',
          error_kind: 'rate_limit',
          surface: 'plugin_ai',
        }),
      }),
    );
  });
});
