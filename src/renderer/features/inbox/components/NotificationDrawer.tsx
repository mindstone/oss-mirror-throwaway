import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Bell, X, ChevronRight, ChevronDown, Check, ExternalLink } from 'lucide-react';
import {
  usePendingApprovals,
  approvalOutcomeMessage,
  approvalOutcomeDescription,
  approvalOutcomeVariant,
  type ApprovalOutcome,
  type PendingApprovalItem,
} from '../hooks/usePendingApprovals';
import { useStagedFiles, type StagedFileItem } from '../hooks/useStagedFiles';
import { useAppNavigationSafe } from '@renderer/hooks/useAppNavigation';
import {
  getSessionStoreState,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import { Button, Tooltip, useToast } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { MemoryPreviewDialog } from './MemoryPreviewDialog';
import { StagedFilePreviewDialog } from './StagedFilePreviewDialog';
import { DrawerApprovalCard } from './DrawerApprovalCard';
import { DrawerQuestionWaitingCard } from './DrawerQuestionWaitingCard';
import { DrawerSkillNotificationCard } from './DrawerSkillNotificationCard';
import { MCPNotificationCard } from './MCPNotificationCard';
import { useSkillChangeNotifications, type SkillChangeNotificationItem } from '../hooks/useSkillChangeNotifications';
import { usePendingQuestionWaitingItems, type QuestionWaitingItem } from '../hooks/usePendingQuestionWaiting';
import { classifySessionKind } from '@shared/sessionKind';
import {
  classifyEffectKind,
  deriveActionPreview,
  isFileBackedEffectKind,
  type ActionPreviewInput,
} from '@rebel/shared';
import {
  buildStagedFileSaveReceipt,
  buildStagedFilesBatchSaveReceipt,
  type StagedFileSaveReceiptOptions,
} from './stagedFileReceipts';
import {
  useApprovalRedirectShadow,
  DEFAULT_REDIRECT_AUTO_DISMISS_MS,
  type ApprovalRedirectShadowValue,
} from '../hooks/useApprovalRedirectShadow';
import { redirectApprovalWithInstruction, type RedirectOutcome, type RedirectTarget } from '../utils/redirectApproval';
import type { ContributionNotificationItem } from '@renderer/features/homepage/hooks/useContributionNotifications';
import { appendErrorReason } from '@renderer/utils/actionErrorMessage';
import { toActionPreviewInput, type ToActionPreviewInputOptions } from '../utils/toActionPreviewInput';
import { ActionPreviewDialog, type ActionPreviewState } from '@renderer/components/approval/actionPreview';
import { useActionPreview } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getApprovalDecisionState } from './utils/approvalDecisionState';
import './NotificationDrawer.css';

export {
  buildStagedFileSaveReceipt,
  buildStagedFilesBatchSaveReceipt,
} from './stagedFileReceipts';

const SUCCESS_DISPLAY_DURATION = 800;
const ALL_CAUGHT_UP_AUTO_CLOSE_MS = 1000;
const POST_ACTION_EMPTY_AUTO_CLOSE_MS = 250;

export function getAllCaughtUpAutoCloseDelay(args: {
  totalCount: number;
  approvalsLoading: boolean;
  skillNotificationsLoading: boolean;
  previousTotalCount: number | null;
}): number | null {
  const {
    totalCount,
    approvalsLoading,
    skillNotificationsLoading,
    previousTotalCount,
  } = args;

  if (totalCount !== 0 || approvalsLoading || skillNotificationsLoading) {
    return null;
  }

  return previousTotalCount && previousTotalCount > 0
    ? POST_ACTION_EMPTY_AUTO_CLOSE_MS
    : ALL_CAUGHT_UP_AUTO_CLOSE_MS;
}

type NotificationDrawerProps = {
  onClose: () => void;
  onSendMessageToSession?: (
    sessionId: string,
    message: string,
    receiptText?: string,
  ) => Promise<void> | void;
  onAddReceiptToSession?: (sessionId: string, receiptText: string) => Promise<void> | void;
  busySessionIds?: Set<string>;
  scrollToSessionId?: string | null;
  onScrollComplete?: () => void;
  /** MCP contribution notification items to display in the drawer. */
  mcpNotifications?: ContributionNotificationItem[];
  /** Callback to dismiss (acknowledge) an MCP contribution notification on the drawer surface. */
  onDismissMcpNotification?: (contributionId: string, status: string) => void;
  /** Callback to navigate to the connector in Settings (for approved notifications). */
  onViewMcpConnector?: () => void;
  /** Callback to spawn a follow-up session for changes (for changes_requested notifications). */
  onMakeMcpChanges?: (notification: ContributionNotificationItem) => void;
};

type UnifiedItem =
  | { kind: 'approval'; id: string; timestamp: number; sessionId: string | null; groupTitle: string; approval: PendingApprovalItem }
  | { kind: 'question-waiting'; id: string; timestamp: number; sessionId: string; groupTitle: string; question: QuestionWaitingItem }
  | { kind: 'staged-file'; id: string; timestamp: number; sessionId: string | null; groupTitle: string; file: StagedFileItem }
  | { kind: 'skill-notification'; id: string; timestamp: number; sessionId: string | null; groupTitle: string; notification: SkillChangeNotificationItem }
  | { kind: 'mcp-notification'; id: string; timestamp: number; sessionId: string | null; groupTitle: string; mcpNotification: ContributionNotificationItem };

type MemoryApprovalContentIdentity = {
  toolUseId: string;
  originalSessionId?: string;
  filePath?: string;
  approvalIdentifier?: string;
};

interface ConversationGroup {
  sessionId: string;
  title: string;
  items: UnifiedItem[];
  mostRecentTimestamp: number;
}

const BACKGROUND_TASKS_KEY = "__background__";
const SKILL_UPDATES_KEY = '__skill_updates__';
const MCP_CONTRIBUTIONS_KEY = '__mcp_contributions__';
// Renderer-safe mirror of DEFAULT_SESSION_TITLES in
// src/core/services/conversationTitleService.ts. Importing that module here
// pulls renderer-unsafe transitive dependencies (behindTheScenesClient,
// promptFileService → node:fs, codexAuth). If a new default title is ever
// added in core, mirror it here.
const DEFAULT_DRAWER_TITLES = new Set(['New Agent Run', 'New conversation']);

function isPseudoSessionId(sessionId: string): boolean {
  return (
    sessionId === BACKGROUND_TASKS_KEY ||
    sessionId === SKILL_UPDATES_KEY ||
    sessionId === MCP_CONTRIBUTIONS_KEY
  );
}

type ResolveGroupDisplayTitleOptions = {
  maxPreviewLength?: number;
  defaultTitles?: ReadonlySet<string>;
};

