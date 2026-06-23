import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  readAuthSnapshot,
  type InstallStatus,
} from '../lib/browserAuth';
import {
  CARD_COPY,
  PermissionGrantCard,
} from '../permissions/PermissionGrantCard';
import { computeMatchPattern, displayOriginForUser } from '../permissions/originMatch';
import {
  clearPendingForOrigin,
  getPending,
  LAST_REVOKED_STORAGE_KEY,
  onChange as onPendingChange,
  type PendingPermissionEntry,
  type PendingPermissionsState,
} from '../permissions/permissionState';
import QuickActions from './QuickActions';

function pillText(status: InstallStatus): string {
  switch (status.kind) {
    case 'boot-token-missing':
      return 'Install from Rebel';
    case 'mint-failed-transient':
    case 'mint-rate-limited':
    case 'connecting':
    case 'registering':
    case 'port-stale':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return `Reconnecting (attempt ${status.attempt})…`;
    case 'mint-forbidden':
    case 'revoked-by-user':
      return 'Re-install required';
    case 'idle':
    default:
      return 'Checking…';
  }
}

function pillKind(status: InstallStatus): string {
  if (status.kind === 'connected') return 'connected';
  if (
    status.kind === 'reconnecting' ||
    status.kind === 'connecting' ||
    status.kind === 'registering' ||
    status.kind === 'mint-failed-transient' ||
    status.kind === 'mint-rate-limited' ||
    status.kind === 'port-stale'
  ) {
    return 'reconnecting';
  }
  if (status.kind === 'mint-forbidden' || status.kind === 'revoked-by-user') {
    return 'error';
  }
  return 'default';
}

function bodyCopy(status: InstallStatus): { title: string; body: string } {
  switch (status.kind) {
    case 'boot-token-missing':
      return {
        title: 'Install from Rebel',
        body: 'Open Rebel, start the browser install there, then drag the extracted folder into your browser. The extension will connect on its own.',
      };
    case 'mint-forbidden':
    case 'revoked-by-user':
      return {
        title: 'Re-install required',
        body: 'This browser install was reset or went stale. Open Rebel and run the browser install again to reconnect.',
      };
    case 'connected':
      return {
        title: 'Ready',
        body: 'Rebel Browser is connected. You can open chat here, or use the quick actions below.',
      };
    case 'reconnecting':
    case 'mint-failed-transient':
    case 'mint-rate-limited':
    case 'port-stale':
    case 'connecting':
    case 'registering':
      return {
        title: 'Connecting',
        body: 'The extension is talking to Rebel. This usually takes a moment. If it stalls, open Rebel and retry the install.',
      };
    case 'idle':
    default:
      return {
        title: 'Waiting for Rebel',
        body: 'Open Rebel and start the browser install from the app. This popup will update once the extension can connect.',
      };
  }
}

/**
 * Success toasts after a successful grant are shown for a short duration
 * then fade. Kept at 3.5s so the user has time to read it without it
 * feeling sticky.
 */
const SUCCESS_TOAST_MS = 3_500;

/**
 * Resolve the current active tab's canonical origin (for active-tab-first
 * ordering of the pending stack). Returns `null` for unsupported schemes —
 * we never surface chrome:// / file:// entries in the "active origin" slot.
 */
async function resolveActiveOrigin(): Promise<string | null> {
  const tabs = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => [] as chrome.tabs.Tab[]);
  const active = tabs[0];
  if (!active || typeof active.url !== 'string' || active.url.length === 0) {
    return null;
  }
  const match = computeMatchPattern(active.url);
  if (!match.ok) return null;
  return match.origin;
}

/**
 * Order pending entries with the active-tab's origin first, then others by
 * `lastRequestedAt` descending. Non-destructive — returns a new array.
 */
