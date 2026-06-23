import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type {
  InboundTrigger,
  InboundTriggerAdapter,
  InboundTriggerServiceDeps,
  InboundTriggerSafetyHook,
} from '../inboundTriggers/types';
import type { AppSettings, AgentEvent } from '@shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the service
// ---------------------------------------------------------------------------

// electron-store is already mocked in vitest.setup.ts

// Mock logger
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

// Mock createBatteryThrottledInterval — capture callback so tests can invoke it
let capturedPollingCallbacks: Map<string, () => void | Promise<void>>;
const mockCleanup = vi.fn();
vi.mock('../visibilityAwareScheduler', () => ({
  createBatteryThrottledInterval: vi.fn((callback: () => void | Promise<void>) => {
    // Store callback keyed by a counter so tests can invoke it
    const key = `poll-${capturedPollingCallbacks.size}`;
    capturedPollingCallbacks.set(key, callback);
    return mockCleanup;
  }),
}));

// Mock agentEventDispatcher — re-export sanitize as identity
vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentErrorEvent: vi.fn(),
  dispatchAgentEvent: vi.fn(),
  sanitizeEventForMainAccumulation: vi.fn((event: AgentEvent) => event),
}));

// Mock conversationState
vi.mock('@shared/utils/conversationState', () => ({
  updateConversationWithEvent: vi.fn(
    (state: Record<string, unknown>, _turnId: string, _event: AgentEvent) => state
  ),
}));

// ---------------------------------------------------------------------------
// Import the service under test after mocks
// ---------------------------------------------------------------------------

let InboundTriggerService: typeof import('../inboundTriggers/inboundTriggerService').InboundTriggerService;

