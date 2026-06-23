import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BotQAModule = typeof import('../botQAService');

async function loadBotQAModule(options: {
  activeBotState: {
    botId: string;
    coachSkillPath?: string;
    coachPrompt?: string;
    coachContentHash?: string;
    coachPromptSource?: 'operator-frontmatter' | 'file-body';
    coachProactiveIntervalMinutes?: number;
  } | null;
  resolverPrompt?: { prompt: string; contentHash: string; source: 'operator-frontmatter' | 'file-body'; proactiveIntervalMinutes?: number };
}) {
  vi.resetModules();

  const resolveMeetingCoachPrompt = vi.fn(() => options.resolverPrompt ?? {
    prompt: 'Resolved coach prompt',
    contentHash: 'resolved-hash',
    source: 'operator-frontmatter' as const,
  });

  const runHeadlessTurn = vi.fn(async ({ prompt, onEvent }) => {
    onEvent({ type: 'assistant', text: 'Answer from memory' });
    onEvent({ type: 'result', text: 'Answer from memory', prompt });
  });

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }));

  vi.doMock('@core/services/settingsStore', () => ({
    setSettingsStoreAdapter: vi.fn(),
    getSettings: vi.fn(() => ({ meetingBot: {} })),
  }));

  vi.doMock('@core/services/meetingTriggerDetector', () => ({
    GO_AHEAD_IN_TEXT_RE: /go\s+ahead/i,
    createMeetingTriggerDetector: vi.fn(() => ({
      ingestSegment: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      hasPendingAccumulation: vi.fn(() => false),
      getAccumulationSpeaker: vi.fn(() => null),
      beginAccumulation: vi.fn(),
      appendToAccumulation: vi.fn(),
      cancelAccumulation: vi.fn(),
      dispose: vi.fn(),
    })),
    extractFollowUpAfterConfirmation: vi.fn(() => null),
    extractQuestion: vi.fn((text: string) => text.replace(/^spark[\s,:-]*/i, '').trim()),
    isConfirmationPhrase: vi.fn(() => false),
    matchesDiscardTrigger: vi.fn(() => false),
    matchesStopTrigger: vi.fn(() => false),
    matchesTrigger: vi.fn((text: string) => /spark/i.test(text)),
    stripTriggerPrefix: vi.fn(() => null),
    classifyHighSignalUtterance: vi.fn(() => null),
  }));

  vi.doMock('../botVoiceService', () => ({
    speakInMeeting: vi.fn(async () => true),
    setAvatarState: vi.fn(),
    stopSpeaking: vi.fn(),
  }));

  vi.doMock('../backendAuth', () => ({
    getBackendAuthHeader: vi.fn(() => 'mock-auth'),
  }));

  vi.doMock('@core/services/meetingBotBackendConfig', async () => {
    const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
      '@core/services/meetingBotBackendConfig',
    );
    return {
      ...actual,
      resolveMeetingBotBackendConfig: vi.fn(() => ({
        configured: true,
        url: 'https://backend.example',
        authKey: 'test-key',
      })),
    };
  });

  vi.doMock('../../behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(async (settings, params) => {
      if (typeof params?.messages?.[0]?.content === 'string' && params.messages[0].content.includes('Is this a complete question')) {
        return { content: [{ text: 'complete' }] };
      }
      return { content: [{ text: '' }] };
    }),
  }));

  vi.doMock('../transcriptStorage', () => ({
    saveLiveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/live-transcript.md' })),
    appendToLiveTranscript: vi.fn(async () => ({ success: true, newSegmentsWritten: 1 })),
  }));

  vi.doMock('../pendingTranscriptsStore', () => ({
    updateLiveTranscriptPath: vi.fn(),
    getPendingTranscript: vi.fn(() => ({
      meetingUrl: 'https://example.com/meeting',
      meetingTitle: 'Weekly sync',
      createdAt: Date.now(),
      calendarEventId: 'event-1',
      calendarSource: 'google',
    })),
  }));

  vi.doMock('../conversationStateService', () => ({
    formatMeetingContext: vi.fn(() => ''),
  }));

  vi.doMock('../meetingBotRuntimeRegistry', () => ({
    getActiveBotState: vi.fn(() => options.activeBotState),
  }));

  vi.doMock('../../meetingCoachPromptResolver', () => ({
    resolveMeetingCoachPrompt,
  }));

  vi.doMock('@core/services/operatorRegistry', () => ({
    listAvailable: vi.fn(async () => []),
    listAvailableWithDiagnostics: vi.fn(async () => ({ operators: [], failures: [] })),
    getById: vi.fn(() => undefined),
    invalidateOperatorRegistry: vi.fn(),
  }));

  const botQA = await import('../botQAService');
  botQA.initializeBotQAService({
    runHeadlessTurn,
    getConversationState: vi.fn(() => null),
  });

  return { botQA, resolveMeetingCoachPrompt, runHeadlessTurn };
}

