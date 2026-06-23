/**
 * ConversationStreamCoordinator — SSE fan-out for the embedded chat
 * (Stage 2 of `260421_embedded_chat_in_extension`).
 *
 * Owns the live `Map<conversationId, Set<StreamWriter>>` for
 * `GET /intent/conversation/:id/stream`, subscribes to turn events on
 * each active conversation via `agentTurnRegistry.subscribeTurnEvents`
 * (Stage 0 multi-subscriber API — never the single-slot
 * `setEventListener`, which is claimed by the automation drain path),
 * and handles:
 *
 *   - Turn event fan-out: translates `AgentEvent`s to SSE frames
 *     (`assistant_delta`, `tool_activity`, `assistant_done`, `turn_error`)
 *     and writes them to every writer for the relevant conversation.
 *   - Auto-subscription to new turns via
 *     `agentTurnRegistry.onTurnStartedForSession` so streams opened
 *     between turns don't miss the next reply.
 *   - Keepalive: writes `:\n\n` every 15s per writer so proxies/clients
 *     don't idle-close the stream.
 *   - Idle timeout: closes all writers for a conversation after 5min of
 *     no turn activity. Resets on each fanned-out event.
 *   - Token revocation: `closeAllForToken(hashedToken)` closes any
 *     writers associated with the hashed pairing token that was revoked,
 *     sending a final `event: revoked` frame first so the client can
 *     distinguish an intentional server-side close from a network drop.
 *   - Graceful shutdown: `closeAll()` closes everything.
 *
 * Error isolation: every `res.write()` is wrapped in a per-writer
 * try/catch so one broken pipe can't poison broadcast to the rest.
 * Failing writers are detached immediately — no retries — because they
 * are unrecoverable (the client already disconnected).
 *
 * Platform-agnostic: this module lives in `src/core/` and therefore must
 * never import from `electron`. Depends only on `node:http`, the
 * registry boundary interface, and `@core/logger`.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md
 */

import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '@shared/types';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'conversationStreamCoordinator' });

/** How often to emit SSE keepalive comments (ms). */
const DEFAULT_KEEPALIVE_MS = 15_000;
/** Idle timeout — close streams if no turn activity arrives for this long (ms). */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * One live SSE connection. Mutable state is kept on the coordinator so
 * callers (the intent service, tests) only need to hold the handle for
 * `detach()`.
 */
export interface StreamWriter {
  readonly res: ServerResponse;
  readonly hashedToken: string;
  readonly conversationId: string;
  lastActivityAt: number;
  closed: boolean;
}

/**
 * Minimal registry surface the coordinator consumes. Typed as a
 * structural interface rather than importing the concrete singleton so
 * tests can wire in a stub without touching shared module state.
 */
export interface ConversationStreamRegistryDeps {
  getActiveTurnForSession(sessionId: string): string | undefined;
  hasActiveTurnForSession(sessionId: string): boolean;
  subscribeTurnEvents(
    turnId: string,
    listener: (event: AgentEvent) => void,
  ): () => void;
  onTurnStartedForSession(
    sessionId: string,
    listener: (turnId: string) => void,
  ): () => void;
}

export interface ConversationStreamCoordinatorDeps {
  registry: ConversationStreamRegistryDeps;
  /** Test seam for wall-clock time. */
  now?: () => number;
  /** Test seam — override keepalive cadence. */
  keepaliveMs?: number;
  /** Test seam — override idle timeout. */
  idleTimeoutMs?: number;
}

/**
 * Per-conversation bookkeeping. Holds the registry subscriptions so we
 * can tear them down cleanly when the last writer for a conversation
 * disconnects.
 */
