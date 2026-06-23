import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallLlm,
  mockGetPrompt,
  mockLogInfo,
  mockLogWarn,
  mockLogDebug,
  mockLogError,
} = vi.hoisted(() => ({
  mockCallLlm: vi.fn(),
  mockGetPrompt: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@core/safetyEvaluationService', () => ({
  getSafetyEvaluationService: () => ({ callLlm: mockCallLlm }),
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: mockGetPrompt,
  PROMPT_IDS: {
    SAFETY_USER_INTENT_CLASSIFIER: 'safety/user-intent-classifier',
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn().mockReturnValue({
    info: mockLogInfo,
    warn: mockLogWarn,
    debug: mockLogDebug,
    error: mockLogError,
  }),
}));

import {
  createUserIntentExtractorCache,
  extractUserIntent,
} from '../userIntentExtractor';

const baseArgs = {
  toolId: 'slack__send_message',
  toolFamily: 'send_message' as const,
  sessionId: 'sess-1',
};

describe('extractUserIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrompt.mockReturnValue('SYSTEM PROMPT FOR USER INTENT CLASSIFIER');
  });

  it('returns null when the user message is empty or whitespace-only', async () => {
    expect(await extractUserIntent({ ...baseArgs, userMessage: '' })).toBeNull();
    expect(await extractUserIntent({ ...baseArgs, userMessage: '   ' })).toBeNull();
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('returns null when the user message is shorter than the minimum length', async () => {
    expect(await extractUserIntent({ ...baseArgs, userMessage: 'go' })).toBeNull();
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('forwards a clean imperative + high confidence result', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: 'send it',
        confidence: 'high',
      }),
    });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'please send it now' });
    expect(result).toEqual({
      signal: 'imperative',
      triggerPhrase: 'send it',
      confidence: 'high',
    });
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.user_intent_fence_injected',
        intentSignal: 'imperative',
        triggerPhraseLength: 'send it'.length,
        confidence: 'high',
      }),
      expect.any(String),
    );
  });

  it('forwards a confirmation + medium confidence result', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'confirmation',
        triggerPhrase: 'go ahead',
        confidence: 'medium',
      }),
    });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'go ahead' });
    expect(result?.signal).toBe('confirmation');
  });

  it('returns null on signal=none even with high confidence', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({ signal: 'none', triggerPhrase: '', confidence: 'high' }),
    });
    const result = await extractUserIntent({
      ...baseArgs,
      userMessage: "what if I sent it tomorrow?",
    });
    expect(result).toBeNull();
  });

  it('forwards a negation result so the caller can invalidate cache', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'negation',
        triggerPhrase: "wait, don't send it",
        confidence: 'high',
      }),
    });
    const result = await extractUserIntent({
      ...baseArgs,
      userMessage: "wait, don't send it",
    });
    expect(result).toEqual({
      signal: 'negation',
      triggerPhrase: "wait, don't send it",
      confidence: 'high',
    });
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.user_intent_negation_detected' }),
      expect.any(String),
    );
  });

  it('redacts triggerPhrase in logs (length + hash only)', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: 'send it',
        confidence: 'high',
      }),
    });
    await extractUserIntent({ ...baseArgs, userMessage: 'please send it now' });
    const fenceLog = mockLogInfo.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).event === 'safety.user_intent_fence_injected',
    );
    expect(fenceLog).toBeDefined();
    const fields = fenceLog![0] as Record<string, unknown>;
    expect(fields.triggerPhrase).toBeUndefined();
    expect(fields.triggerPhraseHash).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(fields.triggerPhraseLength).toBe('send it'.length);
  });

  it('returns null on low confidence even when signal is imperative', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: 'maybe send it',
        confidence: 'low',
      }),
    });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'maybe send it' });
    expect(result).toBeNull();
  });

  it('returns null when the trigger phrase is empty', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: '',
        confidence: 'high',
      }),
    });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'send it' });
    expect(result).toBeNull();
  });

  it('memoises identical (message, family) calls within the supplied cache', async () => {
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: 'send it',
        confidence: 'high',
      }),
    });
    const cache = createUserIntentExtractorCache();
    await extractUserIntent({ ...baseArgs, userMessage: 'please send it now', cache });
    await extractUserIntent({ ...baseArgs, userMessage: 'please send it now', cache });
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
  });

  it('does not memoise across different tool families even with identical messages', async () => {
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({
        signal: 'imperative',
        triggerPhrase: 'send it',
        confidence: 'high',
      }),
    });
    const cache = createUserIntentExtractorCache();
    await extractUserIntent({
      ...baseArgs,
      userMessage: 'please send it now',
      toolFamily: 'send_message',
      cache,
    });
    await extractUserIntent({
      ...baseArgs,
      userMessage: 'please send it now',
      toolFamily: 'send_email',
      cache,
    });
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
  });

  it('returns null and emits a warn on classifier LLM failure', async () => {
    mockCallLlm.mockRejectedValueOnce(new Error('upstream timeout'));
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'please send it' });
    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.user_intent_classifier_error',
        phase: 'llm_call',
      }),
      expect.any(String),
    );
  });

  it('returns null and emits a parse-error warn when classifier returns garbage', async () => {
    mockCallLlm.mockResolvedValueOnce({ text: 'this is not json' });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'please send it' });
    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.user_intent_classifier_parse_error' }),
      expect.any(String),
    );
    const parseErrLog = mockLogWarn.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).event === 'safety.user_intent_classifier_parse_error',
    );
    const fields = parseErrLog![0] as Record<string, unknown>;
    expect(fields.textPreview).toBeUndefined();
    expect(fields.textHash).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(fields.textLength).toBe('this is not json'.length);
  });

  it('returns null without warning on AbortError', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockCallLlm.mockRejectedValueOnce(abortErr);
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'please send it' });
    expect(result).toBeNull();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('parses JSON wrapped in markdown fences', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: '```json\n{"signal":"imperative","triggerPhrase":"send it","confidence":"high"}\n```',
    });
    const result = await extractUserIntent({ ...baseArgs, userMessage: 'send it now' });
    expect(result?.signal).toBe('imperative');
  });
});
