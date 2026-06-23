/**
 * Tests for the transient `safetyEvalInFlight` map that drives the
 * "Checking this is safe…" subline on running-tool rows.
 *
 * Covers:
 *   - setSafetyEvalInFlight / clearSafetyEvalInFlight
 *   - Belt-and-braces cleanup when a matching `tool` stage:'end' event arrives
 *     via processEvent (covers event-drop edge cases)
 *
 * See: docs/plans/260417_safety_eval_silent_lock_bugfix.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('safetyEvalInFlight store slice', () => {
  it('initializes to an empty object', () => {
    const store = createSessionStore();
    expect(store.getState().safetyEvalInFlight).toEqual({});
  });

  it('setSafetyEvalInFlight adds an entry keyed by toolUseId', () => {
    const store = createSessionStore();
    store.getState().setSafetyEvalInFlight('use-1', { attempt: 1, startedAt: 100, toolName: 'Bash' });

    expect(store.getState().safetyEvalInFlight).toEqual({
      'use-1': { attempt: 1, startedAt: 100, toolName: 'Bash' },
    });
  });

  it('setSafetyEvalInFlight replaces an existing entry on retry', () => {
    const store = createSessionStore();
    store.getState().setSafetyEvalInFlight('use-1', { attempt: 1, startedAt: 100, toolName: 'Bash' });
    store.getState().setSafetyEvalInFlight('use-1', { attempt: 2, startedAt: 200, toolName: 'Bash' });

    expect(store.getState().safetyEvalInFlight['use-1']).toEqual({
      attempt: 2,
      startedAt: 200,
      toolName: 'Bash',
    });
  });

  it('clearSafetyEvalInFlight removes the entry', () => {
    const store = createSessionStore();
    store.getState().setSafetyEvalInFlight('use-1', { attempt: 1, startedAt: 100, toolName: 'Bash' });
    store.getState().clearSafetyEvalInFlight('use-1');

    expect(store.getState().safetyEvalInFlight).toEqual({});
  });

  it('clearSafetyEvalInFlight is a no-op for unknown toolUseId', () => {
    const store = createSessionStore();
    const before = store.getState().safetyEvalInFlight;

    store.getState().clearSafetyEvalInFlight('does-not-exist');

    // Same object identity — no spurious re-render.
    expect(store.getState().safetyEvalInFlight).toBe(before);
  });

  it('processEvent belt-and-braces: tool stage:end clears matching safetyEvalInFlight entry', () => {
    const store = createSessionStore();
    store.getState().addUserMessage('hello');
    const messageId = store.getState().messages[0].id;
    const turnId = 'turn-1';
    store.getState().assignTurnToMessage(messageId, turnId, Date.now());

    store.getState().setSafetyEvalInFlight('use-42', { attempt: 1, startedAt: 100, toolName: 'Bash' });
    expect(store.getState().safetyEvalInFlight['use-42']).toBeDefined();

    // Simulate a dropped `-complete` broadcast: the tool itself ends and we
    // rely on processEvent to clean up.
    store.getState().processEvent(turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'use-42',
      detail: '',
      stage: 'end',
      timestamp: Date.now(),
    });

    expect(store.getState().safetyEvalInFlight['use-42']).toBeUndefined();
  });

  it('processEvent tool stage:start does NOT clear safetyEvalInFlight', () => {
    const store = createSessionStore();
    store.getState().addUserMessage('hello');
    const messageId = store.getState().messages[0].id;
    const turnId = 'turn-2';
    store.getState().assignTurnToMessage(messageId, turnId, Date.now());

    store.getState().setSafetyEvalInFlight('use-99', { attempt: 1, startedAt: 100, toolName: 'Bash' });
    store.getState().processEvent(turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'use-99',
      detail: '',
      stage: 'start',
      timestamp: Date.now(),
    });

    expect(store.getState().safetyEvalInFlight['use-99']).toBeDefined();
  });
});
