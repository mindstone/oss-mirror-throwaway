/**
 * Tests for Stage 3: Typed parameter info in tool usage store.
 * Tests the parallel seenParamTypes field, schema-based recording,
 * and typed params propagation to FrequentTool / FrequentToolWithCount.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
const mockStoreState: { store: Record<string, unknown> } = {
  store: {},
};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get store() { return mockStoreState.store; },
    set store(val: Record<string, unknown>) { mockStoreState.store = val; },
  })),
}));

vi.mock('@core/utils/storeMigration', () => ({
  migrateStore: vi.fn((stored: Record<string, unknown>, _opts: unknown) => ({
    data: stored,
    status: 'current',
    shouldPersist: false,
    fromVersion: stored.version ?? 6,
    toVersion: 6,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

// Import after mocks
import {
  recordToolUsage,
  getFrequentTools,
  getFrequentToolsWithCounts,
  getAllToolUsage,
  __resetToolUsageCacheForTests,
  type ParamTypeInfo,
} from '../toolUsageStore';

describe('toolUsageStore — typed params (Stage 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store to default state
    mockStoreState.store = { version: 6, tools: [], lastUpdatedAt: Date.now() };
    // Reset the in-memory cache that was added for EMFILE resilience so
    // state from previous tests doesn't leak into this one.
    __resetToolUsageCacheForTests();
  });

  describe('recordToolUsage with paramTypes', () => {
    it('stores typed param info alongside bare param names', () => {
      const paramTypes: ParamTypeInfo[] = [
        { name: 'to', type: 'string', format: 'email', required: true },
        { name: 'subject', type: 'string', required: true },
        { name: 'cc', type: 'string', format: 'email' },
      ];

      recordToolUsage('GoogleWorkspace/send_email', ['to', 'subject', 'cc'], paramTypes);

      const allTools = getAllToolUsage();
      expect(allTools).toHaveLength(1);
      expect(allTools[0].seenParams).toEqual(['to', 'subject', 'cc']);
      expect(allTools[0].seenParamTypes).toEqual(paramTypes);
    });

    it('records bare params when paramTypes is undefined', () => {
      recordToolUsage('Slack/post_message', ['channel', 'text']);

      const allTools = getAllToolUsage();
      expect(allTools).toHaveLength(1);
      expect(allTools[0].seenParams).toEqual(['channel', 'text']);
      expect(allTools[0].seenParamTypes).toBeUndefined();
    });

    it('merges typed params on subsequent calls (newer takes precedence)', () => {
      // First call: bare params only
      recordToolUsage('GoogleWorkspace/send_email', ['to', 'subject']);

      // Second call: with typed params including a new param
      const paramTypes: ParamTypeInfo[] = [
        { name: 'to', type: 'string', format: 'email', required: true },
        { name: 'subject', type: 'string', required: true },
        { name: 'body', type: 'string', required: true },
      ];
      recordToolUsage('GoogleWorkspace/send_email', ['to', 'subject', 'body'], paramTypes);

      const allTools = getAllToolUsage();
      expect(allTools).toHaveLength(1);
      // Bare params are unioned
      expect(allTools[0].seenParams).toEqual(expect.arrayContaining(['to', 'subject', 'body']));
      // Typed params contain all 3 entries
      expect(allTools[0].seenParamTypes).toHaveLength(3);
      expect(allTools[0].seenParamTypes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'to', format: 'email' }),
          expect.objectContaining({ name: 'body', type: 'string' }),
        ])
      );
    });

    it('updates existing typed param with newer info', () => {
      // First call: basic type info
      const paramTypes1: ParamTypeInfo[] = [
        { name: 'to', type: 'string' },
      ];
      recordToolUsage('GoogleWorkspace/send_email', ['to'], paramTypes1);

      // Second call: more detailed type info (format added)
      const paramTypes2: ParamTypeInfo[] = [
        { name: 'to', type: 'string', format: 'email', required: true },
      ];
      recordToolUsage('GoogleWorkspace/send_email', ['to'], paramTypes2);

      const allTools = getAllToolUsage();
      // Newer info should overwrite
      expect(allTools[0].seenParamTypes).toEqual([
        { name: 'to', type: 'string', format: 'email', required: true },
      ]);
    });
  });

  describe('getFrequentTools with typedParams', () => {
    it('returns typedParams when seenParamTypes is populated', () => {
      const paramTypes: ParamTypeInfo[] = [
        { name: 'to', type: 'string', format: 'email', required: true },
        { name: 'subject', type: 'string', required: true },
      ];

      recordToolUsage('GoogleWorkspace/send_email', ['to', 'subject'], paramTypes);

      const tools = getFrequentTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].typedParams).toEqual(paramTypes);
      // Bare params still present for backwards compatibility
      expect(tools[0].params).toEqual(['to', 'subject']);
    });

    it('returns undefined typedParams when seenParamTypes is empty/missing', () => {
      recordToolUsage('Slack/post_message', ['channel', 'text']);

      const tools = getFrequentTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].typedParams).toBeUndefined();
      expect(tools[0].params).toEqual(['channel', 'text']);
    });
  });

  describe('getFrequentToolsWithCounts with typedParams', () => {
    it('includes typedParams alongside usage counts', () => {
      const paramTypes: ParamTypeInfo[] = [
        { name: 'query', type: 'string', required: true },
      ];

      recordToolUsage('Linear/search_issues', ['query'], paramTypes);
      recordToolUsage('Linear/search_issues', ['query'], paramTypes);

      const tools = getFrequentToolsWithCounts();
      expect(tools).toHaveLength(1);
      expect(tools[0].usageCount).toBe(2);
      expect(tools[0].typedParams).toEqual(paramTypes);
    });
  });

  describe('graceful fallback', () => {
    it('handles empty paramTypes array without crash', () => {
      expect(() => {
        recordToolUsage('Test/tool', ['a', 'b'], []);
      }).not.toThrow();

      const allTools = getAllToolUsage();
      expect(allTools).toHaveLength(1);
      expect(allTools[0].seenParams).toEqual(['a', 'b']);
    });

    it('handles paramTypes with only name (no type/format)', () => {
      const paramTypes: ParamTypeInfo[] = [
        { name: 'query' },
        { name: 'limit' },
      ];

      recordToolUsage('Test/search', ['query', 'limit'], paramTypes);

      const tools = getFrequentTools();
      expect(tools[0].typedParams).toEqual(paramTypes);
    });
  });
});