interface ConversationState {
  writers: Set<StreamWriter>;
  /** Unsubscribe from the *current* turn's event subscription, if any. */
  turnUnsubscribe: (() => void) | null;
  /** TurnId we're currently subscribed to (for bookkeeping only). */
  subscribedTurnId: string | null;
  /** Unsubscribe from session-level turn-start notifications. */
  sessionUnsubscribe: () => void;
  /** Per-conversation idle timer; closes all writers when no activity arrives. */
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Writes a single SSE frame (`event: <type>\ndata: <json>\n\n`) to the
 * response. Exported so the intent service can write the initial
 * `event: connected` frame before handing the writer to the coordinator
 * without duplicating the format.
 */
export function writeSSEFrame(
  res: ServerResponse,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Writes an SSE comment frame (`: <text>\n\n`). Used for keepalives. */
export function writeSSEComment(res: ServerResponse, comment: string): void {
  res.write(`: ${comment}\n\n`);
}

export interface ConversationStreamCoordinator {
  /**
   * Register a new SSE writer for `conversationId`. Subscribes to the
   * currently-active turn (if any) on first attach for this conversation,
   * and listens for subsequent turn starts via
   * `onTurnStartedForSession`.
   *
   * Returns the writer handle the caller uses with `detach()`.
   */
  attach(
    conversationId: string,
    res: ServerResponse,
    hashedToken: string,
  ): StreamWriter;

  /**
   * Remove a writer. Idempotent — safe to call multiple times from the
   * same close listener. When the last writer for a conversation
   * detaches, the coordinator tears down its turn event subscriptions.
   *
   * Does NOT call `res.end()` — the caller owns the response lifecycle
   * (e.g. the connection-close listener also fires, and we must avoid
   * writing to an already-ended stream).
   */
  detach(writer: StreamWriter): void;

  /**
   * Write an SSE frame to every writer for `conversationId`. Intended
   * for tests and for the intent service's initial-frame write. Fans out
   * the turn-event translation itself is done via the registry
   * subscription path (see `attach`).
   */
  broadcast(conversationId: string, event: string, data: unknown): void;

  /**
   * Close every writer whose hashedToken matches. Writes a final
   * `event: revoked` frame so the client can distinguish an intentional
   * close from a network drop, then ends the response. Idempotent.
   */
  closeAllForToken(hashedToken: string): void;

  /** Close every live writer. Used at graceful-shutdown time. */
  closeAll(): void;

  /** Diagnostic — current writer count across all conversations. */
  getWriterCount(): number;

  /** Diagnostic — writer count for a specific conversation. */
  getWriterCountForConversation(conversationId: string): number;
}

export function createConversationStreamCoordinator(
  deps: ConversationStreamCoordinatorDeps,
): ConversationStreamCoordinator {
  const { registry } = deps;
  const now = deps.now ?? (() => Date.now());
  const keepaliveMs = deps.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const conversations = new Map<string, ConversationState>();
  // Per-writer keepalive timers. Separate map so attach() can construct
  // the writer handle first and then wire up the timer without having to
  // thread the timer through the handle's public type.
  const writerKeepalives = new Map<StreamWriter, NodeJS.Timeout>();

  /**
   * Best-effort write; detaches the writer on failure. Returns `true`
   * when the write succeeded and the writer remains live.
   */
  function safeWrite(
    writer: StreamWriter,
    frame: 'event' | 'comment',
    eventOrComment: string,
    data?: unknown,
  ): boolean {
    if (writer.closed) return false;
    try {
      if (frame === 'event') {
        writeSSEFrame(writer.res, eventOrComment, data);
      } else {
        writeSSEComment(writer.res, eventOrComment);
      }
      writer.lastActivityAt = now();
      return true;
    } catch (err) {
      log.warn(
        {
          err,
          conversationId: writer.conversationId,
        },
        'SSE write failed — detaching writer',
      );
      detachWriter(writer, { end: true });
      return false;
    }
  }

  function clearKeepalive(writer: StreamWriter): void {
    const timer = writerKeepalives.get(writer);
    if (timer) {
      clearInterval(timer);
      writerKeepalives.delete(writer);
    }
  }

  function startKeepalive(writer: StreamWriter): void {
    const timer = setInterval(() => {
      if (writer.closed) {
        clearKeepalive(writer);
        return;
      }
      safeWrite(writer, 'comment', 'keepalive');
    }, keepaliveMs);
    timer.unref?.();
    writerKeepalives.set(writer, timer);
  }

  function scheduleIdleTimer(state: ConversationState, conversationId: string): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    const timer = setTimeout(() => {
      log.info(
        { conversationId, writerCount: state.writers.size },
        'Closing SSE writers after idle timeout',
      );
      // Close every writer for this conversation. Writers self-remove
      // via detachWriter; the conversation entry is torn down when the
      // last writer leaves.
      for (const writer of Array.from(state.writers)) {
        detachWriter(writer, { end: true });
      }
    }, idleTimeoutMs);
    timer.unref?.();
    state.idleTimer = timer;
  }

  function handleTurnEvent(
    conversationId: string,
    turnId: string,
    event: AgentEvent,
  ): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- AgentEvent is open at runtime (IPC/stream); this coordinator forwards a subset and the default is deliberately silent for the rest (client re-hydrates via /messages) — an exhaustive assertNever would throw on unknown/future events.
    switch (event.type) {
      case 'assistant_delta': {
        broadcast(conversationId, 'assistant_delta', {
          turnId,
          text: event.text,
        });
        return;
      }
      case 'tool': {
        if (event.stage === 'start') {
          broadcast(conversationId, 'tool_activity', {
            turnId,
            name: event.toolName,
            phase: 'start',
          });
        }
        return;
      }
      case 'result': {
        broadcast(conversationId, 'assistant_done', { turnId });
        return;
      }
      case 'error': {
        broadcast(conversationId, 'turn_error', {
          turnId,
          error: event.error,
        });
        return;
      }
      // Other event types are not forwarded in Stage 2. `turn_started`,
      // `user_question`, etc. are deliberately silent here — the client's state
      // is re-hydrated via /messages on reconnect and deltas cover the streaming
      // UX. AgentEvent is open at runtime (IPC/stream), so the default must
      // tolerate unknown/future types; an exhaustive assertNever would throw.
      // (Guard suppressed at the switch above.)
      default:
        // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- AgentEvent is open at runtime; default tolerates unknown/future event types (assertNever would throw -- see comment above).
        return;
    }
  }

