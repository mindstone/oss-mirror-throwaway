import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import { checkSystemPromptCoherence, SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS } from '../prompt';
import { callBehindTheScenesWithAuth } from '../../../behindTheScenesClient';
import { resolveSystemPrompt } from '../../../mcpService';

vi.mock('../../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
  getEffectiveModelName: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../mcpService', () => ({
  resolveSystemPrompt: vi.fn(),
}));

vi.mock('../../../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

describe('checkSystemPromptCoherence', () => {
  const mockSettings = {
    coreDirectory: '/mock/workspace',
  } as AppSettings;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates AbortSignal to behindTheScenesClient', async () => {
    vi.mocked(resolveSystemPrompt).mockResolvedValue('mock system prompt');
    vi.mocked(callBehindTheScenesWithAuth).mockResolvedValue({
      content: [{ type: 'text', text: '{"hasIssues":false,"issues":[]}' }],
    } as any);

    const controller = new AbortController();

    await checkSystemPromptCoherence(mockSettings, controller.signal);

    expect(callBehindTheScenesWithAuth).toHaveBeenCalledWith(
      mockSettings,
      expect.objectContaining({
        signal: controller.signal,
        timeout: SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS,
      }),
      expect.any(Object)
    );
  });

  it('returns skip (advisory contract) when the LLM call is aborted', async () => {
    vi.mocked(resolveSystemPrompt).mockResolvedValue('mock system prompt');
    vi.mocked(callBehindTheScenesWithAuth).mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );

    const controller = new AbortController();
    controller.abort();

    const result = await checkSystemPromptCoherence(mockSettings, controller.signal);

    expect(result.status).toBe('skip');
    expect(result.id).toBe('systemPromptCoherence');
  });
});
