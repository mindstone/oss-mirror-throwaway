import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { SlackThreadContext } from '@core/services/externalConversation/externalContext';
import type {
  InboundTrigger,
  InboundTriggerAdapter,
  InboundTriggerAdapterState,
  InboundTriggerServiceDeps,
  InboundTriggerSourceState,
} from '../types';

const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLoggerMethods,
  logger: mockLoggerMethods,
}));

vi.mock('../../visibilityAwareScheduler', () => ({
  createBatteryThrottledInterval: vi.fn(() => vi.fn()),
}));

vi.mock('../../agentEventDispatcher', () => ({
  sanitizeEventForMainAccumulation: vi.fn((event) => event),
}));

vi.mock('@shared/utils/conversationState', () => ({
  updateConversationWithEvent: vi.fn((state) => state),
}));

let InboundTriggerService: typeof import('../inboundTriggerService').InboundTriggerService;

beforeAll(async () => {
  ({ InboundTriggerService } = await import('../inboundTriggerService'));
});

const slackContext: SlackThreadContext = {
  kind: 'slack-thread',
  identity: { teamId: 'T1', channelId: 'C1', threadTs: '1710000000.000001' },
  metadata: {
    userId: 'U1',
    userName: 'alice',
    userDisplayName: 'Alice',
    channelName: 'general',
    teamName: 'Acme',
    permalink: 'https://example.slack.com/archives/C1/p1710000000000001',
  },
};

function createTrigger(overrides: Partial<InboundTrigger> = {}): InboundTrigger {
  return {
    adapterId: 'slack-mention',
    sourceId: 'T1',
    timestamp: '1710000000.000002',
    summary: 'Slack mention',
    messageId: 'T1:C1:1710000000.000002',
    context: {
      text: 'hello from Slack',
      channelId: 'C1',
      channelName: 'general',
    },
    externalContext: slackContext,
    ...overrides,
  };
}

function createAdapter(overrides: Partial<InboundTriggerAdapter> = {}): InboundTriggerAdapter {
  return {
    id: 'slack-mention',
    displayName: 'Slack @-mentions',
    isConfigured: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue(null),
    getSourceIds: vi.fn().mockResolvedValue(['T1']),
    getDefaultIntervalMs: vi.fn().mockReturnValue(60_000),
    buildPrompt: vi.fn().mockReturnValue('formatted prompt'),
    buildDisplayMessage: vi.fn().mockReturnValue('display message'),
    postAcknowledgment: vi.fn().mockResolvedValue(undefined),
    checkPrerequisites: vi.fn().mockResolvedValue({ ready: true, reason: null }),
    releaseDuplicateGuard: vi.fn(),
    ...overrides,
  };
}

function createAdapterState(): InboundTriggerAdapterState {
  return {
    enabled: true,
    lastPollAt: null,
    lastErrorAt: null,
    lastError: null,
    pollCount: 0,
    triggerCount: 0,
    sources: {},
  };
}

function createSourceState(): InboundTriggerSourceState {
  return { lastSeenTs: '1710000000.000001', lastProcessedIds: [] };
}

function createDeps(overrides: Partial<InboundTriggerServiceDeps> = {}): InboundTriggerServiceDeps {
  return {
    executeAgentTurn: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockReturnValue({
      experimental: { slackDesktopThreadContinuity: true },
    } as AppSettings),
    createSession: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    broadcastToRenderer: vi.fn(),
    externalConversationService: {
      injectMessage: vi.fn().mockResolvedValue({ conversationId: 'conversation-1', messageId: 'message-1', state: 'submitted', queueSize: 0 }),
      createConversation: vi.fn().mockResolvedValue({ conversationId: 'conversation-2', isNewConversation: true, state: 'new' }),
    },
    conversationScopeResolver: {
      lookup: vi.fn().mockReturnValue(null),
      getBinding: vi.fn(),
    },
    ...overrides,
  };
}

async function process(
  service: InstanceType<typeof InboundTriggerService>,
  deps: InboundTriggerServiceDeps,
  trigger: InboundTrigger,
  adapter: InboundTriggerAdapter = createAdapter(),
  sourceState: InboundTriggerSourceState = createSourceState(),
): Promise<{ adapterState: InboundTriggerAdapterState; sourceState: InboundTriggerSourceState }> {
  const adapterState = createAdapterState();
  await (service as unknown as {
    processTrigger: (
      adapter: InboundTriggerAdapter,
      adapterState: InboundTriggerAdapterState,
      sourceState: InboundTriggerSourceState,
      sourceKey: string,
      trigger: InboundTrigger
    ) => Promise<void>;
  }).processTrigger(adapter, adapterState, sourceState, 'slack-mention:T1', trigger);
  expect(deps).toBeDefined();
  return { adapterState, sourceState };
}

