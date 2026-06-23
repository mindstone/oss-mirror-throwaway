/**
 * Embedded-chat side panel conversation state.
 */
import type { ChatStatePersistence, PersistedChatState } from '@rebel/shared/intentClient';
import { SESSION_AUTH_STORAGE_KEY } from './browserAuth';
import { buildBrowserTabScope, hashScopeKey, type BrowserTabScope } from './chatScope';
import { createLogger } from './logger';

const LEGACY_CHAT_STATE_KEY = 'rebel.chat.v1';
const CHAT_STATE_KEY_PREFIX = 'rebel.chat.scope.v1.';
const CHAT_STATE_INDEX_KEY = 'rebel.chat.scopes.v1';
const MAX_SCOPED_CHAT_RECORDS = 50;
const STALE_CHAT_STATE_MS = 12 * 60 * 60 * 1000;
const log = createLogger({ prefix: '[chat-state]' });

export interface ChatState extends Omit<PersistedChatState, 'conversationId'> {
  conversationId: string | null;
  installSessionId?: string;
}

interface StoredScopeMetadata {
  key: string;
  mode: BrowserTabScope['mode'];
  tabId?: number;
  windowId?: number;
  urlFingerprint?: string;
  titleFingerprint?: string;
}

interface ChatStateEnvelope {
  scope: StoredScopeMetadata;
  state: ChatState;
}

interface ChatStateIndexEntry {
  storageKey: string;
  scopeKeyHash: string;
  mode: BrowserTabScope['mode'];
  updatedAt: number;
}

const EMPTY_STATE: ChatState = { conversationId: null };

function toChatState(raw: unknown): ChatState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  const r = raw as {
    conversationId?: unknown;
    conversationTitle?: unknown;
    createdAt?: unknown;
    pageTitle?: unknown;
    pageUrl?: unknown;
    installSessionId?: unknown;
  };
  const state: ChatState = {
    conversationId: typeof r.conversationId === 'string' ? r.conversationId : null,
  };
  if (typeof r.conversationTitle === 'string' && r.conversationTitle.length > 0) {
    state.conversationTitle = r.conversationTitle;
  }
  if (typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)) {
    state.createdAt = r.createdAt;
  }
  if (typeof r.pageTitle === 'string' && r.pageTitle.length > 0) {
    state.pageTitle = r.pageTitle;
  }
  if (typeof r.pageUrl === 'string' && r.pageUrl.length > 0) {
    state.pageUrl = r.pageUrl;
  }
  if (typeof r.installSessionId === 'string' && r.installSessionId.length > 0) {
    state.installSessionId = r.installSessionId;
  }
  return state;
}

function toStoredScopeMetadata(scope: BrowserTabScope): StoredScopeMetadata {
  return {
    key: scope.key,
    mode: scope.mode,
    ...(typeof scope.tabId === 'number' ? { tabId: scope.tabId } : {}),
    ...(typeof scope.windowId === 'number' ? { windowId: scope.windowId } : {}),
    ...(scope.urlFingerprint ? { urlFingerprint: scope.urlFingerprint } : {}),
    ...(scope.titleFingerprint ? { titleFingerprint: scope.titleFingerprint } : {}),
  };
}

function isStoredScopeMetadata(raw: unknown): raw is StoredScopeMetadata {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate['key'] === 'string'
    && (candidate['mode'] === 'tab' || candidate['mode'] === 'ephemeral')
  );
}

function toChatStateEnvelope(raw: unknown): ChatStateEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as {
    scope?: unknown;
    state?: unknown;
  };
  if (!isStoredScopeMetadata(candidate.scope)) {
    return null;
  }
  return {
    scope: candidate.scope,
    state: toChatState(candidate.state),
  };
}

function matchesScope(scope: BrowserTabScope, storedScope: StoredScopeMetadata): boolean {
  return scope.key === storedScope.key;
}

function isStaleByAge(state: ChatState): boolean {
  return typeof state.createdAt === 'number' && Date.now() - state.createdAt > STALE_CHAT_STATE_MS;
}

async function readCurrentInstallSessionId(): Promise<string | null> {
  try {
    const sessionStorage = chrome.storage.session;
    if (!sessionStorage) return null;
    const raw = await sessionStorage.get(SESSION_AUTH_STORAGE_KEY);
    const record = raw[SESSION_AUTH_STORAGE_KEY];
    if (!record || typeof record !== 'object') return null;
    const installSessionId = (record as { installSessionId?: unknown }).installSessionId;
    return typeof installSessionId === 'string' && installSessionId.length > 0
      ? installSessionId
      : null;
  } catch {
    return null;
  }
}

