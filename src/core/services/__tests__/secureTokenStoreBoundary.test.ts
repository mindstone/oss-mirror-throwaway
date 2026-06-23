import { describe, expect, it } from 'vitest';
import {
  assertSecureTokenLiveKey,
  getSecureTokenCorruptSidecarKey,
  isSecureTokenReservedSidecarKey,
  SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX,
} from '@core/secureTokenStore';

describe('secureTokenStore reserved sidecar key helpers', () => {
  it('derives sidecar keys from valid live keys', () => {
    expect(getSecureTokenCorruptSidecarKey('encryptedTokens')).toBe(`encryptedTokens${SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX}`);
  });

  it('marks reserved sidecar keys and rejects them as live keys', () => {
    const reservedKey = `encryptedTokens${SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX}`;
    expect(isSecureTokenReservedSidecarKey(reservedKey)).toBe(true);
    expect(() => assertSecureTokenLiveKey(reservedKey)).toThrow(/reserved for corruption sidecars/i);
    expect(() => getSecureTokenCorruptSidecarKey(reservedKey)).toThrow(/reserved for corruption sidecars/i);
  });
});