export function truncatePreview(text: string, maxLen = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  if (maxLen <= 0) {
    return '';
  }
  if (maxLen === 1) {
    return '…';
  }
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

export function resolveGroupDisplayTitle(
  group: ConversationGroup,
  liveTitleById: ReadonlyMap<string, string>,
  options: ResolveGroupDisplayTitleOptions = {},
): string {
  if (isPseudoSessionId(group.sessionId)) {
    return group.title;
  }

  const defaultTitles = options.defaultTitles ?? DEFAULT_DRAWER_TITLES;
  const liveTitle = liveTitleById.get(group.sessionId);
  if (liveTitle && !defaultTitles.has(liveTitle)) {
    return liveTitle;
  }

  if (!defaultTitles.has(group.title)) {
    return group.title;
  }

  for (const item of group.items) {
    if (item.kind !== 'approval') {
      continue;
    }
    const preview = item.approval.sessionContext?.firstMessagePreview;
    if (!preview) {
      continue;
    }
    const truncatedPreview = truncatePreview(
      preview,
      options.maxPreviewLength,
    );
    if (truncatedPreview) {
      return truncatedPreview;
    }
  }

  return group.title;
}

export function shouldIgnoreGroupHeaderToggle(target: EventTarget | null): boolean {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;

  if (!element) {
    return false;
  }

  return Boolean(
    element.closest('button, a, input, textarea, select, [role="button"], [role="link"]'),
  );
}

function formatBatchApprovalFailureMessage(
  failed: number,
  failures: Array<{
    reason: Extract<ApprovalOutcome, { ok: false }>['reason'];
    detail?: string;
    displayName?: string;
  }>,
): string {
  const failureDetails = failures
    .map((failure) => {
      if (failure.detail) return failure.detail;
      return approvalOutcomeMessage({ ok: false, reason: failure.reason });
    })
    .filter((message): message is string => Boolean(message));

  if (failed === 1) {
    const firstFailure = failures[0];
    if (!firstFailure) return '1 action failed';
    const message = firstFailure.detail && firstFailure.reason !== 'execution-failed'
      ? firstFailure.detail
      : approvalOutcomeMessage({
          ok: false,
          reason: firstFailure.reason,
          detail: firstFailure.detail,
        });
    return message ? `1 action failed: ${message}` : '1 action failed';
  }

  const detailSuffix = failureDetails.slice(0, 2).join('; ');
  return detailSuffix
    ? `${failed} actions failed: ${detailSuffix}`
    : `${failed} actions failed`;
}

export function canRedirectItem(args: {
  item: UnifiedItem;
  hasSendMessageHandler: boolean;
  sessionSummaries: Array<{ id: string; deletedAt?: number | null }>;
}): boolean {
  const { item, hasSendMessageHandler, sessionSummaries } = args;
  if (!hasSendMessageHandler) return false;
  if (item.kind !== 'approval' && item.kind !== 'staged-file') return false;

  const sessionId = item.sessionId;
  if (!sessionId || isPseudoSessionId(sessionId)) return false;

  const summary = sessionSummaries.find((candidate) => candidate.id === sessionId);
  if (!summary) {
    const kind = classifySessionKind(sessionId);
    return kind === 'automation' || kind === 'automation-insight';
  }
  return summary.deletedAt == null;
}

export function isSourceSessionAvailable(args: {
  sessionId: string | null;
  sessionSummaries: Array<{ id: string; deletedAt?: number | null }>;
}): boolean {
  const { sessionId, sessionSummaries } = args;
  if (!sessionId || isPseudoSessionId(sessionId)) return true;

  const summary = sessionSummaries.find((candidate) => candidate.id === sessionId);
  if (!summary) {
    const kind = classifySessionKind(sessionId);
    return kind === 'automation' || kind === 'automation-insight';
  }
  return summary.deletedAt == null;
}

function focusQuestionTurnAfterSessionOpen(sessionId: string, turnId: string): void {
  let attempts = 0;
  const maxAttempts = 30;

  const tryFocus = () => {
    const state = getSessionStoreState();
    if (state.currentSessionId === sessionId) {
      state.setFocusedTurnId(turnId);
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) {
      requestAnimationFrame(tryFocus);
    }
  };

  requestAnimationFrame(tryFocus);
}

function isEvalErrorApproval(approval: PendingApprovalItem): boolean {
  if (approval.type === 'tool') return approval.toolApproval?.blockedBy === 'eval_error';
  if (approval.type === 'staged-tool') return approval.stagedToolCall?.blockedBy === 'eval_error';
  if (approval.type === 'memory') return approval.memoryApproval?.blockedBy === 'eval_error';
  return false;
}

function isEvalErrorStagedFile(file: StagedFileItem): boolean {
  return file.blockedBy === 'eval_error';
}

const DEFAULT_ACTION_PREVIEW_INPUT: ActionPreviewInput = {
  kind: 'tool',
  toolName: 'review_action',
  args: {},
};

function isStagedFileSourceItem(item: PendingApprovalItem | StagedFileItem): item is StagedFileItem {
  return 'realPath' in item && 'baseHash' in item;
}

function hasStagedToolArgs(approval: PendingApprovalItem): boolean {
  if (approval.type !== 'staged-tool' || !approval.stagedToolCall) return false;
  return Object.keys(approval.stagedToolCall.mcpPayload.args ?? {}).length > 0;
}

function getUnifiedItemId(item: PendingApprovalItem | StagedFileItem): string {
  return isStagedFileSourceItem(item) ? `staged-file:${item.id}` : item.id;
}

function isBatchActionableItem(item: UnifiedItem): boolean {
  if (item.kind === 'approval') return !isEvalErrorApproval(item.approval);
  if (item.kind === 'staged-file') return !isEvalErrorStagedFile(item.file);
  return false;
}

export function mergeGroupsWithRedirectShadows(
  liveGroups: ConversationGroup[],
  redirectOutcomeById: Map<string, ApprovalRedirectShadowValue>,
): ConversationGroup[] {
  if (redirectOutcomeById.size === 0) {
    return liveGroups;
  }

  const liveIds = new Set<string>();
  for (const group of liveGroups) {
    for (const item of group.items) {
      liveIds.add(item.id);
    }
  }

  const retainedToInject: UnifiedItem[] = [];
  for (const [id, shadow] of redirectOutcomeById) {
    if (!liveIds.has(id)) {
      retainedToInject.push(shadow.item);
    }
  }

  if (retainedToInject.length === 0) {
    return liveGroups;
  }

  const groupsBySession = new Map<string, ConversationGroup>();
  for (const group of liveGroups) {
    groupsBySession.set(group.sessionId, { ...group, items: [...group.items] });
  }

  for (const retained of retainedToInject) {
    const sessionKey = retained.sessionId ?? BACKGROUND_TASKS_KEY;
    let group = groupsBySession.get(sessionKey);
    if (!group) {
      group = {
        sessionId: sessionKey,
        title: sessionKey === BACKGROUND_TASKS_KEY ? 'Background tasks' : retained.groupTitle,
        items: [],
        mostRecentTimestamp: 0,
      };
      groupsBySession.set(sessionKey, group);
    }
    group.items.push(retained);
  }

  const mergedGroups: ConversationGroup[] = [];
  for (const group of groupsBySession.values()) {
    group.items.sort((first, second) => second.timestamp - first.timestamp);
    group.mostRecentTimestamp = group.items[0]?.timestamp ?? 0;
    mergedGroups.push(group);
  }

  mergedGroups.sort((first, second) => second.mostRecentTimestamp - first.mostRecentTimestamp);
  return mergedGroups;
}

function buildGroups(
  approvals: PendingApprovalItem[],
  stagedFiles: StagedFileItem[],
  questionWaitingItems: QuestionWaitingItem[],
  skillNotifications: SkillChangeNotificationItem[],
  mcpNotifications: ContributionNotificationItem[] = [],
  sessionSummaries: Array<{ id: string; deletedAt?: number | null }> = [],
): ConversationGroup[] {
  const unified: UnifiedItem[] = [
    ...approvals
      .filter((a) => isSourceSessionAvailable({ sessionId: a.sessionId, sessionSummaries }))
      .map((a): UnifiedItem => ({
        kind: 'approval',
        id: a.id,
        timestamp: a.timestamp,
        sessionId: a.sessionId,
        groupTitle: a.title,
        approval: a,
      })),
    ...stagedFiles
      .filter((f) => isSourceSessionAvailable({ sessionId: f.sessionId, sessionSummaries }))
      .map((f): UnifiedItem => ({
        kind: 'staged-file',
        id: `staged-file:${f.id}`,
        timestamp: f.stagedAt,
        sessionId: f.sessionId,
        groupTitle: f.sessionTitle ?? (f.sessionId ? 'Untitled conversation' : 'Background tasks'),
        file: f,
      })),
    ...questionWaitingItems
      .filter((question) => isSourceSessionAvailable({
        sessionId: question.sessionId,
        sessionSummaries,
      }))
      .map((question): UnifiedItem => ({
        kind: 'question-waiting',
        id: question.id,
        timestamp: question.timestamp,
        sessionId: question.sessionId,
        groupTitle: question.groupTitle,
        question,
      })),
    ...skillNotifications.map((notification): UnifiedItem => ({
      kind: 'skill-notification',
      id: `skill-notification:${notification.id}`,
      timestamp: notification.updatedAt,
      sessionId: SKILL_UPDATES_KEY,
      groupTitle: 'Skill updates',
      notification,
    })),
    ...mcpNotifications.map((item): UnifiedItem => ({
      kind: 'mcp-notification',
      id: item.key,
      timestamp: Date.now(),
      sessionId: MCP_CONTRIBUTIONS_KEY,
      groupTitle: 'Tools you\'ve shared',
      mcpNotification: item,
    })),
  ];

  const groupMap = new Map<string, { title: string; items: UnifiedItem[] }>();

  for (const item of unified) {
    const key = item.sessionId ?? BACKGROUND_TASKS_KEY;
    let group = groupMap.get(key);
    if (!group) {
      const title =
        key === BACKGROUND_TASKS_KEY ? "Background tasks" : item.groupTitle;
      group = { title, items: [] };
      groupMap.set(key, group);
    }
    group.items.push(item);
  }

  const groups: ConversationGroup[] = [];
  for (const [sessionId, { title, items }] of groupMap) {
    items.sort((a, b) => b.timestamp - a.timestamp);
    groups.push({
      sessionId,
      title,
      items,
      mostRecentTimestamp: items[0]?.timestamp ?? 0,
    });
  }

  groups.sort((a, b) => b.mostRecentTimestamp - a.mostRecentTimestamp);
  return groups;
}

export const NotificationDrawer = memo(function NotificationDrawer({
  onClose,
  onSendMessageToSession,
  onAddReceiptToSession,
  busySessionIds,
  scrollToSessionId,
  onScrollComplete,
  mcpNotifications = [],
  onDismissMcpNotification,
  onViewMcpConnector,
  onMakeMcpChanges,
}: NotificationDrawerProps) {
  const {
    approvals,
    isLoading: approvalsLoading,
    dismissApproval,
    saveApproval,
    approveToolApproval,
    executeStagedApproval,
    batchApproveToolApprovals,
  } = usePendingApprovals({
    onSendContinuation: onSendMessageToSession
      ? (sessionId, message, receiptText) => {
          void onSendMessageToSession(sessionId, message, receiptText);
        }
      : undefined,
  });
  const {
    files: stagedFiles,
    publish: publishStagedFile,
    discard: discardStagedFile,
    keepPrivate: keepStagedFilePrivate,
  } = useStagedFiles();
  const {
    notifications: skillNotifications,
    dismissNotification: dismissSkillNotification,
    isLoading: skillNotificationsLoading,
  } = useSkillChangeNotifications({ enabled: true });
  const questionWaitingItems = usePendingQuestionWaitingItems();
  const navigation = useAppNavigationSafe();
  const { showToast } = useToast();
  const sessionSummaries = useSessionStore((state) => state.sessionSummaries);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());
  const {
    redirectOutcomeById,
    setRedirectEntry,
    clearRedirectEntry,
    beginSingleFlight,
    endSingleFlight,
  } = useApprovalRedirectShadow();
  const [previewApproval, setPreviewApproval] =
    useState<PendingApprovalItem | null>(null);
  const [previewFile, setPreviewFile] = useState<StagedFileItem | null>(null);
  const [previewActionItem, setPreviewActionItem] = useState<PendingApprovalItem | StagedFileItem | null>(null);
  const [previewActionInputOptions, setPreviewActionInputOptions] = useState<ToActionPreviewInputOptions | undefined>(undefined);
  const [pendingDialogIntent, setPendingDialogIntent] = useState<{
    itemId: string;
    intent: 'allow-and-remember' | 'deny-and-remember' | 'change-request';
  } | null>(null);
  const [previewActionState, setPreviewActionState] = useState<ActionPreviewState>('ready');
  const [previewActionStateMessage, setPreviewActionStateMessage] = useState<string | undefined>(undefined);
  const [previewConflictData, setPreviewConflictData] = useState<{
    realContent: string;
    stagedContent: string;
  } | null>(null);
  const previewActionInput = useMemo(
    () => (previewActionItem ? toActionPreviewInput(previewActionItem, previewActionInputOptions) : null),
    [previewActionInputOptions, previewActionItem],
  );
  const previewActionEffectKind = useMemo(
    () => (previewActionInput ? classifyEffectKind(previewActionInput) : null),
    [previewActionInput],
  );
  const readMemoryApprovalContent = useCallback(async (
    identity: MemoryApprovalContentIdentity,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const toolUseId = identity.toolUseId.trim();
    if (!toolUseId) return null;
    if (signal.aborted) return null;

    const selectedMemoryApproval = previewActionItem
      && !isStagedFileSourceItem(previewActionItem)
      && previewActionItem.type === 'memory'
      ? previewActionItem.memoryApproval
      : undefined;
    const originalSessionId = identity.originalSessionId?.trim() || selectedMemoryApproval?.originalSessionId || '';
    const approvalIdentifier = identity.approvalIdentifier?.trim() || selectedMemoryApproval?.approvalIdentifier || '';
    const secondKey = originalSessionId
      ? { kind: 'originalSessionId' as const, value: originalSessionId }
      : approvalIdentifier
        ? { kind: 'approvalIdentifier' as const, value: approvalIdentifier }
        : null;
    if (!secondKey) return null;

    const allApprovals = await window.memoryApi.getPendingApprovals({});
    if (signal.aborted) return null;

    const matches = allApprovals.filter((approval) => {
      if (approval.toolUseId !== toolUseId) return false;
      if (secondKey.kind === 'originalSessionId') {
        return approval.originalSessionId === secondKey.value;
      }
      if (secondKey.kind === 'approvalIdentifier') {
        return approval.approvalIdentifier === secondKey.value;
      }
      return false;
    });

    return matches.length === 1 ? (matches[0].content ?? null) : null;
  }, [previewActionItem]);
  const {
    model: resolvedPreviewActionModel,
    content: previewActionContent,
  } = useActionPreview(previewActionInput ?? DEFAULT_ACTION_PREVIEW_INPUT, {
    readStagedContent: async (id) => window.api.getStagedContent(id),
    readWorkspaceFile: async (path) => window.api.readWorkspaceFile(path),
    readMemoryApprovalContent,
  });
  const previewActionRevealedContent = useMemo(
    () => (
      previewActionContent.status === 'revealed' || previewActionContent.status === 'empty'
        ? previewActionContent.staged
        : undefined
    ),
    [previewActionContent.staged, previewActionContent.status],
  );
  const previewActionModel = useMemo(() => {
    if (previewActionInput) return resolvedPreviewActionModel;
    return deriveActionPreview(DEFAULT_ACTION_PREVIEW_INPUT);
  }, [previewActionInput, resolvedPreviewActionModel]);
  const previewActionToolName = useMemo(() => {
    if (!previewActionItem || isStagedFileSourceItem(previewActionItem)) return undefined;
    if (previewActionItem.type === 'tool') return previewActionItem.toolApproval?.toolName;
    if (previewActionItem.type === 'staged-tool') return previewActionItem.stagedToolCall?.mcpPayload.toolId;
    return undefined;
  }, [previewActionItem]);
  const previewActionReason = useMemo(() => {
    if (!previewActionItem || isStagedFileSourceItem(previewActionItem)) return undefined;
    if (previewActionItem.type === 'tool') return previewActionItem.toolApproval?.reason;
    if (previewActionItem.type === 'staged-tool') return previewActionItem.stagedToolCall?.reason;
    if (previewActionItem.type === 'memory') return previewActionItem.memoryApproval?.sensitivityReason;
    return undefined;
  }, [previewActionItem]);
  const previewActionErrorMessage = useMemo(() => {
    if (previewActionState === 'error' && previewActionStateMessage) return previewActionStateMessage;
    if (previewActionContent.error?.detail) {
      return `Could not load preview details: ${previewActionContent.error.detail}`;
    }
    return previewActionStateMessage;
  }, [previewActionContent.error?.detail, previewActionState, previewActionStateMessage]);
  const previewActionDialogState = useMemo<ActionPreviewState>(() => {
    if (previewActionState === 'no-longer-waiting') return 'no-longer-waiting';
    if (previewActionState === 'error') return 'error';
    if (
      previewActionItem
      && previewActionContent.conflict
      && (
        isStagedFileSourceItem(previewActionItem)
        || previewActionItem.type === 'memory'
      )
    ) {
      return 'loading';
    }
    const isFileBacked = isFileBackedEffectKind(previewActionEffectKind);
    if (
      isFileBacked
      && (
        previewActionContent.status === 'not-loaded'
        || previewActionContent.status === 'loading'
        || previewActionContent.loading
      )
    ) {
      return 'loading';
    }
    if (previewActionContent.error || previewActionContent.status === 'error') return 'error';
    return 'ready';
  }, [
    previewActionContent.conflict,
    previewActionContent.error,
    previewActionContent.loading,
    previewActionContent.status,
    previewActionEffectKind,
    previewActionItem,
    previewActionState,
  ]);
  const previewActionDecisionState = useMemo(
    () => getApprovalDecisionState(previewActionItem),
    [previewActionItem],
  );
  const previewActionDecisionReady = previewActionDialogState === 'ready';
  const previewActionUnifiedItem = useMemo<UnifiedItem | null>(() => {
    if (!previewActionItem) return null;
    if (isStagedFileSourceItem(previewActionItem)) {
      return {
        kind: 'staged-file',
        id: getUnifiedItemId(previewActionItem),
        timestamp: previewActionItem.stagedAt,
        sessionId: previewActionItem.sessionId ?? null,
        groupTitle: previewActionItem.sessionTitle ?? 'Staged file',
        file: previewActionItem,
      };
    }

    return {
      kind: 'approval',
      id: getUnifiedItemId(previewActionItem),
      timestamp: previewActionItem.timestamp,
      sessionId: previewActionItem.sessionId ?? null,
      groupTitle: previewActionItem.conversationTitle ?? previewActionItem.title,
      approval: previewActionItem,
    };
  }, [previewActionItem]);
  const previewActionCanChangeRequest = useMemo(() => (
    previewActionUnifiedItem
      ? canRedirectItem({
        item: previewActionUnifiedItem,
        hasSendMessageHandler: Boolean(onSendMessageToSession),
        sessionSummaries,
      })
      : false
  ), [onSendMessageToSession, previewActionUnifiedItem, sessionSummaries]);
  const previewActionAllowLabel = useMemo(() => {
    if (!previewActionItem) return 'Allow';
    if (isStagedFileSourceItem(previewActionItem)) return 'Save';
    if (previewActionDecisionState.isEvalError) return 'Do it once';
    if (previewActionDecisionState.isSafetyBlock) return 'Allow once';
    const sessionKind = previewActionItem.sessionId
      ? classifySessionKind(previewActionItem.sessionId)
      : null;
    if (sessionKind === 'automation' || sessionKind === 'automation-insight') {
      return 'Allow this run only';
    }
    return 'Allow';
  }, [previewActionDecisionState.isEvalError, previewActionDecisionState.isSafetyBlock, previewActionItem]);
  const previewActionDiscardLabel = previewActionDecisionState.isSafetyBlock
    ? 'Don’t allow'
    : 'Discard';
  const previewMemoryModel = useMemo(() => {
    if (!previewApproval || previewApproval.type !== 'memory') return null;
    const input = toActionPreviewInput(previewApproval);
    return input ? deriveActionPreview(input) : null;
  }, [previewApproval]);
  const previewStagedFileModel = useMemo(() => {
    if (!previewFile) return null;
    const input = toActionPreviewInput(previewFile);
    return input ? deriveActionPreview(input) : null;
  }, [previewFile]);
  const isBatchProcessingRef = useRef(false);
  const isMountedRef = useRef(true);

  const liveGroups = useMemo(
    () => buildGroups(
      approvals,
      stagedFiles,
      questionWaitingItems,
      skillNotifications,
      mcpNotifications,
      sessionSummaries,
    ),
    [
      approvals,
      stagedFiles,
      questionWaitingItems,
      skillNotifications,
      mcpNotifications,
      sessionSummaries,
    ],
  );
  const liveItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of liveGroups) {
      for (const item of group.items) {
        ids.add(item.id);
      }
    }
    return ids;
  }, [liveGroups]);

  useEffect(() => {
    if (!pendingDialogIntent) return;
    if (liveItemIds.has(pendingDialogIntent.itemId)) return;
    setPendingDialogIntent(null);
  }, [liveItemIds, pendingDialogIntent]);

  const groups = useMemo(
    () => mergeGroupsWithRedirectShadows(liveGroups, redirectOutcomeById),
    [liveGroups, redirectOutcomeById],
  );

  const liveTitleById = useMemo(() => {
    const titles = new Map<string, string>();
    for (const summary of sessionSummaries) {
      if (summary.title) {
        titles.set(summary.id, summary.title);
      }
    }
    return titles;
  }, [sessionSummaries]);

  const totalCount = useMemo(
    () => groups.reduce((count, group) => count + group.items.length, 0),
    [groups],
  );
  const visibleActionableItems = useMemo(
    () => liveGroups.flatMap((group) => group.items.filter((item) => (
      !redirectOutcomeById.has(item.id) && isBatchActionableItem(item)
    ))),
    [liveGroups, redirectOutcomeById],
  );
  const actionableApprovalCount = useMemo(
    () => visibleActionableItems.length,
    [visibleActionableItems],
  );

  const [highlightedGroupId, setHighlightedGroupId] = useState<string | null>(
    null,
  );
  const scrollHandledRef = useRef<string | null>(null);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScrollCompleteRef = useRef(onScrollComplete);
  const previousTotalCountRef = useRef<number | null>(null);
  onScrollCompleteRef.current = onScrollComplete;

  // Auto-dismiss when showing "You're all caught up" — condition mirrors the render branch.
  // Gate on approvalsLoading to avoid closing while hydration is still in-flight
  // (the drawer is lazily mounted, so initial load may not have finished yet).
  useEffect(() => {
    const autoCloseDelay = getAllCaughtUpAutoCloseDelay({
      totalCount,
      approvalsLoading,
      skillNotificationsLoading,
      previousTotalCount: previousTotalCountRef.current,
    });
    previousTotalCountRef.current = totalCount;

    if (autoCloseDelay == null) return;

    const timer = setTimeout(onClose, autoCloseDelay);
    return () => clearTimeout(timer);
  }, [totalCount, skillNotificationsLoading, approvalsLoading, onClose]);

  useEffect(() => {
    if (groups.length === 1) {
      setExpandedGroups((prev) => {
        if (prev.has(groups[0].sessionId)) return prev;
        return new Set(prev).add(groups[0].sessionId);
      });
    }
  }, [groups]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      if (previousFocusRef.current) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
      scrollHandledRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (
      previewApproval &&
      !approvals.some((a) => a.id === previewApproval.id)
    ) {
      setPreviewApproval(null);
    }
  }, [approvals, previewApproval]);

  useEffect(() => {
    if (previewFile && !stagedFiles.some((f) => f.id === previewFile.id)) {
      setPreviewFile(null);
      setPreviewConflictData(null);
    }
  }, [previewFile, stagedFiles]);

  useEffect(() => {
    if (!previewActionItem) return;
    if (isStagedFileSourceItem(previewActionItem)) {
      if (!stagedFiles.some((file) => file.id === previewActionItem.id)) {
        setPreviewActionItem(null);
      }
      return;
    }

    if (!approvals.some((approval) => approval.id === previewActionItem.id)) {
      setPreviewActionItem(null);
    }
  }, [approvals, previewActionItem, stagedFiles]);

  useEffect(() => {
    if (!previewActionItem || previewActionState === 'no-longer-waiting') return;
    if (!previewActionContent.conflict) return;

    if (isStagedFileSourceItem(previewActionItem)) {
      setPreviewActionItem(null);
      setPreviewFile(previewActionItem);
      setPreviewConflictData(null);
      return;
    }

    if (previewActionItem.type === 'memory') {
      setPreviewActionItem(null);
      setPreviewApproval(previewActionItem);
    }
  }, [previewActionContent.conflict, previewActionItem, previewActionState]);

  useEffect(() => {
    const currentIds = new Set(approvals.map((a) => a.id));
    setApprovedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next.size !== prev.size ? next : prev;
    });
    setQueuedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next.size !== prev.size ? next : prev;
    });
  }, [approvals]);

  const toggleGroup = useCallback((sessionId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!scrollToSessionId) {
      scrollHandledRef.current = null;
      return;
    }
    if (scrollHandledRef.current === scrollToSessionId) return;

    setExpandedGroups((prev) => {
      if (prev.has(scrollToSessionId)) return prev;
      return new Set(prev).add(scrollToSessionId);
    });

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 15;

    function tryScroll() {
      if (cancelled) return;
      const el = document.querySelector(
        `[data-session-group="${scrollToSessionId}"]`,
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        setHighlightedGroupId(scrollToSessionId ?? null);
        scrollHandledRef.current = scrollToSessionId ?? null;
        onScrollCompleteRef.current?.();
        if (cleanupTimerRef.current) clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = setTimeout(
          () => setHighlightedGroupId(null),
          1500,
        );
        return;
      }
      attempts++;
      if (attempts < MAX_ATTEMPTS) {
        requestAnimationFrame(tryScroll);
      }
    }

    requestAnimationFrame(tryScroll);

    return () => {
      cancelled = true;
    };
  }, [scrollToSessionId, groups]);

  useEffect(() => {
    return () => {
      if (cleanupTimerRef.current) clearTimeout(cleanupTimerRef.current);
    };
  }, []);

  const canRedirect = useCallback((item: UnifiedItem): boolean => {
    return canRedirectItem({
      item,
      hasSendMessageHandler: Boolean(onSendMessageToSession),
      sessionSummaries: getSessionStoreState().sessionSummaries,
    });
  }, [onSendMessageToSession]);

  const handleRedirectApproval = useCallback(
    async (item: UnifiedItem, instruction: string): Promise<RedirectOutcome> => {
      if (item.kind !== 'approval' && item.kind !== 'staged-file') {
        return { ok: false, stage: 'precondition', reason: 'missing-session' };
      }

      if (!beginSingleFlight(item.id)) {
        return { ok: false, stage: 'precondition', reason: 'empty-instruction' };
      }

      try {
        const existingShadow = redirectOutcomeById.get(item.id);
        const trimmedInstruction = instruction.trim();

        if (existingShadow?.entry.status === 'error') {
          const retrySessionId = existingShadow.entry.sessionId;
          if (!onSendMessageToSession) {
            return { ok: false, stage: 'precondition', reason: 'missing-session' };
          }
          if (!trimmedInstruction) {
            return { ok: false, stage: 'precondition', reason: 'empty-instruction' };
          }

          setRedirectEntry(existingShadow.item, { status: 'sending' });

          try {
            await Promise.resolve(onSendMessageToSession(retrySessionId, trimmedInstruction));
            setRedirectEntry(
              existingShadow.item,
              { status: 'sent', sessionId: retrySessionId, at: Date.now() },
              { autoDismissMs: DEFAULT_REDIRECT_AUTO_DISMISS_MS },
            );
            return { ok: true, sessionId: retrySessionId };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            setRedirectEntry(existingShadow.item, {
              status: 'error',
              sessionId: retrySessionId,
              at: Date.now(),
              instruction: trimmedInstruction,
              error: errorMessage,
            });
            return { ok: false, stage: 'send', sessionId: retrySessionId, error: errorMessage };
          }
        }

        // CRITICAL: write redirect shadow synchronously before awaiting deny/send.
        setRedirectEntry(item, { status: 'sending' });

        const target: RedirectTarget = item.kind === 'approval'
          ? { kind: 'approval', approval: item.approval }
          : { kind: 'staged-file', stagedFile: item.file };

        const result = await redirectApprovalWithInstruction({
          target,
          instruction,
          deps: {
            denyApproval: async (approval) => {
              const ok = await dismissApproval(approval);
              return { ok, reason: ok ? undefined : 'Dismiss failed' };
            },
            denyMemoryApprovalWithoutFeedback: async (approval) => {
              const ok = await dismissApproval(approval, { sendFeedback: false });
              return { ok, reason: ok ? undefined : 'Dismiss failed' };
            },
            keepStagedFilePrivate: async (id) => {
              const response = await keepStagedFilePrivate(id);
              return { ok: response.success, reason: response.error };
            },
            sendMessageToSession: async (sessionId, message) => {
              if (!onSendMessageToSession) {
                throw new Error('sendMessageToSession unavailable');
              }
              await Promise.resolve(onSendMessageToSession(sessionId, message));
            },
          },
        });

        if (result.ok) {
          setRedirectEntry(
            item,
            { status: 'sent', sessionId: result.sessionId, at: Date.now() },
            { autoDismissMs: DEFAULT_REDIRECT_AUTO_DISMISS_MS },
          );
          return result;
        }

        if (result.stage === 'send') {
          setRedirectEntry(item, {
            status: 'error',
            sessionId: result.sessionId,
            at: Date.now(),
            instruction: trimmedInstruction,
            error: result.error,
          });
          return result;
        }

        clearRedirectEntry(item.id);
        if (result.stage === 'deny' && isMountedRef.current) {
          showToast({ title: "Couldn't deny. Try again.", variant: 'error' });
        } else if (result.stage === 'precondition') {
          console.warn('Redirect precondition failed after drawer gating', {
            itemId: item.id,
            result,
          });
        }
        return result;
      } finally {
        endSingleFlight(item.id);
      }
    },
    [
      beginSingleFlight,
      clearRedirectEntry,
      dismissApproval,
      endSingleFlight,
      keepStagedFilePrivate,
      onSendMessageToSession,
      redirectOutcomeById,
      setRedirectEntry,
      showToast,
    ],
  );

  // ── Individual action handlers ─────────────────────────────────────

  const handleApprove = useCallback(
    async (approval: PendingApprovalItem) => {
      setApprovedIds((prev) => new Set(prev).add(approval.id));

      const isTargetBusy =
        busySessionIds?.has(approval.sessionId ?? "") ?? false;
      if (isTargetBusy) {
        setQueuedIds((prev) => new Set(prev).add(approval.id));
      }

      setTimeout(async () => {
        try {
          if (approval.type === "memory") {
            await saveApproval(approval);
          } else if (approval.type === "staged-tool") {
            const result = await executeStagedApproval(approval);
            if (!result.ok) {
              setApprovedIds((prev) => {
                const next = new Set(prev);
                next.delete(approval.id);
                return next;
              });
              // Show contextual toast based on failure reason (REBEL-10T)
              if (result.reason === "already-handled") return; // silent — already resolved
              const message = approvalOutcomeMessage(result);
              if (message)
                showToast({
                  title: message,
                  description: approvalOutcomeDescription(result),
                  variant: approvalOutcomeVariant(result),
                });
              return;
            }
          } else {
            const result = await approveToolApproval(approval);
            if (!result.ok) {
              setApprovedIds((prev) => {
                const next = new Set(prev);
                next.delete(approval.id);
                return next;
              });
              const message = approvalOutcomeMessage(result);
              if (message)
                showToast({
                  title: message,
                  description: approvalOutcomeDescription(result),
                  variant: approvalOutcomeVariant(result),
                });
              return;
            }
          }
        } catch (err) {
          console.error("Failed to approve from notification drawer:", err);
          setApprovedIds((prev) => {
            const next = new Set(prev);
            next.delete(approval.id);
            return next;
          });
          showToast({
            title: "Something went wrong. Try again.",
            variant: "error",
          });
        }
      }, SUCCESS_DISPLAY_DURATION);
    },
    [
      saveApproval,
      approveToolApproval,
      executeStagedApproval,
      showToast,
      busySessionIds,
    ],
  );

  const handleDismiss = useCallback(
    async (approval: PendingApprovalItem) => {
      const success = await dismissApproval(approval);
      if (!success) {
        showToast({ title: "Failed to dismiss", variant: "error" });
      }
    },
    [dismissApproval, showToast],
  );

  const handleNavigateToSession = useCallback(
    (sessionId: string) => {
      navigation?.navigate({ type: "sessions", sessionId });
    },
    [navigation],
  );

  const openActionPreviewDialog = useCallback((
    item: PendingApprovalItem | StagedFileItem,
    options?: ToActionPreviewInputOptions,
  ) => {
    setPreviewApproval(null);
    setPreviewFile(null);
    setPreviewConflictData(null);
    setPendingDialogIntent(null);
    setPreviewActionItem(item);
    setPreviewActionInputOptions(options);
    setPreviewActionState('ready');
    setPreviewActionStateMessage(undefined);
  }, []);

  const handleOpenActionPreview = useCallback(
    async (
      item: PendingApprovalItem | StagedFileItem,
      options?: ToActionPreviewInputOptions,
    ) => {
      if (isStagedFileSourceItem(item)) {
        const input = toActionPreviewInput(item);
        if (!input || classifyEffectKind(input) !== 'data-capture') {
          setPreviewConflictData(null);
          setPreviewFile(item);
          return;
        }
        openActionPreviewDialog(item, options);
        return;
      }

      if (item.type === 'memory') {
        const input = toActionPreviewInput(item);
        if (!input || classifyEffectKind(input) !== 'data-capture') {
          setPreviewApproval(item);
          return;
        }
        openActionPreviewDialog(item, options);
        return;
      }

      if (item.type === 'staged-tool' && item.stagedToolCall && !hasStagedToolArgs(item)) {
        try {
          const stagedCalls = await window.safetyApi.stagedGetAll({});
          const hydrated = stagedCalls.find((call) => call.id === item.stagedToolCall?.id);
          if (!hydrated || hydrated.status !== 'pending') {
            setPreviewActionItem(item);
            setPreviewActionInputOptions(options);
            setPreviewActionState('no-longer-waiting');
            setPreviewActionStateMessage('This action is no longer waiting for a decision.');
            return;
          }

          openActionPreviewDialog({
            ...item,
            stagedToolCall: {
              ...item.stagedToolCall,
              displayName: hydrated.displayName ?? item.stagedToolCall.displayName,
              mcpPayload: {
                ...item.stagedToolCall.mcpPayload,
                packageId: hydrated.mcpPayload.packageId,
                toolId: hydrated.mcpPayload.toolId,
                args: hydrated.mcpPayload.args ?? {},
              },
              riskLevel: hydrated.riskLevel ?? item.stagedToolCall.riskLevel,
              reason: hydrated.reason ?? item.stagedToolCall.reason,
              allowPermanentTrust: hydrated.allowPermanentTrust ?? item.stagedToolCall.allowPermanentTrust,
              blockedBy: hydrated.blockedBy ?? item.stagedToolCall.blockedBy,
              automationName: hydrated.automationName ?? item.stagedToolCall.automationName,
            },
          }, options);
          return;
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'hydrate staged tool preview args',
            reason: 'keep review flow responsive when hydration fails',
          });
          console.error('Failed to hydrate staged tool approval before preview', {
            approvalId: item.id,
            stagedCallId: item.stagedToolCall.id,
            error,
          });
          showToast({
            title: 'Could not load the latest action details.',
            description: 'Try again in a moment.',
            variant: 'error',
          });
          setPreviewActionItem(item);
          setPreviewActionInputOptions(options);
          setPreviewActionState('error');
          setPreviewActionStateMessage('Could not load the latest action details.');
          return;
        }
      }

      openActionPreviewDialog(item, options);
    },
    [openActionPreviewDialog, showToast],
  );

  const handleNavigateToQuestion = useCallback(
    (question: QuestionWaitingItem) => {
      void Promise.resolve(
        navigation?.navigate({ type: "sessions", sessionId: question.sessionId }),
      ).then(() => {
        focusQuestionTurnAfterSessionOpen(question.sessionId, question.batch.turnId);
        onClose();
      });
    },
    [navigation, onClose],
  );

  const handleOpenStagedFilePath = useCallback(
    (filePath: string) => {
      if (!navigation) {
        showToast({
          title: "Could not open file",
          description: "Navigation is unavailable right now.",
          variant: "error",
        });
        return;
      }
      void navigation.navigate({ type: "library", filePath });
    },
    [navigation, showToast],
  );

  const addStagedFileReceipt = useCallback(
    async (file: StagedFileItem, options: StagedFileSaveReceiptOptions = {}) => {
      if (!file.sessionId || !onAddReceiptToSession) return;
      await Promise.resolve(onAddReceiptToSession(file.sessionId, buildStagedFileSaveReceipt(file, options)));
    },
    [onAddReceiptToSession],
  );

  const addBatchStagedFileReceipts = useCallback(
    async (files: StagedFileItem[]) => {
      if (!onAddReceiptToSession) return;

      const bySession = new Map<string, StagedFileItem[]>();
      for (const file of files) {
        if (!file.sessionId) continue;
        const group = bySession.get(file.sessionId) ?? [];
        group.push(file);
        bySession.set(file.sessionId, group);
      }

      for (const [sessionId, group] of bySession) {
        const receipt = group.length === 1
          ? buildStagedFileSaveReceipt(group[0])
          : buildStagedFilesBatchSaveReceipt(group);
        await Promise.resolve(onAddReceiptToSession(sessionId, receipt));
      }
    },
    [onAddReceiptToSession],
  );

  const handleDismissSkillNotification = useCallback(
    async (notification: SkillChangeNotificationItem) => {
      const dismissed = await dismissSkillNotification(notification);
      if (!dismissed) {
        showToast({
          title: "Could not dismiss notification",
          description: "Try again in a moment.",
          variant: "error",
        });
      }
      return dismissed;
    },
    [dismissSkillNotification, showToast],
  );

  const handleSaveStagedFile = useCallback(
    async (file: StagedFileItem, options: StagedFileSaveReceiptOptions = {}) => {
      const result = await publishStagedFile(file.id);
      if (result.success) {
        await addStagedFileReceipt(file, options);
        showToast({
          title: options.remembered
            ? 'Saved, and remembered for similar actions'
            : `Saved ${file.fileName}`,
          variant: 'default',
        });
        return;
      }

      if (result.hasConflict) {
        setPreviewConflictData(
          (
            result as {
              conflict?: { realContent: string; stagedContent: string };
            }
          ).conflict ?? null,
        );
        setPreviewFile(file);
        return;
      }

      showToast({
        title: appendErrorReason("Failed to save file", result.error),
        description: "The file is still waiting, so you can try again.",
        variant: "error",
      });
    },
    [addStagedFileReceipt, publishStagedFile, showToast],
  );

  const handleKeepPrivateStagedFile = useCallback(
    async (file: StagedFileItem) => {
      const result = await keepStagedFilePrivate(file.id);
      if (result.success) return;

      showToast({
        title: appendErrorReason("Failed to keep file private", result.error),
        description: "The file is still waiting, so you can try again.",
        variant: "error",
      });
    },
    [keepStagedFilePrivate, showToast],
  );

  // ── Batch action handlers ──────────────────────────────────────────

  const hasSafetyBlocks = useCallback((items: PendingApprovalItem[]) => {
    return items.some(
      (a) =>
        a.toolApproval?.blockedBy === "safety_prompt" ||
        a.stagedToolCall?.blockedBy === "safety_prompt" ||
        a.memoryApproval?.blockedBy === "safety_prompt",
    );
  }, []);

  const handleApproveAllGlobal = useCallback(() => {
    if (isBatchProcessingRef.current) return;
    isBatchProcessingRef.current = true;

    const toApprove = visibleActionableItems
      .filter((item): item is Extract<UnifiedItem, { kind: 'approval' }> =>
        item.kind === 'approval' &&
        !approvedIds.has(item.approval.id) &&
        !isEvalErrorApproval(item.approval),
      )
      .map((item) => item.approval);
    const filesToPublish = visibleActionableItems
      .filter((item): item is Extract<UnifiedItem, { kind: 'staged-file' }> =>
        item.kind === 'staged-file' &&
        !isEvalErrorStagedFile(item.file),
      )
      .map((item) => item.file);
    const hadSafetyBlocks = hasSafetyBlocks(toApprove);

    setApprovedIds((prev) => {
      const next = new Set(prev);
      for (const a of toApprove) next.add(a.id);
      return next;
    });

    for (const a of toApprove) {
      if (busySessionIds?.has(a.sessionId ?? "")) {
        setQueuedIds((prev) => new Set(prev).add(a.id));
      }
    }

    setTimeout(async () => {
      try {
        const batchResult = await batchApproveToolApprovals(toApprove);
        let fileConflicts = 0;
        const publishedFiles: StagedFileItem[] = [];
        for (const file of filesToPublish) {
          const result = await publishStagedFile(file.id);
          if (result.success) {
            publishedFiles.push(file);
          } else {
            fileConflicts++;
          }
        }
        await addBatchStagedFileReceipts(publishedFiles);
        if (fileConflicts > 0) {
          showToast({
            title: `${fileConflicts} file(s) need review`,
            variant: "warning",
          });
        } else if (hadSafetyBlocks) {
          showToast({
            title:
              "All approved — update rules in Settings to prevent future blocks",
            variant: "default",
            duration: 6000,
          });
        }
        if (batchResult.failed > 0) {
          const msg = formatBatchApprovalFailureMessage(
            batchResult.failed,
            batchResult.failures,
          );
          showToast({ title: msg, variant: "error" });
        }
        // Stage 3 review F2: the actions ran, but their result summaries
        // could not be delivered (e.g. busy conversation refused the
        // continuation) — surface it instead of silently dropping the text.
        if (batchResult.resultDeliveryFailures?.length) {
          showToast({
            title:
              "Executed, but the conversation was busy — ask Rebel for the results.",
            variant: "warning",
          });
        }
      } catch (err) {
        ignoreBestEffortCleanup(err, {
          operation: 'batch approve drawer items',
          reason: 'avoid crashing batch flow after partial approvals',
        });
        console.error("Batch approve failed:", err);
      }
      isBatchProcessingRef.current = false;
    }, SUCCESS_DISPLAY_DURATION);
  }, [
    approvedIds,
    addBatchStagedFileReceipts,
    batchApproveToolApprovals,
    busySessionIds,
    publishStagedFile,
    showToast,
    hasSafetyBlocks,
    visibleActionableItems,
  ]);

  const handleDismissAllGlobal = useCallback(() => {
    if (isBatchProcessingRef.current) return;
    isBatchProcessingRef.current = true;

    for (const item of visibleActionableItems) {
      if (item.kind === 'approval') {
        if (!approvedIds.has(item.approval.id) && !isEvalErrorApproval(item.approval)) {
          void handleDismiss(item.approval);
        }
      } else if (item.kind === 'staged-file' && !isEvalErrorStagedFile(item.file)) {
        void handleKeepPrivateStagedFile(item.file);
      }
    }

    setTimeout(() => {
      isBatchProcessingRef.current = false;
    }, 0);
  }, [
    approvedIds,
    handleDismiss,
    handleKeepPrivateStagedFile,
    visibleActionableItems,
  ]);

  const closeActionPreviewDialog = useCallback(() => {
    setPreviewActionItem(null);
    setPreviewActionInputOptions(undefined);
    setPreviewActionState('ready');
    setPreviewActionStateMessage(undefined);
  }, []);

  const handleOpenSafetyRules = useCallback(() => {
    closeActionPreviewDialog();
    void navigation?.navigate({ type: 'settings', tab: 'safety', section: 'safetyRules' });
  }, [closeActionPreviewDialog, navigation]);

  const handleActionPreviewAllow = useCallback(() => {
    if (!previewActionItem || !previewActionDecisionReady) return;
    if (isStagedFileSourceItem(previewActionItem)) {
      void handleSaveStagedFile(previewActionItem);
    } else {
      void handleApprove(previewActionItem);
    }
    closeActionPreviewDialog();
  }, [closeActionPreviewDialog, handleApprove, handleSaveStagedFile, previewActionDecisionReady, previewActionItem]);

  const handleActionPreviewAllowAndRemember = useCallback(() => {
    if (!previewActionItem || !previewActionDecisionReady) return;
    if (!previewActionDecisionState.isSafetyBlock || previewActionDecisionState.isEvalError) return;
    setPendingDialogIntent({
      itemId: getUnifiedItemId(previewActionItem),
      intent: 'allow-and-remember',
    });
    closeActionPreviewDialog();
  }, [
    closeActionPreviewDialog,
    previewActionDecisionReady,
    previewActionDecisionState.isEvalError,
    previewActionDecisionState.isSafetyBlock,
    previewActionItem,
  ]);

  const handleActionPreviewDenyAndRemember = useCallback(() => {
    if (!previewActionItem || !previewActionDecisionReady) return;
    if (!previewActionDecisionState.isSafetyBlock || previewActionDecisionState.isEvalError) {
      closeActionPreviewDialog();
      return;
    }
    setPendingDialogIntent({
      itemId: getUnifiedItemId(previewActionItem),
      intent: 'deny-and-remember',
    });
    closeActionPreviewDialog();
  }, [
    closeActionPreviewDialog,
    previewActionDecisionReady,
    previewActionDecisionState.isEvalError,
    previewActionDecisionState.isSafetyBlock,
    previewActionItem,
  ]);

  const handleActionPreviewChangeRequest = useCallback(() => {
    if (!previewActionItem || !previewActionDecisionReady || !previewActionCanChangeRequest) return;
    setPendingDialogIntent({
      itemId: getUnifiedItemId(previewActionItem),
      intent: 'change-request',
    });
    closeActionPreviewDialog();
  }, [
    closeActionPreviewDialog,
    previewActionCanChangeRequest,
    previewActionDecisionReady,
    previewActionItem,
  ]);

  const handleActionPreviewDiscard = useCallback(() => {
    if (!previewActionItem || previewActionDialogState === 'no-longer-waiting') return;
    if (previewActionDecisionState.isSafetyBlock && !previewActionDecisionState.isEvalError) {
      handleActionPreviewDenyAndRemember();
      return;
    }
    if (isStagedFileSourceItem(previewActionItem)) {
      void handleKeepPrivateStagedFile(previewActionItem);
    } else {
      void handleDismiss(previewActionItem);
    }
    closeActionPreviewDialog();
  }, [
    closeActionPreviewDialog,
    handleActionPreviewDenyAndRemember,
    handleDismiss,
    handleKeepPrivateStagedFile,
    previewActionDecisionState.isEvalError,
    previewActionDecisionState.isSafetyBlock,
    previewActionDialogState,
    previewActionItem,
  ]);

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div
      className="notification-drawer"
      role="dialog"
      aria-label="Notifications"
      data-testid="notification-drawer"
    >
      <header className="notification-drawer__header">
        <div className="notification-drawer__header-left">
          <div className="notification-drawer__header-title-row">
            <h3 className="notification-drawer__title">
              Notifications{totalCount > 0 ? ` (${totalCount})` : ''}
            </h3>
          </div>
        </div>
        <div className="notification-drawer__header-right">
          {actionableApprovalCount >= 2 && (
            <div className="notification-drawer__batch-global">
              <Button
                type="button"
                variant="outline"
                size="xxs"
                onClick={handleDismissAllGlobal}
                data-testid="drawer-deny-all"
              >
                <X aria-hidden />
                Deny all
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="xxs"
                onClick={handleApproveAllGlobal}
                data-testid="drawer-allow-all"
              >
                <Check aria-hidden />
                Allow all
              </Button>
            </div>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="notification-drawer__close"
            onClick={onClose}
            aria-label="Close notifications"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>

      {totalCount === 0 && (skillNotificationsLoading || approvalsLoading) ? (
        <div className="notification-drawer__empty" aria-busy="true">
          <p className="notification-drawer__empty-description">
            Loading notifications…
          </p>
        </div>
      ) : totalCount === 0 ? (
        <div className="notification-drawer__empty">
          <div className="notification-drawer__empty-icon">
            <Bell size={28} aria-hidden />
          </div>
          <h4 className="notification-drawer__empty-title">
            You&apos;re all caught up
          </h4>
          <p className="notification-drawer__empty-description">
            When Rebel needs your OK or a shared skill changes, it&apos;ll
            appear here.
          </p>
        </div>
      ) : (
        <div className="notification-drawer__body scrollbar-thin">
          {groups.map((group) => {
            const isExpanded = expandedGroups.has(group.sessionId);
            const displayTitle = resolveGroupDisplayTitle(group, liveTitleById);
            return (
              <div
                key={group.sessionId}
                className={`notification-drawer__group${highlightedGroupId === group.sessionId ? " notification-drawer__group--highlighted" : ""}`}
                data-session-group={group.sessionId}
              >
                <div
                  className="notification-drawer__group-header"
                  onClick={(event) => {
                    if (shouldIgnoreGroupHeaderToggle(event.target)) return;
                    toggleGroup(group.sessionId);
                  }}
                >
                  <div className="notification-drawer__group-header-left">
                    <button
                      type="button"
                      className="notification-drawer__group-toggle"
                      data-testid="notification-drawer-group-toggle"
                      onClick={() => toggleGroup(group.sessionId)}
                      aria-expanded={isExpanded}
                      aria-controls={`notification-group-${group.sessionId}`}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${displayTitle}`}
                    >
                      {isExpanded ? (
                        <ChevronDown
                          size={14}
                          className="notification-drawer__group-chevron"
                          aria-hidden
                        />
                      ) : (
                        <ChevronRight
                          size={14}
                          className="notification-drawer__group-chevron"
                          aria-hidden
                        />
                      )}
                    </button>
                    <Tooltip content={displayTitle} placement="bottom" delayShow={300}>
                      <button
                        type="button"
                        className="notification-drawer__group-title notification-drawer__group-title--toggle"
                        onClick={() => toggleGroup(group.sessionId)}
                        aria-expanded={isExpanded}
                        aria-controls={`notification-group-${group.sessionId}`}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${displayTitle}`}
                      >
                        {displayTitle}
                      </button>
                    </Tooltip>
                  </div>
                  <div className="notification-drawer__group-meta">
                    {!isPseudoSessionId(group.sessionId) && (
                      <button
                        type="button"
                        className="notification-drawer__group-convo-link"
                        onClick={() => handleNavigateToSession(group.sessionId)}
                        aria-label={`Open conversation: ${displayTitle}`}
                      >
                        <ExternalLink size={11} aria-hidden />
                        Convo
                      </button>
                    )}
                    <span className="notification-drawer__group-count">
                      {group.items.length}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div
                    className="notification-drawer__group-items"
                    id={`notification-group-${group.sessionId}`}
                    role="region"
                    aria-label={displayTitle}
                  >
                    {group.items.map((item) => {
                      if (item.kind === 'question-waiting') {
                        return (
                          <DrawerQuestionWaitingCard
                            key={item.id}
                            item={item.question}
                            onOpen={() => handleNavigateToQuestion(item.question)}
                          />
                        );
                      }

                      if (item.kind === "skill-notification") {
                        return (
                          <DrawerSkillNotificationCard
                            key={item.id}
                            notification={item.notification}
                            onDismiss={() => {
                              tracking.skillCollaboration.notificationDismissed(
                                {
                                  skillId: item.notification.skillWorkspacePath,
                                  recipientReason:
                                    item.notification.recipientReason,
                                },
                              );
                              void handleDismissSkillNotification(
                                item.notification,
                              );
                            }}
                            onView={() => {
                              void (async () => {
                                const opened = await navigation?.navigate({
                                  type: "library",
                                  filePath:
                                    item.notification.skillWorkspacePath,
                                });
                                if (opened) {
                                  tracking.skillCollaboration.notificationViewed(
                                    {
                                      skillId:
                                        item.notification.skillWorkspacePath,
                                      recipientReason:
                                        item.notification.recipientReason,
                                    },
                                  );
                                  await handleDismissSkillNotification(
                                    item.notification,
                                  );
                                } else {
                                  // Skill file is likely gone — try to dismiss the notification
                                  const dismissed =
                                    await handleDismissSkillNotification(
                                      item.notification,
                                    );
                                  if (dismissed) {
                                    showToast({
                                      title: "This skill has been removed",
                                      description:
                                        "The notification has been dismissed.",
                                      variant: "default",
                                    });
                                  }
                                  // If dismiss failed, handleDismissSkillNotification already shows error toast
                                }
                              })();
                            }}
                          />
                        );
                      }

                      if (item.kind === 'mcp-notification') {
                        const prUrl = item.mcpNotification.prUrl;
                        return (
                          <MCPNotificationCard
                            key={item.id}
                            state={item.mcpNotification.state}
                            connectorName={item.mcpNotification.connectorName}
                            reviewNotes={item.mcpNotification.reviewNotes}
                            prUrl={prUrl}
                            onAcknowledge={onDismissMcpNotification
                              ? () => onDismissMcpNotification(item.mcpNotification.contributionId, item.mcpNotification.contributionStatus)
                              : undefined}
                            onViewConnector={onViewMcpConnector
                              ? () => {
                                  onViewMcpConnector();
                                  onDismissMcpNotification?.(item.mcpNotification.contributionId, item.mcpNotification.contributionStatus);
                                }
                              : undefined}
                            onMakeChanges={onMakeMcpChanges
                              ? () => {
                                  onMakeMcpChanges(item.mcpNotification);
                                  onDismissMcpNotification?.(item.mcpNotification.contributionId, item.mcpNotification.contributionStatus);
                                }
                              : undefined}
                            onOpenInGitHub={prUrl
                              ? () => {
                                  void window.appApi.openUrl(prUrl);
                                }
                              : undefined}
                          />
                        );
                      }

                      const redirectShadow = redirectOutcomeById.get(item.id);
                      const clearShadow = () => {
                        clearRedirectEntry(item.id);
                      };

                      return (
                        <DrawerApprovalCard
                          key={item.id}
                          approvalId={item.id}
                          approval={
                            item.kind === "approval" ? item.approval : undefined
                          }
                          stagedFile={
                            item.kind === "staged-file" ? item.file : undefined
                          }
                          isApproved={
                            item.kind === "approval"
                              ? approvedIds.has(item.approval.id)
                              : false
                          }
                          isQueued={
                            item.kind === "approval"
                              ? queuedIds.has(item.approval.id)
                              : false
                          }
                          onApprove={
                            item.kind === "approval"
                              ? () => void handleApprove(item.approval)
                              : undefined
                          }
                          onDismiss={
                            item.kind === "approval"
                              ? () => void handleDismiss(item.approval)
                              : undefined
                          }
                          onOpenActionPreview={(sourceItem, previewOptions) => {
                            if (item.kind === 'approval') {
                              void handleOpenActionPreview(sourceItem ?? item.approval, previewOptions);
                              return;
                            }
                            void handleOpenActionPreview(sourceItem ?? item.file, previewOptions);
                          }}
                          onSave={
                            item.kind === "staged-file"
                              ? (options) => {
                                  void handleSaveStagedFile(item.file, options);
                                }
                              : undefined
                          }
                          onKeepPrivate={
                            item.kind === "staged-file"
                              ? () => {
                                  void handleKeepPrivateStagedFile(item.file);
                                }
                              : undefined
                          }
                          onRedirectWithInstruction={
                            canRedirect(item)
                              ? (instruction) => handleRedirectApproval(item, instruction)
                              : undefined
                          }
                          onDismissRedirectError={clearShadow}
                          redirectOutcome={redirectShadow?.entry}
                          pendingDialogIntent={
                            pendingDialogIntent?.itemId === item.id
                              ? pendingDialogIntent.intent
                              : undefined
                          }
                          onPendingDialogIntentHandled={() => {
                            if (pendingDialogIntent?.itemId !== item.id) return;
                            setPendingDialogIntent(null);
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalCount > 0 && (
        <footer className="notification-drawer__footer">
          <p className="notification-drawer__subtitle">
            Dismiss updates here after you&apos;ve reviewed them.
          </p>
        </footer>
      )}

      {previewActionItem && (
        <ActionPreviewDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) closeActionPreviewDialog();
          }}
          model={previewActionModel}
          toolName={previewActionToolName}
          reason={previewActionReason}
          state={previewActionDialogState}
          stateMessage={previewActionStateMessage}
          errorMessage={previewActionErrorMessage}
          revealedContent={previewActionRevealedContent}
          onRetry={() => {
            previewActionContent.refetch();
            if (
              previewActionState === 'error'
              && previewActionStateMessage
              && !previewActionContent.error
              && previewActionItem
            ) {
              void handleOpenActionPreview(previewActionItem);
            }
          }}
          onDiscard={handleActionPreviewDiscard}
          onAllow={previewActionDecisionState.isSafetyBlock && !previewActionDecisionState.isEvalError
            ? undefined
            : handleActionPreviewAllow}
          onAllowAndRemember={previewActionDecisionState.isSafetyBlock && !previewActionDecisionState.isEvalError
            ? handleActionPreviewAllowAndRemember
            : undefined}
          onChangeRequest={
            previewActionCanChangeRequest
              ? handleActionPreviewChangeRequest
              : undefined
          }
          allowDisabled={!previewActionDecisionReady}
          allowLabel={previewActionAllowLabel}
          discardLabel={previewActionDiscardLabel}
          showAllowForConversation={false}
          showAllowAndRemember={previewActionDecisionState.isSafetyBlock && !previewActionDecisionState.isEvalError}
          onOpenSafetyRules={navigation ? handleOpenSafetyRules : undefined}
        />
      )}

      {previewApproval && previewApproval.memoryApproval && (
        <MemoryPreviewDialog
          approval={previewApproval}
          blastRadius={previewMemoryModel?.blastRadius}
          riskReasons={previewMemoryModel?.riskReasons}
          onClose={() => setPreviewApproval(null)}
          onApprove={() => {
            void handleApprove(previewApproval);
            setPreviewApproval(null);
          }}
          onDiscard={() => {
            void handleDismiss(previewApproval);
            setPreviewApproval(null);
          }}
          overlayClassName="notification-drawer__preview-overlay"
          readMemoryApprovalContent={readMemoryApprovalContent}
        />
      )}

      <StagedFilePreviewDialog
        file={previewFile}
        blastRadius={previewStagedFileModel?.blastRadius}
        riskReasons={previewStagedFileModel?.riskReasons}
        onClose={() => {
          setPreviewFile(null);
          setPreviewConflictData(null);
        }}
        onOpenFilePath={handleOpenStagedFilePath}
        onPublish={publishStagedFile}
        onDiscard={discardStagedFile}
        onKeepPrivate={keepStagedFilePrivate}
        onSaved={async (file, options) => {
          await addStagedFileReceipt(file, options);
          showToast({
            title: options?.remembered
              ? 'Saved, and remembered for similar actions'
              : `Saved ${file.fileName}`,
            variant: 'default',
          });
        }}
        onSendMessageToSession={
          onSendMessageToSession
            ? async (sessionId, message) => {
                await onSendMessageToSession(sessionId, message);
              }
            : undefined
        }
        onNavigateToSession={handleNavigateToSession}
        initialConflictData={previewConflictData}
        overlayClassName="notification-drawer__preview-overlay"
      />
    </div>
  );
});
