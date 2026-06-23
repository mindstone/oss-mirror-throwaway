/**
 * DrawerApprovalCard
 *
 * Compact approval card for use inside NotificationDrawer accordion groups.
 * Handles all 4 approval types: tool, memory, staged-tool, staged-file.
 * Includes the full principle-options flow for safety blocks.
 *
 * This is a stripped-down version of StickyNotification (no stacking animation,
 * no drag handle, no focus/unfocus states) designed for list display.
 */

// Invariant #4: DrawerApprovalCard and DrawerSkillNotificationCard MUST remain
// separate components. They share primitives (FileLocationBadge) but have
// different lifecycles. See docs/plans/260419_file_location_centralisation.md
// §Invariants #4.

import { memo, useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect, type KeyboardEvent } from 'react';
import {
  Zap, Brain, FileText, Eye, Check, Clock, Plus,
  Loader2, RefreshCw, AlertCircle, AlertTriangle, ShieldCheck, ShieldQuestion,
  MessageSquare, Mail, Terminal, Globe,
  type LucideIcon,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button, Textarea, FileLocationBadge, Tooltip } from '@renderer/components/ui';
import { SharingBadge, type RiskLevel } from '@renderer/components/approval/primitives';
import { getFriendlyToolName, isGenericReason, legacyMissingLocation } from '@rebel/shared';
import { getMemoryWhyText } from '@renderer/features/automations/utils/getMemoryWhyText';
import { buildMemoryBlockedAction, usePrincipleOptions, type ApprovalTransport, type PrincipleOptionsResult } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { useDesktopApprovalTransport } from '@renderer/transport/useDesktopApprovalTransport';
import { getFileName } from '@renderer/utils/stringUtils';
import { SCOPE_LABELS, DENY_SCOPE_LABELS } from '@renderer/components/approval/scopeLabels';
import { classifySessionKind } from '@shared/sessionKind';
import { extractSourceMetadataFromFileName, humanizeFileName } from '../utils/extractSourceMetadata';
import { humanizeApprovalText } from '../utils/humanizeApprovalText';
import type { PendingApprovalItem } from '../hooks/usePendingApprovals';
import type { StagedFileItem } from '../hooks/useStagedFiles';
import type { RedirectOutcome } from '../utils/redirectApproval';
import { BrowserToolApprovalDetails } from './BrowserToolApprovalDetails';
import { BROWSER_FILL_FORM_TOOL, BROWSER_CLICK_TOOL } from '@rebel/shared';
import { tracking } from '@renderer/src/tracking';
import {
  recordFirstSeen as tallyRecordFirstSeen,
  markViewedConversation as tallyMarkViewedConversation,
  markPreviewed as tallyMarkPreviewed,
  getSecondsSinceFirstSeen as tallyGetSecondsSinceFirstSeen,
} from '../hooks/useApprovalInteractionTally';
import { computeApprovalFacets, narrowSharing } from '../utils/approvalFacetAnalysis';
import { getStagedFileWhyText } from '../utils/approvalWhyText';
import type { ToActionPreviewInputOptions } from '../utils/toActionPreviewInput';
import './DrawerApprovalCard.css';

const SAFETY_PROMPT_BLOCKED_PREFIX = 'Safety Rules blocked:';

function extractBlockReason(reason: string): string {
  return reason.replace(SAFETY_PROMPT_BLOCKED_PREFIX, '').trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

type SlackResolvedUser = {
  id: string;
  displayName?: string;
  realName?: string;
  email?: string;
};

type SlackApprovalRecipient = {
  userId: string;
  packageId?: string;
  label: string;
  status: 'pending' | 'resolved' | 'unresolved';
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSlackUserId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const mention = trimmed.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  const candidate = mention?.[1] ?? trimmed;
  return /^[UW][A-Z0-9]+$/i.test(candidate) ? candidate.toUpperCase() : null;
}

function humanizeToolName(name: string): string {
  const friendly = getFriendlyToolName(name);
  if (friendly) return friendly;
  return name
    .replace(/[_-]/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, c => c.toUpperCase());
}

interface DrawerRiskIndicatorConfig {
  icon: LucideIcon;
  label: string;
  tooltip: string;
}

function getDrawerRiskIndicatorConfig(riskLevel: RiskLevel): DrawerRiskIndicatorConfig {
  switch (riskLevel) {
    case 'low':
      return {
        icon: ShieldCheck,
        label: 'Low risk',
        tooltip: 'Rebel expects this approval to be low impact.',
      };
    case 'medium':
      return {
        icon: AlertCircle,
        label: 'Medium risk',
        tooltip: 'Worth a quick check before allowing. Rebel thinks this action has some impact.',
      };
    case 'high':
      return {
        icon: AlertTriangle,
        label: 'Higher-risk approval',
        tooltip: 'Rebel is asking because this action could affect files, accounts, or shared work.',
      };
    case 'needs-review':
      return {
        icon: AlertCircle,
        label: 'Needs review',
        tooltip: 'Rebel needs you to review this before it continues.',
      };
    case 'unknown':
      return {
        icon: ShieldQuestion,
        label: 'Risk not rated',
        tooltip: 'Rebel does not have a risk rating for this approval.',
      };
  }
}

function getInputPath(input: Record<string, unknown> | undefined): string | undefined {
  const candidate = input?.file_path ?? input?.path ?? input?.filePath;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate
    : undefined;
}

function buildPausedToolActionText(
  approval: PendingApprovalItem | undefined,
  actionLabel: string | null,
): string {
  const toolName = approval?.toolApproval?.toolName
    ?? approval?.stagedToolCall?.mcpPayload.toolId
    ?? '';
  const input = approval?.toolApproval?.input
    ?? approval?.stagedToolCall?.mcpPayload.args;
  const lowerToolName = toolName.toLowerCase();
  const displayToolName = actionLabel ?? humanizeToolName(toolName).toLowerCase();
  const filePath = getInputPath(input);
  const fileName = filePath ? getFileName(filePath) : undefined;

  if (lowerToolName.includes('bash')) {
    return 'running a command';
  }

  if (fileName && lowerToolName.includes('edit')) {
    return `editing ${fileName}`;
  }

  if (fileName && lowerToolName.includes('write')) {
    return `writing ${fileName}`;
  }

  if (approval?.stagedToolCall?.displayName) {
    return `running ${stripMarkdown(approval.stagedToolCall.displayName)}`;
  }

  return `running ${displayToolName || 'this action'}`;
}

function buildPausedActionText(params: {
  isMemory: boolean;
  isStagedFile: boolean;
  approval?: PendingApprovalItem;
  stagedFile?: StagedFileItem;
  actionLabel: string | null;
}): string {
  const { isMemory, isStagedFile, approval, stagedFile, actionLabel } = params;

  if (isStagedFile && stagedFile) {
    const displayName = humanizeFileName(stagedFile.fileName || 'a file');
    const verb = stagedFile.baseHash === 'new-file' ? 'creating' : 'updating';
    const destination = stagedFile.spaceName ? ` in ${stagedFile.spaceName}` : '';
    return `Rebel paused before ${verb} ${displayName}${destination}`;
  }

  if (isMemory && approval?.memoryApproval) {
    const fileName = getFileName(approval.memoryApproval.filePath || '');
    const displayName = fileName ? humanizeFileName(fileName) : 'a memory';
    const spaceName = approval.memoryApproval.spaceName || 'a Space';
    return `Rebel paused before saving ${displayName} to ${spaceName}`;
  }

  return `Rebel paused before ${buildPausedToolActionText(approval, actionLabel)}`;
}

function buildToolSafetyHeadline(
  approval: PendingApprovalItem | undefined,
  actionLabel: string | null,
  slackRecipient: SlackApprovalRecipient | null,
): string {
  const reason = approval?.toolApproval?.reason ?? approval?.stagedToolCall?.reason ?? '';
  const toolName = approval?.stagedToolCall?.mcpPayload.toolId ?? approval?.toolApproval?.toolName ?? '';
  const effectiveToolId = approval?.stagedToolCall?.mcpPayload.toolId
    ?? approval?.toolApproval?.effectiveToolId
    ?? '';
  const toolInput = approval?.stagedToolCall?.mcpPayload.args ?? approval?.toolApproval?.input;
  const displayName = approval?.stagedToolCall?.displayName
    ? stripMarkdown(approval.stagedToolCall.displayName)
    : null;
  const searchable = `${reason} ${toolName} ${effectiveToolId} ${displayName ?? ''}`.toLowerCase();
  const args = asRecord(toolInput);
  const channel = args?.channel ?? args?.channel_id ?? args?.channelId;
  const isSlackDmAction =
    searchable.includes('slack direct message') ||
    searchable.includes('slack dm') ||
    searchable.includes('open_slack_dm') ||
    (typeof channel === 'string' && /^D[A-Z0-9]/i.test(channel));

  if (isSlackDmAction) {
    const recipientDisplayLabel = getSlackRecipientDisplayLabel(slackRecipient);
    const recipientSuffix = recipientDisplayLabel
      ? ` ${recipientDisplayLabel}`
      : '';
    if (
      searchable.includes('open_slack_dm') ||
      searchable.includes('post_slack_message') ||
      searchable.includes('send_message') ||
      (typeof channel === 'string' && /^D[A-Z0-9]/i.test(channel))
    ) {
      return `Approve sending Slack message${recipientSuffix ? ` to${recipientSuffix}` : ''}`;
    }
    return 'Approve this Slack message';
  }

  if (searchable.includes('slack') && searchable.includes('message')) {
    return 'Approve this Slack message';
  }

  if (displayName) {
    return `Approve: ${displayName}`;
  }

  if (actionLabel) {
    return `Approve ${actionLabel}`;
  }

  return 'Approve this action';
}

interface ToolActionMetadata {
  toolName: string;
  toolId: string;
  packageId: string;
  displayName: string;
  args: Record<string, unknown>;
  searchable: string;
}

interface ApprovalActionDetails {
  icon: LucideIcon;
  actionKind: 'file' | 'memory' | 'message' | 'email' | 'tool';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringifyPreviewValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map(item => stringifyPreviewValue(item))
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(', ') : undefined;
  }
  const record = asRecord(value);
  if (record) {
    const named = getStringField(record, ['name', 'label', 'email', 'address', 'value']);
    if (named) return named;
  }
  return undefined;
}

function getStringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringifyPreviewValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

function extractToolActionMetadata(approval: PendingApprovalItem | undefined): ToolActionMetadata | null {
  if (!approval || approval.type === 'memory') return null;

  const toolApprovalInput = approval.toolApproval?.input ?? {};
  const nestedToolArgs = asRecord(toolApprovalInput.args);
  const stagedArgs = approval.stagedToolCall?.mcpPayload.args;
  const args = stagedArgs ?? nestedToolArgs ?? toolApprovalInput;
  const toolName = approval.toolApproval?.toolName ?? '';
  const toolId = approval.stagedToolCall?.mcpPayload.toolId
    ?? getStringField(toolApprovalInput, ['tool_id', 'toolId'])
    ?? approval.toolApproval?.effectiveToolId
    ?? toolName;
  const packageId = approval.stagedToolCall?.mcpPayload.packageId
    ?? getStringField(toolApprovalInput, ['package_id', 'packageId'])
    ?? approval.packageName
    ?? '';
  const displayName = approval.stagedToolCall?.displayName ?? approval.description ?? '';
  const searchable = [
    toolName,
    toolId,
    packageId,
    approval.packageName,
    approval.toolApproval?.effectiveToolId,
    displayName,
  ].filter(Boolean).join(' ').toLowerCase();

  return {
    toolName,
    toolId,
    packageId,
    displayName,
    args,
    searchable,
  };
}

function getSlackApprovalRecipientRequest(
  approval: PendingApprovalItem | undefined,
): { userId: string; packageId?: string } | null {
  const metadata = extractToolActionMetadata(approval);
  if (!metadata?.searchable.includes('slack')) return null;

  const candidate = normalizeSlackUserId(metadata.args.user)
    ?? normalizeSlackUserId(metadata.args.user_id)
    ?? normalizeSlackUserId(metadata.args.userId)
    ?? normalizeSlackUserId(metadata.args.intended_recipient)
    ?? normalizeSlackUserId(metadata.args.intendedRecipient)
    ?? normalizeSlackUserId(metadata.args.recipient_user_id)
    ?? normalizeSlackUserId(metadata.args.recipientUserId);

  return candidate
    ? { userId: candidate, packageId: metadata.packageId || undefined }
    : null;
}

function pickSlackResolvedUserLabel(user: SlackResolvedUser | undefined, fallbackUserId: string): string {
  return user?.displayName?.trim()
    || user?.realName?.trim()
    || user?.email?.trim()
    || fallbackUserId;
}

function getSlackRecipientDisplayLabel(recipient: SlackApprovalRecipient | null): string | null {
  return recipient?.status === 'resolved' ? recipient.label : null;
}

function useSlackApprovalRecipient(
  approval: PendingApprovalItem | undefined,
): SlackApprovalRecipient | null {
  const request = useMemo(() => getSlackApprovalRecipientRequest(approval), [approval]);
  const [resolution, setResolution] = useState<{
    status: 'pending' | 'resolved' | 'unresolved';
    user?: SlackResolvedUser;
  }>({ status: 'pending' });

  useEffect(() => {
    setResolution({ status: 'pending' });
    if (!request) return;

    let cancelled = false;
    const slackApi = (window as typeof window & {
      slackApi?: {
        resolveUser?: (payload: { userId: string; packageId?: string }) => Promise<{
          success: boolean;
          user?: SlackResolvedUser;
        }>;
      };
    }).slackApi;

    if (!slackApi?.resolveUser) {
      setResolution({ status: 'unresolved' });
      return;
    }

    void slackApi.resolveUser({
      userId: request.userId,
      packageId: request.packageId,
    }).then((result) => {
      if (cancelled) return;
      setResolution(result.success && result.user
        ? { status: 'resolved', user: result.user }
        : { status: 'unresolved' });
    }).catch(() => {
      if (!cancelled) setResolution({ status: 'unresolved' });
    });

    return () => {
      cancelled = true;
    };
  }, [request]);

  if (!request) return null;

  return {
    ...request,
    label: pickSlackResolvedUserLabel(resolution.user, request.userId),
    status: resolution.status,
  };
}

function replaceSlackUserIdWithLabel(text: string, recipient: SlackApprovalRecipient | null): string {
  if (!recipient) return text;

  const replacement = getSlackRecipientDisplayLabel(recipient) ?? 'the Slack recipient';
  const idPattern = escapeRegExp(recipient.userId);

  return text
    .replace(new RegExp(`\\buser\\s+${idPattern}\\b`, 'gi'), replacement)
    .replace(new RegExp(idPattern, 'g'), replacement);
}

function normalizeSlackApprovalOptionLabel(text: string, recipient: SlackApprovalRecipient | null): string {
  return replaceSlackUserIdWithLabel(text, recipient)
    .replace(/\bopening a direct message with\b/gi, 'sending a Slack message to')
    .replace(/\bopen a direct message with\b/gi, 'send a Slack message to')
    .replace(/\bopening direct messages with\b/gi, 'sending Slack messages to')
    .replace(/\bopen direct messages with\b/gi, 'send Slack messages to');
}

function normalizeSlackPrincipleOptionsResult(
  result: PrincipleOptionsResult,
  recipient: SlackApprovalRecipient | null,
): PrincipleOptionsResult {
  return {
    ...result,
    options: result.options.map((option) => ({
      ...option,
      label: normalizeSlackApprovalOptionLabel(option.label, recipient),
    })),
  };
}

function isSlackDirectMessageApproval(approval: PendingApprovalItem | undefined): boolean {
  const metadata = extractToolActionMetadata(approval);
  if (!metadata) return false;

  const channel = metadata.args.channel ?? metadata.args.channel_id ?? metadata.args.channelId;
  return metadata.searchable.includes('slack direct message') ||
    metadata.searchable.includes('slack dm') ||
    metadata.searchable.includes('open_slack_dm') ||
    (typeof channel === 'string' && /^D[A-Z0-9]/i.test(channel));
}

function buildSlackMessageApprovalDescription(recipient: SlackApprovalRecipient | null): string {
  const recipientLabel = getSlackRecipientDisplayLabel(recipient) ?? 'this Slack user';
  return `Rebel wants to send a Slack message to ${recipientLabel}. Please confirm before it contacts them.`;
}

function enrichSlackToolInputForCopy(
  toolInput: Record<string, unknown>,
  recipient: SlackApprovalRecipient | null,
): Record<string, unknown> {
  if (!recipient) return toolInput;
  const recipientLabel = getSlackRecipientDisplayLabel(recipient) ?? 'the Slack recipient';
  const copy = { ...toolInput };
  for (const key of ['user', 'user_id', 'userId', 'intended_recipient', 'intendedRecipient', 'recipient_user_id', 'recipientUserId']) {
    if (normalizeSlackUserId(copy[key]) === recipient.userId) {
      copy[key] = recipientLabel;
    }
  }

  return {
    ...copy,
    recipient_display_name: recipientLabel,
    user_display_name: recipientLabel,
  };
}

function isGenericSlackDirectMessageReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes('slack direct messages require approval') ||
    normalized.includes('safety rules explicitly allow slack dms');
}

function getCommunicationKind(metadata: ToolActionMetadata): 'message' | 'email' | undefined {
  const searchable = metadata.searchable;
  if (/(^|\b)(email|gmail|mail)(\b|_)/.test(searchable) || /send_(workspace_)?email/.test(searchable)) {
    return 'email';
  }
  if (
    /(^|\b)(slack|chat|dm|teams|discord|twist)(\b|_)/.test(searchable)
    || /(^|\b)(send|post)[\s_-].*message/.test(searchable)
  ) {
    return 'message';
  }
  return undefined;
}

function getApprovalActionDetails(params: {
  isMemory: boolean;
  isStagedFile: boolean;
  approval?: PendingApprovalItem;
}): ApprovalActionDetails {
  const { isMemory, isStagedFile, approval } = params;
  if (isStagedFile) return { icon: FileText, actionKind: 'file' };
  if (isMemory) return { icon: Brain, actionKind: 'memory' };

  const metadata = extractToolActionMetadata(approval);
  if (!metadata) return { icon: Zap, actionKind: 'tool' };

  const communicationKind = getCommunicationKind(metadata);
  if (communicationKind === 'email') return { icon: Mail, actionKind: 'email' };
  if (communicationKind === 'message') return { icon: MessageSquare, actionKind: 'message' };
  if (metadata.searchable.includes('bash') || metadata.searchable.includes('shell') || metadata.searchable.includes('command')) {
    return { icon: Terminal, actionKind: 'tool' };
  }
  if (metadata.searchable.includes('browser') || metadata.searchable.includes('web') || metadata.searchable.includes('navigate')) {
    return { icon: Globe, actionKind: 'tool' };
  }
  return { icon: Zap, actionKind: 'tool' };
}



