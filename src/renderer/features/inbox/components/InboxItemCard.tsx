import { memo, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { CheckCircle2, ExternalLink, Trash2, Loader2, ChevronDown, RotateCcw } from 'lucide-react';
import type { InboxItem } from '@shared/types';
import { deriveContextPlaceholder, derivePriorityLevel, getPriorityLabel, isPriorityPinnedToToday, priorityToQuadrant, TEMPORAL_GROUP_META } from '@rebel/shared';
import type { PriorityLevel, ConcreteTemporalGroup } from '@rebel/shared';

import { Badge, Button, InlineToggle, Tooltip } from '@renderer/components/ui';
import { useTranscriptionMic } from '@renderer/features/composer/hooks/useTranscriptionMic';
import { useAppContext } from '@renderer/contexts/AppContext';
import { useOptimisticExecution, type ExecutionStatus } from '../hooks/useOptimisticExecution';
import { InboxCardFrame } from './InboxCardFrame';
import { VoiceMicButton } from './VoiceMicButton';
import { InboxItemExpanded } from './InboxItemExpanded';
import { friendlySourceName } from '@renderer/utils/formatSourceLabel';
import { resolveInboxCtaLabel } from '../utils/resolveInboxCtaLabel';
import styles from './InboxItemCard.module.css';

const SUBTITLE_PREVIEW_LENGTH = 120;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PRIORITY_CLASS: Record<PriorityLevel, string> = {
  urgent: styles.priorityUrgent,
  high: styles.priorityHigh,
  medium: styles.priorityMedium,
  low: styles.priorityLow,
};

export type InboxItemCardProps = {
  item: InboxItem;
  isDeparting?: boolean;
  executionStatus?: ExecutionStatus;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onOpenDetail?: (itemId: string, context?: string) => void;
  onExecute: (itemId: string, pinAfter: boolean, context?: string) => void;
  onDone?: (itemId: string) => void;
  onDismiss?: (itemId: string) => void;
  onRestore?: (itemId: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onSetPriority?: (itemId: string, urgent: boolean, important: boolean) => void;
  onSetSchedule?: (itemId: string, group: ConcreteTemporalGroup) => void;
  currentTemporalGroup?: ConcreteTemporalGroup;
  isArchived?: boolean;
  isDone?: boolean;
  doneSessionId?: string;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  selectionActive?: boolean;
  autoDone?: boolean;
  onAutoDoneChange?: (itemId: string, value: boolean) => void;
};

const formatTimeAgo = (timestamp: number): string => {
  const elapsed = Math.max(Date.now() - timestamp, 0);
  if (elapsed < HOUR_MS) {
    const minutes = Math.max(1, Math.round(elapsed / MINUTE_MS));
    return `${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.max(1, Math.round(elapsed / HOUR_MS));
    return `${hours}h ago`;
  }
  if (elapsed < 7 * DAY_MS) {
    const days = Math.max(1, Math.round(elapsed / DAY_MS));
    return `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
};

function getSourceLabel(source: NonNullable<InboxItem['source']>): string {
  if (source.label) return source.label;
  switch (source.kind) {
    case 'meeting': return source.meetingTitle || 'Meeting';
    case 'conversation': return 'Conversation';
    case 'automation': return source.automationName;
    case 'role': return source.roleName;
    case 'workspace': return source.path.split(/[/\\]/).pop() || source.path;
    default: return source.kind;
  }
}

function getSourceSessionId(source: NonNullable<InboxItem['source']>): string | null {
  if (source.kind === 'conversation') return source.sessionId;
  return null;
}

const InboxItemCardComponent = ({
  item,
  isDeparting,
  executionStatus = 'idle',
  isExpanded,
  onToggleExpand,
  onOpenDetail,
  onExecute,
  onDone,
  onDismiss,
  onRestore,
  onOpenFile,
  onOpenSession,
  onSetPriority,
  onSetSchedule,
  currentTemporalGroup,
  isArchived,
  isDone,
  doneSessionId,
  isSelected,
  onToggleSelect,
  selectionActive,
  autoDone: autoDoneDefault,
  onAutoDoneChange,
}: InboxItemCardProps) => {
  const [context, setContext] = useState('');
  const [autoDone, setAutoDone] = useState(autoDoneDefault ?? false);
  const { showToast } = useAppContext();

  useEffect(() => {
    setAutoDone(autoDoneDefault ?? false);
  }, [autoDoneDefault]);

  const { isActive, markPending } = useOptimisticExecution(executionStatus);

  const handleTranscript = useCallback((text: string) => {
    setContext(prev => prev ? `${prev} ${text}` : text);
  }, []);

  const handleTranscriptAndSend = useCallback((text: string) => {
    const fullContext = (context ? `${context} ${text}` : text).trim();
    queueMicrotask(() => {
      onExecute(item.id, !autoDone, fullContext);
    });
    setContext('');
  }, [context, item.id, onExecute, autoDone]);

  const hasDraft = !!item.draft?.trim();

  const handleTranscriptionError = useCallback((message: string) => {
    showToast({ title: message, variant: 'error' });
  }, [showToast]);

  const {
    isRecording,
    isProcessing: isTranscribeProcessing,
    toggleRecording,
    stopAndSend,
    audioLevel
  } = useTranscriptionMic({
    currentSessionId: item.id,
    onTranscript: handleTranscript,
    onTranscriptAndSend: handleTranscriptAndSend,
    onError: handleTranscriptionError,
  });

  const micDisabled = isTranscribeProcessing || (!isRecording && isActive);

  const hasText = !!item.text?.trim();
  const hasReferences = (item.references?.length ?? 0) > 0;
  const placeholder = deriveContextPlaceholder(item);
  const hasContent = hasText || hasReferences || hasDraft;

  const handleActivate = useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand();
    } else if (hasContent && onOpenDetail) {
      onOpenDetail(item.id, context || undefined);
    }
  }, [hasContent, item.id, onOpenDetail, onToggleExpand, context]);

  const handleSourceClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.source) return;
    const sessionId = getSourceSessionId(item.source);
    if (sessionId && onOpenSession) {
      onOpenSession(sessionId);
    } else if (item.source.kind === 'workspace' && onOpenFile) {
      onOpenFile(item.source.path);
    }
  }, [item.source, onOpenSession, onOpenFile]);

  const priorityLevel: PriorityLevel = derivePriorityLevel(item);
  const statusText = getPriorityLabel(priorityLevel);
  const schedulePinnedToToday = isPriorityPinnedToToday(item);

  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const priorityMenuRef = useRef<HTMLDivElement>(null);

  const handlePriorityToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSetPriority) return;
    setPriorityMenuOpen(prev => !prev);
  }, [onSetPriority]);

  const handlePrioritySelect = useCallback((level: PriorityLevel) => {
    if (!onSetPriority) return;
    const { urgent, important } = priorityToQuadrant(level);
    onSetPriority(item.id, urgent, important);
    setPriorityMenuOpen(false);
  }, [onSetPriority, item.id]);

  useEffect(() => {
    if (!priorityMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (priorityMenuRef.current && !priorityMenuRef.current.contains(e.target as Node)) {
        setPriorityMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [priorityMenuOpen]);

  const SCHEDULE_GROUPS: ConcreteTemporalGroup[] = ['due-today', 'due-this-week', 'upcoming'];
  const scheduleValue = currentTemporalGroup ?? 'upcoming';

  const handleScheduleSelect = useCallback((group: ConcreteTemporalGroup) => {
    if (!onSetSchedule) return;
    onSetSchedule(item.id, group);
  }, [onSetSchedule, item.id]);

  const handleAutoDoneToggle = useCallback(() => {
    const next = !autoDone;
    setAutoDone(next);
    onAutoDoneChange?.(item.id, next);
  }, [autoDone, item.id, onAutoDoneChange]);

  const subtitleText = useMemo(() => {
    if (!hasText) return null;
    const trimmed = item.text.trim();
    if (trimmed === item.title.trim()) return null;
    if (trimmed.length <= SUBTITLE_PREVIEW_LENGTH) return trimmed;
    return trimmed.slice(0, SUBTITLE_PREVIEW_LENGTH) + '\u2026';
  }, [hasText, item.text, item.title]);

  const provenanceText = useMemo(() => {
    if (!item.source) return null;
    const raw = item.source.label || getSourceLabel(item.source);
    const friendly = friendlySourceName(raw);
    return friendly.charAt(0).toUpperCase() + friendly.slice(1);
  }, [item.source]);

  const sourceSessionId = item.source ? getSourceSessionId(item.source) : null;

  const expandedContent = onToggleExpand ? <InboxItemExpanded item={item} onOpenFile={onOpenFile} /> : undefined;

  return (
    <InboxCardFrame
      itemId={item.id}
      isDeparting={isDeparting}
      isArchived={isArchived}
      isExpanded={isExpanded}
      isSelected={isSelected}
      selectionActive={selectionActive}
      onToggleSelect={onToggleSelect}
      selectionLabel={`Select ${item.title}`}
      onActivate={handleActivate}
      expandedContent={expandedContent}
      footer={
        <>
          <div className={styles.footerLeft}>
            {onDismiss && (
              <Tooltip content="Remove this item — tap Undo to restore" delayShow={400}>
                <Button
                  size="xs"
                  variant="ghost"
                  className={`${styles.footerButton} ${styles.footerButtonDanger}`}
                  onClick={() => onDismiss(item.id)}
                >
                  <Trash2 size={12} /> Delete
                </Button>
              </Tooltip>
            )}
            {onDone && (
              <Tooltip content="Mark as completed and move to Done" delayShow={400}>
                <Button
                  size="xs"
                  variant="ghost"
                  className={`${styles.footerButton} ${styles.hoverReveal}`}
                  onClick={() => onDone(item.id)}
                >
                  <CheckCircle2 size={12} /> Done
                </Button>
              </Tooltip>
            )}
          </div>
          <div className={styles.footerRight}>
            {isDone && doneSessionId && (
              <Button onClick={() => onOpenSession?.(doneSessionId)} size="xs" variant="outline">
                <ExternalLink size={11} /> Open conversation
              </Button>
            )}
            {isArchived && onRestore && (!isDone || !doneSessionId) && (
              <Button onClick={() => onRestore(item.id)} size="xs" variant="outline">
                <RotateCcw size={11} /> Restore
              </Button>
            )}
            {!isArchived && (
              <Tooltip
                content={
                  autoDone
                    ? 'After Review finishes, Rebel will move this action to Done for you.'
                    : 'Turn on to move this action to Done automatically after Review finishes. Leave it off if you want to check the result first.'
                }
                delayShow={500}
              >
                <InlineToggle
                  checked={autoDone}
                  label="Auto-mark done"
                  onCheckedChange={() => handleAutoDoneToggle()}
                  stopPropagation
                />
              </Tooltip>
            )}
            {!isArchived && (
              <Button
                onClick={() => {
                  markPending();
                  onExecute(item.id, !autoDone, context.trim() || undefined);
                  setContext('');
                }}
                size="xs"
                variant="secondary"
                disabled={isActive}
              >
                {isActive ? (
                  <>
                    <Loader2 size={11} className={styles.spinner} /> <span>Prepping</span>
                  </>
                ) : (
                  resolveInboxCtaLabel(item)
                )}
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className={styles.cardContent}>
        <div className={styles.metaRow}>
          <div className={styles.metaRowPrimary}>
            <div className={styles.priorityDropdownWrapper} ref={priorityMenuRef}>
              <button
                type="button"
                className={styles.statusBadgeTrigger}
                onClick={handlePriorityToggle}
                aria-haspopup="listbox"
                aria-expanded={priorityMenuOpen}
              >
                <Badge size="sm" variant="muted" className={`${styles.statusBadge} ${PRIORITY_CLASS[priorityLevel]}`}>
                  {statusText}
                  <ChevronDown size={10} className={styles.priorityChevron} />
                </Badge>
              </button>
              {priorityMenuOpen && (
                <div className={styles.priorityMenu} role="listbox">
                  {(['urgent', 'high', 'medium', 'low'] as PriorityLevel[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="option"
                      aria-selected={level === priorityLevel}
                      className={`${styles.priorityMenuItem} ${level === priorityLevel ? styles.priorityMenuItemActive : ''} ${PRIORITY_CLASS[level]}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePrioritySelect(level);
                      }}
                    >
                      {getPriorityLabel(level)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {onSetSchedule && (
              <div className={styles.scheduleDropdownWrapper}>
                {schedulePinnedToToday ? (
                  <Tooltip content="Urgent items stay in Today" delayShow={300}>
                    <Badge size="sm" variant="muted" className={`${styles.scheduleBadge} ${styles.scheduleDropdownButtonDisabled}`}>
                      Today
                    </Badge>
                  </Tooltip>
                ) : (
                  <label className={styles.scheduleSelectLabel}>
                    <span className={styles.srOnly}>Schedule</span>
                    <Badge size="sm" variant="muted" className={styles.scheduleBadge}>
                      {TEMPORAL_GROUP_META[scheduleValue].label}
                      <ChevronDown size={10} className={styles.scheduleSelectChevron} aria-hidden />
                    </Badge>
                    <select
                      className={styles.scheduleSelect}
                      value={scheduleValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        handleScheduleSelect(e.target.value as ConcreteTemporalGroup);
                      }}
                      aria-label="Schedule"
                    >
                      {SCHEDULE_GROUPS.map((group) => (
                        <option key={group} value={group}>
                          {TEMPORAL_GROUP_META[group].label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
          <span className={styles.metaRowRight}>
            {provenanceText &&
              ((sourceSessionId && onOpenSession) || (item.source?.kind === 'workspace' && onOpenFile) ? (
                <button className={styles.provenanceLink} onClick={handleSourceClick} type="button">
                  {provenanceText}
                </button>
              ) : (
                <span className={styles.provenanceLabel}>{provenanceText}</span>
              ))}
            <span className={styles.timestamp}>{formatTimeAgo(item.addedAt)}</span>
          </span>
        </div>
        <span className={styles.cardTitle}>{item.title}</span>

        {hasText && item.text.trim() !== item.title.trim() && (
          <div className={styles.subtitleRow}>
            <p className={isExpanded ? styles.subtitleExpanded : styles.subtitle}>
              {isExpanded ? item.text.trim() : subtitleText}
            </p>
            {hasContent && (
              <ChevronDown
                size={18}
                className={`${styles.expandIcon} ${isExpanded ? styles.expandIconOpen : ''}`}
              />
            )}
          </div>
        )}

        {!isArchived && (
          <div className={styles.inputRow}>
            <VoiceMicButton
              isRecording={isRecording}
              isProcessing={isTranscribeProcessing}
              disabled={micDisabled}
              audioLevel={audioLevel}
              onToggle={toggleRecording}
              onStopAndSend={stopAndSend}
            />
            <textarea
              className={styles.contextInput}
              placeholder={placeholder}
              value={context}
              rows={1}
              onChange={(e) => {
                setContext(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.overflowY = 'hidden';
                const max = 120;
                if (el.scrollHeight > max) {
                  el.style.height = `${max}px`;
                  el.style.overflowY = 'auto';
                } else {
                  el.style.height = `${el.scrollHeight}px`;
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isActive) {
                  e.preventDefault();
                  markPending();
                  onExecute(item.id, !autoDone, context.trim() || undefined);
                  setContext('');
                }
              }}
              disabled={isActive}
            />
          </div>
        )}
      </div>
    </InboxCardFrame>
  );
};

export const InboxItemCard = memo(InboxItemCardComponent);
InboxItemCard.displayName = 'InboxItemCard';
