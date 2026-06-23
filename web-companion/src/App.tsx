// web-companion/src/App.tsx

import { Component, useEffect, useState, useCallback, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore, onUnauthorized, fetchSharedResource, unlockSharedResource, getSharedFileDownloadUrl, CloudClientError, type SharedResource, type SharedFile } from '@rebel/cloud-client';
import { AuthScreen } from './screens/AuthScreen';
import { SharedConversationScreen } from './screens/SharedConversationScreen';
import { SharedFileScreen } from './screens/SharedFileScreen';
import { Layout } from './components/Layout';
import { EventBridge } from './components/EventBridge';
import { HomeScreen } from './screens/HomeScreen';
import { ConversationsScreen } from './screens/ConversationsScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { ApprovalsScreen } from './screens/ApprovalsScreen';
import { InboxScreen } from './screens/InboxScreen';
import { HelpScreen } from './screens/HelpScreen';
import { fireAndForget } from './utils/fireAndForget';

function parseTokenFromFragment(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  return params.get('token');
}

function clearFragment(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', maxWidth: 500, margin: '4rem auto', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '0.5rem' }}>Something broke.</h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{
              padding: '0.5rem 1rem', background: 'var(--color-accent)', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// SharedResourceRouter — fetches once, discriminates on resourceType, delegates
// ---------------------------------------------------------------------------

const REBEL_MARKETING_URL = 'https://www.mindstone.com/rebel';

function isSharedFile(resource: SharedResource): resource is SharedFile {
  return 'resourceType' in resource && resource.resourceType === 'file';
}

function SharedResourceRouter() {
  const { shareId } = useParams<{ shareId: string }>();
  const [resource, setResource] = useState<SharedResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<number | undefined>();
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);

  const fetchData = useCallback(() => {
    if (!shareId) return;

    setLoading(true);
    setErrorCode(undefined);
    setNeedsPassword(false);

    fetchSharedResource(window.location.origin, shareId)
      .then((data) => {
        setResource(data);
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
  }, [shareId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleUnlock = useCallback(async (password: string) => {
    if (!shareId) return;
    setUnlocking(true);
    setPasswordError(undefined);
    try {
      const data = await unlockSharedResource(window.location.origin, shareId, password);
      setResource(data);
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--color-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 'var(--space-md)' }}>
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  // Password required
  if (needsPassword && !resource) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--color-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 'var(--space-xl)', textAlign: 'center', gap: 'var(--space-md)' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
            This content is locked
          </h2>
          <p style={{ fontSize: '0.9375rem', color: 'var(--color-text-secondary)', maxWidth: 400, lineHeight: 1.5 }}>
            Enter the password to view it.
          </p>
          <form
            onSubmit={(e) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem('password') as HTMLInputElement; if (input.value.length > 0) fireAndForget(handleUnlock(input.value), 'App:handleUnlock'); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', width: '100%', maxWidth: 320 }}
          >
            <input
              name="password"
              type="password"
              placeholder="Password"
              autoFocus
              maxLength={128}
              disabled={unlocking}
              style={{
                width: '100%', padding: '10px 14px', fontSize: 14,
                border: '1px solid var(--color-border)', borderRadius: 8,
                background: 'var(--color-bg)', color: 'var(--color-text-primary)',
                outline: 'none',
              }}
            />
            {passwordError && (
              <p style={{ color: 'var(--color-error)', fontSize: 13, margin: 0, textAlign: 'center' }}>
                {passwordError}
              </p>
            )}
            <button
              type="submit"
              disabled={unlocking}
              style={{
                background: 'var(--color-accent)', color: '#fff', border: 'none',
                borderRadius: 'var(--radius-sm)', padding: '10px 20px',
                fontSize: '0.9375rem', fontWeight: 600, fontFamily: 'var(--font-sans)',
                cursor: unlocking ? 'not-allowed' : 'pointer',
                opacity: unlocking ? 0.6 : 1,
              }}
            >
              {unlocking ? 'Unlocking...' : 'Unlock'}
            </button>
          </form>
        </div>
        <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-md) var(--space-lg)', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-elevated)', flexShrink: 0 }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', letterSpacing: '0.02em' }}>
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 500 }}>
              Powered by Rebel
            </a>
            {' \u00b7 '}
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 500 }}>
              Try Rebel
            </a>
          </span>
        </footer>
      </div>
    );
  }

  // Error
  if (!resource) {
    const is404 = errorCode === 404;
    const isNetworkError = !errorCode;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--color-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 'var(--space-xl)', textAlign: 'center', gap: 'var(--space-md)' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {is404 ? 'Gone, baby, gone' : 'Well, this is awkward'}
          </h2>
          <p style={{ fontSize: '0.9375rem', color: 'var(--color-text-secondary)', maxWidth: 400, lineHeight: 1.5 }}>
            {is404
              ? 'This content has left the building.'
              : isNetworkError
                ? "Can't reach this content right now. Try again in a moment."
                : 'Something went sideways.'}
          </p>
          <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.875rem', color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 500 }}>
            Learn about Rebel
          </a>
          {!is404 && (
            <button
              onClick={fetchData}
              style={{
                background: 'var(--color-accent)', color: '#fff', border: 'none',
                borderRadius: 'var(--radius-sm)', padding: '10px 20px',
                fontSize: '0.9375rem', fontWeight: 600, fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          )}
        </div>
        <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-md) var(--space-lg)', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-elevated)', flexShrink: 0 }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', letterSpacing: '0.02em' }}>
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 500 }}>
              Powered by Rebel
            </a>
            {' \u00b7 '}
            <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 500 }}>
              Try Rebel
            </a>
          </span>
        </footer>
      </div>
    );
  }

  // Discriminate on resourceType — missing defaults to conversation (backward compat)
  if (isSharedFile(resource)) {
    const file = resource;
    // Use HMAC-signed downloadUrl from unlock response if present; otherwise build unsigned URL
    // `shareId` is defined here because the resource fetch/unlock effects
    // bail early when it's missing; if it's still unset, that's a routing
    // bug worth crashing on rather than silently building a broken URL.
    if (!shareId) {
      throw new Error('SharedResourceRouter: shareId missing when rendering resolved resource');
    }
    const downloadUrl = file.downloadUrl ?? getSharedFileDownloadUrl(window.location.origin, shareId);
    return <SharedFileScreen file={file} downloadUrl={downloadUrl} />;
  }

  // Conversation (default)
  return <SharedConversationScreen data={resource} />;
}

