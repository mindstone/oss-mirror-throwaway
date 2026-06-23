const RELOAD_CONVERSATION_SESSION_STORAGE_KEY = 'reload-conversation-session';

type PersistedReloadConversationSession = {
  sessionId: string;
};

// Intentionally uses sessionStorage (not localStorage): we only want to restore
// the prior conversation on an in-app renderer reload (Cmd+R, HMR page reload,
// webContents.reload()). A full app quit+reopen should always land on the Home
// bootstrap, not silently reopen the last chat. sessionStorage survives
// renderer reloads but is cleared when the BrowserWindow session ends, which
// is exactly that distinction. See
// docs-private/investigations/260422_reload_restore_regression_learnings.md.
function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.sessionStorage;
}

function isPersistedReloadConversationSession(
  value: unknown
): value is PersistedReloadConversationSession {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      value.sessionId.trim().length > 0
  );
}

export function readReloadConversationSessionId(): string | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(RELOAD_CONVERSATION_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedReloadConversationSession(parsed)) {
      return null;
    }

    return parsed.sessionId;
  } catch {
    return null;
  }
}

export function writeReloadConversationSessionId(sessionId: string): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    clearReloadConversationSessionId();
    return;
  }

  try {
    storage.setItem(
      RELOAD_CONVERSATION_SESSION_STORAGE_KEY,
      JSON.stringify({ sessionId: normalizedSessionId } satisfies PersistedReloadConversationSession)
    );
  } catch {
    // Ignore persistence issues - restore is a convenience enhancement.
  }
}

export function clearReloadConversationSessionId(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(RELOAD_CONVERSATION_SESSION_STORAGE_KEY);
  } catch {
    // Ignore persistence issues - failing open is acceptable here.
  }
}
