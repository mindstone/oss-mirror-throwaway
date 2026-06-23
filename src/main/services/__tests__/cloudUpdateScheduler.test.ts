import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';

// ---------------------------------------------------------------------------
// Mocks — the scheduler orchestrates main-process singletons; every collaborator
// is stubbed so a single update cycle can run deterministically.
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

// The OSS no-phone-home gate itself is exercised UNMOCKED in
// cloudUpdateScheduler.ossDsnGate.test.ts; here it is stubbed so this suite
// pins the backfill mechanics deterministically.
vi.mock('@main/sentryCloudDsn', () => ({
  resolveCommercialCloudSentryDsn: vi.fn(),
}));

import { checkForCloudUpdate, setSentryDsnSecret } from '@core/services/cloudUpdateService';
import { resolveCommercialCloudSentryDsn } from '@main/sentryCloudDsn';
import { updateSettings } from '../../settingsStore';
import {
  startCloudUpdateScheduler,
  stopCloudUpdateScheduler,
  _runUpdateCycleForTesting,
} from '../cloudUpdateScheduler';

const TEST_DSN = 'https://public@example.invalid/1';

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

function startWithSettings(settings: AppSettings): void {
  startCloudUpdateScheduler(() => settings);
}

describe('cloudUpdateScheduler SENTRY_DSN backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin the startup jitter timer far in the future so only the explicit
    // test-driven cycle runs (jitter = random * 60min).
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    vi.mocked(checkForCloudUpdate).mockResolvedValue({
      success: true,
      updateAvailable: false,
    } as Awaited<ReturnType<typeof checkForCloudUpdate>>);
    vi.mocked(setSentryDsnSecret).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    stopCloudUpdateScheduler();
    vi.restoreAllMocks();
  });

  it('backfills the SENTRY_DSN secret even when no update is available', async () => {
    vi.mocked(resolveCommercialCloudSentryDsn).mockReturnValue(TEST_DSN);
    startWithSettings(makeSettings());

    await _runUpdateCycleForTesting('interval');

    // checkForCloudUpdate ran and reported up-to-date — the backfill must
    // still fire (it sits BEFORE the update-available early-return so the
    // existing fleet converges on every 24h cycle, not only on updates).
    expect(checkForCloudUpdate).toHaveBeenCalledTimes(1);
    expect(setSentryDsnSecret).toHaveBeenCalledWith({
      flyApiToken: 'fly-pat-test',
      flyAppName: 'rebel-cloud-test',
      sentryDsn: TEST_DSN,
    });
    expect(updateSettings).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({
        sentryDsnSecretRepairedAt: expect.any(Number),
      }),
    });
  });

  it('skips the backfill when sentryDsnSecretRepairedAt is already set', async () => {
    vi.mocked(resolveCommercialCloudSentryDsn).mockReturnValue(TEST_DSN);
    startWithSettings(makeSettings({ sentryDsnSecretRepairedAt: 1_700_000_000_000 }));

    await _runUpdateCycleForTesting('interval');

    expect(checkForCloudUpdate).toHaveBeenCalledTimes(1);
    expect(setSentryDsnSecret).not.toHaveBeenCalled();
  });

  it('skips the backfill when no DSN resolves (OSS / dev builds)', async () => {
    vi.mocked(resolveCommercialCloudSentryDsn).mockReturnValue(undefined);
    startWithSettings(makeSettings());

    await _runUpdateCycleForTesting('interval');

    expect(checkForCloudUpdate).toHaveBeenCalledTimes(1);
    expect(setSentryDsnSecret).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does not persist the repaired-at flag when the secret write fails (retries next cycle)', async () => {
    vi.mocked(resolveCommercialCloudSentryDsn).mockReturnValue(TEST_DSN);
    vi.mocked(setSentryDsnSecret).mockResolvedValue({ success: false, error: 'permission denied' });
    startWithSettings(makeSettings());

    await _runUpdateCycleForTesting('interval');

    expect(setSentryDsnSecret).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
