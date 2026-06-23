import { memo, useCallback, useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AlertCircle, AlertTriangle, Brain, Bookmark, Box, Calendar, Check, ChevronDown, ChevronUp, Circle, Clock, Cloud, CloudOff, Cog, Edit2, ExternalLink, FileText, Flag, Folder, Hash, Hexagon, History, Layers, Loader2, Mail, MessageSquare, Monitor, Pencil, Play, RefreshCw, ShieldQuestion, Sparkles, Square, Star, Target, TestTube, Trash2, Triangle, Wand2, X, Zap } from 'lucide-react';
import type { AutomationAdmissionBlock, AutomationDefinition, AutomationProviderReadinessSummary, AutomationRun, AutomationSchedule, AutomationScheduleQuarantineEntry, SystemAutomationType } from '@shared/types';
import { AutomationSchedule as ScheduleConstructors } from '@shared/utils/automationSchedule';
import { FINISH_LINE_MAX_LENGTH, normalizeFinishLine } from '@core/utils/finishLine';
import { ScheduleEditorPopover } from './ScheduleEditorPopover';
import { BlockedRunDetail } from './BlockedRunDetail';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, Notice, Textarea } from '@renderer/components/ui';
import { useAutomationApprovals, getAutomationReasonDisplayText, type AutomationApprovalItem } from '../hooks/useAutomationApprovals';
import { approvalOutcomeMessage, approvalOutcomeVariant } from '../../inbox/hooks/usePendingApprovals';
import { useAutomationsCrud } from '../hooks/useAutomationsCrud';
import { useSettings } from '@renderer/features/settings/SettingsProvider';
import { RiskBadge, DetailsAccordion, WhySection, SharingBadge } from '@renderer/components/approval/primitives';
import { getMemoryWhyText } from '../utils/getMemoryWhyText';
import { formatRelativeTime } from '@rebel/shared';
import { MentionHeroInput } from '@renderer/features/composer/components/MentionHeroInput';
import { useMentionContext } from '@renderer/contexts';
import { getModelDisplayName } from '@shared/utils/modelNormalization';
import { appendErrorReason } from '@renderer/utils/actionErrorMessage';
import styles from './AutomationsPanel.module.css';

/**
 * EditMenuPopover - Simple popover for choosing between edit options
 */
const EditMenuPopover = memo(({
  isOpen,
  anchorElement,
  onEditInstructions,
  onEditSchedule,
  onChangeModel,
  onClose,
}: {
  isOpen: boolean;
  anchorElement: HTMLElement | null;
  onEditInstructions: () => void;
  onEditSchedule: () => void;
  onChangeModel: () => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the menu below the anchor
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (isOpen && anchorElement) {
      const rect = anchorElement.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 4,
        left: rect.left - 120, // Offset to center-ish under the button
      });
    }
  }, [isOpen, anchorElement]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          anchorElement && !anchorElement.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, anchorElement, onClose]);

  if (!isOpen || !anchorElement) return null;

  return (
    <div
      ref={menuRef}
      className={styles.editMenu}
      style={{ top: position.top, left: position.left }}
      role="menu"
      aria-label="Edit options"
    >
      <button
        type="button"
        className={styles.editMenuItem}
        onClick={() => { onEditInstructions(); onClose(); }}
        role="menuitem"
      >
        <FileText size={14} />
        <span>Edit instructions</span>
      </button>
      <button
        type="button"
        className={styles.editMenuItem}
        onClick={() => { onEditSchedule(); onClose(); }}
        role="menuitem"
      >
        <Clock size={14} />
        <span>Edit schedule</span>
      </button>
      <button
        type="button"
        className={styles.editMenuItem}
        onClick={() => { onChangeModel(); onClose(); }}
        role="menuitem"
      >
        <Brain size={14} />
        <span>Change model...</span>
      </button>
    </div>
  );
});
EditMenuPopover.displayName = 'EditMenuPopover';

/**
 * System automations that support user customization via skill extension.
 * Maps systemType to the base skill path that can be extended.
 */
const CUSTOMIZABLE_SYSTEM_AUTOMATIONS: Partial<Record<SystemAutomationType, { skillPath: string; prompt: string }>> = {
  'transcript-analysis': {
    skillPath: 'rebel-system/skills/meetings/transcript-analysis/SKILL.md',
    prompt: 'I want to customize what happens when my meeting transcripts arrive. '
  }
};

// Finish line copy — keep aligned with the shared finish-line semantics.
// See `docs/plans/260515_finish_line.md`.
const FINISH_LINE_PLACEHOLDER = 'Example: The brief is ready to send, with risks called out.';
const FINISH_LINE_EMPTY_LABEL = 'No finish line';
const FINISH_LINE_HELPER = 'Rebel stops when this is met. Runs of this automation inherit it.';
const FINISH_LINE_COUNTER_THRESHOLD = 400;

type AutomationsPanelProps = {
  onViewSession: (sessionId?: string | null) => void;
  onStartCreateConversation: (initialMessage?: string) => void;
  onStartEditConversation: (automation: AutomationDefinition) => void;
  onCustomizeSystemAutomation?: (automation: AutomationDefinition, skillPath: string, prompt: string) => void;
  onOpenFileInLibrary?: (filePath: string) => void;
  onSendMessageToSession?: (sessionId: string, message: string) => void;
  onOpenProviderSettings?: (cause: AutomationAdmissionBlock | null) => void;
  providerReadinessSummary?: AutomationProviderReadinessSummary | null;
  showToast: (options: { title: string; variant?: 'default' | 'success' | 'warning' | 'error' | 'info' }) => void;
};

const getTimeAwareGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning. What should Rebel handle while you focus?';
  if (hour < 17) return 'What would you like to automate?';
  if (hour < 21) return 'End of day. What should Rebel prep for tomorrow?';
  return 'Even late nights deserve automation. What\'s on your mind?';
};

/**
 * Extract a human-readable skill name from a file path.
 * Examples:
 * - "rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md" → "Wins And Learnings Uncover"
 * - "/path/to/my-skill/SKILL.md" → "My Skill"
 * - "/path/to/custom-task.md" → "Custom Task"
 */
const getReadableSkillName = (filePath: string): string => {
  // Remove leading @ if present (common in file mentions)
  const path = filePath.replace(/^@/, '');
  const parts = path.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] ?? '';
  
  // If it's a SKILL.md file, use the parent folder name
  if (fileName.toLowerCase() === 'skill.md' && parts.length >= 2) {
    const folderName = parts[parts.length - 2] ?? '';
    return formatKebabCase(folderName);
  }
  
  // Otherwise use the filename without extension
  const nameWithoutExt = fileName.replace(/\.md$/i, '');
  return formatKebabCase(nameWithoutExt);
};

/**
 * Convert kebab-case or snake_case to Title Case.
 * "wins-and-learnings-uncover" → "Wins And Learnings Uncover"
 */
function formatKebabCase(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Neutral icon pool for user automations.
 * These are abstract/geometric shapes that don't imply specific content.
 */
const NEUTRAL_ICONS = [Circle, Square, Triangle, Hexagon, Star, Target, Layers, Box, Hash, Bookmark, Folder, Cog] as const;

/**
 * Get a deterministic neutral icon based on automation ID.
 * Uses a simple hash to ensure the same automation always gets the same icon.
 */
const getAutomationIcon = (automationId: string): typeof Circle => {
  // Simple hash based on automation ID characters
  let hash = 0;
  for (let i = 0; i < automationId.length; i++) {
    hash = ((hash << 5) - hash) + automationId.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  const index = Math.abs(hash) % NEUTRAL_ICONS.length;
  return NEUTRAL_ICONS[index];
};

const formatScheduleHuman = (schedule: AutomationDefinition['schedule']): string => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  const formatTime = (time: string): string => {
    const [h, m] = time.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return m === 0 ? `${hour} ${suffix}` : `${hour}:${m.toString().padStart(2, '0')} ${suffix}`;
  };

  switch (schedule.type) {
    case 'daily': {
      const time = formatTime(schedule.time);
      if (schedule.additionalTimes?.length) {
        const additional = schedule.additionalTimes.map(formatTime).join(' and ');
        return `Daily at ${time} and ${additional}`;
      }
      return `Daily at ${time}`;
    }
    case 'weekly': {
      const days = schedule.daysOfWeek ?? [];
      const time = formatTime(schedule.time);
      if (days.length === 5 && !days.includes(0) && !days.includes(6)) {
        return `Weekdays at ${time}`;
      }
      if (days.length === 2 && days.includes(0) && days.includes(6)) {
        return `Weekends at ${time}`;
      }
      if (days.length === 1) {
        return `${dayNames[days[0]]}s at ${time}`;
      }
      return `${days.map(d => shortDays[d]).join(', ')} at ${time}`;
    }
    case 'monthly': {
      const days = schedule.daysOfMonth ?? [];
      const time = formatTime(schedule.time);
      if (days.length === 1) {
        const day = days[0];
        const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';
        return `${day}${suffix} of each month at ${time}`;
      }
      return `Day ${days.join(', ')} of each month at ${time}`;
    }
    case 'every_n_days':
      return `Every ${schedule.intervalDays} days at ${formatTime(schedule.time)}`;
    case 'hourly':
      return `Every hour at :${String(schedule.minute).padStart(2, '0')}`;
    case 'once': {
      const dt = new Date(schedule.dateTime);
      const now = new Date();
      const sameYear = dt.getFullYear() === now.getFullYear();
      const dateStr = dt.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
      });
      const timeStr = formatTime(
        `${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}`
      );
      return `Once on ${dateStr} at ${timeStr}`;
    }
    case 'event':
      if (schedule.eventType === 'transcript-ready') return 'When transcripts arrive';
      return `On ${schedule.eventType ?? 'event'}`;
    default:
      return 'Custom schedule';
  }
};

