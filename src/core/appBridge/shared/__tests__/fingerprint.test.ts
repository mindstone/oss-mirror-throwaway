import { describe, expect, it } from 'vitest';
import {
  formatExtensionIdFingerprint,
  redactExtensionIdForLog,
} from '@core/appBridge/shared/fingerprint';

describe('appBridge/shared/fingerprint', () => {
  it('formats a 32-char extension id into 8-8-8-8 groups', () => {
    expect(
      formatExtensionIdFingerprint('ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'),
    ).toBe('abcdefgh-ijklmnop-abcdefgh-ijklmnop');
  });

  it('returns empty string for empty input', () => {
    expect(formatExtensionIdFingerprint('')).toBe('');
  });

  it('preserves non-standard inputs', () => {
    expect(formatExtensionIdFingerprint('not-a-standard-extension-id')).toBe(
      'not-a-standard-extension-id',
    );
  });

  it('redacts extension ids to the final 8 chars', () => {
    expect(redactExtensionIdForLog('abcdefghijklmnopabcdefghijklmnop')).toBe('…ijklmnop');
    expect(redactExtensionIdForLog('short')).toBe('***');
  });
});
