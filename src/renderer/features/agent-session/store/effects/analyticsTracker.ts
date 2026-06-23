import { tracking, trackFirstRealTaskIfNeeded } from '@renderer/src/tracking';
import type { AgentEvent } from '@shared/types';

export const trackMessageSent = (params: {
  source: 'text' | 'voice';
  sessionId: string;
  hasAttachments: boolean;
  attachmentCount: number;
  isEdit: boolean;
  charCount: number;
}): void => {
  tracking.chat.messageSent(params);
};

export const trackTurnCompleted = (
  turnId: string,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'result' }>,
  durationMs: number
): void => {
  tracking.chat.turnCompleted({
    turnId,
    sessionId,
    durationMs,
    model: event.model ?? undefined,
    inputTokens: event.usage?.inputTokens ?? undefined,
    outputTokens: event.usage?.outputTokens ?? undefined,
    cacheReadTokens: event.usage?.cacheReadTokens ?? undefined,
    cacheCreationTokens: event.usage?.cacheCreationTokens ?? undefined,
    costUsd: event.usage?.costUsd ?? undefined,
    modelUsage: event.modelUsage ?? undefined,
    authMethod: event.authMethod ?? undefined,
    fallbacks: event.fallbacks ?? undefined,
    outputShapeMetrics: event.outputShapeMetrics ?? undefined,
    toolMetrics: event.toolMetrics ? {
      toolUsage: {},
      toolUsageByCategory: event.toolMetrics.toolUsageByCategory,
      mcpServerUsage: event.toolMetrics.mcpServerUsage,
      totalToolCalls: event.toolMetrics.totalToolCalls,
      failedToolCalls: event.toolMetrics.failedToolCalls,
      filesCreated: event.toolMetrics.filesCreated,
      filesEdited: event.toolMetrics.filesEdited,
      workArtifactsCreated: event.toolMetrics.workArtifactsCreated ?? 0,
      workArtifactsCreatedByType: event.toolMetrics.workArtifactsCreatedByType ?? {},
      memoryFilesModified: 0,
      skillFilesModified: 0,
      totalToolOutputChars: event.toolMetrics.totalToolOutputChars,
      mcpToolOutputChars: event.toolMetrics.mcpToolOutputChars,
      builtinToolOutputChars: event.toolMetrics.builtinToolOutputChars,
    } : undefined,
    subAgentMetrics: event.subAgentMetrics ? {
      usedSubAgents: event.subAgentMetrics.usedSubAgents,
      subAgentCount: event.subAgentMetrics.subAgentCount,
      subAgentToolCount: event.subAgentMetrics.subAgentToolCount,
      subAgentTypes: [],
    } : undefined,
  });

  // Track first real task (non-tutorial) with connector usage
  const connectorsUsed = event.toolMetrics?.mcpServerUsage
    ? Object.keys(event.toolMetrics.mcpServerUsage).filter(
        (server) => (event.toolMetrics?.mcpServerUsage?.[server] ?? 0) > 0
      )
    : [];
  const hasIntegrationTools = (event.toolMetrics?.toolUsageByCategory?.integration ?? 0) > 0;
  const taskType = hasIntegrationTools ? 'integration_task' : 'general_task';

  trackFirstRealTaskIfNeeded({
    taskType,
    connectorsUsed,
    success: true,
  });
};

export const trackTurnError = (
  turnId: string,
  sessionId: string,
  errorType: string
): void => {
  tracking.chat.turnError({
    turnId,
    sessionId,
    errorType,
    isRetryable: true
  });
};

export const trackTurnInterrupted = (
  turnId: string,
  sessionId: string,
  elapsedMs: number,
  reason: 'user' | 'timeout' | 'error'
): void => {
  tracking.chat.turnInterrupted({
    turnId,
    sessionId,
    elapsedMs,
    reason
  });
};

export const trackAgentReplyStarted = (
  turnId: string,
  sessionId: string
): void => {
  tracking.chat.agentReplyStarted(turnId, sessionId);
};

export const trackAgentReplyDelivered = (
  turnId: string,
  sessionId: string,
  timeToFirstResponseMs: number,
  totalDurationMs: number
): void => {
  tracking.chat.agentReplyDelivered(turnId, sessionId, timeToFirstResponseMs, totalDurationMs);
};

export const trackMessageEditStarted = (
  messageId: string,
  sessionId: string
): void => {
  tracking.chat.messageEditStarted(messageId, sessionId);
};

export const trackMessageEditCancelled = (
  messageId: string,
  sessionId: string
): void => {
  tracking.chat.messageEditCancelled(messageId, sessionId);
};

export const trackMessageEditSubmitted = (
  messageId: string,
  sessionId: string,
  charDelta: number
): void => {
  tracking.chat.messageEditSubmitted(messageId, sessionId, charDelta);
};

export const trackFileMentioned = (
  sessionId: string,
  fileCount: number
): void => {
  tracking.chat.fileMentioned(sessionId, fileCount);
};