describe('InboundTriggerService external context routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes externalContext with existing binding via injectMessage', async () => {
    const deps = createDeps({
      conversationScopeResolver: {
        lookup: vi.fn().mockReturnValue({ conversationId: 'conversation-existing' }),
        getBinding: vi.fn(),
      },
    });
    const service = new InboundTriggerService(deps);

    const { sourceState } = await process(service, deps, createTrigger());

    expect(deps.externalConversationService?.injectMessage).toHaveBeenCalledWith({
      conversationId: 'conversation-existing',
      context: slackContext,
      text: 'formatted prompt',
    });
    expect(deps.externalConversationService?.createConversation).not.toHaveBeenCalled();
    expect(sourceState.lastSeenTs).toBe('1710000000.000002');
    expect(mockLoggerMethods.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'existing' }),
      'slack_desktop_thread_binding_probe',
    );
  });

  it('creates canonical slack-thread conversation when no binding and flag is enabled', async () => {
    const deps = createDeps();
    const service = new InboundTriggerService(deps);

    await process(service, deps, createTrigger());

    expect(deps.externalConversationService?.createConversation).toHaveBeenCalledWith(slackContext, {
      userText: 'hello from Slack',
      switchToConversation: false,
    });
    expect(deps.externalConversationService?.injectMessage).not.toHaveBeenCalled();
    expect(mockLoggerMethods.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'created-new' }),
      'slack_desktop_thread_binding_probe',
    );
  });

  it('F5 routes a second mention through injectMessage after the first canonical create binds the thread', async () => {
    const lookup = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ conversationId: 'conversation-created' });
    const deps = createDeps({
      conversationScopeResolver: { lookup, getBinding: vi.fn() },
    });
    const service = new InboundTriggerService(deps);

    await process(service, deps, createTrigger({ timestamp: '1710000000.000002', messageId: 'first' }));
    await process(service, deps, createTrigger({ timestamp: '1710000000.000003', messageId: 'second' }));

    expect(deps.externalConversationService?.createConversation).toHaveBeenCalledTimes(1);
    expect(deps.externalConversationService?.injectMessage).toHaveBeenCalledWith({
      conversationId: 'conversation-created',
      context: slackContext,
      text: 'formatted prompt',
    });
  });

  it('F23 advances lastSeenTs after injectMessage succeeds', async () => {
    const deps = createDeps({
      conversationScopeResolver: {
        lookup: vi.fn().mockReturnValue({ conversationId: 'conversation-existing' }),
        getBinding: vi.fn(),
      },
    });
    const service = new InboundTriggerService(deps);
    const sourceState = createSourceState();

    await process(service, deps, createTrigger({ timestamp: '1710000000.000004' }), createAdapter(), sourceState);

    expect(sourceState.lastSeenTs).toBe('1710000000.000004');
  });

  it('F23 leaves lastSeenTs unchanged and releases duplicate guard when injectMessage fails', async () => {
    const deps = createDeps({
      externalConversationService: {
        injectMessage: vi.fn().mockRejectedValue(new Error('inject failed')),
        createConversation: vi.fn(),
      },
      conversationScopeResolver: {
        lookup: vi.fn().mockReturnValue({ conversationId: 'conversation-existing' }),
        getBinding: vi.fn(),
      },
    });
    const adapter = createAdapter();
    const sourceState = createSourceState();
    const service = new InboundTriggerService(deps);

    await process(service, deps, createTrigger({ timestamp: '1710000000.000004' }), adapter, sourceState);

    expect(sourceState.lastSeenTs).toBe('1710000000.000001');
    expect(adapter.releaseDuplicateGuard).toHaveBeenCalled();
  });

  it('logs legacy session observations for existing inbound-slack-mention bindings', async () => {
    const deps = createDeps({
      conversationScopeResolver: {
        lookup: vi.fn().mockReturnValue({ conversationId: 'inbound-slack-mention--legacy' }),
        getBinding: vi.fn(),
      },
    });
    const service = new InboundTriggerService(deps);

    await process(service, deps, createTrigger());

    expect(mockLoggerMethods.info).toHaveBeenCalledWith(
      { sessionId: 'inbound-slack-mention--legacy', teamIdHash: expect.any(String) },
      'slack_polling_legacy_session_observed',
    );
  });

  it('falls back to legacy mint path when no binding and flag is disabled', async () => {
    const deps = createDeps({
      getSettings: vi.fn().mockReturnValue({
        experimental: { slackDesktopThreadContinuity: false },
      } as AppSettings),
    });
    const service = new InboundTriggerService(deps);

    await process(service, deps, createTrigger());

    expect(deps.externalConversationService?.createConversation).not.toHaveBeenCalled();
    expect(deps.externalConversationService?.injectMessage).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringContaining('inbound-slack-mention--'),
    }));
    expect(mockLoggerMethods.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fallback-legacy' }),
      'slack_desktop_thread_binding_probe',
    );
  });

  it('uses legacy mint path unchanged when externalContext is absent', async () => {
    const deps = createDeps();
    const service = new InboundTriggerService(deps);
    const trigger = createTrigger({ externalContext: undefined });

    await process(service, deps, trigger);

    expect(deps.conversationScopeResolver?.lookup).not.toHaveBeenCalled();
    expect(deps.externalConversationService?.createConversation).not.toHaveBeenCalled();
    expect(deps.externalConversationService?.injectMessage).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringContaining('inbound-slack-mention--'),
    }));
  });
});