function isStaleByInstallSession(state: ChatState, currentInstallSessionId: string | null): boolean {
  if (!currentInstallSessionId) return false;
  if (!state.installSessionId) return true;
  return state.installSessionId !== currentInstallSessionId;
}

function getStorageKey(scope: BrowserTabScope): string {
  return `${CHAT_STATE_KEY_PREFIX}${encodeURIComponent(scope.key)}`;
}

async function readEnvelope(scope: BrowserTabScope): Promise<ChatStateEnvelope | null> {
  try {
    const storageKey = getStorageKey(scope);
    const raw = await chrome.storage.local.get(storageKey);
    return toChatStateEnvelope(raw[storageKey]);
  } catch {
    return null;
  }
}

function toChatStateIndex(raw: unknown): Record<string, ChatStateIndexEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const parsed = raw as Record<string, unknown>;
  const next: Record<string, ChatStateIndexEntry> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry['storageKey'] !== 'string' ||
      typeof entry['scopeKeyHash'] !== 'string' ||
      (entry['mode'] !== 'tab' && entry['mode'] !== 'ephemeral') ||
      typeof entry['updatedAt'] !== 'number'
    ) {
      continue;
    }
    next[key] = {
      storageKey: entry['storageKey'],
      scopeKeyHash: entry['scopeKeyHash'],
      mode: entry['mode'],
      updatedAt: entry['updatedAt'],
    };
  }
  return next;
}

async function readIndex(): Promise<Record<string, ChatStateIndexEntry>> {
  try {
    const raw = await chrome.storage.local.get(CHAT_STATE_INDEX_KEY);
    const parsed = toChatStateIndex(raw[CHAT_STATE_INDEX_KEY]);
    if (Object.keys(parsed).length > 0) {
      return parsed;
    }
    return await rebuildIndex();
  } catch {
    return await rebuildIndex();
  }
}

async function rebuildIndex(): Promise<Record<string, ChatStateIndexEntry>> {
  try {
    const allRecords = await chrome.storage.local.get(null);
    const rebuilt: Record<string, ChatStateIndexEntry> = {};
    for (const [storageKey, raw] of Object.entries(allRecords)) {
      if (!storageKey.startsWith(CHAT_STATE_KEY_PREFIX)) continue;
      const envelope = toChatStateEnvelope(raw);
      if (!envelope) continue;
      rebuilt[storageKey] = {
        storageKey,
        scopeKeyHash: hashScopeKey(envelope.scope.key),
        mode: envelope.scope.mode,
        updatedAt: envelope.state.createdAt ?? 0,
      };
    }
    return rebuilt;
  } catch {
    return {};
  }
}

async function updateScopeIndex(scope: BrowserTabScope): Promise<void> {
  const storageKey = getStorageKey(scope);
  const index = await readIndex();
  index[storageKey] = {
    storageKey,
    scopeKeyHash: hashScopeKey(scope.key),
    mode: scope.mode,
    updatedAt: Date.now(),
  };

  const entries = Object.values(index).sort((left, right) => right.updatedAt - left.updatedAt);
  const staleEntries = entries.slice(MAX_SCOPED_CHAT_RECORDS);
  const staleStorageKeys = staleEntries.map((entry) => entry.storageKey);
  for (const entry of staleEntries) {
    delete index[entry.storageKey];
  }

  try {
    await chrome.storage.local.set({ [CHAT_STATE_INDEX_KEY]: index });
    if (staleStorageKeys.length > 0) {
      await chrome.storage.local.remove(staleStorageKeys);
      for (const entry of staleEntries) {
        emitScopeDiagnostic('info', 'scope_pruned', scope, {
          prunedScopeKeyHash: entry.scopeKeyHash,
        });
      }
    }
  } catch (error) {
    emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
      operation: 'index',
      errorName: error instanceof Error ? error.name : 'Error',
    });
  }
}

async function removeScopeFromIndex(scope: BrowserTabScope): Promise<void> {
  const storageKey = getStorageKey(scope);
  const index = await readIndex();
  if (!index[storageKey]) return;
  delete index[storageKey];
  try {
    await chrome.storage.local.set({ [CHAT_STATE_INDEX_KEY]: index });
  } catch (error) {
    emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
      operation: 'index',
      errorName: error instanceof Error ? error.name : 'Error',
    });
  }
}