beforeAll(async () => {
  const module = await import('../inboundTriggers/inboundTriggerService');
  InboundTriggerService = module.InboundTriggerService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock adapter */
const createMockAdapter = (
  id = 'test-adapter',
  overrides: Partial<InboundTriggerAdapter> = {}
): InboundTriggerAdapter => ({
  id,
  displayName: `Test Adapter (${id})`,
  isConfigured: vi.fn().mockResolvedValue(true),
  poll: vi.fn().mockResolvedValue(null),
  getSourceIds: vi.fn().mockResolvedValue(['source-1']),
  getDefaultIntervalMs: vi.fn().mockReturnValue(60_000),
  buildPrompt: vi.fn().mockReturnValue('Test prompt'),
  buildDisplayMessage: vi.fn().mockReturnValue('Test display message'),
  postAcknowledgment: vi.fn().mockResolvedValue(undefined),
  checkPrerequisites: vi.fn().mockResolvedValue({ ready: true, reason: null }),
  createSafetyHook: vi.fn().mockReturnValue(null),
  ...overrides,
});

/** Create mock deps */
const createMockDeps = (
  overrides: Partial<InboundTriggerServiceDeps> = {}
): InboundTriggerServiceDeps => ({
  executeAgentTurn: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockReturnValue({} as AppSettings),
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
  broadcastToRenderer: vi.fn(),
  ...overrides,
});

/** Create a sample trigger */
const createTrigger = (overrides: Partial<InboundTrigger> = {}): InboundTrigger => ({
  adapterId: 'test-adapter',
  sourceId: 'source-1',
  timestamp: '1700000000.000000',
  summary: 'Test mention',
  messageId: 'msg-1',
  context: { channel: 'C123' },
  ...overrides,
});

/** Get the most recently captured polling callback */
const getLastCapturedCallback = (): (() => void | Promise<void>) => {
  const entries = [...capturedPollingCallbacks.entries()];
  return entries[entries.length - 1][1];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboundTriggerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPollingCallbacks = new Map();
  });

  // -----------------------------------------------------------------------
  // 1. Adapter Registration
  // -----------------------------------------------------------------------

  describe('Adapter Registration', () => {
    it('creates state entry for new adapter', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();

      service.registerAdapter(adapter);

      const state = service.getAdapterState('test-adapter');
      expect(state).not.toBeNull();
      expect(state!.enabled).toBe(false);
      expect(state!.pollCount).toBe(0);
      expect(state!.triggerCount).toBe(0);
      expect(state!.lastPollAt).toBeNull();
      expect(state!.lastError).toBeNull();
    });

    it('replaces existing adapter with warning', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter1 = createMockAdapter();
      const adapter2 = createMockAdapter();

      service.registerAdapter(adapter1);
      service.registerAdapter(adapter2);

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'test-adapter' }),
        'Adapter already registered, replacing'
      );
    });

    it('persists state after registration', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();

      service.registerAdapter(adapter);

      // State should be in the store — verify by checking adapter exists in full state
      const fullState = service.getState();
      expect(fullState.adapters['test-adapter']).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Lifecycle (initialize / dispose)
  // -----------------------------------------------------------------------

  describe('Lifecycle', () => {
    it('initialize() starts polling for enabled adapters only', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      const enabledAdapter = createMockAdapter('enabled-adapter');
      const disabledAdapter = createMockAdapter('disabled-adapter');

      service.registerAdapter(enabledAdapter);
      service.registerAdapter(disabledAdapter);

      // Enable one adapter
      service.setAdapterEnabled('enabled-adapter', true);
      capturedPollingCallbacks.clear();

      service.initialize();

      // Only the enabled adapter should have started polling
      // createBatteryThrottledInterval should have been called once (for enabled-adapter)
      expect(capturedPollingCallbacks.size).toBe(1);
    });

    it('dispose() stops all polling and persists state', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();

      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      service.dispose();

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('dispose() is idempotent', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      service.dispose();
      service.dispose(); // second call should be a no-op

      // Should only log disposal once — log.info is called with a single string arg
      const disposeCalls = mockLoggerMethods.info.mock.calls.filter(
        (args: unknown[]) => args[0] === 'Disposing inbound trigger service'
      );
      expect(disposeCalls).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 3. setAdapterEnabled
  // -----------------------------------------------------------------------

  describe('setAdapterEnabled', () => {
    it('enabling starts polling', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();
      service.registerAdapter(adapter);

      capturedPollingCallbacks.clear();
      service.setAdapterEnabled('test-adapter', true);

      expect(capturedPollingCallbacks.size).toBe(1);
      const state = service.getAdapterState('test-adapter');
      expect(state!.enabled).toBe(true);
    });

    it('disabling stops polling', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      mockCleanup.mockClear();
      service.setAdapterEnabled('test-adapter', false);

      expect(mockCleanup).toHaveBeenCalled();
      const state = service.getAdapterState('test-adapter');
      expect(state!.enabled).toBe(false);
    });

    it('no-op if state has not changed', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();
      service.registerAdapter(adapter);

      // Adapter starts disabled
      capturedPollingCallbacks.clear();
      service.setAdapterEnabled('test-adapter', false);

      // Should not have started polling
      expect(capturedPollingCallbacks.size).toBe(0);
    });

    it('handles unknown adapter ID gracefully', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      // Should not throw
      service.setAdapterEnabled('nonexistent', true);

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'nonexistent' }),
        'Cannot set enabled — adapter state not found'
      );
    });
  });

  // -----------------------------------------------------------------------
  // 4. State Access
  // -----------------------------------------------------------------------

  describe('State Access', () => {
    it('getState() returns current state', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      const state = service.getState();
      expect(state).toBeDefined();
      expect(state.version).toBe(1);
      expect(state.adapters).toBeDefined();
    });

    it('getAdapterState() returns null for unknown adapter', () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      const state = service.getAdapterState('unknown');
      expect(state).toBeNull();
    });

    it('checkPrerequisites() delegates to adapter', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        checkPrerequisites: vi.fn().mockResolvedValue({ ready: false, reason: 'Missing token' }),
      });
      service.registerAdapter(adapter);

      const result = await service.checkPrerequisites('test-adapter');
      expect(result).toEqual({ ready: false, reason: 'Missing token' });
      expect(adapter.checkPrerequisites).toHaveBeenCalled();
    });

    it('checkPrerequisites() returns not ready for unregistered adapter', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      const result = await service.checkPrerequisites('unknown');
      expect(result).toEqual({ ready: false, reason: 'Adapter not registered.' });
    });
  });

  // -----------------------------------------------------------------------
  // 5. Polling Logic (pollAdapter)
  // -----------------------------------------------------------------------

  describe('Polling Logic', () => {
    it('skips if disposed', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      service.dispose();

      await pollCallback();

      expect(adapter.isConfigured).not.toHaveBeenCalled();
    });

    it('skips if previous poll still in progress (concurrency guard)', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      // Create adapter whose poll takes a long time
      let resolvePoll: () => void;
      const slowPollPromise = new Promise<null>((resolve) => {
        resolvePoll = () => resolve(null);
      });
      const adapter = createMockAdapter('test-adapter', {
        isConfigured: vi.fn().mockResolvedValue(true),
        getSourceIds: vi.fn().mockResolvedValue(['source-1']),
        poll: vi.fn().mockReturnValue(slowPollPromise),
      });

      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();

      // Start first poll (will hang on adapter.poll)
      const firstPoll = pollCallback();

      // Start second poll immediately — should be skipped
      await pollCallback();

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'test-adapter' }),
        'Poll skipped — previous poll still in progress'
      );

      // Cleanup
      resolvePoll!();
      await firstPoll;
    });

    it('skips if adapter not configured', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        isConfigured: vi.fn().mockResolvedValue(false),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'test-adapter' }),
        'Poll skipped — adapter not configured'
      );
    });

    it('skips if no sources', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        getSourceIds: vi.fn().mockResolvedValue([]),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'test-adapter' }),
        'Poll skipped — no sources to poll'
      );
    });

    it('round-robins across sources', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        getSourceIds: vi.fn().mockResolvedValue(['src-A', 'src-B', 'src-C']),
        poll: vi.fn().mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();

      // First poll: should start from source src-A (index 0)
      await pollCallback();

      // All sources polled in order since none returned a trigger
      expect(adapter.poll).toHaveBeenCalledTimes(3);
      const firstCallSourceId = (adapter.poll as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstCallSourceId).toBe('src-A');
    });

    it('skips source with active inbound turn', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      // Adapter that returns trigger on first poll from source-1
      let pollCallCount = 0;
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        getSourceIds: vi.fn().mockResolvedValue(['source-1']),
        poll: vi.fn().mockImplementation(() => {
          pollCallCount++;
          if (pollCallCount === 1) return Promise.resolve(trigger);
          return Promise.resolve(null);
        }),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();

      // First poll: finds trigger, starts processing (which sets activeTurnsBySource)
      // Make executeAgentTurn hang so the turn stays "active"
      let resolveAgentTurn: () => void;
      const agentTurnPromise = new Promise<void>((resolve) => {
        resolveAgentTurn = () => resolve();
      });
      (deps.executeAgentTurn as ReturnType<typeof vi.fn>).mockReturnValue(agentTurnPromise);

      await pollCallback();
      // Wait a tick to let processTrigger reach the point of setting activeTurnsBySource
      await new Promise((r) => setTimeout(r, 10));

      // Second poll: source-1 should be skipped because active turn is running
      await pollCallback();

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'test-adapter', sourceId: 'source-1' }),
        'Source skipped — active inbound turn running'
      );

      // Cleanup
      resolveAgentTurn!();
      await agentTurnPromise;
    });

    it('sets first-enable lookback timestamp', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      const before = Date.now();
      await pollCallback();

      // The adapter.poll should have been called with a lookback timestamp
      const pollCall = (adapter.poll as ReturnType<typeof vi.fn>).mock.calls[0];
      const lastSeenTs = pollCall[1];
      expect(lastSeenTs).not.toBeNull();

      // The lookback should be approximately 5 minutes ago
      const lookbackValue = Number(lastSeenTs);
      // 5 minutes = 300_000 ms
      expect(lookbackValue).toBeGreaterThan(before - 310_000);
      expect(lookbackValue).toBeLessThanOrEqual(before);
    });

    it('processes one trigger per cycle (oldest-first)', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);

      const trigger = createTrigger();
      let _sourceCallCount = 0;
      const adapter = createMockAdapter('test-adapter', {
        getSourceIds: vi.fn().mockResolvedValue(['src-A', 'src-B']),
        poll: vi.fn().mockImplementation((sourceId: string) => {
          _sourceCallCount++;
          if (sourceId === 'src-A') return Promise.resolve(trigger);
          return Promise.resolve(createTrigger({ sourceId: 'src-B', messageId: 'msg-2' }));
        }),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      // Only src-A should have been polled (trigger found → stop)
      expect(deps.createSession).toHaveBeenCalledTimes(1);
    });

    it('updates pollCount and lastPollAt on each cycle', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter();
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      const state = service.getAdapterState('test-adapter');
      expect(state!.pollCount).toBe(1);
      expect(state!.lastPollAt).not.toBeNull();
    });

    it('clears lastError on successful poll', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        isConfigured: vi.fn()
          .mockRejectedValueOnce(new Error('network error'))
          .mockResolvedValue(true),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();

      // First poll: error
      await pollCallback();
      let state = service.getAdapterState('test-adapter');
      expect(state!.lastError).toBe('network error');

      // Second poll: success
      await pollCallback();
      state = service.getAdapterState('test-adapter');
      expect(state!.lastError).toBeNull();
    });

    it('records error in state on poll failure', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const adapter = createMockAdapter('test-adapter', {
        isConfigured: vi.fn().mockRejectedValue(new Error('API down')),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      const state = service.getAdapterState('test-adapter');
      expect(state!.lastError).toBe('API down');
      expect(state!.lastErrorAt).not.toBeNull();
    });

    it('adds processed message IDs for dedup', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger({ messageId: 'unique-msg-42' });
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      // Wait for processTrigger background work
      await new Promise((r) => setTimeout(r, 50));

      const state = service.getAdapterState('test-adapter');
      const sourceState = state!.sources['source-1'];
      expect(sourceState.lastProcessedIds).toContain('unique-msg-42');
    });
  });

  // -----------------------------------------------------------------------
  // 6. Trigger Processing (processTrigger)
  // -----------------------------------------------------------------------

  describe('Trigger Processing', () => {
    it('posts acknowledgment (best-effort, does not block on failure)', async () => {
      const postAck = vi.fn().mockRejectedValue(new Error('ack failed'));
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
        postAcknowledgment: postAck,
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      // Wait for background processing
      await new Promise((r) => setTimeout(r, 50));

      // Ack was attempted
      expect(postAck).toHaveBeenCalledWith(trigger);
      // Agent turn still proceeded despite ack failure
      expect(deps.executeAgentTurn).toHaveBeenCalled();
    });

    it('creates session with correct origin', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          title: trigger.summary,
          origin: 'inbound-trigger',
        })
      );
    });

    it('broadcasts session to renderer', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.broadcastToRenderer).toHaveBeenCalledWith(
        'inbound-triggers:session-created',
        expect.objectContaining({
          origin: 'inbound-trigger',
          isBusy: true,
        })
      );
    });

    it('executes agent turn with correct params', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
        buildPrompt: vi.fn().mockReturnValue('Agent prompt for mention'),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      expect(deps.executeAgentTurn).toHaveBeenCalledWith(
        expect.any(String), // turnId
        'Agent prompt for mention',
        expect.objectContaining({
          sessionId: expect.stringContaining('inbound-test-adapter--'),
          onEvent: expect.any(Function),
        })
      );
    });

    it('advances lastSeenTs on success', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger({ timestamp: '1700000099.000000' });
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      const state = service.getAdapterState('test-adapter');
      expect(state!.sources['source-1'].lastSeenTs).toBe('1700000099.000000');
    });

    it('does NOT advance lastSeenTs on failure', async () => {
      const deps = createMockDeps({
        executeAgentTurn: vi.fn().mockRejectedValue(new Error('turn failed')),
      });
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger({ timestamp: '1700000099.000000' });
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      const state = service.getAdapterState('test-adapter');
      // lastSeenTs should still be the lookback value, not the trigger's timestamp
      expect(state!.sources['source-1'].lastSeenTs).not.toBe('1700000099.000000');
    });

    it('cleans up activeTurnsBySource on completion', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      let pollCallCount = 0;
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockImplementation(() => {
          pollCallCount++;
          if (pollCallCount === 1) return Promise.resolve(trigger);
          return Promise.resolve(null);
        }),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();

      // First poll: find trigger
      await pollCallback();
      await new Promise((r) => setTimeout(r, 50));

      // Second poll: source should NOT be skipped since turn completed
      mockLoggerMethods.debug.mockClear();
      await pollCallback();

      const skipCalls = mockLoggerMethods.debug.mock.calls.filter(
        (call) => call[1] === 'Source skipped — active inbound turn running'
      );
      expect(skipCalls).toHaveLength(0);
    });

    it('persists state after completion', async () => {
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      // Verify state was persisted (triggerCount increased)
      const state = service.getAdapterState('test-adapter');
      expect(state!.triggerCount).toBe(1);
    });

    it('creates safety hook from adapter', async () => {
      const mockHook: InboundTriggerSafetyHook = vi.fn().mockResolvedValue({});
      const deps = createMockDeps();
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
        createSafetyHook: vi.fn().mockReturnValue(mockHook),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      expect(adapter.createSafetyHook).toHaveBeenCalledWith(trigger, expect.anything());
      expect(deps.executeAgentTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          inboundSafetyHook: mockHook,
        })
      );
    });

    it('skips trigger processing if createSession fails', async () => {
      const deps = createMockDeps({
        createSession: vi.fn().mockRejectedValue(new Error('store failed')),
      });
      const service = new InboundTriggerService(deps);
      const trigger = createTrigger();
      const adapter = createMockAdapter('test-adapter', {
        poll: vi.fn().mockResolvedValueOnce(trigger).mockResolvedValue(null),
      });
      service.registerAdapter(adapter);
      service.setAdapterEnabled('test-adapter', true);

      const pollCallback = getLastCapturedCallback();
      await pollCallback();

      await new Promise((r) => setTimeout(r, 50));

      // executeAgentTurn should NOT have been called since session creation failed
      expect(deps.executeAgentTurn).not.toHaveBeenCalled();
    });
  });
});
