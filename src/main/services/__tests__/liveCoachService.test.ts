import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LiveCoachModule = typeof import('../liveCoachService');

interface ResolverResult {
  prompt: string;
  contentHash: string;
  source: 'operator-frontmatter' | 'file-body';
  proactiveIntervalMinutes?: number;
}

interface LoadResult {
  service: LiveCoachModule;
  resolveMeetingCoachPrompt: ReturnType<typeof vi.fn>;
  runHeadlessTurn: ReturnType<typeof vi.fn>;
  executeAgentTurn: ReturnType<typeof vi.fn>;
  setLastInjectedCoachPath: ReturnType<typeof vi.fn>;
  loggerInfo: ReturnType<typeof vi.fn>;
  loggerWarn: ReturnType<typeof vi.fn>;
  scheduledCallback: (() => Promise<void>) | null;
}

async function loadLiveCoachServiceForTest(options: {
  settings?: { meetingBot?: { coachProactiveIntervalMinutes?: number; enableQualityGate?: boolean } };
  resolverResults: ResolverResult[];
  statMtimeSequence?: number[];
  statImpl?: ReturnType<typeof vi.fn>;
  readFileImpl?: ReturnType<typeof vi.fn>;
  activeBotState?: {
    botId: string;
    coachSkillPath?: string;
    companionSessionId?: string;
    presenceMode?: 'silent' | 'coach' | 'participant';
    coachPrompt?: string;
    coachContentHash?: string;
    coachPromptSource?: 'operator-frontmatter' | 'file-body';
    coachProactiveIntervalMinutes?: number;
    coachPromptLastModifiedMs?: number;
  };
  getActiveBotState?: () => {
    botId: string;
    coachSkillPath?: string;
    companionSessionId?: string;
    presenceMode?: 'silent' | 'coach' | 'participant';
    coachPrompt?: string;
    coachContentHash?: string;
    coachPromptSource?: 'operator-frontmatter' | 'file-body';
    coachProactiveIntervalMinutes?: number;
    coachPromptLastModifiedMs?: number;
  } | null;
  transcriptSequence: string[];
}): Promise<LoadResult> {
  vi.resetModules();

  const loggerInfo = vi.fn();
  const loggerDebug = vi.fn();
  const loggerWarn = vi.fn();
  const loggerError = vi.fn();
  const requestStateUpdate = vi.fn();
  const dispatchAgentErrorEvent = vi.fn();
  const dispatchAgentEvent = vi.fn();
  const setLastInjectedCoachPath = vi.fn();
  const executeAgentTurn = vi.fn(async () => undefined);
  const runHeadlessTurn = vi.fn(async ({ onEvent, prompt }) => {
    onEvent({ type: 'assistant', text: '[CONTRIBUTE] This is useful.' });
    onEvent({ type: 'result', text: '[CONTRIBUTE] This is useful.', prompt });
  });

  let scheduledCallback: (() => Promise<void>) | null = null;
  const createPausableInterval = vi.fn((callback: () => Promise<void>) => {
    scheduledCallback = callback;
    return vi.fn();
  });

  let resolverIndex = 0;
  const resolveMeetingCoachPrompt = vi.fn(() => {
    const fallback = options.resolverResults[options.resolverResults.length - 1];
    const next = options.resolverResults[resolverIndex] ?? fallback;
    resolverIndex += 1;
    return next;
  });

  let statIndex = 0;
  const statMtimeSequence = options.statMtimeSequence ?? [100];
  const stat = options.statImpl ?? vi.fn(async () => {
    const fallback = statMtimeSequence[statMtimeSequence.length - 1];
    const mtimeMs = statMtimeSequence[statIndex] ?? fallback;
    statIndex += 1;
    return { mtimeMs };
  });

  let transcriptIndex = 0;
  const getTranscriptBuffer = vi.fn(() => {
    const fallback = options.transcriptSequence[options.transcriptSequence.length - 1] ?? '';
    const next = options.transcriptSequence[transcriptIndex] ?? fallback;
    transcriptIndex += 1;
    return next;
  });

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      debug: loggerDebug,
      info: loggerInfo,
      warn: loggerWarn,
      error: loggerError,
    }),
  }));

  vi.doMock('@core/services/settingsStore', () => ({
    getSettings: vi.fn(() => options.settings ?? { meetingBot: { coachProactiveIntervalMinutes: 2 } }),
  }));

  const readFile = options.readFileImpl ?? vi.fn(async () => '');

  vi.doMock('node:fs/promises', () => ({
    default: { stat, readFile },
  }));

  vi.doMock('../meetingCoachPromptResolver', () => ({
    resolveMeetingCoachPrompt,
  }));

  vi.doMock('@core/services/operatorRegistry', () => ({
    listAvailable: vi.fn(async () => []),
    listAvailableWithDiagnostics: vi.fn(async () => ({ operators: [], failures: [] })),
    getById: vi.fn(() => undefined),
    invalidateOperatorRegistry: vi.fn(),
  }));

  vi.doMock('../visibilityAwareScheduler', () => ({
    createPausableInterval,
  }));

  vi.doMock('../agentTurnRegistry', () => ({
    agentTurnRegistry: {
      hasActiveTurnForSession: vi.fn(() => false),
      setRendererSession: vi.fn(),
    },
  }));

  vi.doMock('../agentEventDispatcher', () => ({
    dispatchAgentEvent,
    dispatchAgentErrorEvent,
  }));

  vi.doMock('../meetingBot/conversationStateService', () => ({
    formatMeetingContext: vi.fn(() => ''),
    requestStateUpdate,
  }));

  vi.doMock('../meetingBot/btsResponseUtils', () => ({
    removeCodeFence: (input: string) => input,
    extractTextFromBtsResponse: () => '',
    hashTranscriptTail: (transcript: string) => transcript,
  }));

  vi.doMock('../behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(async () => ({ content: [{ text: '' }] })),
  }));

  vi.doMock('@core/services/meetingVoiceService', () => ({
    getMeetingVoiceInstructions: vi.fn(() => 'voice-instructions'),
  }));

  const service = await import('../liveCoachService');

  service.initializeLiveCoachService({
    executeAgentTurn,
    runHeadlessTurn,
    queueContribution: vi.fn(() => true),
    getTranscriptBuffer,
    getConversationState: vi.fn(() => null),
    getWindow: vi.fn(() => ({}) as never),
    getActiveBotState: vi.fn(() => options.getActiveBotState?.() ?? options.activeBotState ?? null),
    setLastInjectedCoachPath,
    checkStalePending: vi.fn(),
    isKnowledgeAccessEnabled: vi.fn(() => false),
  });

  service.startProactiveTimer();

  return {
    service,
    resolveMeetingCoachPrompt,
    runHeadlessTurn,
    executeAgentTurn,
    setLastInjectedCoachPath,
    loggerInfo,
    loggerWarn,
    scheduledCallback,
  };
}

