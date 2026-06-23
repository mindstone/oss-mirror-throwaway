import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Fragment } from "react";
import { PenSquare, Copy, Database, RotateCcw, BellRing, AlertTriangle, WifiOff, Package, Clock } from "lucide-react";
import { deriveTurnLiveness } from '@core/services/conversationState';
import { cn } from "@renderer/lib/utils";
import { Tooltip } from "@renderer/components/ui/Tooltip";
import { Button, Notice } from "@renderer/components/ui";
import { useSettingsSafe } from "@renderer/features/settings";
import { computeTaskDisplayProps } from "@rebel/shared";
import { ToolResultImage } from "@renderer/components/ToolResultImage";
import { ImageGrid } from "./ImageGrid";
import { imageGridSourceFromEvent, type ImageGridItem } from "./imageGridSource";

import type {
  AgentEvent,
  AgentTurnMessage,
  CompactionBoundary as CompactionBoundaryType,
  MemoryUpdateStatus,
  TimeSavedStatus,
  AnyAttachmentPayload,
  McpAppStructuredFallback,
  McpAppUiMeta,
  RendererLogPayload,
  TrustBoundaryRejectionReason,
} from "@shared/types";
import { isImageAttachment } from "@shared/types";
import {
  buildMcpAppAwareMessageText,
  formatMcpAppStructuredFallbackAsPlainText,
  formatPrimaryMcpAppFallbackAsPlainText,
} from "@shared/utils/mcpAppFallbackText";
import { getPrimaryMcpAppCaptionDefault } from "@shared/utils/mcpAppCaptionDefaults";
import { classifyTurnEnding } from "@shared/utils/turnEndingClassification";
import { parseMcpAppSendMessageText } from "@shared/utils/mcpAppSendMessageAttribution";
import { formatTimestamp, formatDurationShort } from "@renderer/utils/formatters";
import { MessageMarkdown } from "@renderer/components/MessageMarkdown";
import { ContextualProgressCard } from "./ContextualProgressCard";
import { McpAppView } from "./McpAppView";
import { TurnStepsInline } from "./TurnStepsInline";
import { MessageWorkDisclosure } from "./MessageWorkDisclosure";
import { AdditionalViewRow } from "./AdditionalViewRow";
import { PrimaryViewSourceStrip } from "./PrimaryViewSourceStrip";
import { InsightsPill } from "./InsightsPill";
import { MemoryUpdateIndicator } from "./MemoryUpdateIndicator";
import { TeamKnowledgeIndicator } from "./TeamKnowledgeIndicator";
import { TimeSavedSummary } from "./TimeSavedSummary";
import { CompactionBoundary } from "./CompactionBoundary";
import { UsageTooltipContent, runtimeRoleToUiLabel, type UsageData, type ModelRole } from "./UsageTooltipContent";
import { getModelDisplayName } from "@shared/utils/modelNormalization";
import { getModelPricing } from "@shared/utils/pricingCalculator";
import { toCanonicalModelId } from "@shared/utils/modelIdentity";
import { ConversationFeedbackPrompt } from "./ConversationFeedbackPrompt";
import type { TurnStepContext } from "../utils/turnStepContext";
import { deriveTurnActivityRecap } from "../utils/turnActivityRecap";
import type { SubAgentTimeline } from "../utils/subAgentTimeline";
import type { McpBuildActivity } from "../utils/activityDerivation";
import { resolveModelAgentInfo } from "../utils/modelAgentLabels";
import { detectAwaitingApiSoftStall } from "../utils/detectAwaitingApiSoftStall";
import { AWAITING_API_SOFT_STALL_MESSAGE, AWAITING_API_SOFT_STALL_HINT } from "@shared/constants/awaitingApiSoftStall";
import { extractAppScreenshotEvents } from "../utils/visualEvidence";
import type { StepToolSummary } from "../utils/toolChips";
import { resolveSourceDisplayName } from "../utils/mcpAppDisplayNames";
import { useSessionStore } from "../store/sessionStore";
import styles from "./ConversationPane.module.css";

import { MeetingTurnSpeakerAttribution } from './MeetingTurnSpeakerAttribution';

function formatFullTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
  return formatter.format(date);
}

function extractTurnTiming(
  events: AgentEvent[] | undefined
): { finishedAt: number | null; durationMs: number | null } {
  if (!events || events.length === 0) return { finishedAt: null, durationMs: null };

  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const event of events) {
    if ('timestamp' in event && typeof event.timestamp === 'number') {
      if (firstTimestamp === null || event.timestamp < firstTimestamp) {
        firstTimestamp = event.timestamp;
      }
      if (lastTimestamp === null || event.timestamp > lastTimestamp) {
        lastTimestamp = event.timestamp;
      }
    }
  }

  const durationMs = firstTimestamp && lastTimestamp && lastTimestamp > firstTimestamp
    ? lastTimestamp - firstTimestamp
    : null;

  return { finishedAt: lastTimestamp, durationMs };
}

/**
 * Friendliest display label for a role's model. Anthropic main models resolve via the canonical id
 * (MODEL_OPTIONS, e.g. "Opus 4.8"); OpenRouter / auxiliary models resolve via the raw
 * provider-prefixed id (catalog, e.g. "deepseek/deepseek-v4-pro" → "DeepSeek V4 Pro"). Try canonical
 * first, then raw, so each kind gets its catalog label rather than a bare id.
 */
function roleModelLabel(rawModelId: string, canonicalModelId: string): string {
  const byCanonical = getModelDisplayName(canonicalModelId);
  if (byCanonical !== canonicalModelId) return byCanonical;
  const byRaw = getModelDisplayName(rawModelId);
  if (byRaw !== rawModelId) return byRaw;
  return byCanonical;
}

export function deriveModelRoles(events: AgentEvent[] | undefined): ModelRole[] {
  const resultEvent = events?.find(e => e.type === 'result') as Extract<AgentEvent, { type: 'result' }> | undefined;
  if (!resultEvent) return [];

  // Preferred path: the runtime authored per-role bindings on the result event (Stage 3). Read them
  // directly instead of reconstructing roles by string-comparing `model` vs `planningModel` — that
  // heuristic mislabeled direct-answer turns and couldn't dedup two spellings of one model (the
  // diagnosed "Opus shown as both tiers" bug). See docs/plans/260601_diagnose-model-tier-tooltip/.
  const roles = resultEvent.roles;
  if (roles && roles.length > 0) {
    const modelUsage = resultEvent.modelUsage ?? {};
    const referencedUsageKeys = new Set<string>();
    const modelRoles: ModelRole[] = roles.map((b) => {
      if (b.modelUsageKey) {
        referencedUsageKeys.add(b.modelUsageKey);
      }

      const usageEntry = b.status === 'observed' && b.modelUsageKey
        ? modelUsage[b.modelUsageKey]
        : undefined;

      return {
        role: runtimeRoleToUiLabel(b.role),
        model: roleModelLabel(b.rawModelId, b.canonicalModelId),
        ...(b.authMethod ? { authMethod: b.authMethod } : {}),
        ...(b.provider ? { provider: b.provider } : {}),
        ...(b.pricingStatus ? { pricingStatus: b.pricingStatus } : {}),
        ...(usageEntry
          ? {
              usage: {
                inputTokens: usageEntry.inputTokens,
                outputTokens: usageEntry.outputTokens,
                costUsd: usageEntry.costUsd ?? null,
              },
            }
          : {}),
        status: b.status,
      };
    });

    for (const [modelUsageKey, usageEntry] of Object.entries(modelUsage)) {
      if (referencedUsageKeys.has(modelUsageKey)) continue;

      const canonical = toCanonicalModelId(modelUsageKey).canonical;
      modelRoles.push({
        role: 'Also ran',
        model: roleModelLabel(modelUsageKey, canonical),
        status: 'observed',
        usage: {
          inputTokens: usageEntry.inputTokens,
          outputTokens: usageEntry.outputTokens,
          costUsd: usageEntry.costUsd ?? null,
        },
        ...(usageEntry.authMethod ? { authMethod: usageEntry.authMethod } : {}),
        ...(usageEntry.openRouterProvider || usageEntry.providersSeen?.[0]
          ? { provider: usageEntry.openRouterProvider ?? usageEntry.providersSeen?.[0] }
          : {}),
        pricingStatus: getModelPricing(canonical) ? 'priced' : 'unpriced',
      });
    }

    const totalObservedTokens = modelRoles.reduce((sum, roleRow) => {
      if (roleRow.status !== 'observed' || !roleRow.usage) return sum;
      return sum + roleRow.usage.inputTokens + roleRow.usage.outputTokens;
    }, 0);

    if (totalObservedTokens > 0) {
      for (const roleRow of modelRoles) {
        if (roleRow.status !== 'observed' || !roleRow.usage) continue;
        const rowTotal = roleRow.usage.inputTokens + roleRow.usage.outputTokens;
        if (rowTotal <= 0) continue;
        const rawShare = (rowTotal / totalObservedTokens) * 100;
        roleRow.sharePct = rawShare > 0 && rawShare < 1 ? 0 : Math.round(rawShare);
      }
    }

    return modelRoles;
  }

  // Legacy fallback for pre-`roles[]` persisted turns: keep the old string-paired derivation so
  // history renders unchanged (new turns always take the roles[] path above). Relabeled to the
  // unified product vocabulary (Planner / Main work) for consistency.
  const planningModel = resultEvent.planningModel?.trim();
  const model = resultEvent.model?.trim();
  const modelUsage = resultEvent.modelUsage;
  if (!planningModel || !model || planningModel === model) {
    return [];
  }
  const planningAuth = modelUsage?.[planningModel]?.authMethod;
  const workingAuth = modelUsage?.[model]?.authMethod;
  return [
    {
      role: 'Planner',
      model: getModelDisplayName(planningModel),
      ...(planningAuth ? { authMethod: planningAuth } : {}),
    },
    {
      role: 'Main work',
      model: getModelDisplayName(model),
      ...(workingAuth ? { authMethod: workingAuth } : {}),
    },
  ];
}

