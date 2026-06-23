/**
 * Producer-side `materializeContentRefsForEvent` unit tests.
 *
 * Mirrors `imageAssetMaterialization.test.ts` for the non-image dimension.
 * Asserts:
 *  - Blocks above the threshold are offloaded and replaced with `content_ref`
 *  - Blocks at/below the threshold stay inline
 *  - desktop surface ⇒ uploadStatus 'pending'; cloud ⇒ 'uploaded'
 *  - Producer falls back to inline content on storage-write failure
 *  - Unknown block shapes pass through untouched
 *  - Summary preserves a leading text snippet for renderer preview
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ContentStore } from '@core/contentStore';
import { CONTENT_REF_THRESHOLD_BYTES } from '@core/contentStore';
import { materializeContentRefsForEvent } from '../contentMaterialization';

function createMockContentStore(): ContentStore & {
  writeContent: ReturnType<typeof vi.fn>;
} {
  return {
    writeContent: vi.fn(async ({ contentId, mimeType, bytes }) => ({
      ref: { contentId, mimeType, byteSize: bytes.byteLength, etag: contentId },
      status: 'created' as const,
    })),
    readContent: vi.fn(async () => ({ reason: 'not-found' as const })),
    hasContent: vi.fn(async () => ({ has: false })),
    listSessionContent: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    moveSessionContentToDeleted: vi.fn(async () => undefined),
    restoreSessionContentFromDeleted: vi.fn(async () => undefined),
  };
}

function makeLargeTextBlock(): { type: 'text'; text: string } {
  return { type: 'text', text: 'x'.repeat(CONTENT_REF_THRESHOLD_BYTES + 256) };
}

function makeSmallTextBlock(): { type: 'text'; text: string } {
  return { type: 'text', text: 'hello world' };
}

describe('materializeContentRefsForEvent', () => {
  it.each([
    { surface: 'desktop' as const, expectedUploadStatus: 'pending' as const },
    { surface: 'cloud' as const, expectedUploadStatus: 'uploaded' as const },
  ])(
    'offloads above-threshold blocks on $surface with uploadStatus=$expectedUploadStatus',
    async ({ surface, expectedUploadStatus }) => {
      const contentStore = createMockContentStore();
      const block = makeLargeTextBlock();
      const expectedBytes = Buffer.from(block.text, 'utf8');
      const expectedId = createHash('sha256').update(expectedBytes).digest('hex').slice(0, 32);

      const result = await materializeContentRefsForEvent(
        {
          sessionId: 'sess-1',
          turnId: 'turn-1',
          eventSeq: 7,
          content: [block],
          surface,
        },
        contentStore,
      );

      expect(result.failures).toEqual([]);
      expect(result.refs[0]).toMatchObject({
        contentId: expectedId,
        mimeType: 'text/plain',
        byteSize: expectedBytes.byteLength,
        etag: expectedId,
        uploadStatus: expectedUploadStatus,
      });
      expect((result.refs[0] as { summary: string }).summary.length).toBeGreaterThan(0);
      expect((result.content[0] as { type: string }).type).toBe('content_ref');
      expect(contentStore.writeContent).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps small blocks inline and unchanged', async () => {
    const contentStore = createMockContentStore();
    const block = makeSmallTextBlock();

    const result = await materializeContentRefsForEvent(
      {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        eventSeq: 7,
        content: [block],
        surface: 'desktop',
      },
      contentStore,
    );

    expect(result.failures).toEqual([]);
    expect(result.refs).toEqual([null]);
    expect(result.content[0]).toEqual(block);
    expect(contentStore.writeContent).not.toHaveBeenCalled();
  });

  it('falls back to inline content on storage write failure', async () => {
    const contentStore = createMockContentStore();
    const storageErr = Object.assign(new Error('disk full'), { code: 'storage-full' });
    (contentStore.writeContent as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw storageErr;
    });

    const block = makeLargeTextBlock();
    const result = await materializeContentRefsForEvent(
      {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        eventSeq: 7,
        content: [block],
        surface: 'desktop',
      },
      contentStore,
    );

    expect(result.failures).toEqual([
      expect.objectContaining({ index: 0, reason: 'storage-full' }),
    ]);
    expect(result.refs[0]).toBeNull();
    expect(result.content[0]).toEqual(block);
  });

  it('mixes offloaded and inline blocks at the boundary', async () => {
    const contentStore = createMockContentStore();
    const blocks = [
      makeSmallTextBlock(),
      makeLargeTextBlock(),
      makeSmallTextBlock(),
    ];

    const result = await materializeContentRefsForEvent(
      {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        eventSeq: 11,
        content: blocks,
        surface: 'desktop',
      },
      contentStore,
    );

    expect(contentStore.writeContent).toHaveBeenCalledTimes(1);
    expect(result.refs[0]).toBeNull();
    expect(result.refs[1]).toMatchObject({ uploadStatus: 'pending' });
    expect(result.refs[2]).toBeNull();
    expect((result.content[1] as { type: string }).type).toBe('content_ref');
    expect(result.content[0]).toEqual(blocks[0]);
    expect(result.content[2]).toEqual(blocks[2]);
  });

  it('classifies unknown error codes as unknown reason', async () => {
    const contentStore = createMockContentStore();
    (contentStore.writeContent as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const result = await materializeContentRefsForEvent(
      {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        eventSeq: 0,
        content: [makeLargeTextBlock()],
        surface: 'desktop',
      },
      contentStore,
    );

    expect(result.failures[0]).toMatchObject({ index: 0, reason: 'unknown' });
    expect(result.refs[0]).toBeNull();
  });

  it('skips already-offloaded content_ref blocks', async () => {
    const contentStore = createMockContentStore();
    const block = {
      type: 'content_ref',
      contentRef: { contentId: 'abc', mimeType: 'text/plain', byteSize: 1, etag: 'abc' },
    };

    const result = await materializeContentRefsForEvent(
      {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        eventSeq: 0,
        content: [block],
        surface: 'desktop',
      },
      contentStore,
    );

    expect(contentStore.writeContent).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual(block);
    expect(result.refs[0]).toBeNull();
  });
});