/** Authenticated portion of the app — requires pairing, wires EventBridge + Layout. */
function AuthenticatedApp() {
  const isPaired = useAuthStore((s) => s.isPaired);

  if (!isPaired) {
    return <AuthScreen />;
  }

  return (
    <>
      <EventBridge />
      <Layout>
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/inbox" element={<InboxScreen />} />
          <Route path="/conversations" element={<ConversationsScreen />} />
          <Route path="/conversations/:id" element={<ConversationScreen />} />
          <Route path="/approvals" element={<ApprovalsScreen />} />
          <Route path="/help" element={<HelpScreen />} />
          <Route path="/settings" element={<Navigate to="/help" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </>
  );
}

export function App() {
  const [ready, setReady] = useState(false);

  // Check for fragment token before useEffect clears it
  const hasFragmentToken = window.location.hash.includes('token=');

  // Mount-once init effect. Reads credentials + optional fragment token and
  // pairs exactly once per mount. Uses `useAuthStore.getState()` directly so
  // the effect closes over the store's stable action identities rather than
  // the hook-selected references (which would otherwise require an
  // exhaustive-deps suppression). Semantics are identical — this store is
  // a singleton and the getState() snapshot inside an async init is
  // intentional.
  useEffect(() => {
    let cancelled = false;
    onUnauthorized(() => {
      fireAndForget(useAuthStore.getState().unpair(), 'App:onUnauthorized:unpair');
    });

    async function init() {
      await useAuthStore.getState().loadCredentials();

      // Only auto-pair from fragment if not already paired from stored credentials
      const fragmentToken = parseTokenFromFragment();
      if (fragmentToken) {
        clearFragment();

        if (!cancelled && !useAuthStore.getState().isPaired) {
          await useAuthStore.getState().pair(window.location.origin, fragmentToken);
        }
      }

      if (!cancelled) setReady(true);
    }

    fireAndForget(init(), 'App:mount:init');
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p style={{ marginTop: '1rem', color: 'var(--color-text-secondary)' }}>
          {hasFragmentToken ? 'Pairing with Rebel...' : 'Reconnecting...'}
        </p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <BrowserRouter basename="/app">
        <Routes>
          <Route path="/shared/:shareId" element={<SharedResourceRouter />} />
          <Route path="*" element={<AuthenticatedApp />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