function extractUsageFromEvents(
  events: AgentEvent[] | undefined,
  modelAgents?: UsageData['modelAgents'],
): UsageData | null {
  if (!events || events.length === 0) return null;

  let resultEvent: (AgentEvent & { type: 'result' }) | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const event of events) {
    if ('timestamp' in event && typeof event.timestamp === 'number') {
      if (firstTimestamp === null || event.timestamp < firstTimestamp) {
        firstTimestamp = event.timestamp;
      }
      if (lastTimestamp === null || event.timestamp > lastTimestamp) {
        lastTimestamp = event.timestamp;
      }
    }
    if (event.type === "result" && event.usage) {
      resultEvent = event;
    }
  }

  if (!resultEvent) return null;

  const durationMs = firstTimestamp && lastTimestamp && lastTimestamp > firstTimestamp
    ? lastTimestamp - firstTimestamp
    : null;

  const modelRoles = deriveModelRoles(events);

  return {
    ...resultEvent.usage,
    model: resultEvent.model,
    modelRoles,
    modelAgents,
    contextUtilization: resultEvent.usage?.contextUtilization ?? null,
    contextWindow: resultEvent.usage?.contextWindow ?? null,
    durationMs,
    thinkingEffort: resultEvent.thinkingEffort,
    authMethod: resultEvent.authMethod,
    fallbacks: resultEvent.fallbacks,
  };
}

type TimestampTooltipContentProps = {
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
};

const TimestampTooltipContent = memo(({ startedAt, finishedAt, durationMs }: TimestampTooltipContentProps) => (
  <div className={styles.timestampTooltip}>
    <div className={styles.timestampRow}>
      <span className={styles.timestampLabel}>Started</span>
      <span className={styles.timestampValue}>{formatFullTimestamp(startedAt)}</span>
    </div>
    {finishedAt && (
      <div className={styles.timestampRow}>
        <span className={styles.timestampLabel}>Finished</span>
        <span className={styles.timestampValue}>{formatFullTimestamp(finishedAt)}</span>
      </div>
    )}
    {durationMs != null && durationMs > 0 && (
      <div className={styles.timestampRow}>
        <span className={styles.timestampLabel}>Duration</span>
        <span className={styles.timestampValue}>{formatDurationShort(durationMs)}</span>
      </div>
    )}
  </div>
));
TimestampTooltipContent.displayName = 'TimestampTooltipContent';

/**
 * Check if a turn completed (has a result or error event).
 * Returns false if the turn was interrupted before completion.
 */
function hasTurnCompleted(events: AgentEvent[] | undefined): boolean {
  if (!events || events.length === 0) return false;
  return events.some(e => e.type === 'result' || e.type === 'error');
}

type MessageRole = "user" | "assistant" | "result";
const roleStyles: Record<MessageRole, string> = {
  user: styles.user,
  assistant: styles.assistant,
  result: styles.result,
};

const DEFAULT_PRIMARY_VIEW_ROLE_LABEL = 'Interactive view';
const PRIMARY_PROSE_DISCLOSURE_CHAR_LIMIT = 240;
const MCP_APP_SAFETY_CLEANUP_MARKER = ' (cleaned for safety)';

type McpAppToolSummary = StepToolSummary & {
  mcpAppUiMeta: McpAppUiMeta;
};

type McpAppTrustNotice = {
  reason: TrustBoundaryRejectionReason;
  message: string;
  method?: 'ui/updateModelContext' | 'ui/sendMessage' | 'tools/call';
  toolName?: string;
  sourcePackageId?: string;
  conversationId?: string;
};

function isMcpAppToolSummary(tool: StepToolSummary): tool is McpAppToolSummary {
  return Boolean(tool.mcpAppUiMeta?.resourceUri);
}

function getToolStableId(tool: StepToolSummary, index: number): string {
  return tool.toolUseId ?? `${tool.toolName ?? tool.label}-${index}`;
}

function getAdditionalViewStatus(tool: StepToolSummary): 'idle' | 'loading' | 'failed' {
  if (tool.status === 'error') return 'failed';
  if (tool.status === 'pending' || tool.status === 'running') return 'loading';
  return 'idle';
}

const COMMON_SENTENCE_ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'p.m.',
  'a.m.',
  'inc.',
  'ltd.',
  'co.',
  'no.',
]);

function getTokenEndingAt(text: string, index: number): string {
  const prefix = text.slice(0, index + 1);
  const match = prefix.match(/([A-Za-z](?:\.[A-Za-z])+\.|[A-Za-z]+\.)$/u);
  return match?.[1]?.toLowerCase() ?? '';
}

function isNumberedListMarkerPeriod(text: string, index: number): boolean {
  return /(?:^|\s)\d+\.$/u.test(text.slice(0, index + 1));
}

function isInsideMarkdownStrong(text: string, index: number): boolean {
  const opening = text.lastIndexOf('**', index);
  if (opening === -1) return false;
  const priorClosing = opening > 0 ? text.lastIndexOf('**', opening - 1) : -1;
  const closing = text.indexOf('**', index + 1);
  return closing !== -1 && priorClosing < opening;
}

function isCommonAbbreviationPeriod(text: string, index: number): boolean {
  const token = getTokenEndingAt(text, index);
  if (!token) return false;
  if (COMMON_SENTENCE_ABBREVIATIONS.has(token)) return true;
  return /^(?:[a-z]\.){2,}$/u.test(token);
}

function isSentenceBoundaryAt(text: string, index: number): boolean {
  const char = text[index];
  if (char !== '.' && char !== '!' && char !== '?') return false;
  if (char === '.') {
    if (isNumberedListMarkerPeriod(text, index)) return false;
    if (isInsideMarkdownStrong(text, index)) return false;
    if (isCommonAbbreviationPeriod(text, index)) return false;
  }

  let nextIndex = index + 1;
  while (nextIndex < text.length && /["')\]}*_]/u.test(text[nextIndex])) {
    nextIndex += 1;
  }
  return nextIndex >= text.length || /\s/u.test(text[nextIndex]);
}

function countSentenceBoundaries(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isSentenceBoundaryAt(text, index)) {
      count += 1;
    }
  }
  return count;
}

function findFirstSentence(text: string): string {
  const trimmed = text.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (isSentenceBoundaryAt(trimmed, index)) {
      return trimmed.slice(0, index + 1).trim();
    }
  }
  return trimmed;
}

function shouldCollapsePrimaryProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const sentenceCount = countSentenceBoundaries(trimmed);
  if (sentenceCount === 0) return false;
  if (sentenceCount > 1) return true;
  return trimmed.length > PRIMARY_PROSE_DISCLOSURE_CHAR_LIMIT && findFirstSentence(trimmed).length < trimmed.length;
}

function comparePrimaryMcpAppTools(
  a: { tool: McpAppToolSummary; originalIndex: number },
  b: { tool: McpAppToolSummary; originalIndex: number },
): number {
  const aEmissionIndex = a.tool.emissionIndex ?? Number.POSITIVE_INFINITY;
  const bEmissionIndex = b.tool.emissionIndex ?? Number.POSITIVE_INFINITY;
  if (aEmissionIndex !== bEmissionIndex) {
    return aEmissionIndex - bEmissionIndex;
  }

  const aTimestamp = a.tool.emissionTimestamp ?? Number.POSITIVE_INFINITY;
  const bTimestamp = b.tool.emissionTimestamp ?? Number.POSITIVE_INFINITY;
  if (aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }

  return a.originalIndex - b.originalIndex;
}

function shouldAutoOpenInlineWork(tool: StepToolSummary): boolean {
  switch (tool.status) {
    case 'pending':
    case 'running':
    case 'error':
      return true;
    case undefined:
    case 'success':
      return false;
    default:
      // Trust beats tidiness: if a future status reaches this renderer, keep
      // the disclosure open so unexpected work state remains visible.
      return true;
  }
}

function emitRendererWarnLog(message: string, context: Record<string, unknown>): void {
  try {
    const payload: RendererLogPayload = {
      level: 'warn',
      message,
      context,
      source: 'renderer',
      timestamp: Date.now(),
    };
    (window as unknown as { api?: { logEvent?: (payload: RendererLogPayload) => void } }).api?.logEvent?.(payload);
  } catch {
    // Logging must never disrupt transcript rendering.
  }
}

function buildInlineWorkSteps(
  sourceSteps: AgentEvent[],
  toolSummariesByStep: Map<number, StepToolSummary[]>,
): AgentEvent[] {
  const maxToolStep = Math.max(0, ...Array.from(toolSummariesByStep.keys()));
  if (maxToolStep <= sourceSteps.length) {
    return sourceSteps;
  }

  return Array.from({ length: maxToolStep }, (_, index) => (
    sourceSteps[index] ?? {
      type: 'assistant',
      text: '',
      timestamp: index,
    }
  ));
}

function PrimaryProseCaption({ prose }: { prose: string }) {
  const trimmed = prose.trim();
  const [showFullProse, setShowFullProse] = useState(false);
  const controlledRegionId = useId();

  if (!trimmed) return null;

  const isLong = shouldCollapsePrimaryProse(trimmed);
  const compactProse = isLong ? findFirstSentence(trimmed) : trimmed;

  return (
    <div className={styles.mcpAppPrimaryCaption} data-testid="mcp-app-primary-caption">
      <p>{compactProse}</p>
      {isLong ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowFullProse((value) => !value)}
            aria-expanded={showFullProse}
            aria-controls={controlledRegionId}
          >
            {showFullProse ? "Hide Rebel's note" : "Show Rebel's note"}
          </Button>
          <p
            id={controlledRegionId}
            className={styles.mcpAppPrimaryCaptionFull}
            hidden={!showFullProse}
          >
            {trimmed}
          </p>
        </>
      ) : null}
    </div>
  );
}

function getMcpAppSourceDisplayName(uiMeta: McpAppUiMeta): string {
  return resolveSourceDisplayName(uiMeta.sourcePackageId).displayName;
}

function getPrimaryViewRoleLabel(uiMeta: McpAppUiMeta): string {
  return uiMeta.viewRoleLabel?.trim() || DEFAULT_PRIMARY_VIEW_ROLE_LABEL;
}

function getPrimaryViewIframeTitle(uiMeta: McpAppUiMeta): string {
  return `${getPrimaryViewRoleLabel(uiMeta)} from ${getMcpAppSourceDisplayName(uiMeta)}`;
}

function getFallbackCopyLabel(fallback: McpAppStructuredFallback | undefined): string {
  return fallback?.kind === 'email-draft' ? 'Copy draft' : 'Copy details';
}