function emitScopeDiagnostic(
  level: 'info' | 'warn',
  code:
    | 'scope_resolved'
    | 'scope_fallback_ephemeral'
    | 'scope_mismatch_discarded'
    | 'scope_persist_failed'
    | 'scope_pruned'
    | 'legacy_state_migrated'
    | 'legacy_state_ignored',
  scope: BrowserTabScope,
  extra: Record<string, unknown> = {},
): void {
  log[level]({
    diagnosticCode: code,
    surface: 'browser-extension',
    scopeMode: scope.mode,
    scopeKeyHash: hashScopeKey(scope.key),
    ...(typeof scope.tabId === 'number' ? { tabId: scope.tabId } : {}),
    ...(typeof scope.windowId === 'number' ? { windowId: scope.windowId } : {}),
    ...(scope.urlFingerprint ? { urlFingerprint: scope.urlFingerprint } : {}),
    ...(scope.titleFingerprint ? { titleFingerprint: scope.titleFingerprint } : {}),
    ...extra,
  });
}

export async function getChatState(scope: BrowserTabScope): Promise<ChatState> {
  try {
    const envelope = await readEnvelope(scope);
    if (!envelope) return { ...EMPTY_STATE };
    if (!matchesScope(scope, envelope.scope)) {
      emitScopeDiagnostic('warn', 'scope_mismatch_discarded', scope, {
        previousScopeKeyHash: hashScopeKey(envelope.scope.key),
        reason: 'scope-key-mismatch',
      });
      return { ...EMPTY_STATE };
    }
    return envelope.state;
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function readLegacyChatState(scope: BrowserTabScope): Promise<ChatState> {
  try {
    const raw = await chrome.storage.local.get(LEGACY_CHAT_STATE_KEY);
    return toChatState(raw[LEGACY_CHAT_STATE_KEY]);
  } catch (error) {
    emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
      operation: 'read-legacy',
      errorName: error instanceof Error ? error.name : 'Error',
    });
    return { ...EMPTY_STATE };
  }
}

function legacyStateMatchesScope(scope: BrowserTabScope, state: ChatState): boolean {
  return scope.mode === 'tab' && Boolean(scope.url) && state.pageUrl === scope.url;
}

function hasExplicitLegacyInstallSessionMismatch(
  state: ChatState,
  currentInstallSessionId: string | null,
): boolean {
  return Boolean(
    currentInstallSessionId &&
    state.installSessionId &&
    state.installSessionId !== currentInstallSessionId,
  );
}

async function migrateLegacyChatStateIfSafe(
  scope: BrowserTabScope,
  currentInstallSessionId: string | null,
): Promise<ChatState> {
  const legacyState = await readLegacyChatState(scope);
  if (!legacyState.conversationId) {
    return { ...EMPTY_STATE };
  }

  if (hasExplicitLegacyInstallSessionMismatch(legacyState, currentInstallSessionId)) {
    await chrome.storage.local.remove(LEGACY_CHAT_STATE_KEY).catch((error) => {
      emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
        operation: 'clear-legacy',
        errorName: error instanceof Error ? error.name : 'Error',
      });
    });
    emitScopeDiagnostic('info', 'legacy_state_ignored', scope, {
      reason: 'install-session-mismatch',
    });
    return { ...EMPTY_STATE };
  }

  if (!legacyStateMatchesScope(scope, legacyState)) {
    emitScopeDiagnostic('info', 'legacy_state_ignored', scope, {
      reason: 'scope-proof-missing',
    });
    return { ...EMPTY_STATE };
  }

  const migratedState: ChatState = {
    ...legacyState,
    ...(currentInstallSessionId ? { installSessionId: currentInstallSessionId } : {}),
  };

  try {
    await setChatState(scope, migratedState);
    await chrome.storage.local.remove(LEGACY_CHAT_STATE_KEY).catch((error) => {
      emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
        operation: 'clear-legacy',
        errorName: error instanceof Error ? error.name : 'Error',
      });
    });
    emitScopeDiagnostic('info', 'legacy_state_migrated', scope);
    return migratedState;
  } catch (error) {
    emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
      operation: 'migrate-legacy',
      errorName: error instanceof Error ? error.name : 'Error',
    });
    return { ...EMPTY_STATE };
  }
}