describe('botQAService coach prompt resolution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [] }),
      status: 200,
      statusText: 'OK',
    })));
  });

  afterEach(async () => {
    const maybeModule = await import('../botQAService');
    maybeModule.stopAllBotQA();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves coach prompt once then reuses cached prompt for subsequent questions', async () => {
    const activeBotState: {
      botId: string;
      coachSkillPath?: string;
      coachPrompt?: string;
      coachContentHash?: string;
      coachPromptSource?: 'operator-frontmatter' | 'file-body';
      coachProactiveIntervalMinutes?: number;
    } = {
      botId: 'bot-1',
      coachSkillPath: '/tmp/coach.md',
    };

    const { botQA, resolveMeetingCoachPrompt, runHeadlessTurn } = await loadBotQAModule({
      activeBotState,
      resolverPrompt: {
        prompt: 'Apply this coach framing',
        contentHash: 'coach-hash',
        source: 'operator-frontmatter',
      },
    });

    botQA.startBotQA('bot-1', 'Alice', 'Spark', true);
    botQA.setKnowledgeAccess('bot-1', true);

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const firstTimestamp = '2026-05-25T10:00:00.000Z';
    const secondTimestamp = '2026-05-25T10:00:10.000Z';
    const pollMessages = [
      [{ text: 'Spark what should I say next?', sender: { name: 'Alice' }, timestamp: firstTimestamp, created_at: firstTimestamp }],
      [{ text: 'Spark how should I respond to pricing pushback?', sender: { name: 'Alice' }, timestamp: secondTimestamp, created_at: secondTimestamp }],
      [],
    ];
    let pollIndex = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
          text: async () => '',
        } as Response;
      }
      const messages = pollMessages[pollIndex] ?? [];
      pollIndex += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true, messages }),
        text: async () => '',
      } as Response;
    });

    await vi.advanceTimersByTimeAsync(2200);
    await Promise.resolve();

    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(resolveMeetingCoachPrompt).toHaveBeenCalledTimes(1);
    expect(runHeadlessTurn.mock.calls[0]?.[0]?.prompt).toContain('Apply this coach framing');

    await vi.advanceTimersByTimeAsync(2200);
    await Promise.resolve();

    expect(resolveMeetingCoachPrompt).toHaveBeenCalledTimes(1);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(2);
    expect(runHeadlessTurn.mock.calls[1]?.[0]?.prompt).toContain('Apply this coach framing');
    expect(activeBotState.coachContentHash).toBe('coach-hash');
    expect(activeBotState.coachPrompt).toBe('Apply this coach framing');
  });

  it('uses pre-cached coach prompt without invoking resolver', async () => {
    const activeBotState = {
      botId: 'bot-2',
      coachSkillPath: '/tmp/coach.md',
      coachPrompt: 'Already cached coach guidance',
      coachContentHash: 'cached-hash',
      coachPromptSource: 'operator-frontmatter' as const,
    };

    const { botQA, resolveMeetingCoachPrompt, runHeadlessTurn } = await loadBotQAModule({
      activeBotState,
    });

    botQA.startBotQA('bot-2', 'Alice', 'Spark', true);
    botQA.setKnowledgeAccess('bot-2', true);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const timestamp = '2026-05-25T10:15:00.000Z';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
          text: async () => '',
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          success: true,
          messages: [{ text: 'Spark what should I say here?', sender: { name: 'Alice' }, timestamp, created_at: timestamp }],
        }),
        text: async () => '',
      } as Response;
    });

    await vi.advanceTimersByTimeAsync(2200);
    await Promise.resolve();

    expect(resolveMeetingCoachPrompt).not.toHaveBeenCalled();
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(runHeadlessTurn.mock.calls[0]?.[0]?.prompt).toContain('Already cached coach guidance');
  });
});
