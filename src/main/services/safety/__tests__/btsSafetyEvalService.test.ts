import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { callWithModelAuthAware } from '@core/services/behindTheScenesClient';
import { getSettings } from '@core/services/settingsStore';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  __resetTemperatureUnsupportedModelsForTesting,
  createBtsSafetyEvalService,
} from '../btsSafetyEvalService';

const loggerState = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerState.logger),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(),
}));

const mockSettings = {
  behindTheScenesModel: 'claude-haiku-4-5',
  claude: {
    apiKey: 'test-api-key',
    oauthToken: null,
    authMethod: 'api-key',
  },
} as unknown as AppSettings;

const baseRequest = {
  system: 'Evaluate action safety',
  userMessage: 'Tool call details',
  maxTokens: 321,
  outputSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string' },
    },
  },
  timeout: 8_500,
};

function makeTextResponse(text: string): {
  content: Array<{ type: string; text?: string }>;
  model: string;
  structured_output?: unknown;
} {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5',
  };
}

function makeTemperatureRejectionError(message: string): ModelError {
  return new ModelError('invalid_request', message, 400, 'openai', {
    rawMessage: message,
  });
}

describe('createBtsSafetyEvalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTemperatureUnsupportedModelsForTesting();
    vi.mocked(getSettings).mockReturnValue(mockSettings);
  });

  it('calls callWithModelAuthAware with the expected params', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await service.callLlm(baseRequest);

    expect(callWithModelAuthAware).toHaveBeenCalledWith(
      mockSettings,
      'claude-haiku-4-5',
      {
        codexConnectivity: 'disconnected',
        system: baseRequest.system,
        messages: [{ role: 'user', content: baseRequest.userMessage }],
        maxTokens: baseRequest.maxTokens,
        outputFormat: {
          type: 'json_schema',
          schema: baseRequest.outputSchema,
        },
        timeout: baseRequest.timeout,
        signal: undefined,
      },
      { category: 'safety', outcomePolicy: 'turn_bearing' },
      { disableOperationalFallback: false },
    );
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it('forwards temperature on supported models', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await service.callLlm({ ...baseRequest, temperature: 0 });

    const options = vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2];
    expect(options).toMatchObject({ temperature: 0 });
  });

  it('retries once without temperature on temperature rejection and remembers model', async () => {
    const rejection = makeTemperatureRejectionError(
      'This model does not support temperature. Only the default value is supported.',
    );
    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow","confidence":"high"}'));

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm({ ...baseRequest, temperature: 0 });

    expect(result).toEqual({ text: '{"decision":"allow","confidence":"high"}' });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2]).toMatchObject({ temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[1]?.[2]).not.toHaveProperty('temperature');
    expect(loggerState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.eval_temperature_unsupported',
        model: 'claude-haiku-4-5',
        retrySucceeded: true,
        errKind: 'invalid_request',
      }),
      expect.stringContaining('rejected temperature'),
    );

    vi.mocked(callWithModelAuthAware).mockReset();
    vi.mocked(callWithModelAuthAware).mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'));

    await service.callLlm({ ...baseRequest, temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2]).not.toHaveProperty('temperature');
  });

  it('detects temperature rejection wording from ModelError __rawMessage', async () => {
    const rejection = new ModelError('invalid_request', 'Invalid request body', 400, 'openai', {
      rawMessage:
        '{"error":{"message":"Unsupported parameter: temperature. Only the default value is supported."}}',
    });
    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm({ ...baseRequest, temperature: 0 });

    expect(rejection.__rawMessage).toContain('temperature');
    expect(result).toEqual({ text: '{"decision":"allow"}' });
    expect(vi.mocked(callWithModelAuthAware)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2]).toMatchObject({ temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[1]?.[2]).not.toHaveProperty('temperature');
  });

  it('does not remember model when no-temp retry also fails', async () => {
    const rejection = makeTemperatureRejectionError(
      'temperature is unsupported for this model; only the default is accepted',
    );
    const retryError = new Error('retry without temperature failed');
    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(retryError)
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({ ...baseRequest, temperature: 0 })).rejects.toBe(retryError);
    await service.callLlm({ ...baseRequest, temperature: 0 });

    expect(vi.mocked(callWithModelAuthAware).mock.calls[2]?.[2]).toMatchObject({ temperature: 0 });
  });

  it('logs retrySucceeded:false (observably) when the no-temp retry also fails', async () => {
    const rejection = makeTemperatureRejectionError(
      'temperature is unsupported for this model; only the default is accepted',
    );
    const retryError = new Error('retry without temperature failed');
    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(retryError);

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({ ...baseRequest, temperature: 0 })).rejects.toBe(retryError);

    expect(loggerState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.eval_temperature_unsupported',
        model: 'claude-haiku-4-5',
        retrySucceeded: false,
        errKind: 'invalid_request',
      }),
      expect.any(String),
    );
  });

  it('rethrows a malformed first response without misclassifying it as a temperature rejection', async () => {
    // First (with-temperature) call returns an unparseable response shape →
    // extractResponse throws a plain Error inside the try. It must NOT be
    // treated as a temperature rejection (no spurious no-temp retry).
    vi.mocked(callWithModelAuthAware).mockResolvedValueOnce({
      content: [{ type: 'tool_result' }],
      model: 'claude-haiku-4-5',
    });

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({ ...baseRequest, temperature: 0 })).rejects.toThrow(
      'Unexpected response format from safety evaluation LLM',
    );

    expect(vi.mocked(callWithModelAuthAware)).toHaveBeenCalledTimes(1);
    expect(loggerState.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.eval_temperature_unsupported' }),
      expect.any(String),
    );
  });

  it('rethrows non-temperature invalid_request errors without stripping temperature', async () => {
    const nonTemperatureError = new ModelError(
      'invalid_request',
      'max_tokens: 1000000 exceeds maximum of 8192',
      400,
      'openai',
      {
        rawMessage: 'max_tokens cannot exceed model limit',
      },
    );

    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(nonTemperatureError)
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await expect(service.callLlm({ ...baseRequest, temperature: 0 })).rejects.toBe(nonTemperatureError);
    await service.callLlm({ ...baseRequest, temperature: 0 });

    expect(vi.mocked(callWithModelAuthAware)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2]).toMatchObject({ temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[1]?.[2]).toMatchObject({ temperature: 0 });
    expect(loggerState.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.eval_temperature_unsupported' }),
      expect.any(String),
    );
  });

  it('keeps current behavior when request has no temperature', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await service.callLlm(baseRequest);

    expect(vi.mocked(callWithModelAuthAware)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2]).not.toHaveProperty('temperature');
  });

  it('reset seam clears remembered temperature-unsupported models', async () => {
    const rejection = makeTemperatureRejectionError(
      'temperature is unsupported; only the default is allowed',
    );
    vi.mocked(callWithModelAuthAware)
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'))
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'))
      .mockResolvedValueOnce(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await service.callLlm({ ...baseRequest, temperature: 0 });
    await service.callLlm({ ...baseRequest, temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[2]?.[2]).not.toHaveProperty('temperature');

    __resetTemperatureUnsupportedModelsForTesting();
    await service.callLlm({ ...baseRequest, temperature: 0 });
    expect(vi.mocked(callWithModelAuthAware).mock.calls[3]?.[2]).toMatchObject({ temperature: 0 });
  });

  it('extracts text content from the BTS response', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue({
      content: [
        { type: 'tool_result' },
        { type: 'text', text: '{"decision":"block"}' },
      ],
      model: 'claude-haiku-4-5',
    });

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm(baseRequest);

    expect(result).toEqual({ text: '{"decision":"block"}' });
  });

  it('serializes structured_output when text content is absent', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue({
      content: [{ type: 'tool_result' }],
      model: 'claude-haiku-4-5',
      structured_output: { decision: 'allow', confidence: 'high' },
    });

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm(baseRequest);

    expect(result).toEqual({ text: '{"decision":"allow","confidence":"high"}' });
  });

  it('prefers structured_output over text content when both are present', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue({
      content: [
        { type: 'text', text: '**Explanation of the principle:**\n\nSome markdown prose' },
      ],
      model: 'claude-haiku-4-5',
      structured_output: { decision: 'allow', scope: 'broad' },
    });

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm(baseRequest);

    expect(result).toEqual({ text: '{"decision":"allow","scope":"broad"}' });
  });

  it('treats structured_output: null as absent and falls back to text', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue({
      content: [{ type: 'text', text: '{"decision":"block"}' }],
      model: 'claude-haiku-4-5',
      structured_output: null,
    });

    const service = createBtsSafetyEvalService();
    const result = await service.callLlm(baseRequest);

    expect(result).toEqual({ text: '{"decision":"block"}' });
  });

  it('throws on unexpected response format', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue({
      content: [{ type: 'tool_result' }],
      model: 'claude-haiku-4-5',
    });

    const service = createBtsSafetyEvalService();

    await expect(service.callLlm(baseRequest)).rejects.toThrow(
      'Unexpected response format from safety evaluation LLM',
    );
  });

  it('passes timeout and outputFormat through to BTS client', async () => {
    vi.mocked(callWithModelAuthAware).mockResolvedValue(makeTextResponse('{"decision":"allow"}'));

    const service = createBtsSafetyEvalService();
    await service.callLlm(baseRequest);

    const options = vi.mocked(callWithModelAuthAware).mock.calls[0]?.[2];
    expect(options?.timeout).toBe(baseRequest.timeout);
    expect(options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: baseRequest.outputSchema,
    });
  });
});
