import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { createBtsSafetyEvalService, isTemperatureRejectionError } from '../btsSafetyEvalService';
import { ModelError } from '@core/rebelCore/modelErrors';

const mocks = vi.hoisted(() => ({
  callWithModelAuthAware: vi.fn(),
  createBtsRoutePlan: vi.fn(),
  getSettings: vi.fn(),
  resolveBtsModel: vi.fn(),
  codexConnected: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => mocks.callWithModelAuthAware(...args),
  createBtsRoutePlan: (...args: unknown[]) => mocks.createBtsRoutePlan(...args),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => mocks.getSettings(),
}));

vi.mock('@shared/utils/btsModelResolver', () => ({
  resolveBtsModel: (...args: unknown[]) => mocks.resolveBtsModel(...args),
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({
    isConnected: mocks.codexConnected,
  }),
}));

describe('btsSafetyEvalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockReturnValue({ behindTheScenesModel: 'openai/gpt-5.5' } as AppSettings);
    mocks.resolveBtsModel.mockReturnValue('openai/gpt-5.5');
    mocks.codexConnected.mockReturnValue(true);
    mocks.createBtsRoutePlan.mockResolvedValue({
      decision: { transport: 'anthropic-direct' },
    });
    mocks.callWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"decision":"allow","confidence":"high","reason":"ok"}' }],
      model: 'claude-haiku-4-5',
    });
  });

  it('threads disableOperationalFallback to auth-aware BTS dispatch for explicit fallback hops', async () => {
    const service = createBtsSafetyEvalService();

    await service.callLlm({
      system: 'sys',
      userMessage: 'user',
      maxTokens: 256,
      outputSchema: { type: 'object' },
      timeout: 7000,
      modelOverride: 'claude-haiku-4-5',
      transportHint: 'anthropic-direct',
      disableOperationalFallback: true,
    });

    expect(mocks.callWithModelAuthAware).toHaveBeenCalledTimes(1);
    expect(mocks.callWithModelAuthAware).toHaveBeenCalledWith(
      expect.anything(),
      'claude-haiku-4-5',
      expect.objectContaining({
        codexConnectivity: 'connected',
      }),
      expect.objectContaining({
        category: 'safety',
      }),
      { disableOperationalFallback: true },
    );
  });

  // Fable 5 Stage 6: a provider safety refusal of the eval call itself
  // (stop_reason: 'refusal' surfaced as `_stopReason`, no usable text) must
  // classify distinctly instead of masquerading as a generic parse failure.
  it('classifies a refused BTS response (stop_reason: refusal) distinctly from a parse failure', async () => {
    mocks.callWithModelAuthAware.mockResolvedValue({
      content: [],
      model: 'claude-fable-5',
      _stopReason: 'refusal',
    });

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({
      system: 'sys',
      userMessage: 'user',
      maxTokens: 256,
      outputSchema: { type: 'object' },
      timeout: 7000,
    })).rejects.toThrow(/refused by provider safety classifier/);
  });

  it('keeps the generic parse-failure error for empty responses WITHOUT a refusal stop reason', async () => {
    mocks.callWithModelAuthAware.mockResolvedValue({
      content: [],
      model: 'claude-fable-5',
    });

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({
      system: 'sys',
      userMessage: 'user',
      maxTokens: 256,
      outputSchema: { type: 'object' },
      timeout: 7000,
    })).rejects.toThrow('Unexpected response format from safety evaluation LLM');
  });

  // A4 (Stage 2): every eval dispatch logs the resolved model + the transport
  // actually resolved by the route plan — not only the `requestedOverride`
  // branch. This is the triage signal for "which model/transport did the
  // failing safety call use?".
  it('logs the resolved model + transport on the normal (no-override) path', async () => {
    mocks.resolveBtsModel.mockReturnValue('openai/gpt-5.4-mini');
    mocks.createBtsRoutePlan.mockResolvedValue({ decision: { transport: 'codex-proxy' } });

    const service = createBtsSafetyEvalService();
    await service.callLlm({
      system: 'sys',
      userMessage: 'user',
      maxTokens: 256,
      outputSchema: { type: 'object' },
      timeout: 7000,
    });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: 'openai/gpt-5.4-mini',
        transport: 'codex-proxy',
        codexConnectivity: 'connected',
      }),
      'Safety eval dispatch resolved model + transport',
    );
  });

  it('logs transport: null when route-plan resolution fails (never breaks the eval)', async () => {
    mocks.createBtsRoutePlan.mockRejectedValue(new Error('route resolution blew up'));

    const service = createBtsSafetyEvalService();
    // The eval itself still completes — the log resolution is best-effort.
    const result = await service.callLlm({
      system: 'sys',
      userMessage: 'user',
      maxTokens: 256,
      outputSchema: { type: 'object' },
      timeout: 7000,
    });

    expect(result.text).toContain('"decision":"allow"');
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: 'openai/gpt-5.5',
        transport: null,
      }),
      'Safety eval dispatch resolved model + transport',
    );
  });
});

describe('isTemperatureRejectionError — self-heal regex for sampling-forbidden models', () => {
  function temp400(rawMessage: string): ModelError {
    return new ModelError('invalid_request', rawMessage, 400, 'Anthropic', { rawMessage });
  }

  it('matches the deprecated-temperature 400 text used by Fable 5 and Opus 4.7/4.8', () => {
    expect(isTemperatureRejectionError(temp400('`temperature` is deprecated for this model.'))).toBe(true);
  });

  it('still matches the pre-existing unsupported/not-support/only-the-default arms', () => {
    expect(isTemperatureRejectionError(temp400('temperature is unsupported for this model'))).toBe(true);
    expect(isTemperatureRejectionError(temp400('This model does not support temperature'))).toBe(true);
    expect(isTemperatureRejectionError(temp400("'temperature' supports only the default value for this model"))).toBe(true);
  });

  it('rejects non-temperature 400s, non-400s, and non-ModelErrors', () => {
    expect(isTemperatureRejectionError(temp400('`top_p` is deprecated for this model.'))).toBe(false);
    expect(isTemperatureRejectionError(
      new ModelError('invalid_request', '`temperature` is deprecated for this model.', 422, 'Anthropic'),
    )).toBe(false);
    expect(isTemperatureRejectionError(
      new ModelError('rate_limit', 'temperature deprecated', 400, 'Anthropic'),
    )).toBe(false);
    expect(isTemperatureRejectionError(new Error('`temperature` is deprecated for this model.'))).toBe(false);
  });
});
