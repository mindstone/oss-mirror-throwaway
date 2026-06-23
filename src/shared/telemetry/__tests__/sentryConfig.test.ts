import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROFILES_SAMPLE_RATE,
  DEFAULT_REPLAYS_ERROR_SAMPLE_RATE,
  DEFAULT_REPLAYS_SESSION_SAMPLE_RATE,
  DEFAULT_TRACES_SAMPLE_RATE,
  buildSentryRelease,
  isSentryExplicitlyDisabledByEnv,
  shouldEnableSentry,
} from '../sentryConfig';

describe('sentryConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('buildSentryRelease', () => {
    it('uses SENTRY_RELEASE override when provided', () => {
      vi.stubEnv('SENTRY_RELEASE', '  custom-release  ');

      expect(buildSentryRelease('1.2.3', 'beta')).toBe('custom-release');
    });

    it('builds release from version and channel when override is absent', () => {
      expect(buildSentryRelease('1.2.3', 'stable')).toBe('mindstone-rebel@1.2.3');
      expect(buildSentryRelease('1.2.3', 'beta')).toBe('mindstone-rebel-beta@1.2.3');
      expect(buildSentryRelease('1.2.3', 'dev')).toBe('mindstone-rebel-dev@1.2.3');
    });

    it('falls back to dev version when version is missing', () => {
      expect(buildSentryRelease(undefined, 'stable')).toBe('mindstone-rebel@dev');
      expect(buildSentryRelease('   ', 'stable')).toBe('mindstone-rebel@dev');
    });
  });

  describe('shouldEnableSentry', () => {
    it('respects SENTRY_ENABLED override when set to true-ish values', () => {
      vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
      vi.stubEnv('SENTRY_ENABLED', 'true');
      expect(shouldEnableSentry({ isPackaged: false })).toBe(true);

      vi.stubEnv('SENTRY_ENABLED', '1');
      expect(shouldEnableSentry({ isPackaged: false })).toBe(true);
    });

    it('respects SENTRY_ENABLED override when set to false-ish values', () => {
      vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
      vi.stubEnv('SENTRY_ENABLED', 'off');
      expect(shouldEnableSentry({ isPackaged: true })).toBe(false);

      vi.stubEnv('SENTRY_ENABLED', '0');
      expect(shouldEnableSentry({ isPackaged: true })).toBe(false);
    });

    it('defaults off when SENTRY_DSN is absent', () => {
      vi.stubEnv('SENTRY_DSN', '');
      vi.stubEnv('SENTRY_ENABLED', 'true');

      expect(shouldEnableSentry({ isPackaged: true })).toBe(false);
      expect(shouldEnableSentry({ isPackaged: false })).toBe(false);
      expect(shouldEnableSentry()).toBe(false);
    });

    it('enables when SENTRY_DSN is present and no override is set', () => {
      vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');

      expect(shouldEnableSentry({ isPackaged: true })).toBe(true);
      expect(shouldEnableSentry({ isPackaged: false })).toBe(true);
      expect(shouldEnableSentry()).toBe(true);
    });

    // F4: when the `dsn` key is present (the OSS gate always passes it, value
    // possibly empty), do NOT fall back to the env DSN — "override present +
    // empty" means "do not enable". Enterprise (no `dsn` key) is unchanged.
    it('does NOT fall back to env DSN when the dsn key is present but empty (OSS-off)', () => {
      vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
      vi.stubEnv('SENTRY_ENABLED', '');

      expect(shouldEnableSentry({ dsn: undefined })).toBe(false);
      expect(shouldEnableSentry({ dsn: '' })).toBe(false);
      expect(shouldEnableSentry({ isPackaged: true, dsn: undefined })).toBe(false);
    });

    it('uses the supplied dsn verbatim when the dsn key is present (OSS-on with user DSN)', () => {
      vi.stubEnv('SENTRY_DSN', '');

      expect(shouldEnableSentry({ dsn: 'https://user.invalid/9' })).toBe(true);
    });
  });

  describe('isSentryExplicitlyDisabledByEnv', () => {
    // Drives the main → renderer `--rebel-sentry-disabled` suppression bridge:
    // must be true ONLY on an explicit false-ish opt-out, regardless of DSN.
    it('is true for explicit false-ish SENTRY_ENABLED values', () => {
      for (const value of ['0', 'false', 'no', 'off', ' OFF ']) {
        vi.stubEnv('SENTRY_ENABLED', value);
        expect(isSentryExplicitlyDisabledByEnv()).toBe(true);
      }
    });

    it('is false when SENTRY_ENABLED is unset, empty, unrecognized, or true-ish', () => {
      vi.stubEnv('SENTRY_ENABLED', '');
      expect(isSentryExplicitlyDisabledByEnv()).toBe(false);

      vi.stubEnv('SENTRY_ENABLED', 'banana');
      expect(isSentryExplicitlyDisabledByEnv()).toBe(false);

      for (const value of ['1', 'true', 'yes', 'on']) {
        vi.stubEnv('SENTRY_ENABLED', value);
        expect(isSentryExplicitlyDisabledByEnv()).toBe(false);
      }
    });

    it('ignores the DSN entirely (asks only about the explicit opt-out)', () => {
      vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
      vi.stubEnv('SENTRY_ENABLED', '0');
      expect(isSentryExplicitlyDisabledByEnv()).toBe(true);

      vi.stubEnv('SENTRY_DSN', '');
      expect(isSentryExplicitlyDisabledByEnv()).toBe(true);
    });
  });

  describe('sample rate defaults', () => {
    it('stay within the valid [0, 1] range', () => {
      const sampleRates = [
        DEFAULT_TRACES_SAMPLE_RATE,
        DEFAULT_PROFILES_SAMPLE_RATE,
        DEFAULT_REPLAYS_SESSION_SAMPLE_RATE,
        DEFAULT_REPLAYS_ERROR_SAMPLE_RATE,
      ];

      for (const rate of sampleRates) {
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    });
  });
});
