/**
 * Agent Domain IPC Handlers
 *
 * Handles agent turn execution, stopping, and context compaction.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { logger } from '@core/logger';
import type { EventWindow } from '@core/types';
import { registerHandler } from './utils/registerHandler';
import type { AgentTurnRequest, AgentEvent, AppSettings, AgentTurnMessage, AgentSession } from '@shared/types';
import { generateCompactionSummary, generateIntelligentSummary } from '../services/compactionService';
import { buildEnhancedPromptWithWindow, sanitizeTaskContext } from '@core/utils/compactionUtils';
import { handleApprovalResponse, getPendingToolApprovalMetadata } from '../services/toolSafetyService';
import { getAutomationContext } from '../services/safety/automationContextLookup';
import { resolveItem } from '../services/safety/automationPendingItemsTracker';
import { getPendingApprovals } from '../services/safety/pendingApprovalsStore';
import { hasValidAuth } from '../utils/authEnvUtils';
import { classifySessionKind } from '@shared/sessionKind';

import {
  cacheAttachments,
  loadCachedAttachments,
  deleteCacheFiles,
} from '../services/attachmentCacheService';
import { evaluateDoneSafety } from '../services/doneSafetyService';
import { startAgentTurn, stopAgentTurn } from '../services/agentTurnService';
import { sessionCoachingScheduler } from '../services/sessionCoachingScheduler';
import {
  consumePendingPersonalisationPrefix,
  peekPendingPersonalisationPrefix,
} from '../services/pendingPersonalisationPrefixes';
import {
  findPersistedUserQuestionProvenance,
  registerUserQuestionResponseHandler,
  setUserQuestionProvenanceResolver,
} from '@core/services/userQuestionResponseHandler';
import { getIncrementalSessionStore } from '../services/incrementalSessionStore';
import { isAnyTurnActive } from '../services/visibilityAwareScheduler';
import type { AgentLoopOptions } from '@core/services/recovery/recoveryAdapter';

/**
 * Validate that any `systemPromptPrefix` carried on an `agent:turn` request
 * matches the trusted prefix recorded in main when an Operator personalisation
 * was initiated. Mismatched values (e.g. cloud-pushed event drift, stale
 * session re-runs) are dropped with a warning so the agent never sees an
 * unverified prefix. Matching values are evicted from the registry so the
 * prefix only applies to the first turn (turn-scoped).
 */
function enforceTrustedSystemPromptPrefix(request: AgentTurnRequest): AgentTurnRequest {
  const proposed = request.systemPromptPrefix;
  if (typeof proposed !== 'string' || proposed.length === 0) {
    consumePendingPersonalisationPrefix(request.sessionId);
    return request;
  }
  const trusted = peekPendingPersonalisationPrefix(request.sessionId);
  if (!trusted || trusted !== proposed) {
    logger.warn(
      {
        sessionId: request.sessionId,
        hasTrustedEntry: Boolean(trusted),
      },
      'agent:turn systemPromptPrefix did not match the trusted personalisation registry; dropping prefix.',
    );
    const { systemPromptPrefix: _drop, ...rest } = request;
    return rest as AgentTurnRequest;
  }
  consumePendingPersonalisationPrefix(request.sessionId);
  return request;
}

/** Broadcast tool approval resolved event to all renderer windows for real-time sync */
function broadcastToolApprovalResolved(toolUseID: string, sessionId: string | undefined, approved: boolean): void {
  broadcastTypedPayload(getBroadcastService(), 'tool-safety:approval-resolved', { toolUseID, sessionId, approved });
}

