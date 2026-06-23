// web-companion/src/screens/InboxScreen.tsx

import { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createAgentTurnSocket,
  updateSession,
  useInboxStore,
  useWebVoiceRecording,
  formatRelativeTime,
  resolveInboxCtaLabel,
  deriveContextPlaceholder,
  getQuadrantLabel,
  computeTemporalBoundaries,
  groupByTemporal,
  TEMPORAL_GROUP_ORDER,
  TEMPORAL_GROUP_META,
  sortInboxItems,
  type ConcreteTemporalGroup,
  type InboxItem,
} from '@rebel/cloud-client';
import {
  PlusIcon,
  ArchiveIcon,
  Trash2Icon,
  LoaderIcon,
  MicIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  PinIcon,
  KeyboardIcon,
  SquareIcon,
} from '../components/icons';
import styles from './InboxScreen.module.css';
import { fireAndForget } from '../utils/fireAndForget';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type SnoozeOption = 'tomorrow' | 'next-week' | 'clear';

const TEMPORAL_SECTION_ORDER: ConcreteTemporalGroup[] = TEMPORAL_GROUP_ORDER.filter(
  (group): group is ConcreteTemporalGroup => group !== 'all',
);

const getNextMondayTimestamp = (nowMs: number): number => {
  const nextMonday = new Date(nowMs);
  const daysUntilNextMonday = ((8 - nextMonday.getDay()) % 7) || 7;
  nextMonday.setDate(nextMonday.getDate() + daysUntilNextMonday);
  nextMonday.setHours(0, 0, 0, 0);
  return nextMonday.getTime();
};

