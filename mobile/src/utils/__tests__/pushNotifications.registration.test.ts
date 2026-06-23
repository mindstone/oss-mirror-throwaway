/**
 * Regression repro for REBEL-1CN — "Calling the 'getRegistrationInfoAsync'
 * function has failed" (255 events / 2 users, Sentry rebel project, RN SDK).
 *
 * Root cause: `_layout.tsx` calls `registerForPushNotifications(...)` fire-and-
 * forget (un-awaited, no `.catch()`), and the function's permission calls
 * (`getPermissionsAsync` / `requestPermissionsAsync`) sit OUTSIDE its inner
 * try/catch. When the native push-registration call rejects (common on
 * simulators, restricted devices, or transient ExpoModulesCore failures), the
 * rejection escapes as an unhandled promise rejection and is captured by
 * Sentry. The paired-state effect re-runs, so it retries → many events.
 *
 * Contract this test pins: `registerForPushNotifications` must NEVER reject —
 * it owns its own failures and degrades gracefully (the app works without push).
 *
 * RED before the fix (rejection escapes); GREEN after wrapping the whole body.
 */

// expo-notifications: control the permission + token calls so we can force the
// native-failure path. setNotificationHandler/addNotificationResponseReceivedListener
// are invoked at module load, so they must exist on the mock.
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetExpoPushToken = jest.fn();
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetExpoPushToken(...a),
}));

// expo-router pulls in navigator internals that don't load under jest; the
// registration path doesn't use the router, so stub it (mirrors the sibling
// pushNotifications.test.ts).
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project-id' } } } },
}));

jest.mock('@rebel/cloud-client', () => ({
  createLogger: () => ({
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

import { registerForPushNotifications } from '../pushNotifications';

beforeEach(() => {
  mockGetPermissions.mockReset();
  mockRequestPermissions.mockReset();
  mockGetExpoPushToken.mockReset();
  // @ts-expect-error test shim
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));
});

describe('registerForPushNotifications — never rejects (REBEL-1CN)', () => {
  it('resolves (does not reject) when getPermissionsAsync fails natively', async () => {
    // Simulate the native ExpoModulesCore failure behind getRegistrationInfoAsync.
    mockGetPermissions.mockRejectedValue(
      new Error("Calling the 'getRegistrationInfoAsync' function has failed"),
    );

    // Must not reject. On the unfixed code this rejection escapes.
    await expect(registerForPushNotifications('https://cloud.example', 'tok')).resolves.toBeUndefined();
  });

  it('resolves when requestPermissionsAsync fails natively', async () => {
    mockGetPermissions.mockResolvedValue({ status: 'undetermined' });
    mockRequestPermissions.mockRejectedValue(
      new Error("Calling the 'getRegistrationInfoAsync' function has failed"),
    );

    await expect(registerForPushNotifications('https://cloud.example', 'tok')).resolves.toBeUndefined();
  });

  it('resolves when getExpoPushTokenAsync fails (already-guarded path stays green)', async () => {
    mockGetPermissions.mockResolvedValue({ status: 'granted' });
    mockGetExpoPushToken.mockRejectedValue(new Error('token backend down'));

    await expect(registerForPushNotifications('https://cloud.example', 'tok')).resolves.toBeUndefined();
  });
});
