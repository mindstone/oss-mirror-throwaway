import { describe, it, expect, vi } from 'vitest';
import {
  prefetchDocuments,
  formatPrefetchedDocumentsContext,
  type PrefetchDocumentFn,
  type PrefetchResult,
  type ServerInstanceInfo,
} from '../documentPrefetchService';
import type { ConnectorCatalog } from '@shared/types';
import type { ExtractedUrl } from '../urlDetectionService';

const makeUrl = (url: string, domain: string): ExtractedUrl => ({ url, domain, fullMatch: url });

const makeCatalog = (): ConnectorCatalog => ({
  connectors: [
    {
      id: 'bundled-google',
      name: 'Google Workspace',
      description: 'Google Workspace',
      urlPatterns: [
        {
          pattern: 'https?://docs\\.google\\.com/document/(?:u/\\d+/)?d/(?<id>[a-zA-Z0-9_-]+)',
          tool: 'read_workspace_document',
          extractArgs: { group: 'id', param: 'documentId' },
          label: 'Google Docs',
        },
        {
          pattern: 'https?://docs\\.google\\.com/spreadsheets/(?:u/\\d+/)?d/(?<id>[a-zA-Z0-9_-]+)',
          tool: 'read_workspace_spreadsheet',
          extractArgs: { group: 'id', param: 'spreadsheetId' },
          label: 'Google Sheets',
        },
      ],
    },
  ],
} as ConnectorCatalog);

const makeInstances = (): ServerInstanceInfo[] => [
  { instanceId: 'GoogleWorkspace-test-com', catalogId: 'bundled-google', isDisabled: false },
];

const successFn: PrefetchDocumentFn = async ({ args }) => ({
  content: `Document content for ${args.documentId ?? args.spreadsheetId ?? 'unknown'}`,
  charCount: 50,
  isMaterialized: false,
});

