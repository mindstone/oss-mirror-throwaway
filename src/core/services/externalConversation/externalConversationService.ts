/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader)
 *  - Adapter-shaped extension point (§2 success criteria)
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { AgentEvent, AgentSession } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { type ConversationScopeResolver } from './conversationScopeResolver';
import type { ExternalContext } from './externalContext';
import { getOriginForExternalContext } from '@rebel/shared';
import type { ExternalConversationAdapter } from './externalConversationAdapter';

const log = createScopedLogger({ service: 'externalConversationService' });

const MAX_BUFFERED_PER_CONVERSATION = 50;
const MAX_TEXT_LEN = 16_000;
const CREATE_SESSION_MATERIALIZE_RETRY_DELAYS_MS = [0, 25, 50, 100, 200, 400] as const;

type SessionStoreUpdateSession = (
  sessionId: string,
  mutator: (existing: AgentSession | null) => AgentSession | null,
) => Promise<boolean>;
type PersistExternalContextOutcome = 'updated' | 'noop' | 'missing';

function appIdForExternalContext(ctx: ExternalContext): 'browser-extension' | 'office-addin' | 'slack' {
  switch (ctx.kind) {
    case 'browser-tab':
      return 'browser-extension';
    case 'office-document':
      return 'office-addin';
    case 'slack-thread':
    case 'slack-mention-poll':
      return 'slack';
  }
}

/**
 * `getOriginForExternalContext` lives in `@rebel/shared` so all broadcast
 * sites (this service, agentTurnSubmissionService, slackWebhook replays)
 * stay on the same mapping without duplicating the switch.
 */

export interface BufferedMessage {
  id: string;
  context: ExternalContext;
  text: string;
  receivedAt: number;
}

export interface ExternalConversationServiceDeps {
  broadcast: BroadcastService;
  errorReporter: ErrorReporter;
  agentTurnRegistry: any; // using any temporarily to avoid tight coupling in types if not imported correctly
  conversationScopeResolver: ConversationScopeResolver;
  sessionStore: {
    getSession(id: string): Promise<Pick<AgentSession, 'id'> & Partial<AgentSession> | null>;
    updateSession: SessionStoreUpdateSession;
  };
  uuid?: () => string;
  now?: () => number;
  streamCoordinator?: any;
  adapters: Map<string, ExternalConversationAdapter<any>>;
}

export interface CreateConversationOpts {
  intent?: string;
  userText?: string;
  pageContext?: { title?: string; url?: string; selection?: string; text?: string };
  switchToConversation?: boolean;
  /**
   * Replay provenance for inbound contexts surfaced from the Slack pending log.
   * When `replayed: true`, broadcast carries age/timestamp so the renderer can
   * decide whether to surface a "delayed" notice on the resulting conversation.
   */
  replayMetadata?: { replayed: boolean; ageMs?: number; replayedAt?: number };
}

export interface InjectMessageArgs {
  conversationId: string;
  context: ExternalContext;
  text: string;
  canBindContext?: boolean;
  replayMetadata?: { replayed: boolean; ageMs?: number; replayedAt?: number };
}

export interface ExternalConversationService {
  createConversation(ctx: ExternalContext, opts?: CreateConversationOpts): Promise<{ conversationId: string; isNewConversation: boolean; state: string }>;
  injectMessage(args: InjectMessageArgs): Promise<{ conversationId: string; messageId: string; state: string; queueSize: number }>;
  getState(conversationId: string): Promise<{ conversationId: string; turnStatus: 'running' | 'idle'; pendingMessages: number; lastAssistantAt: number | null }>;
  getMessages(conversationId: string): Promise<{ conversationId: string; messages: any[]; turnStatus: 'running' | 'idle'; conversationTitle?: string }>;
  streamConversation(conversationId: string, req: IncomingMessage, res: ServerResponse, hashedToken: string): Promise<void>;
  focusConversation(conversationId: string): Promise<{ conversationId: string; focused: boolean }>;
  drainBuffer(conversationId: string): BufferedMessage[];
  getBufferSize(conversationId: string): number;
  reset(): void;
}