  function subscribeToTurn(
    state: ConversationState,
    conversationId: string,
    turnId: string,
  ): void {
    if (state.subscribedTurnId === turnId) return;
    // Replace any previous subscription (the registry cleans up the
    // underlying subscriber set on turn cleanup, but unsubscribing
    // explicitly keeps ownership symmetrical).
    state.turnUnsubscribe?.();
    state.turnUnsubscribe = null;
    state.subscribedTurnId = null;

    try {
      const unsubscribe = registry.subscribeTurnEvents(turnId, (event) => {
        handleTurnEvent(conversationId, turnId, event);
      });
      state.turnUnsubscribe = unsubscribe;
      state.subscribedTurnId = turnId;
    } catch (err) {
      log.warn(
        { err, conversationId, turnId },
        'Failed to subscribe to turn events for SSE fan-out',
      );
    }
  }

  function detachWriter(
    writer: StreamWriter,
    options: { end: boolean },
  ): void {
    if (writer.closed) {
      // Still clean up timers defensively — we may be called twice from
      // overlapping close listeners.
      clearKeepalive(writer);
      const state = conversations.get(writer.conversationId);
      if (state) {
        state.writers.delete(writer);
        if (state.writers.size === 0) {
          tearDownConversation(writer.conversationId, state);
        }
      }
      return;
    }
    writer.closed = true;
    clearKeepalive(writer);

    const state = conversations.get(writer.conversationId);
    if (state) {
      state.writers.delete(writer);
      if (state.writers.size === 0) {
        tearDownConversation(writer.conversationId, state);
      }
    }

    if (options.end) {
      try {
        writer.res.end();
      } catch {
        // Already ended / socket dead — nothing else to do.
      }
    }
  }

