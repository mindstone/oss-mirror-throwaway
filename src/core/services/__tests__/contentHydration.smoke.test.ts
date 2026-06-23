import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ContentRef } from '@shared/types/agent';
import type { ContentStore } from '@core/contentStore';
import type { Logger } from '@core/logger';
import { ContentHydrationCache } from '../contentHydrationCache';
import { hydrateContentRefs, isHydratedContent } from '../contentHydration';

describe('content_ref hydration smoke trace', () => {
  it('round-trips a contentRef through hydrateContentRefs', async () => {
    const sessionId = 'smoke-session';
    const contentId = 'smoke-content-id-1234567890123456';
    const payload = Buffer.from('smoke payload from content store', 'utf8');
    const contentRef: ContentRef = {
      contentId,
      mimeType: 'text/plain',
      byteSize: payload.byteLength,
      summary: 'smoke payload from content store',
    };

    const contentStore = {
      readContent: async () => ({
        reason: 'ok' as const,
        bytes: payload,
        mimeType: 'text/plain',
        byteSize: payload.byteLength,
      }),
    } as unknown as ContentStore;

    const log = {
      warn: () => undefined,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;

    const [hydrated] = await hydrateContentRefs([contentRef], {
      sessionId,
      contentStore,
      cache: new ContentHydrationCache(),
      log,
    });

    expect(hydrated).toBeDefined();
    expect(isHydratedContent(hydrated!)).toBe(true);
    if (hydrated && isHydratedContent(hydrated)) {
      expect(hydrated.contentRef.contentId).toBe(contentId);
      expect(hydrated.bytes.toString('utf8')).toBe('smoke payload from content store');
      expect(hydrated.mimeType).toBe('text/plain');
    }
  });
});
