import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSessionStore,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  clearCurrentSessionEvents,
  hasCurrentSessionEvents,
  flushPendingEventsVersionNotification,
} from '../../store/sessionStore';
import type { AgentEvent } from '@shared/types';

/**
 * Regression tests for eventsByTurn persistence subscription.
 *
 * Bug: Agent turns would complete successfully but fail to persist to disk.
 * Root cause: Persistence subscription only watched `messages.length`, but agent
 * work (tool calls, results) goes into eventsByTurn which wasn't being watched.
 *
 * Fix: Events now live in an external Map (outside Zustand) with a version counter.
 * Persistence subscribes to `state.eventsByTurnVersion` changes.
 * See docs/plans/finished/260128_Session_Persistence_Gap_Investigation.md
 *
 * Stage 5 (260508 active-work rebuild): bumpVersion now schedules a single
 * microtask-coalesced Zustand notification per tick rather than firing one per
 * event. Tests that need to observe `state.eventsByTurnVersion` synchronously
 * after calling `processEvent` (or any helper that bumps the counter) must
 * call `flushPendingEventsVersionNotification()` to drain the pending
 * notification — production code wires the same flush at boundary points
 * (terminal turn events, queue drain, session switch, persistence read,
 * beforeunload).
 */
// Mock window.sessionsApi for store actions that persist to disk
vi.stubGlobal('window', {
  sessionsApi: { upsert: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
});

describe('eventsByTurn persistence', () => {
  beforeEach(() => {
    clearCurrentSessionEvents();
  });

  describe('eventsByTurnVersion changes on processEvent', () => {
    it('increments eventsByTurnVersion when processEvent is called', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test message');
      const afterMessage = store.getState();

      const turnId = 'test-turn-123';
      store.getState().assignTurnToMessage(afterMessage.messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      const versionBefore = store.getState().eventsByTurnVersion;

      store.getState().processEvent(turnId, {
        type: 'status',
        message: 'Starting agent turn...',
        timestamp: Date.now()
      });
      flushPendingEventsVersionNotification();

      const versionAfter = store.getState().eventsByTurnVersion;
      expect(versionAfter).toBeGreaterThan(versionBefore);
    });

    it('increments version for each event processed', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test message');
      const turnId = 'test-turn-456';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      const versions: number[] = [];

      const events: AgentEvent[] = [
        { type: 'status' as const, message: 'Starting...', timestamp: Date.now() },
        { type: 'tool' as const, toolName: 'test_tool', toolUseId: 'tool-1', stage: 'start' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'test_tool', toolUseId: 'tool-1', stage: 'end' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'assistant' as const, text: 'Here is my response', timestamp: Date.now() },
        { type: 'result' as const, text: 'Final result', timestamp: Date.now() }
      ];

      for (const event of events) {
        versions.push(store.getState().eventsByTurnVersion);
        store.getState().processEvent(turnId, event);
        // Stage 5: drain the per-event coalesced microtask so the assertion
        // below sees a unique version per event (the Zustand state lags by
        // ≤1 microtask).
        flushPendingEventsVersionNotification();
      }
      versions.push(store.getState().eventsByTurnVersion);

      // Each version should be unique (monotonically increasing)
      const uniqueVersions = new Set(versions);
      expect(uniqueVersions.size).toBe(versions.length);
    });

    it('events are accumulated in external Map', () => {
      const store = createSessionStore();
      
      store.getState().addUserMessage('Test message');
      const turnId = 'test-turn-789';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      store.getState().processEvent(turnId, {
        type: 'status',
        message: 'Working...',
        timestamp: Date.now()
      });
      store.getState().processEvent(turnId, {
        type: 'result',
        text: 'Done!',
        timestamp: Date.now()
      });

      const events = getCurrentSessionEventsForTurn(turnId);
      expect(events).toBeDefined();
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('status');
      expect(events[1].type).toBe('result');

      // Zustand state.eventsByTurn is always empty (events live externally)
      expect(store.getState().eventsByTurn).toEqual({});
    });
  });

  describe('Zustand subscription behavior', () => {
    it('subscribeWithSelector fires on eventsByTurnVersion change', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback
      );

      store.getState().addUserMessage('Test');
      const turnId = 'sub-test-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      callback.mockClear();

      store.getState().processEvent(turnId, {
        type: 'status',
        message: 'Test status',
        timestamp: Date.now()
      });
      flushPendingEventsVersionNotification();

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('subscription fires for each event during a turn (when flushed between events)', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      store.getState().addUserMessage('Test');
      const turnId = 'multi-event-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback
      );

      // Stage 5: each event bumps the synchronous counter; the Zustand
      // notification is microtask-coalesced. Without a flush between events,
      // a single notification would fan out per microtask boundary
      // (the perf win). Tests asserting per-event semantics flush between
      // events to mirror the boundary-flush calls production code makes at
      // terminal turn events / queue drain / etc.
      store.getState().processEvent(turnId, { type: 'status', message: 'Starting', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'web_search', toolUseId: 't1', stage: 'start', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'web_search', toolUseId: 't1', stage: 'end', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'assistant', text: 'Found results', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'result', text: 'Complete', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();

      expect(callback).toHaveBeenCalledTimes(5);

      unsubscribe();
    });

    it('messages.length does NOT change during mid-turn events (status, tools)', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test');
      const turnId = 'msg-length-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const messagesLengthBefore = store.getState().messages.length;

      store.getState().processEvent(turnId, { type: 'status', message: 'Working', timestamp: Date.now() } as AgentEvent);
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'test', toolUseId: 't1', stage: 'start', timestamp: Date.now() } as AgentEvent);
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'test', toolUseId: 't1', stage: 'end', timestamp: Date.now() } as AgentEvent);

      const messagesLengthAfter = store.getState().messages.length;

      expect(messagesLengthAfter).toBe(messagesLengthBefore);
    });
  });

  describe('regression: mid-turn persistence gap', () => {
    it('eventsByTurnVersion subscription triggers during turn where messages.length does not', () => {
      const store = createSessionStore();
      const eventsByTurnCallback = vi.fn();
      const messagesLengthCallback = vi.fn();

      store.getState().addUserMessage('Initial message');
      const turnId = 'regression-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      const unsubEvents = store.subscribe(
        (state) => state.eventsByTurnVersion,
        eventsByTurnCallback
      );
      const unsubMessages = store.subscribe(
        (state) => state.messages.length,
        messagesLengthCallback
      );

      // Flush between events to assert per-event firing semantics. Without
      // flushes, the post-Stage-5 microtask scheduler would coalesce all
      // three bumps into a single Zustand notification.
      store.getState().processEvent(turnId, { type: 'status', message: 'Starting agent...', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'research', toolUseId: 't1', stage: 'start', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();
      store.getState().processEvent(turnId, { type: 'tool', toolName: 'research', toolUseId: 't1', stage: 'end', detail: 'Found 10 results', timestamp: Date.now() } as AgentEvent);
      flushPendingEventsVersionNotification();

      expect(eventsByTurnCallback).toHaveBeenCalledTimes(3);
      expect(messagesLengthCallback).toHaveBeenCalledTimes(0);

      unsubEvents();
      unsubMessages();
    });

    it('long-running turns with many tool calls persist incrementally', () => {
      const store = createSessionStore();
      const eventsByTurnCallback = vi.fn();

      store.getState().addUserMessage('Research task');
      const turnId = 'long-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      flushPendingEventsVersionNotification();

      const unsubEvents = store.subscribe(
        (state) => state.eventsByTurnVersion,
        eventsByTurnCallback
      );

      const simulatedEvents: AgentEvent[] = [
        { type: 'status' as const, message: 'Starting research...', timestamp: Date.now() },
        { type: 'tool' as const, toolName: 'Task', toolUseId: 't1', stage: 'start' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'Task', toolUseId: 't1', stage: 'end' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'Task', toolUseId: 't2', stage: 'start' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'Task', toolUseId: 't2', stage: 'end' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'WebSearch', toolUseId: 't3', stage: 'start' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'tool' as const, toolName: 'WebSearch', toolUseId: 't3', stage: 'end' as const, timestamp: Date.now() } as AgentEvent,
        { type: 'status' as const, message: 'Compiling results...', timestamp: Date.now() },
      ];

      for (const event of simulatedEvents) {
        store.getState().processEvent(turnId, event);
        // Stage 5: flush per event to assert per-event subscription firing.
        // Without flushes, all 8 bumps would coalesce into a single Zustand
        // notification at the next microtask boundary (the perf win).
        flushPendingEventsVersionNotification();
      }

      expect(eventsByTurnCallback).toHaveBeenCalledTimes(simulatedEvents.length);

      // Verify all events are stored in external Map
      const turnEvents = getCurrentSessionEventsForTurn(turnId);
      expect(turnEvents.length).toBe(simulatedEvents.length);

      unsubEvents();
    });
  });

  describe('session lifecycle: events survive reset into history', () => {
    it('resetSession preserves events in the snapshot', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test message');
      const turnId = 'reset-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      store.getState().processEvent(turnId, { type: 'status', message: 'Working', timestamp: Date.now() });
      store.getState().processEvent(turnId, { type: 'result', text: 'Done', timestamp: Date.now() });

      // Verify events exist before reset
      expect(getCurrentSessionEventsForTurn(turnId).length).toBe(2);

      const oldSessionId = store.getState().currentSessionId;
      store.getState().resetSession();

      // After reset: external Map should be cleared (new session)
      expect(hasCurrentSessionEvents()).toBe(false);

      // The old session should have been saved to history with events intact
      const summaries = store.getState().sessionSummaries;
      const oldSummary = summaries.find(s => s.id === oldSessionId);
      expect(oldSummary).toBeDefined();
    });

    it('softDeleteSession for current session clears external Map', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test message');
      const turnId = 'delete-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      store.getState().processEvent(turnId, { type: 'result', text: 'Done', timestamp: Date.now() });
      expect(hasCurrentSessionEvents()).toBe(true);

      const oldSessionId = store.getState().currentSessionId;
      store.getState().softDeleteSession(oldSessionId);

      // External Map should be cleared after soft delete
      expect(hasCurrentSessionEvents()).toBe(false);
      // New session should be created
      expect(store.getState().currentSessionId).not.toBe(oldSessionId);
    });

    it('clearInterruptedTurnData removes only the specified turn from external Map', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Message 1');
      const turn1 = 'turn-1';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turn1, Date.now());
      store.getState().processEvent(turn1, { type: 'result', text: 'Done 1', timestamp: Date.now() });

      store.getState().addUserMessage('Message 2');
      const turn2 = 'turn-2';
      store.getState().assignTurnToMessage(store.getState().messages[1].id, turn2, Date.now());
      store.getState().processEvent(turn2, { type: 'status', message: 'Working', timestamp: Date.now() });

      // Both turns have events
      expect(getCurrentSessionEventsForTurn(turn1).length).toBe(1);
      expect(getCurrentSessionEventsForTurn(turn2).length).toBe(1);

      store.getState().clearInterruptedTurnData(turn2);

      // Turn 1 events preserved, turn 2 removed
      expect(getCurrentSessionEventsForTurn(turn1).length).toBe(1);
      expect(getCurrentSessionEventsForTurn(turn2).length).toBe(0);
    });

    it('performCompaction clears all events from external Map', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test');
      const turnId = 'compact-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      store.getState().processEvent(turnId, { type: 'result', text: 'Done', timestamp: Date.now() });

      expect(hasCurrentSessionEvents()).toBe(true);

      store.getState().performCompaction('Summary of compacted content', 1);

      expect(hasCurrentSessionEvents()).toBe(false);
      expect(getCurrentSessionEvents()).toEqual({});
    });
  });

  describe('openHistorySession with fullFidelityEvents', () => {
    it('uses fullFidelityEvents for external Map when provided', () => {
      const store = createSessionStore();

      // Set up session with events containing detail
      store.getState().addUserMessage('Test message');
      const turnId = 'fidelity-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const fullEvent: AgentEvent = {
        type: 'tool',
        toolName: 'MissionSet',
        toolUseId: 'tool-1',
        detail: '{"goal":"Build feature X","done_criteria":"Tests pass"}',
        stage: 'end',
        timestamp: Date.now(),
      };
      store.getState().processEvent(turnId, fullEvent);
      store.getState().processEvent(turnId, { type: 'result', text: 'Done', timestamp: Date.now() });

      // Snapshot and add to history (this calls cacheSession which compacts)
      const snapshot = store.getState().snapshotCurrentSession()!;
      expect(snapshot).not.toBeNull();
      store.getState().addOrUpdateHistorySession(snapshot);

      // Verify cache has compacted events (detail stripped)
      const cached = store.getState().getLoadedSession(snapshot.id);
      expect(cached).toBeDefined();
      const cachedToolEvent = cached!.eventsByTurn[turnId]?.find(
        (e) => e.type === 'tool' && e.toolName === 'MissionSet'
      );
      if (cachedToolEvent && cachedToolEvent.type === 'tool') {
        expect(cachedToolEvent.detail).toBe('');
      }

      // Switch to a new session first
      store.getState().resetSession();

      // Open the history session WITH full-fidelity events
      const fullEvents: Record<string, AgentEvent[]> = {
        [turnId]: [fullEvent, { type: 'result', text: 'Done', timestamp: Date.now() }],
      };
      const opened = store.getState().openHistorySession(snapshot.id, fullEvents);
      expect(opened).not.toBeNull();

      // External Map should have full-fidelity events (not compacted)
      const externalEvents = getCurrentSessionEventsForTurn(turnId);
      const toolEvent = externalEvents.find(
        (e) => e.type === 'tool' && e.toolName === 'MissionSet'
      );
      expect(toolEvent).toBeDefined();
      if (toolEvent && toolEvent.type === 'tool') {
        expect(toolEvent.detail).toBe('{"goal":"Build feature X","done_criteria":"Tests pass"}');
      }
    });

    it('falls back to cached events when fullFidelityEvents not provided', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('Test');
      const turnId = 'fallback-turn';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      store.getState().processEvent(turnId, {
        type: 'tool',
        toolName: 'Read',
        toolUseId: 'tool-2',
        detail: '{"file_path":"/tmp/test.txt"}',
        stage: 'start',
        timestamp: Date.now(),
      });
      store.getState().processEvent(turnId, { type: 'result', text: 'Done', timestamp: Date.now() });

      const snapshot = store.getState().snapshotCurrentSession()!;
      store.getState().addOrUpdateHistorySession(snapshot);
      store.getState().resetSession();

      // Open WITHOUT full-fidelity events (backwards compat)
      const opened = store.getState().openHistorySession(snapshot.id);
      expect(opened).not.toBeNull();

      // Should still have events (from cache, compacted but structurally intact)
      const events = getCurrentSessionEventsForTurn(turnId);
      expect(events.length).toBeGreaterThan(0);
    });
  });
});
