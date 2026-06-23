type BotQAModule = typeof import('../botQAService');
type LiveCoachModule = typeof import('../../liveCoachService');

async function loadBotQAModule(): Promise<BotQAModule> {
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

  vi.doMock('../botVoiceService', () => ({
    speakInMeeting: vi.fn(async () => true),
    setAvatarState: vi.fn(),
    stopSpeaking: vi.fn(),
  }));

  vi.doMock('../../authService', () => ({
    getAuthState: vi.fn(() => ({ user: { id: 'user-1' } })),
  }));

  vi.doMock('../../behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(),
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

  vi.doMock('../meetingBotService', () => ({
    getActiveBotState: vi.fn(() => null),
  }));

  vi.doMock('../conversationStateService', () => ({
    formatMeetingContext: vi.fn(() => ''),
  }));

  return import('../botQAService');
}

async function loadLiveCoachModule(
  settings: { meetingBot?: { enableEventDrivenTriggers?: boolean } } = { meetingBot: {} },
): Promise<{
  service: LiveCoachModule;
  requestStateUpdate: ReturnType<typeof vi.fn>;
  dispatchAgentErrorEvent: ReturnType<typeof vi.fn>;
}> {
  const requestStateUpdate = vi.fn();
  const dispatchAgentErrorEvent = vi.fn();

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
    getSettings: vi.fn(() => settings),
  }));

  vi.doMock('../../agentTurnRegistry', () => ({
    agentTurnRegistry: {
      hasActiveTurnForSession: vi.fn(() => false),
      setRendererSession: vi.fn(),
    },
  }));

  vi.doMock('../../agentEventDispatcher', () => ({
    dispatchAgentEvent: vi.fn(),
    dispatchAgentErrorEvent,
  }));

  vi.doMock('../conversationStateService', () => ({
    formatMeetingContext: vi.fn(() => ''),
    requestStateUpdate,
  }));

  const service = await import('../../liveCoachService');
  return { service, requestStateUpdate, dispatchAgentErrorEvent };
}

describe('classifyHighSignalUtterance', () => {
  let botQA: BotQAModule;

  beforeEach(async () => {
    vi.resetModules();
    botQA = await loadBotQAModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies high-signal utterances and ignores non-triggers', () => {
    expect(botQA.classifyHighSignalUtterance('What do you think about the timeline?')).toEqual({ type: 'question' });
    expect(botQA.classifyHighSignalUtterance("Let's go with option B")).toEqual({ type: 'decision' });
    expect(botQA.classifyHighSignalUtterance('I disagree with that approach')).toEqual({ type: 'tension' });

    expect(botQA.classifyHighSignalUtterance('Sounds good')).toBeNull();
    expect(botQA.classifyHighSignalUtterance('Thanks for that')).toBeNull();
    expect(botQA.classifyHighSignalUtterance('Yes')).toBeNull();
    expect(botQA.classifyHighSignalUtterance('Why?')).toBeNull();
    expect(botQA.classifyHighSignalUtterance('Should we go with plan A?')).toEqual({ type: 'question' });
    expect(botQA.classifyHighSignalUtterance('The timeline works?')).toBeNull();
  });
});

describe('event-driven trigger wiring', () => {
  let botQA: BotQAModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    botQA = await loadBotQAModule();
  });

  afterEach(async () => {
    await botQA.stopAllBotQA();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires for identified non-owner speech and excludes owner/unknown speakers', async () => {
    const onHighSignalUtterance = vi.fn();
    botQA.initializeBotQAService({
      runHeadlessTurn: vi.fn(async () => undefined),
      getConversationState: vi.fn(() => null),
      onHighSignalUtterance,
    });

    botQA.startBotQA('bot-1', 'Alice Example');

    botQA.processTranscriptSegment('bot-1', 'Bob', 'I disagree with that approach');
    expect(onHighSignalUtterance).toHaveBeenCalledWith('bot-1', 'tension', 'I disagree with that approach');

    onHighSignalUtterance.mockClear();
    botQA.processTranscriptSegment('bot-1', 'Alice', 'I disagree with that approach');
    botQA.processTranscriptSegment('bot-1', 'Unknown', 'I disagree with that approach');
    expect(onHighSignalUtterance).not.toHaveBeenCalled();
  });
});

