/**
 * Stage 5 (guard-large-tool-outputs): history/replay IMAGE guard.
 *
 * Stage 4 added a universal inline-image guard (encoded size + dimension via
 * `checkInlineImageWithinLimits`) and vision-fail-closed handling, but ONLY on
 * the FRESH current-turn path (`buildModelFacingToolResultContent`). Persisted
 * raw `imageContent` reconstructed into provider image blocks on a LATER turn
 * bypassed both. This is the IMAGE analogue of the gap Stage 2 fixed for TEXT.
 *
 * These tests assert that REPLAYED/historical inline image blocks are guarded at
 * the SAME translator funnels Stage 2 used:
 *   - oversized (over encoded-byte) image → text placeholder, no image block;
 *   - over-dimension image → text placeholder, no image block;
 *   - image to a NON-vision client → text placeholder, no image block, no error;
 *   - small/valid image to a vision client → passed through unchanged;
 *   - idempotency: already-placeholdered/bounded content is a no-op.
 * Asserted for BOTH the Anthropic and OpenAI translator paths. tool_use_id /
 * tool_call_id pairing must be preserved throughout.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 5.
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ChatMessage } from '../../modelTypes';
import { toAnthropicMessages } from '../anthropicClient';
import { translateMessagesToOpenAI } from '../openaiTranslators';
import {
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  IMAGE_HARD_DIMENSION_LIMIT,
} from '@shared/attachmentLimits';

// A tiny valid 1x1 transparent PNG (base64) — must pass through untouched.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Base64 string longer than the provider's encoded limit → oversized.
const OVERSIZED_IMG_B64 = 'A'.repeat(ANTHROPIC_IMAGE_BYTE_LIMIT + 16);

// A real PNG header whose IHDR declares dimensions beyond the hard limit.
const pngWithDims = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
};
const OVER_DIM_PNG_B64 = pngWithDims(
  IMAGE_HARD_DIMENSION_LIMIT + 100,
  IMAGE_HARD_DIMENSION_LIMIT + 100,
).toString('base64');

const imageHistory = (toolUseId: string, data: string, mimeType = 'image/png'): ChatMessage[] => [
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [
          { type: 'text', text: 'see image' },
          { type: 'image', data, mimeType },
        ],
      } as never,
    ],
  },
];

// ---- Anthropic helpers ------------------------------------------------------

interface AnthBlock {
  tool_use_id: string;
  content: Array<Record<string, unknown>>;
}
const anthParts = (translated: unknown): AnthBlock => {
  const t = translated as Array<{ content: AnthBlock[] }>;
  return t[0].content[0];
};
const anthImagePart = (block: AnthBlock) => block.content.find((p) => p.type === 'image');
const anthAllText = (block: AnthBlock): string =>
  block.content
    .filter((p) => p.type === 'text')
    .map((p) => String((p as { text?: unknown }).text ?? ''))
    .join('\n');

// ---- OpenAI helpers ---------------------------------------------------------

const openaiImageMsg = (translated: Awaited<ReturnType<typeof translateMessagesToOpenAI>>) =>
  translated.find(
    (m) => Array.isArray(m.content)
      && (m.content as Array<{ type?: string }>).some((p) => p.type === 'image_url'),
  );
const openaiToolMsg = (translated: Awaited<ReturnType<typeof translateMessagesToOpenAI>>) =>
  translated.find((m) => m.role === 'tool');

describe('Stage 5 — Anthropic translator guards historical image blocks', () => {
  it('replaces an OVERSIZED (over encoded-byte) historical image with a placeholder', async () => {
    const translated = await toAnthropicMessages(imageHistory('tool-1', OVERSIZED_IMG_B64), true);
    const block = anthParts(translated);
    expect(block.tool_use_id).toBe('tool-1'); // pairing intact
    expect(anthImagePart(block)).toBeUndefined(); // no image block
    expect(anthAllText(block)).toMatch(/Image 1 omitted/);
    // The oversized base64 must NOT appear anywhere in the translated content.
    expect(JSON.stringify(translated)).not.toContain(OVERSIZED_IMG_B64);
  });

  it('replaces an OVER-DIMENSION historical image with a placeholder', async () => {
    const translated = await toAnthropicMessages(imageHistory('tool-2', OVER_DIM_PNG_B64), true);
    const block = anthParts(translated);
    expect(anthImagePart(block)).toBeUndefined();
    expect(anthAllText(block)).toMatch(/Image 1 omitted/);
  });

  it('passes a small/valid historical image through unchanged (vision client)', async () => {
    const translated = await toAnthropicMessages(imageHistory('tool-3', TINY_PNG_B64), true);
    const block = anthParts(translated);
    expect(block.tool_use_id).toBe('tool-3');
    const image = anthImagePart(block);
    expect(image).toBeDefined();
    const source = image?.source as { data?: string } | undefined;
    expect(source?.data).toBe(TINY_PNG_B64); // untouched, full base64
  });

  it('placeholders historical image blocks for a NON-vision client', async () => {
    const translated = await toAnthropicMessages(
      imageHistory('tool-4', TINY_PNG_B64),
      false, // supportsImageContent = false (non-vision model)
    );
    const block = anthParts(translated);
    expect(anthImagePart(block)).toBeUndefined();
    expect(anthAllText(block)).toMatch(/vision is not supported/);
  });

  it('is idempotent: a history that already has the placeholder is a no-op', async () => {
    const first = await toAnthropicMessages(imageHistory('tool-5', OVERSIZED_IMG_B64), true);
    const placeholderText = anthAllText(anthParts(first));
    // Feed the placeholdered text back as a plain text tool_result.
    const replay: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-5', content: placeholderText } as never],
      },
    ];
    const second = (await toAnthropicMessages(replay, true)) as unknown as Array<{
      content: Array<{ content: unknown }>;
    }>;
    expect(second[0].content[0].content).toBe(placeholderText);
  });
});

describe('Stage 5 — OpenAI translator guards historical image blocks', () => {
  it('replaces an OVERSIZED historical image with a placeholder (no image_url)', async () => {
    const translated = await translateMessagesToOpenAI(
      imageHistory('tool-1', OVERSIZED_IMG_B64),
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    expect(openaiImageMsg(translated)).toBeUndefined(); // no image part emitted
    const toolMsg = openaiToolMsg(translated);
    expect(toolMsg?.tool_call_id).toBe('tool-1'); // pairing intact
    expect(String(toolMsg?.content)).toMatch(/Image 1 omitted/);
    expect(JSON.stringify(translated)).not.toContain(OVERSIZED_IMG_B64);
  });

  it('replaces an OVER-DIMENSION historical image with a placeholder', async () => {
    const translated = await translateMessagesToOpenAI(
      imageHistory('tool-2', OVER_DIM_PNG_B64),
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    expect(openaiImageMsg(translated)).toBeUndefined();
    expect(String(openaiToolMsg(translated)?.content)).toMatch(/Image 1 omitted/);
  });

  it('passes a small/valid historical image through as image_url (vision client)', async () => {
    const translated = await translateMessagesToOpenAI(
      imageHistory('tool-3', TINY_PNG_B64),
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    const imageMsg = openaiImageMsg(translated);
    expect(imageMsg).toBeDefined();
    const parts = imageMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart?.image_url?.url).toContain(TINY_PNG_B64);
  });

  it('placeholders historical image blocks for a NON-vision client (no image_url, no error)', async () => {
    const translated = await translateMessagesToOpenAI(
      imageHistory('tool-4', TINY_PNG_B64),
      { supportsImageContent: false },
      undefined,
      'gpt-5.5',
    );
    expect(openaiImageMsg(translated)).toBeUndefined();
    expect(String(openaiToolMsg(translated)?.content)).toMatch(/vision is not supported/);
  });

  it('is idempotent: a history that already has the placeholder is a no-op', async () => {
    const first = await translateMessagesToOpenAI(
      imageHistory('tool-5', OVERSIZED_IMG_B64),
      { supportsImageContent: true },
      undefined,
      'gpt-5.5',
    );
    const placeholderText = String(openaiToolMsg(first)?.content);
    const replay: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-5', content: placeholderText } as never],
      },
    ];
    const second = await translateMessagesToOpenAI(replay, { supportsImageContent: true }, undefined, 'gpt-5.5');
    expect(openaiToolMsg(second)?.content).toBe(placeholderText);
    expect(openaiImageMsg(second)).toBeUndefined();
  });
});