export interface AgentHandlerDeps {
  getWindowForEvent: (sender: Electron.WebContents) => BrowserWindow | null;
  executeAgentTurn: (
    win: EventWindow | null,
    turnId: string,
    prompt: string,
    options: {
      resetConversation?: boolean;
      sessionId: string;
      attachments?: AgentTurnRequest['attachments'];
      privateMode?: boolean;
      /** Override the model for this turn only */
      modelOverride?: string;
      /** Override the thinking model for this turn only */
      thinkingModelOverride?: string;
      /** Override the working profile for this turn only */
      workingProfileOverrideId?: string;
      /** Override the thinking profile for this turn only */
      thinkingProfileOverrideId?: string;
      /** Override the thinking effort for this turn only */
      thinkingEffortOverride?: import('@shared/types').ThinkingEffort;
      /** Lazy loader for agent sessions (for @conversations context injection) - only called if @conversations keyword is detected */
      loadSessions?: () => AgentSession[];
      /** Enable unleashed mode (looser auto-continue stopping criteria) for fire-and-forget tasks */
      unleashedMode?: boolean;
      /** User-set success criterion resolved at turn admission. See `docs/plans/260515_finish_line.md`. */
      finishLine?: string;
      /** Activate council mode for this turn */
      councilMode?: boolean;
      /** Active Space path for prompt-time Operator discovery scoping. */
      activeSpacePath?: string | null;
      /** Pre-created AbortController (from IPC handler to eliminate race condition) */
      existingAbortController?: AbortController;
      /**
       * Session type for executor routing.
       * - 'interactive': User is actively watching/interacting
       * - 'automation': Background task, skip heavy pre-turn logic
       */
      sessionType?: import('../services/promptTemplateService').SessionType;
      /**
       * When true, skips tool safety evaluation for this turn.
       * Used for automation runs that need to execute tools without user approval.
       */
      bypassToolSafety?: boolean;
      /** Get meeting companion context for tool hint injection */
      getMeetingCompanionContext?: (sessionId: string) => Promise<{
        currentCoachPath: string | null;
        lastInjectedCoachPath: string | null | undefined;
        coachSkillContent?: string;
      } | null>;
      /** Update lastInjectedCoachPath after injection */
      setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
    }
  ) => Promise<void>;
  executeAgentTurnWithRecovery?: (
    win: EventWindow | null,
    turnId: string,
    prompt: string,
    options: AgentLoopOptions,
  ) => Promise<void>;
  dispatchAgentEvent: (
    win: EventWindow | null,
    turnId: string,
    event: Exclude<AgentEvent, { type: 'error' | 'answer_phase_started' }>
  ) => void;
  getActiveTurnController: (turnId: string) => AbortController | undefined;
  /** Get the Query.close() callback for force-kill escalation */
  getTurnCloseCallback: (turnId: string) => (() => void) | undefined;
  deleteRendererSessionByTurn: (turnId: string) => void;
  /** Cancel any existing turn for a session (returns cancelled turnId if any) */
  cancelExistingTurnForSession: (sessionId: string) => string | undefined;
  /**
   * Probe for a session's active turn — required by the
   * `supersedePolicy: 'reject'` admission guard in startAgentTurn (a
   * queue-mode send must be refused, not supersede, when the target session
   * is busy). Same source of truth as cancelExistingTurnForSession.
   */
  getActiveTurnForSession: (sessionId: string) => string | undefined;
  getSettings: () => AppSettings;
  /** Load agent sessions for @conversations context injection */
  loadAgentSessions?: () => AgentSession[];
  /** Get meeting companion context for tool hint injection */
  getMeetingCompanionContext?: (sessionId: string) => Promise<{
    currentCoachPath: string | null;
    lastInjectedCoachPath: string | null | undefined;
    coachSkillContent?: string;
  } | null>;
  /** Update lastInjectedCoachPath after injection */
  setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
  /** Get Focus context for first-turn injection (calendar + goals). */
  getFocusContext?: (sessionId: string, origin?: string) => Promise<string | null>;
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const {
    getWindowForEvent,
    executeAgentTurn,
    executeAgentTurnWithRecovery,
    dispatchAgentEvent,
    getActiveTurnController,
    deleteRendererSessionByTurn,
    cancelExistingTurnForSession,
    getActiveTurnForSession,
    getSettings,
    loadAgentSessions,
    getMeetingCompanionContext,
    setLastInjectedCoachPath,
    getFocusContext,
  } = deps;

  registerHandler('agent:turn', async (event: IpcMainInvokeEvent, request: AgentTurnRequest) => {
    const win = getWindowForEvent(event.sender);

    const trustedRequest = enforceTrustedSystemPromptPrefix(request);

    // Delegate all orchestration to shared service (used by both IPC and cloud socket shim)
    const { turnId } = startAgentTurn(
      {
        executeAgentTurn,
        executeAgentTurnWithRecovery,
        dispatchAgentEvent,
        deleteRendererSessionByTurn,
        cancelExistingTurnForSession,
        getActiveTurnForSession,
        isActiveTurnId: (turnId: string) => getActiveTurnController(turnId) !== undefined,
        loadAgentSessions,
        getMeetingCompanionContext,
        setLastInjectedCoachPath,
        getFocusContext,
        onSessionActive: (sessionId) => sessionCoachingScheduler.markSessionActive(sessionId),
      },
      trustedRequest,
      win,
    );

    return { turnId };
  });

  registerHandler('agent:stop-turn', async (_event: IpcMainInvokeEvent, turnId: string) => {
    if (!turnId || typeof turnId !== 'string') {
      throw new Error('Invalid turn ID provided for stop operation.');
    }

    const result = stopAgentTurn(turnId);
    if (result.status === 'not_found') {
      logger.warn({ turnId }, 'Attempted to stop non-existent or already completed turn');
      return { success: false, reason: 'Agent turn not found or already completed' };
    }
    return { success: true };
  });

