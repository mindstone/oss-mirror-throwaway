// web-companion/src/screens/ConversationsScreen.tsx

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useSessionStore,
  updateSession,
  deleteSession,
  formatRelativeTime,
  type SessionSummary,
} from '@rebel/cloud-client';
import { XIcon } from '../components/icons';
import styles from './ConversationsScreen.module.css';
import { fireAndForget } from '../utils/fireAndForget';

interface SessionRowProps {
  session: SessionSummary;
  isMenuOpen: boolean;
  isRenaming: boolean;
  renameDraft: string;
  isMutating: boolean;
  onOpen: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onStartRename: (session: SessionSummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: (session: SessionSummary) => void | Promise<void>;
  onCancelRename: () => void;
  onToggleStar: (session: SessionSummary) => void;
  onMarkDone: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  menuRef: (node: HTMLDivElement | null) => void;
}

function SessionRow({
  session,
  isMenuOpen,
  isRenaming,
  renameDraft,
  isMutating,
  onOpen,
  onToggleMenu,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onToggleStar,
  onMarkDone,
  onDelete,
  menuRef,
}: SessionRowProps) {
  const rowTitle = session.title?.trim() || 'Untitled';

  return (
    <div className={styles.row} data-testid={`session-item-${session.id}`}>
      <div
        className={`${styles.rowMain} ${isRenaming ? styles.rowMainEditing : ''}`}
        role="button"
        tabIndex={isRenaming || isMutating ? -1 : 0}
        onClick={() => {
          if (!isRenaming && !isMutating) {
            onOpen(session.id);
          }
        }}
        onKeyDown={(event) => {
          if (isRenaming || isMutating) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(session.id);
          }
        }}
      >
        <div className={styles.rowHeader}>
          {isRenaming ? (
            <input
              className={styles.renameInput}
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelRename();
                }
              }}
              onBlur={() => {
                fireAndForget(onCommitRename(session), 'ConversationsScreen:onCommitRename');
              }}
              autoFocus
              maxLength={200}
              aria-label="Rename conversation"
            />
          ) : (
            <span className={styles.rowTitle}>{rowTitle}</span>
          )}

          {session.starredAt ? (
            <span className={styles.starIcon} aria-label="Starred" title="Starred">
              ★
            </span>
          ) : null}

          {session.isBusy && <span className={styles.busyDot} />}
        </div>

        <p className={styles.rowPreview}>{session.preview || 'No messages yet'}</p>

        <div className={styles.rowFooter}>
          <span className={styles.rowTime}>{formatRelativeTime(session.updatedAt)}</span>
          <span className={styles.rowMeta}>
            {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <div className={styles.rowActions} ref={isMenuOpen ? menuRef : undefined}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={() => onToggleMenu(session.id)}
          aria-label="Session actions"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          disabled={isMutating}
        >
          ⋯
        </button>

        {isMenuOpen && (
          <div className={styles.menu} role="menu" aria-label="Session actions">
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => onStartRename(session)}
              role="menuitem"
              disabled={isMutating}
            >
              Rename
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => onToggleStar(session)}
              role="menuitem"
              disabled={isMutating}
            >
              {session.starredAt ? 'Remove from Starred' : 'Add to Starred'}
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => onMarkDone(session)}
              role="menuitem"
              disabled={isMutating}
            >
              Mark as done
            </button>
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onClick={() => onDelete(session)}
              role="menuitem"
              disabled={isMutating}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConversationsScreen() {
  const { sessions, isLoading, error, fetchSessions } = useSessionStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpenSessionId, setMenuOpenSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [mutatingSessionId, setMutatingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const renamingSessionIdRef = useRef<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fireAndForget(fetchSessions({ activeOnly: true }), 'ConversationsScreen:mount:fetchSessions');
  }, [fetchSessions]);

  useEffect(() => {
    renamingSessionIdRef.current = renamingSessionId;
  }, [renamingSessionId]);

  useEffect(() => {
    if (!menuOpenSessionId && !renamingSessionId) return;

    const handleClick = (event: MouseEvent) => {
      if (
        menuOpenSessionId &&
        menuContainerRef.current &&
        !menuContainerRef.current.contains(event.target as Node)
      ) {
        setMenuOpenSessionId(null);
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpenSessionId(null);
      renamingSessionIdRef.current = null;
      setRenamingSessionId(null);
      setRenameDraft('');
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpenSessionId, renamingSessionId]);

  const sortedSessions = useMemo(
    () =>
      sessions
        .filter((session) => !session.deletedAt)
        .slice()
        .sort((a, b) => {
          if (a.isBusy && !b.isBusy) return -1;
          if (!a.isBusy && b.isBusy) return 1;
          return b.updatedAt - a.updatedAt;
        }),
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return sortedSessions;

    return sortedSessions.filter((session) =>
      (session.title ?? '').toLowerCase().includes(normalizedQuery),
    );
  }, [searchQuery, sortedSessions]);

  const handleRefresh = useCallback(() => {
    fireAndForget(fetchSessions({ activeOnly: true }), 'ConversationsScreen:handleRefresh:fetchSessions');
  }, [fetchSessions]);

  const handleOpen = useCallback(
    (id: string) => {
      fireAndForget(navigate(`/conversations/${id}`), 'ConversationsScreen:handleOpen:navigate');
    },
    [navigate],
  );

  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuContainerRef.current = node;
  }, []);

  const runSessionAction = useCallback(
    async (sessionId: string, action: () => Promise<unknown>) => {
      setActionError(null);
      setMutatingSessionId(sessionId);

      try {
        await action();
        await fetchSessions({ activeOnly: true });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Action failed. Rebel blames entropy.');
      } finally {
        setMutatingSessionId((current) => (current === sessionId ? null : current));
        setMenuOpenSessionId((current) => (current === sessionId ? null : current));
      }
    },
    [fetchSessions],
  );

  const handleToggleMenu = useCallback((sessionId: string) => {
    setMenuOpenSessionId((current) => (current === sessionId ? null : sessionId));
  }, []);

  const handleStartRename = useCallback((session: SessionSummary) => {
    setMenuOpenSessionId(null);
    renamingSessionIdRef.current = session.id;
    setRenamingSessionId(session.id);
    setRenameDraft(session.title ?? '');
  }, []);

  const handleCancelRename = useCallback(() => {
    renamingSessionIdRef.current = null;
    setRenamingSessionId(null);
    setRenameDraft('');
  }, []);

  const handleCommitRename = useCallback(
    async (session: SessionSummary) => {
      if (renamingSessionIdRef.current !== session.id) return;

      const nextTitle = renameDraft.trim() || 'Untitled';
      const currentTitle = session.title?.trim() || 'Untitled';

      renamingSessionIdRef.current = null;
      setRenamingSessionId(null);
      setRenameDraft('');

      if (nextTitle === currentTitle) return;

      await runSessionAction(session.id, () =>
        updateSession(session.id, {
          title: nextTitle,
          updatedAt: Date.now(),
        }),
      );
    },
    [renameDraft, runSessionAction],
  );

  const handleToggleStar = useCallback(
    (session: SessionSummary) => {
      // True favourite toggle — only touch starredAt, never lifecycle fields.
      fireAndForget(runSessionAction(session.id, () =>
        updateSession(session.id, {
          starredAt: session.starredAt ? null : Date.now(),
          updatedAt: Date.now(),
        }),
      ), 'ConversationsScreen:handleToggleStar');
    },
    [runSessionAction],
  );

  const handleMarkDone = useCallback(
    (session: SessionSummary) => {
      const now = Date.now();
      // Lifecycle DONE write via canonical `doneAt`. resolvedAt stays a distinct
      // co-write.
      fireAndForget(runSessionAction(session.id, () =>
        updateSession(session.id, {
          resolvedAt: now,
          doneAt: now,
          updatedAt: now,
        }),
      ), 'ConversationsScreen:handleMarkDone');
    },
    [runSessionAction],
  );

  const handleDelete = useCallback(
    (session: SessionSummary) => {
      const shouldDelete = window.confirm(
        'Delete this conversation? It will not be coming back.',
      );

      if (!shouldDelete) {
        setMenuOpenSessionId(null);
        return;
      }

      fireAndForget(runSessionAction(session.id, () => deleteSession(session.id)), 'ConversationsScreen:handleDelete');
    },
    [runSessionAction],
  );

  if (isLoading && sessions.length === 0) {
    return (
      <div className={styles.centered}>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className={styles.centered}>
        <p className={styles.errorText}>{error}</p>
        <button className={styles.retryButton} onClick={handleRefresh}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.headerTitle}>Conversations</h1>
      </div>

      {sortedSessions.length > 0 && (
        <div className={styles.searchBar}>
          <input
            type="text"
            className={styles.searchInput}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by title"
            aria-label="Search conversations by title"
          />
          {searchQuery && (
            <button
              type="button"
              className={styles.searchClearButton}
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
      )}

      {actionError && <p className={styles.actionError}>{actionError}</p>}

      {sortedSessions.length === 0 ? (
        <div className={styles.centered}>
          <p className={styles.emptyTitle}>Nothing here yet. The blank canvas of productivity.</p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className={styles.centered}>
          <p className={styles.emptyTitle}>No title matches. Rebel checked the obvious places.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {filteredSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isMenuOpen={menuOpenSessionId === session.id}
              isRenaming={renamingSessionId === session.id}
              renameDraft={renameDraft}
              isMutating={mutatingSessionId === session.id}
              onOpen={handleOpen}
              onToggleMenu={handleToggleMenu}
              onStartRename={handleStartRename}
              onRenameDraftChange={setRenameDraft}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
              onToggleStar={handleToggleStar}
              onMarkDone={handleMarkDone}
              onDelete={handleDelete}
              menuRef={setMenuRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
