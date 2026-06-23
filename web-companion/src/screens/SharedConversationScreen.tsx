// web-companion/src/screens/SharedConversationScreen.tsx
// Standalone read-only view for shared conversations — no auth required.
// Supports password-protected shares via unlock endpoint.
// Accepts optional pre-fetched `data` prop from SharedResourceRouter;
// when provided, skips internal fetch and renders directly.

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedSession, unlockSharedSession, CloudClientError, type SharedSession, type SharedMessage } from '@rebel/cloud-client';
import { SafeWebMarkdown } from '../components/SafeWebMarkdown';
import styles from './SharedConversationScreen.module.css';

const REBEL_MARKETING_URL = 'https://www.mindstone.com/rebel';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SharedMessageBubble({ message }: { message: SharedMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`${styles.messageRow} ${isUser ? styles.userRow : styles.assistantRow}`}>
      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.assistantBubble}`}>
        {isUser ? (
          <p className={styles.bubbleText}>{message.text}</p>
        ) : (
          <div className={styles.markdown}>
            <SafeWebMarkdown>{message.text}</SafeWebMarkdown>
          </div>
        )}
      </div>
      <span className={styles.messageTime}>
        {new Date(message.createdAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className={styles.loading}>
      <div className={styles.shimmerLines}>
        <div className={styles.shimmerLine} />
        <div className={styles.shimmerLine} />
        <div className={styles.shimmerLine} />
        <div className={styles.shimmerLine} />
      </div>
    </div>
  );
}

function ErrorView({ statusCode, onRetry }: { statusCode?: number; onRetry: () => void }) {
  const is404 = statusCode === 404;
  const isNetworkError = !statusCode;

  return (
    <div className={styles.error}>
      <h2 className={styles.errorHeading}>
        {is404 ? 'Gone, baby, gone' : 'Well, this is awkward'}
      </h2>
      <p className={styles.errorMessage}>
        {is404
          ? 'This conversation has left the building.'
          : isNetworkError
            ? "Can't reach this conversation right now. Try again in a moment."
            : 'Something went sideways.'}
      </p>
      <a
        href={REBEL_MARKETING_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.errorLink}
      >
        Learn about Rebel
      </a>
      {!is404 && (
        <button className={styles.retryButton} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function PasswordPrompt({ onSubmit, error, submitting }: {
  onSubmit: (password: string) => void;
  error?: string;
  submitting: boolean;
}) {
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length > 0) onSubmit(password);
  };

  return (
    <div className={styles.error}>
      <h2 className={styles.errorHeading}>This conversation is locked</h2>
      <p className={styles.errorMessage}>Enter the password to view it.</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', width: '100%', maxWidth: 320 }}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          maxLength={128}
          className={styles.passwordInput}
          disabled={submitting}
        />
        {error && <p className={styles.passwordError}>{error}</p>}
        <button
          type="submit"
          className={styles.retryButton}
          disabled={password.length === 0 || submitting}
        >
          {submitting ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

interface SharedConversationScreenProps {
  /** Pre-fetched session data from SharedResourceRouter. When provided, skips internal fetch. */
  data?: SharedSession;
}

export function SharedConversationScreen({ data }: SharedConversationScreenProps = {}) {
  const { shareId } = useParams<{ shareId: string }>();
  const [session, setSession] = useState<SharedSession | null>(data ?? null);
  const [loading, setLoading] = useState(!data);
  const [errorCode, setErrorCode] = useState<number | undefined>();
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);

  const fetchData = useCallback(() => {
    if (!shareId || data) return;

    setLoading(true);
    setErrorCode(undefined);
    setNeedsPassword(false);

    fetchSharedSession(window.location.origin, shareId)
      .then((fetched) => {
        setSession(fetched);
        setLoading(false);
      })
      .catch((err) => {
        const code = err instanceof CloudClientError ? err.statusCode : undefined;
        if (code === 401) {
          setNeedsPassword(true);
          setLoading(false);
          return;
        }
        setErrorCode(code ?? 0);
        setLoading(false);
      });
  }, [shareId, data]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleUnlock = useCallback(async (password: string) => {
    if (!shareId) return;
    setUnlocking(true);
    setPasswordError(undefined);
    try {
      const data = await unlockSharedSession(window.location.origin, shareId, password);
      setSession(data);
      setNeedsPassword(false);
    } catch (err) {
      const code = err instanceof CloudClientError ? err.statusCode : undefined;
      if (code === 401) {
        setPasswordError("That's not it. Try again.");
      } else if (code === 429) {
        setPasswordError('Too many attempts. Wait a few minutes.');
      } else {
        setPasswordError('Something went wrong. Try again.');
      }
    }
    setUnlocking(false);
  }, [shareId]);

  // Loading
  if (loading) {
    return (
      <div className={styles.container}>
        <LoadingSkeleton />
      </div>
    );
  }

  // Password required
  if (needsPassword && !session) {
    return (
      <div className={styles.container}>
        <PasswordPrompt onSubmit={handleUnlock} error={passwordError} submitting={unlocking} />
        <footer className={styles.footer}>
          <span className={styles.footerText}>
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
              Powered by Rebel
            </a>
            {' \u00b7 '}
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
              Try Rebel
            </a>
          </span>
        </footer>
      </div>
    );
  }

  // Error
  if (!session) {
    return (
      <div className={styles.container}>
        <ErrorView statusCode={errorCode} onRetry={fetchData} />
        <footer className={styles.footer}>
          <span className={styles.footerText}>
            <a
              href={REBEL_MARKETING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.footerLink}
            >
              Powered by Rebel
            </a>
            {' \u00b7 '}
            <a
              href={REBEL_MARKETING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.footerLink}
            >
              Try Rebel
            </a>
          </span>
        </footer>
      </div>
    );
  }

  // Success
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <span className={styles.title}>{session.title || 'Shared conversation'}</span>
          <span className={styles.sharedLabel}>Shared conversation</span>
        </div>
      </header>

      <div className={styles.messages}>
        <div className={styles.messagesInner}>
          {session.messages.map((msg) => (
            <SharedMessageBubble key={msg.id} message={msg} />
          ))}
          
        </div>
      </div>

      <footer className={styles.footer}>
        <span className={styles.footerText}>
          <a
            href={REBEL_MARKETING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.footerLink}
          >
            Powered by Rebel
          </a>
          {' \u00b7 '}
          <a
            href={REBEL_MARKETING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.footerLink}
          >
            Try Rebel
          </a>
        </span>
      </footer>
    </div>
  );
}
