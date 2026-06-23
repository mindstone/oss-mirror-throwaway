/**
 * ConversationStreamCoordinator unit tests.
 *
 * Covers:
 *   - attach/detach lifecycle (single + multiple writers)
 *   - broadcast fans out to every writer and advances activity clock
 *   - closeAllForToken closes only the matching writers (leaves others)
 *   - closeAll tears down everything cleanly
 *   - keepalive timer emits `:\n\n` comment frames on cadence
 *   - turn event subscription: assistant_delta → `event: assistant_delta` frame
 *   - turn event subscription: result → `event: assistant_done` frame
 *   - new turn auto-subscription via `onTurnStartedForSession`
 *   - broken pipe (res.write throws) is isolated — coordinator detaches
 *     and keeps working for other writers
 *
 * Uses fakes for the registry + a mock ServerResponse so we don't open
 * real sockets. `vi.useFakeTimers()` drives keepalive and idle timers
 * deterministically.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md
 */

import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  createConversationStreamCoordinator,
  type ConversationStreamRegistryDeps,
} from '../server/conversationStreamCoordinator';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeResponse {
  res: ServerResponse;
  writes: string[];
  ended: boolean;
  /** Inject a throw on the next N writes. */
  throwOnNextWrites: number;
  headersSent: boolean;
}

function buildFakeResponse(): FakeResponse {
  // NOTE: we intentionally return the same `state` object that the
  // closures mutate — spreading (`{ ...state }`) would copy the
  // primitives by value at return time and break `state.ended` /
  // `state.headersSent` assertions.
  const state: FakeResponse = {
    res: null as unknown as ServerResponse,
    writes: [],
    ended: false,
    throwOnNextWrites: 0,
    headersSent: false,
  };
  state.res = {
    write(chunk: string | Buffer): boolean {
      if (state.throwOnNextWrites > 0) {
        state.throwOnNextWrites -= 1;
        throw new Error('EPIPE broken pipe');
      }
      state.writes.push(
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      );
      return true;
    },
    end(): void {
      state.ended = true;
    },
    flushHeaders(): void {
      state.headersSent = true;
    },
  } as unknown as ServerResponse;
  return state;
}

interface FakeRegistry extends ConversationStreamRegistryDeps {
  activeTurns: Map<string, string>;
  turnSubscribers: Map<string, Set<(event: AgentEvent) => void>>;
  sessionTurnStartListeners: Map<string, Set<(turnId: string) => void>>;
  turnSubscribeCalls: string[];
  turnUnsubscribeCalls: string[];
  sessionListenCalls: string[];
  sessionUnsubscribeCalls: string[];
  fireTurnEvent(turnId: string, event: AgentEvent): void;
  fireTurnStarted(sessionId: string, turnId: string): void;
  throwOnSubscribe?: boolean;
}

