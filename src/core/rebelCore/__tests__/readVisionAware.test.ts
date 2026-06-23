import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeBuiltinTool } from '../builtinTools';
import { buildModelFacingToolResultContent } from '../agentLoop';
import { ANTHROPIC_IMAGE_BYTE_LIMIT } from '@shared/attachmentLimits';

/**
 * Stage 3 behavioral tests: vision-aware `Read`.
 *
 * Core bug fix: a `Read` of a large image file must NOT return multi-MB raw
 * bytes as a UTF-8 string. Images become a small vision content block; other
 * binary returns a placeholder; large text returns a head slice + guidance.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 3.
 */

// Minimal valid magic-byte headers padded to a real size.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webpHeader = (): Buffer => {
  const buf = Buffer.alloc(16);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  return buf;
};

describe('Read — vision-aware (Stage 3)', () => {
  let workdir: string;

  const ctx = (overrides: Record<string, unknown> = {}) => ({
    cwd: workdir,
    surfaceCapability: 'desktop' as const,
    ...overrides,
  });

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-vision-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('Read of a PNG returns an image content block (not raw text)', async () => {
    const file = path.join(workdir, 'pic.png');
    // Pad to a realistic-but-small image; the magic bytes lead.
    await fs.writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.alloc(2048, 7)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toHaveLength(1);
    expect(result.imageContent?.[0]?.mimeType).toBe('image/png');
    expect(result.imageContent?.[0]?.type).toBe('image');
    // base64 of the file bytes, not raw bytes-as-text.
    expect(typeof result.imageContent?.[0]?.data).toBe('string');
    // The text output is a tiny metadata placeholder, NOT the raw bytes.
    expect(result.output).toContain('image file');
    expect(result.output).toContain('image/png');
    expect(result.output).not.toContain('\x89PNG');
  });

  it('Read of a JPEG returns an image content block', async () => {
    const file = path.join(workdir, 'photo.jpg');
    await fs.writeFile(file, Buffer.concat([JPEG_MAGIC, Buffer.alloc(1024, 9)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent?.[0]?.mimeType).toBe('image/jpeg');
  });

  it('Read of a GIF and a WEBP are detected by magic bytes', async () => {
    const gif = path.join(workdir, 'anim.gif');
    const webp = path.join(workdir, 'modern.webp');
    await fs.writeFile(gif, Buffer.concat([GIF_MAGIC, Buffer.alloc(64, 1)]));
    await fs.writeFile(webp, Buffer.concat([webpHeader(), Buffer.alloc(64, 1)]));

    const gifResult = await executeBuiltinTool('Read', { file_path: gif }, ctx());
    const webpResult = await executeBuiltinTool('Read', { file_path: webp }, ctx());

    expect(gifResult.imageContent?.[0]?.mimeType).toBe('image/gif');
    expect(webpResult.imageContent?.[0]?.mimeType).toBe('image/webp');
  });

  it('the 8.9MB-image scenario yields a small image block, NOT a multi-MB string', async () => {
    // Reproduces the original overflow shape: a large image read.
    const file = path.join(workdir, 'huge.png');
    // 3 MiB (under the 5 MiB per-image cap → still served as a vision block).
    await fs.writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.alloc(3 * 1024 * 1024, 0xab)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    // The model-facing TEXT output is tiny (a placeholder), not megabytes.
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024);
    // The image goes through the dedicated image channel (which the boundary
    // renders as a vision tile, ~tiles not raw bytes-as-text).
    expect(result.imageContent).toHaveLength(1);
    expect(result.imageContent?.[0]?.mimeType).toBe('image/png');
  });

  it('Read of an oversized image (>5 MiB) returns a placeholder + recoverable path, no image block', async () => {
    const file = path.join(workdir, 'gigantic.jpg');
    await fs.writeFile(file, Buffer.concat([JPEG_MAGIC, Buffer.alloc(6 * 1024 * 1024, 0x10)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('too large to view inline');
    expect(result.output).toContain('image/jpeg');
    expect(result.output).toContain('remains on disk');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024);
  });

  it('Read of a 4 MiB image (UNDER the old 5 MiB decoded cap, OVER the base64 encoded limit) → placeholder', async () => {
    // This is the byte-unit bug: 4 MiB decoded passes a decoded ≤5 MiB check,
    // but base64-encodes to ~5.33 MiB which the provider rejects. Must be a
    // placeholder, never an image block.
    const file = path.join(workdir, 'four-mib.png');
    await fs.writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.alloc(4 * 1024 * 1024, 0x22)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('too large to view inline');
    expect(result.output).toContain('provider limit');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024);
  });

  it('Read of an over-dimension image (small bytes, > hard pixel limit) → placeholder, no image block', async () => {
    // A tiny PNG whose IHDR declares dimensions beyond IMAGE_HARD_DIMENSION_LIMIT
    // (8000px). The byte cap would pass; the dimension guard must reject it.
    const ihdr = Buffer.alloc(24);
    // PNG signature (8 bytes).
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
    ihdr.write('IHDR', 12, 'ascii');
    ihdr.writeUInt32BE(10000, 16); // width = 10000 px
    ihdr.writeUInt32BE(10000, 20); // height = 10000 px
    const file = path.join(workdir, 'huge-dims.png');
    await fs.writeFile(file, Buffer.concat([ihdr, Buffer.alloc(256, 1)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('dimensions 10000x10000px');
    expect(result.output).toContain('provider limit');
  });

  it('Read of an in-dimension PNG (small) still returns an image block', async () => {
    const ihdr = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
    ihdr.write('IHDR', 12, 'ascii');
    ihdr.writeUInt32BE(640, 16);
    ihdr.writeUInt32BE(480, 20);
    const file = path.join(workdir, 'normal-dims.png');
    await fs.writeFile(file, Buffer.concat([ihdr, Buffer.alloc(256, 1)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.imageContent).toHaveLength(1);
    expect(result.imageContent?.[0]?.mimeType).toBe('image/png');
  });

  it('Read of an unknown binary returns a placeholder + metadata, no raw bytes', async () => {
    const file = path.join(workdir, 'mystery.bin');
    // Non-image bytes incl. a NUL → binary.
    await fs.writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xfd, 0x00, 0x42]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('binary file');
    expect(result.output).toContain('raw bytes omitted');
    // No raw control bytes leaked into the model-facing text.
    expect(result.output).not.toContain('\x00');
  });

  it('Read of a normal UTF-8 text file is unchanged', async () => {
    const file = path.join(workdir, 'notes.md');
    await fs.writeFile(file, 'hello world\nsecond line', 'utf8');

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello world\nsecond line');
    expect(result.imageContent).toBeUndefined();
  });

  it('Read of a UTF-8 text file with multibyte chars is unchanged', async () => {
    const file = path.join(workdir, 'emoji.txt');
    const content = 'café 🚀 日本語';
    await fs.writeFile(file, content, 'utf8');

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.output).toBe(content);
    expect(result.imageContent).toBeUndefined();
  });

  it('offset/limit still slice text', async () => {
    const file = path.join(workdir, 'lines.txt');
    await fs.writeFile(file, 'l0\nl1\nl2\nl3\nl4', 'utf8');

    const result = await executeBuiltinTool('Read', { file_path: file, offset: 1, limit: 2 }, ctx());

    expect(result.output).toBe('l1\nl2');
  });

  it('Read of a large text file returns a head slice + offset/limit guidance + materialised path', async () => {
    const file = path.join(workdir, 'big.txt');
    // 200 KiB of ASCII text (> the 128 KiB friendly cap).
    const big = 'x'.repeat(200 * 1024);
    await fs.writeFile(file, big, 'utf8');

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('output truncated');
    expect(result.output).toContain('bytes omitted');
    // Head slice stays at/under the friendly cap (+ the note).
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(150 * 1024);
    // outputChars carries the original (pre-truncation) size for accounting.
    expect(result.outputChars).toBe(200 * 1024);

    // cwd present → full content materialised to .rebel/tool-outputs and cited.
    expect(result.output).toContain('.rebel/tool-outputs/');
    const match = result.output.match(/\.rebel\/tool-outputs\/[^\s\]]+/);
    expect(match).not.toBeNull();
    const saved = await fs.readFile(path.join(workdir, match![0]), 'utf8');
    expect(saved).toBe(big);
  });

  it('Read of a large text file degrades to a bounded placeholder when materialisation is unavailable', async () => {
    // Materialisation disabled (kill-switch) simulates the no-writable-workspace
    // surface: the read is still bounded with offset/limit guidance, no raw dump,
    // and no .rebel/tool-outputs/ citation.
    const prev = process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
    process.env.REBEL_DISABLE_BASH_MATERIALIZATION = '1';
    try {
      const file = path.join(workdir, 'big-nowrite.txt');
      const big = 'y'.repeat(200 * 1024);
      await fs.writeFile(file, big, 'utf8');

      const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

      expect(result.isError).toBe(false);
      expect(result.output).toContain('output truncated');
      expect(result.output).toContain('offset/limit');
      expect(result.output).not.toContain('.rebel/tool-outputs/');
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(150 * 1024);
    } finally {
      if (prev === undefined) {
        delete process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
      } else {
        process.env.REBEL_DISABLE_BASH_MATERIALIZATION = prev;
      }
    }
  });
});

/**
 * Stage 4 regression: end-to-end large-image guard through the PROVIDER-BOUND
 * funnel.
 *
 * The earlier suite above asserts the `Read` tool-level result (imageContent vs
 * placeholder). Reviews flagged that this was "tested at the tool level only" —
 * the assertions never followed the result through the SAME funnel the agent
 * loop uses to build provider-bound `tool_result` content
 * (`buildModelFacingToolResultContent`). These tests close that gap by chaining
 * the REAL `executeBuiltinTool('Read', …)` into the REAL
 * `buildModelFacingToolResultContent(...)`, with genuinely large REAL image
 * bytes (multi-MB, correct magic bytes), and asserting on the bytes that would
 * actually leave for the provider:
 *   - a large-but-under-cap image → exactly ONE provider image block whose
 *     base64 payload is within the provider encoded-byte limit, a tiny text
 *     block, and a serialized payload that is bounded (no surprise inflation);
 *   - an OVERSIZED image (encoded > provider cap) → NO image block, a text
 *     placeholder, and ZERO raw image magic bytes (\x89PNG / \xFF\xD8) in the
 *     provider-bound content.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 3 / Stage 4.
 */
const PNG_MAGIC_8 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Serialize provider-bound tool_result content the way a JSON wire request
// would (image base64 + text), to measure the real outbound byte footprint.
const serializedBytes = (content: ReturnType<typeof buildModelFacingToolResultContent>): number =>
  Buffer.byteLength(JSON.stringify(content), 'utf8');

describe('Read — large image through buildModelFacingToolResultContent (Stage 4)', () => {
  let workdir: string;

  const ctx = () => ({ cwd: workdir, surfaceCapability: 'desktop' as const });

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-vision-mf-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('a large PNG-magic image (~3 MiB raw, under the encoded cap) becomes a single bounded provider image block', async () => {
    // 3 MiB raw → base64 ≈ 4 MiB, under the 5 MiB encoded provider cap → a real
    // vision block. The Read codec detects images by magic bytes (it does not
    // parse IHDR), so this is a PNG-magic buffer padded to a genuinely large
    // size, not a structurally-complete PNG — the byte-budget behavior is what
    // this test exercises.
    const rawBytes = 3 * 1024 * 1024;
    const file = path.join(workdir, 'large-magic.png');
    await fs.writeFile(file, Buffer.concat([PNG_MAGIC_8, Buffer.alloc(rawBytes, 0xab)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    // Tool-level: a vision block, tiny text.
    expect(result.isError).toBe(false);
    expect(result.imageContent).toHaveLength(1);
    expect(result.imageContent?.[0]?.mimeType).toBe('image/png');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024);

    // Provider-bound funnel (vision client): exactly one image block survives.
    const content = buildModelFacingToolResultContent(result, /* supportsImageContent */ true);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    const imageBlocks = blocks.filter((b) => b.type === 'image');
    const textBlocks = blocks.filter((b) => b.type === 'text');
    expect(imageBlocks).toHaveLength(1);
    expect(textBlocks).toHaveLength(1);

    const imageBlock = imageBlocks[0] as Extract<typeof imageBlocks[number], { type: 'image' }>;
    expect(imageBlock.mimeType).toBe('image/png');
    expect(imageBlock.data).toBeDefined();
    // The provider-bound payload is the base64 of the file — within the cap.
    const encodedBytes = Buffer.byteLength(imageBlock.data ?? '', 'utf8');
    expect(encodedBytes).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT);
    // base64 of 3 MiB ≈ 4 MiB → sanity-bound the inflation (no double-encode).
    expect(encodedBytes).toBeLessThan(rawBytes * 2);
    // The text block is the tiny metadata placeholder, not raw bytes.
    const textBlock = textBlocks[0] as Extract<typeof textBlocks[number], { type: 'text' }>;
    expect(Buffer.byteLength(textBlock.text, 'utf8')).toBeLessThan(1024);
    expect(textBlock.text).not.toContain('\x89PNG');

    // Whole serialized provider-bound payload is bounded: it carries exactly one
    // under-cap base64 image plus a tiny text block — nothing more. Bound it at
    // the encoded image cap plus a small JSON/text envelope, mirroring the
    // serialized-byte assertions the oversized cases make.
    expect(serializedBytes(content)).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT + 64 * 1024);
  });

  it('an OVERSIZED PNG (encoded > provider cap) yields NO provider image block and no raw magic bytes', async () => {
    // 6 MiB raw → base64 ≈ 8 MiB, well over the 5 MiB encoded cap. The tool
    // already drops it to a placeholder; assert the provider-bound funnel keeps
    // it that way (and never reconstructs an image block).
    const rawBytes = 6 * 1024 * 1024;
    const file = path.join(workdir, 'oversized.png');
    await fs.writeFile(file, Buffer.concat([PNG_MAGIC_8, Buffer.alloc(rawBytes, 0xcd)]));

    const result = await executeBuiltinTool('Read', { file_path: file }, ctx());

    // Tool-level: no image block, bounded placeholder text.
    expect(result.isError).toBe(false);
    expect(result.imageContent).toBeUndefined();
    expect(result.output).toContain('too large to view inline');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024);

    // Provider-bound funnel (vision client): with no imageContent, the result is
    // the bounded text string — no image block, no megabytes.
    const content = buildModelFacingToolResultContent(result, /* supportsImageContent */ true);
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    // No raw image magic bytes leak into the provider-bound payload.
    expect(serialized).not.toContain('\x89PNG');
    expect(serialized).not.toContain('\xff\xd8');
    // The full provider-bound payload stays tiny — nowhere near the 6 MiB file.
    expect(serializedBytes(content)).toBeLessThan(2048);
    if (Array.isArray(content)) {
      expect(content.some((b) => b.type === 'image')).toBe(false);
    }
  });

  it('an in-tool placeholdered image stays placeholdered even when reconstructed as an image block (no resurrection)', async () => {
    // Belt-and-braces: even if a caller manually injects an oversized imageContent
    // block (e.g. from a non-Read tool or replayed history), the funnel's
    // universal inline-image backstop must reduce it to a text placeholder rather
    // than forward multi-MB base64 to the provider.
    const oversizedData = 'A'.repeat(ANTHROPIC_IMAGE_BYTE_LIMIT + 1024);
    const synthetic = {
      output: 'tool produced an image',
      isError: false,
      imageContent: [{ type: 'image' as const, mimeType: 'image/png' as const, data: oversizedData }],
    };

    const content = buildModelFacingToolResultContent(synthetic, /* supportsImageContent */ true);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    const placeholder = blocks.find(
      (b): b is Extract<typeof blocks[number], { type: 'text' }> =>
        b.type === 'text' && b.text.includes('omitted'),
    );
    expect(placeholder).toBeDefined();
    // The oversized base64 never reaches the provider-bound payload.
    expect(serializedBytes(content)).toBeLessThan(4096);
  });
});
