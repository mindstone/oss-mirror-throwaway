import { describe, expect, it } from 'vitest';
import {
  checkInlineImageWithinLimits,
  detectImageMimeType,
  isBinaryHeader,
  parseImageDimensions,
} from '../fileTypeDetection';
import { ANTHROPIC_IMAGE_BYTE_LIMIT, IMAGE_HARD_DIMENSION_LIMIT } from '@shared/attachmentLimits';

describe('detectImageMimeType', () => {
  it('detects PNG magic bytes', () => {
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])))
      .toBe('image/png');
  });

  it('detects JPEG magic bytes', () => {
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
      .toBe('image/jpeg');
  });

  it('detects GIF magic bytes', () => {
    expect(detectImageMimeType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])))
      .toBe('image/gif');
  });

  it('detects WEBP (RIFF....WEBP) magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    expect(detectImageMimeType(buf)).toBe('image/webp');
  });

  it('does not match RIFF without WEBP (e.g. WAV audio)', () => {
    const buf = Buffer.alloc(12);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WAVE', 8, 'ascii');
    expect(detectImageMimeType(buf)).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(detectImageMimeType(Buffer.from('hello world', 'utf8'))).toBeNull();
  });
});

describe('isBinaryHeader', () => {
  it('treats a NUL byte as binary', () => {
    expect(isBinaryHeader(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('treats plain ASCII text as not binary', () => {
    expect(isBinaryHeader(Buffer.from('the quick brown fox\n', 'utf8'))).toBe(false);
  });

  it('treats multibyte UTF-8 as not binary', () => {
    expect(isBinaryHeader(Buffer.from('café 🚀 日本語', 'utf8'))).toBe(false);
  });

  it('treats text with tabs/newlines/CR as not binary', () => {
    expect(isBinaryHeader(Buffer.from('a\tb\r\nc\f', 'utf8'))).toBe(false);
  });

  it('treats a high ratio of control bytes as binary', () => {
    expect(isBinaryHeader(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41]))).toBe(true);
  });

  it('treats an empty buffer as not binary', () => {
    expect(isBinaryHeader(Buffer.alloc(0))).toBe(false);
  });
});

const pngWithDims = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
};

const gifWithDims = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
};

const jpegWithDims = (w: number, h: number): Buffer => {
  // SOI + an APP0 segment (to exercise the marker walk) + SOF0.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]); // marker + len(4) + 2 payload
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff; sof0[1] = 0xc0; // SOF0
  sof0.writeUInt16BE(11, 2); // segment length
  sof0[4] = 0x08; // precision
  sof0.writeUInt16BE(h, 5);
  sof0.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
};

const webpVp8x = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  // canvas width/height minus 1, 24-bit little-endian at 24/27.
  const wm = w - 1; const hm = h - 1;
  buf[24] = wm & 0xff; buf[25] = (wm >> 8) & 0xff; buf[26] = (wm >> 16) & 0xff;
  buf[27] = hm & 0xff; buf[28] = (hm >> 8) & 0xff; buf[29] = (hm >> 16) & 0xff;
  return buf;
};

describe('parseImageDimensions', () => {
  it('parses PNG dimensions from IHDR', () => {
    expect(parseImageDimensions(pngWithDims(1024, 768), 'image/png')).toEqual({ width: 1024, height: 768 });
  });

  it('parses GIF dimensions', () => {
    expect(parseImageDimensions(gifWithDims(320, 200), 'image/gif')).toEqual({ width: 320, height: 200 });
  });

  it('parses JPEG dimensions via SOF marker walk', () => {
    expect(parseImageDimensions(jpegWithDims(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 });
  });

  it('parses WEBP (VP8X) canvas dimensions', () => {
    expect(parseImageDimensions(webpVp8x(4000, 3000), 'image/webp')).toEqual({ width: 4000, height: 3000 });
  });

  it('returns null for a truncated header', () => {
    expect(parseImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBeNull();
  });
});

describe('checkInlineImageWithinLimits', () => {
  it('accepts a small in-limit image', () => {
    expect(checkInlineImageWithinLimits('c21hbGw=', 'image/png')).toEqual({ ok: true });
  });

  it('rejects a base64 string over the encoded byte limit', () => {
    const oversized = 'A'.repeat(ANTHROPIC_IMAGE_BYTE_LIMIT + 4);
    const verdict = checkInlineImageWithinLimits(oversized, 'image/png');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/exceeds the/);
  });

  it('rejects an over-dimension image even when bytes are small', () => {
    const big = IMAGE_HARD_DIMENSION_LIMIT + 1;
    const data = pngWithDims(big, big).toString('base64');
    const verdict = checkInlineImageWithinLimits(data, 'image/png');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/dimensions/);
  });

  it('accepts an in-dimension image', () => {
    const data = pngWithDims(800, 600).toString('base64');
    expect(checkInlineImageWithinLimits(data, 'image/png')).toEqual({ ok: true });
  });

  it('does not fail-hard on an unparseable header (byte cap is primary)', () => {
    // Valid-ish small base64 that is not a real image header → dimensions null → ok.
    expect(checkInlineImageWithinLimits('Zm9vYmFy', 'image/png')).toEqual({ ok: true });
  });
});