describe('liveCoachService Stage 8.3 runtime caching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves coach prompt once and reuses cached prompt on later participant ticks', async () => {
    let now = 120_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-1',
      coachSkillPath: '/tmp/coach.md',
      presenceMode: 'participant' as const,
    };

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 1, enableQualityGate: false } },
      resolverResults: [
        { prompt: 'CACHED COACH PROMPT', contentHash: 'hash-a', source: 'operator-frontmatter' },
      ],
      statMtimeSequence: [111, 111, 111],
      activeBotState,
      transcriptSequence: ['transcript-1', 'transcript-2'],
    });

    expect(loaded.scheduledCallback).toBeTypeOf('function');
    await loaded.scheduledCallback?.();

    now += 61_000;
    await loaded.scheduledCallback?.();

    expect(loaded.resolveMeetingCoachPrompt).toHaveBeenCalledTimes(1);
    expect(loaded.runHeadlessTurn).toHaveBeenCalledTimes(2);
    for (const [params] of loaded.runHeadlessTurn.mock.calls) {
      expect((params.prompt as string)).toContain('CACHED COACH PROMPT');
    }
  });

  it('emits content-hash change breadcrumb and forces reinjection when coach prompt changes', async () => {
    let now = 120_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-2',
      coachSkillPath: '/tmp/coach.md',
      companionSessionId: 'session-2',
      presenceMode: 'coach' as const,
    };

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 1 } },
      resolverResults: [
        { prompt: 'Prompt A', contentHash: 'hash-a', source: 'operator-frontmatter' },
        { prompt: 'Prompt B', contentHash: 'hash-b', source: 'operator-frontmatter' },
      ],
      statMtimeSequence: [100, 200],
      activeBotState,
      transcriptSequence: ['transcript-a', 'transcript-b'],
    });

    await loaded.scheduledCallback?.();
    now += 61_000;
    await loaded.scheduledCallback?.();

    expect(loaded.resolveMeetingCoachPrompt).toHaveBeenCalledTimes(2);
    expect(loaded.setLastInjectedCoachPath).toHaveBeenCalledWith('session-2', null);
    expect(loaded.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        previous: 'hash-a',
        current: 'hash-b',
      }),
      'operators:meeting_coach_content_hash_changed',
    );
  });

  it('uses proactiveIntervalMinutes override from resolved coach prompt', async () => {
    let now = 600_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-3',
      coachSkillPath: '/tmp/coach.md',
      companionSessionId: 'session-3',
      presenceMode: 'coach' as const,
    };

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 2 } },
      resolverResults: [
        {
          prompt: 'Prompt with interval override',
          contentHash: 'hash-override',
          source: 'operator-frontmatter',
          proactiveIntervalMinutes: 5,
        },
      ],
      statMtimeSequence: [300, 300, 300],
      activeBotState,
      transcriptSequence: ['transcript-1', 'transcript-2', 'transcript-3'],
    });

    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(1);

    now += 3 * 60 * 1000;
    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 1000 + 1;
    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(2);
  });

  it('aborts prompt refresh when coach changes mid-refresh and does not overwrite new coach state', async () => {
    const now = 120_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-race',
      coachSkillPath: '/tmp/coach-a.md',
      companionSessionId: 'session-race',
      presenceMode: 'coach' as const,
      coachPrompt: 'Prompt for coach B',
      coachContentHash: 'hash-b',
      coachPromptSource: 'operator-frontmatter' as const,
      coachPromptLastModifiedMs: 10,
    };

    const releaseStatRef: { current: ((value: { mtimeMs: number }) => void) | null } = { current: null };
    const statImpl = vi.fn(() => new Promise<{ mtimeMs: number }>((resolve) => {
      releaseStatRef.current = resolve;
    }));

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 1 } },
      resolverResults: [
        { prompt: 'Prompt for coach A', contentHash: 'hash-a', source: 'operator-frontmatter' },
      ],
      statImpl,
      getActiveBotState: () => activeBotState,
      transcriptSequence: ['transcript-1'],
    });

    const proactiveTickPromise = loaded.scheduledCallback?.();
    expect(proactiveTickPromise).toBeDefined();
    expect(statImpl).toHaveBeenCalledTimes(1);

    // Simulate user switching coaches while stat() is still in flight.
    activeBotState.coachSkillPath = '/tmp/coach-b.md';
    releaseStatRef.current?.({ mtimeMs: 50 });
    await proactiveTickPromise;

    expect(loaded.resolveMeetingCoachPrompt).not.toHaveBeenCalled();
    expect(activeBotState.coachPrompt).toBe('Prompt for coach B');
    expect(activeBotState.coachContentHash).toBe('hash-b');
    expect(loaded.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-race',
        reason: 'coach_changed_during_refresh',
        originalCoachSkillPath: '/tmp/coach-a.md',
        currentCoachSkillPath: '/tmp/coach-b.md',
      }),
      'operators:meeting_coach_refresh_aborted',
    );
  });

  it('preserves the cached coach prompt when live_meeting role is removed mid-meeting', async () => {
    let now = 120_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-mid-toggle',
      coachSkillPath: '/tmp/coach/OPERATOR.md',
      companionSessionId: 'session-mid-toggle',
      presenceMode: 'coach' as const,
      coachPrompt: 'Cached coaching prompt',
      coachContentHash: 'cached-hash',
      coachPromptSource: 'operator-frontmatter' as const,
      coachPromptLastModifiedMs: 100,
    };

    const operatorMd = [
      '---',
      'name: Coach',
      'description: Cached coach prompt is in cache.',
      'consult_when: When asked.',
      'kind: operator',
      'roles: [operator]',
      'consultation_prompt: Consult prompt',
      '---',
      'Body',
      '',
    ].join('\n');

    const readFile = vi.fn(async () => operatorMd);

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 1 } },
      resolverResults: [
        { prompt: 'New prompt should not be applied', contentHash: 'wrong-hash', source: 'file-body' },
      ],
      statMtimeSequence: [200],
      readFileImpl: readFile,
      activeBotState,
      transcriptSequence: ['transcript-1'],
    });

    now += 61_000;
    await loaded.scheduledCallback?.();

    expect(loaded.resolveMeetingCoachPrompt).not.toHaveBeenCalled();
    expect(activeBotState.coachPrompt).toBe('Cached coaching prompt');
    expect(activeBotState.coachContentHash).toBe('cached-hash');
    expect(activeBotState.coachPromptLastModifiedMs).toBe(200);
    expect(loaded.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-mid-toggle',
        coachSkillPath: '/tmp/coach/OPERATOR.md',
        cachedContentHash: 'cached-hash',
      }),
      'operators:meeting_coach_role_removed_during_active_meeting',
    );
  });

  it('clamps excessive proactive interval values to 60 minutes and logs the clamp', async () => {
    let now = 3_700_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const activeBotState = {
      botId: 'bot-clamp',
      coachSkillPath: '/tmp/coach.md',
      companionSessionId: 'session-clamp',
      presenceMode: 'coach' as const,
    };

    const loaded = await loadLiveCoachServiceForTest({
      settings: { meetingBot: { coachProactiveIntervalMinutes: 2 } },
      resolverResults: [
        {
          prompt: 'Prompt with excessive interval',
          contentHash: 'hash-excessive',
          source: 'operator-frontmatter',
          proactiveIntervalMinutes: 999999,
        },
      ],
      statMtimeSequence: [300, 300, 300],
      activeBotState,
      transcriptSequence: ['transcript-1', 'transcript-2', 'transcript-3'],
    });

    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(1);

    now += 30 * 60 * 1000;
    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(1);

    now += 30 * 60 * 1000 + 1;
    await loaded.scheduledCallback?.();
    expect(loaded.executeAgentTurn).toHaveBeenCalledTimes(2);

    expect(loaded.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-clamp',
        original: 999999,
        clamped: 60,
      }),
      'operators:proactive_interval_clamped',
    );
  });
});