function orderPendingEntries(
  state: PendingPermissionsState,
  activeOrigin: string | null,
): PendingPermissionEntry[] {
  const entries = Object.values(state);
  return entries.sort((a, b) => {
    if (activeOrigin) {
      const aActive = a.origin === activeOrigin;
      const bActive = b.origin === activeOrigin;
      if (aActive && !bActive) return -1;
      if (bActive && !aActive) return 1;
    }
    return b.lastRequestedAt - a.lastRequestedAt;
  });
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

interface LastRevokedMarker {
  origin: string;
  at: number;
}

export function Popup(): ReactElement {
  const [status, setStatus] = useState<InstallStatus>({ kind: 'idle' });
  const [clientId, setClientId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pendingState, setPendingState] = useState<PendingPermissionsState>({});
  const [activeOrigin, setActiveOrigin] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [revokedToast, setRevokedToast] = useState<string | null>(null);

  const refreshAuth = useCallback(async (): Promise<void> => {
    const auth = await readAuthSnapshot();
    setClientId(auth.clientId);
    setToken(auth.token);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const result = await chrome.runtime
      .sendMessage({ target: 'service-worker', type: 'get-install-state' })
      .catch(() => null) as { status?: InstallStatus } | null;
    if (result?.status) {
      setStatus(result.status);
    }
  }, []);

  useEffect(() => {
    chrome.action.setBadgeText({ text: '' }).catch(() => {
      // badge clear is best-effort
    });

    void refreshStatus();
    void refreshAuth();
    void resolveActiveOrigin().then((origin) => {
      setActiveOrigin(origin);
    });
    void getPending().then((initial) => setPendingState(initial));

    const listener = (msg: unknown): void => {
      if (!msg || typeof msg !== 'object') return;
      const envelope = msg as {
        target?: string;
        type?: string;
        status?: InstallStatus;
      };
      if (envelope.target === 'popup' && envelope.type === 'connection-status' && envelope.status) {
        setStatus(envelope.status);
        void refreshAuth();
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return (): void => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refreshAuth, refreshStatus]);

  // Subscribe to pending-permissions changes (finding P — chrome.storage.onChanged
  // is the single notification channel).
  useEffect(() => {
    const unsub = onPendingChange((next) => setPendingState(next));
    return (): void => {
      unsub();
    };
  }, []);

  // Revoked-externally toast — driven by `rebel.last-revoked.v1` written by
  // the service worker when `chrome.permissions.onRemoved` fires.
  useEffect(() => {
    const session = chrome.storage?.session;
    const onChanged = chrome.storage?.onChanged;
    if (!session || !onChanged) return;

    void session
      .get(LAST_REVOKED_STORAGE_KEY)
      .then((record: Record<string, unknown>) => {
        const marker = record[LAST_REVOKED_STORAGE_KEY] as
          | LastRevokedMarker
          | undefined;
        if (marker && typeof marker.origin === 'string') {
          setRevokedToast(
            CARD_COPY.revokedToast(displayOriginForUser(marker.origin)),
          );
          // Clear it so reopening the popup doesn't show stale toasts.
          void session.remove(LAST_REVOKED_STORAGE_KEY).catch(() => undefined);
        }
      })
      .catch(() => undefined);

    const listener = (
      changes: Record<string, StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'session') return;
      const change = changes[LAST_REVOKED_STORAGE_KEY];
      if (!change || !change.newValue) return;
      const marker = change.newValue as LastRevokedMarker;
      if (typeof marker.origin !== 'string') return;
      setRevokedToast(
        CARD_COPY.revokedToast(displayOriginForUser(marker.origin)),
      );
      void session.remove(LAST_REVOKED_STORAGE_KEY).catch(() => undefined);
    };
    onChanged.addListener(listener);
    return (): void => {
      onChanged.removeListener(listener);
    };
  }, []);

  // Auto-dismiss the success toast after a short delay.
  useEffect(() => {
    if (!successToast) return;
    const handle = setTimeout(() => setSuccessToast(null), SUCCESS_TOAST_MS);
    return (): void => clearTimeout(handle);
  }, [successToast]);

  // Auto-dismiss the revoked toast too — no stale badging.
  useEffect(() => {
    if (!revokedToast) return;
    const handle = setTimeout(() => setRevokedToast(null), SUCCESS_TOAST_MS);
    return (): void => clearTimeout(handle);
  }, [revokedToast]);

  const handleAllow = useCallback(async (origin: string): Promise<void> => {
    await clearPendingForOrigin(origin);
    // Inform the SW so it can log a grant breadcrumb + catch anything that
    // storage events alone would miss. Best-effort — silent on failure.
    chrome.runtime
      .sendMessage({
        target: 'service-worker',
        type: 'permission-granted',
        origin,
      })
      .catch(() => undefined);
    setSuccessToast(CARD_COPY.successToast);
  }, []);

  const handleDismiss = useCallback(
    (origin: string) => (): void => {
      void clearPendingForOrigin(origin);
    },
    [],
  );

  const orderedEntries = useMemo(
    () => orderPendingEntries(pendingState, activeOrigin),
    [pendingState, activeOrigin],
  );

  const handleReconnect = useCallback(async (): Promise<void> => {
    setNotice('Retrying the connection…');
    await chrome.runtime
      .sendMessage({ target: 'service-worker', type: 'reconnect-auth' })
      .catch(() => undefined);
  }, []);

  const handleOpenSidePanel = useCallback(async (): Promise<void> => {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentWindow = await chrome.windows.getCurrent();
      const windowId =
        typeof activeTab?.windowId === 'number' ? activeTab.windowId : currentWindow.id;
      if (typeof windowId !== 'number') return;
      await chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'open-side-panel',
        ...(typeof activeTab?.id === 'number' ? { tabId: activeTab.id } : {}),
        windowId,
      });
      window.close();
    } catch {
      // Best-effort only.
    }
  }, []);

  const copy = bodyCopy(status);

  return (
    <div className="popup">
      <div className="popup-header">
        <span className="popup-title">Rebel</span>
        <span className="status-pill" data-kind={pillKind(status)}>
          <span className="status-dot" />
          {pillText(status)}
        </span>
      </div>

      {orderedEntries.length > 0 && (
        <div className="permission-stack" data-testid="permission-stack">
          {orderedEntries.map((entry) => (
            <PermissionGrantCard
              key={entry.origin}
              entry={entry}
              onAllow={handleAllow}
              onDismiss={handleDismiss(entry.origin)}
              surface="popup"
            />
          ))}
        </div>
      )}

      {successToast && (
        <div
          className="permission-toast"
          role="status"
          data-testid="permission-success-toast"
        >
          {successToast}
        </div>
      )}

      {revokedToast && (
        <div
          className="permission-toast"
          role="status"
          data-kind="revoked"
          data-testid="permission-revoked-toast"
        >
          {revokedToast}
        </div>
      )}

      {status.kind === 'connected' && (
        <button
          type="button"
          className="btn chat-cta"
          onClick={handleOpenSidePanel}
          data-testid="open-chat-button"
        >
          <span className="chat-cta-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          Chat with Rebel
        </button>
      )}

      <div className="section" data-testid="install-status-card">
        <span className="section-label">{copy.title}</span>
        <span className="muted">{copy.body}</span>
        {status.kind !== 'connected' && (
          <div className="button-row">
            <button className="btn" type="button" onClick={handleReconnect}>
              Retry connection
            </button>
          </div>
        )}
      </div>

      <QuickActions
        visible={status.kind === 'connected'}
        clientId={clientId}
        token={token}
      />

      {notice && <div className="message info">{notice}</div>}
    </div>
  );
}

const mount = document.getElementById('root');
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
