import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginEventBus } from '../pluginEventBus';

// Mock the session store to control privateMode and sessionSummaries for privacy guard tests
vi.mock('@renderer/features/agent-session/store/sessionStore', () => {
  let privateMode = false;
  let sessionSummaries: Array<{ id: string; privateMode?: boolean }> = [];
  return {
    getSessionStoreState: () => ({ privateMode, sessionSummaries }),
    subscribeToSessionStore: vi.fn(),
    setPrivateMode: (value: boolean) => { privateMode = value; },
    setSessionSummaries: (summaries: Array<{ id: string; privateMode?: boolean }>) => { sessionSummaries = summaries; },
  };
});

// Import the test helpers after mock setup
const { setPrivateMode, setSessionSummaries } = await import('@renderer/features/agent-session/store/sessionStore') as any;

describe('pluginEventBus', () => {
  beforeEach(() => {
    pluginEventBus.reset();
    setPrivateMode(false);
    setSessionSummaries([]);
  });

  describe('subscribe/emit', () => {
    it('delivers events to subscribers after initialization', () => {
      pluginEventBus.initialize();
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ sessionId: 's1', turnId: 't1' });
    });

    it('does not deliver events before initialization', () => {
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('delivers events after late initialization', () => {
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();

      pluginEventBus.initialize();
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('supports multiple subscribers for the same event', () => {
      pluginEventBus.initialize();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      pluginEventBus.subscribe('turn:completed', cb1);
      pluginEventBus.subscribe('turn:completed', cb2);

      pluginEventBus.emit('turn:completed', { text: 'hello' });
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('does not cross-deliver events between different types', () => {
      pluginEventBus.initialize();
      const startCb = vi.fn();
      const completeCb = vi.fn();
      pluginEventBus.subscribe('turn:started', startCb);
      pluginEventBus.subscribe('turn:completed', completeCb);

      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(startCb).toHaveBeenCalledTimes(1);
      expect(completeCb).not.toHaveBeenCalled();
    });

    it('handles emit with no subscribers gracefully', () => {
      pluginEventBus.initialize();
      expect(() => {
        pluginEventBus.emit('navigation:changed', { target: 'settings', previousTarget: 'sessions' });
      }).not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('returns an unsubscribe function that removes the listener', () => {
      pluginEventBus.initialize();
      const cb = vi.fn();
      const unsub = pluginEventBus.subscribe('turn:started', cb);

      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't2' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('only removes the specific listener, not others', () => {
      pluginEventBus.initialize();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = pluginEventBus.subscribe('turn:error', cb1);
      pluginEventBus.subscribe('turn:error', cb2);

      unsub1();
      pluginEventBus.emit('turn:error', { error: 'test' });

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('privacy guard', () => {
    it('suppresses turn:started during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('suppresses turn:completed during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:completed', cb);
      pluginEventBus.emit('turn:completed', { sessionId: 's1', turnId: 't1', assistantText: 'hi', toolsUsed: [] });
      expect(cb).not.toHaveBeenCalled();
    });

    it('suppresses turn:error during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:error', cb);
      pluginEventBus.emit('turn:error', { sessionId: 's1', turnId: 't1', error: 'oops' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('suppresses conversation:created during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('conversation:created', cb);
      pluginEventBus.emit('conversation:created', { sessionId: 's1', title: 'Test' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('does NOT suppress navigation:changed during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('navigation:changed', cb);
      pluginEventBus.emit('navigation:changed', { target: 'settings', previousTarget: 'sessions' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does NOT suppress memory:source-added during private sessions', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('memory:source-added', cb);
      pluginEventBus.emit('memory:source-added', { turnId: 't1', summary: 'test' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('resumes delivery when private mode is turned off', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);

      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();

      setPrivateMode(false);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't2' });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('target-session privacy guard', () => {
    it('suppresses privacy-guarded events when targetSessionId points to a private session', () => {
      pluginEventBus.initialize();
      setPrivateMode(false);
      setSessionSummaries([{ id: 'private-s1', privateMode: true }]);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:completed', cb);
      pluginEventBus.emit('turn:completed', { sessionId: 'private-s1', turnId: 't1' }, 'private-s1');
      expect(cb).not.toHaveBeenCalled();
    });

    it('delivers privacy-guarded events when targetSessionId points to a public session', () => {
      pluginEventBus.initialize();
      setPrivateMode(false);
      setSessionSummaries([{ id: 'public-s1', privateMode: false }]);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:completed', cb);
      pluginEventBus.emit('turn:completed', { sessionId: 'public-s1', turnId: 't1' }, 'public-s1');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('falls back to current-session privacy when no targetSessionId provided', () => {
      pluginEventBus.initialize();
      setPrivateMode(true);
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('treats unknown targetSessionId as private (safe default)', () => {
      pluginEventBus.initialize();
      setPrivateMode(false);
      setSessionSummaries([{ id: 'known-s1', privateMode: false }]);
      const cb = vi.fn();
      pluginEventBus.subscribe('conversation:created', cb);
      pluginEventBus.emit('conversation:created', { sessionId: 'unknown-s1' }, 'unknown-s1');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('continues delivering to other listeners when one throws', () => {
      pluginEventBus.initialize();
      const badCb = vi.fn(() => { throw new Error('plugin crash'); });
      const goodCb = vi.fn();

      pluginEventBus.subscribe('turn:completed', badCb);
      pluginEventBus.subscribe('turn:completed', goodCb);

      expect(() => {
        pluginEventBus.emit('turn:completed', { text: 'hello' });
      }).not.toThrow();

      expect(badCb).toHaveBeenCalledTimes(1);
      expect(goodCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('clears all listeners and resets initialization', () => {
      pluginEventBus.initialize();
      const cb = vi.fn();
      pluginEventBus.subscribe('turn:started', cb);

      pluginEventBus.reset();
      expect(pluginEventBus.isInitialized()).toBe(false);

      // Even after re-initialize, the old listener should be gone
      pluginEventBus.initialize();
      pluginEventBus.emit('turn:started', { sessionId: 's1', turnId: 't1' });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('isInitialized', () => {
    it('returns false before initialize()', () => {
      expect(pluginEventBus.isInitialized()).toBe(false);
    });

    it('returns true after initialize()', () => {
      pluginEventBus.initialize();
      expect(pluginEventBus.isInitialized()).toBe(true);
    });
  });
});