  registerHandler(
    'agent:generate-summary',
    async (
      _event: IpcMainInvokeEvent,
      request: { messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string }>; largeToolNames?: string[] }
    ) => {
      const { messages, largeToolNames } = request;

      if (!Array.isArray(messages) || messages.length === 0) {
        return { summary: null, error: 'No messages provided for summary generation' };
      }

      const settings = getSettings();
      if (!hasValidAuth(settings)) {
        return { summary: null, error: 'Claude authentication not configured' };
      }

      try {
        logger.info({ messageCount: messages.length, largeToolNames }, 'Generating compaction summary');

        const agentMessages: AgentTurnMessage[] = messages.map((m, index) => ({
          id: `summary-msg-${index}`,
          turnId: 'summary-turn',
          role: m.role,
          text: m.text,
          createdAt: Date.now(),
        }));

        const summary = await generateCompactionSummary(settings, agentMessages, largeToolNames);

        if (!summary) {
          return { summary: null, error: 'Failed to generate summary' };
        }

        logger.info({ summaryLength: summary.length }, 'Compaction summary generated successfully');
        return { summary };
      } catch (error: unknown) {
        logger.error({ err: error }, 'Error generating compaction summary');
        return { summary: null, error: error instanceof Error ? error.message : 'Unknown error generating summary' };
      }
    }
  );

  registerHandler(
    'agent:generate-intelligent-summary',
    async (
      _event: IpcMainInvokeEvent,
      request: {
        messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string; turnId?: string }>;
        originalPrompt: string;
        depth: number;
      }
    ) => {
      const { messages, originalPrompt, depth } = request;

      if (!Array.isArray(messages) || messages.length === 0) {
        return { summary: null, enhancedPrompt: null, error: 'No messages provided for intelligent summary' };
      }

      const settings = getSettings();
      if (!hasValidAuth(settings)) {
        return { summary: null, enhancedPrompt: null, error: 'Claude authentication not configured' };
      }

      try {
        logger.info(
          { messageCount: messages.length, depth },
          'Generating intelligent compaction summary'
        );

        const agentMessages: AgentTurnMessage[] = messages.map((m, index) => ({
          id: `summary-msg-${index}`,
          turnId: m.turnId || 'summary-turn',
          role: m.role,
          text: m.text,
          createdAt: Date.now(),
        }));

        // Extract task context from first non-empty user message
        const taskContextRaw =
          agentMessages.find((m) => m.role === 'user' && m.text.trim().length > 0)?.text
          ?? originalPrompt;
        const taskContext = sanitizeTaskContext(taskContextRaw);

        const { olderSummary, recentMessages } = await generateIntelligentSummary(
          agentMessages,
          { settings, taskContext, depth }
        );

        // Build the enhanced prompt on the main process side (renderer can't import @core utils)
        const enhancedPrompt = buildEnhancedPromptWithWindow(
          originalPrompt,
          olderSummary,
          recentMessages,
          depth,
          [] // Renderer path doesn't have tool-specific suggestions
        );

        logger.info(
          { summaryLength: olderSummary.length, enhancedPromptLength: enhancedPrompt.length, depth },
          'Intelligent compaction summary generated successfully'
        );

        return { summary: olderSummary, enhancedPrompt };
      } catch (error: unknown) {
        logger.error({ err: error }, 'Error generating intelligent compaction summary');
        return {
          summary: null,
          enhancedPrompt: null,
          error: error instanceof Error ? error.message : 'Unknown error generating intelligent summary',
        };
      }
    }
  );

  registerHandler(
    'agent:tool-safety-response',
    async (
      _event: IpcMainInvokeEvent,
      request: { toolUseID: string; approved: boolean; input: Record<string, unknown> }
    ) => {
      const { toolUseID, approved, input } = request;

      if (!toolUseID || typeof toolUseID !== 'string') {
        logger.error({ toolUseID }, 'Invalid toolUseID in tool safety response');
        return { success: false, clearedCount: 0 };
      }

      // Guard: check if this approval was already auto-resolved by approvalReEvalService.
      // After a Safety Prompt update, re-eval runs asynchronously and may resolve pending
      // approvals before the renderer's IPC arrives. Skip to avoid duplicate continuations.
      const stillPending = getPendingApprovals().some((p) => p.toolUseID === toolUseID);
      if (!stillPending) {
        logger.info(
          { toolUseID },
          'Approval already resolved (likely by auto re-eval) — skipping duplicate'
        );
        return { success: true, clearedCount: 0 };
      }

      // Get full metadata BEFORE handling (handleApprovalResponse cleans up the metadata)
      const metadata = getPendingToolApprovalMetadata(toolUseID);
      const sessionId = metadata?.sessionId;

      logger.info(
        { toolUseID, approved, sessionId },
        'Received tool safety response from renderer'
      );

      handleApprovalResponse(toolUseID, approved, input);

      // Track resolution in automation pending items tracker (deny-then-retry items)
      const sessionKind = sessionId ? classifySessionKind(sessionId) : null;
      if (sessionId && (sessionKind === 'automation' || sessionKind === 'automation-insight')) {
        const automationContext = getAutomationContext(sessionId);
        if (automationContext) {
          resolveItem(automationContext.automationId, toolUseID, approved ? 'approved' : 'rejected');
        }
      }

      // Broadcast resolved event to all windows for real-time sync across surfaces
      broadcastToolApprovalResolved(toolUseID, sessionId, approved);

      return { success: true, clearedCount: 0 };
    }
  );

  // Attachment cache handlers for network reconnect resume
  registerHandler(
    'agent:cache-attachments',
    async (
      _event: IpcMainInvokeEvent,
      request: { attachments: AgentTurnRequest['attachments'] }
    ) => {
      const { attachments } = request;

      if (!attachments || attachments.length === 0) {
        return { cacheIds: [] };
      }

      const cacheIds = await cacheAttachments(attachments);
      logger.info(
        { count: cacheIds.length },
        'Cached attachments for network reconnect resume'
      );
      return { cacheIds };
    }
  );

  registerHandler(
    'agent:load-cached-attachments',
    async (
      _event: IpcMainInvokeEvent,
      request: { cacheIds: string[] }
    ) => {
      const { cacheIds } = request;

      if (!cacheIds || cacheIds.length === 0) {
        return { results: [] };
      }

      const results = await loadCachedAttachments(cacheIds);
      logger.info(
        { requested: cacheIds.length, successful: results.filter((r) => r.success).length },
        'Loaded cached attachments'
      );
      return { results };
    }
  );

  registerHandler(
    'agent:delete-cached-attachments',
    async (
      _event: IpcMainInvokeEvent,
      request: { cacheIds: string[] }
    ) => {
      const { cacheIds } = request;

      if (!cacheIds || cacheIds.length === 0) {
        return { success: true };
      }

      await deleteCacheFiles(cacheIds);
      logger.debug({ count: cacheIds.length }, 'Deleted cached attachments');
      return { success: true };
    }
  );

  registerHandler(
    'agent:evaluate-done-safety',
    async (
      _event: IpcMainInvokeEvent,
      request: { lastUserMessage: string; responseText: string }
    ) => {
      const settings = getSettings();

      if (!hasValidAuth(settings)) {
        logger.warn('Cannot evaluate done safety - no valid auth');
        return {
          safeToMarkDone: false,
          reason: 'No API key or OAuth token available',
        };
      }

      const result = await evaluateDoneSafety(
        settings,
        request
      );

      logger.debug(
        { safeToMarkDone: result.safeToMarkDone, reason: result.reason },
        'Done safety evaluation complete'
      );

      return result;
    }
  );

  // Prompt cache warmup handler
  registerHandler(
    'agent:warm-cache',
    async (_event: IpcMainInvokeEvent) => {
      const settings = getSettings();

      // Import warmup service lazily to avoid circular dependency
      const { warmPromptCache, isCacheExpired, isInFailureCooldown } = await import('../services/promptCacheWarmupService');

      // Double-check cache hasn't warmed since request was queued
      if (!isCacheExpired()) {
        logger.debug('Cache warmup skipped - cache is still warm');
        return { success: true };
      }

      // Skip if we recently failed (prevents rapid retries on persistent failures)
      if (isInFailureCooldown()) {
        logger.debug('Cache warmup skipped - in failure cooldown');
        return { success: false, error: 'In cooldown after recent failure' };
      }

      // Stage 6 (260508): skip warm-up while a turn is in flight; the next
      // composer focus or explicit retry will warm a fresh cache once idle.
      if (isAnyTurnActive()) {
        logger.debug('Cache warmup skipped - active agent turn in flight');
        return { success: false, error: 'Active agent turn in flight' };
      }

      logger.info('Starting prompt cache warmup from IPC');
      const result = await warmPromptCache(settings);

      if (result.success) {
        logger.info('Prompt cache warmup completed successfully');
      } else {
        logger.warn({ error: result.error }, 'Prompt cache warmup failed');
      }

      return result;
    }
  );

  // User question response handler (AskUserQuestion deny-and-retry continuation).
  // The handler body now lives in @core/services/userQuestionResponseHandler so
  // cloud-service can reuse it via /api/ipc/agent:user-question-response.
  // See docs/plans/260420_user_question_cross_surface_resilience.md (Stage 3a).
  setUserQuestionProvenanceResolver(async (sessionId, turnId, batchId) => {
    const session = await getIncrementalSessionStore().getSession(sessionId);
    const turnEvents = session?.eventsByTurn?.[turnId] ?? [];
    return findPersistedUserQuestionProvenance(turnEvents, sessionId, batchId);
  });
  registerUserQuestionResponseHandler();
}
