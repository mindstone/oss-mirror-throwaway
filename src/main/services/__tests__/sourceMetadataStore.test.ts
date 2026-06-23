/**
 * Tests for sourceMetadataStore.ts
 * 
 * Tests the search functionality for meeting transcripts, emails, and other sources.
 */

import { describe, it, expect, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const stubLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockAccess = vi.fn<(filePath: string) => Promise<void>>();

// Setup fresh module for each test to ensure isolation
const setupModule = async () => {
  vi.resetModules();
  mockAccess.mockReset();
  mockAccess.mockResolvedValue(undefined);
  await initTestPlatformConfig();
  vi.doMock('node:fs/promises', () => ({
    default: {
      access: mockAccess,
    },
    access: mockAccess,
  }));
  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      store: T;
      constructor(options: { defaults: T }) {
        this.store = structuredClone(options.defaults);
      }
      get(key: keyof T) {
        return this.store[key];
      }
      set(key: keyof T, value: T[keyof T]) {
        this.store[key] = value;
      }
    }
    return { default: MemoryStore };
  });
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));
  const store = await import('../sourceMetadataStore');
  // Clear any persisted state from previous tests
  store.clearStore();
  return store;
};

describe('sourceMetadataStore', () => {

  describe('searchSources', () => {
    describe('with no filters', () => {
      it('returns all sources when no params provided', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/16/meeting2.md',
          'memory/sources/2026/01-Jan/16/meeting2.md',
          `---
source_type: meeting
participants:
  - "Bob Smith"
occurred_at: 2026-01-16
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({});

        expect(result.sources).toHaveLength(2);
        expect(result.totalCount).toBe(2);
      });

      it('returns empty array when store is empty', async () => {
        const store = await setupModule();
        const result = await store.searchSources({});

        expect(result.sources).toHaveLength(0);
        expect(result.totalCount).toBe(0);
      });
    });

    describe('participant filtering (current behavior)', () => {
      it('matches participant by substring (case-insensitive)', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
  - "Bob Smith"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['alice'],
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].participants).toContain('Alice Chen');
      });

      it('matches participant by partial name', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Bob Smith"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['bob'],
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].participants).toContain('Bob Smith');
      });

      it('matches participant by last name', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Bob Smith"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['smith'],
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].participants).toContain('Bob Smith');
      });

      it('matches email address by substring', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/16/meeting2.md',
          'memory/sources/2026/01-Jan/16/meeting2.md',
          `---
source_type: meeting
participants:
  - "[external-email]"
occurred_at: 2026-01-16
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['charlie@company'],
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].participants).toContain('[external-email]');
      });

      it('returns empty when no participant matches', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['nonexistent'],
        });

        expect(result.sources).toHaveLength(0);
      });

      it('matches any of multiple participants (OR logic)', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/17/meeting3.md',
          'memory/sources/2026/01-Jan/17/meeting3.md',
          `---
source_type: meeting
participants:
  - "Eve Wilson"
occurred_at: 2026-01-17
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['alice', 'eve'],
        });

        expect(result.sources).toHaveLength(2);
      });

      it('matches email prefix (P1b improvement)', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "[external-email]"
occurred_at: 2026-01-15
---
# Meeting with Alice`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/16/meeting2.md',
          'memory/sources/2026/01-Jan/16/meeting2.md',
          `---
source_type: meeting
participants:
  - "[external-email]"
occurred_at: 2026-01-16
---
# Meeting with Bob`,
          Date.now()
        );

        // "alice" should match "[external-email]"
        const result1 = await store.searchSources({ participants: ['alice'] });
        expect(result1.sources).toHaveLength(1);
        expect(result1.sources[0].participants).toContain('[external-email]');

        // "bob" should match "[external-email]"
        const result2 = await store.searchSources({ participants: ['bob'] });
        expect(result2.sources).toHaveLength(1);
        expect(result2.sources[0].participants).toContain('[external-email]');

        // "charlie" should not match either
        const result3 = await store.searchSources({ participants: ['charlie'] });
        expect(result3.sources).toHaveLength(0);
      });
    });

    describe('date range filtering', () => {
      it('filters by after, before, and combined date range', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/10/meeting1.md',
          'memory/sources/2026/01-Jan/10/meeting1.md',
          `---
source_type: meeting
occurred_at: 2026-01-10
---
# Early January`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting2.md',
          'memory/sources/2026/01-Jan/15/meeting2.md',
          `---
source_type: meeting
occurred_at: 2026-01-15
---
# Mid January`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/20/meeting3.md',
          'memory/sources/2026/01-Jan/20/meeting3.md',
          `---
source_type: meeting
occurred_at: 2026-01-20
---
# Late January`,
          Date.now()
        );

        // Verify we only have 3 sources
        const allSources = await store.searchSources({});
        expect(allSources.sources).toHaveLength(3);

        // Test after filter
        const afterResult = await store.searchSources({
          dateRange: { after: '2026-01-14' },
        });
        expect(afterResult.sources).toHaveLength(2);
        expect(afterResult.sources.every(s => s.occurredAt >= '2026-01-14')).toBe(true);

        // Test before filter
        const beforeResult = await store.searchSources({
          dateRange: { before: '2026-01-16' },
        });
        expect(beforeResult.sources).toHaveLength(2);
        expect(beforeResult.sources.every(s => s.occurredAt <= '2026-01-16')).toBe(true);

        // Test combined range
        const rangeResult = await store.searchSources({
          dateRange: { after: '2026-01-12', before: '2026-01-18' },
        });
        expect(rangeResult.sources).toHaveLength(1);
        expect(rangeResult.sources[0].occurredAt).toBe('2026-01-15');
      });
    });

    describe('source type filtering', () => {
      it('filters by source type', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting.md',
          'memory/sources/2026/01-Jan/15/meeting.md',
          `---
source_type: meeting
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/email.md',
          'memory/sources/2026/01-Jan/15/email.md',
          `---
source_type: email
occurred_at: 2026-01-15
---
# Email`,
          Date.now()
        );

        const result = await store.searchSources({
          sourceTypes: ['meeting'],
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].sourceType).toBe('meeting');
      });

      it('filters by multiple source types', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting.md',
          'memory/sources/2026/01-Jan/15/meeting.md',
          `---
source_type: meeting
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/email.md',
          'memory/sources/2026/01-Jan/15/email.md',
          `---
source_type: email
occurred_at: 2026-01-15
---
# Email`,
          Date.now()
        );

        const result = await store.searchSources({
          sourceTypes: ['meeting', 'email'],
        });

        expect(result.sources).toHaveLength(2);
      });
    });

    describe('combined filters', () => {
      it('applies participant AND date range filters', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting1.md',
          'memory/sources/2026/01-Jan/15/meeting1.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/20/meeting2.md',
          'memory/sources/2026/01-Jan/20/meeting2.md',
          `---
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-20
---
# Meeting`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/meeting3.md',
          'memory/sources/2026/01-Jan/15/meeting3.md',
          `---
source_type: meeting
participants:
  - "Bob Smith"
occurred_at: 2026-01-15
---
# Meeting`,
          Date.now()
        );

        const result = await store.searchSources({
          participants: ['alice'],
          dateRange: { before: '2026-01-18' },
        });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].occurredAt).toBe('2026-01-15');
        expect(result.sources[0].participants).toContain('Alice Chen');
      });
    });

    describe('query-based search (text + semantic)', () => {
      it('finds sources by participant name in query', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/Chief-of-Staff/memory/sources/2026/01-Jan/15/meeting1.md',
          'Chief-of-Staff/memory/sources/2026/01-Jan/15/meeting1.md',
          `---
title: Meeting with Diana
source_type: meeting
participants:
  - "Diana Davis"
  - "Carol Chen"
occurred_at: 2026-01-15
---
## Summary
Discussed product roadmap.`,
          Date.now()
        );
        store.indexSource(
          '/workspace/Chief-of-Staff/memory/sources/2026/01-Jan/16/meeting2.md',
          'Chief-of-Staff/memory/sources/2026/01-Jan/16/meeting2.md',
          `---
title: Design Review
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-16
---
## Summary
Reviewed design mockups.`,
          Date.now()
        );

        const result = await store.searchSources({ query: 'diana' });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].participants).toContain('Diana Davis');
      });

      it('finds sources by title text in query', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/work/memory/sources/2026/01-Jan/15/slack.md',
          'work/memory/sources/2026/01-Jan/15/slack.md',
          `---
title: slack-carol-diana-dm-cost-quality-debate
source_type: recording
occurred_at: 2026-01-15
---
## Summary
Debated cost vs quality tradeoffs.`,
          Date.now()
        );

        const result = await store.searchSources({ query: 'diana' });

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].title).toContain('diana');
      });

      it('merges text matches with semantic search results', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/space1/memory/sources/2026/01-Jan/15/meeting1.md',
          'space1/memory/sources/2026/01-Jan/15/meeting1.md',
          `---
title: Meeting with Diana
source_type: meeting
participants:
  - "Diana Davis"
occurred_at: 2026-01-15
---
## Summary
Discussed roadmap.`,
          Date.now()
        );
        store.indexSource(
          '/workspace/space2/memory/sources/2026/01-Jan/16/meeting2.md',
          'space2/memory/sources/2026/01-Jan/16/meeting2.md',
          `---
title: Product Strategy
source_type: meeting
participants:
  - "Alice Chen"
occurred_at: 2026-01-16
---
## Summary
Talked about strategy.`,
          Date.now()
        );

        // Semantic search returns the second meeting (conceptual match)
        const mockSemanticSearch = vi.fn().mockResolvedValue({
          status: 'ok',
          results: [
            { relativePath: 'space2/memory/sources/2026/01-Jan/16/meeting2.md', score: 0.8 },
          ],
        });

        const result = await store.searchSources(
          { query: 'diana' },
          mockSemanticSearch,
        );

        // Should have both: text match (Diana in participants) + semantic match
        expect(result.sources).toHaveLength(2);
        expect(result.status).toBe('ok');
        const paths = result.sources.map((s) => s.relativePath);
        expect(paths).toContain('space1/memory/sources/2026/01-Jan/15/meeting1.md');
        expect(paths).toContain('space2/memory/sources/2026/01-Jan/16/meeting2.md');
      });

      it('works with space-prefixed paths (no pathPrefix filter)', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/Chief-of-Staff/memory/sources/2026/03/meeting.md',
          'Chief-of-Staff/memory/sources/2026/03/meeting.md',
          `---
title: Cost quality debate
source_type: meeting
participants:
  - "Diana Davis"
occurred_at: 2026-03-26
---
## Summary
Discussed costs.`,
          Date.now()
        );

        // Semantic search returns the result (proving no pathPrefix filter blocks it)
        const mockSemanticSearch = vi.fn().mockResolvedValue({
          status: 'ok',
          results: [
            { relativePath: 'Chief-of-Staff/memory/sources/2026/03/meeting.md', score: 0.7 },
          ],
        });

        const result = await store.searchSources(
          { query: 'cost debate' },
          mockSemanticSearch,
        );

        expect(result.sources).toHaveLength(1);
        // Verify semantic search was called WITHOUT pathPrefix
        expect(mockSemanticSearch).toHaveBeenCalledWith('cost debate', {
          limit: 200,
          threshold: 0.2,
        });
      });
    });

    describe('status signalling (hybrid honesty)', () => {
      const indexDiana = (store: Awaited<ReturnType<typeof setupModule>>) => {
        store.indexSource(
          '/workspace/space1/memory/sources/2026/01-Jan/15/meeting1.md',
          'space1/memory/sources/2026/01-Jan/15/meeting1.md',
          `---
title: Meeting with Diana
source_type: meeting
participants:
  - "Diana Davis"
occurred_at: 2026-01-15
---
## Summary
Discussed roadmap.`,
          Date.now()
        );
      };

      it('returns ok when no query is given (semantic not needed)', async () => {
        const store = await setupModule();
        indexDiana(store);
        const mockSemanticSearch = vi.fn();

        const result = await store.searchSources({}, mockSemanticSearch);

        expect(result.status).toBe('ok');
        expect(mockSemanticSearch).not.toHaveBeenCalled();
      });

      it('returns ok when semantic search succeeds', async () => {
        const store = await setupModule();
        indexDiana(store);
        const mockSemanticSearch = vi.fn().mockResolvedValue({ status: 'ok', results: [] });

        const result = await store.searchSources({ query: 'diana' }, mockSemanticSearch);

        expect(result.status).toBe('ok');
        // Text match still found Diana even though semantic returned nothing.
        expect(result.sources).toHaveLength(1);
      });

      it('returns ok with results when semantic is down but text matches (graceful, shown silently)', async () => {
        const store = await setupModule();
        indexDiana(store);
        const mockSemanticSearch = vi.fn().mockResolvedValue({ status: 'error', results: [] });

        // Query matches Diana via text (title/participants), so results are present.
        const result = await store.searchSources({ query: 'diana' }, mockSemanticSearch);

        // Honest rule: results present + semantic-down → status carries the
        // failure but the bridge will show results as success:true.
        expect(result.status).toBe('error');
        expect(result.sources).toHaveLength(1);
      });

      it('returns non-ok and empty when semantic is down and there is no text match', async () => {
        const store = await setupModule();
        indexDiana(store);
        const mockSemanticSearch = vi.fn().mockResolvedValue({ status: 'index_not_ready', results: [] });

        // Conceptual query with no title/participant/summary substring match.
        const result = await store.searchSources({ query: 'photosynthesis' }, mockSemanticSearch);

        expect(result.status).toBe('index_not_ready');
        expect(result.sources).toHaveLength(0);
      });

      it('skips the semantic call (status ok) when filters leave zero candidates', async () => {
        const store = await setupModule();
        indexDiana(store);
        // A non-ok semantic fn that must NOT be called: restrictive filters
        // leave zero candidates, so a pre-filtered-empty result is an honest
        // "no sources", not "unavailable".
        const mockSemanticSearch = vi.fn().mockResolvedValue({ status: 'error', results: [] });

        const result = await store.searchSources(
          { query: 'diana', sourceTypes: ['email'] }, // Diana is a 'meeting'
          mockSemanticSearch,
        );

        expect(result.status).toBe('ok');
        expect(result.sources).toHaveLength(0);
        expect(mockSemanticSearch).not.toHaveBeenCalled();
      });
    });

    describe('limit', () => {
      it('respects limit parameter', async () => {
        const store = await setupModule();
        for (let i = 1; i <= 5; i++) {
          store.indexSource(
            `/workspace/memory/sources/2026/01-Jan/${i}/meeting.md`,
            `memory/sources/2026/01-Jan/${i}/meeting.md`,
            `---
source_type: meeting
occurred_at: 2026-01-0${i}
---
# Meeting ${i}`,
            Date.now()
          );
        }

        const result = await store.searchSources({ limit: 3 });

        expect(result.sources).toHaveLength(3);
        expect(result.totalCount).toBe(5);
      });
    });

    describe('stale file pruning', () => {
      it('filters missing files from search results and prunes them from the store', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/15/existing.md',
          'memory/sources/2026/01-Jan/15/existing.md',
          `---
source_type: meeting
occurred_at: 2026-01-15
---
# Existing`,
          Date.now()
        );
        store.indexSource(
          '/workspace/memory/sources/2026/01-Jan/16/missing.md',
          'memory/sources/2026/01-Jan/16/missing.md',
          `---
source_type: meeting
occurred_at: 2026-01-16
---
# Missing`,
          Date.now()
        );
        mockAccess.mockImplementation(async (filePath) => {
          if (filePath === '/workspace/memory/sources/2026/01-Jan/16/missing.md') {
            const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
        });

        const result = await store.searchSources({});

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].filePath).toBe('/workspace/memory/sources/2026/01-Jan/15/existing.md');
        expect(store.getSource('/workspace/memory/sources/2026/01-Jan/16/missing.md')).toBeUndefined();
      });

      it('can remove source metadata by relative path', async () => {
        const store = await setupModule();
        store.indexSource(
          '/workspace/Chief-of-Staff/memory/sources/2026/04-Apr/30/source.md',
          'Chief-of-Staff/memory/sources/2026/04-Apr/30/source.md',
          `---
source_type: slack
occurred_at: 2026-04-30
---
# Source`,
          Date.now()
        );

        store.removeSource('Chief-of-Staff/memory/sources/2026/04-Apr/30/source.md');

        expect(store.getAllSources()).toHaveLength(0);
      });
    });
  });
});
