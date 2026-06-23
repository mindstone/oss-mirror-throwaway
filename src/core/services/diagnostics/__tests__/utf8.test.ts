import { describe, it, expect } from 'vitest';
import { clipUtf8Tail, payloadBytes, utf8ByteLength } from '../utf8';

describe('diagnostics utf8 helpers', () => {
  it('matches TextEncoder byte length for payloads', () => {
    expect(payloadBytes({ msg: 'hello' })).toBe(new TextEncoder().encode(JSON.stringify({ msg: 'hello' })).byteLength);
  });
  it('clips ASCII text from the tail', () => {
    expect(clipUtf8Tail('abcdef', 3)).toBe('def');
  });
  it('does not split multi-byte characters beyond the requested byte budget', () => {
    const clipped = clipUtf8Tail('ab😀cd', 6);
    expect(utf8ByteLength(clipped)).toBeLessThanOrEqual(6);
    expect(clipped.endsWith('cd')).toBe(true);
  });
  it('returns empty text when max bytes is non-positive', () => {
    expect(clipUtf8Tail('abc', 0)).toBe('');
  });
});