  function tearDownConversation(conversationId: string, state: ConversationState): void {
    state.turnUnsubscribe?.();
    state.turnUnsubscribe = null;
    state.subscribedTurnId = null;
    state.sessionUnsubscribe();
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    conversations.delete(conversationId);
  }

  function broadcast(conversationId: string, event: string, data: unknown): void {
    const state = conversations.get(conversationId);
    if (!state) return;
    // Snapshot: safeWrite may detach a writer mid-iteration, which
    // mutates the underlying Set.
    const writers = Array.from(state.writers);
    for (const writer of writers) {
      safeWrite(writer, 'event', event, data);
    }
    // Activity resets the idle clock.
    scheduleIdleTimer(state, conversationId);
  }

  function attach(
    conversationId: string,
    res: ServerResponse,
    hashedToken: string,
  ): StreamWriter {
    const writer: StreamWriter = {
      res,
      hashedToken,
      conversationId,
      lastActivityAt: now(),
      closed: false,
    };

    let state = conversations.get(conversationId);
    if (!state) {
      state = {
        writers: new Set<StreamWriter>(),
        turnUnsubscribe: null,
        subscribedTurnId: null,
        // Session-level listener is installed for the life of the
        // conversation entry. New turns on this session auto-subscribe.
        sessionUnsubscribe: registry.onTurnStartedForSession(
          conversationId,
          (turnId) => {
            const currentState = conversations.get(conversationId);
            if (!currentState) return;
            subscribeToTurn(currentState, conversationId, turnId);
          },
        ),
        idleTimer: null,
      };
      conversations.set(conversationId, state);

      // If a turn is already active at attach time, subscribe immediately
      // so the very first writer doesn't miss the in-flight deltas.
      try {
        const activeTurnId = registry.getActiveTurnForSession(conversationId);
        if (activeTurnId) {
          subscribeToTurn(state, conversationId, activeTurnId);
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          'Failed to resolve active turn at SSE attach time',
        );
      }
    }

    state.writers.add(writer);
    startKeepalive(writer);
    scheduleIdleTimer(state, conversationId);

    return writer;
  }

  function closeAllForToken(hashedToken: string): void {
    if (typeof hashedToken !== 'string' || hashedToken.length === 0) return;
    let closed = 0;
    for (const state of conversations.values()) {
      const matching = Array.from(state.writers).filter(
        (w) => w.hashedToken === hashedToken,
      );
      for (const writer of matching) {
        // Best-effort final notice. We intentionally tolerate a write
        // failure here — the writer will be cleaned up either way.
        if (!writer.closed) {
          try {
            writeSSEFrame(writer.res, 'revoked', { reason: 'token_revoked' });
          } catch {
            // Writer already dead — detach below.
          }
        }
        detachWriter(writer, { end: true });
        closed += 1;
      }
    }
    if (closed > 0) {
      log.info({ closed }, 'Closed SSE writers for revoked token');
    }
  }

  function closeAll(): void {
    const allWriters: StreamWriter[] = [];
    for (const state of conversations.values()) {
      for (const writer of state.writers) {
        allWriters.push(writer);
      }
    }
    for (const writer of allWriters) {
      detachWriter(writer, { end: true });
    }
    // Defensive: tearDownConversation is called as writers leave, but
    // if a conversation entry somehow persisted (no writers), make sure
    // the session subscription isn't leaked.
    for (const [conversationId, state] of Array.from(conversations.entries())) {
      if (state.writers.size === 0) {
        tearDownConversation(conversationId, state);
      }
    }
  }

  function detach(writer: StreamWriter): void {
    detachWriter(writer, { end: false });
  }

  function getWriterCount(): number {
    let total = 0;
    for (const state of conversations.values()) {
      total += state.writers.size;
    }
    return total;
  }

  function getWriterCountForConversation(conversationId: string): number {
    return conversations.get(conversationId)?.writers.size ?? 0;
  }

  return {
    attach,
    detach,
    broadcast,
    closeAllForToken,
    closeAll,
    getWriterCount,
    getWriterCountForConversation,
  };
}
