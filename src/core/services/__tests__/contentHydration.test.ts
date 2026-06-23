import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Logger } from '@core/logger';
import type { ContentRef } from '@shared/types/agent';
import type { ContentStore } from '@core/contentStore';
import { ContentHydrationCache } from '../contentHydrationCache';
import {
  hydrateContentRef,
  hydrateContentRefs,
  isHydratedContent,
  type ContentDownloader,
} from '../contentHydration';
import { resetContentResolutionFailuresForTests, getRecentFailures } from '../contentResolutionFailureRecorder';

function createMockLog(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeContentStore(overrides: Partial<ContentStore> = {}): ContentStore {
  return {
    writeContent: vi.fn(),
    readContent: vi.fn().mockResolvedValue({ reason: 'not-found' }),
    hasContent: vi.fn(),
    listSessionContent: vi.fn(),
    deleteSession: vi.fn(),
    moveSessionContentToDeleted: vi.fn(),
    restoreSessionContentFromDeleted: vi.fn(),
    ...overrides,
  } as unknown as ContentStore;
}

const SAMPLE_REF: ContentRef = {
  contentId: 'a'.repeat(32),
  mimeType: 'text/plain',
  byteSize: 12,
  summary: 'hello world!',
};

describe('hydrateContentRef', () => {
  beforeEach(() => {
    resetContentResolutionFailuresForTests();
  });

  it('returns ok with bytes when local store hits', async () => {
    const bytes = Buffer.from('hello world!', 'utf8');
    const store = makeContentStore({
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes,
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
      }),
    });
    const cache = new ContentHydrationCache();
    const result = await hydrateContentRef(SAMPLE_REF, 'sess-1', {
      contentStore: store,
      cache,
      log: createMockLog(),
    });
    expect(isHydratedContent(result)).toBe(true);
    if (isHydratedContent(result)) {
      expect(result.bytes.toString('utf8')).toBe('hello world!');
      expect(result.mimeType).toBe('text/plain');
    }
  });

  it('falls back to cloud client on local missing', async () => {
    const store = makeContentStore({
      readContent: vi.fn().mockResolvedValue({ reason: 'not-found' }),
    });
    const cloudBytes = Buffer.from('cloud copy', 'utf8');
    const cloudClient: ContentDownloader = {
      downloadContent: vi.fn().mockResolvedValue({ bytes: cloudBytes, mimeType: 'text/plain' }),
    };
    const result = await hydrateContentRef(SAMPLE_REF, 'sess-1', {
      contentStore: store,
      cache: new ContentHydrationCache(),
      cloudClient,
      log: createMockLog(),
    });
    expect(isHydratedContent(result)).toBe(true);
    if (isHydratedContent(result)) {
      expect(result.bytes.toString('utf8')).toBe('cloud copy');
    }
    expect(cloudClient.downloadContent).toHaveBeenCalled();
  });

  it('returns missing failure when no cloud and local missing', async () => {
    const result = await hydrateContentRef(SAMPLE_REF, 'sess-x', {
      contentStore: makeContentStore(),
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    expect(isHydratedContent(result)).toBe(false);
    if (!isHydratedContent(result)) {
      expect(result.reason).toBe('missing');
    }
    expect(getRecentFailures()).toHaveLength(1);
  });

  it('maps pending-upload when local missing and ref.uploadStatus is pending', async () => {
    const pendingRef: ContentRef = { ...SAMPLE_REF, uploadStatus: 'pending' };
    const result = await hydrateContentRef(pendingRef, 'sess-2', {
      contentStore: makeContentStore(),
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    if (!isHydratedContent(result)) {
      expect(result.reason).toBe('pending-upload');
    }
  });

  it('returns missing when local and cloud both return missing', async () => {
    const cloudClient: ContentDownloader = {
      downloadContent: vi.fn().mockResolvedValue({ reason: 'missing' }),
    };
    const result = await hydrateContentRef(SAMPLE_REF, 'sess-m', {
      contentStore: makeContentStore(),
      cloudClient,
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    expect(isHydratedContent(result)).toBe(false);
    if (!isHydratedContent(result)) {
      expect(result.reason).toBe('missing');
    }
  });

  it('returns fetch-failed on cloud network errors', async () => {
    const cloudClient: ContentDownloader = {
      downloadContent: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    const result = await hydrateContentRef(SAMPLE_REF, 'sess-net', {
      contentStore: makeContentStore(),
      cloudClient,
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    expect(isHydratedContent(result)).toBe(false);
    if (!isHydratedContent(result)) {
      expect(result.reason).toBe('fetch-failed');
    }
  });

  it('uses cache on second hit', async () => {
    const bytes = Buffer.from('cached', 'utf8');
    const readSpy = vi.fn().mockResolvedValue({
      reason: 'ok',
      bytes,
      mimeType: 'text/plain',
      byteSize: bytes.byteLength,
    });
    const store = makeContentStore({ readContent: readSpy });
    const cache = new ContentHydrationCache();
    await hydrateContentRef(SAMPLE_REF, 'sess-1', { contentStore: store, cache, log: createMockLog() });
    await hydrateContentRef(SAMPLE_REF, 'sess-1', { contentStore: store, cache, log: createMockLog() });
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateContentRefs', () => {
  it('returns empty array for empty input', async () => {
    const out = await hydrateContentRefs([], {
      contentStore: makeContentStore(),
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    expect(out).toEqual([]);
  });

  it('hydrates mixed refs in order', async () => {
    const store = makeContentStore({
      readContent: vi.fn()
        .mockResolvedValueOnce({
          reason: 'ok',
          bytes: Buffer.from('first', 'utf8'),
          mimeType: 'text/plain',
          byteSize: 5,
        })
        .mockResolvedValueOnce({ reason: 'not-found' }),
    });
    const refs: ContentRef[] = [
      SAMPLE_REF,
      { ...SAMPLE_REF, contentId: 'b'.repeat(32) },
    ];
    const out = await hydrateContentRefs(refs, {
      sessionId: 'sess-order',
      contentStore: store,
      cache: new ContentHydrationCache(),
      log: createMockLog(),
    });
    expect(out).toHaveLength(2);
    expect(isHydratedContent(out[0])).toBe(true);
    expect(isHydratedContent(out[1])).toBe(false);
  });
});
