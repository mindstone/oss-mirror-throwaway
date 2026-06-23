/**
 * Browser extension intent client wrappers.
 *
 * Stage 3 migrates the extension surface to `@rebel/shared`'s
 * `createIntentClient(...)` while preserving the public signatures consumed
 * by popup + side panel code.
 */
import {
  createIntentClient,
  isResponseError,
  NO_OP_SINK,
  parseSSEChunk as parseSharedSSEChunk,
  type ChatErrorCode,
  type ConnectStreamError,
  type ConnectStreamEvent,
  type DiagnosticEvent,
  type DiagnosticSink,
  type IntentClient,
  type IntentClientError,
  type IntentTransportAdapter,
} from '@rebel/shared/intentClient';
import {
  LOCAL_AUTH_STORAGE_KEY,
  readPairingSnapshot,
  SESSION_AUTH_STORAGE_KEY,
  type PairingSnapshot,
} from './browserAuth';
import { createPortDiscovery, type PortDiscovery } from './port-discovery';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type IntentKind = 'summarise' | 'ask' | 'save_to_notes' | 'chat';

export interface TabContext {
  tabId: number;
  windowId?: number;
  url?: string;
  title?: string;
}

export interface PageContext {
  title?: string;
  url?: string;
  /** Highlighted selection at click time. */
  selection?: string;
  /** Full page text when the popup included it (capped). */
  text?: string;
}

export interface SendIntentInput {
  clientId: string;
  token: string;
  intent: IntentKind;
  tabContext: TabContext;
  pageContext?: PageContext;
  userText?: string;
  title?: string;
  switchToConversation?: boolean;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
  timeoutMs?: number;
  fingerprint?: string;
}

export type SendIntentErrorCode = Extract<
  ChatErrorCode,
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'APP_NOT_CONNECTED'
  | 'PORT_UNREACHABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN'
>;

export type SendIntentResult =
  | { ok: true; conversationId: string; state?: 'new' | 'resumed' }
  | { ok: false; error: SendIntentErrorCode; message: string; status?: number };

export interface CaptureTabContextOptions {
  tabsQuery?: (info: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
}

export interface SendMessageInput {
  conversationId: string;
  clientId: string;
  token: string;
  text: string;
  tabContext?: TabContext;
  fingerprint?: string;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
  timeoutMs?: number;
}

export type SendMessageResult =
  | { ok: true; messageId: string; state: 'submitted' | 'buffered'; queueSize: number }
  | { ok: false; error: SendIntentErrorCode; message: string; status?: number };

export interface GetHistoryInput {
  conversationId: string;
  clientId: string;
  token: string;
  fingerprint?: string;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
  timeoutMs?: number;
}

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  turnId?: string;
  partial?: boolean;
}

export type GetHistoryResult =
  | {
      ok: true;
      messages: HistoryMessage[];
      turnStatus: 'idle' | 'running';
      conversationTitle?: string;
    }
  | { ok: false; error: SendIntentErrorCode; message: string; status?: number };

export type StreamEvent = ConnectStreamEvent;

export interface ConnectStreamInput {
  conversationId: string;
  clientId: string;
  token: string;
  fingerprint?: string;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  signal?: AbortSignal;
}

export interface StreamConnection {
  close(): void;
}

export interface FocusInRebelInput {
  conversationId: string;
  clientId: string;
  token: string;
  fingerprint?: string;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
  timeoutMs?: number;
}

export type FocusInRebelResult =
  | { ok: true }
  | { ok: false; error: SendIntentErrorCode; message: string; status?: number };

// ---------------------------------------------------------------------------
// Transport adapter
// ---------------------------------------------------------------------------

const APP_ID = 'browser-extension';
const DEFAULT_TIMEOUT_MS = 5_000;
const PORT_UNREACHABLE_COPY = "Couldn't find Rebel on this computer. Is the app open?";
const NETWORK_ERROR_COPY = "Couldn't reach the Rebel app on this computer.";
const TIMEOUT_COPY = 'Rebel took too long to respond. Try again.';
const NOT_IMPLEMENTED_COPY =
  "Rebel can't take this action yet — the feature is still landing. Please try again soon.";
