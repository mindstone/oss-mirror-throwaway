// why-did-you-render - must be imported before React to patch it
// Uses top-level await, only runs in dev mode, tree-shaken in production
import './wdyr';

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { HotkeysProvider } from 'react-hotkeys-hook';
import App from './App';
import './styles/index.css';
import { analytics } from './src/analytics';
import { FlowPanelsProvider } from './features/flow-panels/FlowPanelsProvider';
import { captureRendererException, initRendererSentry, SentryErrorBoundary } from './src/sentry';
import { addToRendererLogBuffer } from './src/rendererLogBuffer';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { ToastProvider } from '@renderer/components/ui';
import { MeetingStatusProvider } from '@renderer/contexts/MeetingStatusContext';
import { usePerformanceMonitor } from '@renderer/hooks/usePerformanceMonitor';
import type { RendererLogPayload } from '@shared/types';

// Detect if this is an API mismatch error (missing function on window.api)
// This happens when the packaged app has an older preload than the renderer expects
const isApiMismatchError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  // Check for "is not a function" errors on any of the known API surfaces
  const isFunctionError = message.includes('is not a function');
  const isUndefinedError = message.includes('Cannot read property') || message.includes('Cannot read properties of undefined');
  const knownApiSurfaces = [
    'window.api',
    'window.settingsApi',
    'window.appApi',
    'window.miscApi',
    'window.authApi',
    'window.agentApi',
    'window.libraryApi',
    'window.voiceApi',
    'window.exportApi',
    'window.permissionsApi',
    'window.sessionsApi',
    'window.inboxApi',
  ];
  const matchesApiSurface = knownApiSurfaces.some(api => message.includes(api));
  return (isFunctionError || isUndefinedError) && matchesApiSurface;
};