export function buildStagedFileActionText(
  stagedFile: Pick<StagedFileItem, 'baseHash' | 'fileName' | 'spaceName'>,
): string {
  // Humanise source-capture files (filename pattern yyMMdd_HHmm_source-type_description.md).
  // Falls through to raw-filename messaging when the filename does not match.
  // TODO(stage-4-ui): wire contextLine from humanized result into the staged-file meta block
  const sourceMeta = extractSourceMetadataFromFileName(stagedFile.fileName);
  const humanized = humanizeApprovalText(sourceMeta, stagedFile.spaceName);
  if (humanized) return humanized.actionText;

  const rawFileName = stagedFile.fileName || 'a file';
  const displayName = humanizeFileName(rawFileName);
  const verb = stagedFile.baseHash === 'new-file' ? 'create' : 'update';
  if (!stagedFile.spaceName) {
    return `Rebel wants to ${verb} ${displayName}`;
  }
  return `Rebel wants to ${verb} ${displayName} in ${stagedFile.spaceName}`;
}

function buildStagedFileHeadline(stagedFile: Pick<StagedFileItem, 'baseHash'>): string {
  return stagedFile.baseHash === 'new-file'
    ? 'Rebel wants to create a file'
    : 'Rebel wants to update a file';
}

function buildStagedFileDecisionMessage(
  stagedFile: Pick<StagedFileItem, 'baseHash' | 'fileName' | 'spaceName'>,
  whyText?: string,
): string {
  const verb = stagedFile.baseHash === 'new-file' ? 'create' : 'update';
  const fileName = stagedFile.fileName ? humanizeFileName(stagedFile.fileName) : 'a file';
  const destination = stagedFile.spaceName ? ` in ${stagedFile.spaceName}` : '';
  const base = `This will ${verb} ${fileName}${destination}.`;
  return whyText ? `${base} ${whyText}` : base;
}

function cleanStagedSummary(summary: string | undefined): string {
  if (!summary) return '';
  return stripMarkdown(summary)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^-+$/.test(line))
    .join('\n')
    .trim();
}

// Stage 4 cleanup: the Outside-workspace-parent-folder enrichment branch was
// removed here — FileLocation.outsideCategory + describeFileLocation() now
// produce the correct label for outside-workspace paths, and the card renders
// that via <FileLocationBadge>. The action text stays about the action; the
// badge handles the location. See docs/plans/260419_file_location_centralisation.md §Stage 4.
export function buildMemoryApprovalActionText(
  memoryApproval: { filePath?: string; spaceName?: string },
): string {
  const fileName = getFileName(memoryApproval.filePath || '');
  const spaceName = memoryApproval.spaceName || 'a space';

  // Humanise source-capture files after Outside-workspace enrichment so destination
  // context is preserved. Falls through to raw-filename messaging when not a source capture.
  // TODO(stage-4-ui): wire contextLine from humanized result into the memory approval card
  const sourceMeta = extractSourceMetadataFromFileName(fileName);
  const humanized = humanizeApprovalText(sourceMeta, spaceName);
  if (humanized) return humanized.actionText;

  const displayName = humanizeFileName(fileName);
  return displayName
    ? `Rebel wants to save ${displayName} to ${spaceName}`
    : `Rebel wants to save to ${spaceName}`;
}

export interface DrawerApprovalCardProps {
  approval?: PendingApprovalItem;
  stagedFile?: StagedFileItem;
  /**
   * Stable composite id used to dedupe the `Approval Card Viewed` analytics
   * event across drawer-group collapse/expand cycles and evaluator re-eval.
   * Should be the unified `item.id` from the pending-approvals data source
   * (e.g. `tool:<toolUseID>`, `memory:<toolUseId>`, `staged-tool:<callId>`,
   * `staged-file:<toolUseId>`). When omitted, analytics firing is skipped —
   * test fixtures and legacy callers should not break.
   */
  approvalId?: string;
  isApproved?: boolean;
  isQueued?: boolean;
  onApprove?: () => void;
  onDismiss?: () => void;
  onNavigate?: () => void;
  onPreview?: () => void;
  onOpenActionPreview?: (
    item: PendingApprovalItem | StagedFileItem,
    options?: ToActionPreviewInputOptions,
  ) => void;
  onSave?: (options?: { remembered?: boolean }) => void;
  onKeepPrivate?: () => void;
  onRedirectWithInstruction?: (instruction: string) => Promise<RedirectOutcome>;
  onNavigateToConversation?: () => void;
  onDismissRedirectError?: () => void;
  redirectOutcome?: DrawerRedirectEntry;
  pendingDialogIntent?: 'allow-and-remember' | 'deny-and-remember' | 'change-request';
  onPendingDialogIntentHandled?: () => void;
}

export type DrawerRedirectEntry =
  | { status: 'sending' }
  | { status: 'sent'; sessionId: string; at: number }
  | { status: 'error'; sessionId: string; at: number; instruction: string; error: string };