const APP_NOT_CONNECTED_COPY = "Rebel isn't reachable right now. Try again in a moment.";
const UNAUTHORIZED_COPY = 'Pair the extension again in Rebel settings to restore the connection.';
const BAD_REQUEST_COPY = 'Rebel rejected the request.';
const UNKNOWN_COPY = 'Rebel returned an unexpected response.';

type AuthHints = {
  clientId?: string;
  token?: string;
  fingerprint?: string;
  conversationId?: string;
};

export interface ExtensionTransportAdapter extends IntentTransportAdapter {
  setAuthHints(hints: AuthHints): void;
  primeBaseUrl(): Promise<boolean>;
  isReachable(): Promise<boolean>;
  handleExternalAuthReset(): void;
}

interface ExtensionTransportOptions {
  portDiscovery?: PortDiscovery;
  authSnapshotReader?: () => Promise<PairingSnapshot>;
}

class BrowserExtensionTransportAdapter implements ExtensionTransportAdapter {
  private readonly portDiscovery: PortDiscovery;
  private readonly authSnapshotReader: () => Promise<PairingSnapshot>;
  private cachedBaseUrl = '';
  private cachedSnapshot: PairingSnapshot | null = null;
  private snapshotInFlight: Promise<PairingSnapshot> | null = null;
  private cachedClientId: string | null = null;
  private cachedToken: string | null = null;
  private cachedFingerprint: string | null = null;
  private authHints: AuthHints = {};

  constructor(options: ExtensionTransportOptions = {}) {
    this.portDiscovery = options.portDiscovery ?? createPortDiscovery();
    this.authSnapshotReader = options.authSnapshotReader ?? readPairingSnapshot;
  }

  setAuthHints(hints: AuthHints): void {
    this.authHints = {
      ...(isNonEmptyString(hints.clientId) ? { clientId: hints.clientId } : {}),
      ...(isNonEmptyString(hints.token) ? { token: hints.token } : {}),
      ...(isNonEmptyString(hints.fingerprint) ? { fingerprint: hints.fingerprint } : {}),
      ...(isNonEmptyString(hints.conversationId)
        ? { conversationId: hints.conversationId }
        : {}),
    };
    if (this.authHints.clientId) this.cachedClientId = this.authHints.clientId;
    if (this.authHints.token) this.cachedToken = this.authHints.token;
    if (this.authHints.fingerprint) this.cachedFingerprint = this.authHints.fingerprint;
  }

  async primeBaseUrl(): Promise<boolean> {
    const port = await this.portDiscovery.getPort();
    if (!port) {
      this.cachedBaseUrl = '';
      return false;
    }
    this.cachedBaseUrl = port.origin;
    return true;
  }

  async isReachable(): Promise<boolean> {
    const port = await this.portDiscovery.refresh();
    if (!port) {
      this.cachedBaseUrl = '';
      return false;
    }
    this.cachedBaseUrl = port.origin;
    return true;
  }

  resolveBaseUrl(): string {
    return this.cachedBaseUrl;
  }

