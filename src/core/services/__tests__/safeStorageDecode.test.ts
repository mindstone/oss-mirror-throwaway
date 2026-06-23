/**
 * Unit tests for the shared safeStorage decode helpers.
 *
 * Covers the v10/v11-prefix guard, per-store validators, Sentry dedupe
 * latch, and DecodedResult contract used by all four token storage
 * modules. See docs-private/investigations/260506_safestorage_token_corruption_ufffd.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captureMessage = vi.fn();
const captureException = vi.fn();
const addBreadcrumb = vi.fn();
const captureExceptionWithScope = vi.fn();

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureMessage, captureException, addBreadcrumb, captureExceptionWithScope }),
}));

import {
  __resetDegradedLatchForTesting,
  captureDegradedOnce,
  clearDegradedLatch,
  decodeJsonStore,
  decodeStringStore,
  hasSafeStorageHeader,
  isValidNonEmptyAscii,
  isValidTokenString,
} from '../safeStorageDecode';

beforeEach(() => {
  __resetDegradedLatchForTesting();
  captureMessage.mockClear();
  captureException.mockClear();
  addBreadcrumb.mockClear();
  captureExceptionWithScope.mockClear();
});

afterEach(() => {
  __resetDegradedLatchForTesting();
});

describe('hasSafeStorageHeader', () => {
  it('detects v10 prefix', () => {
    expect(hasSafeStorageHeader(Buffer.from('v10rest'))).toBe(true);
  });

  it('detects v11 prefix', () => {
    expect(hasSafeStorageHeader(Buffer.from('v11rest'))).toBe(true);
  });

  it('returns false for plain ascii prefix', () => {
    expect(hasSafeStorageHeader(Buffer.from('abc-token'))).toBe(false);
  });

  it('returns false for buffer shorter than 3 bytes', () => {
    expect(hasSafeStorageHeader(Buffer.from('v1'))).toBe(false);
    expect(hasSafeStorageHeader(Buffer.from(''))).toBe(false);
  });

  it('returns false when prefix bytes are not ascii v10/v11', () => {
    expect(hasSafeStorageHeader(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  it('does not false-positive on high-bit bytes that mask to ascii v10', () => {
    // 0xF6 & 0x7F = 0x76 ('v'); 0xB1 & 0x7F = 0x31 ('1'); 0xB0 & 0x7F = 0x30 ('0').
    // A naive `buf.subarray(0,3).toString('ascii')` would treat this as a v10
    // header. Byte-level comparison must correctly reject it.
    expect(hasSafeStorageHeader(Buffer.from([0xf6, 0xb1, 0xb0]))).toBe(false);
  });
});

describe('isValidNonEmptyAscii', () => {
  it('accepts plain ascii printable strings', () => {
    expect(isValidNonEmptyAscii('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(true);
    expect(isValidNonEmptyAscii('fake-openrouter-key-abc')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidNonEmptyAscii('')).toBe(false);
  });

  it('rejects strings containing the unicode replacement character', () => {
    expect(isValidNonEmptyAscii('hello\uFFFDworld')).toBe(false);
  });

  it('rejects strings containing control characters', () => {
    expect(isValidNonEmptyAscii('abc\x00def')).toBe(false);
    expect(isValidNonEmptyAscii('abc\ndef')).toBe(false);
    expect(isValidNonEmptyAscii('abc\x7fdef')).toBe(false);
  });

  it('rejects high-bit / multibyte content', () => {
    expect(isValidNonEmptyAscii('café')).toBe(false);
    expect(isValidNonEmptyAscii('emoji 🤖')).toBe(false);
  });
});

describe('isValidTokenString', () => {
  it('accepts a 16-char ASCII token', () => {
    expect(isValidTokenString('abcdef0123456789')).toBe(true);
  });

  it('rejects strings shorter than 16 chars', () => {
    expect(isValidTokenString('short')).toBe(false);
  });

  it('rejects strings longer than 4096 chars', () => {
    expect(isValidTokenString('a'.repeat(4097))).toBe(false);
  });

  it('rejects strings with U+FFFD even when length is valid', () => {
    expect(isValidTokenString(`abc\uFFFD${'x'.repeat(20)}`)).toBe(false);
  });
});

describe('captureDegradedOnce / clearDegradedLatch', () => {
  it('captures one message per kind during a degraded period', () => {
    captureDegradedOnce('auth-session-token');
    captureDegradedOnce('auth-session-token');
    captureDegradedOnce('auth-session-token');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'auth-session-token' } }),
    );
  });

  it('captures one message per distinct kind', () => {
    captureDegradedOnce('auth-session-token');
    captureDegradedOnce('fly-api-token');
    captureDegradedOnce('auth-session-token');
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('re-captures after clearDegradedLatch', () => {
    captureDegradedOnce('auth-session-token');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    clearDegradedLatch('auth-session-token');
    captureDegradedOnce('auth-session-token');
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('does not throw when errorReporter.captureMessage itself throws', () => {
    captureMessage.mockImplementationOnce(() => {
      throw new Error('reporter blew up');
    });
    expect(() => captureDegradedOnce('auth-session-token')).not.toThrow();
  });
});

describe('decodeStringStore — encryption available', () => {
  function makeOpts(stored: string, decrypt: (buf: Buffer) => string) {
    return {
      stored,
      isEncryptionAvailable: () => true,
      decryptString: decrypt,
      validate: isValidTokenString,
      kind: 'auth-session-token',
    };
  }

  it('returns ok with the decrypted value when decryption succeeds', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeStringStore(makeOpts(stored, () => 'token-1234567890abc'));
    expect(result).toEqual({ kind: 'ok', value: 'token-1234567890abc' });
  });

  it('returns corrupt when decrypt throws on a v10-prefixed payload', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeStringStore(
      makeOpts(stored, () => {
        throw new Error('decrypt failed');
      }),
    );
    expect(result).toEqual({ kind: 'corrupt' });
  });

  it('returns corrupt when decrypt throws on a v11-prefixed payload', () => {
    const stored = Buffer.from('v11ciphertext').toString('base64');
    const result = decodeStringStore(
      makeOpts(stored, () => {
        throw new Error('decrypt failed');
      }),
    );
    expect(result).toEqual({ kind: 'corrupt' });
  });

  it('falls back to plain decode + validate when decrypt throws on unprefixed bytes', () => {
    const plainToken = 'plain-token-1234567';
    const stored = Buffer.from(plainToken).toString('base64');
    const result = decodeStringStore(
      makeOpts(stored, () => {
        throw new Error('decrypt failed');
      }),
    );
    expect(result).toEqual({ kind: 'ok', value: plainToken });
  });

  it('returns null when decrypt-throws fallback fails validation', () => {
    const stored = Buffer.from('short').toString('base64');
    const result = decodeStringStore(
      makeOpts(stored, () => {
        throw new Error('decrypt failed');
      }),
    );
    expect(result).toEqual({ kind: 'null' });
  });
});

describe('decodeStringStore — encryption unavailable', () => {
  function makeOpts(stored: string) {
    return {
      stored,
      isEncryptionAvailable: () => false,
      decryptString: () => {
        throw new Error('not called');
      },
      validate: isValidTokenString,
      kind: 'auth-session-token',
    };
  }

  it('returns unavailable_encrypted on v10-prefixed payload (the bug)', () => {
    const stored = Buffer.from('v10ciphertext-bytes').toString('base64');
    const result = decodeStringStore(makeOpts(stored));
    expect(result).toEqual({ kind: 'unavailable_encrypted' });
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('dedupes Sentry captures across repeated reads in the same degraded period', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    decodeStringStore(makeOpts(stored));
    decodeStringStore(makeOpts(stored));
    decodeStringStore(makeOpts(stored));
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('returns ok on a legitimate plain-stored token (Linux path)', () => {
    const plainToken = 'plain-linux-token-abc';
    const stored = Buffer.from(plainToken).toString('base64');
    const result = decodeStringStore(makeOpts(stored));
    expect(result).toEqual({ kind: 'ok', value: plainToken });
  });

  it('returns null on plain-decode validation failure (no delete)', () => {
    const stored = Buffer.from('xx').toString('base64');
    const result = decodeStringStore(makeOpts(stored));
    expect(result).toEqual({ kind: 'null' });
  });
});

describe('decodeJsonStore', () => {
  type Shape = { accessToken: string; refreshToken: string; expiresAt: number };
  function isShape(parsed: unknown): parsed is Shape {
    if (parsed === null || typeof parsed !== 'object') return false;
    const p = parsed as Record<string, unknown>;
    return (
      typeof p.accessToken === 'string' &&
      p.accessToken.length > 0 &&
      typeof p.refreshToken === 'string' &&
      p.refreshToken.length > 0 &&
      typeof p.expiresAt === 'number' &&
      Number.isFinite(p.expiresAt) &&
      p.expiresAt > 0
    );
  }

  it('returns ok with parsed shape when decryption succeeds', () => {
    const json = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => true,
      decryptString: () => json,
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'ok', value: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
  });

  it('returns null when decrypted JSON fails shape validation (no delete)', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => true,
      decryptString: () => JSON.stringify({ accessToken: '' }),
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'null' });
  });

  it('returns null on malformed JSON after successful decrypt', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => true,
      decryptString: () => 'not json',
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'null' });
  });

  it('falls back to plain JSON decode when decrypt throws on unprefixed bytes', () => {
    const json = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const stored = Buffer.from(json).toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error('decrypt failed');
      },
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'ok', value: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
  });

  it('returns corrupt on decrypt-throws + v10 prefix', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error('decrypt failed');
      },
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'corrupt' });
  });

  it('returns unavailable_encrypted when keychain is down on v10-prefixed bytes', () => {
    const stored = Buffer.from('v10ciphertext').toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => false,
      decryptString: () => {
        throw new Error('not called');
      },
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'unavailable_encrypted' });
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('plain-write + plain-read on Linux returns ok', () => {
    const json = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const stored = Buffer.from(json).toString('base64');
    const result = decodeJsonStore<Shape>({
      stored,
      isEncryptionAvailable: () => false,
      decryptString: () => {
        throw new Error('not called');
      },
      validate: isShape,
      kind: 'provider-oauth-token:fly',
    });
    expect(result).toEqual({ kind: 'ok', value: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
  });
});