export const DrawerApprovalCard = memo(function DrawerApprovalCard({
  approval,
  stagedFile,
  approvalId,
  isApproved = false,
  isQueued = false,
  onApprove,
  onDismiss,
  onNavigate,
  onPreview,
  onOpenActionPreview,
  onSave,
  onKeepPrivate,
  onRedirectWithInstruction,
  onDismissRedirectError,
  redirectOutcome,
  pendingDialogIntent,
  onPendingDialogIntentHandled,
}: DrawerApprovalCardProps) {
  const isStagedFile = Boolean(stagedFile);
  const rememberOnApproveRef = useRef(false);
  const isMemory = !isStagedFile && approval?.type === 'memory';
  const actionDetails = useMemo(
    () => getApprovalActionDetails({ isMemory, isStagedFile, approval }),
    [isMemory, isStagedFile, approval],
  );
  const Icon = actionDetails.icon;
  const actionKind = actionDetails.actionKind;

  const timeAgo = formatDistanceToNow(
    isStagedFile ? (stagedFile?.stagedAt ?? Date.now()) : (approval?.timestamp ?? Date.now()),
    { addSuffix: true },
  );

  const approvalSessionKind =
    !isStagedFile && !isMemory && approval?.sessionId
      ? classifySessionKind(approval.sessionId)
      : null;
  const isAutomation = approvalSessionKind === 'automation' || approvalSessionKind === 'automation-insight';

  const stagedFileLocation = useMemo(() => {
    if (!stagedFile) {
      return null;
    }
    return stagedFile.location ?? legacyMissingLocation({
      fileName: stagedFile.fileName,
      spaceName: stagedFile.spaceName,
      legacyPath: stagedFile.spacePath || stagedFile.realPath,
    });
  }, [stagedFile]);

  // Memory-approval surface parity with staged-file branch and mobile
  // (mobile/src/components/ApprovalCards.tsx + MemoryApprovalSheet.tsx). The
  // badge renders inside the approval body, carrying location context so the
  // action text stays focused on the action itself (per Invariant #4).
  const memoryApprovalLocation = useMemo(() => {
    if (!isMemory || !approval?.memoryApproval) {
      return null;
    }
    const memory = approval.memoryApproval;
    return memory.location ?? legacyMissingLocation({
      fileName: memory.filePath ? getFileName(memory.filePath) : undefined,
      spaceName: memory.spaceName,
      legacyPath: memory.spacePath || memory.filePath,
    });
  }, [isMemory, approval]);

  const memorySharing = narrowSharing(approval?.memoryApproval?.sharing) ?? 'unclear';
  const stagedFileSharing = narrowSharing(stagedFile?.sharing) ?? 'unclear';

  const displayRiskLevel = useMemo<RiskLevel | null>(() => {
    if (isStagedFile) {
      switch (stagedFile?.blockedBy) {
        case 'safety_prompt':
          return 'high';
        case 'sensitivity_eval':
        case 'eval_error':
          return 'needs-review';
        default:
          return stagedFile?.approvalKind === 'shared_skill_checkpoint' ? 'medium' : null;
      }
    }

    if (isMemory) {
      switch (approval?.memoryApproval?.blockedBy) {
        case 'safety_prompt':
          return 'high';
        case 'sensitivity_eval':
        case 'eval_error':
          return 'needs-review';
        default:
          return null;
      }
    }

    const riskLevel = approval?.riskLevel;
    if (typeof riskLevel === 'string') {
      switch (riskLevel) {
        case 'low':
        case 'medium':
        case 'high':
          return riskLevel;
        default:
          return null;
      }
    }

    return null;
  }, [isMemory, isStagedFile, stagedFile?.blockedBy, stagedFile?.approvalKind, approval?.memoryApproval?.blockedBy, approval?.riskLevel]);
  const riskIndicatorConfig = useMemo(
    () => displayRiskLevel ? getDrawerRiskIndicatorConfig(displayRiskLevel) : null,
    [displayRiskLevel],
  );
  const RiskIndicatorIcon = riskIndicatorConfig?.icon;

  // Derive safety block status from data
  const isSafetyBlock = useMemo(() => {
    if (isStagedFile && stagedFile) return stagedFile.blockedBy === 'safety_prompt' || stagedFile.blockedBy === 'eval_error';
    if (!approval) return false;
    if (approval.type === 'tool') return approval.toolApproval?.blockedBy === 'safety_prompt' || approval.toolApproval?.blockedBy === 'eval_error';
    if (approval.type === 'staged-tool') return approval.stagedToolCall?.blockedBy === 'safety_prompt' || approval.stagedToolCall?.blockedBy === 'eval_error';
    if (approval.type === 'memory') return approval.memoryApproval?.blockedBy === 'safety_prompt' || approval.memoryApproval?.blockedBy === 'eval_error';
    return false;
  }, [isStagedFile, stagedFile, approval]);

  // Whether this approval is due to the safety evaluator being unavailable (not a principled block).
  // eval_error approvals should not offer "Save a rule" / permanent trust options.
  const isEvalError = useMemo(() => {
    if (isStagedFile && stagedFile) return stagedFile.blockedBy === 'eval_error';
    if (!approval) return false;
    if (approval.type === 'tool') return approval.toolApproval?.blockedBy === 'eval_error';
    if (approval.type === 'staged-tool') return approval.stagedToolCall?.blockedBy === 'eval_error';
    if (approval.type === 'memory') return approval.memoryApproval?.blockedBy === 'eval_error';
    return false;
  }, [isStagedFile, stagedFile, approval]);


  // ── Action handlers ──────────────────────────────────────────────
  const handleApproveAction = useCallback(() => {
    const remembered = rememberOnApproveRef.current;
    rememberOnApproveRef.current = false;
    if (isStagedFile) { onSave?.({ remembered }); return; }
    onApprove?.();
  }, [isStagedFile, onSave, onApprove]);

  const handleDismissAction = useCallback(() => {
    if (isStagedFile) { onKeepPrivate?.(); return; }
    onDismiss?.();
  }, [isStagedFile, onKeepPrivate, onDismiss]);

  // ── Description ──────────────────────────────────────────────────
  const actionLabel = useMemo(() => {
    if (isMemory || isStagedFile) return null;
    const toolName = approval?.toolApproval?.toolName
      ?? approval?.stagedToolCall?.mcpPayload.toolId;
    if (!toolName) return null;
    return humanizeToolName(toolName).toLowerCase();
  }, [isMemory, isStagedFile, approval]);
  const slackRecipient = useSlackApprovalRecipient(!isStagedFile && !isMemory ? approval : undefined);
  const resolvedRecipientLabel = getSlackRecipientDisplayLabel(slackRecipient) ?? undefined;

  const description = useMemo(() => {
    if (isEvalError) {
      return 'Decide whether to continue';
    }
    if (isStagedFile && stagedFile) {
      return buildStagedFileActionText(stagedFile);
    }
    if (isMemory && approval?.memoryApproval) {
      return buildMemoryApprovalActionText(approval.memoryApproval);
    }
    const safetyReason = approval?.toolApproval?.reason ?? approval?.stagedToolCall?.reason;
    const strippedReason = safetyReason?.startsWith(SAFETY_PROMPT_BLOCKED_PREFIX)
      ? safetyReason.slice(SAFETY_PROMPT_BLOCKED_PREFIX.length).trim()
      : null;
    if (isSlackDirectMessageApproval(approval)) {
      return buildSlackMessageApprovalDescription(slackRecipient);
    }
    if (
      strippedReason &&
      approval?.description &&
      slackRecipient &&
      isGenericSlackDirectMessageReason(strippedReason)
    ) {
      return replaceSlackUserIdWithLabel(stripMarkdown(approval.description), slackRecipient);
    }
    if (strippedReason && !isGenericReason(strippedReason)) {
      return replaceSlackUserIdWithLabel(stripMarkdown(strippedReason), slackRecipient);
    }
    if (approval?.description) {
      return replaceSlackUserIdWithLabel(stripMarkdown(approval.description), slackRecipient);
    }
    if (actionLabel) return replaceSlackUserIdWithLabel(`Rebel would like to ${actionLabel}`, slackRecipient);
    return 'Needs your OK to continue';
  }, [actionLabel, approval, isEvalError, isMemory, isStagedFile, slackRecipient, stagedFile]);

  // ── Safety reason (eval_error gets paused-action copy) ────────────
  const safetyReasonText = useMemo(() => {
    if (isEvalError) {
      const pausedAction = buildPausedActionText({
        isMemory,
        isStagedFile,
        approval,
        stagedFile,
        actionLabel,
      });
      return `${pausedAction}. The safety check did not finish, so nothing has run. It won't keep trying in the background because that could run later without you noticing.`;
    }
    if (isStagedFile && stagedFile?.blockedBy === 'safety_prompt') return null;
    if (!isStagedFile && !isMemory && isSafetyBlock) return null; // tool blocks already show reason in description
    return null;
  }, [actionLabel, approval, isEvalError, isMemory, isStagedFile, isSafetyBlock, stagedFile]);

  // ── Why text (collapsible explanation) ─────────────────────────────
  const whyText = useMemo(() => {
    // Skip when safetyReasonText is already showing (eval_error case)
    if (safetyReasonText) return undefined;

    if (isStagedFile && stagedFile) {
      return getStagedFileWhyText(stagedFile);
    }
    if (isMemory && approval?.memoryApproval) {
      // For safety_prompt blocks, sensitivityReason may contain the raw Safety Prompt
      // reason text rather than a credential category — getMemoryWhyText would produce
      // misleading copy ("I spotted <raw rule text>"). Show a generic safety-rule message.
      if (approval.memoryApproval.blockedBy === 'safety_prompt') {
        return 'Your safety settings flagged this save \u2014 taking a cautious approach.';
      }
      return getMemoryWhyText({
        spaceName: approval.memoryApproval.spaceName,
        sensitivityReason: approval.memoryApproval.sensitivityReason,
        sharing: approval.memoryApproval.sharing,
        privateMode: approval.memoryApproval.privateMode,
        hasSpaceOverride: approval.memoryApproval.hasSpaceOverride,
        approvalKind: approval.memoryApproval.approvalKind,
        authorLabel: approval.memoryApproval.authorLabel,
        location: approval.memoryApproval.location,
      });
    }
    // Tool and staged-tool: the description already shows the non-generic reason,
    // so a separate WHY toggle would duplicate it. Skip.
    return undefined;
  }, [safetyReasonText, isStagedFile, stagedFile, isMemory, approval]);

  // ── Analytics: approval-card instrumentation (Phase 1 plan) ──────
  // All facts used in cardViewed/whyExpanded/viewConversationClicked are
  // derived here once so the effect dep array is stable. Keep this block
  // below whyText so `reasonLength` reflects the actual collapsed text.
  const approvalType: 'tool' | 'memory' | 'staged-tool' | 'staged-file' =
    isStagedFile ? 'staged-file' : (approval?.type ?? 'tool');
  const analyticsBlockedBy = isStagedFile
    ? stagedFile?.blockedBy
    : isMemory
      ? approval?.memoryApproval?.blockedBy
      : undefined;
  const analyticsRiskLevel = !isStagedFile && !isMemory
    ? approval?.riskLevel
    : undefined;
  const analyticsSharing = narrowSharing(
    isStagedFile
      ? stagedFile?.sharing
      : isMemory
        ? approval?.memoryApproval?.sharing
        : undefined,
  );
  // Facet analysis must reflect what the user *actually sees* on the card so
  // `thinFacets` (R17 promotion-gate) agrees with UX reality. That means
  // preferring `safetyReasonText` (eval_error memory copy, always visible)
  // over `whyText` (behind a toggle). If neither is present, reasonLength
  // falls through to 0 and the card is correctly classified as thin.
  const visibleExplanation = safetyReasonText ?? whyText;
  // Single source of truth for withheld-preview state. Used by the
  // analyticsFacets memo below AND the render branches that gate the
  // withheld-copy block / preview-text block. Strict `=== undefined` matches
  // the Zod schema at src/shared/ipc/channels/memory.ts:153 which rejects
  // null — any drift between analytics and render would reopen the exact
  // data-quality bug this follow-up is closing.
  const isPreviewWithheld = isMemory
    && approval?.memoryApproval?.contentPreview === undefined
    && !!approval?.memoryApproval?.sensitivityReason;
  const analyticsFacets = useMemo(
    () => computeApprovalFacets({
      contentPreview: isMemory ? approval?.memoryApproval?.contentPreview : undefined,
      summary: isStagedFile ? stagedFile?.summary : (isMemory ? approval?.memoryApproval?.summary : undefined),
      whyText: visibleExplanation,
      isPreviewWithheld,
      hasStructuredFacets: false, // Phase 2 (R4) will wire this
    }),
    [isMemory, isPreviewWithheld, isStagedFile, approval, stagedFile, visibleExplanation],
  );

  const headlineText = isStagedFile && stagedFile && !isEvalError
    ? buildStagedFileHeadline(stagedFile)
    : !isStagedFile && !isMemory && isSafetyBlock && !isEvalError
      ? buildToolSafetyHeadline(approval, actionLabel, slackRecipient)
      : description;
  const stagedDecisionMessage = isStagedFile && stagedFile
    ? buildStagedFileDecisionMessage(stagedFile, whyText)
    : undefined;
  const toolDecisionMessage = !isStagedFile && !isMemory && isSafetyBlock && !isEvalError
    ? description
    : undefined;

  // Fire `Approval Card Viewed` once per approvalId. Module-level tally
  // survives drawer-group collapse/expand (card unmounts) and evaluator
  // re-eval (new instance, same id) so we don't double-count.
  useEffect(() => {
    if (!approvalId) return;
    if (!tallyRecordFirstSeen(approvalId)) return;
    tracking.approvals.cardViewed({
      approvalType,
      blockedBy: analyticsBlockedBy,
      riskLevel: analyticsRiskLevel,
      sharing: analyticsSharing,
      hasContentPreview: analyticsFacets.hasContentPreview,
      hasWithheldPreview: analyticsFacets.hasWithheldPreview,
      hasWhyFacets: analyticsFacets.hasWhyFacets,
      thinFacets: analyticsFacets.thinFacets,
    });
  }, [
    approvalId,
    approvalType,
    analyticsBlockedBy,
    analyticsRiskLevel,
    analyticsSharing,
    analyticsFacets.hasContentPreview,
    analyticsFacets.hasWithheldPreview,
    analyticsFacets.hasWhyFacets,
    analyticsFacets.thinFacets,
  ]);

  // ── Navigation / Preview ─────────────────────────────────────────
  // Wrap onNavigate/onPreview to fire analytics before invoking the
  // underlying callback. For staged-file approvals the "navigate" button
  // opens a preview dialog — route that to `previewContentClicked` rather than
  // `viewConversationClicked` so the semantics match the user intent.
  const handleNavigateClick = useCallback(() => {
    if (onOpenActionPreview) {
      const sourceItem = stagedFile ?? approval;
      if (!sourceItem) return;
      if (approvalId) tallyMarkPreviewed(approvalId);
      tracking.approvals.previewContentClicked({
        approvalType,
        previewSource: 'dialog',
      });
      onOpenActionPreview(sourceItem, { resolvedRecipientLabel });
      return;
    }
    if (onNavigate) {
      if (isStagedFile) {
        if (approvalId) tallyMarkPreviewed(approvalId);
        tracking.approvals.previewContentClicked({
          approvalType,
          previewSource: 'dialog',
        });
      } else {
        if (approvalId) tallyMarkViewedConversation(approvalId);
        tracking.approvals.viewConversationClicked({
          approvalType,
          blockedBy: analyticsBlockedBy,
          riskLevel: analyticsRiskLevel,
          sharing: analyticsSharing,
          hasContentPreview: analyticsFacets.hasContentPreview,
          hasWithheldPreview: analyticsFacets.hasWithheldPreview,
          thinFacets: analyticsFacets.thinFacets,
          secondsSinceCardViewed: approvalId
            ? tallyGetSecondsSinceFirstSeen(approvalId)
            : undefined,
        });
      }
    }
    onNavigate?.();
  }, [
    onNavigate,
    onOpenActionPreview,
    approval,
    stagedFile,
    isStagedFile,
    approvalId,
    approvalType,
    analyticsBlockedBy,
    analyticsRiskLevel,
    analyticsSharing,
    analyticsFacets.hasContentPreview,
    analyticsFacets.hasWithheldPreview,
    analyticsFacets.thinFacets,
    resolvedRecipientLabel,
  ]);

  const handlePreviewClick = useCallback(() => {
    if (onOpenActionPreview) {
      const sourceItem = stagedFile ?? approval;
      if (!sourceItem) return;
      if (approvalId) tallyMarkPreviewed(approvalId);
      tracking.approvals.previewContentClicked({
        approvalType,
        previewSource: 'dialog',
      });
      onOpenActionPreview(sourceItem, { resolvedRecipientLabel });
      return;
    }
    if (onPreview) {
      if (approvalId) tallyMarkPreviewed(approvalId);
      tracking.approvals.previewContentClicked({
        approvalType,
        previewSource: 'dialog',
      });
    }
    onPreview?.();
  }, [
    approval,
    approvalId,
    approvalType,
    onOpenActionPreview,
    onPreview,
    resolvedRecipientLabel,
    stagedFile,
  ]);

  // ── Button labels ────────────────────────────────────────────────

  const successLabel = isMemory || isStagedFile ? 'Saved' : 'Approved';
  const dismissLabel = 'Cancel this';
  const approveLabel = isEvalError ? 'Do it once' : 'Allow';
  const approveTooltip = isEvalError
    ? (isMemory || isStagedFile
      ? 'Save this once without the unfinished safety check'
      : 'Do this once without the unfinished safety check')
    : (!isSafetyBlock
      ? (isAutomation ? 'This automation will ask again next time it runs' : 'Allow just this once')
      : '');
  const approveButtonVariant = 'secondary';
  const approveButtonClass = 'drawer-card__action-button drawer-card__btn-main-action';
  const dismissButtonClass = 'drawer-card__action-button drawer-card__btn-tertiary';

  // ── Text expand/collapse (shared for description and staged-file summary) ──
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [isDescTruncated, setIsDescTruncated] = useState(false);
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
  const [isPreviewTruncated, setIsPreviewTruncated] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLParagraphElement>(null);

  // Tracks whether this component is still mounted, so async handlers can
  // skip component-local setState calls after the card is removed from the
  // tree (module-scoped redirect state is already safe; this only gates
  // local UI state like `redirectMode` and `instructionDraft`).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const stagedSummaryText = useMemo(
    () => cleanStagedSummary(stagedFile?.summary),
    [stagedFile?.summary],
  );
  const stagedExplanationText = useMemo(
    () => [stagedDecisionMessage, stagedSummaryText]
      .filter((part): part is string => Boolean(part))
      .join(' '),
    [stagedDecisionMessage, stagedSummaryText],
  );
  const stagedFileHoverPath = stagedFile?.realPath || stagedFile?.fileName || '';
  const displayedText = isStagedFile ? stagedExplanationText : description;
  const memoryPreview = approval?.memoryApproval?.contentPreview;
  const previewText = useMemo(() => {
    if (!isMemory || !memoryPreview) return '';
    const strippedPreview = stripMarkdown(memoryPreview);
    return strippedPreview.length > 200
      ? `${strippedPreview.slice(0, 200)}…`
      : strippedPreview;
  }, [isMemory, memoryPreview]);

  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el || isDescExpanded) return;
    const clampedHeight = el.clientHeight;
    if (clampedHeight === 0) return;
    // With -webkit-line-clamp, Chromium may report scrollHeight === clientHeight
    // even when content is visually truncated. Temporarily remove the clamp to
    // measure the true content height (runs before paint — no visual flash).
    el.style.display = 'block';
    el.style.overflow = 'visible';
    el.style.webkitLineClamp = 'unset';
    const fullHeight = el.scrollHeight;
    el.style.display = '';
    el.style.overflow = '';
    el.style.webkitLineClamp = '';
    setIsDescTruncated(fullHeight > clampedHeight + 1);
  }, [displayedText, isDescExpanded]);

  useEffect(() => {
    setIsPreviewExpanded(false);
  }, [previewText, isPreviewWithheld]);

  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) {
      setIsPreviewTruncated(false);
      return;
    }
    if (isPreviewExpanded) return;
    const clampedHeight = el.clientHeight;
    if (clampedHeight === 0) return;
    el.style.display = 'block';
    el.style.overflow = 'visible';
    el.style.webkitLineClamp = 'unset';
    const fullHeight = el.scrollHeight;
    el.style.display = '';
    el.style.overflow = '';
    el.style.webkitLineClamp = '';
    setIsPreviewTruncated(fullHeight > clampedHeight + 1);
  }, [previewText, isPreviewExpanded]);

  const toggleDescExpand = useCallback(() => {
    if (isDescTruncated || isDescExpanded || (isStagedFile && stagedExplanationText)) {
      setIsDescExpanded(prev => !prev);
    }
  }, [isDescTruncated, isDescExpanded, isStagedFile, stagedExplanationText]);

  const togglePreviewExpand = useCallback(() => {
    setIsPreviewExpanded(prev => !prev);
  }, []);

  // ── Principle options (safety blocks) ────────────────────────────
  const [showOptions, setShowOptions] = useState(false);

  const blockedAction = useMemo(() => {
    if (!isSafetyBlock) return null;
    if (isStagedFile && stagedFile) {
      return buildMemoryBlockedAction({
        spaceName: stagedFile.spaceName,
        filePath: stagedFile.realPath,
        sharing: stagedFile.sharing,
        spacePath: stagedFile.spacePath,
        location: stagedFileLocation ?? undefined,
        contentSummary: stagedFile.summary,
      });
    }
    if (approval?.type === 'memory' && approval.memoryApproval) {
      return buildMemoryBlockedAction({
        spaceName: approval.memoryApproval.spaceName || '',
        filePath: approval.memoryApproval.filePath || '',
        sharing: approval.memoryApproval.sharing,
        sensitivityReason: approval.memoryApproval.sensitivityReason,
        spacePath: approval.memoryApproval.spacePath,
        location: approval.memoryApproval.location,
        contentSummary: approval.memoryApproval.contentPreview?.slice(0, 200),
      });
    }
    if (approval?.toolApproval) {
      return {
        toolName: approval.toolApproval.toolName,
        toolInput: enrichSlackToolInputForCopy(approval.toolApproval.input ?? {}, slackRecipient),
        blockReason: extractBlockReason(approval.toolApproval.reason ?? ''),
      };
    }
    if (approval?.stagedToolCall) {
      return {
        toolName: approval.stagedToolCall.mcpPayload.toolId,
        toolInput: enrichSlackToolInputForCopy(approval.stagedToolCall.mcpPayload.args ?? {}, slackRecipient),
        blockReason: extractBlockReason(approval.stagedToolCall.reason ?? ''),
      };
    }
    return null;
  }, [isSafetyBlock, isStagedFile, stagedFile, stagedFileLocation, approval, slackRecipient]);

  const effectiveToolId = useMemo(() => {
    if (isStagedFile || approval?.type === 'memory') return null;
    return approval?.toolApproval?.effectiveToolId
      ?? approval?.stagedToolCall?.mcpPayload?.toolId
      ?? null;
  }, [isStagedFile, approval]);

  const transport = useDesktopApprovalTransport();
  const shouldNormalizeSlackOptions = !isStagedFile && !isMemory && isSlackDirectMessageApproval(approval);
  const approvalCopyTransport = useMemo<ApprovalTransport>(() => {
    if (!shouldNormalizeSlackOptions) return transport;

    return {
      ...transport,
      safetyPrompt: {
        ...transport.safetyPrompt,
        generateOptions: async (request) => normalizeSlackPrincipleOptionsResult(
          await transport.safetyPrompt.generateOptions(request),
          slackRecipient,
        ),
        generateDenyOptions: async (request) => normalizeSlackPrincipleOptionsResult(
          await transport.safetyPrompt.generateDenyOptions(request),
          slackRecipient,
        ),
      },
    };
  }, [shouldNormalizeSlackOptions, slackRecipient, transport]);

  const principleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId,
    packageName: approval?.packageName,
    onApprove: handleApproveAction,
    transport: approvalCopyTransport,
  });

  const denyPrincipleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId,
    packageName: approval?.packageName,
    direction: 'deny',
    onApprove: handleDismissAction,
    onDeny: handleDismissAction,
    transport: approvalCopyTransport,
  });

  const [showDenyOptions, setShowDenyOptions] = useState(false);
  const [redirectMode, setRedirectMode] = useState<'idle' | 'editing' | 'sending' | 'retrying'>('idle');
  const [instructionDraft, setInstructionDraft] = useState('');

  const handleAllowAndUpdate = useCallback(() => {
    setShowDenyOptions(false);
    setShowOptions(true);
    principleOptions.startGeneration();
  }, [principleOptions]);

  const _handleBackFromOptions = useCallback(() => {
    setShowOptions(false);
    principleOptions.goBack();
  }, [principleOptions]);

  const handleDenyAndUpdate = useCallback(() => {
    setShowOptions(false);
    setShowDenyOptions(true);
    denyPrincipleOptions.startGeneration();
  }, [denyPrincipleOptions]);

  const showRedirectEditor = redirectMode !== 'idle' && !redirectOutcome;
  const showRedirectResult = Boolean(redirectOutcome);
  const showRedirectButton = Boolean(onRedirectWithInstruction);
  const redirectButtonLabel = 'Change request';
  const actionRowClass = [
    'drawer-card__inline-row',
    showRedirectButton && 'drawer-card__inline-row--with-redirect',
    isEvalError && 'drawer-card__inline-row--eval',
  ].filter(Boolean).join(' ');
  const isRedirectBusy = redirectMode === 'sending' || redirectMode === 'retrying';
  const trimmedInstructionDraft = instructionDraft.trim();

  useEffect(() => {
    if (!pendingDialogIntent) return;
    if (pendingDialogIntent === 'allow-and-remember' && isSafetyBlock && !isEvalError) {
      handleAllowAndUpdate();
    } else if (pendingDialogIntent === 'deny-and-remember' && isSafetyBlock && !isEvalError) {
      handleDenyAndUpdate();
    } else if (pendingDialogIntent === 'change-request' && showRedirectButton) {
      setShowOptions(false);
      setShowDenyOptions(false);
      setRedirectMode('editing');
    }
    onPendingDialogIntentHandled?.();
  }, [
    handleAllowAndUpdate,
    handleDenyAndUpdate,
    isEvalError,
    isSafetyBlock,
    onPendingDialogIntentHandled,
    pendingDialogIntent,
    showRedirectButton,
  ]);

  const handleRedirectCancel = useCallback(() => {
    setRedirectMode('idle');
    setInstructionDraft('');
  }, []);

  const handleRedirectSubmit = useCallback(async () => {
    if (!onRedirectWithInstruction) return;
    if (!trimmedInstructionDraft) return;

    setRedirectMode('sending');
    try {
      const result = await onRedirectWithInstruction(trimmedInstructionDraft);
      if (!isMountedRef.current) return;
      if (!result.ok && result.stage !== 'send') {
        setRedirectMode('editing');
        return;
      }
      setRedirectMode('idle');
      setInstructionDraft('');
    } catch (error) {
      console.error('Failed to submit redirect instruction from drawer card', {
        error,
      });
      ignoreBestEffortCleanup(error, {
        operation: 'submit redirect instruction',
        reason: 'keep redirect editor interactive after send failures',
      });
      if (!isMountedRef.current) return;
      setRedirectMode('editing');
    }
  }, [onRedirectWithInstruction, trimmedInstructionDraft]);

  const handleRedirectRetry = useCallback(async () => {
    if (!onRedirectWithInstruction || redirectOutcome?.status !== 'error') return;

    const retryInstruction = redirectOutcome.instruction.trim();
    if (!retryInstruction) return;

    setRedirectMode('retrying');
    try {
      await onRedirectWithInstruction(retryInstruction);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'retry redirect instruction',
        reason: 'allow repeated retries without crashing approval cards',
      });
      console.error('Failed to retry redirect instruction from drawer card', {
        error,
      });
    } finally {
      if (isMountedRef.current) setRedirectMode('idle');
    }
  }, [onRedirectWithInstruction, redirectOutcome]);

  const handleDismissRedirectError = useCallback(() => {
    onDismissRedirectError?.();
    setRedirectMode('idle');
    setInstructionDraft('');
  }, [onDismissRedirectError]);

  const handleRedirectEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stop propagation so NotificationDrawer's document-level Escape handler
      // does NOT also close the entire drawer — Escape in the editor should
      // cancel editing only. (Escape handlers: React preventDefault does NOT
      // stop native event propagation.)
      event.stopPropagation();
      handleRedirectCancel();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleRedirectSubmit();
    }
  }, [handleRedirectCancel, handleRedirectSubmit]);

  // ── Render ───────────────────────────────────────────────────────
  const previewLabel = actionKind === 'email'
    ? 'Preview email'
    : actionKind === 'message'
      ? 'Preview message'
      : isMemory
        ? 'Preview saved note'
        : 'Preview details';
  // Preview rendered as a box matching the staged-file (SKILL.md) preview row:
  // type icon on the left, label, eye affordance on the right. Reuses the
  // drawer-card__file-row primitive so the treatment stays identical and
  // theme-consistent. Positioned above the decision message for message/email/
  // tool approvals; kept next to the inline content for memory approvals.
  const previewBox = (onPreview || onOpenActionPreview) && !isStagedFile ? (
    <div className="drawer-card__links">
      <button
        type="button"
        className="drawer-card__file-row drawer-card__file-row--preview"
        onClick={handlePreviewClick}
        data-testid="drawer-card-preview-badge"
        aria-label={previewLabel}
      >
        <Icon size={12} aria-hidden="true" />
        <span className="drawer-card__file-name">{previewLabel}</span>
        <span className="drawer-card__file-preview-affordance" aria-hidden="true">
          <Eye size={12} />
        </span>
      </button>
    </div>
  ) : null;
  const cardClass = isApproved
    ? `drawer-card ${isQueued ? 'drawer-card--queued' : 'drawer-card--approved'}`
    : 'drawer-card';

  return (
    <div
      className={cardClass}
      data-testid={isStagedFile ? 'drawer-card-staged-file' : 'drawer-card-approval'}
    >
      {/* Success / Queued state */}
      {isApproved ? (
        <div className={isQueued ? 'drawer-card__result drawer-card__result--queued' : 'drawer-card__result'}>
          {isQueued ? <Clock size={16} /> : <Check size={16} />}
          <span>{isQueued ? 'Queued' : successLabel}</span>
        </div>
      ) : (
        <>
          {/* Header: status icon + time/title stack */}
          <div className="drawer-card__headline-row">
            <div className="drawer-card__type-icon" data-action-kind={actionKind}>
              <Icon size={18} />
            </div>
            <div className="drawer-card__headline-copy">
              <span className="drawer-card__time-row">
                <span className="drawer-card__time">{timeAgo}</span>
                {displayRiskLevel && riskIndicatorConfig && RiskIndicatorIcon && (
                  <Tooltip
                    content={riskIndicatorConfig.tooltip}
                    placement="top"
                    delayShow={250}
                    maxWidth="260px"
                  >
                    <span
                      className={`drawer-card__risk-indicator drawer-card__risk-indicator--${displayRiskLevel}`}
                      aria-label={riskIndicatorConfig.label}
                      role="img"
                      tabIndex={0}
                    >
                      <RiskIndicatorIcon size={11} aria-hidden="true" />
                    </span>
                  </Tooltip>
                )}
              </span>
              <p className="drawer-card__headline-title">
                {headlineText}
              </p>
            </div>
          </div>

          <div className="drawer-card__body">
          {/* Description — staged files get enriched layout, others get text */}
          {isStagedFile && stagedFile ? (
            <div className="drawer-card__staged-meta">
              <div className="drawer-card__file-meta-row">
                <div className="drawer-card__file-meta-left">
                  <span className={stagedFile.baseHash === 'new-file' ? 'drawer-card__badge drawer-card__badge--new' : 'drawer-card__badge drawer-card__badge--modified'}>
                    {stagedFile.baseHash === 'new-file' && <Plus size={10} aria-hidden="true" />}
                    {stagedFile.baseHash === 'new-file' ? 'New file' : 'Modified'}
                    {stagedFile.spaceName && ` in ${stagedFile.spaceName}`}
                  </span>
                  {!stagedFile.spaceName && stagedFileLocation && (
                    <FileLocationBadge
                      location={stagedFileLocation}
                      compact
                      className="drawer-card__file-location"
                    />
                  )}
                  <SharingBadge sharing={stagedFileSharing} className="drawer-card__sharing-badge" />
                </div>
              </div>
              <Tooltip
                content={stagedFileHoverPath}
                placement="top"
                delayShow={250}
                maxWidth="420px"
                disabled={!stagedFileHoverPath}
              >
                <button
                  type="button"
                  className={stagedFile.baseHash === 'new-file'
                    ? 'drawer-card__file-row drawer-card__file-row--new'
                    : 'drawer-card__file-row drawer-card__file-row--modified'}
                  onClick={onNavigate || onOpenActionPreview ? handleNavigateClick : undefined}
                  disabled={!onNavigate && !onOpenActionPreview}
                  aria-label={`Preview ${stagedFile.fileName || 'file'}`}
                  data-testid="drawer-card-file-row"
                >
                  <FileText size={12} aria-hidden="true" />
                  <span className="drawer-card__file-name">
                    {stagedFile.fileName || humanizeFileName(stagedFile.realPath || 'file')}
                  </span>
                  {(onNavigate || onOpenActionPreview) && (
                    <span className="drawer-card__file-preview-affordance" aria-hidden="true">
                      <Eye size={12} />
                    </span>
                  )}
                </button>
              </Tooltip>
              {stagedExplanationText && (
                <p
                  ref={summaryRef}
                  className={[
                    'drawer-card__staged-explanation',
                    isDescExpanded && 'drawer-card__staged-explanation--expanded',
                    'drawer-card__staged-explanation--clickable',
                  ].filter(Boolean).join(' ')}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isDescExpanded}
                  aria-label={isDescExpanded ? 'Collapse file explanation' : 'Expand file explanation'}
                  onClick={toggleDescExpand}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleDescExpand();
                    }
                  }}
                >
                  {stagedExplanationText}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Preview box sits above the decision message for message/email/
                  tool approvals so the preview affordance is the first thing
                  under the headline. Memory keeps its preview next to the
                  inline content below. */}
              {!isMemory && previewBox}
              {toolDecisionMessage && (
                <p className="drawer-card__decision-message">
                  {toolDecisionMessage}
                </p>
              )}
              {/* Memory-approval branch: render FileLocationBadge alongside
                  the description for parity with mobile and the staged-file
                  branch (Invariant #4 — location context lives in the badge,
                  not the action text). */}
              {isMemory && (
                <div className="drawer-card__destination-badges">
                  {memoryApprovalLocation && (
                    <FileLocationBadge
                      location={memoryApprovalLocation}
                      compact
                      className="drawer-card__file-location"
                    />
                  )}
                  <SharingBadge sharing={memorySharing} className="drawer-card__sharing-badge" />
                </div>
              )}
              {isMemory && isPreviewWithheld && (
                <p className="drawer-card__preview-withheld">
                  Preview withheld — may contain sensitive content
                </p>
              )}
              {isMemory && !isPreviewWithheld && previewText && (
                <p
                  ref={previewRef}
                  className={[
                    'drawer-card__preview-text',
                    isPreviewExpanded && 'drawer-card__preview-text--expanded',
                  ].filter(Boolean).join(' ')}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isPreviewExpanded}
                  aria-label={isPreviewExpanded ? 'Collapse preview' : isPreviewTruncated ? 'Expand preview' : 'Toggle preview'}
                  title={!isPreviewExpanded && isPreviewTruncated ? 'Expand preview' : undefined}
                  onClick={togglePreviewExpand}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setIsPreviewExpanded((v) => !v);
                    }
                  }}
                >
                  {previewText}
                </p>
              )}
              {isMemory && previewBox}
            </>
          )}

          {/* Safety reason (eval_error friendly message) */}
          {safetyReasonText && (
            <p className="drawer-card__safety-reason">{safetyReasonText}</p>
          )}

          {/* Reason — visible by default so decision cards explain themselves. */}
          {!isStagedFile && whyText && (
            <p className="drawer-card__reason-message">{whyText}</p>
          )}

          {/* Principle options section (safety blocks only) */}
          {showOptions && isSafetyBlock && !isEvalError && (
            <div className="drawer-card__principle-section">
              {/* Loading */}
              {principleOptions.generationState === 'loading' && (
                <div className="drawer-card__principle-loading">
                  <Loader2 size={12} className="drawer-card__spinner" />
                  <span>Preparing what to remember. You can still allow once below.</span>
                </div>
              )}

              {/* Options loaded */}
              {principleOptions.generationState === 'loaded' && principleOptions.applyState !== 'applied' && (
                <div className="drawer-card__options">
                  <div className="drawer-card__options-header">
                    <span>Remember this choice for next time</span>
                  </div>
                  {principleOptions.options.map((opt, idx) => {
                    const { label: scopeLabel, icon: ScopeIcon } = SCOPE_LABELS[opt.scope];
                    const optionLabel = normalizeSlackApprovalOptionLabel(opt.label, slackRecipient);
                    return (
                      <button
                        key={opt.scope}
                        type="button"
                        className={`drawer-card__option${principleOptions.selectedOption === idx ? ' drawer-card__option--selected' : ''}`}
                        onClick={() => principleOptions.selectOption(idx)}
                      >
                        <span className="drawer-card__scope-badge"><ScopeIcon size={10} />{scopeLabel}</span>
                        {optionLabel}
                      </button>
                    );
                  })}
                  <div
                    className={`drawer-card__option${principleOptions.selectedOption === 'other' ? ' drawer-card__option--selected' : ''}`}
                    onClick={() => principleOptions.selectOption('other')}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') principleOptions.selectOption('other'); }}
                  >
                    <span className="drawer-card__scope-badge">Custom</span>
                    <input
                      type="text"
                      className="drawer-card__other-inline-input"
                      placeholder="What should Rebel remember?"
                      value={principleOptions.otherText}
                      onChange={(e) => principleOptions.setOtherText(e.target.value)}
                      onClick={(e) => { e.stopPropagation(); principleOptions.selectOption('other'); }}
                    />
                  </div>

                  {/* Trust confirmation */}
                  {principleOptions.applyState === 'confirming_trust' && (
                    <div className="drawer-card__trust-confirm">
                      <AlertCircle size={12} />
                      <span>
                        {blockedAction?.toolName === 'memory_write'
                          ? 'Saves to this space will always be allowed without safety checks. Are you sure?'
                          : 'This tool will always be allowed without safety checks. Are you sure?'}
                      </span>
                      <div className="drawer-card__trust-actions">
                        <button type="button" className="drawer-card__btn-confirm" onClick={principleOptions.confirmTrustedTool}>
                          Yes, always allow
                        </button>
                        <button type="button" className="drawer-card__btn-back" onClick={principleOptions.cancelTrustedTool}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Apply error */}
                  {principleOptions.applyState === 'error' && (
                    <div className="drawer-card__principle-error">
                      <AlertCircle size={12} />
                      <span>{principleOptions.applyError || 'Failed to apply'}</span>
                      <button type="button" className="drawer-card__retry-link" onClick={principleOptions.retryApply}>
                        <RefreshCw size={10} />
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Applying */}
                  {principleOptions.applyState === 'applying' && (
                    <div className="drawer-card__principle-loading">
                      <Loader2 size={12} className="drawer-card__spinner" />
                      <span>Applying&hellip;</span>
                    </div>
                  )}

                  {/* Confirm / Back buttons */}
                  {principleOptions.selectedOption !== null && principleOptions.applyState === 'idle' && (
                    <div className="drawer-card__option-actions">
                      <button type="button" className="drawer-card__btn-back" onClick={principleOptions.goBack}>
                        Back
                      </button>
                      <button
                        type="button"
                        className="drawer-card__btn-confirm"
                        onClick={() => {
                          rememberOnApproveRef.current = true;
                          principleOptions.confirmSelection();
                        }}
                        disabled={principleOptions.selectedOption === 'other' && !principleOptions.otherText.trim()}
                      >
                        Save &amp; allow
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Generation error */}
              {principleOptions.generationState === 'error' && (
                <div className="drawer-card__principle-error">
                  <AlertCircle size={12} />
                  <span>{principleOptions.generationError || "Couldn\u2019t generate options"}</span>
                  <button type="button" className="drawer-card__retry-link" onClick={principleOptions.retryGeneration}>
                    <RefreshCw size={10} />
                    Retry
                  </button>
                </div>
              )}

              {/* "Allow once" — always visible in expanded view */}
              <button
                type="button"
                className="drawer-card__allow-once-link"
                onClick={() => {
                  rememberOnApproveRef.current = false;
                  handleApproveAction();
                }}
              >
                {isAutomation ? 'Allow this run only' : 'Allow once'}
              </button>
            </div>
          )}

          {/* Deny Principle options section (safety blocks only) */}
          {showDenyOptions && isSafetyBlock && !isEvalError && (
            <div className="drawer-card__principle-section">
              {/* Loading */}
              {denyPrincipleOptions.generationState === 'loading' && (
                <div className="drawer-card__principle-loading">
                  <Loader2 size={12} className="drawer-card__spinner" />
                  <span>Preparing what to block. You can still block once below.</span>
                </div>
              )}

              {/* Options loaded */}
              {denyPrincipleOptions.generationState === 'loaded' && denyPrincipleOptions.applyState !== 'applied' && (
                <div className="drawer-card__options">
                  <div className="drawer-card__options-header">
                    <span>Remember this block for next time</span>
                  </div>
                  {denyPrincipleOptions.options.map((opt, idx) => {
                    const { label: scopeLabel, icon: ScopeIcon } = DENY_SCOPE_LABELS[opt.scope];
                    const optionLabel = normalizeSlackApprovalOptionLabel(opt.label, slackRecipient);
                    return (
                      <button
                        key={opt.scope}
                        type="button"
                        className={`drawer-card__option${denyPrincipleOptions.selectedOption === idx ? ' drawer-card__option--selected' : ''}`}
                        onClick={() => denyPrincipleOptions.selectOption(idx)}
                      >
                        <span className="drawer-card__scope-badge"><ScopeIcon size={10} />{scopeLabel}</span>
                        {optionLabel}
                      </button>
                    );
                  })}
                  <div
                    className={`drawer-card__option${denyPrincipleOptions.selectedOption === 'other' ? ' drawer-card__option--selected' : ''}`}
                    onClick={() => denyPrincipleOptions.selectOption('other')}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') denyPrincipleOptions.selectOption('other'); }}
                  >
                    <span className="drawer-card__scope-badge">Custom</span>
                    <input
                      type="text"
                      className="drawer-card__other-inline-input"
                      placeholder="What should Rebel block?"
                      value={denyPrincipleOptions.otherText}
                      onChange={(e) => denyPrincipleOptions.setOtherText(e.target.value)}
                      onClick={(e) => { e.stopPropagation(); denyPrincipleOptions.selectOption('other'); }}
                    />
                  </div>

                  {/* Trust confirmation — deny variant */}
                  {denyPrincipleOptions.applyState === 'confirming_trust' && (
                    <div className="drawer-card__trust-confirm">
                      <AlertCircle size={12} />
                      <span>Rebel will always block this kind of request. Are you sure?</span>
                      <div className="drawer-card__trust-actions">
                        <button type="button" className="drawer-card__btn-confirm drawer-card__btn-confirm--deny" onClick={denyPrincipleOptions.confirmTrustedTool}>
                          Yes, always block
                        </button>
                        <button type="button" className="drawer-card__btn-back" onClick={denyPrincipleOptions.cancelTrustedTool}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Apply error */}
                  {denyPrincipleOptions.applyState === 'error' && (
                    <div className="drawer-card__principle-error">
                      <AlertCircle size={12} />
                      <span>{denyPrincipleOptions.applyError || 'Failed to apply'}</span>
                      <button type="button" className="drawer-card__retry-link" onClick={denyPrincipleOptions.retryApply}>
                        <RefreshCw size={10} />
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Applying */}
                  {denyPrincipleOptions.applyState === 'applying' && (
                    <div className="drawer-card__principle-loading">
                      <Loader2 size={12} className="drawer-card__spinner" />
                      <span>Applying&hellip;</span>
                    </div>
                  )}

                  {/* Confirm / Back buttons */}
                  {denyPrincipleOptions.selectedOption !== null && denyPrincipleOptions.applyState === 'idle' && (
                    <div className="drawer-card__option-actions">
                      <button type="button" className="drawer-card__btn-back" onClick={denyPrincipleOptions.goBack}>
                        Back
                      </button>
                      <button
                        type="button"
                        className="drawer-card__btn-confirm drawer-card__btn-confirm--deny"
                        onClick={denyPrincipleOptions.confirmSelection}
                        disabled={denyPrincipleOptions.selectedOption === 'other' && !denyPrincipleOptions.otherText.trim()}
                      >
                        Save &amp; deny
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Generation error */}
              {denyPrincipleOptions.generationState === 'error' && (
                <div className="drawer-card__principle-error">
                  <AlertCircle size={12} />
                  <span>{denyPrincipleOptions.generationError || "Couldn\u2019t generate options"}</span>
                  <button type="button" className="drawer-card__retry-link" onClick={denyPrincipleOptions.retryGeneration}>
                    <RefreshCw size={10} />
                    Retry
                  </button>
                </div>
              )}

              {/* "Deny once" — always visible in expanded view */}
              <button
                type="button"
                className="drawer-card__allow-once-link"
                onClick={denyPrincipleOptions.resolveOnce}
              >
                Deny once
              </button>
            </div>
          )}

          {/* Browser tool — per-field details / destructive-label highlight.
              Uses the same safety heuristics as the server-side safety prompt
              (src/core/safety/browserToolSafety.ts) so the user sees exactly
              what the LLM saw. */}
          {!isStagedFile && !isMemory && approval?.toolApproval && (
            approval.toolApproval.toolName === BROWSER_FILL_FORM_TOOL
            || approval.toolApproval.toolName === BROWSER_CLICK_TOOL
          ) && (
            <BrowserToolApprovalDetails
              toolName={approval.toolApproval.toolName}
              toolInput={approval.toolApproval.input ?? {}}
            />
          )}

          {/* Redirect result state */}
          {redirectOutcome?.status === 'sending' && (
            <div className="drawer-card__result drawer-card__result--queued" data-testid="drawer-card-redirect-sending">
              <Loader2 size={16} className="drawer-card__spinner" />
              <span>Adding to conversation</span>
            </div>
          )}

          {redirectOutcome?.status === 'sent' && (
            <div className="drawer-card__redirect-state" data-testid="drawer-card-redirect-sent">
              <div className="drawer-card__result">
                <Check size={16} />
                <span>Added to conversation</span>
              </div>
            </div>
          )}

          {redirectOutcome?.status === 'error' && (
            <div className="drawer-card__redirect-state" data-testid="drawer-card-redirect-error">
              <div className="drawer-card__result drawer-card__result--error">
                <AlertCircle size={16} />
                <span>Couldn&apos;t add it. Try again.</span>
              </div>
              <div className="drawer-card__redirect-actions">
                <button
                  type="button"
                  className="drawer-card__btn-back"
                  onClick={handleDismissRedirectError}
                  data-testid="drawer-card-redirect-dismiss"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="drawer-card__btn-primary"
                  onClick={() => {
                    void handleRedirectRetry();
                  }}
                  disabled={isRedirectBusy}
                  data-testid="drawer-card-redirect-retry"
                >
                  {isRedirectBusy ? (
                    <>
                      <Loader2 size={12} className="drawer-card__spinner" />
                      Adding…
                    </>
                  ) : 'Retry'}
                </button>
              </div>
            </div>
          )}

          {/* Redirect editor */}
          {showRedirectEditor && (
            <div className="drawer-card__redirect" data-testid="drawer-card-redirect-editor">
              <Textarea
                value={instructionDraft}
                onChange={(event) => setInstructionDraft(event.target.value)}
                onKeyDown={handleRedirectEditorKeyDown}
                placeholder="Tell Rebel what to do instead..."
                rows={2}
                autoFocus
                maxLength={4000}
                className="drawer-card__redirect-input"
                data-testid="drawer-card-redirect-input"
              />
              <div className="drawer-card__redirect-actions">
                <button
                  type="button"
                  className="drawer-card__btn-back"
                  onClick={handleRedirectCancel}
                  data-testid="drawer-card-redirect-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="drawer-card__btn-primary"
                  onClick={() => {
                    void handleRedirectSubmit();
                  }}
                  disabled={!trimmedInstructionDraft || isRedirectBusy}
                  data-testid="drawer-card-redirect-submit"
                >
                  {isRedirectBusy ? (
                    <>
                      <Loader2 size={12} className="drawer-card__spinner" />
                      Sending…
                    </>
                  ) : 'Send update'}
                </button>
              </div>
            </div>
          )}

          {/* Action buttons (hidden when principle options, redirect editor, or redirect result are open) */}
          {!showOptions && !showDenyOptions && !showRedirectEditor && !showRedirectResult && (
            <div className="drawer-card__actions">
              <div className={actionRowClass}>
                <Tooltip
                  content={approveTooltip}
                  placement="top"
                  delayShow={300}
                >
                  <Button
                    type="button"
                    variant={approveButtonVariant}
                    size="sm"
                    className={approveButtonClass}
                    onClick={isSafetyBlock && !isEvalError ? handleAllowAndUpdate : handleApproveAction}
                    data-testid={isStagedFile ? 'drawer-card-save' : 'drawer-card-approve'}
                  >
                    {isSafetyBlock && !isEvalError ? 'Allow and remember\u2026' : approveLabel}
                  </Button>
                </Tooltip>
                <Button
                  type="button"
                  variant="ghost"
                  size={showRedirectButton ? 'xs' : 'sm'}
                  className={dismissButtonClass}
                  onClick={isSafetyBlock && !isEvalError ? handleDenyAndUpdate : handleDismissAction}
                  data-testid={isStagedFile ? 'drawer-card-keep-private' : 'drawer-card-dismiss'}
                >
                  {isSafetyBlock && !isEvalError ? 'Don\u2019t allow\u2026' : dismissLabel}
                </Button>
                {showRedirectButton && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="drawer-card__action-button drawer-card__btn-change-request"
                    onClick={() => {
                      setShowOptions(false);
                      setShowDenyOptions(false);
                      setRedirectMode('editing');
                    }}
                    data-testid="drawer-card-redirect"
                  >
                    {redirectButtonLabel}
                  </Button>
                )}
              </div>
            </div>
          )}

          </div>
        </>
      )}
    </div>
  );
});
