import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

const mockCallBehindTheScenes = vi.fn();

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenes(...args),
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({ isConnected: () => false }),
}));

import {
  buildCoachingPrompt,
  COACHING_JSON_SCHEMA,
  evaluateSessionForCoaching,
  parseCoachingResponseModelText,
  type SessionCoachingContext,
} from '../sessionCoachingService';

const fakeSettings = {} as AppSettings;

function makeContext(overrides: Partial<SessionCoachingContext> = {}): SessionCoachingContext {
  return {
    sessionId: 'session-1',
    transcript: 'User asked about preparing for a customer renewal. Assistant answered with generic next steps.',
    toolsAvailable: [],
    toolsUsed: [],
    messageCount: 4,
    ...overrides,
  };
}

function makeLlmResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

describe('sessionCoachingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the production prompt and schema to the BTS client', async () => {
    const context = makeContext();
    mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse(JSON.stringify({ hasInsight: false })));

    await evaluateSessionForCoaching(context, fakeSettings);

    expect(mockCallBehindTheScenes).toHaveBeenCalledWith(
      fakeSettings,
      expect.objectContaining({
        messages: [{ role: 'user', content: buildCoachingPrompt(context) }],
        outputFormat: {
          type: 'json_schema',
          schema: COACHING_JSON_SCHEMA,
        },
        timeout: 30000,
      }),
      { category: 'coaching', sessionId: context.sessionId },
    );
  });

  it('uses the safe model-text parser, including markdown fenced JSON', async () => {
    const parsed = parseCoachingResponseModelText('```json\n{"hasInsight":false,"reason":"nothing useful"}\n```');

    expect(parsed).toEqual({ hasInsight: false, reason: 'nothing useful' });
  });

  it('filters insights below the production quality threshold', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse(JSON.stringify({
      hasInsight: true,
      rating: 84,
      insight: 'The renewal angle was underused.',
      continuationPrompt: 'Search the CRM for renewal risks.',
      category: 'deeper_research',
    })));

    await expect(evaluateSessionForCoaching(makeContext(), fakeSettings)).resolves.toBeNull();
  });

  it('falls back invalid categories to deeper_research', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse(JSON.stringify({
      hasInsight: true,
      rating: 95,
      insight: 'The customer renewal context should have been connected.',
      continuationPrompt: 'Review the renewal thread and summarize risks.',
      category: 'not_a_real_category',
    })));

    const result = await evaluateSessionForCoaching(makeContext(), fakeSettings);

    expect(result?.primaryInsight.category).toBe('deeper_research');
  });

  it('returns null when an insight is missing required production fields', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse(JSON.stringify({
      hasInsight: true,
      rating: 95,
      insight: 'The customer renewal context should have been connected.',
      category: 'deeper_research',
    })));

    await expect(evaluateSessionForCoaching(makeContext(), fakeSettings)).resolves.toBeNull();
  });
});
