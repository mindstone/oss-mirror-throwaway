import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METADATA_MAX_LENGTH,
  FenceCollisionError,
  generateFenceNonce,
  sanitizeMetadata,
  truncateUtf8Safe,
} from '../untrustedFencing';

describe('untrustedFencing primitives', () => {
  // -------------------------------------------------------------------------
  // generateFenceNonce
  // -------------------------------------------------------------------------

  describe('generateFenceNonce', () => {
    it('returns a 32-character hex string', () => {
      const nonce = generateFenceNonce();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces distinct nonces across invocations', () => {
      // 128 bits of entropy — collision across any reasonable number of
      // calls is astronomically unlikely. Five trials keeps the test
      // fast while still catching a completely deterministic generator.
      const seen = new Set<string>();
      for (let i = 0; i < 5; i += 1) seen.add(generateFenceNonce());
      expect(seen.size).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // truncateUtf8Safe
  // -------------------------------------------------------------------------

  describe('truncateUtf8Safe', () => {
    const MARKER = '\n[…truncated…]';

    it('returns the input unchanged when under the cap (ASCII)', () => {
      const value = 'short ascii body';
      expect(truncateUtf8Safe(value, 1024, MARKER)).toBe(value);
    });

    it('returns the input unchanged when exactly at the cap (ASCII)', () => {
      const value = 'A'.repeat(64);
      expect(truncateUtf8Safe(value, 64, MARKER)).toBe(value);
    });

    it('truncates when body is one byte over the cap, final bytes ≤ limit', () => {
      const value = 'A'.repeat(65);
      const out = truncateUtf8Safe(value, 64, MARKER);
      expect(out).toContain(MARKER);
      expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(64);
    });

    it('truncates non-ASCII whose UTF-16 length is ≤ cap but UTF-8 bytes > cap', () => {
      // Japanese char encodes to 3 UTF-8 bytes, 1 UTF-16 code unit.
      const value = 'あ'.repeat(100); // 300 UTF-8 bytes, 100 UTF-16 code units.
      expect(value.length).toBe(100);
      expect(new TextEncoder().encode(value).byteLength).toBe(300);
      const out = truncateUtf8Safe(value, 200, MARKER);
      expect(out).toContain(MARKER);
      expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(200);
    });

    it('never splits a surrogate pair', () => {
      const value = '🎯'.repeat(64); // each emoji = 4 UTF-8 bytes, surrogate pair in UTF-16
      // Odd budget forces the binary search to land between code points.
      const out = truncateUtf8Safe(value, 45, MARKER);
      // `fatal: true` throws on any invalid UTF-8 sequence.
      const roundtripped = new TextDecoder('utf-8', { fatal: true }).decode(
        new TextEncoder().encode(out),
      );
      expect(roundtripped).toBe(out);
      expect(out.includes('\uFFFD')).toBe(false);
      expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(45);
    });

    it('returns the input verbatim on non-finite / non-positive limits', () => {
      const value = 'A'.repeat(10000);
      expect(truncateUtf8Safe(value, 0, MARKER)).toBe(value);
      expect(truncateUtf8Safe(value, -1, MARKER)).toBe(value);
      expect(truncateUtf8Safe(value, Number.NaN, MARKER)).toBe(value);
      expect(truncateUtf8Safe(value, Number.POSITIVE_INFINITY, MARKER)).toBe(value);
    });

    it('emits only the clipped marker when limit is smaller than the marker itself', () => {
      // Pathological: limit ≤ marker bytes. Returned string should be
      // (up to) `limit` bytes of the marker.
      const value = 'whatever';
      const tinyLimit = 5;
      const out = truncateUtf8Safe(value, tinyLimit, MARKER);
      expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(tinyLimit);
      // Must be a prefix of the marker.
      expect(MARKER.startsWith(out)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sanitizeMetadata
  // -------------------------------------------------------------------------

  describe('sanitizeMetadata', () => {
    it('returns plain ASCII unchanged', () => {
      expect(sanitizeMetadata('Work/Project/NOTES.md')).toBe('Work/Project/NOTES.md');
    });

    it('strips C0 control characters', () => {
      expect(sanitizeMetadata('before\u0000after')).toBe('before after');
    });

    it('strips C1 controls and line separators', () => {
      expect(sanitizeMetadata('a\u0085b\u2028c\u2029d')).toBe('a b c d');
    });

    it('collapses whitespace runs and trims', () => {
      expect(sanitizeMetadata('  a\t\tb\n\n c   ')).toBe('a b c');
    });

    it('truncates at DEFAULT_METADATA_MAX_LENGTH with an ellipsis', () => {
      const longValue = 'A'.repeat(DEFAULT_METADATA_MAX_LENGTH + 50);
      const out = sanitizeMetadata(longValue);
      expect(Array.from(out).length).toBeLessThanOrEqual(DEFAULT_METADATA_MAX_LENGTH);
      expect(out.endsWith('…')).toBe(true);
    });

    it('honors a custom maxLength', () => {
      const longValue = 'A'.repeat(100);
      const out = sanitizeMetadata(longValue, 10);
      expect(Array.from(out).length).toBeLessThanOrEqual(10);
      expect(out.endsWith('…')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // FenceCollisionError
  // -------------------------------------------------------------------------

  describe('FenceCollisionError', () => {
    it('carries the colliding marker and a descriptive message', () => {
      const err = new FenceCollisionError('<<<END_UNTRUSTED_STAGED_abc>>>');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(FenceCollisionError);
      expect(err.name).toBe('FenceCollisionError');
      expect(err.marker).toBe('<<<END_UNTRUSTED_STAGED_abc>>>');
      expect(err.message).toContain('Fence collision');
      expect(err.message).toContain('<<<END_UNTRUSTED_STAGED_abc>>>');
    });
  });
});
