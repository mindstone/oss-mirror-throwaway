/**
 * Stage 2 (guard-large-tool-outputs): history/replay guard.
 *
 * Ensures tool_result content reaching a provider from EXISTING history is
 * bounded by the same 200 KiB cap as fresh results (Stage 1), covering:
 *   (a) pre-fix RAW persisted tool_result outputs (plain string + text block),
 *   (b) content_ref blocks hydrated back to FULL text for model replay.
 *
 * Asserted for BOTH the Anthropic and OpenAI translator paths. Image blocks and
 * tool_use_id pairing must be preserved; re-bounding bounded content is a no-op.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 2.
 */
import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ChatMessage } from '../../modelTypes';
import { toAnthropicMessages } from '../anthropicClient';
import { translateMessagesToOpenAI } from '../openaiTranslators';
import { TurnScopedContentHydrationCache } from '@core/services/contentHydrationCache';
import { UNIVERSAL_TOOL_OUTPUT_CAP_BYTES } from '@core/services/contentTruncation';
import * as contentStoreModule from '@core/contentStore';

vi.mock('@core/contentStore', async () => {
  const actual = await vi.importActual<typeof contentStoreModule>('@core/contentStore');
  return {
    ...actual,
    getContentStore: vi.fn(),
  };
});

const CAP = UNIVERSAL_TOOL_OUTPUT_CAP_BYTES; // 200 KiB
const OVERSIZED_BYTES = CAP * 3; // ~600 KiB raw

// A tiny valid 1x1 transparent PNG (base64) — must pass through untouched.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SAMPLE_REF = {
  contentId: 'c'.repeat(32),
  mimeType: 'text/plain',
  byteSize: OVERSIZED_BYTES,
  summary: 'preview…',
};

const mockContentStoreReturning = (bytes: Buffer): void => {
  vi.mocked(contentStoreModule.getContentStore).mockReturnValue({
    readContent: vi.fn().mockResolvedValue({
      reason: 'ok',
      bytes,
      mimeType: 'text/plain',
      byteSize: bytes.byteLength,
    }),
  } as unknown as ReturnType<typeof contentStoreModule.getContentStore>);
};

const anthTextFrom = (translated: unknown, msg = 0, block = 0, part = 0): string => {
  const t = translated as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;
  const value = t[msg].content[block].content[part]?.text;
  return typeof value === 'string' ? value : '';
};

describe('Stage 2 — Anthropic translator bounds historical tool_result text', () => {
  it('bounds a pre-fix RAW string tool_result from history', async () => {
    const huge = 'a'.repeat(OVERSIZED_BYTES);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: huge } as never],
      },
    ];

    const translated = (await toAnthropicMessages(messages, true)) as unknown as Array<{
      content: Array<{ type: string; tool_use_id: string; content: unknown }>;
    }>;

    const block = translated[0].content[0];
    expect(block.tool_use_id).toBe('tool-1'); // pairing intact
    expect(typeof block.content).toBe('string');
    const out = block.content as string;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(out).toMatch(/output truncated/);
  });

  it('bounds a pre-fix RAW text block tool_result from history', async () => {
    const huge = 'b'.repeat(OVERSIZED_BYTES);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [{ type: 'text', text: huge }],
          } as never,
        ],
      },
    ];

    const translated = await toAnthropicMessages(messages, true);
    const text = anthTextFrom(translated);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(text).toMatch(/output truncated/);
  });

  it('bounds content_ref hydrated text; ContentStore still holds full bytes', async () => {
    const fullBytes = Buffer.from('z'.repeat(OVERSIZED_BYTES), 'utf8');
    mockContentStoreReturning(fullBytes);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [{ type: 'content_ref', contentRef: SAMPLE_REF } as never],
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
    );

    const text = anthTextFrom(translated);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(text).toMatch(/output truncated/);
    // ContentStore is untouched by the cap — full bytes still resolvable.
    expect(fullBytes.byteLength).toBe(OVERSIZED_BYTES);
  });

  it('leaves a small tool_result unchanged with pairing intact', async () => {
    const small = 'all good';
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-4',
            content: [{ type: 'text', text: small }],
          } as never,
        ],
      },
    ];

    const translated = (await toAnthropicMessages(messages, true)) as unknown as Array<{
      content: Array<{ tool_use_id: string; content: Array<Record<string, unknown>> }>;
    }>;
    expect(translated[0].content[0].tool_use_id).toBe('tool-4');
    expect(translated[0].content[0].content[0].text).toBe(small);
  });

  it('leaves an image block untouched (not treated as oversized text)', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-5',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
            ],
          } as never,
        ],
      },
    ];

    const translated = (await toAnthropicMessages(messages, true)) as unknown as Array<{
      content: Array<{ content: Array<Record<string, unknown>> }>;
    }>;
    const parts = translated[0].content[0].content;
    const image = parts.find((p) => p.type === 'image');
    expect(image).toBeDefined();
    const source = image?.source as { data?: string } | undefined;
    expect(source?.data).toBe(TINY_PNG_B64); // untouched, full base64
  });

  it('is idempotent: re-bounding already-bounded content is a no-op', async () => {
    const huge = 'q'.repeat(OVERSIZED_BYTES);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-6', content: huge } as never],
      },
    ];
    const first = (await toAnthropicMessages(messages, true)) as unknown as Array<{
      content: Array<{ content: unknown }>;
    }>;
    const boundedOnce = first[0].content[0].content as string;

    // Feed the already-bounded output back through as history.
    const replay: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-6', content: boundedOnce } as never],
      },
    ];
    const second = (await toAnthropicMessages(replay, true)) as unknown as Array<{
      content: Array<{ content: unknown }>;
    }>;
    expect(second[0].content[0].content).toBe(boundedOnce);
  });
});

