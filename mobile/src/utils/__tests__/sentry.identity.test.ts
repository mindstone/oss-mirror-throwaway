jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  init: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  wrap: jest.fn((component) => component),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '1.0.0-test',
      runtimeVersion: '42',
    },
  },
}));

import * as Sentry from '@sentry/react-native';
import {
  initSentry,
  setSentryUser,
  setSentryHealthContext,
  clearSentryContext,
} from '../sentry';

describe('mobile Sentry identity + health context', () => {
  beforeEach(() => {
    // initSentry is idempotent (guarded by _initAttempted); a DSN must be
    // present so _sentryEnabled flips true. The first run in the suite is the
    // one that takes effect — subsequent calls are no-ops, which is fine.
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://example.invalid/1';
    initSentry();
    jest.clearAllMocks();
  });

  describe('setSentryUser', () => {
    it('calls Sentry.setUser with { email } when only an email is present', () => {
      setSentryUser({ email: 'worker@example.com' });
      expect(Sentry.setUser).toHaveBeenCalledTimes(1);
      expect(Sentry.setUser).toHaveBeenCalledWith({ email: 'worker@example.com' });
    });

    it('includes id alongside email when both are present', () => {
      setSentryUser({ id: 'abc', email: 'worker@example.com' });
      expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'abc', email: 'worker@example.com' });
    });

    it('sets Sentry user to { id: rebel_client_id } when email is absent (anon-id fallback — F4)', () => {
      // Mobile must NOT go user-less when email is unknown: it falls back to the
      // shared anonymous install id (rebel_client_id), matching desktop and the
      // analytics anonymousId so the two telemetry streams stay identity-consistent.
      setSentryUser({ id: 'rebel-client-xyz' });
      expect(Sentry.setUser).toHaveBeenCalledTimes(1);
      expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'rebel-client-xyz' });
    });

    it('does not set a user (graceful degradation) when NEITHER id nor email resolve', () => {
      setSentryUser({ email: undefined });
      setSentryUser({ email: null });
      setSentryUser({ id: undefined, email: null });
      setSentryUser({});
      expect(Sentry.setUser).not.toHaveBeenCalled();
    });
  });

  describe('clearSentryContext', () => {
    it('clears the Sentry user by passing null', () => {
      clearSentryContext();
      expect(Sentry.setUser).toHaveBeenCalledTimes(1);
      expect(Sentry.setUser).toHaveBeenCalledWith(null);
    });
  });

  describe('setSentryHealthContext', () => {
    it('sets the mobileHealth context with version, runtime, paired, and online', () => {
      setSentryHealthContext({ paired: true, online: true });
      expect(Sentry.setContext).toHaveBeenCalledTimes(1);
      const [contextName, payload] = (Sentry.setContext as jest.Mock).mock.calls[0];
      expect(contextName).toBe('mobileHealth');
      expect(payload).toMatchObject({
        appVersion: '1.0.0-test',
        runtimeVersion: '42',
        paired: true,
        online: true,
      });
      expect(typeof payload.capturedAt).toBe('string');
    });

    it('records online as null when not provided', () => {
      setSentryHealthContext({ paired: false });
      const [, payload] = (Sentry.setContext as jest.Mock).mock.calls[0];
      expect(payload).toMatchObject({ paired: false, online: null });
    });
  });
});
