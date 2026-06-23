// web-companion/src/screens/HomeScreen.tsx

import { useEffect, useCallback, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  useAuthStore,
  useSessionStore,
  useApprovalStore,
  useInboxStore,
  useTodayCards,
  formatRelativeTime,
  getGreeting,
} from '@rebel/cloud-client';
import { SendIcon } from '../components/icons';
import { TodayCards } from '../components/TodayCards';
import { QuickStartChips } from '../components/QuickStartChips';
import { HandledByRebelCard } from '../components/HandledByRebelCard';
import styles from './HomeScreen.module.css';
import { fireAndForget } from '../utils/fireAndForget';

export function HomeScreen() {
  const navigate = useNavigate();
  const cloudUrl = useAuthStore((s) => s.cloudUrl);
  const { sessions, fetchSessions } = useSessionStore();
  const { toolApprovals, stagedCalls, memoryApprovals, fetchPending } = useApprovalStore();
  const fetchInbox = useInboxStore((s) => s.fetchInbox);
  const { totalCount: todayTotalCount } = useTodayCards();
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    fireAndForget(fetchSessions({ activeOnly: true }), 'HomeScreen:mount:fetchSessions');
    fireAndForget(fetchPending(), 'HomeScreen:mount:fetchPending');
    fireAndForget(fetchInbox(), 'HomeScreen:mount:fetchInbox');
  }, [fetchSessions, fetchPending, fetchInbox]);

  const approvalCount = toolApprovals.length + stagedCalls.length + memoryApprovals.length;
  const pendingCount = approvalCount;
  const todayActionCount = Math.max(todayTotalCount - approvalCount, 0);
  const activeSessions = sessions.filter((s) => s.isBusy);
  const recentSessions = sessions.filter((s) => !s.isBusy).slice(0, 5);

  const handleQuickSend = useCallback(() => {
    if (!prompt.trim()) return;
    const text = prompt.trim();
    setPrompt('');

    const sessionId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    fireAndForget(navigate(`/conversations/${sessionId}?initialPrompt=${encodeURIComponent(text)}`), 'HomeScreen:handleQuickSend:navigate');
  }, [prompt, navigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && prompt.trim()) {
        e.preventDefault();
        handleQuickSend();
      }
    },
    [handleQuickSend, prompt],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>{getGreeting()}</h1>
        {cloudUrl && (
          <p className={styles.connectedTo}>
            Connected to {cloudUrl.replace(/^https?:\/\//, '')}
          </p>
        )}
      </div>

      <TodayCards />

      <QuickStartChips
        approvalCount={approvalCount}
        todayActionCount={todayActionCount}
        hasAnySessions={sessions.length > 0}
      />

      <HandledByRebelCard />

      {/* Quick input */}
      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          data-testid="quick-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Rebel something..."
          rows={1}
          maxLength={5000}
        />
        <button
          className={styles.sendButton}
          data-testid="send-button"
          onClick={handleQuickSend}
          disabled={!prompt.trim()}
          aria-label="Send"
        >
          <SendIcon size={18} />
        </button>
      </div>

      {/* Pending approvals */}
      {pendingCount > 0 && (
        <Link
          to="/approvals"
          className={styles.approvalBanner}
          data-testid="notification-bell"
        >
          <span className={styles.approvalText}>
            {pendingCount} approval{pendingCount !== 1 ? 's' : ''} waiting
          </span>
          <span className={styles.approvalArrow}>›</span>
        </Link>
      )}

      {/* Active sessions */}
      {activeSessions.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Active</h2>
          {activeSessions.map((session) => (
            <div
              key={session.id}
              className={styles.activeRow}
              data-testid={`session-item-${session.id}`}
              onClick={() => navigate(`/conversations/${session.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigate(`/conversations/${session.id}`)}
            >
              <span className={styles.busyDot} />
              <span className={styles.sessionTitle}>
                {session.title || 'Untitled'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Recent conversations */}
      {recentSessions.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Recent</h2>
          {recentSessions.map((session) => (
            <div
              key={session.id}
              className={styles.sessionRow}
              data-testid={`session-item-${session.id}`}
              onClick={() => navigate(`/conversations/${session.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigate(`/conversations/${session.id}`)}
            >
              <div className={styles.sessionRowContent}>
                <span className={styles.sessionTitle}>
                  {session.title || 'Untitled'}
                </span>
                <span className={styles.sessionTime}>
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </div>
              {session.preview && (
                <p className={styles.sessionPreview}>{session.preview}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          No conversations yet. Go on, say something.
        </div>
      )}
    </div>
  );
}