export async function setChatState(scope: BrowserTabScope, state: ChatState): Promise<void> {
  const payload: ChatState = { conversationId: state.conversationId };
  if (typeof state.conversationTitle === 'string' && state.conversationTitle.length > 0) {
    payload.conversationTitle = state.conversationTitle;
  }
  if (typeof state.createdAt === 'number' && Number.isFinite(state.createdAt)) {
    payload.createdAt = state.createdAt;
  }
  if (typeof state.pageTitle === 'string' && state.pageTitle.length > 0) {
    payload.pageTitle = state.pageTitle;
  }
  if (typeof state.pageUrl === 'string' && state.pageUrl.length > 0) {
    payload.pageUrl = state.pageUrl;
  }
  if (typeof state.installSessionId === 'string' && state.installSessionId.length > 0) {
    payload.installSessionId = state.installSessionId;
  }
  await chrome.storage.local.set({
    [getStorageKey(scope)]: {
      scope: toStoredScopeMetadata(scope),
      state: payload,
    } satisfies ChatStateEnvelope,
  });
  await updateScopeIndex(scope);
}

export async function clearChatState(scope: BrowserTabScope): Promise<void> {
  await chrome.storage.local.remove(getStorageKey(scope));
  await removeScopeFromIndex(scope);
}

export function onStorageChanged(scope: BrowserTabScope, callback: (state: ChatState) => void): () => void {
  const storageKey = getStorageKey(scope);
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ): void => {
    if (area !== 'local') return;
    if (!Object.prototype.hasOwnProperty.call(changes, storageKey)) return;
    const envelope = toChatStateEnvelope(changes[storageKey]?.newValue);
    callback(envelope?.state ?? { ...EMPTY_STATE });
  };
  chrome.storage.onChanged.addListener(listener);
  return (): void => {
    chrome.storage.onChanged.removeListener(listener);
  };
}

function createPersistedState(state: ChatState): PersistedChatState {
  return {
    conversationId: state.conversationId ?? '',
    ...(state.conversationTitle ? { conversationTitle: state.conversationTitle } : {}),
    ...(typeof state.createdAt === 'number' ? { createdAt: state.createdAt } : {}),
    ...(state.pageTitle ? { pageTitle: state.pageTitle } : {}),
    ...(state.pageUrl ? { pageUrl: state.pageUrl } : {}),
  };
}

export function createExtensionScopedChatStatePersistence(
  scope: BrowserTabScope,
): ChatStatePersistence {
  if (scope.mode === 'ephemeral') {
    emitScopeDiagnostic('info', 'scope_fallback_ephemeral', scope, {
      reason: 'missing-tab-id',
    });
  } else {
    emitScopeDiagnostic('info', 'scope_resolved', scope);
  }

  return {
    async get() {
      const currentInstallSessionId = await readCurrentInstallSessionId();
      let state = await getChatState(scope);
      if (!state.conversationId) {
        state = await migrateLegacyChatStateIfSafe(scope, currentInstallSessionId);
      }
      if (!state.conversationId) return null;
      if (isStaleByAge(state) || isStaleByInstallSession(state, currentInstallSessionId)) {
        await clearChatState(scope).catch((error) => {
          emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
            operation: 'clear',
            errorName: error instanceof Error ? error.name : 'Error',
          });
        });
        return null;
      }
      return createPersistedState(state);
    },
    async set(state) {
      const installSessionId = await readCurrentInstallSessionId();
      try {
        await setChatState(scope, {
          conversationId: state.conversationId,
          ...(state.conversationTitle ? { conversationTitle: state.conversationTitle } : {}),
          ...(typeof state.createdAt === 'number' ? { createdAt: state.createdAt } : {}),
          ...(state.pageTitle ? { pageTitle: state.pageTitle } : {}),
          ...(state.pageUrl ? { pageUrl: state.pageUrl } : {}),
          ...(installSessionId ? { installSessionId } : {}),
        });
      } catch (error) {
        emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
          operation: 'set',
          errorName: error instanceof Error ? error.name : 'Error',
        });
      }
    },
    async clear() {
      try {
        await clearChatState(scope);
      } catch (error) {
        emitScopeDiagnostic('warn', 'scope_persist_failed', scope, {
          operation: 'clear',
          errorName: error instanceof Error ? error.name : 'Error',
        });
      }
    },
    subscribe(listener) {
      return onStorageChanged(scope, () => {
        listener();
      });
    },
  };
}

export const TEST_SCOPES = {
  tab(id: number, windowId = 1): BrowserTabScope {
    return buildBrowserTabScope({ tabId: id, windowId }, `test-tab-${id}`);
  },
  ephemeral(panelSessionId = 'ephemeral-test'): BrowserTabScope {
    return buildBrowserTabScope(null, panelSessionId);
  },
} as const;

export const LEGACY_BROWSER_CHAT_STATE_KEY = LEGACY_CHAT_STATE_KEY;