function getTrustRejectionNoticeMessage(
  reason: TrustBoundaryRejectionReason,
  method?: string,
): string {
  if (method === 'tools/call') {
    switch (reason) {
      case 'permission_denied':
      case 'tool_not_allowed':
        return "View tried to use a tool that isn't allowed. Grant access in Settings.";
      case 'rate_limited':
        return 'View is calling tools too quickly.';
      case 'stale_nonce':
        return 'View needs to be reopened before it can use tools.';
      case 'invalid_params':
        return 'View sent an invalid tool request. Rebel declined the paperwork.';
      default:
        return "View couldn't use that tool.";
    }
  }

  if (method === 'ui/sendMessage') {
    switch (reason) {
      case 'permission_denied':
        return 'View tried to send a message on your behalf. Grant in Settings to enable.';
      case 'rate_limited':
        return 'View is sending too many messages. It will retry shortly.';
      case 'invalid_role':
        return 'View tried to send a message in an unauthorized role.';
      case 'stale_nonce':
        return 'View needs to be reopened before it can send a message.';
      case 'invalid_params':
        return 'View sent an invalid message. Rebel declined the paperwork.';
      default:
        return "View couldn't send a message to the conversation.";
    }
  }

  switch (reason) {
    case 'permission_denied':
      return 'View tried to provide context to the assistant. Grant in Settings to enable.';
    case 'rate_limited':
      return 'View is sending too much context. It will retry shortly.';
    case 'stale_nonce':
      return 'View needs to be reopened to send context.';
    case 'invalid_params':
      return 'View sent invalid context (too long, malformed, or missing fields).';
    case 'unknown_method':
      return "View tried something Rebel doesn't know how to do.";
    default:
      return "View couldn't share context with the assistant.";
  }
}

type McpAppRecoveryNoticeProps = {
  uiMeta: McpAppUiMeta;
  agentProse: string;
  onRetry: () => void;
  onCopyFallback: (text: string) => void | Promise<void>;
};

function McpAppRecoveryNotice({
  uiMeta,
  agentProse,
  onRetry,
  onCopyFallback,
}: McpAppRecoveryNoticeProps) {
  const [showProse, setShowProse] = useState(false);
  const controlledRegionId = useId();
  const summary = uiMeta.viewSummary?.trim();
  const structuredFallbackText = formatMcpAppStructuredFallbackAsPlainText(uiMeta.structuredFallback, {
    roleLabel: getPrimaryViewRoleLabel(uiMeta),
  });
  const primaryFallbackText = formatPrimaryMcpAppFallbackAsPlainText(uiMeta);
  const actions = [
    { label: 'Retry', onClick: onRetry, 'data-testid': 'mcp-app-retry-button' },
    ...(structuredFallbackText
      ? [{
          label: getFallbackCopyLabel(uiMeta.structuredFallback),
          onClick: () => {
            void onCopyFallback(primaryFallbackText || structuredFallbackText);
          },
          variant: 'secondary' as const,
          'data-testid': 'mcp-app-copy-fallback-button',
        }]
      : []),
  ];

  return (
    <Notice
      tone="error"
      placement="inline"
      role="status"
      title="The view failed to load."
      actions={actions}
      data-testid="mcp-app-recovery-notice"
    >
      <div className={styles.mcpAppRecoveryContent}>
        <p>The useful details are still here.</p>
        {summary ? (
          <p className={styles.mcpAppSummaryBlock}>{summary}</p>
        ) : null}
        {structuredFallbackText ? (
          <pre className={styles.mcpAppFallbackText}>{structuredFallbackText}</pre>
        ) : null}
        {agentProse.trim() ? (
          <div className={styles.mcpAppProseDisclosure}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowProse((value) => !value)}
              aria-expanded={showProse}
              aria-controls={controlledRegionId}
            >
              {showProse ? "Hide Rebel's note" : "Show Rebel's note"}
            </Button>
            <pre
              id={controlledRegionId}
              className={styles.mcpAppFallbackText}
              hidden={!showProse}
            >
              {agentProse}
            </pre>
          </div>
        ) : null}
      </div>
    </Notice>
  );
}

export type MessageItemProps = {
  message: AgentTurnMessage;
  /** Whether this message should animate entrance (genuinely new message) */
  isNewMessage?: boolean;
  /** Whether this message should show spotlight glow (turn just completed) */
  isSpotlighted?: boolean;
  boundaryAfterThis: CompactionBoundaryType | undefined;
  messageCount: number;
  /** Session ID to use for conversation-level feedback */
  sessionIdForFeedback: string;
  /** Whether to show conversation feedback controls within this message */
  showConversationFeedback?: boolean;
  /** Anchor metadata for conversation feedback votes. */
  conversationFeedbackAnchor?: {
    anchorMessageId: string;
    anchorTurnId: string | null;
    anchorMessageIndex: number;
  };
  /** Pre-computed resolved turn ID for this message (handles fallback assignments) */
  resolvedTurnId: string | null;
  /** Events for this message's turn (pre-sliced for memoization) */
  turnEvents: AgentEvent[];
  /** Step context for this message's turn (pre-sliced for memoization) */
  turnStepContext: TurnStepContext | undefined;
  /** Sub-agent timeline for this message's turn (pre-sliced for memoization) */
  subAgentTimeline: SubAgentTimeline | undefined;
  activeStepByTurn: Record<string, number | null>;
  memoryStatusByTurn: Record<string, MemoryUpdateStatus>;
  timeSavedStatusByTurn: Record<string, TimeSavedStatus>;
  /**
   * Per-turn AI activity summary (260618 show-more-activity). When present for
   * this message's turn, it becomes the collapsed work-disclosure label
   * (sentence); otherwise the deterministic count-line recap is shown.
   */
  activitySummaryByTurn: Record<string, string>;
  visibleTurnId: string;
  focusedTurnId: string | null;
  /** Turn the agent runtime is actively processing (not affected by user clicks). (FOX-2505) */
  processingTurnId: string | null;
  editingMessageId: string | null;
  isBusy: boolean;
  /** When true, the turn is waiting on blocking approval and should not appear actively thinking. */
  isPausedForApproval?: boolean;
  isStopping: boolean;
  thinkingHeadline?: string;
  thinkingElapsedLabel?: string;
  /**
   * Live MCP connector build activity, threaded straight through to
   * `ContextualProgressCard` so the Doing-right-now row can show
   * "Writing <name>" / "Testing <name>" while a connector is being built.
   */
  mcpBuildActivity?: McpBuildActivity | null;
  onFocusTurn: (turnId: string) => void;
  onBeginEditMessage: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  onSelectInlineStep: (turnId: string, stepNumber: number | null) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder?: (folderPath: string) => void;
  onOpenConversation?: (sessionId: string) => void;
  onNavigate?: (url: string) => void;
  onOpenTutorial?: (tutorialPath: string) => void;
  onCopyToClipboard: (text: string) => void;
  showToast?: (options: { title: string }) => void;
  coreDirectory?: string;
  onOpenInLibrary?: (filePath: string, isFolder: boolean) => void;
  /** Callback to continue working on incomplete tasks — only provided for the last message */
  onContinueIncomplete?: () => void;
  /** User message id to reuse for turn-level retry affordances. */
  retrySourceMessageId?: string;
  /**
   * Stage 1b (260617_bricked-state-0448-electron42): stop the live turn — wired
   * upstream to `stopActiveTurn()`. Powers BOTH actions in the soft "still
   * waiting" affordance (State B): "Stop" calls it directly, and "Try again"
   * is stop-then-resend (this, then `onRetryMessage(retrySourceMessageId)`) so
   * the still-alive turn is never double-sent. Only provided for the
   * actively-processing turn.
   */
  onStopActiveTurn?: () => void;
};

