import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMcpAppModelContextStoreForTests,
  cleanupConversation,
  cleanupOlderThan,
  getContextsForConversation,
  storeContext,
} from '../mcpAppModelContextStore';

describe('mcpAppModelContextStore', () => {
  beforeEach(() => {
    _resetMcpAppModelContextStoreForTests();
  });

  it('stores contexts per conversation and supersedes newer writes from the same source', () => {
    storeContext({
      sourcePackageId: 'GoogleWorkspace-user-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-1',
      content: 'old draft',
      storedAt: '2026-05-10T00:00:00.000Z',
    });
    storeContext({
      sourcePackageId: 'GoogleWorkspace-user-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-2',
      content: 'new draft',
      storedAt: '2026-05-10T00:01:00.000Z',
    });

    expect(getContextsForConversation('conversation-1')).toEqual([
      expect.objectContaining({
        sourcePackageId: 'GoogleWorkspace-user-1',
        toolUseId: 'tool-2',
        content: 'new draft',
      }),
    ]);
  });

  it('cleans up by conversation and max entries per source', () => {
    storeContext({
      sourcePackageId: 'source-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-1',
      content: 'one',
      storedAt: '2026-05-10T00:00:00.000Z',
    });
    storeContext({
      sourcePackageId: 'source-1',
      conversationId: 'conversation-2',
      toolUseId: 'tool-2',
      content: 'two',
      storedAt: '2026-05-10T00:01:00.000Z',
    });
    cleanupOlderThan(1);

    expect(getContextsForConversation('conversation-1')).toEqual([]);
    expect(getContextsForConversation('conversation-2')).toHaveLength(1);

    cleanupConversation('conversation-2');
    expect(getContextsForConversation('conversation-2')).toEqual([]);
  });
});
