/**
 * OSS no-phone-home gate for the SENTRY_DSN Fly-secret backfill.
 *
 * Unlike `cloudUpdateScheduler.test.ts` (which stubs DSN resolution to pin the
 * backfill mechanics), this suite exercises the REAL resolution chain
 * (`resolveCommercialCloudSentryDsn` -> `resolveSentryDsnForBuild`) with only
 * the platform-config `isOss` signal mocked and `SENTRY_DSN` stubbed into the
 * runtime env. It pins the invariant that an OSS build never forwards an env
 * DSN to a cloud instance as a Fly secret, while commercial builds still do.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';

// ---------------------------------------------------------------------------
// Mocks — every collaborator except the DSN-resolution chain is stubbed so a
// single update cycle can run deterministically. Deliberately NOT mocked:
// `@shared/telemetry/sentryConfig` and `@main/sentryCloudDsn` (the gate under
// test).
// ---------------------------------------------------------------------------

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn() }),
}));

vi.mock('@core/services/cloudUpdateService', () => ({
  checkForCloudUpdate: vi.fn(),
  applyCloudUpdate: vi.fn(),
  getCloudUpdateChannel: vi.fn(() => 'prod'),
  setFlyApiTokenSecret: vi.fn(),
  setSentryDsnSecret: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  updateSettings: vi.fn(),
}));

vi.mock('../flyTokenStorage', () => ({
  loadFlyApiToken: vi.fn(() => 'fly-pat-test'),
}));

vi.mock('@main/utils/buildChannel', () => ({
  getBuildChannel: vi.fn(() => 'stable'),
}));

vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => () => {}),
}));

// Mutable isOss signal — the only platform input the gate reads.
const mockPlatformConfig = vi.hoisted(() => ({ isOss: false }));
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => mockPlatformConfig,
}));

import { checkForCloudUpdate, setSentryDsnSecret } from '@core/services/cloudUpdateService';
import { updateSettings } from '../../settingsStore';
import {
  startCloudUpdateScheduler,
  stopCloudUpdateScheduler,
  _runUpdateCycleForTesting,
} from '../cloudUpdateScheduler';

const ENV_DSN = 'https://[external-email]/42';

function makeSettings(cloudInstanceOverrides?: Partial<CloudInstanceConfig>): AppSettings {
  return {
    cloudInstance: {
      mode: 'cloud',
      provisionMode: 'byok',
      cloudUrl: 'https://rebel-cloud-test.fly.dev',
      flyAppName: 'rebel-cloud-test',
      flyMachineId: 'mach-1',
      ...cloudInstanceOverrides,
    },
  } as unknown as AppSettings;
}

describe('cloudUpdateScheduler SENTRY_DSN backfill — OSS no-phone-home gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin the startup jitter timer far in the future so only the explicit
    // test-driven cycle runs (jitter = random * 60min).
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    vi.stubEnv('SENTRY_DSN', ENV_DSN);
    vi.mocked(checkForCloudUpdate).mockResolvedValue({
      success: true,
      updateAvailable: false,
    } as Awaited<ReturnType<typeof checkForCloudUpdate>>);
    vi.mocked(setSentryDsnSecret).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    stopCloudUpdateScheduler();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('OSS build with SENTRY_DSN in env writes NO Fly secret (and records no repair)', async () => {
    mockPlatformConfig.isOss = true;
    startCloudUpdateScheduler(() => makeSettings());

    await _runUpdateCycleForTesting('interval');

    // The cycle itself ran — only the DSN backfill must be gated off.
    expect(checkForCloudUpdate).toHaveBeenCalledTimes(1);
    expect(setSentryDsnSecret).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({
          sentryDsnSecretRepairedAt: expect.any(Number),
        }),
      }),
    );
  });

  it('commercial build backfills the env DSN as a Fly secret (real resolver)', async () => {
    mockPlatformConfig.isOss = false;
    startCloudUpdateScheduler(() => makeSettings());

    await _runUpdateCycleForTesting('interval');

    expect(setSentryDsnSecret).toHaveBeenCalledWith({
      flyApiToken: 'fly-pat-test',
      flyAppName: 'rebel-cloud-test',
      sentryDsn: ENV_DSN,
    });
  });
});
