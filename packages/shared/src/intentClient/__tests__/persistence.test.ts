import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryChatStatePersistence,
  runChatStatePersistenceConformance,
  type PersistedChatState,
} from '../persistence';

const SAMPLE_STATE: PersistedChatState = {
  conversationId: 'conv-123',
  conversationTitle: 'Weekly plan',
  createdAt: 1_714_209_600_000,
  pageTitle: 'Roadmap',
  pageUrl: 'https://example.com/roadmap',
};

describe('runChatStatePersistenceConformance', () => {
  it('passes for in-memory persistence', async () => {
    const persistence = createInMemoryChatStatePersistence();
    const result = await runChatStatePersistenceConformance(
      persistence,
      SAMPLE_STATE,
    );

    expect(result).toEqual({
      initialState: null,
      afterSetState: SAMPLE_STATE,
      afterClearState: null,
    });
  });
});

describe('createInMemoryChatStatePersistence', () => {
  it('notifies subscribers on set and clear', async () => {
    const persistence = createInMemoryChatStatePersistence();
    const onChange = vi.fn();
    const unsubscribe = persistence.subscribe?.(onChange);

    expect(typeof unsubscribe).toBe('function');

    await persistence.set(SAMPLE_STATE);
    await persistence.clear();

    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe?.();
    await persistence.set(SAMPLE_STATE);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
