import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearReloadConversationSessionId,
  readReloadConversationSessionId,
  writeReloadConversationSessionId
} from '../reloadConversationSession';

describe('reloadConversationSession', () => {
  let storage: Storage;

  beforeEach(() => {
    const backingStore = new Map<string, string>();
    storage = {
      getItem: (key) => backingStore.get(key) ?? null,
      setItem: (key, value) => {
        backingStore.set(key, value);
      },
      removeItem: (key) => {
        backingStore.delete(key);
      },
      clear: () => {
        backingStore.clear();
      },
      key: (index) => Array.from(backingStore.keys())[index] ?? null,
      get length() {
        return backingStore.size;
      }
    } satisfies Storage;

    vi.stubGlobal('window', { sessionStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads back the stored session id', () => {
    writeReloadConversationSessionId('session-123');

    expect(readReloadConversationSessionId()).toBe('session-123');
  });

  it('clears the stored session id', () => {
    writeReloadConversationSessionId('session-123');

    clearReloadConversationSessionId();

    expect(readReloadConversationSessionId()).toBeNull();
  });

  it('ignores malformed persisted data', () => {
    storage.setItem('reload-conversation-session', '{bad json');

    expect(readReloadConversationSessionId()).toBeNull();
  });

  it('ignores persisted payloads without a usable session id', () => {
    storage.setItem(
      'reload-conversation-session',
      JSON.stringify({ sessionId: '   ' })
    );

    expect(readReloadConversationSessionId()).toBeNull();
  });
});
