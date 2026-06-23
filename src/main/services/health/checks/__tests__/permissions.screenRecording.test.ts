/**
 * Pin suite for checkScreenRecordingPermission (RC-5).
 *
 * Screen Recording is only needed for LOCAL meeting recording, and Rebel now
 * requests it on-demand at the first local recording rather than eagerly at
 * startup. This probe makes the OS grant status observable in diagnostics:
 * - granted        → pass
 * - not-determined → pass (expected until first local recording; no nag)
 * - denied         → warn (with remediation)
 * - restricted     → warn (with remediation)
 * - non-darwin     → pass ("Not required on this platform")
 * - cloud context  → pass ("Not applicable in cloud context")
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getMediaAccessStatus = vi.fn();

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: vi.fn(() => ({ systemPreferences: { getMediaAccessStatus } })),
}));

import { checkScreenRecordingPermission } from '../permissions';
import { getElectronModule } from '@core/lazyElectron';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('checkScreenRecordingPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getElectronModule).mockReturnValue({
      systemPreferences: { getMediaAccessStatus },
    } as unknown as ReturnType<typeof getElectronModule>);
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it('passes when permission is granted', () => {
    getMediaAccessStatus.mockReturnValue('granted');
    const result = checkScreenRecordingPermission();
    expect(result.id).toBe('screenRecordingPermission');
    expect(result.status).toBe('pass');
    expect(getMediaAccessStatus).toHaveBeenCalledWith('screen');
  });

  it('passes (no nag) when permission is not yet requested', () => {
    getMediaAccessStatus.mockReturnValue('not-determined');
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/first record/i);
  });

  it('warns with remediation when permission is denied', () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('warn');
    expect(result.remediation).toMatch(/Screen Recording/i);
  });

  it('warns when permission is restricted', () => {
    getMediaAccessStatus.mockReturnValue('restricted');
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('warn');
  });

  it('passes on non-darwin platforms without touching systemPreferences', () => {
    setPlatform('win32');
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/Not required on this platform/i);
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it('passes (cloud context) when Electron module is unavailable', () => {
    vi.mocked(getElectronModule).mockReturnValue(null);
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/cloud context/i);
  });

  it('warns gracefully if the status lookup throws', () => {
    getMediaAccessStatus.mockImplementation(() => {
      throw new Error('TCC unavailable');
    });
    const result = checkScreenRecordingPermission();
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/Could not check/i);
  });
});