const MessageItemComponent = ({
  message,
  isNewMessage,
  isSpotlighted,
  boundaryAfterThis,
  messageCount,
  sessionIdForFeedback,
  showConversationFeedback = false,
  conversationFeedbackAnchor,
  resolvedTurnId,
  turnEvents,
  turnStepContext,
  subAgentTimeline,
  activeStepByTurn,
  memoryStatusByTurn,
  timeSavedStatusByTurn,
  activitySummaryByTurn,
  visibleTurnId,
  focusedTurnId,
  processingTurnId,
  editingMessageId,
  isBusy,
  isPausedForApproval = false,
  isStopping,
  thinkingHeadline,
  thinkingElapsedLabel,
  mcpBuildActivity,
  onFocusTurn,
  onBeginEditMessage,
  onRetryMessage,
  onSelectInlineStep,
  onOpenFile,
  onOpenFolder,
  onOpenConversation,
  onNavigate,
  onOpenTutorial,
  onCopyToClipboard,
  showToast,
  coreDirectory,
  onOpenInLibrary,
  onContinueIncomplete,
  retrySourceMessageId,
  onStopActiveTurn,
}: MessageItemProps) => {
  const appMessageAttribution = message.role === 'user'
    ? parseMcpAppSendMessageText(message.text)
    : null;
  const appAttributedDisplayText = appMessageAttribution
    ? message.displayText ?? appMessageAttribution.content
    : '';
  const appAttributedMessageWasCleaned = appAttributedDisplayText.endsWith(MCP_APP_SAFETY_CLEANUP_MARKER);
  const appAttributedVisibleText = appAttributedMessageWasCleaned
    ? appAttributedDisplayText.slice(0, -MCP_APP_SAFETY_CLEANUP_MARKER.length).trimEnd()
    : appAttributedDisplayText;
  const isAppAttributedUserMessage = Boolean(appMessageAttribution);
  const label =
    isAppAttributedUserMessage
      ? "App message"
      : message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? "Rebel"
        : "Summary";
  const timestamp = formatTimestamp(message.createdAt);
  const turnId = message.turnId;
  // resolvedTurnId is now passed as a prop (pre-computed by ConversationPane)
  const isSelectableTurn = Boolean(
    !isAppAttributedUserMessage && resolvedTurnId && turnEvents.length > 0
  );
  const isActiveTurnMessage = resolvedTurnId
    ? resolvedTurnId === visibleTurnId
    : turnId === visibleTurnId;
  const isEditingThisMessage = editingMessageId === message.id;
  
  // Use effectivelyIdle for optimistic UI behavior during stop - while isStopping,
  // the backend is still busy but we treat the UI as idle so users can immediately
  // begin editing their next message.
  const effectivelyIdle = !isBusy || isStopping;
  const canEditThisMessage = message.role === "user" && effectivelyIdle && !isAppAttributedUserMessage;
  
  // Determine if this turn was interrupted (started but never completed)
  const settingsContext = useSettingsSafe();
  const mcpAppsEnabled = settingsContext?.settings?.experimental?.mcpAppsEnabled !== false;
  const resolvedTheme = useMemo((): 'light' | 'dark' => {
    const themePref = settingsContext?.settings?.theme;
    if (themePref === 'light' || themePref === 'dark') return themePref;
    return document.body.classList.contains('dark') ? 'dark' : 'light';
  }, [settingsContext?.settings?.theme]);
  const profiles = settingsContext?.settings?.localModel?.profiles;
  const modelAgentsForUsage = useMemo<UsageData['modelAgents']>(() => {
    if (!subAgentTimeline?.items.length) {
      return undefined;
    }

    const byLabel = new Map<string, NonNullable<UsageData['modelAgents']>[number]>();
    for (const item of subAgentTimeline.items) {
      const modelInfo = resolveModelAgentInfo(item.subagentType, profiles);
      if (!modelInfo.isModelAgent) {
        continue;
      }

      const key = `${modelInfo.label}::${modelInfo.provider ?? ''}`;
      if (!byLabel.has(key)) {
        byLabel.set(key, {
          label: modelInfo.label,
          provider: modelInfo.provider
        });
      }
    }

    return byLabel.size > 0 ? Array.from(byLabel.values()) : undefined;
  }, [subAgentTimeline, profiles]);

  const usageData = useMemo(
    () => extractUsageFromEvents(turnEvents, modelAgentsForUsage),
    [turnEvents, modelAgentsForUsage]
  );
  const appScreenshotEvents = useMemo(
    () => extractAppScreenshotEvents(turnEvents),
    [turnEvents]
  );
  const appScreenshotItems = useMemo<ImageGridItem[]>(
    () =>
      appScreenshotEvents.flatMap((slice, sliceIndex) =>
        imageGridSourceFromEvent(
          { imageContent: slice.imageContent, imageRef: slice.imageRef },
          sessionIdForFeedback,
          {
            altPrefix: 'Screenshot captured',
            keyPrefix: slice.toolUseId ?? `app-screenshot-${sliceIndex}`,
          },
        ),
      ),
    [appScreenshotEvents, sessionIdForFeedback]
  );
  
  // Determine if this turn was interrupted (started but never completed)
  // turnEvents is now passed as a prop (pre-sliced by ConversationPane)
  const turnWasInterrupted = turnEvents.length > 0 && !hasTurnCompleted(turnEvents);
  // Note: canEditThisMessage already includes effectivelyIdle check, no need for redundant !isBusy
  const canRetryThisMessage =
    canEditThisMessage && turnWasInterrupted && onRetryMessage;
  const [interruptedNoticeDismissed, setInterruptedNoticeDismissed] = useState(false);

  useEffect(() => {
    setInterruptedNoticeDismissed(false);
  }, [resolvedTurnId]);

  const visibleTurnLivenessStatus =
    resolvedTurnId && resolvedTurnId === visibleTurnId && turnEvents.length > 0
      ? deriveTurnLiveness(
          { [resolvedTurnId]: turnEvents },
          Date.now(),
          { declaredActiveTurnId: resolvedTurnId },
        ).status
      : null;

  const showInterruptedRecoveryNotice = Boolean(
    message.role !== 'user'
    && resolvedTurnId
    && resolvedTurnId === visibleTurnId
    && visibleTurnLivenessStatus === 'interrupted'
    && retrySourceMessageId
    && onRetryMessage
    && !interruptedNoticeDismissed,
  );

  const handleInterruptedTryAgain = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onRetryMessage || !retrySourceMessageId) return;
    onRetryMessage(retrySourceMessageId);
  }, [onRetryMessage, retrySourceMessageId]);

  const handleDismissInterruptedNotice = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setInterruptedNoticeDismissed(true);
  }, []);

  // Stage 1b (260617_bricked-state-0448-electron42): SOFT "still waiting" state
  // (State B). The watchdog dispatches a one-shot `status` carrying a `stall`
  // marker when an interactive `awaiting_api` turn has been silent past ~30s with
  // no first token. We surface a calm, non-destructive inline "Try again / Stop"
  // row (reusing the interrupted-recovery row anatomy below) WITHOUT ending the
  // turn — the spinner keeps running. It only shows on the ACTIVELY-PROCESSING
  // turn, never on a completed/historical one, and clears automatically when the
  // turn produces output or ends (the detector returns null) or while stopping.
  const softStallMarker = useMemo(
    () => detectAwaitingApiSoftStall(turnEvents),
    [turnEvents],
  );
  // First-token signal: `answer_phase_started` flips this the instant the turn
  // starts answering, BEFORE the rolled-up `assistant` event lands (which the
  // events-only detector would otherwise have to wait for). The renderer never
  // receives `assistant_delta`, so the detector cannot see first-token on its
  // own — this scoped store subscription is the belt that enforces the
  // load-bearing invariant: never show "still waiting" while text is appearing.
  const answerHasStarted = useSessionStore(
    (s) => (resolvedTurnId ? s.answerStreamingTurnIds.has(resolvedTurnId) : false),
  );
  // "Try again" needs the stop handler AND a resend source (the user message);
  // "Stop" needs only the stop handler. Show the row if at least one is wired.
  const canSoftStallTryAgain = Boolean(onStopActiveTurn && onRetryMessage && retrySourceMessageId);
  const canSoftStallStop = Boolean(onStopActiveTurn);
  const showSoftStallNotice = Boolean(
    message.role !== 'user'
    && softStallMarker
    && !answerHasStarted
    && resolvedTurnId
    && resolvedTurnId === processingTurnId
    && isBusy
    && !isStopping
    && (canSoftStallTryAgain || canSoftStallStop),
  );

  // "Try again" = abandon-and-retry: stop the still-alive turn FIRST, then resend
  // the user's message. Never a parallel `sendUserPrompt` (the documented
  // double-send hazard). `onStopActiveTurn` is the renderer's guarded stop (its
  // own `isStopping` re-entrancy guard + 10s force-kill), and `onRetryMessage`
  // dedupes server-side, so the resend lands once the prior turn is torn down.
  //
  // The stop is intentionally NOT awaited before the resend: `onStopActiveTurn`
  // is a fire-and-forget `() => void`, and same-session supersede in the main
  // process (`agentTurnService.ts` startTurn → cancels/supersedes any prior turn
  // for the session) guarantees the resend cannot run a second concurrent turn —
  // even if the stop IPC hasn't fully settled. So sequential (not awaited) calls
  // are safe here; the new turn supersedes the stalled one either way.
  const handleSoftStallTryAgain = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onStopActiveTurn || !onRetryMessage || !retrySourceMessageId) return;
    onStopActiveTurn();
    onRetryMessage(retrySourceMessageId);
  }, [onStopActiveTurn, onRetryMessage, retrySourceMessageId]);

  const handleSoftStallStop = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onStopActiveTurn?.();
  }, [onStopActiveTurn]);

  // turnStepContext is now passed as a prop (pre-sliced by ConversationPane)
  const inlineSteps = turnStepContext;
  const selectedInlineStepNumber = resolvedTurnId
    ? (activeStepByTurn[resolvedTurnId] ?? null)
    : null;
  const selectedInlineStep =
    selectedInlineStepNumber && inlineSteps
      ? (inlineSteps.assistantSteps[selectedInlineStepNumber - 1] ?? null)
      : null;
  const mcpAppTools = useMemo(() => {
    if (!inlineSteps) return [];
    return Array.from(inlineSteps.toolSummariesByStep.values())
      .flat()
      .filter(isMcpAppToolSummary);
  }, [inlineSteps]);
  const [trustRejectionNotice, setTrustRejectionNotice] = useState<McpAppTrustNotice | null>(null);
  useEffect(() => {
    if (mcpAppTools.length === 0) return;
    const toolUseIds = new Set(mcpAppTools.map((tool) => tool.toolUseId).filter(Boolean));
    const handleTrustRejection = (event: Event) => {
      const detail = (event as CustomEvent<{
        toolUseId?: string;
        sessionId?: string;
        conversationId?: string;
        sourcePackageId?: string;
        method?: 'ui/updateModelContext' | 'ui/sendMessage' | 'tools/call';
        toolName?: string;
        rejection?: { reason?: TrustBoundaryRejectionReason };
      }>).detail;
      const eventToolUseId = detail?.toolUseId;
      const eventSessionId = detail?.sessionId ?? detail?.conversationId;
      if (eventToolUseId && !toolUseIds.has(eventToolUseId)) {
        return;
      }
      if (!eventToolUseId && eventSessionId && eventSessionId !== sessionIdForFeedback) {
        return;
      }
      const reason = detail?.rejection?.reason;
      if (!reason) {
        return;
      }
      setTrustRejectionNotice({
        reason,
        message: getTrustRejectionNoticeMessage(reason, detail?.method),
        method: detail?.method,
        toolName: detail?.toolName,
        sourcePackageId: detail?.sourcePackageId,
        conversationId: detail?.conversationId ?? detail?.sessionId,
      });
    };
    window.addEventListener('mcp-app:trust-rejection', handleTrustRejection);
    return () => window.removeEventListener('mcp-app:trust-rejection', handleTrustRejection);
  }, [mcpAppTools, sessionIdForFeedback]);
  const canGrantMcpAppContextPermission = Boolean(
    (trustRejectionNotice?.reason === 'permission_denied' || trustRejectionNotice?.reason === 'tool_not_allowed')
      && trustRejectionNotice.sourcePackageId
      && trustRejectionNotice.conversationId
      && (trustRejectionNotice.method !== 'tools/call' || trustRejectionNotice.toolName)
      && typeof window.mcpAppsApi?.grantPermission === 'function',
  );
  const handleGrantMcpAppContextPermission = useCallback(() => {
    if (!trustRejectionNotice?.sourcePackageId || !trustRejectionNotice.conversationId) {
      return;
    }
    const grantRequest = trustRejectionNotice.method === 'tools/call'
      ? {
          sourcePackageId: trustRejectionNotice.sourcePackageId,
          conversationId: trustRejectionNotice.conversationId,
          method: 'tools/call' as const,
          toolName: trustRejectionNotice.toolName ?? '',
        }
      : {
          sourcePackageId: trustRejectionNotice.sourcePackageId,
          conversationId: trustRejectionNotice.conversationId,
          method: trustRejectionNotice.method ?? 'ui/updateModelContext',
        };
    void window.mcpAppsApi?.grantPermission?.(grantRequest).then((response) => {
      if (response.success) {
        const grantedMessage = trustRejectionNotice.method === 'tools/call'
          ? 'Tool access granted. The view can retry now.'
          : trustRejectionNotice.method === 'ui/sendMessage'
            ? 'Message sending granted. The view can retry now.'
            : 'Context sharing granted. The view can retry now.';
        setTrustRejectionNotice({
          ...trustRejectionNotice,
          reason: 'permission_denied',
          message: grantedMessage,
        });
      }
    }).catch(() => {
      const failedMessage = trustRejectionNotice.method === 'tools/call'
        ? "Couldn't grant tool access. The settings gremlin remains undefeated."
        : trustRejectionNotice.method === 'ui/sendMessage'
          ? "Couldn't grant message sending. The settings gremlin remains undefeated."
          : "Couldn't grant context sharing. The settings gremlin remains undefeated.";
      setTrustRejectionNotice({
        ...trustRejectionNotice,
        message: failedMessage,
      });
    });
  }, [trustRejectionNotice]);
  const primaryMcpAppTools = useMemo(
    () => mcpAppTools
      .map((tool, originalIndex) => ({ tool, originalIndex }))
      .filter(({ tool }) => tool.mcpAppUiMeta?.presentation === 'primary')
      .sort(comparePrimaryMcpAppTools)
      .map(({ tool }) => tool),
    [mcpAppTools],
  );
  // Lead primary = first-emitted (by tool emission index, not completion order).
  // See planning doc § A3c determinism contract.
  const leadPrimaryMcpAppTool = primaryMcpAppTools[0] ?? null;
  const demotedPrimaryMcpAppTools = useMemo(
    () => primaryMcpAppTools.slice(1),
    [primaryMcpAppTools],
  );
  // When the LLM renders the same file multiple times in one turn (e.g. rebuilds
  // a dashboard then re-shows it), only keep the latest occurrence per file path.
  const deduplicatedInlineMcpAppTools = useMemo(() => {
    const inlineTools = mcpAppTools.filter(
      (tool) => tool.mcpAppUiMeta?.presentation !== 'primary',
    );
    if (inlineTools.length <= 1) return inlineTools;
    const lastIndexByPath = new Map<string, number>();
    for (let i = 0; i < inlineTools.length; i++) {
      const filePath = inlineTools[i].mcpAppUiMeta?.originalFilePath;
      if (filePath) lastIndexByPath.set(filePath, i);
    }
    if (lastIndexByPath.size === 0) return inlineTools;
    return inlineTools.filter((tool, i) => {
      const filePath = tool.mcpAppUiMeta?.originalFilePath;
      if (!filePath) return true;
      return lastIndexByPath.get(filePath) === i;
    });
  }, [mcpAppTools]);
  const inlineToolSummariesByStep = useMemo(() => {
    if (!inlineSteps) return new Map<number, StepToolSummary[]>();
    const filtered = new Map<number, StepToolSummary[]>();
    inlineSteps.toolSummariesByStep.forEach((tools, stepNumber) => {
      const inlineTools = tools.filter((tool) => tool.mcpAppUiMeta?.presentation !== 'primary');
      if (inlineTools.length > 0) {
        filtered.set(stepNumber, inlineTools);
      }
    });
    return filtered;
  }, [inlineSteps]);
  const inlineToolCount = useMemo(() => {
    let count = 0;
    inlineToolSummariesByStep.forEach((tools) => {
      count += tools.length;
    });
    return count;
  }, [inlineToolSummariesByStep]);
  const inlineWorkSteps = useMemo(
    () => buildInlineWorkSteps(inlineSteps?.assistantSteps ?? [], inlineToolSummariesByStep),
    [inlineSteps?.assistantSteps, inlineToolSummariesByStep],
  );
  const inlineWorkHasActiveOrFailedTool = useMemo(() => {
    for (const tools of inlineToolSummariesByStep.values()) {
      if (tools.some(shouldAutoOpenInlineWork)) {
        return true;
      }
    }
    return false;
  }, [inlineToolSummariesByStep]);
  const multiplePrimaryWarningKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (primaryMcpAppTools.length <= 1) return;
    const toolUseIds = primaryMcpAppTools.map((tool, index) => getToolStableId(tool, index));
    const warnKey = toolUseIds.join('|');
    if (multiplePrimaryWarningKeyRef.current === warnKey) return;
    multiplePrimaryWarningKeyRef.current = warnKey;
    const leadTool = primaryMcpAppTools[0];
    emitRendererWarnLog('Multiple primary views in single turn — first emitted wins; others demoted', {
      toolUseIds,
      selectedLeadToolUseId: toolUseIds[0],
      demotedToolUseIds: toolUseIds.slice(1),
      resourceUris: {
        lead: leadTool?.mcpAppUiMeta.resourceUri,
        demoted: primaryMcpAppTools.slice(1).map((tool) => tool.mcpAppUiMeta.resourceUri),
      },
      emissionIndexes: primaryMcpAppTools.map((tool) => tool.emissionIndex ?? null),
    });
  }, [primaryMcpAppTools]);
  const [expandedAdditionalViewIds, setExpandedAdditionalViewIds] = useState<Record<string, boolean>>({});
  const [failedPrimaryViewIds, setFailedPrimaryViewIds] = useState<Record<string, boolean>>({});
  const primaryViewDescriptionIdPrefix = useId();
  const updatePrimaryViewFailureState = useCallback((stableId: string, hasFailure: boolean) => {
    setFailedPrimaryViewIds((current) => {
      if (current[stableId] === hasFailure) {
        return current;
      }
      return {
        ...current,
        [stableId]: hasFailure,
      };
    });
  }, []);

  const showThinkingUi = isBusy && !isPausedForApproval;
  const isActiveThinking = Boolean(
    showThinkingUi && processingTurnId && resolvedTurnId === processingTurnId && !isStopping
  );

  const taskDisplayProps = useMemo(() => {
    const turnDelta = inlineSteps?.turnTaskDelta ?? null;
    return computeTaskDisplayProps(
      turnDelta,
      inlineSteps?.missionContext ?? null,
      isActiveThinking,
    );
  }, [inlineSteps?.turnTaskDelta, inlineSteps?.missionContext, isActiveThinking]);

  /**
   * @param source - 'mouse' | 'keyboard'. Mouse activation skips when there's a
   *                 live text selection to avoid stealing the user's drag-select.
   *                 Keyboard activation (Enter/Space) always fires — global
   *                 selection state shouldn't block accessibility activation.
   */
  const handleActivate = (source: 'mouse' | 'keyboard' = 'mouse') => {
    if (!isSelectableTurn || !resolvedTurnId) {
      return;
    }
    // Don't focus the turn (which triggers a re-render storm) when the user
    // is in the middle of a text-selection drag. Without this guard, mouseup
    // at the end of a drag-select bubbles to the article's onClick, calls
    // onFocusTurn, and the resulting re-render destroys/recreates the DOM
    // text nodes underneath the selection — collapsing the selection just
    // as the user finishes the drag. See
    // `docs-private/investigations/260427_text_selection_unstable_v2.md`.
    //
    // Only check selection for mouse activation. Keyboard activation is an
    // explicit user gesture that should never be silently swallowed by an
    // unrelated selection elsewhere on the page (accessibility / screen reader).
    if (source === 'mouse') {
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (selection && !selection.isCollapsed) {
        return;
      }
    }
    onFocusTurn(resolvedTurnId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSelectableTurn) {
      return;
    }
    // Only activate when the message card itself has focus, not descendants.
    // React portal events bubble through the component tree, so a textarea
    // inside a portaled dialog would otherwise have its space key swallowed.
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleActivate('keyboard');
    }
  };

  const handleCopy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onCopyToClipboard(text);
    } catch (error) {
      console.warn('Clipboard write failed', error);
      showToast?.({ title: 'Couldn’t copy to clipboard' });
    }
  };
  const hostComposedCopyText = useMemo(() => {
    if (message.role === 'user' || primaryMcpAppTools.length === 0) {
      return message.displayText ?? message.text ?? '';
    }

    return buildMcpAppAwareMessageText(
      message.text,
      primaryMcpAppTools.map((tool, index) => ({
        type: 'tool' as const,
        toolName: tool.toolName ?? tool.label,
        toolUseId: tool.toolUseId,
        detail: tool.detail ?? tool.label,
        stage: 'end' as const,
        timestamp: index,
        mcpAppUiMeta: tool.mcpAppUiMeta,
        toolResult: tool.toolResult,
      })),
    );
  }, [message.displayText, message.role, message.text, primaryMcpAppTools]);
  const selectedInlineStepCopyText =
    selectedInlineStep &&
    message.role !== "user" &&
    "text" in selectedInlineStep
      ? selectedInlineStep.text
      : null;
  const shouldShowMessageCopyButton = Boolean(
    selectedInlineStepCopyText
      || message.role === 'user'
      || primaryMcpAppTools.length === 0,
  );

  const renderMcpAppView = (tool: McpAppToolSummary, index: number, isPrimary: boolean) => {
    const uiMeta = tool.mcpAppUiMeta;
    const stableId = getToolStableId(tool, index);
    return (
      <McpAppView
        key={`mcp-app-view-${tool.toolUseId ?? index}`}
        uiMeta={uiMeta}
        sessionId={sessionIdForFeedback}
        conversationId={sessionIdForFeedback}
        toolUseId={tool.toolUseId}
        theme={resolvedTheme}
        toolResult={tool.toolResult}
        toolResultText={tool.detail ?? tool.label}
        trustedPreviewDomains={settingsContext?.settings?.trustedPreviewDomains}
        iframeTitle={isPrimary ? getPrimaryViewIframeTitle(uiMeta) : undefined}
        onFailureStateChange={isPrimary
          ? (hasFailure) => updatePrimaryViewFailureState(stableId, hasFailure)
          : undefined}
        renderErrorFallback={isPrimary
          ? ({ retry }) => (
              <McpAppRecoveryNotice
                uiMeta={uiMeta}
                agentProse={message.text ?? ''}
                onRetry={retry}
                onCopyFallback={handleCopy}
              />
            )
          : undefined}
      />
    );
  };

  const renderPrimaryMcpAppSection = (
    tool: McpAppToolSummary,
    index: number,
    options: { includeCaption?: boolean } = {},
  ) => {
    const uiMeta = tool.mcpAppUiMeta;
    const summaryDescriptionId = `${primaryViewDescriptionIdPrefix}-mcp-app-${index}-summary`;
    const viewSummary = uiMeta.viewSummary?.trim();
    const roleLabel = getPrimaryViewRoleLabel(uiMeta);
    const stableId = getToolStableId(tool, index);

    return (
      <section
        key={`mcp-app-msg-${tool.toolUseId ?? index}`}
        className={styles.mcpAppPrimaryView}
        aria-describedby={summaryDescriptionId}
        data-testid="mcp-app-primary-view"
        onClick={(event) => event.stopPropagation()}
      >
        <p id={summaryDescriptionId} className={styles.srOnly}>
          {viewSummary || `${roleLabel} ready.`}
        </p>
        {options.includeCaption ? (
          <PrimaryProseCaption
            prose={
              message.text?.trim()
                ? message.text
                : getPrimaryMcpAppCaptionDefault(uiMeta) ?? ''
            }
          />
        ) : null}
        <PrimaryViewSourceStrip
          sourcePackageId={uiMeta.sourcePackageId}
          viewRoleLabel={roleLabel}
          hasFailure={Boolean(failedPrimaryViewIds[stableId])}
        />
        {renderMcpAppView(tool, index, true)}
      </section>
    );
  };

  // Per-turn timing from the turn's event timestamps (min/max). Declared here so
  // both the activity recap below and the timestamp tooltip can read it.
  const turnTiming = extractTurnTiming(turnEvents);

  // Per-turn recap inputs (files/tools/duration/errors), derived ONCE so both
  // surfaces that show the recap stay in lockstep: the inline work disclosure
  // (`renderInlineWorkDisclosure`, primary-MCP-app branch) AND the ordinary-turn
  // host `ContextualProgressCard` (Stage 6 F1). The counts mirror WorkSurface's
  // `storylineStats` / Behind-the-Scenes drawer scope — distinct file paths,
  // deduped inline tool count (excludes primary MCP-app views), error events.
  const turnActivityRecapInputs = useMemo(() => {
    if (!inlineSteps) {
      return { filesTouched: 0, toolCount: 0, durationMs: undefined as number | undefined, errors: 0 };
    }
    const filePaths = new Set<string>();
    inlineSteps.flattenedFileOperations.forEach((operation) => {
      if (operation.filePath) {
        filePaths.add(operation.filePath);
      }
    });
    const errorCount = inlineSteps.technicalEvents.filter((event) => event.type === 'error').length;
    return {
      filesTouched: filePaths.size,
      toolCount: inlineToolCount,
      // Duration sourced from the turn's event timestamps (min/max). Omitted
      // when not computable.
      durationMs: turnTiming.durationMs ?? undefined,
      errors: errorCount,
    };
  }, [inlineSteps, inlineToolCount, turnTiming.durationMs]);

  const renderInlineWorkDisclosure = () => {
    if (!inlineSteps || inlineToolCount === 0) return null;

    const recap = deriveTurnActivityRecap(turnActivityRecapInputs);

    // Prefer the AI one-sentence summary when present for this turn; otherwise
    // fall back to the deterministic count-line. The summary arrives async via
    // the `session:activity-summary-generated` broadcast, so the count-line
    // shows first and the sentence swaps in. The label is clamped to one line
    // (CSS), so the swap is a pure text change — no height/layout change, no
    // auto-scroll fight (see useConversationAutoScroll). The swap is silent to
    // screen readers (no aria-live on the label).
    const activitySummary = resolvedTurnId
      ? activitySummaryByTurn[resolvedTurnId]
      : undefined;
    const deterministicLabel =
      recap.label || (inlineToolCount === 1 ? 'Show details' : `Show ${inlineToolCount} steps`);
    const disclosureLabel = activitySummary ?? deterministicLabel;
    // ariaLabel reflects whichever label is actually shown. For the AI sentence
    // we keep the orienting "Show how Rebel worked" framing + the sentence so a
    // screen-reader user knows the control expands the work detail.
    const disclosureAriaLabel = activitySummary
      ? `Show how Rebel worked: ${activitySummary}`
      : recap.label
        ? recap.ariaLabel
        : 'Show agent work for this message';

    return (
      <MessageWorkDisclosure
        label={disclosureLabel}
        forceOpenWhenActiveOrFailed={inlineWorkHasActiveOrFailedTool}
        ariaLabel={disclosureAriaLabel}
      >
        <TurnStepsInline
          steps={inlineWorkSteps}
          fileOperationsByStep={inlineSteps.fileOperationsByStep}
          toolSummariesByStep={inlineToolSummariesByStep}
          modelByStep={inlineSteps.modelByStep}
          selectedStepNumber={selectedInlineStepNumber}
          subAgentTimeline={subAgentTimeline ?? null}
          isThinking={Boolean(
            showThinkingUi && processingTurnId && resolvedTurnId === processingTurnId && !isStopping
          )}
          thinkingHeadline={thinkingHeadline}
          thinkingElapsedLabel={thinkingElapsedLabel}
          missionContext={inlineSteps.missionContext}
          taskProgress={inlineSteps.taskProgress}
          sessionId={sessionIdForFeedback}
          onOpenConversation={onOpenConversation}
          onSelectStep={(stepNumber) => {
            if (resolvedTurnId) {
              onSelectInlineStep(resolvedTurnId, stepNumber);
            }
          }}
          headless
        />
      </MessageWorkDisclosure>
    );
  };

  const memoryStatus = resolvedTurnId
    ? memoryStatusByTurn[resolvedTurnId]
    : undefined;
  const timeSavedStatus = resolvedTurnId
    ? timeSavedStatusByTurn[resolvedTurnId]
    : undefined;

  // Check if this turn has completed (has a result event)
  // This gates showing "No memory changes" - we only show it for completed turns
  const turnHasResultEvent = turnEvents.some(e => e.type === 'result');
  const canShowConversationFeedbackHere =
    showConversationFeedback && (message.role === 'assistant' || message.role === 'result');
  const visibleHeaderLabel = label === 'Summary' ? null : label;
  const turnEndingKind = classifyTurnEnding(message.endedWith).kind;
  const hasAssistantHeaderIndicators = Boolean(
    (message.role === "assistant" || message.role === "result") && resolvedTurnId
  );
  const shouldShowMessageHeader = Boolean(
    visibleHeaderLabel || turnEndingKind === 'transient_error' || hasAssistantHeaderIndicators
  );
  const usageAction = resolvedTurnId && (message.role === 'assistant' || message.role === 'result') && usageData ? (
    <Tooltip
      content={<UsageTooltipContent usage={usageData} />}
      placement="top"
      delayShow={200}
    >
      <button
        type="button"
        className={cn(styles.action, styles.infoIcon)}
        onClick={(event) => event.stopPropagation()}
        aria-label={usageData.fallbacks?.length
          ? "Turn usage — degradation occurred"
          : "View turn usage details"}
      >
        <Database size={14} aria-hidden />
        {usageData.fallbacks && usageData.fallbacks.length > 0 && (
          <span className={styles.fallbackDot} aria-hidden />
        )}
      </button>
    </Tooltip>
  ) : null;
  const copyAction = shouldShowMessageCopyButton ? (
    <Tooltip content="Copy message" placement="top" delayShow={300}>
      <span className={styles.tooltipTrigger}>
        <button
          type="button"
          className={cn(styles.action, styles.usageButton)}
          onClick={(event) => {
            event.stopPropagation();
            void handleCopy(selectedInlineStepCopyText ?? hostComposedCopyText);
          }}
          aria-label="Copy message"
          data-testid="message-copy-button"
          disabled={!((selectedInlineStepCopyText ?? hostComposedCopyText)?.trim().length > 0)}
        >
          <Copy size={14} aria-hidden />
        </button>
      </span>
    </Tooltip>
  ) : null;
  const timestampAction = timestamp ? (
    <Tooltip
      content={
        <TimestampTooltipContent
          startedAt={message.createdAt}
          finishedAt={turnTiming.finishedAt}
          durationMs={turnTiming.durationMs}
        />
      }
      placement="top"
      delayShow={200}
    >
      <time>{timestamp}</time>
    </Tooltip>
  ) : null;
  const retryAction = canRetryThisMessage ? (
    <Tooltip content="Retry interrupted turn" placement="top" delayShow={300}>
      <span className={styles.tooltipTrigger}>
        <button
          type="button"
          className={styles.action}
          onClick={(event) => {
            event.stopPropagation();
            onRetryMessage(message.id);
          }}
          disabled={isStopping}
          aria-label="Retry interrupted turn"
          data-testid="message-retry-button"
        >
          <RotateCcw size={16} aria-hidden />
        </button>
      </span>
    </Tooltip>
  ) : null;
  const editAction = canEditThisMessage ? (
    <Tooltip
      content={isEditingThisMessage ? "Editing..." : "Edit message"}
      placement="top"
      delayShow={300}
    >
      <span className={styles.tooltipTrigger}>
        <button
          type="button"
          className={styles.action}
          onClick={(event) => {
            event.stopPropagation();
            onBeginEditMessage(message.id);
          }}
          disabled={isStopping}
          aria-label="Edit message"
          data-testid="message-edit-button"
        >
          <PenSquare size={16} aria-hidden />
        </button>
      </span>
    </Tooltip>
  ) : null;
  const hasMessageFooter = Boolean(
    usageAction || copyAction || timestampAction || retryAction || editAction || canShowConversationFeedbackHere
  );

  if (message.isApprovalReceipt) {
    return (
      <article
        className={cn(styles.message, styles.approvalReceipt)}
        data-message-id={message.id}
        data-role="receipt"
      >
        <span className={styles.approvalReceiptContent}>
          <BellRing size={14} className={styles.approvalReceiptIcon} aria-hidden />
          <span className={styles.approvalReceiptText}>{message.text}</span>
        </span>
      </article>
    );
  }

  if (message.isWarning) {
    return (
      <article
        className={cn(styles.message, styles.warningBanner)}
        data-message-id={message.id}
        data-role="warning"
      >
        <span className={styles.warningBannerContent}>
          <AlertTriangle size={14} className={styles.warningBannerIcon} aria-hidden />
          <span className={styles.warningBannerText}>{message.text}</span>
        </span>
      </article>
    );
  }

  return (
    <Fragment>
      <article
        className={cn(
          "agent-turn-message",
          styles.message,
          roleStyles[message.role as MessageRole],
          isAppAttributedUserMessage && styles.appAttributedUser,
          isSelectableTurn && styles.isSelectable,
          isActiveTurnMessage && styles.activeRun,
          isNewMessage && (message.role === "user" ? styles.messageEntranceUser : styles.messageEntranceAssistant),
          isSpotlighted && styles.turnCompleteSpotlight
        )}
        data-message-id={message.id}
        data-role={message.role}
        data-turn-id={message.turnId}
        onClick={isSelectableTurn ? () => handleActivate('mouse') : undefined}
        onKeyDown={isSelectableTurn ? handleKeyDown : undefined}
        role={isSelectableTurn ? "button" : undefined}
        tabIndex={isSelectableTurn ? 0 : undefined}
        aria-pressed={
          isSelectableTurn
            ? isActiveTurnMessage
              ? "true"
              : "false"
            : undefined
        }
        aria-label={
          isSelectableTurn && turnId
            ? isActiveTurnMessage
              ? "Viewing this run"
              : "View this run"
            : undefined
        }
      >
        {shouldShowMessageHeader ? (
          <header className={styles.header}>
            <span className={styles.label}>
              {visibleHeaderLabel ? <span>{visibleHeaderLabel}</span> : null}
              {turnEndingKind === 'transient_error' ? (
                <span
                  className={styles.transientErrorMarker}
                  role="status"
                  aria-label="Connection dropped before this turn finished"
                  title="The connection dropped before Rebel could wrap up. The work it completed is preserved."
                >
                  <WifiOff size={11} aria-hidden />
                  <span>Connection dropped</span>
                </span>
              ) : null}
              {(message.role === "assistant" || message.role === "result") &&
              resolvedTurnId ? (
                <>
                  <InsightsPill turnId={resolvedTurnId} />
                  {(memoryStatus || turnHasResultEvent) ? (
                    <MemoryUpdateIndicator
                      status={memoryStatus}
                      fileOperations={turnStepContext?.flattenedFileOperations}
                      onOpenFile={onOpenFile}
                    />
                  ) : null}
                  <TeamKnowledgeIndicator
                    turnEvents={turnEvents}
                    onOpenFile={onOpenFile}
                  />
                  {timeSavedStatus ? (
                    <TimeSavedSummary status={timeSavedStatus} />
                  ) : null}
                </>
              ) : null}
            </span>
          </header>
        ) : null}
        <div className={styles.body} data-message-body>
          {message.role === "user" ? (
              <>
                {appMessageAttribution ? (
                  <div className={styles.appAttributedUserBody} data-testid="mcp-app-attributed-user-message">
                    <p>{appAttributedVisibleText}</p>
                    <div className={styles.appAttributedUserMeta}>
                      <Package size={13} aria-hidden />
                      <span>from {appMessageAttribution.sourcePackageFamily}</span>
                      {appAttributedMessageWasCleaned ? <span>· cleaned</span> : null}
                    </div>
                  </div>
                ) : (
                  <p>{message.displayText ?? message.text}</p>
                )}
                {message.attachments && message.attachments.length > 0 ? (
                  <div className={styles.attachments}>
                    {(message.attachments as AnyAttachmentPayload[]).map((attachment: AnyAttachmentPayload) => (
                      isImageAttachment(attachment) ? (
                        (attachment.previewBase64Data ?? attachment.base64Data) ? (
                          <figure key={attachment.id} className={styles.imageAttachment}>
                            <ToolResultImage
                              image={{
                                type: 'image',
                                data: attachment.previewBase64Data ?? attachment.base64Data,
                                mimeType: attachment.mimeType,
                              }}
                              alt={`Attached image: ${attachment.name}`}
                              thumbnailSize="compact"
                            />
                          </figure>
                        ) : (
                          <div key={attachment.id} className={styles.fileAttachment}>
                            <span className={styles.attachmentName}>
                              📷 {attachment.name}
                            </span>
                          </div>
                        )
                      ) : (
                        <div key={attachment.id} className={styles.fileAttachment}>
                          <span className={styles.attachmentName}>
                            {attachment.name}
                          </span>
                          {'relativePath' in attachment && (
                            <span className={styles.attachmentPath}>
                              {attachment.relativePath}
                            </span>
                          )}
                        </div>
                      )
                    ))}
                  </div>
                ) : null}
                <MeetingTurnSpeakerAttribution message={message} />
              </>
          ) : (
            <>
              {trustRejectionNotice ? (
                <Notice
                  tone={trustRejectionNotice.reason === 'rate_limited' ? 'warning' : 'info'}
                  placement="inline"
                  role="status"
                  data-testid="mcp-app-trust-rejection-notice"
                >
                  <div className={styles.noticeActionRow}>
                    <span>{trustRejectionNotice.message}</span>
                    {canGrantMcpAppContextPermission ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleGrantMcpAppContextPermission}
                        data-testid="mcp-app-grant-context-button"
                      >
                        Grant for this conversation
                      </Button>
                    ) : null}
                  </div>
                </Notice>
              ) : null}
              {showInterruptedRecoveryNotice ? (
                <div className={styles.interruptedRecoveryNotice} role="status" aria-live="polite">
                  <div className={styles.interruptedRecoveryStatus}>
                    <WifiOff size={12} aria-hidden />
                    <span className={styles.interruptedRecoveryText} data-testid="interrupted-turn-status">
                      Interrupted — answer may be incomplete.
                    </span>
                  </div>
                  <div className={styles.interruptedRecoveryActions}>
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      onClick={handleInterruptedTryAgain}
                      disabled={isStopping}
                      data-testid="interrupted-turn-try-again-button"
                    >
                      Try again
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className={styles.interruptedRecoveryDismiss}
                      onClick={handleDismissInterruptedNotice}
                      data-testid="interrupted-turn-dismiss-button"
                    >
                      Dismiss notice
                    </Button>
                  </div>
                </div>
              ) : null}
              {/*
                Stage 1b (260617_bricked-state-0448-electron42): SOFT "still
                waiting" affordance (State B). Calm/info tone — NOT an error, NOT
                a modal. The spinner keeps running; this only acknowledges the
                slow turn and offers a guarded exit. "Try again" is stop-then-
                resend (the turn is still alive); "Stop" is the guaranteed exit.
                Reuses the interrupted-recovery row anatomy above (role="status"
                aria-live="polite", Button size="xs", disabled while stopping).
              */}
              {showSoftStallNotice ? (
                <div className={styles.interruptedRecoveryNotice} role="status" aria-live="polite">
                  <div className={styles.interruptedRecoveryStatus}>
                    <Clock size={12} aria-hidden />
                    <span className={styles.interruptedRecoveryText} data-testid="soft-stall-status">
                      {AWAITING_API_SOFT_STALL_MESSAGE} {AWAITING_API_SOFT_STALL_HINT}
                    </span>
                  </div>
                  <div className={styles.interruptedRecoveryActions}>
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      onClick={handleSoftStallTryAgain}
                      disabled={isStopping || !canSoftStallTryAgain}
                      data-testid="soft-stall-try-again-button"
                    >
                      Try again
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={handleSoftStallStop}
                      disabled={isStopping || !canSoftStallStop}
                      data-testid="soft-stall-stop-button"
                    >
                      Stop
                    </Button>
                  </div>
                </div>
              ) : null}
              {/*
                Primary MCP App rendering (presentation: 'primary').
                Schema in src/shared/types/agent.ts; See
                docs/plans/260507_unified_interactive_ui_architecture.md § Phase A3.
              */}
              {mcpAppsEnabled && leadPrimaryMcpAppTool && !selectedInlineStep ? (
                <>
                  {renderPrimaryMcpAppSection(leadPrimaryMcpAppTool, 0, { includeCaption: true })}
                  {demotedPrimaryMcpAppTools.length > 0 ? (
                    <div className={styles.additionalViewsList} data-testid="additional-view-rows">
                      {demotedPrimaryMcpAppTools.map((tool, demotedIndex) => {
                        const stableId = getToolStableId(tool, demotedIndex + 1);
                        const expanded = Boolean(expandedAdditionalViewIds[stableId]);
                        const controlledRegionId = `${primaryViewDescriptionIdPrefix}-additional-${stableId.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
                        return (
                          <Fragment key={`additional-view-${stableId}`}>
                            <AdditionalViewRow
                              viewRoleLabel={getPrimaryViewRoleLabel(tool.mcpAppUiMeta)}
                              viewSummary={tool.mcpAppUiMeta.viewSummary?.trim() || tool.detail || tool.label}
                              status={getAdditionalViewStatus(tool)}
                              expanded={expanded}
                              controlledRegionId={controlledRegionId}
                              onOpen={() => {
                                setExpandedAdditionalViewIds((current) => ({
                                  ...current,
                                  [stableId]: !current[stableId],
                                }));
                              }}
                            />
                            {expanded ? (
                              <div
                                id={controlledRegionId}
                                className={styles.additionalViewExpandedBody}
                                data-testid="additional-view-expanded"
                              >
                                {/* Demoted primary iframes are intentionally loaded only after expansion.
                                    Eagerly pre-loading N additional views would be a performance regression;
                                    v2 can add a lighter resource probe if field data says failure-before-open
                                    needs to be surfaced earlier. */}
                                {renderPrimaryMcpAppSection(tool, demotedIndex + 1)}
                              </div>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </div>
                  ) : null}
                  {renderInlineWorkDisclosure()}
                </>
              ) : null}
              {resolvedTurnId && (!mcpAppsEnabled || !leadPrimaryMcpAppTool || selectedInlineStep) && (
                taskDisplayProps ||
                (inlineSteps && (inlineSteps.assistantSteps.length > 0 || inlineSteps.toolSummariesByStep.size > 0)) ||
                subAgentTimeline ||
                (focusedTurnId && resolvedTurnId === focusedTurnId) ||
                // Keep the card mounted during the early window of an MCP build
                // where no steps/tools have fired yet. Without this, a focus
                // change that flips focusedTurnId could unmount the card while
                // "Writing <name>" is still the only activity signal, leaving
                // the user with no visible progress until the next tool event.
                (mcpBuildActivity && processingTurnId && resolvedTurnId === processingTurnId)
              ) ? (
                <ContextualProgressCard
                  missionContext={taskDisplayProps?.displayMission}
                  taskProgress={taskDisplayProps?.displayTasks}
                  snapshotCounts={taskDisplayProps?.snapshotCounts}
                  steps={inlineSteps?.assistantSteps ?? []}
                  fileOperationsByStep={inlineSteps?.fileOperationsByStep ?? new Map()}
                  toolSummariesByStep={inlineSteps?.toolSummariesByStep ?? new Map()}
                  modelByStep={inlineSteps?.modelByStep ?? new Map()}
                  modelByTaskId={inlineSteps?.modelByTaskId}
                  selectedStepNumber={selectedInlineStepNumber}
                  subAgentTimeline={subAgentTimeline ?? null}
                  isThinking={Boolean(
                    showThinkingUi && processingTurnId && resolvedTurnId === processingTurnId && !isStopping
                  )}
                  isBusy={isBusy}
                  isPaused={isPausedForApproval}
                  sessionId={sessionIdForFeedback}
                  thinkingHeadline={
                    focusedTurnId && resolvedTurnId === focusedTurnId
                      ? thinkingHeadline
                      : undefined
                  }
                  thinkingElapsedLabel={
                    focusedTurnId && resolvedTurnId === focusedTurnId
                      ? thinkingElapsedLabel
                      : undefined
                  }
                  mcpBuildActivity={
                    processingTurnId && resolvedTurnId === processingTurnId
                      ? mcpBuildActivity
                      : undefined
                  }
                  activityRecap={{
                    // AI sentence for this turn (async; falls back to the
                    // deterministic count-line until it arrives). Same source
                    // the inline work disclosure reads.
                    summary: resolvedTurnId ? activitySummaryByTurn[resolvedTurnId] : undefined,
                    ...turnActivityRecapInputs,
                  }}
                  turnEvents={turnEvents}
                  isStopping={isStopping}
                  endedWith={message.endedWith}
                  onContinue={onContinueIncomplete && !isBusy ? onContinueIncomplete : undefined}
                  onOpenConversation={onOpenConversation}
                  onSelectStep={(stepNumber) => {
                    if (resolvedTurnId) {
                      onSelectInlineStep(resolvedTurnId, stepNumber);
                    }
                  }}
                />
              ) : null}
              {appScreenshotItems.length > 0 ? (
                <section className={styles.visualEvidence} aria-label="Screenshot captured by Rebel">
                  <span className={styles.visualEvidenceLabel}>Screenshot captured</span>
                  <ImageGrid images={appScreenshotItems} />
                </section>
              ) : null}
              {/* MCP Apps interactive views -- rendered at message level alongside the result text */}
              {mcpAppsEnabled && !leadPrimaryMcpAppTool && deduplicatedInlineMcpAppTools.length > 0 ? (
                deduplicatedInlineMcpAppTools.map((tool, idx) => renderMcpAppView(tool, idx, false))
              ) : null}
              {/* Hide message content while turn is actively thinking with steps.
                  message.text is a cumulative aggregation of all assistant text events
                  (joined with \n\n), which are the same texts shown as step snippets in
                  TurnStepsInline. Showing both produces visible duplication.
                  Show MessageMarkdown when:
                  - Viewing a specific step (selectedInlineStep), OR
                  - Turn is complete (not actively thinking), OR
                  - No steps exist yet (message content is the only thing to show) */}
              {(() => {
                const isActivelyThinking = Boolean(showThinkingUi && processingTurnId && resolvedTurnId === processingTurnId && !isStopping);
                const hasLiveActivitySurface = Boolean(
                  inlineSteps && (
                    inlineSteps.assistantSteps.length > 0
                    || inlineSteps.toolSummariesByStep.size > 0
                    || inlineSteps.pendingTodos.length > 0
                    || (inlineSteps.taskProgress && inlineSteps.taskProgress.length > 0)
                    || inlineSteps.missionContext != null
                  )
                ) || Boolean(subAgentTimeline);
                
                // If viewing a specific step, show that step's content
                if (selectedInlineStep) {
                  const contentToShow = "text" in selectedInlineStep
                    ? selectedInlineStep.text
                    : message.text;
                  return (
                    <MessageMarkdown
                      content={contentToShow}
                      onOpenFile={onOpenFile}
                      onOpenFolder={onOpenFolder}
                      onOpenConversation={onOpenConversation}
                      onNavigate={onNavigate}
                      onOpenTutorial={onOpenTutorial}
                      showToast={showToast}
                      coreDirectory={coreDirectory}
                      onOpenInLibrary={onOpenInLibrary}
                    />
                  );
                }

                // Primary MCP App views own the assistant body. Prose, when present,
                // is rendered above the view as a compact caption so we don't repeat it.
                if (mcpAppsEnabled && leadPrimaryMcpAppTool) {
                  return null;
                }
                
                // Turn complete - always show the final message
                if (!isActivelyThinking) {
                  return (
                    <MessageMarkdown
                      content={message.text}
                      onOpenFile={onOpenFile}
                      onOpenFolder={onOpenFolder}
                      onOpenConversation={onOpenConversation}
                      onNavigate={onNavigate}
                      onOpenTutorial={onOpenTutorial}
                      showToast={showToast}
                      coreDirectory={coreDirectory}
                      onOpenInLibrary={onOpenInLibrary}
                    />
                  );
                }
                
                // Actively thinking with visible activity UI - hide markdown to avoid
                // resurfacing narrated interim assistant text below TurnStepsInline.
                if (hasLiveActivitySurface) {
                  return null;
                }
                
                // Actively thinking but no live activity surface yet - show whatever content we have
                return (
                  <MessageMarkdown
                    content={message.text}
                    onOpenFile={onOpenFile}
                    onOpenFolder={onOpenFolder}
                    onOpenConversation={onOpenConversation}
                    onNavigate={onNavigate}
                    onOpenTutorial={onOpenTutorial}
                    showToast={showToast}
                    coreDirectory={coreDirectory}
                    onOpenInLibrary={onOpenInLibrary}
                  />
                );
              })()}
            </>
          )}
        </div>
        {hasMessageFooter ? (
          <footer className={styles.footer} aria-label="Message actions and response feedback">
            <span className={styles.footerMeta} role="group" aria-label="Message actions and metadata">
              {usageAction}
              {copyAction}
              {timestampAction}
              {retryAction}
              {editAction}
            </span>
            {canShowConversationFeedbackHere ? (
              <ConversationFeedbackPrompt
                sessionId={sessionIdForFeedback}
                isBusy={isBusy}
                messageCount={messageCount}
                anchorMessageId={conversationFeedbackAnchor?.anchorMessageId}
                anchorTurnId={conversationFeedbackAnchor?.anchorTurnId}
                anchorMessageIndex={conversationFeedbackAnchor?.anchorMessageIndex}
                className={styles.footerFeedback}
                showToast={showToast}
              />
            ) : null}
          </footer>
        ) : null}
        {selectedInlineStep && resolvedTurnId ? (
          <div className={styles.swapNotice}>
            <span>
              Showing step {selectedInlineStepNumber}
              {inlineSteps ? ` of ${inlineSteps.assistantSteps.length}` : ""}
            </span>
            <button
              type="button"
              onClick={() => onSelectInlineStep(resolvedTurnId, null)}
            >
              Show final result
            </button>
          </div>
        ) : null}
      </article>
      {boundaryAfterThis && (
        <CompactionBoundary
          boundary={boundaryAfterThis}
          messageCount={messageCount}
        />
      )}
    </Fragment>
  );
};

MessageItemComponent.displayName = "MessageItem";

function conversationFeedbackAnchorEqual(
  a: MessageItemProps['conversationFeedbackAnchor'],
  b: MessageItemProps['conversationFeedbackAnchor'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.anchorMessageId === b.anchorMessageId &&
    a.anchorTurnId === b.anchorTurnId &&
    a.anchorMessageIndex === b.anchorMessageIndex
  );
}

function getTurnScopedValue<T>(
  map: Record<string, T>,
  turnId: string | null,
): T | undefined {
  return turnId ? map[turnId] : undefined;
}

function areMessageItemPropsEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  if (prev.message !== next.message) return false;
  if (prev.isNewMessage !== next.isNewMessage) return false;
  if (prev.isSpotlighted !== next.isSpotlighted) return false;
  if (prev.boundaryAfterThis !== next.boundaryAfterThis) return false;
  if (prev.messageCount !== next.messageCount) return false;
  if (prev.sessionIdForFeedback !== next.sessionIdForFeedback) return false;
  if (prev.showConversationFeedback !== next.showConversationFeedback) return false;
  if (!conversationFeedbackAnchorEqual(prev.conversationFeedbackAnchor, next.conversationFeedbackAnchor)) return false;
  if (prev.resolvedTurnId !== next.resolvedTurnId) return false;
  if (prev.turnEvents !== next.turnEvents) return false;
  if (prev.turnStepContext !== next.turnStepContext) return false;
  if (prev.subAgentTimeline !== next.subAgentTimeline) return false;
  if (
    getTurnScopedValue(prev.activeStepByTurn, prev.resolvedTurnId) !==
    getTurnScopedValue(next.activeStepByTurn, next.resolvedTurnId)
  ) {
    return false;
  }
  if (
    getTurnScopedValue(prev.memoryStatusByTurn, prev.resolvedTurnId) !==
    getTurnScopedValue(next.memoryStatusByTurn, next.resolvedTurnId)
  ) {
    return false;
  }
  if (
    getTurnScopedValue(prev.timeSavedStatusByTurn, prev.resolvedTurnId) !==
    getTurnScopedValue(next.timeSavedStatusByTurn, next.resolvedTurnId)
  ) {
    return false;
  }
  // Turn-scoped so a late activity-summary swap-in repaints THIS row (and only
  // this row) when the sentence arrives for its turn. (260618 show-more-activity)
  if (
    getTurnScopedValue(prev.activitySummaryByTurn, prev.resolvedTurnId) !==
    getTurnScopedValue(next.activitySummaryByTurn, next.resolvedTurnId)
  ) {
    return false;
  }
  if (prev.visibleTurnId !== next.visibleTurnId) return false;
  if (prev.focusedTurnId !== next.focusedTurnId) return false;
  if (prev.processingTurnId !== next.processingTurnId) return false;
  if (prev.editingMessageId !== next.editingMessageId) return false;
  if (prev.isBusy !== next.isBusy) return false;
  if (prev.isPausedForApproval !== next.isPausedForApproval) return false;
  if (prev.isStopping !== next.isStopping) return false;
  if (prev.thinkingHeadline !== next.thinkingHeadline) return false;
  // The elapsed timer is cosmetic and updates frequently during active turns.
  // Re-rendering a heavy historical/result row just to tick this label can
  // dominate conversation switching. Real activity changes still flow through
  // `thinkingHeadline`, `mcpBuildActivity`, events, and step context props.
  if (prev.mcpBuildActivity !== next.mcpBuildActivity) return false;
  if (prev.onFocusTurn !== next.onFocusTurn) return false;
  if (prev.onBeginEditMessage !== next.onBeginEditMessage) return false;
  if (prev.onRetryMessage !== next.onRetryMessage) return false;
  if (prev.onSelectInlineStep !== next.onSelectInlineStep) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onOpenFolder !== next.onOpenFolder) return false;
  if (prev.onOpenConversation !== next.onOpenConversation) return false;
  if (prev.onNavigate !== next.onNavigate) return false;
  if (prev.onOpenTutorial !== next.onOpenTutorial) return false;
  if (prev.onCopyToClipboard !== next.onCopyToClipboard) return false;
  if (prev.showToast !== next.showToast) return false;
  if (prev.coreDirectory !== next.coreDirectory) return false;
  if (prev.onOpenInLibrary !== next.onOpenInLibrary) return false;
  if (prev.onContinueIncomplete !== next.onContinueIncomplete) return false;
  if (prev.retrySourceMessageId !== next.retrySourceMessageId) return false;
  if (prev.onStopActiveTurn !== next.onStopActiveTurn) return false;
  return true;
}

export const MessageItem = memo(MessageItemComponent, areMessageItemPropsEqual);