  async buildHeaders(init: {
    requestId: string;
    contentType?: string;
    accept?: string;
  }): Promise<Headers> {
    void init.requestId;
    const snapshot = await this.readCachedSnapshot();
    this.cachedClientId =
      readString(snapshot.clientId) ?? readString(this.authHints.clientId) ?? null;
    this.cachedToken = readString(snapshot.token) ?? readString(this.authHints.token) ?? null;
    this.cachedFingerprint =
      readString(snapshot.fingerprint) ?? readString(this.authHints.fingerprint) ?? null;

    if (!this.cachedClientId || !this.cachedToken) {
      throw createIntentError({
        code: 'UNAUTHORIZED',
        message: UNAUTHORIZED_COPY,
      });
    }

    const headers = new Headers();
    headers.set('authorization', `Bearer ${this.cachedToken}`);
    headers.set('x-rebel-app-id', APP_ID);
    headers.set('x-rebel-client-id', this.cachedClientId);
    if (this.cachedFingerprint) {
      headers.set('x-rebel-client-fingerprint', this.cachedFingerprint);
    }
    if (isNonEmptyString(init.contentType)) {
      headers.set('content-type', init.contentType);
    }
    if (isNonEmptyString(init.accept)) {
      headers.set('accept', init.accept);
    }
    if (isNonEmptyString(this.authHints.conversationId)) {
      headers.set('x-rebel-conversation-id', this.authHints.conversationId);
    }
    return headers;
  }

  stampRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    const stamped: Record<string, unknown> = {
      ...body,
      appId: APP_ID,
    };
    const bodyClientId = readString(body['clientId']);
    const clientId = bodyClientId ?? this.cachedClientId ?? this.authHints.clientId ?? null;
    if (clientId) {
      stamped['clientId'] = clientId;
    }
    return stamped;
  }

  describeForLog(): {
    surface: 'browser-extension';
    origin: string;
    transportKind: 'port-discovery';
  } {
    return {
      surface: 'browser-extension',
      origin: this.cachedBaseUrl,
      transportKind: 'port-discovery',
    };
  }

  async probeReachability(): Promise<boolean> {
    return this.isReachable();
  }

  handleExternalAuthReset(): void {
    this.cachedSnapshot = null;
    this.snapshotInFlight = null;
    this.cachedClientId = null;
    this.cachedToken = null;
    this.cachedFingerprint = null;
    this.authHints = {};
  }

  private async readCachedSnapshot(): Promise<PairingSnapshot> {
    if (this.cachedSnapshot) {
      return this.cachedSnapshot;
    }
    if (this.snapshotInFlight) {
      return this.snapshotInFlight;
    }
    this.snapshotInFlight = this.authSnapshotReader()
      .then((snapshot) => {
        this.cachedSnapshot = snapshot;
        return snapshot;
      })
      .catch(() => ({
        clientId: null,
        token: null,
        fingerprint: null,
      }))
      .finally(() => {
        this.snapshotInFlight = null;
      });
    return this.snapshotInFlight;
  }
}

export function createExtensionTransportAdapter(
  options: ExtensionTransportOptions = {},
): ExtensionTransportAdapter {
  return new BrowserExtensionTransportAdapter(options);
}

export const extensionTransport = createExtensionTransportAdapter();

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

class ConsoleDiagnosticSink implements DiagnosticSink {
  emit(event: DiagnosticEvent): void {
    try {
       
      console.debug('[intent-client]', event.kind, event);
    } catch {
      // no-op (diagnostics are best-effort)
    }
  }
}

function shouldUseConsoleDiagnostics(): boolean {
  return import.meta.env.DEV;
}

const extensionDiagnostics: DiagnosticSink = shouldUseConsoleDiagnostics()
  ? new ConsoleDiagnosticSink()
  : NO_OP_SINK;

// ---------------------------------------------------------------------------
// Shared-client legacy route bridge
// ---------------------------------------------------------------------------

type SharedIntentRoute = 'create' | 'message' | 'history' | 'focus' | 'stream';

function detectSharedIntentRoute(url: string): SharedIntentRoute | null {
  if (url.endsWith('/intent/conversation/create')) return 'create';
  if (url.endsWith('/intent/conversation/message')) return 'message';
  if (url.endsWith('/intent/conversation/history')) return 'history';
  if (url.endsWith('/intent/conversation/focus')) return 'focus';
  if (url.endsWith('/intent/conversation/stream')) return 'stream';
  return null;
}

function parseBodyObject(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rewriteUrlPath(url: string, nextPath: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const parsed = new URL(url);
    return `${parsed.origin}${nextPath}`;
  }
  return nextPath;
}

function createLegacyRouteFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const originalUrl = String(input);
    const route = detectSharedIntentRoute(originalUrl);
    if (!route) {
      return fetchImpl(input, init);
    }

    const headers = new Headers(init?.headers);
    const bodyObject = parseBodyObject(init?.body);
    const conversationId =
      readString(bodyObject['conversationId']) ??
      readString(headers.get('x-rebel-conversation-id'));
    let url = originalUrl;
    let method = (init?.method ?? 'POST').toUpperCase();
    let body = init?.body;

    headers.delete('x-rebel-conversation-id');

    switch (route) {
      case 'create': {
        method = 'POST';
        break;
      }
      case 'message': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        const { conversationId: _omit, ...legacyBody } = bodyObject;
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/message`,
        );
        method = 'POST';
        body = JSON.stringify(legacyBody);
        break;
      }
      case 'history': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/messages`,
        );
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('accept');
        break;
      }
      case 'focus': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/focus`,
        );
        method = 'POST';
        body = '{}';
        headers.set('content-type', 'application/json');
        headers.delete('accept');
        break;
      }
      case 'stream': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/stream`,
        );
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.set('accept', 'text/event-stream');
        break;
      }
    }

    const requestInit: RequestInit = {
      ...init,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    };

    return fetchImpl(url, requestInit);
  }) as typeof fetch;
}

const sharedFetch = createLegacyRouteFetch(fetch);

const sharedClient = createIntentClient({
  transport: extensionTransport,
  diagnostics: extensionDiagnostics,
  fetchImpl: sharedFetch,
});

interface RuntimeInput {
  clientId: string;
  token: string;
  fingerprint?: string;
  conversationId?: string;
  fetchImpl?: typeof fetch;
  portDiscovery?: PortDiscovery;
}

export interface RuntimeContext {
  client: IntentClient;
  transport: ExtensionTransportAdapter;
  diagnostics: DiagnosticSink;
}

function createRuntime(input: RuntimeInput): RuntimeContext {
  const hasOverrides = Boolean(input.fetchImpl) || Boolean(input.portDiscovery);
  if (!hasOverrides) {
    return {
      client: sharedClient,
      transport: extensionTransport,
      diagnostics: extensionDiagnostics,
    };
  }
  const transport = createExtensionTransportAdapter({
    ...(input.portDiscovery ? { portDiscovery: input.portDiscovery } : {}),
  });
  const scopedFetch = createLegacyRouteFetch(input.fetchImpl ?? fetch);
  const diagnostics = extensionDiagnostics;
  const client = createIntentClient({
    transport,
    diagnostics,
    fetchImpl: scopedFetch,
  });
  return { client, transport, diagnostics };
}

export function createExtensionIntentRuntime(
  options: Pick<RuntimeInput, 'fetchImpl' | 'portDiscovery'> = {},
): RuntimeContext {
  return createRuntime({
    clientId: '',
    token: '',
    ...options,
  });
}

async function prepareRuntime(input: RuntimeInput): Promise<
  | { ok: true; runtime: RuntimeContext }
  | { ok: false; error: SendIntentErrorCode; message: string; status?: number }
> {
  ensureAuthResetListenerInstalled();
  const runtime = createRuntime(input);
  runtime.transport.setAuthHints({
    clientId: input.clientId,
    token: input.token,
    ...(isNonEmptyString(input.fingerprint) ? { fingerprint: input.fingerprint } : {}),
    ...(isNonEmptyString(input.conversationId)
      ? { conversationId: input.conversationId }
      : {}),
  });
  const reachable = await runtime.transport.primeBaseUrl();
  if (!reachable) {
    return { ok: false, error: 'PORT_UNREACHABLE', message: PORT_UNREACHABLE_COPY };
  }
  return { ok: true, runtime };
}

// ---------------------------------------------------------------------------
// auth-reset listener
// ---------------------------------------------------------------------------

let authResetListenerInstalled = false;

function readField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return readString(record[key]) ?? null;
}

