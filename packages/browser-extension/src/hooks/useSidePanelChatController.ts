import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  createChatController,
  type ChatController,
  type ChatContext,
  type ChatControllerSnapshot,
  type ContextProvider,
} from '@rebel/shared/chatController';
import type {
  ConnectStreamError,
  ConnectStreamHandlers,
  IntentClient,
  IntentClientError,
  ResponseError,
} from '@rebel/shared/intentClient';
import {
  LOCAL_AUTH_STORAGE_KEY,
  readAuthSnapshot,
  SESSION_AUTH_STORAGE_KEY,
  type InstallStatus,
  type PairingSnapshot,
} from '../lib/browserAuth';
import {
  createExtensionIntentRuntime,
  type TabContext,
  type ExtensionTransportAdapter,
  type RuntimeContext,
} from '../lib/intents';
import { createExtensionScopedChatStatePersistence } from '../lib/chatState';
import { buildBrowserTabScope, type BrowserTabScope } from '../lib/chatScope';

const PORT_UNREACHABLE_COPY = "Couldn't find Rebel on this computer. Is the app open?";
const UNAUTHORIZED_COPY = 'Pair the extension again in Rebel settings to restore the connection.';
const EMPTY_SNAPSHOT: ChatControllerSnapshot = {
  phase: 'hydrating' as const,
  conversationId: null,
  conversationContext: {},
  messages: [],
  turnStatus: 'idle' as const,
  error: null,
  retryableSend: null,
  creatingConversation: false,
  reconnectAttempt: 0,
};

type RuntimeWithTransport = RuntimeContext & { transport: ExtensionTransportAdapter };

function createPanelSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `panel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPaired(pairing: PairingSnapshot): boolean {
  return Boolean(pairing.clientId && pairing.token);
}

function toTabContext(raw: unknown): Partial<TabContext> | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const tabContext: Partial<TabContext> = {};
  if (typeof candidate['tabId'] === 'number') tabContext.tabId = candidate['tabId'];
  if (typeof candidate['windowId'] === 'number') tabContext.windowId = candidate['windowId'];
  if (typeof candidate['url'] === 'string' && candidate['url'].length > 0) {
    tabContext.url = candidate['url'];
  }
  if (typeof candidate['title'] === 'string' && candidate['title'].length > 0) {
    tabContext.title = candidate['title'];
  }
  return Object.keys(tabContext).length > 0 ? tabContext : null;
}

async function resolveActiveScope(
  panelSessionId: string,
  rememberWindowId: (windowId: number) => void,
): Promise<BrowserTabScope> {
  try {
    let currentWindow: chrome.windows.Window | null = null;
    try {
      currentWindow = await chrome.windows?.getCurrent?.() ?? null;
    } catch {
      currentWindow = null;
    }
    if (typeof currentWindow?.id === 'number') {
      rememberWindowId(currentWindow.id);
    }
    const response = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'get-active-scope',
      ...(typeof currentWindow?.id === 'number' ? { windowId: currentWindow.id } : {}),
    });
    const tabContext = toTabContext((response as { tabContext?: unknown } | null)?.tabContext);
    return buildBrowserTabScope(tabContext, panelSessionId);
  } catch {
    return buildBrowserTabScope(null, panelSessionId);
  }
}

function shouldApplyScopeChange(
  current: BrowserTabScope | null,
  next: BrowserTabScope,
): boolean {
  if (
    typeof current?.windowId === 'number' &&
    typeof next.windowId === 'number' &&
    current.windowId !== next.windowId
  ) {
    return false;
  }
  return true;
}

function scopeMessageWindowId(envelope: { tabContext?: unknown; windowId?: unknown }): number | null {
  const tabContext = toTabContext(envelope.tabContext);
  if (typeof tabContext?.windowId === 'number') return tabContext.windowId;
  return typeof envelope.windowId === 'number' ? envelope.windowId : null;
}

function scopeFromMessage(envelope: { tabContext?: unknown; windowId?: unknown }, panelSessionId: string): BrowserTabScope {
  const tabContext = toTabContext(envelope.tabContext);
  if (tabContext) {
    return buildBrowserTabScope(tabContext, panelSessionId);
  }
  return buildBrowserTabScope(
    typeof envelope.windowId === 'number' ? { windowId: envelope.windowId } : null,
    panelSessionId,
  );
}

function createRuntimeError(
  code: IntentClientError['code'],
  message: string,
  status?: number,
): IntentClientError {
  const error = new Error(message) as IntentClientError;
  error.name = 'IntentClientError';
  error.code = code;
  if (typeof status === 'number') {
    error.status = status;
  }
  return error;
}

function toStreamError(error: unknown): ConnectStreamError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const responseError = error as ResponseError;
    return {
      code: responseError.code,
      message: responseError.message,
      ...(typeof responseError.status === 'number' ? { status: responseError.status } : {}),
    };
  }
  return {
    errName: 'TypeError',
    errMsg: error instanceof Error ? error.message : String(error),
    errConstructor: error instanceof Error ? error.constructor.name : 'Error',
    isTypeError: true,
    isDOMException: false,
    isAbortError: false,
  };
}

function createAuthedIntentClient(
  runtime: RuntimeWithTransport,
  getPairing: () => PairingSnapshot,
): IntentClient {
  const prime = async (conversationId?: string): Promise<void> => {
    const pairing = getPairing();
    if (!pairing.clientId || !pairing.token) {
      throw createRuntimeError('UNAUTHORIZED', UNAUTHORIZED_COPY, 401);
    }
    runtime.transport.setAuthHints({
      clientId: pairing.clientId,
      token: pairing.token,
      ...(pairing.fingerprint ? { fingerprint: pairing.fingerprint } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    const reachable = await runtime.transport.primeBaseUrl();
    if (!reachable) {
      throw createRuntimeError('PORT_UNREACHABLE', PORT_UNREACHABLE_COPY);
    }
  };

  return {
    async createConversation(input, signal) {
      await prime();
      return runtime.client.createConversation(input, signal);
    },
    async sendMessage(input, signal) {
      await prime(input.conversationId);
      return runtime.client.sendMessage(input, signal);
    },
    async getHistory(input, signal) {
      await prime(input.conversationId);
      return runtime.client.getHistory(input, signal);
    },
    async focusInRebel(input, signal) {
      await prime(input.conversationId);
      return runtime.client.focusInRebel(input, signal);
    },
    connectStream(input, handlers: ConnectStreamHandlers) {
      let closed = false;
      let connection: { close(): void } | null = null;
      const close = (): void => {
        closed = true;
        connection?.close();
      };
      void prime(input.conversationId)
        .then(() => {
          if (closed) return;
          connection = runtime.client.connectStream(input, handlers);
        })
        .catch((error) => {
          if (closed) return;
          handlers.onError(toStreamError(error));
          handlers.onClose('error');
        });
      return { close };
    },
  };
}

function createScopedContextProvider(scope: BrowserTabScope): ContextProvider {
  return {
    async captureContext(): Promise<ChatContext | null> {
      if (scope.mode !== 'tab' || typeof scope.tabId !== 'number') return null;
      const tabContext: TabContext = {
        tabId: scope.tabId,
        ...(typeof scope.windowId === 'number' ? { windowId: scope.windowId } : {}),
        ...(scope.url ? { url: scope.url } : {}),
        ...(scope.title ? { title: scope.title } : {}),
      };
      return {
        tabContext,
        pageContext: {
          ...(scope.title ? { title: scope.title } : {}),
          ...(scope.url ? { url: scope.url } : {}),
        },
      };
    },
  };
}

export function useSidePanelChatController() {
  const [pairing, setPairing] = useState<PairingSnapshot>({
    clientId: null,
    token: null,
    fingerprint: null,
  });
  const [pairingLoaded, setPairingLoaded] = useState(false);
  const [installStatus, setInstallStatus] = useState<InstallStatus>({ kind: 'idle' });
  const [controller, setController] = useState<ChatController | null>(null);
  const [composerMountKey, setComposerMountKey] = useState(0);
  const [scope, setScope] = useState<BrowserTabScope | null>(null);
  const panelSessionIdRef = useRef(createPanelSessionId());
  const scopeGenerationRef = useRef(0);
  const panelWindowIdRef = useRef<number | null>(null);

  const pairingRef = useRef(pairing);
  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    let cancelled = false;
    void readAuthSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        setPairing({
          clientId: snapshot.clientId,
          token: snapshot.token,
          fingerprint: snapshot.fingerprint,
        });
        setPairingLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setPairingLoaded(true);
        }
      });

    void chrome.runtime
      .sendMessage({ target: 'service-worker', type: 'get-install-state' })
      .then((result) => {
        if (cancelled) return;
        const status = (result as { status?: InstallStatus } | null)?.status;
        if (status) {
          setInstallStatus(status);
        }
      })
      .catch(() => undefined);

    const storageListener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ): void => {
      if (area !== 'local' && area !== 'session') return;
      if (
        !Object.prototype.hasOwnProperty.call(changes, LOCAL_AUTH_STORAGE_KEY) &&
        !Object.prototype.hasOwnProperty.call(changes, SESSION_AUTH_STORAGE_KEY)
      ) {
        return;
      }
      void readAuthSnapshot()
        .then((snapshot) => {
          if (cancelled) return;
          setPairing({
            clientId: snapshot.clientId,
            token: snapshot.token,
            fingerprint: snapshot.fingerprint,
          });
        })
        .catch(() => undefined);
    };

    const messageListener = (msg: unknown): void => {
      if (!msg || typeof msg !== 'object') return;
      const envelope = msg as {
        target?: string;
        type?: string;
        status?: InstallStatus;
        tabContext?: unknown;
        windowId?: unknown;
      };
      if (envelope.target === 'sidepanel' && envelope.type === 'connection-status' && envelope.status) {
        setInstallStatus(envelope.status);
      }
      if (envelope.target === 'sidepanel' && envelope.type === 'scope-changed') {
        const eventWindowId = scopeMessageWindowId(envelope);
        if (typeof eventWindowId === 'number') {
          const panelWindowId = panelWindowIdRef.current;
          if (panelWindowId === null || panelWindowId !== eventWindowId) {
            return;
          }
        }
        scopeGenerationRef.current += 1;
        const nextScope = scopeFromMessage(envelope, panelSessionIdRef.current);
        setScope((current) => (shouldApplyScopeChange(current, nextScope) ? nextScope : current));
      }
    };

    chrome.storage.onChanged.addListener(storageListener);
    chrome.runtime.onMessage.addListener(messageListener);

    return (): void => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(storageListener);
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  const paired = isPaired(pairing);

  useEffect(() => {
    if (!pairingLoaded || !paired) {
      setScope(null);
      return;
    }

    let cancelled = false;
    const generation = scopeGenerationRef.current;
    void resolveActiveScope(panelSessionIdRef.current, (windowId) => {
      panelWindowIdRef.current = windowId;
    })
      .then((nextScope) => {
        if (cancelled || scopeGenerationRef.current !== generation) return;
        setScope(nextScope);
      })
      .catch(() => {
        if (cancelled || scopeGenerationRef.current !== generation) return;
        setScope(buildBrowserTabScope(null, panelSessionIdRef.current));
      });

    return (): void => {
      cancelled = true;
    };
  }, [pairingLoaded, paired]);

  useEffect(() => {
    if (!pairingLoaded || !paired || !scope) {
      setController((existing) => {
        existing?.dispose();
        return null;
      });
      return;
    }

    const runtime = createExtensionIntentRuntime() as RuntimeWithTransport;
    const authedClient = createAuthedIntentClient(runtime, () => pairingRef.current);
    const nextController = createChatController({
      client: authedClient,
      transport: runtime.transport,
      persistence: createExtensionScopedChatStatePersistence(scope),
      diagnostics: runtime.diagnostics,
      context: createScopedContextProvider(scope),
      missingContextMessage: 'Open a page in your browser, then try again.',
    });
    setController(nextController);

    return (): void => {
      nextController.dispose();
      setController((current) => (current === nextController ? null : current));
    };
  }, [pairingLoaded, paired, scope]);

  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => undefined), [controller]),
    useCallback(() => controller?.getSnapshot() ?? EMPTY_SNAPSHOT, [controller]),
    () => EMPTY_SNAPSHOT,
  );
  const streamingText = useSyncExternalStore(
    useCallback((listener: () => void) => controller?.subscribeStreamingText(listener) ?? (() => undefined), [controller]),
    useCallback(() => controller?.getStreamingText() ?? '', [controller]),
    () => '',
  );
  const send = useCallback(async (text: string): Promise<void> => {
    await controller?.send(text);
  }, [controller]);
  const startFresh = useCallback(async (): Promise<void> => {
    await controller?.startFresh();
  }, [controller]);
  const openInRebel = useCallback(async (): Promise<void> => {
    await controller?.openInRebel();
  }, [controller]);

  const authResetNotifiedRef = useRef(false);
  useEffect(() => {
    const needsAuthReset = snapshot.phase === 'revoked' || snapshot.error?.code === 'UNAUTHORIZED';
    if (!paired || !needsAuthReset) {
      authResetNotifiedRef.current = false;
      return;
    }
    if (authResetNotifiedRef.current) return;
    authResetNotifiedRef.current = true;
    chrome.runtime
      .sendMessage({
        target: 'service-worker',
        type: 'auth-invalidated',
        reason: 'revoked-by-user',
      })
      .catch(() => {
        chrome.storage.session.remove(SESSION_AUTH_STORAGE_KEY).catch(() => undefined);
      });
  }, [paired, snapshot.error?.code, snapshot.phase]);

  const handleStartFresh = useCallback(async (): Promise<void> => {
    await startFresh();
    setComposerMountKey((value) => value + 1);
  }, [startFresh]);

  const handleRetrySend = useCallback(async (): Promise<void> => {
    if (!snapshot.retryableSend) return;
    await send(snapshot.retryableSend);
  }, [send, snapshot.retryableSend]);

  return useMemo(
    () => ({
      pairingLoaded,
      installStatus,
      paired,
      snapshot,
      streamingText,
      scopeKey: scope?.key ?? null,
      scopeContext: scope
        ? {
          ...(scope.title ? { title: scope.title } : {}),
          ...(scope.url ? { url: scope.url } : {}),
        }
        : null,
      composerMountKey,
      send,
      startFresh: handleStartFresh,
      retrySend: handleRetrySend,
      openInRebel,
    }),
    [
      composerMountKey,
      handleRetrySend,
      handleStartFresh,
      installStatus,
      openInRebel,
      paired,
      pairingLoaded,
      send,
      scope,
      snapshot,
      streamingText,
    ],
  );
}