function buildFakeRegistry(): FakeRegistry {
  const activeTurns = new Map<string, string>();
  const turnSubscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  const sessionTurnStartListeners = new Map<
    string,
    Set<(turnId: string) => void>
  >();
  const turnSubscribeCalls: string[] = [];
  const turnUnsubscribeCalls: string[] = [];
  const sessionListenCalls: string[] = [];
  const sessionUnsubscribeCalls: string[] = [];

  const registry: FakeRegistry = {
    activeTurns,
    turnSubscribers,
    sessionTurnStartListeners,
    turnSubscribeCalls,
    turnUnsubscribeCalls,
    sessionListenCalls,
    sessionUnsubscribeCalls,
    getActiveTurnForSession(sessionId) {
      return activeTurns.get(sessionId);
    },
    hasActiveTurnForSession(sessionId) {
      return activeTurns.has(sessionId);
    },
    subscribeTurnEvents(turnId, listener) {
      if (registry.throwOnSubscribe) {
        throw new Error('subscribe failure');
      }
      turnSubscribeCalls.push(turnId);
      const existing = turnSubscribers.get(turnId) ?? new Set();
      existing.add(listener);
      turnSubscribers.set(turnId, existing);
      return () => {
        turnUnsubscribeCalls.push(turnId);
        const current = turnSubscribers.get(turnId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
          turnSubscribers.delete(turnId);
        }
      };
    },
    onTurnStartedForSession(sessionId, listener) {
      sessionListenCalls.push(sessionId);
      const existing = sessionTurnStartListeners.get(sessionId) ?? new Set();
      existing.add(listener);
      sessionTurnStartListeners.set(sessionId, existing);
      return () => {
        sessionUnsubscribeCalls.push(sessionId);
        const current = sessionTurnStartListeners.get(sessionId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
          sessionTurnStartListeners.delete(sessionId);
        }
      };
    },
    fireTurnEvent(turnId, event) {
      const subs = turnSubscribers.get(turnId);
      if (!subs) return;
      for (const sub of subs) {
        sub(event);
      }
    },
    fireTurnStarted(sessionId, turnId) {
      activeTurns.set(sessionId, turnId);
      const listeners = sessionTurnStartListeners.get(sessionId);
      if (!listeners) return;
      for (const listener of listeners) {
        listener(turnId);
      }
    },
  };
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('conversationStreamCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attach registers a writer and returns a handle', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    const writer = coord.attach('s1', fake.res, 'hashedA');

    expect(writer.conversationId).toBe('s1');
    expect(writer.hashedToken).toBe('hashedA');
    expect(writer.closed).toBe(false);
    expect(coord.getWriterCount()).toBe(1);
    expect(coord.getWriterCountForConversation('s1')).toBe(1);
  });

  it('detach removes the writer and tears down subscriptions when last writer leaves', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    const writer = coord.attach('s1', fake.res, 'hashedA');
    expect(registry.turnSubscribeCalls).toEqual(['t1']);
    expect(registry.sessionListenCalls).toEqual(['s1']);

    coord.detach(writer);

    expect(coord.getWriterCount()).toBe(0);
    // Both the per-turn and the session-level subscriptions should be released.
    expect(registry.turnUnsubscribeCalls).toEqual(['t1']);
    expect(registry.sessionUnsubscribeCalls).toEqual(['s1']);
  });

  it('broadcast fans out to every writer in the conversation', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const a = buildFakeResponse();
    const b = buildFakeResponse();

    coord.attach('s1', a.res, 'hashedA');
    coord.attach('s1', b.res, 'hashedB');

    coord.broadcast('s1', 'assistant_delta', { turnId: 't1', text: 'hi' });

    const expected =
      'event: assistant_delta\ndata: {"turnId":"t1","text":"hi"}\n\n';
    expect(a.writes).toContain(expected);
    expect(b.writes).toContain(expected);
  });

  it('closeAllForToken closes matching writers and leaves others alone', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const a = buildFakeResponse();
    const b = buildFakeResponse();
    const c = buildFakeResponse();

    coord.attach('s1', a.res, 'hashA');
    coord.attach('s1', b.res, 'hashB');
    coord.attach('s2', c.res, 'hashA'); // different conversation, same token

    coord.closeAllForToken('hashA');

    // a + c closed (both held hashA), b still open
    expect(a.ended).toBe(true);
    expect(c.ended).toBe(true);
    expect(b.ended).toBe(false);
    // Both closed writers received the final `revoked` frame.
    expect(a.writes.some((w) => w.startsWith('event: revoked'))).toBe(true);
    expect(c.writes.some((w) => w.startsWith('event: revoked'))).toBe(true);
    expect(b.writes.some((w) => w.startsWith('event: revoked'))).toBe(false);
    expect(coord.getWriterCount()).toBe(1);
    expect(coord.getWriterCountForConversation('s1')).toBe(1);
    expect(coord.getWriterCountForConversation('s2')).toBe(0);
  });

  it('closeAll closes every live writer across conversations', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const a = buildFakeResponse();
    const b = buildFakeResponse();

    coord.attach('s1', a.res, 'hashA');
    coord.attach('s2', b.res, 'hashB');

    coord.closeAll();

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(coord.getWriterCount()).toBe(0);
  });

  it('keepalive timer writes SSE comment frames every 15s', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({
      registry,
      keepaliveMs: 15_000,
    });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    // No keepalive writes until timer fires.
    expect(fake.writes.filter((w) => w.startsWith(':'))).toHaveLength(0);

    vi.advanceTimersByTime(15_000);
    expect(fake.writes.filter((w) => w.startsWith(':'))).toHaveLength(1);
    expect(fake.writes[fake.writes.length - 1]).toBe(': keepalive\n\n');

    vi.advanceTimersByTime(30_000);
    expect(fake.writes.filter((w) => w.startsWith(':'))).toHaveLength(3);
  });

  it('forwards assistant_delta turn events as SSE frames', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    registry.fireTurnEvent('t1', {
      type: 'assistant_delta',
      text: 'Hello',
      timestamp: 1,
    } as AgentEvent);

    expect(fake.writes).toContain(
      'event: assistant_delta\ndata: {"turnId":"t1","text":"Hello"}\n\n',
    );
  });

  it('forwards result turn events as assistant_done frames', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    registry.fireTurnEvent('t1', {
      type: 'result',
      text: 'done',
      timestamp: 1,
    } as AgentEvent);

    expect(fake.writes).toContain(
      'event: assistant_done\ndata: {"turnId":"t1"}\n\n',
    );
  });

  it('forwards tool start events as tool_activity frames, ignores tool end', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    registry.fireTurnEvent('t1', {
      type: 'tool',
      toolName: 'read_page',
      detail: 'scraping',
      stage: 'start',
      timestamp: 1,
    } as AgentEvent);
    registry.fireTurnEvent('t1', {
      type: 'tool',
      toolName: 'read_page',
      detail: 'done',
      stage: 'end',
      timestamp: 2,
    } as AgentEvent);

    const toolFrames = fake.writes.filter((w) => w.startsWith('event: tool_activity'));
    expect(toolFrames).toHaveLength(1);
    expect(toolFrames[0]).toContain('"phase":"start"');
    expect(toolFrames[0]).toContain('"name":"read_page"');
  });

  it('forwards error events as turn_error frames', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    registry.fireTurnEvent('t1', {
      type: 'error',
      error: 'boom',
      timestamp: 1,
    } as AgentEvent);

    const errFrames = fake.writes.filter((w) => w.startsWith('event: turn_error'));
    expect(errFrames).toHaveLength(1);
    expect(errFrames[0]).toContain('"error":"boom"');
  });

  it('auto-subscribes to a new turn via onTurnStartedForSession', () => {
    const registry = buildFakeRegistry();
    // Start with no active turn.
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');
    // No turn active → no per-turn subscribe yet; only the session listener.
    expect(registry.turnSubscribeCalls).toEqual([]);
    expect(registry.sessionListenCalls).toEqual(['s1']);

    // Simulate a new turn starting on this session.
    registry.fireTurnStarted('s1', 't2');
    expect(registry.turnSubscribeCalls).toEqual(['t2']);

    // Events from that turn should now fan out.
    registry.fireTurnEvent('t2', {
      type: 'assistant_delta',
      text: 'late',
      timestamp: 1,
    } as AgentEvent);
    expect(fake.writes).toContain(
      'event: assistant_delta\ndata: {"turnId":"t2","text":"late"}\n\n',
    );
  });

  it('swaps subscriptions when a new turn starts after an old one', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');
    // First turn subscribed at attach.
    expect(registry.turnSubscribeCalls).toEqual(['t1']);

    // New turn starts. Old turn subscription is torn down; new one added.
    registry.fireTurnStarted('s1', 't2');
    expect(registry.turnUnsubscribeCalls).toEqual(['t1']);
    expect(registry.turnSubscribeCalls).toEqual(['t1', 't2']);
  });

  it('broken-pipe on write detaches only the failing writer and keeps the rest alive', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const bad = buildFakeResponse();
    const good = buildFakeResponse();

    coord.attach('s1', bad.res, 'hashA');
    coord.attach('s1', good.res, 'hashB');

    // Next write on `bad` throws; `good` keeps working.
    bad.throwOnNextWrites = 1;

    coord.broadcast('s1', 'assistant_delta', { turnId: 't1', text: 'hi' });

    // Bad writer got detached + ended. Good writer still there with the frame.
    expect(bad.ended).toBe(true);
    expect(good.writes).toContain(
      'event: assistant_delta\ndata: {"turnId":"t1","text":"hi"}\n\n',
    );
    expect(coord.getWriterCount()).toBe(1);

    // Subsequent broadcasts still work on the good writer.
    coord.broadcast('s1', 'assistant_delta', { turnId: 't1', text: 'more' });
    expect(good.writes).toContain(
      'event: assistant_delta\ndata: {"turnId":"t1","text":"more"}\n\n',
    );
  });

  it('idle timeout closes writers when no activity arrives for the configured window', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({
      registry,
      idleTimeoutMs: 60_000,
      // Make keepalive much larger than idle so it doesn't interfere.
      keepaliveMs: 600_000,
    });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');
    vi.advanceTimersByTime(59_000);
    expect(fake.ended).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(fake.ended).toBe(true);
    expect(coord.getWriterCount()).toBe(0);
  });

  it('broadcasting an event resets the idle timer', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({
      registry,
      idleTimeoutMs: 60_000,
      keepaliveMs: 600_000,
    });
    const fake = buildFakeResponse();

    coord.attach('s1', fake.res, 'hashA');

    vi.advanceTimersByTime(50_000);
    coord.broadcast('s1', 'assistant_delta', { turnId: 't1', text: 'still alive' });
    // We should now have another ~60s before timeout.
    vi.advanceTimersByTime(50_000);
    expect(fake.ended).toBe(false);

    vi.advanceTimersByTime(15_000);
    expect(fake.ended).toBe(true);
  });

  it('detach is idempotent (safe to call twice from overlapping close listeners)', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    const writer = coord.attach('s1', fake.res, 'hashA');
    coord.detach(writer);
    coord.detach(writer);

    expect(coord.getWriterCount()).toBe(0);
  });

  it('subscribe failure at attach time logs + continues (no throw)', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    registry.throwOnSubscribe = true;
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();

    expect(() => coord.attach('s1', fake.res, 'hashA')).not.toThrow();
    expect(coord.getWriterCount()).toBe(1);
  });

  it('multiple writers receive the same fanned-out turn event', () => {
    const registry = buildFakeRegistry();
    registry.activeTurns.set('s1', 't1');
    const coord = createConversationStreamCoordinator({ registry });
    const a = buildFakeResponse();
    const b = buildFakeResponse();

    coord.attach('s1', a.res, 'hashA');
    coord.attach('s1', b.res, 'hashB');

    registry.fireTurnEvent('t1', {
      type: 'assistant_delta',
      text: 'hi',
      timestamp: 1,
    } as AgentEvent);

    const expected =
      'event: assistant_delta\ndata: {"turnId":"t1","text":"hi"}\n\n';
    expect(a.writes).toContain(expected);
    expect(b.writes).toContain(expected);
  });

  it('closeAllForToken ignores empty hashed token (dev-mode path)', () => {
    const registry = buildFakeRegistry();
    const coord = createConversationStreamCoordinator({ registry });
    const fake = buildFakeResponse();
    coord.attach('s1', fake.res, '');
    coord.closeAllForToken('');
    expect(fake.ended).toBe(false);
    expect(coord.getWriterCount()).toBe(1);
  });
});