function shouldResetAuthCache(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: chrome.storage.AreaName,
): boolean {
  if (
    areaName === 'session' &&
    Object.prototype.hasOwnProperty.call(changes, SESSION_AUTH_STORAGE_KEY)
  ) {
    const nextToken = readField(changes[SESSION_AUTH_STORAGE_KEY]?.newValue, 'token');
    const prevToken = readField(changes[SESSION_AUTH_STORAGE_KEY]?.oldValue, 'token');
    return !nextToken || prevToken !== nextToken;
  }
  if (
    areaName === 'local' &&
    Object.prototype.hasOwnProperty.call(changes, LOCAL_AUTH_STORAGE_KEY)
  ) {
    const nextClientId = readField(changes[LOCAL_AUTH_STORAGE_KEY]?.newValue, 'clientId');
    const prevClientId = readField(changes[LOCAL_AUTH_STORAGE_KEY]?.oldValue, 'clientId');
    const nextFingerprint =
      readField(changes[LOCAL_AUTH_STORAGE_KEY]?.newValue, 'fingerprint') ??
      readField(changes[LOCAL_AUTH_STORAGE_KEY]?.newValue, 'clientFingerprint');
    const prevFingerprint =
      readField(changes[LOCAL_AUTH_STORAGE_KEY]?.oldValue, 'fingerprint') ??
      readField(changes[LOCAL_AUTH_STORAGE_KEY]?.oldValue, 'clientFingerprint');
    return !nextClientId || prevClientId !== nextClientId || prevFingerprint !== nextFingerprint;
  }
  return false;
}

function ensureAuthResetListenerInstalled(): void {
  if (authResetListenerInstalled) return;
  const maybeChrome = globalThis as typeof globalThis & { chrome?: typeof chrome };
  const onChanged = maybeChrome.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return;
  onChanged.addListener((changes, areaName) => {
    if (shouldResetAuthCache(changes, areaName)) {
      extensionTransport.handleExternalAuthReset();
    }
  });
  authResetListenerInstalled = true;
}

ensureAuthResetListenerInstalled();

// ---------------------------------------------------------------------------
// captureTabContext
// ---------------------------------------------------------------------------

export async function captureTabContext(
  options: CaptureTabContextOptions = {},
): Promise<TabContext | null> {
  const queryImpl =
    options.tabsQuery ?? ((info: chrome.tabs.QueryInfo) => chrome.tabs.query(info));
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await queryImpl({ active: true, currentWindow: true });
  } catch {
    return null;
  }
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    return null;
  }
  const ctx: TabContext = { tabId: tab.id };
  if (typeof tab.windowId === 'number') ctx.windowId = tab.windowId;
  if (typeof tab.url === 'string' && tab.url.length > 0) ctx.url = tab.url;
  if (typeof tab.title === 'string' && tab.title.length > 0) ctx.title = tab.title;
  return ctx;
}

// ---------------------------------------------------------------------------
// createConversation/sendIntent
// ---------------------------------------------------------------------------

