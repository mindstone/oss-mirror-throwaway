type ConversationStateServiceModule = typeof import('../conversationStateService');

type SettingsStoreModule = typeof import('@core/services/settingsStore');
type BehindTheScenesClientModule = typeof import('../../behindTheScenesClient');

function makeStateResponse(payload: {
  currentTopic: string;
  shortSummary: string;
  openQuestions: string[];
  recentDecisions: string[];
}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    model: 'claude-3-5-haiku',
  };
}

describe('conversationStateService', () => {
  let service: ConversationStateServiceModule;
  let settingsStore: SettingsStoreModule;
  let btsClient: BehindTheScenesClientModule;
  let transcriptBuffer = '';
  let activeBotId = 'bot-1';

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

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

    vi.doMock('../../behindTheScenesClient', () => ({
      callBehindTheScenesWithAuth: vi.fn(),
    }));

    vi.doMock('@core/services/promptFileService', () => ({
      getPrompt: vi.fn(() => 'You are a conversation state tracker for a meeting assistant. Output compact JSON only.'),
      PROMPT_IDS: { UTILITY_MEETING_CONVERSATION_STATE: 'utility/meeting-conversation-state' },
    }));

    service = await import('../conversationStateService');
    settingsStore = await import('@core/services/settingsStore');
    btsClient = await import('../../behindTheScenesClient');

    transcriptBuffer = '';
    activeBotId = 'bot-1';

    service.initializeConversationStateService({
      getTranscriptBuffer: (botId: string) => (botId === activeBotId ? transcriptBuffer : null),
      getActiveBotState: () => ({ botId: activeBotId }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes state and cleans up on stop', () => {
    service.startStateTracking('bot-1');

    const initial = service.getConversationState('bot-1');
    expect(initial).not.toBeNull();
    expect(initial?.currentTopic).toBe('');
    expect(initial?.openQuestions).toEqual([]);
    expect(initial?.recentDecisions).toEqual([]);

    const finalState = service.stopStateTracking('bot-1');
    expect(finalState).not.toBeNull();
    expect(service.getConversationState('bot-1')).toBeNull();

    // stopStateTracking on a second instance also cleans up
    service.startStateTracking('bot-1');
    service.stopStateTracking('bot-1');
    expect(service.getConversationState('bot-1')).toBeNull();
  });

  it('coalesces updates while one update is already in-flight', async () => {
    transcriptBuffer = 'We should discuss launch timing.';

    const callBehindTheScenesWithAuth = vi.mocked(btsClient.callBehindTheScenesWithAuth);
    let resolveFirstCall: ((value: ReturnType<typeof makeStateResponse>) => void) | undefined;

    callBehindTheScenesWithAuth
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstCall = resolve as (value: ReturnType<typeof makeStateResponse>) => void;
          }) as Promise<ReturnType<typeof makeStateResponse>>
      )
      .mockResolvedValueOnce(
        makeStateResponse({
          currentTopic: 'Launch timing',
          shortSummary: 'Team is choosing a launch date.',
          openQuestions: ['Can we delay by two weeks?'],
          recentDecisions: ['Need final date by Friday'],
        })
      );

    service.startStateTracking('bot-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(callBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);

    transcriptBuffer = 'We should discuss launch timing. Can we delay by two weeks?';
    service.requestStateUpdate('bot-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(callBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);

    resolveFirstCall?.(
      makeStateResponse({
        currentTopic: 'Launch timeline',
        shortSummary: 'Initial launch timing discussion.',
        openQuestions: ['Do we shift by two weeks?'],
        recentDecisions: [],
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(callBehindTheScenesWithAuth).toHaveBeenCalledTimes(2);
  });

  it('skips LLM updates when transcript hash is unchanged', async () => {
    transcriptBuffer = 'Budget review started.';

    const callBehindTheScenesWithAuth = vi.mocked(btsClient.callBehindTheScenesWithAuth);
    callBehindTheScenesWithAuth.mockResolvedValue(
      makeStateResponse({
        currentTopic: 'Budget review',
        shortSummary: 'The team reviewed budget tradeoffs.',
        openQuestions: ['Do we reallocate hiring budget?'],
        recentDecisions: [],
      })
    );

    service.startStateTracking('bot-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(callBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);

    service.requestStateUpdate('bot-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(callBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
  });

  it('respects kill switch and skips updates when disabled', async () => {
    transcriptBuffer = 'Any transcript text';
    const getSettings = vi.mocked(settingsStore.getSettings);
    getSettings.mockReturnValue({
      meetingBot: {
        enableConversationState: false,
      },
    } as ReturnType<typeof settingsStore.getSettings>);

    const callBehindTheScenesWithAuth = vi.mocked(btsClient.callBehindTheScenesWithAuth);

    service.startStateTracking('bot-1');
    service.requestStateUpdate('bot-1');
    await vi.advanceTimersByTimeAsync(2000);

    expect(callBehindTheScenesWithAuth).not.toHaveBeenCalled();
  });
});