const AUTOMATION_TIME_OPTS = { direction: 'both' as const, abbreviateDays: false };
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_PROVIDER_READINESS_SUMMARY: AutomationProviderReadinessSummary = {
  readiness: 'ready',
  affectedAutomationCount: 0,
  affectedAutomationIds: [],
  blockedRunCount: 0,
  sinceMs: null,
  cause: null,
};

type LastRunTone = 'neutral' | 'success' | 'error' | 'waiting';

type RunHistoryGroup = {
  key: string;
  runs: AutomationRun[];
  primaryRun: AutomationRun;
  waitingCauseKey: string | null;
  waiting: boolean;
};

type ProviderReadinessBanner = {
  key: string;
  title: string;
  body: string;
  ctaLabel: string;
  cause: AutomationAdmissionBlock | null;
};

const getProviderDisplayName = (provider: AutomationAdmissionBlock['provider'] | undefined): string => {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic';
    case 'openrouter':
      return 'OpenRouter';
    case 'codex':
      return 'ChatGPT Pro';
    default:
      return 'your AI provider';
  }
};

const formatBlockedAutomationCount = (count: number): string =>
  `${count} automation${count === 1 ? '' : 's'} can't run`;

const formatWeekday = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleDateString(undefined, { weekday: 'long' });

const formatWeekdayTime = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${time}`;
};

const getProviderReadinessBanner = (
  summary: AutomationProviderReadinessSummary,
): ProviderReadinessBanner[] => {
  if (
    summary.readiness !== 'blocked'
    || !summary.cause
    || summary.affectedAutomationCount <= 0
  ) {
    return [];
  }

  const affectedAutomationCountText = formatBlockedAutomationCount(summary.affectedAutomationCount);
  const blockedForAtLeastOneDay =
    typeof summary.sinceMs === 'number' && (Date.now() - summary.sinceMs) >= DAY_MS;

  switch (summary.cause.code) {
    case 'codex_disconnected':
      return [{
        key: summary.cause.code,
        title: 'Automations are waiting on ChatGPT Pro',
        body: blockedForAtLeastOneDay && summary.sinceMs
          ? `ChatGPT Pro has been disconnected since ${formatWeekday(summary.sinceMs)}, so ${affectedAutomationCountText}. Reconnect and they'll pick up on their own.`
          : `ChatGPT Pro is disconnected, so ${affectedAutomationCountText}. Reconnect and they'll pick up on their own.`,
        ctaLabel: 'Reconnect',
        cause: summary.cause,
      }];
    case 'anthropic_missing_api_key':
      return [{
        key: summary.cause.code,
        title: 'Automations are waiting on Anthropic',
        body: `Anthropic needs an API key, so ${affectedAutomationCountText}. Add it once and everything resumes on schedule.`,
        ctaLabel: 'Add API key',
        cause: summary.cause,
      }];
    case 'openrouter_disconnected':
      return [{
        key: summary.cause.code,
        title: 'Automations are waiting on OpenRouter',
        body: blockedForAtLeastOneDay && summary.sinceMs
          ? `OpenRouter has been disconnected since ${formatWeekday(summary.sinceMs)}, so ${affectedAutomationCountText}. Reconnect and they'll pick up on their own.`
          : `OpenRouter is disconnected, so ${affectedAutomationCountText}. Reconnect and they'll pick up on their own.`,
        ctaLabel: 'Reconnect',
        cause: summary.cause,
      }];
    default:
      return [{
        key: summary.cause.code,
        title: 'Automations are waiting on your AI provider',
        body: `Your AI provider needs attention, so ${affectedAutomationCountText}. Fix it once and everything resumes on schedule.`,
        ctaLabel: 'Open settings',
        cause: summary.cause,
      }];
  }
};

const isProviderWaitingRun = (run: AutomationRun): boolean =>
  run.status === 'provider_not_ready'
  || (run.status === 'failure' && run.admissionBlock?.source === 'provider-readiness');

const getWaitingCauseKey = (run: AutomationRun): string | null => {
  if (!isProviderWaitingRun(run)) return null;
  if (run.admissionBlock?.source === 'provider-readiness') {
    return run.admissionBlock.code;
  }
  return 'provider_not_ready';
};

const getWaitingCauseAndFix = (run: AutomationRun): { cause: string; fix: string } => {
  if (run.admissionBlock?.source === 'provider-readiness') {
    switch (run.admissionBlock.code) {
      case 'codex_disconnected':
        return { cause: 'ChatGPT Pro is disconnected', fix: 'Reconnect' };
      case 'anthropic_missing_api_key':
        return { cause: 'Anthropic needs an API key', fix: 'Add the key' };
      case 'openrouter_disconnected':
        return { cause: 'OpenRouter is disconnected', fix: 'Reconnect' };
    }
  }

  return {
    cause: 'your AI provider needs attention',
    fix: 'Fix the connection',
  };
};

const formatWaitingGroupedSublabel = (runs: AutomationRun[]): string => {
  const earliestRunAt = runs.reduce((earliest, run) => Math.min(earliest, run.startedAt), runs[0]?.startedAt ?? Date.now());
  const skippedWhen = formatWeekdayTime(earliestRunAt);
  if (runs.length === 1) {
    return `1 scheduled run skipped ${skippedWhen}`;
  }
  return `${runs.length} scheduled runs skipped since ${skippedWhen}`;
};

const coalesceRunHistory = (runs: AutomationRun[]): RunHistoryGroup[] => {
  const groups: RunHistoryGroup[] = [];

  for (const run of runs) {
    const waiting = isProviderWaitingRun(run);
    const waitingCauseKey = waiting ? getWaitingCauseKey(run) : null;
    const last = groups.at(-1);

    if (waiting && last && last.waiting && last.waitingCauseKey === waitingCauseKey) {
      last.runs.push(run);
      continue;
    }

    groups.push({
      key: run.id,
      runs: [run],
      primaryRun: run,
      waitingCauseKey,
      waiting,
    });
  }

  return groups;
};

const formatLastRunStatus = (
  status: string | undefined,
  timestamp: number | null | undefined,
  admissionBlock?: AutomationAdmissionBlock,
): { text: string; tone: LastRunTone } => {
  if (!status || !timestamp) return { text: 'Not yet run', tone: 'neutral' };
  
  const relativeTime = formatRelativeTime(timestamp, AUTOMATION_TIME_OPTS);

  if (
    status === 'provider_not_ready'
    || (status === 'failure' && admissionBlock?.source === 'provider-readiness')
  ) {
    return {
      text: `Waiting on ${getProviderDisplayName(admissionBlock?.provider)} · ${relativeTime}`,
      tone: 'waiting',
    };
  }
  
  if (status === 'blocked_by_security') {
    return { text: `Last run blocked ${relativeTime}`, tone: 'error' };
  }
  
  if (status === 'success') return { text: `✓ Ran ${relativeTime}`, tone: 'success' };
  if (status === 'completed_with_blocks') return { text: `✓ Ran with issues · ${relativeTime}`, tone: 'success' };
  if (status === 'cancelled') return { text: `Cancelled ${relativeTime}`, tone: 'error' };
  if (status === 'failure') return { text: `Failed ${relativeTime}`, tone: 'error' };
  
  return { text: `${status} ${relativeTime}`, tone: 'neutral' };
};

/**
 * Format duration between two timestamps in human-readable form.
 * Examples: "12s", "2m 34s", "1h 5m"
 */