// Render function form so we can show details in development and provide recovery actions
const ErrorFallback = ({
  error,
  componentStack,
  resetError
}: {
  error: unknown;
  componentStack: string;
  resetError: () => void;
}) => {
  const apiMismatch = isApiMismatchError(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'error'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  const handleReload = () => {
    try {
      resetError();
    } catch {
      // ignore
    }
    // Full renderer reload to recover quickly without asking the user to restart
    window.location.reload();
  };

  const handleRestart = () => {
    setIsRestarting(true);
    try {
      // Use the emergency API which is fire-and-forget and always available
      // (doesn't rely on generated IPC bridge that might have the mismatch)
      if (typeof (window as unknown as Record<string, unknown>).emergencyApi === 'object' && typeof ((window as unknown as Record<string, Record<string, unknown>>).emergencyApi)?.requestRelaunch === 'function') {
        ((window as unknown as Record<string, Record<string, () => void>>).emergencyApi).requestRelaunch();
      } else if (typeof window.appApi?.relaunch === 'function') {
        // Fallback to normal IPC if emergency API somehow unavailable
        void window.appApi.relaunch();
      } else {
        // Emergency API not available - show manual instruction
        setIsRestarting(false);
        setUpdateError("Couldn't restart automatically — quit and reopen Rebel manually");
        setUpdateStatus('error');
        return;
      }
    } catch {
      // If relaunch fails, show manual instruction
      setIsRestarting(false);
      setUpdateError("Couldn't restart automatically — quit and reopen Rebel manually");
      setUpdateStatus('error');
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateStatus('checking');
    setUpdateError(null);
    try {
      // Use miscApi.checkForUpdates which triggers background download if available
      if (typeof window.miscApi?.checkForUpdates === 'function') {
        const result = await window.miscApi.checkForUpdates();
        if (result.error) {
          setUpdateError(result.error);
          setUpdateStatus('error');
        } else if (result.available) {
          // Update found and downloading (or already downloaded)
          setUpdateStatus('available');
        } else {
          setUpdateError('No updates available. Try restarting anyway.');
          setUpdateStatus('error');
        }
      } else {
        setUpdateError('Update check unavailable. Try restarting.');
        setUpdateStatus('error');
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Failed to check for updates');
      setUpdateStatus('error');
    }
  };

  const handleCopy = async () => {
    try {
      const details = [
        `Error: ${errorMessage}`,
        componentStack ? `Component Stack:\n${componentStack}` : '',
        errorStack ? `Stack:\n${errorStack}` : ''
      ]
        .filter(Boolean)
        .join('\n\n');
      await navigator.clipboard.writeText(details);
    } catch {
      // ignore
    }
  };

  // API mismatch requires a full app restart, not just a renderer reload
  if (apiMismatch) {
    return (
      <div role="alert" style={{ padding: '2rem', color: 'var(--foreground, #e11d48)' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Rebel needs a restart to finish updating</h1>
        <p style={{ marginBottom: '0.5rem' }}>
          A new version was installed but needs a restart to take effect
        </p>
        <p style={{ fontSize: '0.875rem', color: 'var(--muted-foreground, #6b7280)', marginBottom: '0.5rem' }}>
          This takes a few seconds
        </p>
        {isRestarting && (
          <p style={{ fontSize: '0.875rem', color: 'var(--muted-foreground, #6b7280)', marginBottom: '0.5rem' }}>
            Restarting...
          </p>
        )}
        {updateStatus === 'available' && (
          <p style={{ fontSize: '0.875rem', color: 'var(--success, #22c55e)', marginBottom: '0.5rem' }}>
            Update found and downloading. Click "Restart Rebel" to apply once ready.
          </p>
        )}
        {updateStatus === 'error' && updateError && (
          <p style={{ fontSize: '0.875rem', color: 'var(--destructive, #ef4444)', marginBottom: '0.5rem' }}>
            {updateError}
          </p>
        )}
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button 
            onClick={handleRestart} 
            disabled={isRestarting}
            style={{ padding: '0.5rem 0.75rem', opacity: isRestarting ? 0.6 : 1 }}
          >
            {isRestarting ? 'Restarting...' : 'Restart Rebel'}
          </button>
          <button 
            onClick={handleCheckForUpdates} 
            disabled={updateStatus === 'checking' || isRestarting}
            style={{ padding: '0.5rem 0.75rem', opacity: (updateStatus === 'checking' || isRestarting) ? 0.6 : 1 }}
          >
            {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
          {import.meta.env.DEV ? (
            <button onClick={handleCopy} style={{ padding: '0.5rem 0.75rem' }}>Copy error details</button>
          ) : null}
        </div>
        <p style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--muted-foreground, #6b7280)' }}>
          If none of that works, quit Rebel manually (Cmd+Q or Alt+F4) and reopen it
        </p>
        {import.meta.env.DEV ? (
          <pre
            style={{
              marginTop: '1rem',
              whiteSpace: 'pre-wrap',
              color: 'var(--foreground, #111827)',
              background: 'rgba(0,0,0,0.05)',
              padding: '0.75rem',
              borderRadius: 6
            }}
          >
{`Error: ${errorMessage}\n\n${componentStack || errorStack || ''}`}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div role="alert" style={{ padding: '2rem', color: 'var(--foreground, #e11d48)' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Well, that wasn't supposed to happen</h1>
      <p>Rebel hit an unexpected error — a reload should sort it out. If this keeps happening, let the team know when it started</p>
      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
        <button onClick={handleReload} style={{ padding: '0.5rem 0.75rem' }}>Reload Rebel</button>
        {import.meta.env.DEV ? (
          <button onClick={handleCopy} style={{ padding: '0.5rem 0.75rem' }}>Copy error details</button>
        ) : null}
      </div>
      {import.meta.env.DEV ? (
        <pre
          style={{
            marginTop: '1rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--foreground, #111827)',
            background: 'rgba(0,0,0,0.05)',
            padding: '0.75rem',
            borderRadius: 6
          }}
        >
{`Error: ${errorMessage}\n\n${componentStack || errorStack || ''}`}
        </pre>
      ) : null}
    </div>
  );
};

initRendererSentry();
analytics.init();
analytics.track('Renderer Boot', {
  path: window.location?.pathname ?? '/',
  hash: window.location?.hash ?? ''
});

// Set data-beta attribute on body for beta-specific styling
// Uses buildChannel from preload, with VITE_BETA_MODE override for dev
const buildChannel = (window as unknown as Record<string, Record<string, unknown>>).electronEnv?.buildChannel;
const isBetaApp = buildChannel === 'beta' || import.meta.env.VITE_BETA_MODE === 'true';
if (isBetaApp) {
  document.body.setAttribute('data-beta', 'true');
}

// Prod-mode emit helper — mirrors App.tsx's `emitLog`, but runs above
// AppContext (which is defined inside <App />) so it speaks directly to
// `window.api.logEvent`. The preload bridge tags `source: 'renderer'`
// downstream.
const rendererPerfEmitLog = (payload: RendererLogPayload): void => {
  try {
    window.api.logEvent(payload);
  } catch {
    // The log bridge must never crash the renderer from a perf emission.
  }
  // Stage 4 (Class B): mirror into the renderer-local ring so these pre-AppContext
  // perf logs are also attachable on a renderer capture. Best-effort.
  try {
    addToRendererLogBuffer({
      timestamp: payload.timestamp ?? Date.now(),
      level: payload.level,
      message: payload.message,
      context: payload.context,
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'rendererPerfEmitLog.addToRendererLogBuffer',
      reason: 'Renderer log-ring population is best-effort observability; it must never crash the renderer',
    });
  }
};

function PerformanceMonitor({ children }: { children: React.ReactNode }) {
  const prodPerfEnabled =
    typeof window !== 'undefined' &&
    (window.electronEnv?.runtimeConfig as { prodPerfMonitor?: boolean } | null)
      ?.prodPerfMonitor === true;
  const perfMode: 'dev' | 'prod' | 'off' = import.meta.env.DEV
    ? 'dev'
    : prodPerfEnabled
      ? 'prod'
      : 'off';
  usePerformanceMonitor({ mode: perfMode, emitLog: rendererPerfEmitLog });
  return <>{children}</>;
}

// StrictMode doubles all renders and contaminates heap snapshots.
// Opt-in via VITE_REACT_STRICT_MODE (npm run dev:strict) — decoupled from
// VITE_PERFORMANCE so that dev:perf is snapshot-safe. See docs/project/APP_PERFORMANCE_AND_MEMORY.md.
const isStrictMode = import.meta.env.DEV && import.meta.env.VITE_REACT_STRICT_MODE === 'true';
const AppTree = (
  <SentryErrorBoundary fallback={ErrorFallback}>
    <HotkeysProvider initiallyActiveScopes={['*']}>
      <ToastProvider>
        <MeetingStatusProvider>
          <FlowPanelsProvider>
            <PerformanceMonitor>
              <App />
            </PerformanceMonitor>
          </FlowPanelsProvider>
        </MeetingStatusProvider>
      </ToastProvider>
    </HotkeysProvider>
  </SentryErrorBoundary>
);

// C2 (Class A): the SentryErrorBoundary only catches render-phase errors AFTER
// React mounts. A synchronous throw during createRoot()/the initial render call
// (e.g. a missing #root node, or a module-eval throw in a provider's
// constructor) leaves the renderer blank with NOTHING captured — exactly the
// "app launched but the UI is dead" class. Wrap the mount so that failure is
// visible to Sentry. captureRendererException is a no-op until initRendererSentry
// (called above) succeeds; this does not duplicate the already-installed global
// window.onerror / unhandledrejection handlers (a synchronous throw here is not
// an unhandled rejection, and rethrowing would only reach window.onerror with a
// less specific tag set).
try {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    isStrictMode ? <React.StrictMode>{AppTree}</React.StrictMode> : AppTree
  );
} catch (mountError) {
  captureRendererException(mountError, {
    tags: { area: 'renderer', component: 'mount' },
  });
  // Re-throw so the failure is not silently swallowed — the renderer is
  // unusable either way, and the global handler / dev console still see it.
  throw mountError;
}

// Hide the initial pre-React loading shell once React has mounted
const loadingEl = document.getElementById('app-loading');
if (loadingEl) {
  loadingEl.classList.add('hidden');
  loadingEl.setAttribute('aria-hidden', 'true');
}