export async function createConversation(input: SendIntentInput): Promise<SendIntentResult> {
  const prepared = await prepareRuntime(input);
  if (!prepared.ok) {
    return prepared;
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const result = await prepared.runtime.client.createConversation(
      {
        intent: input.intent,
        tabContext: input.tabContext,
        ...(input.pageContext ? { pageContext: input.pageContext } : {}),
        ...(isNonEmptyString(input.userText) ? { userText: input.userText } : {}),
        ...(isNonEmptyString(input.title) ? { title: input.title } : {}),
        ...(typeof input.switchToConversation === 'boolean'
          ? { switchToConversation: input.switchToConversation }
          : {}),
      },
      controller.signal,
    );
    return {
      ok: true,
      conversationId: result.conversationId,
      ...(result.state ? { state: result.state } : {}),
    };
  } catch (error) {
    return { ok: false, ...toLegacyErrorEnvelope(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendIntent(input: SendIntentInput): Promise<SendIntentResult> {
  return createConversation(input);
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const prepared = await prepareRuntime(input);
  if (!prepared.ok) {
    return prepared;
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const result = await prepared.runtime.client.sendMessage(
      {
        conversationId: input.conversationId,
        text: input.text,
        ...(input.tabContext ? { tabContext: input.tabContext } : {}),
      },
      controller.signal,
    );
    return {
      ok: true,
      messageId: result.messageId,
      state: result.state,
      queueSize: result.queueSize,
    };
  } catch (error) {
    return { ok: false, ...toLegacyErrorEnvelope(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

export async function getHistory(input: GetHistoryInput): Promise<GetHistoryResult> {
  const prepared = await prepareRuntime(input);
  if (!prepared.ok) {
    return prepared;
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const result = await prepared.runtime.client.getHistory(
      { conversationId: input.conversationId },
      controller.signal,
    );
    return {
      ok: true,
      messages: result.messages,
      turnStatus: result.turnStatus,
      ...(result.conversationTitle ? { conversationTitle: result.conversationTitle } : {}),
    };
  } catch (error) {
    return { ok: false, ...toLegacyErrorEnvelope(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// focusInRebel
// ---------------------------------------------------------------------------

export async function focusInRebel(input: FocusInRebelInput): Promise<FocusInRebelResult> {
  const prepared = await prepareRuntime(input);
  if (!prepared.ok) {
    return prepared;
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    await prepared.runtime.client.focusInRebel(
      { conversationId: input.conversationId },
      controller.signal,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, ...toLegacyErrorEnvelope(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// connectStream
// ---------------------------------------------------------------------------

export function connectStream(input: ConnectStreamInput): StreamConnection {
  ensureAuthResetListenerInstalled();
  const runtime = createRuntime(input);
  runtime.transport.setAuthHints({
    clientId: input.clientId,
    token: input.token,
    ...(isNonEmptyString(input.fingerprint) ? { fingerprint: input.fingerprint } : {}),
    conversationId: input.conversationId,
  });

  const controller = new AbortController();
  let closed = false;
  let closeNotified = false;
  let connection: { close(): void } | null = null;

  const notifyClose = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    input.onClose?.();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.abort();
    } catch {
      // no-op (abort is idempotent)
    }
    connection?.close();
    if (!connection) {
      notifyClose();
    }
  };

  if (input.signal) {
    if (input.signal.aborted) {
      close();
    } else {
      input.signal.addEventListener('abort', close, { once: true });
    }
  }

  const start = async (): Promise<void> => {
    const reachable = await runtime.transport.primeBaseUrl();
    if (closed) return;
    if (!reachable) {
      input.onError?.(new Error('PORT_UNREACHABLE'));
      notifyClose();
      return;
    }

    connection = runtime.client.connectStream(
      {
        conversationId: input.conversationId,
        signal: controller.signal,
      },
      {
        onEvent: (event) => {
          input.onEvent(event);
        },
        onError: (error) => {
          if (closed) return;
          input.onError?.(toLegacyStreamError(error));
        },
        onClose: () => {
          notifyClose();
        },
      },
    );
  };

  void start();
  return { close };
}

// ---------------------------------------------------------------------------
// parseSSEChunk compatibility export
// ---------------------------------------------------------------------------

export function parseSSEChunk(buffer: string): {
  events: Array<{ event: string; data: string }>;
  remaining: string;
} {
  const parsed = parseSharedSSEChunk(buffer);
  return {
    events: parsed.events,
    remaining: parsed.remainder,
  };
}

// ---------------------------------------------------------------------------
// Legacy error envelope mapping
// ---------------------------------------------------------------------------

function mapSharedCodeToLegacy(code: ChatErrorCode): SendIntentErrorCode {
  switch (code) {
    case 'UNSUPPORTED':
      return 'NOT_IMPLEMENTED';
    case 'BRIDGE_UNAVAILABLE':
      return 'APP_NOT_CONNECTED';
    case 'BRIDGE_ERROR':
      return 'INTERNAL_ERROR';
    case 'FORBIDDEN':
    case 'REVOKED':
      return 'UNAUTHORIZED';
    case 'GONE':
      return 'NOT_FOUND';
    case 'ABORTED':
      return 'TIMEOUT';
    case 'NOT_IMPLEMENTED':
    case 'NOT_FOUND':
    case 'APP_NOT_CONNECTED':
    case 'PORT_UNREACHABLE':
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'BAD_REQUEST':
    case 'UNAUTHORIZED':
    case 'INTERNAL_ERROR':
    case 'UNKNOWN':
      return code;
  }
}

function defaultMessageForLegacyCode(code: SendIntentErrorCode, status?: number): string {
  switch (code) {
    case 'PORT_UNREACHABLE':
      return PORT_UNREACHABLE_COPY;
    case 'NETWORK_ERROR':
      return NETWORK_ERROR_COPY;
    case 'TIMEOUT':
      return TIMEOUT_COPY;
    case 'NOT_IMPLEMENTED':
      return NOT_IMPLEMENTED_COPY;
    case 'APP_NOT_CONNECTED':
      return APP_NOT_CONNECTED_COPY;
    case 'UNAUTHORIZED':
      return UNAUTHORIZED_COPY;
    case 'BAD_REQUEST':
      return BAD_REQUEST_COPY;
    case 'INTERNAL_ERROR':
      return typeof status === 'number'
        ? `Rebel returned an unexpected ${status}.`
        : 'Rebel returned an unexpected server error.';
    case 'NOT_FOUND':
      return 'This conversation no longer exists in Rebel.';
    case 'UNKNOWN':
    default:
      return UNKNOWN_COPY;
  }
}

function toLegacyErrorEnvelope(
  error: unknown,
  timedOut = false,
): { error: SendIntentErrorCode; message: string; status?: number } {
  if (timedOut) {
    return { error: 'TIMEOUT', message: TIMEOUT_COPY };
  }

  if (isIntentClientErrorLike(error)) {
    const mapped = mapSharedCodeToLegacy(error.code);
    const message =
      mapped === 'TIMEOUT'
        ? TIMEOUT_COPY
        : mapped === 'NETWORK_ERROR'
          ? NETWORK_ERROR_COPY
          : isNonEmptyString(error.message)
            ? error.message
            : defaultMessageForLegacyCode(mapped, error.status);
    return {
      error: mapped,
      message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
    };
  }

  if (error instanceof Error && error.message === 'PORT_UNREACHABLE') {
    return { error: 'PORT_UNREACHABLE', message: PORT_UNREACHABLE_COPY };
  }

  return { error: 'UNKNOWN', message: UNKNOWN_COPY };
}

function toLegacyStreamError(error: ConnectStreamError): Error {
  if (isResponseError(error)) {
    const code = mapSharedCodeToLegacy(error.code);
    const message = isNonEmptyString(error.message)
      ? error.message
      : defaultMessageForLegacyCode(code, error.status);
    return new Error(`${code}: ${message}`);
  }

  if (error.isAbortError) {
    return new Error(`TIMEOUT: ${TIMEOUT_COPY}`);
  }
  if (error.isTypeError || error.isDOMException) {
    return new Error(`NETWORK_ERROR: ${NETWORK_ERROR_COPY}`);
  }
  return new Error(`UNKNOWN: ${UNKNOWN_COPY}`);
}

function createIntentError(input: {
  code: ChatErrorCode;
  message: string;
  status?: number;
}): IntentClientError {
  const error = new Error(input.message) as IntentClientError;
  error.name = 'IntentClientError';
  error.code = input.code;
  if (typeof input.status === 'number') {
    error.status = input.status;
  }
  return error;
}

function isIntentClientErrorLike(error: unknown): error is IntentClientError {
  if (!(error instanceof Error)) return false;
  if (!isRecord(error)) return false;
  return isNonEmptyString(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}