describe('prefetchDocuments', () => {
  it('returns empty array when no URLs provided', async () => {
    const results = await prefetchDocuments([], makeCatalog(), makeInstances(), successFn);
    expect(results).toEqual([]);
  });

  it('returns empty array when no URLs match catalog patterns', async () => {
    const urls = [makeUrl('https://example.com/page', 'example.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), successFn);
    expect(results).toEqual([]);
  });

  it('successfully prefetches a Google Docs URL', async () => {
    const urls = [makeUrl('https://docs.google.com/document/d/abc123/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), successFn);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('fetched');
    expect(results[0]?.content).toContain('abc123');
    expect(results[0]?.serverInstanceId).toBe('GoogleWorkspace-test-com');
    expect(results[0]?.label).toBe('Google Docs');
  });

  it('prefetches multiple URLs in parallel', async () => {
    const urls = [
      makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/spreadsheets/d/sheet1/edit', 'docs.google.com'),
    ];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), successFn);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'fetched')).toBe(true);
  });

  it('returns materialized status when fetchDocument reports materialization', async () => {
    const materializedFn: PrefetchDocumentFn = async () => ({
      content: 'preview text...',
      charCount: 200_000,
      isMaterialized: true,
      materializedPath: '.rebel/tool-outputs/260403_1430_prefetch_abc.json',
    });

    const urls = [makeUrl('https://docs.google.com/document/d/bigdoc/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), materializedFn);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('materialized');
    expect(results[0]?.materializedPath).toContain('.rebel/tool-outputs/');
  });

  it('marks inline docs as failed when exceeding per-doc inline limit', async () => {
    const largeFn: PrefetchDocumentFn = async () => ({
      content: 'x'.repeat(20_000),
      charCount: 20_000,
      isMaterialized: false,
    });

    const urls = [makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), largeFn, {
      inlineCharLimit: 15_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('too large');
  });

  it('enforces total inline character budget across multiple docs', async () => {
    const mediumFn: PrefetchDocumentFn = async () => ({
      content: 'x'.repeat(14_000),
      charCount: 14_000,
      isMaterialized: false,
    });

    const urls = [
      makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/document/d/doc2/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/document/d/doc3/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/document/d/doc4/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/document/d/doc5/edit', 'docs.google.com'),
    ];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), mediumFn, {
      inlineCharLimit: 15_000,
      totalInlineCharLimit: 60_000,
    });

    const fetchedCount = results.filter(r => r.status === 'fetched').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    expect(fetchedCount).toBe(4); // 4 * 14K = 56K < 60K
    expect(failedCount).toBe(1); // 5th would be 70K > 60K
  });

  it('limits URLs to maxUrls setting', async () => {
    const fetchFn = vi.fn(successFn);
    const urls = Array.from({ length: 7 }, (_, i) =>
      makeUrl(`https://docs.google.com/document/d/doc${i}/edit`, 'docs.google.com')
    );

    await prefetchDocuments(urls, makeCatalog(), makeInstances(), fetchFn, { maxUrls: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('handles fetch failures gracefully', async () => {
    const failingFn: PrefetchDocumentFn = async () => {
      throw new Error('Connection timeout');
    };

    const urls = [makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), failingFn);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toBe('Connection timeout');
  });

  it('returns failed when no active server instance matches', async () => {
    const urls = [makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), [], successFn);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('No active connector');
  });

  it('skips disabled server instances', async () => {
    const disabledInstances: ServerInstanceInfo[] = [
      { instanceId: 'GoogleWorkspace-test-com', catalogId: 'bundled-google', isDisabled: true },
    ];

    const urls = [makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com')];
    const results = await prefetchDocuments(urls, makeCatalog(), disabledInstances, successFn);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
  });

  it('handles mixed success and failure', async () => {
    let callCount = 0;
    const mixedFn: PrefetchDocumentFn = async () => {
      callCount++;
      if (callCount === 2) throw new Error('Auth failed');
      return { content: 'content', charCount: 100, isMaterialized: false };
    };

    const urls = [
      makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com'),
      makeUrl('https://docs.google.com/document/d/doc2/edit', 'docs.google.com'),
    ];
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), mixedFn);

    expect(results).toHaveLength(2);
    const statuses = results.map(r => r.status);
    expect(statuses).toContain('fetched');
    expect(statuses).toContain('failed');
  });

  it('respects total deadline timeout', async () => {
    const slowFn: PrefetchDocumentFn = async () => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      return { content: 'late', charCount: 4, isMaterialized: false };
    };

    const urls = [makeUrl('https://docs.google.com/document/d/doc1/edit', 'docs.google.com')];
    const start = Date.now();
    const results = await prefetchDocuments(urls, makeCatalog(), makeInstances(), slowFn, {
      totalTimeoutMs: 200,
    });
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('deadline');
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('formatPrefetchedDocumentsContext', () => {
  it('returns undefined when all results are failed', () => {
    const results: PrefetchResult[] = [
      { url: 'https://example.com', status: 'failed', error: 'timeout' },
    ];
    expect(formatPrefetchedDocumentsContext(results)).toBeUndefined();
  });

  it('formats fetched documents with inline content', () => {
    const results: PrefetchResult[] = [
      { url: 'https://docs.google.com/document/d/abc', status: 'fetched', content: 'Hello world', charCount: 11 },
    ];
    const context = formatPrefetchedDocumentsContext(results);
    expect(context).toContain('<document');
    expect(context).toContain('status="fetched"');
    expect(context).toContain('Hello world');
  });

  it('formats materialized documents with file path and preview', () => {
    const results: PrefetchResult[] = [
      {
        url: 'https://docs.google.com/spreadsheets/d/xyz',
        status: 'materialized',
        materializedPath: '.rebel/tool-outputs/test.json',
        charCount: 200_000,
        preview: 'First 2KB...',
      },
    ];
    const context = formatPrefetchedDocumentsContext(results);
    expect(context).toContain('status="materialized"');
    expect(context).toContain('.rebel/tool-outputs/test.json');
    expect(context).toContain('First 2KB...');
  });

  it('includes failed entries with error messages', () => {
    const results: PrefetchResult[] = [
      { url: 'https://docs.google.com/document/d/abc', status: 'fetched', content: 'content', charCount: 7 },
      { url: 'https://docs.google.com/document/d/def', status: 'failed', error: 'Auth required' },
    ];
    const context = formatPrefetchedDocumentsContext(results);
    expect(context).toContain('Auth required');
    expect(context).toContain('content');
  });
});