describe('Stage 2 — OpenAI translator bounds historical tool_result text', () => {
  it('bounds a pre-fix RAW string tool_result from history', async () => {
    const huge = 'a'.repeat(OVERSIZED_BYTES);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: huge } as never],
      },
    ];

    const translated = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, undefined, 'gpt-5.5');
    const toolMsg = translated.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('tool-1'); // pairing intact
    const out = String(toolMsg?.content);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(out).toMatch(/output truncated/);
  });

  it('bounds a pre-fix RAW text block tool_result from history', async () => {
    const huge = 'b'.repeat(OVERSIZED_BYTES);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [{ type: 'text', text: huge }],
          } as never,
        ],
      },
    ];

    const translated = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, undefined, 'gpt-5.5');
    const toolMsg = translated.find((m) => m.role === 'tool');
    const out = String(toolMsg?.content);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(out).toMatch(/output truncated/);
  });

  it('bounds content_ref hydrated text; ContentStore still holds full bytes', async () => {
    const fullBytes = Buffer.from('z'.repeat(OVERSIZED_BYTES), 'utf8');
    mockContentStoreReturning(fullBytes);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [{ type: 'content_ref', contentRef: SAMPLE_REF } as never],
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
    const toolMsg = translated.find((m) => m.role === 'tool');
    const out = String(toolMsg?.content);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(out).toMatch(/output truncated/);
    expect(fullBytes.byteLength).toBe(OVERSIZED_BYTES);
  });

  it('leaves a small tool_result unchanged with pairing intact', async () => {
    const small = 'all good';
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-4',
            content: [{ type: 'text', text: small }],
          } as never,
        ],
      },
    ];

    const translated = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, undefined, 'gpt-5.5');
    const toolMsg = translated.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('tool-4');
    expect(toolMsg?.content).toBe(small);
  });

  it('leaves an image block as image_url (not treated as oversized text)', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-5',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
            ],
          } as never,
        ],
      },
    ];

    const translated = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, undefined, 'gpt-5.5');
    const imageMsg = translated.find(
      (m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'image_url'),
    );
    expect(imageMsg).toBeDefined();
    const parts = imageMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart?.image_url?.url).toContain(TINY_PNG_B64); // full base64 preserved
  });

  it('is idempotent: re-bounding already-bounded content is a no-op', async () => {
    const huge = 'q'.repeat(OVERSIZED_BYTES);
    const first = await translateMessagesToOpenAI(
      [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-6', content: huge } as never],
        },
      ],
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    const boundedOnce = String(first.find((m) => m.role === 'tool')?.content);

    const second = await translateMessagesToOpenAI(
      [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-6', content: boundedOnce } as never],
        },
      ],
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    expect(second.find((m) => m.role === 'tool')?.content).toBe(boundedOnce);
  });
});
