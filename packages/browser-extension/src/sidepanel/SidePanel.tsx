import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildConversationNotice,
  resolveHeaderStatus,
  type ConversationNoticeViewModel,
  type SharedConnectionHealth,
} from '@rebel/shared/chatUI';
import { useSidePanelChatController } from '../hooks/useSidePanelChatController';
import ChatHeader from './components/ChatHeader';
import Composer from './components/Composer';
import ContextChip from './components/ContextChip';
import EmptyState from './components/EmptyState';
import MessageList from './components/MessageList';
import {
  CARD_COPY,
  PermissionGrantCard,
} from '../permissions/PermissionGrantCard';
import {
  computeMatchPattern,
  displayOriginForUser,
} from '../permissions/originMatch';
import {
  clearPendingForOrigin,
  getPending,
  LAST_REVOKED_STORAGE_KEY,
  onChange as onPendingChange,
  type PendingPermissionEntry,
  type PendingPermissionsState,
} from '../permissions/permissionState';
import { type InstallStatus } from '../lib/browserAuth';

function disconnectedCopy(status: InstallStatus): { title: string; body: string } {
  switch (status.kind) {
    case 'connected':
      return {
        title: 'Connected',
        body: 'Rebel Browser is connected. Open chat here to keep going.',
      };
    case 'mint-forbidden':
    case 'revoked-by-user':
      return {
        title: 'Re-install required',
        body: 'This browser install was reset or went stale. Open Rebel and run the browser install again to reconnect.',
      };
    case 'boot-token-missing':
      return {
        title: 'Install from Rebel',
        body: 'Open Rebel and start the browser install there. Once the extension is loaded, this panel wakes up and we can talk.',
      };
    case 'connecting':
    case 'registering':
    case 'reconnecting':
    case 'mint-failed-transient':
    case 'mint-rate-limited':
    case 'port-stale':
      return {
        title: 'Connecting',
        body: 'The extension is trying to reach Rebel now. Give it a moment, or rerun the install from Rebel if it stays stuck.',
      };
    case 'idle':
    default:
      return {
        title: 'Install Rebel Browser to start chatting',
        body: 'Open Rebel and start the browser install from the app. This panel updates once the extension can connect.',
      };
  }
}

/** Permission toast TTL — see popup.tsx, same value for consistency. */
const SUCCESS_TOAST_MS = 3_500;

