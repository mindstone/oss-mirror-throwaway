import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ChatMessage } from '../../modelTypes';
import { toAnthropicMessages } from '../anthropicClient';
import { TurnScopedContentHydrationCache } from '@core/services/contentHydrationCache';
import type { ContentDownloader } from '@core/services/contentHydration';
import * as contentStoreModule from '@core/contentStore';

 
vi.mock('@core/contentStore', async () => {
  const actual = await vi.importActual<typeof contentStoreModule>('@core/contentStore');
  return {
    ...actual,
    getContentStore: vi.fn(),
  };
});

const SAMPLE_REF = {
  contentId: 'c'.repeat(32),
  mimeType: 'text/plain',
  byteSize: 12,
  summary: 'preview…',
};

describe('toAnthropicMessages content_ref translation', () => {
  it('hydrates content_ref blocks to inline text blocks before dispatch', async () => {
    const bytes = Buffer.from('hello full content', 'utf8');
    const mockStore = {
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes,
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
      }),
    };
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue(mockStore as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF, summary: 'preview…' } as never,
            ],
          },
        ],
      },
    ];

    const translated = await toAnthropicMessages(
      messages,
      true, // supportsImageContent
      'sess-1',
      undefined,
      new TurnScopedContentHydrationCache(),
    ) as unknown as Array<{
      content: Array<{ content: Array<Record<string, unknown>> }>;
    }>;

    const block = translated[0].content[0].content[0];
    expect(block?.type).toBe('text');
    expect(block?.text).toBe('hello full content');
    expect(block?.__hydratedBlock).toBeUndefined();
  });

  it('falls back to a structured "[Tool output unavailable]" text on failed hydration', async () => {
    const mockStore = {
      readContent: vi.fn().mockResolvedValue({ reason: 'not-found' }),
    };
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue(mockStore as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF } as never,
            ],
          },
        ],
      },
    ];

    const translated = await toAnthropicMessages(
      messages,
      true, // supportsImageContent
      'sess-2',
      undefined,
      new TurnScopedContentHydrationCache(),
    ) as unknown as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;

    const block = translated[0].content[0].content[0];
    expect(block?.type).toBe('text');
    expect(block?.text).toMatch(/Tool output unavailable/);
  });

  it('uses cloud client on local missing when present', async () => {
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue({
      readContent: vi.fn().mockResolvedValue({ reason: 'not-found' }),
    } as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

    const cloudClient: ContentDownloader = {
      downloadContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes: Buffer.from('cloud copy', 'utf8'),
        mimeType: 'text/plain',
      }),
    };

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF } as never,
            ],
          },
        ],
      },
    ];

    const translated = await toAnthropicMessages(
      messages,
      true, // supportsImageContent
      'sess-3',
      undefined,
      new TurnScopedContentHydrationCache(),
      cloudClient,
    ) as unknown as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;

    const block = translated[0].content[0].content[0];
    expect(block?.type).toBe('text');
    expect(block?.text).toBe('cloud copy');
    expect(cloudClient.downloadContent).toHaveBeenCalled();
  });

  it('applies middle-truncation marker for content_ref hydrated text exceeding budget', async () => {
    const huge = 'x'.repeat(800_000);
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue({
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes: Buffer.from(huge, 'utf8'),
        mimeType: 'text/plain',
        byteSize: huge.length,
      }),
    } as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-4',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF } as never,
              { type: 'content_ref', contentRef: { ...SAMPLE_REF, contentId: 'd'.repeat(32) } } as never,
            ],
          },
        ],
      },
    ];

    const translated = await toAnthropicMessages(
      messages,
      true, // supportsImageContent
      'sess-4',
      undefined,
      new TurnScopedContentHydrationCache(),
    ) as unknown as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;

    const tool = translated[0].content[0].content;
    const totalBytes = tool.reduce((sum, block) => sum + (typeof block.text === 'string' ? Buffer.byteLength(block.text, 'utf8') : 0), 0);
    expect(totalBytes).toBeLessThanOrEqual(180_000 * 4);
    const hasMarker = tool.some((b) => typeof b.text === 'string' && /truncated/.test(b.text));
    expect(hasMarker).toBe(true);
  });
});