describe('handleHighSignalUtterance debounce', () => {
  let liveCoach: LiveCoachModule;
  let requestStateUpdate: ReturnType<typeof vi.fn>;
  let dispatchAgentErrorEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    ({ service: liveCoach, requestStateUpdate, dispatchAgentErrorEvent } = await loadLiveCoachModule());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debounces repeated event triggers by trigger type window', async () => {
    const executeAgentTurn = vi.fn(async () => undefined);

    liveCoach.initializeLiveCoachService({
      executeAgentTurn,
      runHeadlessTurn: vi.fn(async () => undefined),
      queueContribution: vi.fn(() => true),
      getTranscriptBuffer: vi.fn(() => null),
      getConversationState: vi.fn(() => null),
      getWindow: vi.fn(() => ({}) as never),
      getActiveBotState: vi.fn(() => ({
        botId: 'bot-1',
        coachSkillPath: '/tmp/coach.md',
        companionSessionId: 'session-1',
        presenceMode: 'coach' as const,
      })),
    });

    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    liveCoach.handleHighSignalUtterance('bot-1', 'question', 'What do you think about this timeline?');
    await Promise.resolve();
    await Promise.resolve();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(requestStateUpdate).toHaveBeenCalledTimes(1);

    now += 10_000; // within 45s debounce
    liveCoach.handleHighSignalUtterance('bot-1', 'question', 'What do you think about this timeline?');
    await Promise.resolve();
    await Promise.resolve();
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);

    now += 46_000; // beyond 45s debounce
    liveCoach.handleHighSignalUtterance('bot-1', 'question', 'What do you think about this timeline?');
    await Promise.resolve();
    await Promise.resolve();
    expect(executeAgentTurn).toHaveBeenCalledTimes(2);
    expect(requestStateUpdate).toHaveBeenCalledTimes(2);
  });

  it('respects kill switch and skips event-driven triggers when disabled', async () => {
    vi.resetModules();
    const loaded = await loadLiveCoachModule({
      meetingBot: { enableEventDrivenTriggers: false },
    });
    liveCoach = loaded.service;
    requestStateUpdate = loaded.requestStateUpdate;

    const executeAgentTurn = vi.fn(async () => undefined);
    liveCoach.initializeLiveCoachService({
      executeAgentTurn,
      runHeadlessTurn: vi.fn(async () => undefined),
      queueContribution: vi.fn(() => true),
      getTranscriptBuffer: vi.fn(() => null),
      getConversationState: vi.fn(() => null),
      getWindow: vi.fn(() => ({}) as never),
      getActiveBotState: vi.fn(() => ({
        botId: 'bot-1',
        coachSkillPath: '/tmp/coach.md',
        companionSessionId: 'session-1',
        presenceMode: 'coach' as const,
      })),
    });

    liveCoach.handleHighSignalUtterance('bot-1', 'question', 'What do you think about this timeline?');
    await Promise.resolve();
    await Promise.resolve();

    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(requestStateUpdate).not.toHaveBeenCalled();
  });

  it('routes proactive tip failures through dispatchAgentErrorEvent', async () => {
    const executeAgentTurn = vi.fn(async () => {
      throw new Error('This request requires more credits, or fewer max_tokens.');
    });

    liveCoach.initializeLiveCoachService({
      executeAgentTurn,
      runHeadlessTurn: vi.fn(async () => undefined),
      queueContribution: vi.fn(() => true),
      getTranscriptBuffer: vi.fn(() => null),
      getConversationState: vi.fn(() => null),
      getWindow: vi.fn(() => ({}) as never),
      getActiveBotState: vi.fn(() => ({
        botId: 'bot-1',
        coachSkillPath: '/tmp/coach.md',
        companionSessionId: 'session-1',
        presenceMode: 'coach' as const,
      })),
    });

    liveCoach.handleHighSignalUtterance('bot-1', 'question', 'What do you think about this timeline?');
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchAgentErrorEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(Error),
    );
  });
});