interface LastRevokedMarker {
  origin: string;
  at: number;
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

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

function conversationHealthForPhase(
  phase: 'hydrating' | 'idle' | 'sending' | 'streaming' | 'reconnecting' | 'offline' | 'revoked',
): SharedConnectionHealth {
  switch (phase) {
    case 'reconnecting':
      return 'reconnecting';
    case 'offline':
    case 'revoked':
      return 'degraded';
    default:
      return 'healthy';
  }
}

function messageForConversationNotice(notice: ConversationNoticeViewModel): string {
  switch (notice.kind) {
    case 'offline':
      return "Rebel isn't running right now. Open the app and I'll reconnect.";
    case 'reconnecting':
      return 'Reconnecting to Rebel now.';
    case 'revoked':
      return notice.message ?? 'Your connection to Rebel was reset. Open Rebel and run the browser install again.';
    case 'error':
      return notice.message ?? 'Rebel hit a snag. Try again in a moment.';
  }
}

export function SidePanel(): ReactElement {
  const {
    pairingLoaded,
    installStatus,
    paired,
    snapshot,
    streamingText,
    scopeKey,
    scopeContext,
    composerMountKey,
    send,
    startFresh,
    retrySend,
    openInRebel,
  } = useSidePanelChatController();

  const [pendingState, setPendingState] = useState<PendingPermissionsState>({});
  const [activeOrigin, setActiveOrigin] = useState<string | null>(null);
  const [permissionSuccessToast, setPermissionSuccessToast] = useState<string | null>(null);
  const [permissionRevokedToast, setPermissionRevokedToast] = useState<string | null>(null);

  useEffect(() => {
    void resolveActiveOrigin().then(setActiveOrigin);
    void getPending().then(setPendingState);

    const unsub = onPendingChange((next) => setPendingState(next));
    return (): void => {
      unsub();
    };
  }, []);

  useEffect(() => {
    const session = chrome.storage?.session;
    const onChanged = chrome.storage?.onChanged;
    if (!session || !onChanged) return;

    void session
      .get(LAST_REVOKED_STORAGE_KEY)
      .then((record: Record<string, unknown>) => {
        const marker = record[LAST_REVOKED_STORAGE_KEY] as LastRevokedMarker | undefined;
        if (marker && typeof marker.origin === 'string') {
          setPermissionRevokedToast(CARD_COPY.revokedToast(displayOriginForUser(marker.origin)));
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
      setPermissionRevokedToast(CARD_COPY.revokedToast(displayOriginForUser(marker.origin)));
      void session.remove(LAST_REVOKED_STORAGE_KEY).catch(() => undefined);
    };
    onChanged.addListener(listener);
    return (): void => {
      onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (!permissionSuccessToast) return;
    const handle = setTimeout(() => setPermissionSuccessToast(null), SUCCESS_TOAST_MS);
    return (): void => clearTimeout(handle);
  }, [permissionSuccessToast]);

  useEffect(() => {
    if (!permissionRevokedToast) return;
    const handle = setTimeout(() => setPermissionRevokedToast(null), SUCCESS_TOAST_MS);
    return (): void => clearTimeout(handle);
  }, [permissionRevokedToast]);

  const handlePermissionAllow = useCallback(async (origin: string): Promise<void> => {
    await clearPendingForOrigin(origin);
    chrome.runtime
      .sendMessage({
        target: 'service-worker',
        type: 'permission-granted',
        origin,
      })
      .catch(() => undefined);
    setPermissionSuccessToast(CARD_COPY.successToast);
  }, []);

  const handlePermissionDismiss = useCallback(
    (origin: string) => (): void => {
      void clearPendingForOrigin(origin);
    },
    [],
  );

  const orderedPendingEntries = useMemo(
    () => orderPendingEntries(pendingState, activeOrigin),
    [pendingState, activeOrigin],
  );

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (!snapshot.conversationId) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      if (ev.key !== 'n' && ev.key !== 'N') return;
      ev.preventDefault();
      void startFresh();
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [snapshot.conversationId, startFresh]);

  const disconnectedState = disconnectedCopy(installStatus);
  const hasConversation = Boolean(snapshot.conversationId);
  const headerStatus = resolveHeaderStatus({
    surfaceReady: paired,
    connectionHealth: conversationHealthForPhase(snapshot.phase),
  });
  const conversationNotice = buildConversationNotice({
    phase: snapshot.phase,
    ...(snapshot.error?.message ? { errorMessage: snapshot.error.message } : {}),
  });
  const statusBannerNotice =
    conversationNotice &&
    (conversationNotice.kind === 'offline' || conversationNotice.kind === 'reconnecting')
      ? conversationNotice
      : null;
  const detailBannerNotice =
    conversationNotice &&
    (conversationNotice.kind === 'revoked' ||
      conversationNotice.kind === 'error' ||
      (conversationNotice.kind === 'offline' && Boolean(conversationNotice.message)))
      ? conversationNotice
      : null;
  const showEmptyState = paired && !hasConversation && snapshot.messages.length === 0;
  const composerDisabled =
    !paired ||
    snapshot.phase === 'hydrating' ||
    snapshot.phase === 'sending' ||
    snapshot.phase === 'streaming' ||
    snapshot.phase === 'reconnecting' ||
    snapshot.phase === 'offline' ||
    snapshot.phase === 'revoked' ||
    snapshot.creatingConversation;
  const placeholder = !paired
    ? 'Install Rebel Browser to start chatting'
    : snapshot.phase === 'offline'
      ? "Rebel is offline — I'll reconnect when it's back"
      : hasConversation
        ? 'Message Rebel…'
        : 'Ask about this page…';

  if (!pairingLoaded) {
    return <div className="sidepanel" data-testid="sidepanel" aria-busy="true" />;
  }

  return (
    <div className="sidepanel" data-testid="sidepanel">
      <ChatHeader
        status={headerStatus}
        hasConversation={hasConversation}
        {...(hasConversation ? { onOpenInRebel: () => void openInRebel() } : {})}
        {...(hasConversation ? { onStartFresh: () => void startFresh() } : {})}
      />
      {statusBannerNotice && (
        <div
          className="offline-banner"
          role="status"
          data-testid="offline-banner"
          data-kind={statusBannerNotice.kind}
        >
          <span className="offline-banner-dot" aria-hidden="true" />
          <span className="offline-banner-text">
            {messageForConversationNotice(statusBannerNotice)}
          </span>
        </div>
      )}
      {orderedPendingEntries.length > 0 && (
        <div className="permission-stack" data-testid="permission-stack">
          <p className="permission-stack-title">{CARD_COPY.sidepanelBannerTitle}</p>
          {orderedPendingEntries.map((entry) => (
            <PermissionGrantCard
              key={entry.origin}
              entry={entry}
              onAllow={handlePermissionAllow}
              onDismiss={handlePermissionDismiss(entry.origin)}
              surface="sidepanel"
            />
          ))}
        </div>
      )}
      {permissionSuccessToast && (
        <div className="permission-toast" role="status" data-testid="permission-success-toast">
          {permissionSuccessToast}
        </div>
      )}
      {permissionRevokedToast && (
        <div
          className="permission-toast"
          role="status"
          data-kind="revoked"
          data-testid="permission-revoked-toast"
        >
          {permissionRevokedToast}
        </div>
      )}
      <div
        className={`sidepanel-body${showEmptyState ? ' is-empty' : ''}`}
        data-testid="sidepanel-body"
        data-state={!paired ? 'not-paired' : hasConversation ? 'paired-chatting' : 'paired-idle'}
      >
        {!paired && (
          <div className="not-paired" data-testid="not-paired">
            <h1 className="not-paired-title">{disconnectedState.title}</h1>
            <p className="not-paired-body">{disconnectedState.body}</p>
          </div>
        )}
        {paired && showEmptyState && (
          <EmptyState
            key={scopeKey ?? 'no-scope'}
            context={
              scopeContext
                ? {
                  ...(scopeContext.title ? { title: scopeContext.title } : {}),
                  ...(scopeContext.url ? { url: scopeContext.url } : {}),
                }
                : null
            }
          />
        )}
        {paired && hasConversation && (
          <div className="conversation">
            {(snapshot.conversationContext.pageTitle || snapshot.conversationContext.pageUrl) && (
              <ContextChip
                {...(snapshot.conversationContext.pageTitle
                  ? { pageTitle: snapshot.conversationContext.pageTitle }
                  : {})}
                {...(snapshot.conversationContext.pageUrl
                  ? { pageUrl: snapshot.conversationContext.pageUrl }
                  : {})}
              />
            )}
            <MessageList
              messages={snapshot.messages}
              streamingText={streamingText}
              turnStatus={snapshot.turnStatus}
            />
          </div>
        )}
        {detailBannerNotice && (
          <div
            className="error-banner"
            role="alert"
            data-testid="error-banner"
            data-kind={detailBannerNotice.kind}
          >
            <span className="error-banner-text">
              {detailBannerNotice.message ?? messageForConversationNotice(detailBannerNotice)}
            </span>
            {snapshot.retryableSend &&
              (detailBannerNotice.kind === 'offline' || detailBannerNotice.kind === 'error') && (
              <button
                type="button"
                className="error-banner-retry"
                onClick={() => {
                  void retrySend();
                }}
                disabled={snapshot.phase === 'offline'}
                data-testid="error-banner-retry"
              >
                Retry
              </button>
              )}
          </div>
        )}
      </div>
      <Composer
        key={`${scopeKey ?? 'no-scope'}:${composerMountKey}`}
        onSend={(text) => {
          void send(text);
        }}
        disabled={composerDisabled}
        placeholder={placeholder}
      />
    </div>
  );
}

const mount = document.getElementById('root');
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <SidePanel />
    </StrictMode>,
  );
}