const formatDuration = (startedAt: number, completedAt: number | null | undefined): string | null => {
  if (!completedAt) return null;
  const durationMs = completedAt - startedAt;
  if (durationMs < 0) return null;
  
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

/**
 * Format elapsed time for a running automation.
 * Returns "Running for Xm..." or "Running for Xs..." etc.
 */
const formatElapsedTime = (startedAt: number): string => {
  const elapsed = Date.now() - startedAt;
  const seconds = Math.floor(elapsed / 1000);
  
  if (seconds < 60) return `Running for ${seconds}s...`;
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Running for ${minutes}m...`;
  
  const hours = Math.floor(minutes / 60);
  return `Running for ${hours}h...`;
};

/**
 * Get a human-readable status label for a run status.
 */
const getRunStatusLabel = (status: string): string => {
  switch (status) {
    case 'success': return 'Completed';
    case 'completed_with_blocks': return 'Completed with issues';
    case 'failure': return 'Failed';
    case 'provider_not_ready': return 'Waiting';
    case 'blocked_by_security': return 'Blocked by security';
    case 'cancelled': return 'Cancelled';
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    default: return status;
  }
};

/**
 * Determine if an automation needs setup (is in "draft" state).
 * An automation needs setup if:
 * - It was blocked by security on its last run (permissions denied), OR
 * - It has never run and has no successful runs
 * 
 * This helps users identify automations that won't work until they complete setup.
 */
const automationNeedsSetup = (definition: AutomationDefinition): { needsSetup: boolean; reason: 'blocked' | 'never_run' | null } => {
  // Blocked by security on last run - needs permissions (unless already approved)
  if (definition.lastRunStatus === 'blocked_by_security') {
    return { needsSetup: true, reason: 'blocked' };
  }
  
  // Never run at all - user should run it to verify it works
  // Only flag this for user-created automations (not system ones)
  if (!definition.isSystem && !definition.lastRunAt && !definition.lastSuccessAt) {
    return { needsSetup: true, reason: 'never_run' };
  }
  
  return { needsSetup: false, reason: null };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getQuarantinedDefinitionId = (entry: AutomationScheduleQuarantineEntry): string | null => {
  if (!isRecord(entry.definition)) return null;
  const id = entry.definition.id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const getQuarantinedDefinitionName = (entry: AutomationScheduleQuarantineEntry): string => {
  if (!isRecord(entry.definition)) return 'Untitled automation';
  const name = entry.definition.name;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }
  const id = entry.definition.id;
  if (typeof id === 'string' && id.trim().length > 0) {
    return id.trim();
  }
  return 'Untitled automation';
};

const AutomationsPanelComponent = ({
  onViewSession,
  onStartCreateConversation,
  onStartEditConversation,
  onCustomizeSystemAutomation,
  onOpenFileInLibrary,
  onOpenProviderSettings,
  providerReadinessSummary,
  showToast,
}: AutomationsPanelProps) => {
  // Mention props from context (eliminates prop drilling from App.tsx)
  const {
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    hasWorkspace,
    hasConversations,
    coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex,
  } = useMentionContext();
  // CRUD data and operations sourced locally (Stage 6c: moved out of App.tsx)
  const {
    definitions,
    runs,
    quarantined,
    loading,
    error,
    upsertAutomation,
    deleteAutomation: onDelete,
    runAutomationNow: onRunNow,
  } = useAutomationsCrud();

  // Cloud continuity status — used to show/hide the Desktop|Cloud run-location control
  const { draftSettings } = useSettings();
  const isCloudContinuityConnected = draftSettings?.cloudInstance?.mode === 'cloud';

  const [runningId, setRunningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmAutomation, setDeleteConfirmAutomation] = useState<AutomationDefinition | null>(null);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [heroInputValue, setHeroInputValue] = useState('');
  // Track which automations have their approval panel expanded
  const [expandedApprovalPanels, setExpandedApprovalPanels] = useState<Set<string>>(new Set());
  // Track which run errors are expanded (by run ID)
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  // Track which automations are showing full run history (beyond initial 5)
  const [showAllRuns, setShowAllRuns] = useState<Set<string>>(new Set());
  // Track which descriptions are expanded
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set());
  // Track which descriptions are actually truncated (measured)
  const [truncatedDescriptions, setTruncatedDescriptions] = useState<Set<string>>(new Set());
  // Refs for description elements to measure truncation
  const descriptionRefs = useRef<Map<string, HTMLParagraphElement | null>>(new Map());
  // Track dismissed error (resets when error changes)
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Finish line inline editor state — single editor at a time across the panel.
  // TODO(finish-line): extracting a shared
  // `FinishLineFormField` is queued as a follow-on planning doc — see
  // `docs/plans/260515_finish_line.md` (deferred section).
  const [editingFinishLineId, setEditingFinishLineId] = useState<string | null>(null);
  const [finishLineInput, setFinishLineInput] = useState('');
  const [savingFinishLineId, setSavingFinishLineId] = useState<string | null>(null);
  const finishLineEditButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  
  // Load pending approvals mapped to automations
  const {
    approvalsByAutomation,
    dismissApproval,
    approveToolApproval,
    approveMemoryApproval,
  } = useAutomationApprovals(runs);
  
  // Edit menu state - shown when clicking pencil icon
  const [editMenuAnchor, setEditMenuAnchor] = useState<{
    element: HTMLElement;
    automation: AutomationDefinition;
  } | null>(null);
  
  // Schedule editor popover state
  const [scheduleAnchor, setScheduleAnchor] = useState<{
    element: HTMLElement;
    automationId: string;
    schedule: AutomationSchedule;
  } | null>(null);

  const { userDefinitions, systemDefinitions } = useMemo(() => {
    const user: AutomationDefinition[] = [];
    const system: AutomationDefinition[] = [];
    for (const def of definitions) {
      if (def.isSystem) {
        if (def.systemType === 'calendar-sync' && !draftSettings?.calendar?.useOtherCalendarProvider) {
          continue;
        }
        system.push(def);
      } else {
        user.push(def);
      }
    }
    // Sort user automations: those with pending approvals come first
    user.sort((a, b) => {
      const aHasApprovals = (approvalsByAutomation.get(a.id)?.length ?? 0) > 0;
      const bHasApprovals = (approvalsByAutomation.get(b.id)?.length ?? 0) > 0;
      if (aHasApprovals && !bHasApprovals) return -1;
      if (!aHasApprovals && bHasApprovals) return 1;
      return 0;
    });
    return { userDefinitions: user, systemDefinitions: system };
  }, [definitions, approvalsByAutomation, draftSettings?.calendar?.useOtherCalendarProvider]);

  const runningRuns = useMemo(() => {
    const map = new Map<string, AutomationRun>();
    runs.forEach((run) => {
      if (run.status === 'running' && run.automationId) {
        map.set(run.automationId, run);
      }
    });
    return map;
  }, [runs]);

  // Compute runs by automation ID: sorted by startedAt desc, exclude 'running'
  // We store ALL runs but display up to INITIAL_RUNS_SHOWN unless user clicks "View all"
  const INITIAL_RUNS_SHOWN = 5;
  const runsByAutomationId = useMemo(() => {
    const map = new Map<string, AutomationRun[]>();
    for (const def of definitions) {
      const automationRuns = runs
        .filter(r => r.automationId === def.id && r.status !== 'running')
        .sort((a, b) => b.startedAt - a.startedAt);
      map.set(def.id, automationRuns);
    }
    return map;
  }, [definitions, runs]);

  const handleToggleRunHistory = useCallback((automationId: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(automationId)) {
        next.delete(automationId);
      } else {
        next.add(automationId);
      }
      return next;
    });
  }, []);

  const handleToggleErrorDetails = useCallback((runId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }, []);

  const handleShowAllRuns = useCallback((automationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setShowAllRuns(prev => {
      const next = new Set(prev);
      next.add(automationId);
      return next;
    });
  }, []);

  const handleToggleDescription = useCallback((automationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedDescriptions(prev => {
      const next = new Set(prev);
      if (next.has(automationId)) {
        next.delete(automationId);
      } else {
        next.add(automationId);
      }
      return next;
    });
  }, []);

  // Measure truncation after render
  // With -webkit-line-clamp, Chromium may report scrollHeight === clientHeight
  // even when content is visually truncated. Temporarily remove the clamp to
  // measure the true content height (runs before paint — no visual flash).
  // Batched: unclamp all → read all → restore all to avoid layout thrashing.
  useLayoutEffect(() => {
    const candidates: Array<{ el: HTMLElement; id: string; clampedHeight: number }> = [];
    descriptionRefs.current.forEach((el, id) => {
      if (!el || expandedDescriptions.has(id)) return;
      const clampedHeight = el.clientHeight;
      if (clampedHeight === 0) return;
      candidates.push({ el, id, clampedHeight });
    });
    // Batch unclamp
    for (const { el } of candidates) {
      el.style.display = 'block';
      el.style.overflow = 'visible';
      el.style.webkitLineClamp = 'unset';
    }
    // Batch read
    const newTruncated = new Set<string>();
    for (const { el, id, clampedHeight } of candidates) {
      if (el.scrollHeight > clampedHeight + 1) {
        newTruncated.add(id);
      }
    }
    // Batch restore
    for (const { el } of candidates) {
      el.style.display = '';
      el.style.overflow = '';
      el.style.webkitLineClamp = '';
    }
    setTruncatedDescriptions(prev => {
      if (prev.size !== newTruncated.size) return newTruncated;
      for (const id of newTruncated) { if (!prev.has(id)) return newTruncated; }
      return prev;
    });
  }, [userDefinitions, expandedDescriptions]);

  const handleRetryRun = useCallback(async (automationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRunningId(automationId);
    try {
      await onRunNow(automationId);
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn\'t start automation' });
    } finally {
      setRunningId(null);
    }
  }, [onRunNow, showToast]);

  const handleRunNow = useCallback(async (definition: AutomationDefinition, e: React.MouseEvent) => {
    e.stopPropagation();
    setRunningId(definition.id);
    try {
      await onRunNow(definition.id);
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn\'t start automation' });
    } finally {
      setRunningId(null);
    }
  }, [onRunNow, showToast]);

  const handleDeleteClick = useCallback((definition: AutomationDefinition, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirmAutomation(definition);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmAutomation) return;
    const automationId = deleteConfirmAutomation.id;
    setDeleteConfirmAutomation(null);
    setDeletingId(automationId);
    try {
      await onDelete(automationId);
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn\'t delete' });
    } finally {
      setDeletingId(null);
    }
  }, [deleteConfirmAutomation, onDelete, showToast]);

  const handleDeleteQuarantined = useCallback(async (entry: AutomationScheduleQuarantineEntry) => {
    const definitionId = getQuarantinedDefinitionId(entry);
    if (!definitionId) {
      showToast({ title: 'Couldn’t delete this quarantined automation automatically.' });
      return;
    }

    setDeletingId(definitionId);
    try {
      await onDelete(definitionId);
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn’t delete' });
    } finally {
      setDeletingId(null);
    }
  }, [onDelete, showToast]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmAutomation(null);
  }, []);

  const handleHeroInputSubmit = useCallback(() => {
    onStartCreateConversation(heroInputValue || undefined);
    setHeroInputValue('');
  }, [heroInputValue, onStartCreateConversation]);

  // Note: hero input keyDown (Enter to submit) is handled internally by MentionHeroInput

  // Opens the edit menu with options for instructions or schedule
  const handleEditClick = useCallback((definition: AutomationDefinition, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setEditMenuAnchor({
      element: e.currentTarget,
      automation: definition,
    });
  }, []);

  const handleEditMenuClose = useCallback(() => {
    setEditMenuAnchor(null);
  }, []);

  const handleEditInstructions = useCallback(() => {
    if (editMenuAnchor) {
      // If the automation has a skill file, open it in the library (same as "View instructions")
      if (editMenuAnchor.automation.filePath && onOpenFileInLibrary) {
        onOpenFileInLibrary(editMenuAnchor.automation.filePath);
      } else {
        // Fall back to conversation edit for automations without a file
        onStartEditConversation(editMenuAnchor.automation);
      }
    }
  }, [editMenuAnchor, onOpenFileInLibrary, onStartEditConversation]);

  const handleEditScheduleFromMenu = useCallback(() => {
    if (editMenuAnchor) {
      // Use the menu's anchor element for positioning
      setScheduleAnchor({
        element: editMenuAnchor.element,
        automationId: editMenuAnchor.automation.id,
        schedule: editMenuAnchor.automation.schedule,
      });
    }
  }, [editMenuAnchor]);

  const handleChangeModelFromMenu = useCallback(() => {
    if (editMenuAnchor) {
      onStartEditConversation(editMenuAnchor.automation);
    }
  }, [editMenuAnchor, onStartEditConversation]);

  const handleToggle = useCallback(async (definition: AutomationDefinition) => {
    try {
      await upsertAutomation({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        filePath: definition.filePath,
        enabled: !definition.enabled,
        catchUpIfMissed: definition.catchUpIfMissed,
        schedule: definition.schedule
      });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn\'t toggle' });
    }
  }, [upsertAutomation, showToast]);

  const handleToggleCloudExecution = useCallback(async (definition: AutomationDefinition) => {
    const isCurrentlyCloud = definition.executeIn === 'cloud';
    try {
      await upsertAutomation({
        id: definition.id,
        schedule: definition.schedule,
        executeIn: isCurrentlyCloud ? 'local' : 'cloud',
        // Capture timezone when enabling cloud execution, clear when disabling
        timezone: isCurrentlyCloud ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      showToast({
        title: isCurrentlyCloud
          ? 'Now runs on your desktop — only while Rebel is open'
          : 'Now runs in the cloud — even when your laptop\'s closed',
      });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Couldn\'t update' });
    }
  }, [upsertAutomation, showToast]);

  const handleCustomize = useCallback((definition: AutomationDefinition) => {
    if (!definition.systemType || !onCustomizeSystemAutomation) return;
    const customization = CUSTOMIZABLE_SYSTEM_AUTOMATIONS[definition.systemType];
    if (!customization) return;
    onCustomizeSystemAutomation(definition, customization.skillPath, customization.prompt);
  }, [onCustomizeSystemAutomation]);

  // ─── Finish line handlers ──────────────────────────────────────────────
  const returnFocusToFinishLineEdit = useCallback((automationId: string) => {
    requestAnimationFrame(() => {
      finishLineEditButtonRefs.current.get(automationId)?.focus();
    });
  }, []);

  const handleStartEditFinishLine = useCallback((definition: AutomationDefinition) => {
    setFinishLineInput(definition.finishLine ?? '');
    setEditingFinishLineId(definition.id);
  }, []);

  const handleCancelFinishLine = useCallback((automationId: string) => {
    setEditingFinishLineId(null);
    setFinishLineInput('');
    returnFocusToFinishLineEdit(automationId);
  }, [returnFocusToFinishLineEdit]);

  const handleSaveFinishLine = useCallback(async (definition: AutomationDefinition) => {
    setSavingFinishLineId(definition.id);
    try {
      const normalized = normalizeFinishLine(finishLineInput);
      await upsertAutomation({
        id: definition.id,
        schedule: definition.schedule,
        finishLine: normalized ?? '',
      });
      setEditingFinishLineId(null);
      setFinishLineInput('');
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : "Couldn't save finish line" });
    } finally {
      setSavingFinishLineId(null);
      returnFocusToFinishLineEdit(definition.id);
    }
  }, [finishLineInput, upsertAutomation, showToast, returnFocusToFinishLineEdit]);

  const handleClearFinishLine = useCallback(async (definition: AutomationDefinition) => {
    setSavingFinishLineId(definition.id);
    try {
      await upsertAutomation({
        id: definition.id,
        schedule: definition.schedule,
        finishLine: '',
      });
      setEditingFinishLineId((prev) => (prev === definition.id ? null : prev));
      setFinishLineInput('');
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : "Couldn't clear finish line" });
    } finally {
      setSavingFinishLineId(null);
      returnFocusToFinishLineEdit(definition.id);
    }
  }, [upsertAutomation, showToast, returnFocusToFinishLineEdit]);

  const handleFinishLineKeyDown = useCallback(
    (definition: AutomationDefinition, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleSaveFinishLine(definition);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelFinishLine(definition.id);
      }
    },
    [handleCancelFinishLine, handleSaveFinishLine],
  );

  // Toggle approval panel expansion for a specific automation
  const handleToggleApprovalPanel = useCallback((automationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedApprovalPanels(prev => {
      const next = new Set(prev);
      if (next.has(automationId)) {
        next.delete(automationId);
      } else {
        next.add(automationId);
      }
      return next;
    });
  }, []);

  // Handle approval actions — contextual error messages (REBEL-10T)
  const handleApproveApproval = useCallback(async (approval: AutomationApprovalItem) => {
    if (approval.type === 'tool') {
      const result = await approveToolApproval(approval);
      if (!result.ok) {
        if (result.reason === 'already-handled') return; // silent — already resolved
        const message = approvalOutcomeMessage(result);
        if (message) showToast({ title: message, variant: approvalOutcomeVariant(result) });
      }
    } else {
      const result = await approveMemoryApproval(approval);
      if (!result.ok) {
        const fallbackReason = result.reason === 'ipc-failed'
          ? "Couldn't reach Rebel. Try again in a moment."
          : 'Please try again.';
        showToast({
          title: appendErrorReason("Couldn't approve that", result.detail ?? fallbackReason),
          variant: 'error',
        });
      }
    }
  }, [approveToolApproval, approveMemoryApproval, showToast]);

  const handleDismissApproval = useCallback(async (approval: AutomationApprovalItem) => {
    const success = await dismissApproval(approval);
    if (!success) {
      showToast({ title: "Couldn't dismiss that. Try again." });
    }
  }, [dismissApproval, showToast]);

  const handleViewApprovalConversation = useCallback((approval: AutomationApprovalItem) => {
    if (approval.sessionId) {
      onViewSession(approval.sessionId);
    }
  }, [onViewSession]);



  const handleScheduleSave = useCallback(async (schedule: AutomationSchedule) => {
    if (!scheduleAnchor) return;
    try {
      await upsertAutomation({ id: scheduleAnchor.automationId, schedule });
      showToast({ title: 'Schedule updated' });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : "Couldn't update that schedule" });
      throw err; // Re-throw so popover can handle
    }
    setScheduleAnchor(null);
  }, [scheduleAnchor, upsertAutomation, showToast]);

  const handleScheduleClose = useCallback(() => {
    setScheduleAnchor(null);
  }, []);

  const isEmpty = userDefinitions.length === 0 && systemDefinitions.length === 0 && quarantined.length === 0;
  const effectiveProviderReadinessSummary =
    providerReadinessSummary ?? EMPTY_PROVIDER_READINESS_SUMMARY;
  const providerReadinessBanners = useMemo(
    () => getProviderReadinessBanner(effectiveProviderReadinessSummary),
    [effectiveProviderReadinessSummary],
  );

  return (
    <div className={styles.viewport} data-testid="automations-panel">
      <div className={styles.panel}>
        {/* Page Header */}
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Automations</h1>
          <p className={styles.pageSubtitle}>
            Schedule tasks to run automatically. Rebel works while you don't.
          </p>
          <p className={styles.keepOpenNotice}>
            <Clock size={14} />
            Keep Rebel open in your dock or menu bar for automations to run on schedule.
          </p>
        </div>

        <div className={styles.panelBody}>
          {loading ? (
            <div className={styles.loadingState}>
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonCard} />
            </div>
          ) : isEmpty ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <Clock size={32} strokeWidth={1.5} />
              </div>
              <h3 className={styles.emptyHeadline}>Rebel works while you don't</h3>
              <p className={styles.emptyDescription}>
                Schedule recurring tasks—meeting prep, weekly summaries, research updates,
                follow-up reminders—and Rebel handles them automatically. Small time savings add up.
              </p>
              <div className={styles.emptyPrompt}>
                <span className={styles.emptyGreeting}>{getTimeAwareGreeting()}</span>
              </div>
              <button
                type="button"
                className={styles.createButton}
                onClick={() => onStartCreateConversation()}
                data-testid="automations-create-button"
              >
                <MessageSquare size={18} />
                Tell Rebel what to automate
              </button>
              <div className={styles.suggestionChips}>
                <button type="button" className={styles.suggestionChip} onClick={() => onStartCreateConversation('Create a daily email digest automation')}>
                  <Mail size={14} /> Daily email digest
                </button>
                <button type="button" className={styles.suggestionChip} onClick={() => onStartCreateConversation('Create a meeting prep automation')}>
                  <Calendar size={14} /> Meeting prep
                </button>
                <button type="button" className={styles.suggestionChip} onClick={() => onStartCreateConversation('Create a weekly review automation')}>
                  <Sparkles size={14} /> Weekly review
                </button>
              </div>
            </div>
          ) : (
            <>
            {/* Hero Input - Always visible at top when automations exist */}
            <div className={styles.heroInputSection}>
              <MentionHeroInput
                value={heroInputValue}
                onChange={setHeroInputValue}
                onSubmit={handleHeroInputSubmit}
                placeholder='e.g. "Summarize my emails every morning at 9am"'
                ariaLabel="Create automation"
                testId="automations-create-input-hero"
                submitTestId="automations-create-button-hero"
                submitAriaLabel="Create automation"
                mentionResultsForQuery={mentionResultsForQuery}
                ensureLibraryIndex={ensureLibraryIndex}
                getRelativeLibraryPath={getRelativeLibraryPath}
                hasWorkspace={hasWorkspace}
                hasConversations={hasConversations}
                coreDirectory={coreDirectory}
                libraryIndex={libraryIndex}
                libraryIndexLoading={libraryIndexLoading}
                libraryIndexError={libraryIndexError}
                refreshLibraryIndex={refreshLibraryIndex}
              />
              <p className={styles.heroInputHelper}>
                Not sure what to automate?{' '}
                <button
                  type="button"
                  className={styles.heroInputHelperLink}
                  onClick={() => onStartCreateConversation('Help me discover what I should automate. Interview me about my workflow to find the best automation opportunities.')}
                >
                  Let Rebel help you discover opportunities.
                </button>
              </p>
            </div>

            {quarantined.length > 0 && (
              <div className={styles.quarantinedSection} data-testid="automations-quarantined-section">
                <div className={styles.sectionHeader}>
                  <h3 className={styles.sectionTitle}>Couldn&apos;t load</h3>
                  <p className={styles.sectionSubtitle}>
                    A few automations need manual cleanup.
                  </p>
                </div>
                <div className={styles.quarantinedList}>
                  {quarantined.map((entry, index) => {
                    const quarantinedId = getQuarantinedDefinitionId(entry);
                    const isDeletingQuarantined = quarantinedId !== null && deletingId === quarantinedId;
                    return (
                      <div
                        key={`${quarantinedId ?? 'unknown'}-${entry.quarantinedAt}-${index}`}
                        className={styles.quarantinedItem}
                      >
                        <div className={styles.quarantinedContent}>
                          <p className={styles.quarantinedName}>{getQuarantinedDefinitionName(entry)}</p>
                          <p className={styles.quarantinedReason}>
                            This automation couldn&apos;t load (reason: {entry.reason}). Delete it, or contact support to recover.
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={quarantinedId === null || isDeletingQuarantined}
                          onClick={() => { void handleDeleteQuarantined(entry); }}
                        >
                          Delete
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Two-column layout */}
            <div className={styles.columnsContainer}>
              {/* Main column - User automations */}
              <div className={styles.mainColumn}>
                {providerReadinessBanners.length > 0 && (
                  <div className={styles.providerReadinessNoticeStack}>
                    {providerReadinessBanners.map((notice, index) => (
                      <Notice
                        key={notice.key}
                        tone="warning"
                        placement="section"
                        density="standard"
                        title={notice.title}
                        data-testid={`automations-provider-readiness-notice-${index}`}
                        actions={[{
                          label: notice.ctaLabel,
                          onClick: () => { onOpenProviderSettings?.(notice.cause); },
                          'data-testid': `automations-provider-readiness-cta-${index}`,
                        }]}
                      >
                        {notice.body}
                      </Notice>
                    ))}
                  </div>
                )}
                {userDefinitions.length > 0 ? (
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>Your Automations</h3>
                    <p className={styles.sectionSubtitle}>
                      Tasks you've scheduled. Edit, run, or pause anytime.
                    </p>
                  </div>
                ) : (
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>Your Automations</h3>
                  </div>
                )}
                {userDefinitions.length === 0 ? (
                  <div className={styles.userEmptyState}>
                    <img
                      src="https://storage.googleapis.com/mindstone-public-assets/rebel/rebel4.png"
                      alt=""
                      aria-hidden="true"
                      className={styles.userEmptyMascot}
                    />
                    <p className={styles.userEmptyText}>
                      No automations yet. Describe a recurring task and Rebel will handle it on schedule.
                    </p>
                    <button
                      type="button"
                      className={styles.userEmptyButton}
                      onClick={() => onStartCreateConversation()}
                      data-testid="automations-user-empty-create"
                    >
                      Create your first automation
                    </button>
                  </div>
                ) : (
                <div className={styles.automationsList}>
                  {userDefinitions.map((definition) => {
              const runningRun = runningRuns.get(definition.id);
              const isRunning = !!runningRun || runningId === definition.id;
              const isDeleting = deletingId === definition.id;
              const Icon = getAutomationIcon(definition.id);
              const latestAutomationRun = runsByAutomationId.get(definition.id)?.[0];
              const lastRun = formatLastRunStatus(
                definition.lastRunStatus,
                definition.lastRunAt,
                latestAutomationRun?.admissionBlock,
              );
              const nextRun = definition.nextRunAt ? formatRelativeTime(definition.nextRunAt, AUTOMATION_TIME_OPTS) : null;
              const workingModelDisplay = definition.model ? getModelDisplayName(definition.model) : null;
              const thinkingModelDisplay = definition.thinkingModel ? getModelDisplayName(definition.thinkingModel) : null;
              const modelChipText = workingModelDisplay && thinkingModelDisplay
                ? `${workingModelDisplay} / ${thinkingModelDisplay}`
                : workingModelDisplay
                  ? workingModelDisplay
                  : thinkingModelDisplay
                    ? `Default / ${thinkingModelDisplay}`
                    : null;
              
              // Check if automation needs setup
              const { needsSetup, reason: setupReason } = automationNeedsSetup(definition);

              // Detect completed/failed once-automations
              const isCompletedOnce = definition.schedule.type === 'once'
                && (definition.lastRunStatus === 'success' || definition.lastRunStatus === 'completed_with_blocks');
              const isFailedOnce = definition.schedule.type === 'once'
                && definition.lastRunAt != null
                && !isCompletedOnce;
              
              // Get pending approvals for this automation
              const automationApprovals = approvalsByAutomation.get(definition.id) || [];
              const approvalCount = automationApprovals.length;
              const isApprovalPanelExpanded = expandedApprovalPanels.has(definition.id);
              const isDescriptionExpanded = expandedDescriptions.has(definition.id);
              // Check if description is actually truncated (measured)
              const descriptionNeedsTruncation = truncatedDescriptions.has(definition.id);
              const isCloudSelected = definition.executeIn === 'cloud';
              const isCloudDegraded = isCloudSelected && !isCloudContinuityConnected;

              return (
                <div
                  key={definition.id}
                  className={`${styles.automationCard} ${isRunning ? styles.automationCardRunning : ''} ${!definition.enabled ? styles.automationCardPaused : ''} ${needsSetup ? styles.automationCardNeedsSetup : ''} ${isCompletedOnce ? styles.automationCardCompleted : ''} ${isFailedOnce ? styles.automationCardFailed : ''}`.trim()}
                  data-testid={`automation-item-${definition.id}`}
                >
                  {/* Card Body - Icon, content, and toggle */}
                  <div className={styles.cardBody}>
                    <div className={styles.cardIcon}>
                      <Icon size={20} />
                    </div>
                    <div className={styles.cardContent}>
                    <div className={styles.cardHeader}>
                      <div className={styles.cardTitleRow}>
                        <span className={styles.cardName}>{definition.name}</span>
                        {/* Status in parentheses - inline with title, clickable for errors to expand history */}
                        {!isRunning && lastRun.text && (
                          lastRun.tone === 'error' ? (
                            <button
                              type="button"
                              className={`${styles.cardStatusInline} ${styles.cardStatusInlineError} ${styles.cardStatusInlineClickable}`.trim()}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleRunHistory(definition.id);
                              }}
                              title="View run details"
                            >
                              ({lastRun.text.replace('✓ ', '')})
                            </button>
                          ) : (
                            <span
                              className={`${styles.cardStatusInline} ${lastRun.tone === 'success' ? styles.cardStatusInlineSuccess : ''} ${lastRun.tone === 'waiting' ? styles.cardStatusInlineWaiting : ''}`.trim()}
                            >
                              ({lastRun.text.replace('✓ ', '')})
                            </span>
                          )
                        )}
                        {isRunning && (
                          <span className={styles.cardStatusInline}>
                            <Loader2 size={12} className={styles.runningSpinner} />
                            ({runningRun ? formatElapsedTime(runningRun.startedAt) : 'Starting...'})
                            {runningRun?.sessionId && (
                              <button
                                type="button"
                                className={styles.runningViewLink}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onViewSession(runningRun.sessionId);
                                }}
                              >
                                View →
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    {definition.description && (
                      <div className={styles.cardDescriptionWrapper}>
                        <p 
                          ref={(el) => {
                            if (el) {
                              descriptionRefs.current.set(definition.id, el);
                            } else {
                              descriptionRefs.current.delete(definition.id);
                            }
                          }}
                          className={`${styles.cardDescription} ${isDescriptionExpanded ? styles.cardDescriptionExpanded : ''}`.trim()}
                        >
                          {definition.description}
                          {/* View more inline with text when truncated */}
                          {descriptionNeedsTruncation && !isDescriptionExpanded && (
                            <button
                              type="button"
                              className={styles.cardDescriptionToggleInline}
                              onClick={(e) => handleToggleDescription(definition.id, e)}
                            >
                              View more
                            </button>
                          )}
                        </p>
                        {descriptionNeedsTruncation && isDescriptionExpanded && (
                          <button
                            type="button"
                            className={styles.cardDescriptionToggle}
                            onClick={(e) => handleToggleDescription(definition.id, e)}
                          >
                            View less
                          </button>
                        )}
                      </div>
                    )}

                    {modelChipText && (
                      <span className={styles.modelChip}>{modelChipText}</span>
                    )}

                    {(() => {
                      const isEditingFinishLine = editingFinishLineId === definition.id;
                      const isSavingFinishLine = savingFinishLineId === definition.id;
                      const finishLineHelperId = `automation-finish-line-helper-${definition.id}`;
                      const finishLineCounterId = `automation-finish-line-counter-${definition.id}`;
                      const counterAtCap = finishLineInput.length >= FINISH_LINE_MAX_LENGTH;
                      return (
                        <div
                          className={styles.finishLineSection}
                          data-testid={`automation-finish-line-section-${definition.id}`}
                        >
                          {isEditingFinishLine ? (
                            <div className={styles.finishLineEdit}>
                              <Textarea
                                value={finishLineInput}
                                onChange={(e) => setFinishLineInput(e.target.value)}
                                onKeyDown={(e) => handleFinishLineKeyDown(definition, e)}
                                placeholder={FINISH_LINE_PLACEHOLDER}
                                rows={3}
                                maxLength={FINISH_LINE_MAX_LENGTH}
                                className={styles.finishLineTextarea}
                                aria-label="Finish line criterion"
                                aria-describedby={finishLineHelperId}
                                data-testid="automation-finish-line-textarea"
                                autoFocus
                              />
                              <div className={styles.finishLineHelperRow}>
                                <p id={finishLineHelperId} className={styles.finishLineHelper}>
                                  {FINISH_LINE_HELPER}
                                </p>
                                {finishLineInput.length > FINISH_LINE_COUNTER_THRESHOLD && (
                                  <span
                                    id={finishLineCounterId}
                                    className={`${styles.finishLineCounter}${counterAtCap ? ` ${styles.finishLineCounterAtCap}` : ''}`}
                                    aria-live="polite"
                                    data-testid="automation-finish-line-counter"
                                  >
                                    {finishLineInput.length}/{FINISH_LINE_MAX_LENGTH}
                                  </span>
                                )}
                              </div>
                              <div className={styles.finishLineActions}>
                                {definition.finishLine && (
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => { void handleClearFinishLine(definition); }}
                                    disabled={isSavingFinishLine}
                                    className={styles.finishLineClearBtn}
                                    data-testid="automation-finish-line-clear"
                                  >
                                    Clear
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleCancelFinishLine(definition.id)}
                                  disabled={isSavingFinishLine}
                                  data-testid="automation-finish-line-cancel"
                                >
                                  Cancel
                                </Button>
                                <Button
                                  variant="default"
                                  size="sm"
                                  onClick={() => { void handleSaveFinishLine(definition); }}
                                  disabled={isSavingFinishLine}
                                  data-testid="automation-finish-line-save"
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className={styles.finishLineHeader}>
                              <span className={styles.finishLineLabel}>Finish line</span>
                              {definition.finishLine ? (
                                <span className={styles.finishLineValue} title={definition.finishLine}>
                                  <Flag size={12} className={styles.finishLineIcon} aria-hidden="true" />
                                  {definition.finishLine}
                                </span>
                              ) : (
                                <span className={styles.finishLineEmpty}>{FINISH_LINE_EMPTY_LABEL}</span>
                              )}
                              <button
                                ref={(el) => {
                                  if (el) {
                                    finishLineEditButtonRefs.current.set(definition.id, el);
                                  } else {
                                    finishLineEditButtonRefs.current.delete(definition.id);
                                  }
                                }}
                                type="button"
                                className={styles.finishLineEditBtn}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleStartEditFinishLine(definition);
                                }}
                                aria-label={definition.finishLine ? 'Edit finish line' : 'Set finish line'}
                                data-testid="automation-finish-line-edit"
                              >
                                <Edit2 size={12} />
                              </button>
                              {definition.finishLine && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => { void handleClearFinishLine(definition); }}
                                  disabled={isSavingFinishLine}
                                  aria-label="Clear finish line"
                                  className={styles.finishLineInlineClearBtn}
                                  data-testid="automation-finish-line-clear-collapsed"
                                >
                                  Clear
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div className={styles.cardMeta}>
                      <button
                        type="button"
                        className={styles.cardScheduleBadge}
                        onClick={(e) => {
                          e.stopPropagation();
                          setScheduleAnchor({
                            element: e.currentTarget,
                            automationId: definition.id,
                            schedule: definition.schedule,
                          });
                        }}
                        title="Edit schedule"
                      >
                        <Clock size={11} />
                        <span>{formatScheduleHuman(definition.schedule)}</span>
                        <Pencil size={10} className={styles.cardScheduleEditIcon} />
                      </button>
                      {isCompletedOnce && (
                        <span className={styles.onceBadgeCompleted}>
                          <Check size={11} />
                          Completed
                        </span>
                      )}
                      {isFailedOnce && (
                        <span className={styles.onceBadgeFailed}>
                          <AlertCircle size={11} />
                          Failed
                        </span>
                      )}
                      {nextRun && !isRunning && (
                        <span className={styles.cardNextRunBadge}>Next {nextRun}</span>
                      )}
                      {/* Run location — segmented Desktop | Cloud control; visible when connected or cloud-selected */}
                      {(isCloudContinuityConnected || definition.executeIn === 'cloud') && !definition.isSystem && definition.schedule.type !== 'event' && (
                        <div
                          className={styles.runLocation}
                          role="radiogroup"
                          aria-label="Where this automation runs"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className={styles.runLocationLabel}>Runs on</span>
                          <div className={styles.runLocationSegments}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={!isCloudSelected}
                              className={`${styles.runLocationSegment} ${!isCloudSelected ? styles.runLocationSegmentActive : ''}`.trim()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isCloudSelected) void handleToggleCloudExecution(definition);
                              }}
                              title="Runs only while Rebel is open on this computer"
                            >
                              <Monitor size={11} />
                              <span>Desktop</span>
                            </button>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={isCloudSelected}
                              className={`${styles.runLocationSegment} ${isCloudSelected ? styles.runLocationSegmentActive : ''} ${isCloudDegraded ? styles.runLocationSegmentDegraded : ''}`.trim()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isCloudSelected) void handleToggleCloudExecution(definition);
                              }}
                              title={isCloudDegraded
                                ? 'Cloud\'s offline — running on your desktop until it\'s back'
                                : 'Runs in the cloud, even when your laptop\'s closed'}
                            >
                              {isCloudDegraded ? <CloudOff size={11} /> : <Cloud size={11} />}
                              <span>Cloud</span>
                            </button>
                          </div>
                          {isCloudDegraded && (
                            <span className={styles.runLocationHint}>offline — on desktop for now</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Run History Section - expanded state only (toggle moved to footer) */}
                    {(() => {
                      const allAutomationRuns = runsByAutomationId.get(definition.id) ?? [];
                      const isHistoryExpanded = expandedCards.has(definition.id);
                      const isShowingAll = showAllRuns.has(definition.id);
                      const hasMoreRuns = allAutomationRuns.length > INITIAL_RUNS_SHOWN;
                      const visibleRuns = isShowingAll ? allAutomationRuns : allAutomationRuns.slice(0, INITIAL_RUNS_SHOWN);
                      const runGroups = coalesceRunHistory(visibleRuns);
                      
                      // Only show section when expanded and has runs
                      if (!isHistoryExpanded || allAutomationRuns.length === 0) return null;
                      
                      return (
                        <div 
                          id={`automation-run-history-${definition.id}`}
                          className={styles.runHistorySection} 
                          data-testid={`automation-run-history-${definition.id}`}
                        >
                          <div className={styles.runHistoryTimeline}>
                            {runGroups.map((group, index) => {
                              const run = group.primaryRun;
                              const isWaiting = group.waiting;
                              const isSuccess = !isWaiting && (run.status === 'success' || run.status === 'completed_with_blocks');
                              const isError = !isWaiting && ['failure', 'blocked_by_security', 'cancelled'].includes(run.status);
                              const duration = isWaiting ? null : formatDuration(run.startedAt, run.completedAt);
                              const isErrorExpanded = expandedErrors.has(group.key);
                              const hasError = isError && run.error;
                              const hasBlockedActions = run.blockedActions && run.blockedActions.length > 0;
                              const hasExpandableDetail = isWaiting || hasError || (isSuccess && hasBlockedActions);
                              const isFirst = index === 0;
                              const waitingGroupedSublabel = isWaiting ? formatWaitingGroupedSublabel(group.runs) : null;
                              const waitingDetail = isWaiting
                                ? (() => {
                                    const { cause, fix } = getWaitingCauseAndFix(run);
                                    return `Rebel didn't run this because ${cause}. ${fix} and runs resume on schedule, or use Run now if you'd rather not wait.`;
                                  })()
                                : null;
                              
                              return (
                                <div 
                                  key={group.key}
                                  className={`${styles.runHistoryItem} ${isFirst ? styles.runHistoryItemFirst : ''}`}
                                  data-testid={isWaiting ? `automation-run-history-waiting-${definition.id}-${index}` : undefined}
                                >
                                  <div className={styles.runHistoryItemMain}>
                                    <span className={`${styles.runHistoryStatus} ${isSuccess ? styles.runHistoryStatusSuccess : ''} ${isError ? styles.runHistoryStatusError : ''} ${isWaiting ? styles.runHistoryStatusWaiting : ''}`.trim()}>
                                      {isSuccess ? <Check size={12} /> : isError ? <AlertCircle size={12} /> : isWaiting ? <AlertTriangle size={12} /> : <Clock size={12} />}
                                    </span>
                                    <div className={styles.runHistoryInfo}>
                                      <div className={styles.runHistoryHeader}>
                                        <span className={`${styles.runHistoryStatusLabel} ${isError ? styles.runHistoryStatusLabelError : ''}`}>{isWaiting ? 'Waiting' : getRunStatusLabel(run.status)}</span>
                                        {!isWaiting && (
                                          <>
                                            <span className={styles.runHistoryDot}>·</span>
                                            <span className={styles.runHistoryTime}>{formatRelativeTime(run.startedAt, AUTOMATION_TIME_OPTS)}</span>
                                          </>
                                        )}
                                        {!isWaiting && duration && (
                                          <>
                                            <span className={styles.runHistoryDot}>·</span>
                                            <span className={styles.runHistoryDuration}>{duration}</span>
                                          </>
                                        )}
                                      </div>
                                      {isWaiting && waitingGroupedSublabel && (
                                        <span className={styles.runHistoryTime}>{waitingGroupedSublabel}</span>
                                      )}
                                      {hasExpandableDetail && (
                                        <button
                                          type="button"
                                          className={isWaiting ? styles.runHistoryWaitToggle : styles.runHistoryErrorToggle}
                                          onClick={(e) => handleToggleErrorDetails(group.key, e)}
                                          aria-expanded={isErrorExpanded}
                                        >
                                          <span>{isErrorExpanded ? 'Hide details' : 'Show details'}</span>
                                        </button>
                                      )}
                                    </div>
                                    <div className={styles.runHistoryActions}>
                                      {(isError || isWaiting) && (
                                        <button
                                          type="button"
                                          className={styles.runHistoryRetryButton}
                                          onClick={(e) => void handleRetryRun(definition.id, e)}
                                          title={isWaiting ? 'Run now' : 'Retry now'}
                                          disabled={runningId === definition.id}
                                        >
                                          {isWaiting ? <Play size={12} /> : <RefreshCw size={12} />}
                                          <span>{isWaiting ? 'Run now' : 'Retry'}</span>
                                        </button>
                                      )}
                                      {run.sessionId && (
                                        <button
                                          type="button"
                                          className={styles.runHistoryViewLink}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onViewSession(run.sessionId);
                                          }}
                                        >
                                          View →
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  {hasExpandableDetail && isErrorExpanded && (
                                    <div className={isWaiting ? styles.runHistoryWaitDetails : styles.runHistoryErrorDetails}>
                                      {isWaiting && waitingDetail ? (
                                        <p className={styles.runHistoryWaitText}>{waitingDetail}</p>
                                      ) : run.status !== 'cancelled' && run.blockedActions?.length ? (
                                        <BlockedRunDetail
                                          run={run}
                                          definition={definition}
                                          onRetry={async (id) => { await onRunNow(id); }}
                                        />
                                      ) : run.error?.includes('could not be found in your workspace') ? (
                                        <div className={styles.runHistoryErrorText}>
                                          <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{run.error.split('\n\n')[0]}</p>
                                          {run.error.split('\n\n')[1] && (
                                            <p style={{ margin: 0, opacity: 0.7, fontSize: '0.85em' }}>{run.error.split('\n\n')[1]}</p>
                                          )}
                                        </div>
                                      ) : (
                                        <pre className={styles.runHistoryErrorText}>{run.error}</pre>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {hasMoreRuns && !isShowingAll && (
                            <button
                              type="button"
                              className={styles.runHistoryViewAll}
                              onClick={(e) => handleShowAllRuns(definition.id, e)}
                            >
                              View all {allAutomationRuns.length} runs
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    </div>
                    {/* Toggle on right side of body - matches built-in cards */}
                    <div className={styles.cardToggle}>
                      <label className={styles.toggleSwitch} title={definition.enabled ? 'Pause' : 'Enable'}>
                        <input
                          type="checkbox"
                          checked={definition.enabled}
                          onChange={() => void handleToggle(definition)}
                        />
                        <span className={styles.toggleTrack} />
                      </label>
                    </div>
                  </div>

                  {/* Approval Extension - Shows as card extension when there are pending approvals */}
                  {approvalCount > 0 && (
                    <div className={styles.approvalExtension} data-testid={`automation-approval-extension-${definition.id}`}>
                      {/* Collapsed state - clickable bar */}
                      <button
                        type="button"
                        className={styles.approvalExtensionBar}
                        onClick={(e) => handleToggleApprovalPanel(definition.id, e)}
                        aria-expanded={isApprovalPanelExpanded}
                      >
                        <ShieldQuestion size={14} />
                        <span>{approvalCount} approval{approvalCount === 1 ? '' : 's'} needed</span>
                        {isApprovalPanelExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      
                      {/* Expanded state - approval details */}
                      {isApprovalPanelExpanded && (
                        <div className={styles.approvalExtensionContent}>
                          {automationApprovals.map((approval) => {
                            const isMemory = approval.type === 'memory';
                            const memoryWhyText = isMemory && approval.memoryApproval
                              ? getMemoryWhyText(approval.memoryApproval)
                              : undefined;
                            const toolReason = !isMemory && approval.toolApproval?.reason
                              ? getAutomationReasonDisplayText(approval.toolApproval.reason, approval.description)
                              : undefined;
                            const whyText = memoryWhyText ?? toolReason;

                            return (
                              <div key={approval.id} className={styles.approvalItem}>
                                <div className={styles.approvalItemHeader}>
                                  <span className={styles.approvalItemIcon}>
                                    {isMemory ? <Brain size={12} /> : <Zap size={12} />}
                                  </span>
                                  <span className={styles.approvalItemTitle}>
                                    {isMemory
                                      ? (approval.spaceName ? `Save to ${approval.spaceName}` : 'Memory write')
                                      : (approval.packageName || 'Action needs your OK')}
                                  </span>
                                  {approval.riskLevel && (
                                    <RiskBadge riskLevel={approval.riskLevel} />
                                  )}
                                  {isMemory && approval.memoryApproval?.sharing && (
                                    <SharingBadge sharing={approval.memoryApproval.sharing} />
                                  )}
                                </div>

                                <p className={styles.approvalItemDescription}>
                                  {approval.description}
                                </p>

                                {/* Content preview for memory approvals */}
                                {isMemory && approval.memoryApproval?.contentPreview && (
                                  <p className={styles.approvalContentPreview}>
                                    {approval.memoryApproval.contentPreview.length > 200
                                      ? `${approval.memoryApproval.contentPreview.slice(0, 200)}…`
                                      : approval.memoryApproval.contentPreview}
                                  </p>
                                )}

                                {/* Tool details accordion */}
                                {!isMemory && approval.toolApproval && (
                                  <DetailsAccordion
                                    toolName={approval.toolApproval.toolName}
                                    params={approval.toolApproval.input}
                                  />
                                )}

                                {/* WHY section */}
                                {whyText && <WhySection reason={whyText} />}

                                <div className={styles.approvalItemActions}>
                                  <button
                                    type="button"
                                    className={`${styles.approvalActionButton} ${styles.approvalActionDismiss}`}
                                    onClick={() => void handleDismissApproval(approval)}
                                    data-testid={`approval-dismiss-${approval.id}`}
                                  >
                                    <X size={12} />
                                    {isMemory ? "Don't save" : "Don't run"}
                                  </button>
                                  <div className={styles.approvalItemActionsRight}>
                                    {approval.sessionId && (
                                      <button
                                        type="button"
                                        className={`${styles.approvalActionButton} ${styles.approvalActionView}`}
                                        onClick={() => handleViewApprovalConversation(approval)}
                                        data-testid={`approval-view-${approval.id}`}
                                      >
                                        <ExternalLink size={12} />
                                        View
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className={`${styles.approvalActionButton} ${styles.approvalActionApprove}`}
                                      onClick={() => void handleApproveApproval(approval)}
                                      data-testid={`approval-approve-${approval.id}`}
                                    >
                                      <Check size={12} />
                                      Allow
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Card Footer - Action buttons */}
                  <div className={styles.cardFooter}>
                    {/* Left side actions */}
                    <div className={styles.cardFooterLeft}>
                      <button
                        type="button"
                        className={`${styles.cardFooterButton} ${styles.cardFooterButtonDanger}`.trim()}
                        onClick={(e) => handleDeleteClick(definition, e)}
                        disabled={isDeleting}
                      >
                        <Trash2 size={12} />
                        <span>Delete</span>
                      </button>
                      {definition.filePath && (
                        <button
                          type="button"
                          className={styles.cardFooterButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenFileInLibrary?.(definition.filePath);
                          }}
                          title={`View: ${getReadableSkillName(definition.filePath)}`}
                        >
                          <FileText size={12} />
                          <span>View instructions</span>
                        </button>
                      )}
                      {/* View runs button - only show when there are past runs */}
                      {(runsByAutomationId.get(definition.id)?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          className={styles.cardFooterButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleRunHistory(definition.id);
                          }}
                          aria-expanded={expandedCards.has(definition.id)}
                          aria-controls={`automation-run-history-${definition.id}`}
                          data-testid={`automation-run-history-toggle-${definition.id}`}
                        >
                          <History size={12} />
                          <span>{expandedCards.has(definition.id) ? 'Hide runs' : 'View runs'}</span>
                        </button>
                      )}
                      {(isCompletedOnce || isFailedOnce) && (
                        <button
                          type="button"
                          className={styles.cardFooterButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            setScheduleAnchor({
                              element: e.currentTarget,
                              automationId: definition.id,
                              schedule: definition.schedule,
                            });
                          }}
                          data-testid={`automation-reschedule-${definition.id}`}
                        >
                          <Calendar size={12} />
                          <span>Reschedule</span>
                        </button>
                      )}
                    </div>
                    {/* Right side actions */}
                    <div className={styles.cardFooterRight}>
                      {/* Test automation CTA - show when never run */}
                      {needsSetup && setupReason === 'never_run' && !isRunning ? (
                        <>
                          <button
                            type="button"
                            className={styles.cardFooterButton}
                            onClick={(e) => handleEditClick(definition, e)}
                            data-testid={`automation-edit-${definition.id}`}
                          >
                            <Pencil size={12} />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.cardFooterButton} ${styles.cardFooterButtonPrimary}`.trim()}
                            onClick={(e) => handleRunNow(definition, e)}
                            disabled={isRunning}
                            title="Run this automation now"
                            data-testid={`automation-test-${definition.id}`}
                          >
                            <TestTube size={12} />
                            <span>Test automation</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.cardFooterButton}
                            onClick={(e) => handleRunNow(definition, e)}
                            disabled={isRunning}
                          >
                            <Play size={12} />
                            <span>Run now</span>
                          </button>
                          <button
                            type="button"
                            className={styles.cardFooterButton}
                            onClick={(e) => handleEditClick(definition, e)}
                            data-testid={`automation-edit-${definition.id}`}
                          >
                            <Pencil size={12} />
                            <span>Edit</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
                  })}
                </div>
                )}
              </div>

              {/* Sidebar column - System automations */}
              {systemDefinitions.length > 0 && (
                <div className={styles.sidebarColumn}>
                  <div className={styles.systemSection}>
                    <h3 className={styles.sectionTitle}>Built-in</h3>
                    <p className={styles.sectionSubtitle}>
                      Rebel runs these to power Inbox and The Spark. Enable the ones you find useful.
                    </p>
                    {systemDefinitions.map((definition) => {
                      const runningRun = runningRuns.get(definition.id);
                      const isCustomizable = definition.systemType && 
                        CUSTOMIZABLE_SYSTEM_AUTOMATIONS[definition.systemType] !== undefined;
                      return (
                        <div 
                          key={definition.id} 
                          className={styles.systemCard}
                          title="Built-in automation — runs automatically to power your dashboard"
                        >
                          {/* Header row with name and toggle */}
                          <div className={styles.systemCardHeader}>
                            <div className={styles.systemNameRow}>
                              <span className={styles.systemName}>{definition.name}</span>
                              {isCustomizable && onCustomizeSystemAutomation && (
                                <button
                                  type="button"
                                  className={styles.customizeLink}
                                  onClick={() => handleCustomize(definition)}
                                  title="Add your own rules and preferences"
                                >
                                  <Wand2 size={12} />
                                  <span>Make it yours</span>
                                </button>
                              )}
                            </div>
                            <div className={styles.systemActions}>
                              {runningRun ? (
                                <span className={styles.runningDot} title="Running" />
                              ) : (
                                <label className={styles.toggleSwitch}>
                                  <input
                                    type="checkbox"
                                    checked={definition.enabled}
                                    onChange={() => void handleToggle(definition)}
                                  />
                                  <span className={styles.toggleTrack} />
                                </label>
                              )}
                            </div>
                          </div>
                          {/* Description extends full width below */}
                          <div className={styles.systemInfo}>
                            {definition.description && (
                              <p className={styles.systemDescription}>{definition.description}</p>
                            )}
                            <span className={styles.systemScheduleBadge}>
                              <Clock size={10} />
                              {formatScheduleHuman(definition.schedule)}
                            </span>
                          </div>

                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            </>
          )}

          {error && error !== dismissedError && (
            <div className={styles.errorBanner}>
              <span className={styles.errorBannerText}>{error}</span>
              <button
                type="button"
                className={styles.errorBannerDismiss}
                onClick={() => setDismissedError(error)}
                aria-label="Dismiss error"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>


        {/* Edit Menu Popover - shown when clicking pencil icon */}
        <EditMenuPopover
          isOpen={editMenuAnchor !== null}
          anchorElement={editMenuAnchor?.element ?? null}
          onEditInstructions={handleEditInstructions}
          onEditSchedule={handleEditScheduleFromMenu}
          onChangeModel={handleChangeModelFromMenu}
          onClose={handleEditMenuClose}
        />

        {/* Schedule Editor Popover */}
        <ScheduleEditorPopover
          isOpen={scheduleAnchor !== null}
          anchorElement={scheduleAnchor?.element ?? null}
          currentSchedule={scheduleAnchor?.schedule ?? ScheduleConstructors.daily({ time: '09:00' })}
          onSave={handleScheduleSave}
          onClose={handleScheduleClose}
        />

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteConfirmAutomation !== null} onOpenChange={(open) => !open && handleDeleteCancel()}>
          <DialogContent size="sm">
            <DialogHeader icon={<Trash2 size={20} />}>
              <DialogTitle>Delete automation?</DialogTitle>
              <DialogDescription>
                "{deleteConfirmAutomation?.name || 'Untitled'}" will be permanently removed.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
                This cannot be undone. Any scheduled runs will be cancelled.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={handleDeleteCancel}>
                Keep automation
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteConfirm}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export const AutomationsPanel = memo(AutomationsPanelComponent);
AutomationsPanel.displayName = 'AutomationsPanel';

export default AutomationsPanel;
