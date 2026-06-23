import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ChatMessage } from '../../modelTypes';
import { translateMessagesToOpenAI } from '../openaiTranslators';
import { TurnScopedContentHydrationCache } from '@core/services/contentHydrationCache';
import * as contentStoreModule from '@core/contentStore';

 
vi.mock('@core/contentStore', async () => {
  const actual = await vi.importActual<typeof contentStoreModule>('@core/contentStore');
  return {
    ...actual,
    getContentStore: vi.fn(),
  };
});

const SAMPLE_REF = {
  contentId: 'a'.repeat(32),
  mimeType: 'text/plain',
  byteSize: 19,
  summary: 'preview',
};

describe('translateMessagesToOpenAI content_ref translation', () => {
  it('hydrates content_ref into tool message content', async () => {
    const bytes = Buffer.from('hello full text', 'utf8');
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue({
      readContent: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes,
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
      }),
    } as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF } as never,
            ],
          },
        ],
      },
    ];

    const translated = await translateMessagesToOpenAI(
      messages,
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
      'sess-1',
      undefined,
      new TurnScopedContentHydrationCache(),
    );

    const toolMessage = translated.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('hello full text');
  });

  it('surfaces failure reason inline when content_ref hydration fails', async () => {
    vi.mocked(contentStoreModule.getContentStore).mockReturnValue({
      readContent: vi.fn().mockResolvedValue({ reason: 'not-found' }),
    } as unknown as ReturnType<typeof contentStoreModule.getContentStore>);

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

    const translated = await translateMessagesToOpenAI(
      messages,
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
      'sess-2',
      undefined,
      new TurnScopedContentHydrationCache(),
    );

    const toolMessage = translated.find((m) => m.role === 'tool');
    expect(String(toolMessage?.content)).toMatch(/Tool output unavailable/);
  });

  it('applies truncation marker when content_ref text exceeds OpenAI budget', async () => {
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
            tool_use_id: 'tool-3',
            content: [
              { type: 'content_ref', contentRef: SAMPLE_REF } as never,
              { type: 'content_ref', contentRef: { ...SAMPLE_REF, contentId: 'b'.repeat(32) } } as never,
            ],
          },
        ],
      },
    ];

    const translated = await translateMessagesToOpenAI(
      messages,
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
      'sess-3',
      undefined,
      new TurnScopedContentHydrationCache(),
    );

    const toolMessage = translated.find((m) => m.role === 'tool');
    expect(typeof toolMessage?.content).toBe('string');
    expect(String(toolMessage?.content)).toMatch(/truncated/);
  });
});
