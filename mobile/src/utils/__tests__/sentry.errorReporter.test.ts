jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  init: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
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
    },
  },
}));

import * as Sentry from '@sentry/react-native';
import { initSentry, mobileErrorReporter } from '../sentry';

describe('mobileErrorReporter Sentry pass-through', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://example.invalid/1';
    initSentry();
    jest.clearAllMocks();
  });

  it('passes captureException context through to Sentry without wrapping', () => {
    const error = new Error('boom');
    const context = { fingerprint: ['x'], level: 'warning', tags: { foo: 'bar' }, extra: { z: 1 } };

    mobileErrorReporter.captureException(error, context);

    expect(Sentry.captureException).toHaveBeenCalledWith(error, context);
  });

  it('passes captureMessage context through to Sentry without wrapping', () => {
    const context = { fingerprint: ['x'], level: 'warning', tags: { foo: 'bar' }, extra: { z: 1 } };

    mobileErrorReporter.captureMessage('hello', context);

    expect(Sentry.captureMessage).toHaveBeenCalledWith('hello', context);
  });

  it('W2D-5: emits console.warn when Sentry.captureException throws and does not propagate the throw', () => {
    const transportError = new Error('Sentry transport failure');
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw transportError;
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const error = new Error('boom');
    expect(() => mobileErrorReporter.captureException(error, {})).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('[mobileErrorReporter] capture failed', transportError);

    warnSpy.mockRestore();
  });
});
