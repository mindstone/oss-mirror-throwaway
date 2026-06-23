import { beforeEach, describe, expect, it, vi } from 'vitest';

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(_key: string) { return undefined; },
    set(_keyOrObj: string | Record<string, unknown>, _value?: unknown) {},
    has(_key: string) { return false; },
    delete(_key: string) {},
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/file-conversation-store.json',
  })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/utils/storeMigration', () => ({
  migrateStore: vi.fn((stored: Record<string, unknown> | undefined, opts: { createDefault: () => unknown }) => ({
    data:
      stored &&
      typeof stored.version === 'number' &&
      Array.isArray((stored as { entries?: unknown[] }).entries)
        ? stored
        : opts.createDefault(),
    status: 'current',
    shouldPersist: !stored || typeof stored.version !== 'number',
    fromVersion: (stored as { version?: number } | undefined)?.version ?? 1,
    toVersion: 1,
    backupPath: null,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

import {
  clearFileConversations,
  hasSessionWriteInDirectory,
  trackFileConversation,
} from '../fileConversationStore';

describe('hasSessionWriteInDirectory', () => {
  beforeEach(() => {
    storeData = {};
    clearFileConversations();
  });

  it('returns true when the session has write activity under a directory prefix', () => {
    trackFileConversation('connectors/foo/src/index.ts', 'session-a', 'Session A', 'write');

    expect(
      hasSessionWriteInDirectory('session-a', 'connectors/foo', '/Users/dev/workspace'),
    ).toBe(true);
  });

  it('returns false for unrelated directory prefixes', () => {
    trackFileConversation('connectors/foo/src/index.ts', 'session-a', 'Session A', 'write');

    expect(
      hasSessionWriteInDirectory('session-a', 'connectors/bar', '/Users/dev/workspace'),
    ).toBe(false);
  });

  it('filters by sessionId', () => {
    trackFileConversation('connectors/foo/src/index.ts', 'session-b', 'Session B', 'write');

    expect(
      hasSessionWriteInDirectory('session-a', 'connectors/foo', '/Users/dev/workspace'),
    ).toBe(false);
  });

  it('counts only write entries and ignores open entries', () => {
    trackFileConversation('connectors/foo/src/index.ts', 'session-a', 'Session A', 'open');

    expect(
      hasSessionWriteInDirectory('session-a', 'connectors/foo', '/Users/dev/workspace'),
    ).toBe(false);
  });

  it('normalizes Windows-style paths and separators', () => {
    trackFileConversation(
      'C:\\Users\\harry\\workspace\\mcp-servers\\fibonacci\\server.js',
      'session-a',
      'Session A',
      'write',
    );

    expect(
      hasSessionWriteInDirectory(
        'session-a',
        'C:/Users/you/workspace/mcp-servers/fibonacci',
      ),
    ).toBe(true);
  });

  it('resolves relative paths against coreDirectory when provided', () => {
    trackFileConversation('relative/project/server.js', 'session-a', 'Session A', 'write');

    expect(
      hasSessionWriteInDirectory(
        'session-a',
        'relative/project',
        '/Users/dev/workspace',
      ),
    ).toBe(true);
  });
});
