/**
 * Stage B3 fix — pairing-funnel reaches the SDK (native must-address).
 *
 * Before the fix, analytics initialised only AFTER pairing, so the pairing
 * funnel (Pair Started/Succeeded/Failed — emitted in PairScreen while still
 * UNPAIRED) was eaten by the post-pair gate. Under the corrected always-on
 * model, init happens at app LAUNCH gated only on `isAnalyticsPermitted()`, so
 * the funnel — emitted via the real `tracking` wrappers through the real
 * `analytics` singleton — actually lands.
 *
 * This drives the REAL singleton + REAL tracking wrappers (only the RudderStack
 * SDK is mocked) to prove the funnel is no longer gated out by pairing state.
 */

const mockSetup = jest.fn().mockResolvedValue(undefined);
const mockTrack = jest.fn().mockResolvedValue(undefined);

jest.mock('@rudderstack/rudder-sdk-react-native', () => ({
  __esModule: true,
  default: {
    setup: (...args: unknown[]) => mockSetup(...args),
    track: (...args: unknown[]) => mockTrack(...args),
    identify: jest.fn(),
    flush: jest.fn(),
    reset: jest.fn(),
  },
}));

jest.mock('../anonymousId', () => ({
  resolveAnonymousId: jest.fn().mockResolvedValue('install-id-123'),
}));

import { analytics, isAnalyticsPermitted, __resetAnalyticsStateForTests } from '../analytics';
import { tracking } from '../tracking';

const WRITE_KEY = 'EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY';
const DATA_PLANE = 'EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL';

beforeEach(() => {
  jest.clearAllMocks();
  __resetAnalyticsStateForTests();
  process.env[WRITE_KEY] = 'wk';
  process.env[DATA_PLANE] = 'https://dp.example';
});

afterAll(() => {
  delete process.env[WRITE_KEY];
  delete process.env[DATA_PLANE];
});

describe('launch-init pairing funnel', () => {
  it('init runs at launch purely on credentials (NO pairing dependency)', async () => {
    expect(isAnalyticsPermitted()).toBe(true);
    await analytics.init(); // simulates the app-launch mount effect (unpaired)
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(analytics.isAvailable()).toBe(true);
  });

  it('pairing funnel (Started/Succeeded/Failed) reaches the SDK once init has run — even while unpaired', async () => {
    await analytics.init(); // launch-time, BEFORE any pairing

    // These are emitted in PairScreen while isPaired === false.
    tracking.pair.started('scan');
    tracking.pair.succeeded('scan');
    tracking.pair.failed('manual', 'auth');

    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events).toEqual(['Pair Started', 'Pair Succeeded', 'Pair Failed']);
    // client_surface tag still injected, non-overridable.
    for (const call of mockTrack.mock.calls) {
      expect((call[1] as Record<string, unknown>).client_surface).toBe('mobile');
    }
  });

  it('the funnel WOULD have been dropped if init had not run (regression characterisation)', () => {
    // No init() — mirrors the old post-pair-only behaviour for Pair Failed.
    tracking.pair.failed('scan', 'network');
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