function InboxItemCard({
  item,
  onExecute,
  onSnooze,
  onArchive,
  onDelete,
}: {
  item: InboxItem;
  onExecute: (id: string, pinAfter: boolean, context?: string) => void;
  onSnooze: (id: string, option: SnoozeOption) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [context, setContext] = useState('');
  const [openMenu, setOpenMenu] = useState<'split' | 'snooze' | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const splitRef = useRef<HTMLDivElement>(null);
  const snoozeRef = useRef<HTMLDivElement>(null);
  const isExecuting = !!item.executingSessionId;
  const quadrant = getQuadrantLabel(item);
  const ctaLabel = resolveInboxCtaLabel(item);

  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  // Close split dropdown on outside click or Escape
  useEffect(() => {
    if (!openMenu) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (splitRef.current?.contains(target) || snoozeRef.current?.contains(target)) {
        return;
      }
      setOpenMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenu]);

  const handleDelete = useCallback(() => {
    if (confirmDelete) {
      onDelete(item.id);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
    }
  }, [confirmDelete, item.id, onDelete]);

  const handleRun = useCallback((pinAfter: boolean) => {
    const trimmed = context.trim() || undefined;
    onExecute(item.id, pinAfter, trimmed);
    setContext('');
    setOpenMenu(null);
  }, [item.id, context, onExecute]);

  const handleSnooze = useCallback(
    (option: SnoozeOption) => {
      onSnooze(item.id, option);
      setOpenMenu(null);
    },
    [item.id, onSnooze],
  );

  return (
    <div
      className={`${styles.item} ${isExecuting ? styles.itemExecuting : ''}`}
      data-testid={`inbox-item-${item.id}`}
    >
      <div className={styles.itemHeader}>
        <span className={styles.itemTitle}>{item.title}</span>
        {quadrant && (
          <span
            className={`${styles.badge} ${
              item.urgent && item.important
                ? styles.badgeUrgent
                : item.important
                  ? styles.badgeImportant
                  : ''
            }`}
          >
            {quadrant}
          </span>
        )}
        <span className={styles.itemTime}>
          {formatRelativeTime(item.addedAt)}
        </span>
      </div>

      {item.text && (
        <p className={styles.itemText}>{item.text}</p>
      )}

      {!isExecuting && (
        <div className={styles.contextRow}>
          <input
            type="text"
            className={styles.contextInput}
            placeholder={deriveContextPlaceholder(item)}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleRun(false);
              }
            }}
            maxLength={2000}
          />
        </div>
      )}

      <div className={styles.itemActions}>
        {isExecuting ? (
          <span className={styles.executingIndicator}>
            <span className={styles.executingSpinner}>
              <LoaderIcon size={14} />
            </span>
            Running…
          </span>
        ) : (
          <div className={styles.splitButton} ref={splitRef}>
            <button
              className={`${styles.actionButton} ${styles.executeButton}`}
              onClick={() => handleRun(false)}
              aria-label={`${ctaLabel} and archive`}
            >
              <ArchiveIcon size={12} />
              {ctaLabel}
            </button>
            <button
              className={styles.splitToggle}
              onClick={() => setOpenMenu((current) => (current === 'split' ? null : 'split'))}
              aria-haspopup="true"
              aria-expanded={openMenu === 'split'}
              aria-label="More options"
            >
              <ChevronDownIcon size={12} />
            </button>
            {openMenu === 'split' && (
              <div className={styles.splitDropdown}>
                <button
                  className={styles.splitDropdownItem}
                  onClick={() => handleRun(true)}
                >
                  <PinIcon size={14} />
                  {ctaLabel} &amp; Pin
                </button>
              </div>
            )}
          </div>
        )}

        {!isExecuting && (
          <div className={styles.snoozeMenu} ref={snoozeRef}>
            <button
              className={styles.actionButton}
              onClick={() => setOpenMenu((current) => (current === 'snooze' ? null : 'snooze'))}
              aria-haspopup="true"
              aria-expanded={openMenu === 'snooze'}
              aria-label="Snooze options"
            >
              Snooze
              <ChevronDownIcon size={12} />
            </button>

            {openMenu === 'snooze' && (
              <div className={styles.snoozeDropdown}>
                <button
                  className={styles.snoozeDropdownItem}
                  onClick={() => handleSnooze('tomorrow')}
                >
                  Tomorrow
                </button>
                <button
                  className={styles.snoozeDropdownItem}
                  onClick={() => handleSnooze('next-week')}
                >
                  Next week
                </button>
                <button
                  className={styles.snoozeDropdownItem}
                  onClick={() => handleSnooze('clear')}
                >
                  Clear snooze
                </button>
              </div>
            )}
          </div>
        )}

        <button
          className={styles.actionButton}
          onClick={() => onArchive(item.id)}
          aria-label="Archive"
        >
          <ArchiveIcon size={12} />
        </button>
        <button
          className={`${styles.actionButton} ${confirmDelete ? styles.deleteConfirm : styles.deleteButton}`}
          onClick={handleDelete}
          aria-label={confirmDelete ? 'Confirm delete' : 'Delete'}
        >
          <Trash2Icon size={12} />
          {confirmDelete ? 'Sure?' : ''}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function InboxScreen() {
  const navigate = useNavigate();
  const { items, history, isLoading, error, fetchInbox, addItem, archiveItem, deleteItem, snoozeItem, executeItem } =
    useInboxStore();
  const [input, setInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [isTextMode, setIsTextMode] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backgroundSocketsRef = useRef<Map<string, { close: () => void }>>(new Map());

  useEffect(
    () => () => {
      clearTimeout(toastTimerRef.current);
      backgroundSocketsRef.current.forEach((socket) => socket.close());
      backgroundSocketsRef.current.clear();
    },
    [],
  );

  // Voice recording — transcript auto-adds as inbox item
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      fireAndForget(addItem(transcript), 'InboxScreen:voiceTranscript:addItem');
    },
    [addItem],
  );

  const { isRecording, isTranscribing, audioLevel, toggleRecording } =
    useWebVoiceRecording(handleVoiceTranscript);

  useEffect(() => {
    fireAndForget(fetchInbox(), 'InboxScreen:mount:fetchInbox');
  }, [fetchInbox]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const handleAdd = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    fireAndForget(addItem(text), 'InboxScreen:handleAdd:addItem');
  }, [input, addItem]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && input.trim()) {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd, input],
  );

  const handleExecute = useCallback(
    async (itemId: string, pinAfter: boolean, context?: string) => {
      try {
        const { sessionId, prompt } = await executeItem(itemId, context);

        if (pinAfter) {
          // Best-effort "keep Active" write — logged via fireAndForget. If this
          // fails, background execution still proceeds. Active = doneAt null.
          fireAndForget(updateSession(sessionId, {
            doneAt: null,
            updatedAt: Date.now(),
          }), 'InboxScreen:handleExecute:pin');

          const existingSocket = backgroundSocketsRef.current.get(sessionId);
          if (existingSocket) {
            existingSocket.close();
          }

          const socket = createAgentTurnSocket(
            { sessionId, prompt },
            () => {},
            undefined,
            () => {
              if (backgroundSocketsRef.current.get(sessionId) === socket) {
                backgroundSocketsRef.current.delete(sessionId);
              }
            },
          );

          backgroundSocketsRef.current.set(sessionId, socket);
          showToast('Running in background');
          return;
        }

        showToast('On it');
        fireAndForget(
          navigate(`/conversations/${sessionId}?initialPrompt=${encodeURIComponent(prompt)}`),
          'InboxScreen:handleExecute:navigate',
        );
      } catch {
        showToast('Failed to start');
        fireAndForget(archiveItem(itemId, false), 'InboxScreen:handleExecute:archiveItem');
      }
    },
    [archiveItem, executeItem, navigate, showToast],
  );

  const handleSnooze = useCallback(
    async (itemId: string, option: SnoozeOption) => {
      const boundaries = computeTemporalBoundaries();
      const dueBy =
        option === 'tomorrow'
          ? boundaries.todayEndMs
          : option === 'next-week'
            ? getNextMondayTimestamp(boundaries.nowMs)
            : null;

      try {
        await snoozeItem(itemId, dueBy);
        showToast(option === 'clear' ? 'Snooze cleared' : 'Snoozed');
      } catch {
        showToast('Failed to snooze');
      }
    },
    [showToast, snoozeItem],
  );

  const handleArchive = useCallback(
    (itemId: string) => {
      fireAndForget(archiveItem(itemId, true), 'InboxScreen:handleArchive:archiveItem');
    },
    [archiveItem],
  );

  const handleDelete = useCallback(
    (itemId: string) => {
      fireAndForget(deleteItem(itemId), 'InboxScreen:handleDelete:deleteItem');
    },
    [deleteItem],
  );

  // Split items into active and archived
  const activeItems = useMemo(
    () => items.filter((item) => !item.archived),
    [items],
  );

  const groupedActiveSections = useMemo(() => {
    const grouped = groupByTemporal(activeItems);

    return TEMPORAL_SECTION_ORDER
      .map((group) => ({
        group,
        label: TEMPORAL_GROUP_META[group].label,
        items: sortInboxItems(grouped.get(group) ?? []),
      }))
      .filter((section) => section.items.length > 0);
  }, [activeItems]);

  const archivedItems = items.filter((i) => i.archived);

  // Loading state
  if (isLoading && items.length === 0) {
    return (
      <div className={styles.centered}>
        <div className="loading-spinner" />
      </div>
    );
  }

  // Error state (no data loaded)
  if (error && items.length === 0) {
    return (
      <div className={styles.centered}>
        <p className={styles.errorText}>{error}</p>
        <button className={styles.retryButton} onClick={() => fetchInbox()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.headerTitle}>Actions</h1>
        {activeItems.length > 0 && (
          <span className={styles.headerCount}>
            {activeItems.length} item{activeItems.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Quick add — voice-first by default */}
      {isTextMode ? (
        <div className={styles.addRow}>
          <button
            className={styles.keyboardToggle}
            onClick={() => setIsTextMode(false)}
            aria-label="Switch to voice"
          >
            <MicIcon size={18} />
          </button>
          <input
            className={styles.input}
            data-testid="inbox-add-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add something to the pile…"
            maxLength={500}
            disabled={isRecording}
          />
          <button
            className={`${styles.voiceButton} ${isRecording ? styles.voiceButtonRecording : ''}`}
            data-testid="inbox-voice-button"
            onClick={toggleRecording}
            aria-label={isRecording ? 'Stop recording' : 'Record voice note'}
          >
            <MicIcon size={18} />
          </button>
          <button
            className={`${styles.addButton} ${input.trim() ? styles.addButtonReady : ''}`}
            data-testid="inbox-add-button"
            onClick={handleAdd}
            disabled={!input.trim()}
            aria-label="Add item"
          >
            <PlusIcon size={18} />
          </button>
        </div>
      ) : (
        <div className={styles.voiceFirstRow}>
          {isTranscribing ? (
            <div className={styles.voiceTranscribingInline}>
              <span className={styles.executingSpinner}>
                <LoaderIcon size={14} />
              </span>
              <span>Transcribing…</span>
            </div>
          ) : (
            <>
              <button
                className={`${styles.voiceMicInline} ${isRecording ? styles.voiceMicInlineRecording : ''}`}
                data-testid="inbox-voice-button"
                onClick={toggleRecording}
                aria-label={isRecording ? 'Stop recording' : 'Tap to speak'}
                style={{ '--audio-level': isRecording ? audioLevel : 0 } as React.CSSProperties}
              >
                {isRecording ? <SquareIcon size={16} /> : <MicIcon size={22} />}
              </button>
              <span className={isRecording ? styles.voiceHintRecording : styles.voiceHint}>
                {isRecording ? 'Listening…' : 'Tap to add by voice'}
              </span>
              {!isRecording && (
                <button
                  className={styles.keyboardToggle}
                  onClick={() => setIsTextMode(true)}
                  aria-label="Switch to typing"
                >
                  <KeyboardIcon size={18} />
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Transcribing indicator (text mode only) */}
      {isTextMode && isTranscribing && (
        <div className={styles.transcribingBanner}>
          <span className={styles.executingSpinner}>
            <LoaderIcon size={14} />
          </span>
          Transcribing…
        </div>
      )}

      {/* Inline error banner */}
      {error && items.length > 0 && (
        <div className={styles.transcribingBanner}>
          <span style={{ color: 'var(--color-error)' }}>{error}</span>
        </div>
      )}

      {/* Active items */}
      {groupedActiveSections.length > 0 ? (
        <div className={styles.temporalSections}>
          {groupedActiveSections.map((section) => (
            <section key={section.group} className={styles.temporalSection}>
              <div className={styles.temporalSectionHeader}>
                <span className={styles.temporalSectionLabel}>{section.label}</span>
                <span className={styles.temporalSectionCount}>{section.items.length}</span>
              </div>

              <div className={styles.itemsList}>
                {section.items.map((item) => (
                  <InboxItemCard
                    key={item.id}
                    item={item}
                    onExecute={handleExecute}
                    onSnooze={handleSnooze}
                    onArchive={handleArchive}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{TEMPORAL_GROUP_META['due-today'].emptyMessage}</p>
          <p className={styles.emptySubtitle}>{TEMPORAL_GROUP_META['due-this-week'].emptyMessage}</p>
        </div>
      )}

      {/* Archived / History section */}
      {(archivedItems.length > 0 || history.length > 0) && (
        <>
          <button
            className={styles.archivedToggle}
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
          >
            <span className={`${styles.archivedToggleIcon} ${showArchived ? styles.archivedToggleIconOpen : ''}`}>
              <ChevronRightIcon size={14} />
            </span>
            Archived{' '}
            ({archivedItems.length + history.length})
          </button>

          {showArchived && (
            <div className={styles.archivedSection}>
              <div className={styles.itemsList}>
                {/* Archived items (not yet executed) */}
                {archivedItems.map((item) => (
                  <div
                    key={item.id}
                    className={`${styles.item} ${styles.archivedItem}`}
                    data-testid={`inbox-archived-${item.id}`}
                  >
                    <div className={styles.itemHeader}>
                      <span className={styles.itemTitle}>{item.title}</span>
                      <span className={styles.itemTime}>
                        {formatRelativeTime(item.archivedAt ?? item.addedAt)}
                      </span>
                    </div>
                    {item.text && (
                      <p className={styles.itemText}>{item.text}</p>
                    )}
                  </div>
                ))}

                {/* Execution history */}
                {history.map((entry) => (
                  <div
                    key={`${entry.id}-${entry.executedAt}`}
                    className={`${styles.item} ${styles.archivedItem}`}
                    data-testid={`inbox-history-${entry.id}`}
                  >
                    <div className={styles.itemHeader}>
                      <span className={styles.itemTitle}>{entry.title}</span>
                      <span className={styles.itemTime}>
                        {formatRelativeTime(entry.executedAt)}
                      </span>
                    </div>
                    {entry.text && (
                      <p className={styles.itemText}>{entry.text}</p>
                    )}
                    <div className={styles.itemActions}>
                      <button
                        className={styles.historyLink}
                        onClick={() => navigate(`/conversations/${entry.sessionId}`)}
                      >
                        View conversation →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Toast */}
      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