// Minimal port of appBridgeIntentService.ts core logic
export function createExternalConversationService(deps: ExternalConversationServiceDeps): ExternalConversationService {
  const registry = deps.agentTurnRegistry;
  const uuid = deps.uuid ?? randomUUID;
  const now = deps.now ?? (() => Date.now());
  const getSession = deps.sessionStore.getSession.bind(deps.sessionStore);
  const updateSession = deps.sessionStore.updateSession.bind(deps.sessionStore);

  const pendingBuffer = new Map<string, BufferedMessage[]>();
  const lastAssistantAtByConversation = new Map<string, number>();
  const drainRegisteredForTurn = new Set<string>();
  const drainTriggeredForTurn = new Set<string>();
  const turnEndedUnsubscribers = new Map<string, () => void>();

  function getAdapter(kind: string): ExternalConversationAdapter<any> {
    const adapter = deps.adapters.get(kind);
    if (!adapter) {
      const err = new Error(`No adapter registered for external context kind: ${kind}`);
      (err as any).code = 'INTERNAL_ERROR';
      (err as any).status = 500;
      throw err;
    }
    return adapter;
  }

  function externalContextsMatch(a: ExternalContext | undefined, b: ExternalContext): boolean {
    return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
  }

  async function persistExternalContextToSession(args: {
    conversationId: string;
    turnId?: string | null;
    context: ExternalContext;
    phase: 'createConversation' | 'injectMessage';
  }): Promise<void> {
    const { conversationId, context, phase } = args;

    if (context.kind !== 'slack-thread' && context.kind !== 'slack-mention-poll') {
      return;
    }

    const outcome: { value: PersistExternalContextOutcome } = { value: 'missing' };
    let persistedTurnId: string | null = args.turnId ?? null;

    try {
      await updateSession(conversationId, (session) => {
        if (!session) {
          outcome.value = 'missing';
          return null;
        }

        persistedTurnId = session.activeTurnId ?? persistedTurnId;
        if (externalContextsMatch(session.externalContext, context)) {
          outcome.value = 'noop';
          return null;
        }

        outcome.value = 'updated';
        const previousUpdatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
        return {
          ...session,
          externalContext: context,
          updatedAt: Math.max(previousUpdatedAt + 1, now()),
        };
      });

      if (outcome.value === 'updated') {
        log.info(
          { conversationId, turnId: persistedTurnId, kind: context.kind, phase },
          'Persisted external conversation context to session',
        );
      } else if (outcome.value === 'noop') {
        log.debug(
          { conversationId, turnId: persistedTurnId, kind: context.kind, phase },
          'External conversation context already persisted on session',
        );
      } else {
        log.warn(
          { conversationId, turnId: persistedTurnId, kind: context.kind, phase },
          'Could not persist external conversation context because session was not found',
        );
      }
    } catch (err) {
      log.warn(
        { err, conversationId, turnId: persistedTurnId, kind: context.kind, phase },
        'Failed to persist external conversation context to session',
      );
    }
  }

  async function createConversation(ctx: ExternalContext, opts: CreateConversationOpts = {}) {
    const adapter = getAdapter(ctx.kind);
    const { conversationId, isNewConversation } = deps.conversationScopeResolver.resolve(ctx, uuid());

    if (adapter.assertContextCanBind) {
      const existingBinding = deps.conversationScopeResolver.getBinding(conversationId);
      adapter.assertContextCanBind(conversationId, ctx, existingBinding?.context);
    }
    deps.conversationScopeResolver.bindConversation(conversationId, ctx);

    let initialText = '';
    if (adapter.formatInitialPrompt) {
      initialText = adapter.formatInitialPrompt({ intent: opts.intent, userText: opts.userText, context: ctx, pageContext: opts.pageContext }).slice(0, MAX_TEXT_LEN);
    }

    deps.errorReporter.addBreadcrumb({
      category: 'external-conversation',
      level: 'info',
      message: 'intent-create-conversation',
      data: {
        kind: ctx.kind,
        intent: opts.intent,
        conversationId,
        hasSelection: Boolean(opts.pageContext?.selection?.trim().length),
      },
    });

    const focus = opts.switchToConversation ?? true;
    const broadcastOrigin = getOriginForExternalContext(ctx);

    try {
      deps.broadcast.sendToAllWindows('conversations:start-requested', {
        sessionId: conversationId,
        text: initialText,
        sendMessage: true,
        switchToConversation: focus,
        ...(broadcastOrigin ? { origin: broadcastOrigin } : {}),
        ...(ctx.kind === 'slack-thread' || ctx.kind === 'slack-mention-poll' ? { externalContext: ctx } : {}),
        ...(opts.replayMetadata ? { replayMetadata: opts.replayMetadata } : {}),
      });

      // Maintain legacy AppBridge broadcast if required.
      // Let's emit intent:external-context-arrived as well for parity.
      const docCtx: any = { host: (ctx.identity as any).host };
      if ((ctx.metadata as any)?.title) docCtx.title = (ctx.metadata as any).title;
      if ((ctx.metadata as any)?.url) docCtx.url = (ctx.metadata as any).url;

      deps.broadcast.sendToAllWindows('intent:external-context-arrived', {
        sessionId: conversationId,
        appId: appIdForExternalContext(ctx),
        intent: opts.intent,
        initialText,
        tabContext: ctx.kind === 'browser-tab' ? (ctx as any).metadata : undefined, // Compatibility shape
        documentContext: ctx.kind === 'office-document' ? docCtx : undefined,
        externalContext: ctx,
        focus,
        receivedAt: now(),
      });
    } catch (err) {
      log.error({ err, conversationId, kind: ctx.kind }, 'createConversation broadcast failed');
      deps.errorReporter.captureException(err, { area: 'external-conversation', phase: 'create-broadcast', conversationId });
      const error = new Error('Could not deliver the intent to the Rebel window.');
      (error as any).code = 'INTERNAL_ERROR';
      (error as any).status = 500;
      throw error;
    }

    const materialized = await waitForSessionMaterialized(conversationId);
    if (!materialized) {
      log.error(
        {
          event: 'external_conversation_session_not_materialized',
          conversationId,
          kind: ctx.kind,
          phase: 'createConversation',
          retryDelaysMs: CREATE_SESSION_MATERIALIZE_RETRY_DELAYS_MS,
        },
        'External conversation session did not materialize before retry budget; externalContext was not persisted.',
      );
      deps.errorReporter.addBreadcrumb({
        category: 'external-conversation',
        level: 'warning',
        message: 'intent-create-session-not-yet-materialized',
        data: { conversationId },
      });
    } else {
      await persistExternalContextToSession({
        conversationId,
        context: ctx,
        phase: 'createConversation',
      });
    }

    return { conversationId, isNewConversation, state: 'new' };
  }

  async function waitForSessionMaterialized(conversationId: string): Promise<boolean> {
    for (const delay of CREATE_SESSION_MATERIALIZE_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      const session = await getSession(conversationId);
      if (session) return true;
    }
    return false;
  }

  async function injectMessage(args: InjectMessageArgs) {
    const { conversationId, context: ctx, text } = args;
    if (!conversationId) {
      const err = new Error('Missing conversationId.');
      (err as any).code = 'BAD_REQUEST';
      (err as any).status = 400;
      throw err;
    }

    const session = await getSession(conversationId);
    if (!session) {
      const err = new Error(`No Rebel conversation exists with id ${conversationId}.`);
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }

    const adapter = getAdapter(ctx.kind);
    const canBindContext = args.canBindContext ?? true;
    if (canBindContext && adapter.assertContextCanBind) {
      const existingBinding = deps.conversationScopeResolver.getBinding(conversationId);
      adapter.assertContextCanBind(conversationId, ctx, existingBinding?.context);
    }
    if (canBindContext) {
      deps.conversationScopeResolver.bindConversation(conversationId, ctx);
    }

    const messageId = uuid();
    const receivedAt = now();
    const slicedText = text.slice(0, MAX_TEXT_LEN);

    const isActive = registry.hasActiveTurnForSession(conversationId);
    if (!isActive) {
      deps.errorReporter.addBreadcrumb({
        category: 'external-conversation',
        level: 'info',
        message: 'intent-message-submitted',
        data: { conversationId, messageId, bytes: Buffer.byteLength(slicedText, 'utf8') },
      });
      const injectOrigin = getOriginForExternalContext(ctx);
      try {
        deps.broadcast.sendToAllWindows('conversations:start-requested', {
          sessionId: conversationId,
          text: slicedText,
          sendMessage: true,
          switchToConversation: false,
          ...(injectOrigin ? { origin: injectOrigin } : {}),
          ...(ctx.kind === 'slack-thread' || ctx.kind === 'slack-mention-poll' ? { externalContext: ctx } : {}),
          ...(args.replayMetadata ? { replayMetadata: args.replayMetadata } : {}),
        });
      } catch (err) {
        deps.errorReporter.captureException(err, { area: 'external-conversation', phase: 'inject-broadcast', conversationId, messageId });
        const error = new Error('Could not deliver the message to the Rebel window.');
        (error as any).code = 'INTERNAL_ERROR';
        (error as any).status = 500;
        throw error;
      }
      await persistExternalContextToSession({
        conversationId,
        turnId: session.activeTurnId,
        context: ctx,
        phase: 'injectMessage',
      });
      return { conversationId, messageId, state: 'submitted', queueSize: 0 };
    }

    const existing = pendingBuffer.get(conversationId) ?? [];
    if (existing.length >= MAX_BUFFERED_PER_CONVERSATION) {
      const err = new Error(`Too many pending messages for conversation ${conversationId}. Let Rebel finish the current task first.`);
      (err as any).code = 'RATE_LIMITED';
      (err as any).status = 429;
      throw err;
    }

    existing.push({ id: messageId, context: ctx, text: slicedText, receivedAt });
    pendingBuffer.set(conversationId, existing);

    const activeTurnId = registry.getActiveTurnForSession(conversationId);
    if (activeTurnId) registerDrainListener(conversationId, activeTurnId);

    const docCtx: any = { host: (ctx.identity as any)?.host };
    if ((ctx.metadata as any)?.title) docCtx.title = (ctx.metadata as any).title;
    if ((ctx.metadata as any)?.url) docCtx.url = (ctx.metadata as any).url;

    try {
      deps.broadcast.sendToAllWindows('intent:buffered-message', {
        sessionId: conversationId,
        appId: appIdForExternalContext(ctx),
        messageId,
        text: slicedText,
        receivedAt,
        queueSize: existing.length,
        documentContext: ctx.kind === 'office-document' ? docCtx : undefined,
        externalContext: ctx,
      });
    } catch (err) {
      log.warn({ err, sessionId: conversationId, intentId: messageId }, 'Failed to broadcast intent:buffered-message');
    }

    await persistExternalContextToSession({
      conversationId,
      turnId: activeTurnId,
      context: ctx,
      phase: 'injectMessage',
    });

    return { conversationId, messageId, state: 'buffered', queueSize: existing.length };
  }

  function queueDrain(conversationId: string, turnId: string): void {
    if (drainTriggeredForTurn.has(turnId)) return;
    drainTriggeredForTurn.add(turnId);
    drainRegisteredForTurn.delete(turnId);
    turnEndedUnsubscribers.get(turnId)?.();
    turnEndedUnsubscribers.delete(turnId);
    queueMicrotask(() => drainForConversation(conversationId));
  }

  function registerDrainListener(conversationId: string, turnId: string): void {
    if (drainRegisteredForTurn.has(turnId)) return;
    drainRegisteredForTurn.add(turnId);

    // Use subscribeTurnEvents for multi-listener support when available; keep
    // a legacy setEventListener fallback for older test doubles.
    const listener = (event: AgentEvent) => {
      if (event.type === 'assistant_delta' || event.type === 'assistant') {
        lastAssistantAtByConversation.set(conversationId, now());
      }
      // Spec invariant: broadcast MUST carry provenance. This handles outbound broadcasts.
      // E.g. event stream sending. (We append `originalSessionId` if needed, done in adapter or AppBridge wrapper)
      
      if (event.type === 'result' || event.type === 'error') {
        lastAssistantAtByConversation.set(conversationId, now());
        queueDrain(conversationId, turnId);
      }
    };

    const unsubscribeEvents = typeof registry.subscribeTurnEvents === 'function'
      ? registry.subscribeTurnEvents(turnId, listener)
      : (() => {
        registry.setEventListener(turnId, listener);
        return undefined;
      })();

    const unsubscribeTurnEnded = registry.onTurnEnded?.(turnId, () => {
      queueDrain(conversationId, turnId);
    });

    turnEndedUnsubscribers.set(turnId, () => {
      unsubscribeEvents?.();
      unsubscribeTurnEnded?.();
    });
  }

  function drainForConversation(conversationId: string): BufferedMessage[] {
    const buffered = pendingBuffer.get(conversationId) ?? [];
    if (buffered.length === 0) return [];
    pendingBuffer.delete(conversationId);

    for (const msg of buffered) {
      const drainOrigin = getOriginForExternalContext(msg.context);
      try {
        deps.broadcast.sendToAllWindows('conversations:start-requested', {
          sessionId: conversationId,
          text: msg.text,
          sendMessage: true,
          switchToConversation: false,
          ...(drainOrigin ? { origin: drainOrigin } : {}),
          ...(msg.context.kind === 'slack-thread' || msg.context.kind === 'slack-mention-poll' ? { externalContext: msg.context } : {}),
        });
      } catch (err) {
        deps.errorReporter.captureException(err, { area: 'external-conversation', phase: 'drain-replay', conversationId });
      }
    }

    try {
      deps.broadcast.sendToAllWindows('intent:buffer-drained', {
        sessionId: conversationId,
        flushedIds: buffered.map(m => m.id),
        remaining: pendingBuffer.get(conversationId)?.length ?? 0,
        drainedAt: now(),
      });
    } catch (err) {
      log.warn({ err, sessionId: conversationId, intentIds: buffered.map(m => m.id) }, 'Failed to broadcast intent:buffer-drained');
    }
    
    return buffered;
  }

  async function getState(conversationId: string) {
    if (!conversationId) {
      const err = new Error('Missing conversationId.');
      (err as any).code = 'BAD_REQUEST';
      (err as any).status = 400;
      throw err;
    }
    const session = await getSession(conversationId);
    if (!session) {
      const err = new Error(`No Rebel conversation exists with id ${conversationId}.`);
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }

    const pendingMessages = pendingBuffer.get(conversationId)?.length ?? 0;
    const isActive = registry.hasActiveTurnForSession(conversationId);
    const lastAssistantAt = lastAssistantAtByConversation.get(conversationId) ?? null;

    return { conversationId, turnStatus: isActive ? 'running' : 'idle' as 'running' | 'idle', pendingMessages, lastAssistantAt };
  }

  // To prevent external dependencies on `selectVisibleMessages` making it hard to compile,
  // I will just pass through the messages array, the wrapper can map them if necessary.
  // However, I need to keep functionality the same.
  async function getMessages(conversationId: string) {
    if (!conversationId) {
      const err = new Error('Missing conversationId.');
      (err as any).code = 'BAD_REQUEST';
      (err as any).status = 400;
      throw err;
    }
    const session = await getSession(conversationId);
    if (!session) {
      const err = new Error(`No Rebel conversation exists with id ${conversationId}.`);
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }

    const isActive = registry.hasActiveTurnForSession(conversationId);
    return {
      conversationId,
      messages: session.messages || [],
      turnStatus: isActive ? 'running' : 'idle' as 'running' | 'idle',
      ...(session.title ? { conversationTitle: session.title } : {}),
    };
  }

  async function streamConversation(conversationId: string, req: IncomingMessage, res: ServerResponse, hashedToken: string) {
    if (!conversationId) {
      const err = new Error('Missing conversationId.');
      (err as any).code = 'BAD_REQUEST';
      (err as any).status = 400;
      throw err;
    }
    if (!deps.streamCoordinator) {
      const err = new Error('Conversation streaming is not available on this Rebel install.');
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }
    const session = await getSession(conversationId);
    if (!session) {
      const err = new Error(`No Rebel conversation exists with id ${conversationId}.`);
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();

    const writer = deps.streamCoordinator.attach(conversationId, res, hashedToken);
    const turnStatus = registry.hasActiveTurnForSession(conversationId) ? 'running' : 'idle';
    
    try {
      res.write(`event: connected\ndata: ${JSON.stringify({ conversationId, turnStatus })}\n\n`);
    } catch {
      deps.streamCoordinator.detach(writer);
      try {
        res.end();
      } catch (endErr) {
        // Stream already closed by client; expected race condition.
        log.debug({ err: endErr, sessionId: conversationId }, 'Stream already closed when calling res.end()');
      }
      return;
    }

    const onClose = () => deps.streamCoordinator.detach(writer);
    req.on('close', onClose);
    res.on('close', onClose);
  }

  async function focusConversation(conversationId: string) {
    if (!conversationId) {
      const err = new Error('Missing conversationId.');
      (err as any).code = 'BAD_REQUEST';
      (err as any).status = 400;
      throw err;
    }
    const session = await getSession(conversationId);
    if (!session) {
      const err = new Error(`No Rebel conversation exists with id ${conversationId}.`);
      (err as any).code = 'CAPABILITY_NOT_SUPPORTED';
      (err as any).status = 404;
      throw err;
    }

    deps.errorReporter.addBreadcrumb({
      category: 'external-conversation',
      level: 'info',
      message: 'intent-focus-conversation',
      data: { conversationId },
    });

    // Derive origin from the session's externalContext when available so a
    // Slack-thread focus doesn't masquerade as browser-extension.
    const focusOrigin = session.externalContext
      ? getOriginForExternalContext(session.externalContext) ?? session.origin ?? 'browser-extension'
      : session.origin ?? 'browser-extension';
    try {
      deps.broadcast.sendToAllWindows('conversations:start-requested', {
        sessionId: conversationId,
        text: '',
        sendMessage: false,
        switchToConversation: true,
        origin: focusOrigin,
        ...(session.externalContext ? { externalContext: session.externalContext } : {}),
      });
    } catch (err) {
      log.error({ err, conversationId }, 'focusConversation broadcast failed');
      deps.errorReporter.captureException(err, { area: 'external-conversation', phase: 'focus-broadcast', conversationId });
      const error = new Error('Could not deliver the focus request to the Rebel window.');
      (error as any).code = 'INTERNAL_ERROR';
      (error as any).status = 500;
      throw error;
    }

    return { conversationId, focused: true };
  }

  function drainBuffer(conversationId: string) {
    return drainForConversation(conversationId);
  }

  function getBufferSize(conversationId: string) {
    return pendingBuffer.get(conversationId)?.length ?? 0;
  }

  function reset() {
    pendingBuffer.clear();
    lastAssistantAtByConversation.clear();
    drainRegisteredForTurn.clear();
    drainTriggeredForTurn.clear();
    for (const unsubscribe of turnEndedUnsubscribers.values()) unsubscribe();
    turnEndedUnsubscribers.clear();
  }

  return {
    createConversation,
    injectMessage,
    getState,
    getMessages,
    streamConversation,
    focusConversation,
    drainBuffer,
    getBufferSize,
    reset,
  };
}
