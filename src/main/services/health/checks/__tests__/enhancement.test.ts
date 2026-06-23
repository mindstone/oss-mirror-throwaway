import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

vi.mock('../../../enhancementService', () => ({
  isEnhancementRunning: vi.fn(),
  isEnhancementPaused: vi.fn(),
}));

vi.mock('../../../fileIndexService', () => ({
  getEnhancementState: vi.fn(),
}));

vi.mock('../../../fileWatcherService', () => ({
  getWatcherStatus: vi.fn(),
  AUTO_ENHANCE_FILE_THRESHOLD: 1000,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(),
}));

import { isEnhancementRunning, isEnhancementPaused } from '../../../enhancementService';
import { getEnhancementState } from '../../../fileIndexService';
import { getWatcherStatus } from '../../../fileWatcherService';
import { getSettings } from '@core/services/settingsStore';
import { checkEnhancementHealth } from '../enhancement';

const mockIsRunning = vi.mocked(isEnhancementRunning);
const mockIsPaused = vi.mocked(isEnhancementPaused);
const mockGetState = vi.mocked(getEnhancementState);
const mockGetWatcher = vi.mocked(getWatcherStatus);
const mockGetSettings = vi.mocked(getSettings);

function setSettings(partial: Partial<AppSettings>): void {
  mockGetSettings.mockReturnValue(partial as AppSettings);
}

function setWorkspaceSize(totalFiles: number): void {
  mockGetWatcher.mockReturnValue({ totalFiles } as ReturnType<typeof getWatcherStatus>);
}

function makeState(totalChunks: number, enhancedChunks: number): ReturnType<typeof getEnhancementState> {
  return { totalChunks, enhancedChunks, isRunning: false, isPaused: false, schemaSupportsEnhancement: true };
}

describe('checkEnhancementHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockReturnValue(false);
    mockIsPaused.mockReturnValue(false);
    mockGetState.mockReturnValue(makeState(0, 0));
    setWorkspaceSize(500); // small workspace by default
    setSettings({});
  });

  describe('not-running with chunks remaining (the previously misreported branch)', () => {
    beforeEach(() => {
      mockIsRunning.mockReturnValue(false);
      mockIsPaused.mockReturnValue(false);
      mockGetState.mockReturnValue(makeState(70_521, 0));
    });

    it('returns pass ("disabled in settings") when backgroundEnhancement === false', () => {
      setSettings({ backgroundEnhancement: false });
      setWorkspaceSize(9_549);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toBe('Background enhancement disabled in settings');
      expect(result.details).toMatchObject({ reason: 'disabled-in-settings', remaining: 70_521 });
      // remediation is dead on pass results — should not be set.
      expect(result.remediation).toBeUndefined();
    });

    it('returns pass ("paused by user") when enhancementUserRequested === false', () => {
      setSettings({ enhancementUserRequested: false });
      setWorkspaceSize(9_549);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toContain('paused');
      expect(result.message).toContain('70,521');
      expect(result.details).toMatchObject({ reason: 'paused-by-user', remaining: 70_521 });
      expect(result.remediation).toBeUndefined();
    });

    it('returns pass ("available, awaiting opt-in") for LARGE workspace with enhancementUserRequested undefined (the user-reported false alarm)', () => {
      // Reproduces the user-reported case: 9,549-file workspace > AUTO_ENHANCE_FILE_THRESHOLD,
      // never opted in, worker deliberately not started by the auto-skip gate in fileWatcherService.
      setSettings({});
      setWorkspaceSize(9_549);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toContain('available');
      expect(result.message).toContain('70,521');
      expect(result.details).toMatchObject({
        reason: 'awaiting-opt-in',
        remaining: 70_521,
        totalFiles: 9_549,
        autoEnhanceFileThreshold: 1000,
      });
    });

    it('returns warn ("stopped") for SMALL workspace with chunks remaining (worker should have auto-started, didn\'t — silent-failure regression guard)', () => {
      // Small workspace: worker auto-starts regardless of opt-in setting.
      // If we still see !isRunning and chunks remaining, something failed silently.
      setSettings({});
      setWorkspaceSize(500);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('warn');
      expect(result.message).toContain('stopped');
      expect(result.details).toMatchObject({ reason: 'unexpected-stop', remaining: 70_521 });
      expect(result.remediation).toMatch(/errors/);
    });

    it('returns warn ("stopped") when user opted in (enhancementUserRequested === true) but worker isn\'t running, regardless of workspace size', () => {
      setSettings({ enhancementUserRequested: true });
      setWorkspaceSize(9_549); // even with large workspace, opt-in means it should be running

      const result = checkEnhancementHealth();

      expect(result.status).toBe('warn');
      expect(result.message).toContain('stopped');
      expect(result.details).toMatchObject({ reason: 'unexpected-stop', remaining: 70_521 });
    });

    it('boundary: workspace at exactly the threshold (1000) is treated as small (auto-start should fire)', () => {
      // Worker uses `> AUTO_ENHANCE_FILE_THRESHOLD` (strict), so exactly 1000 = small.
      setSettings({});
      setWorkspaceSize(1000);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('warn');
      expect(result.details).toMatchObject({ reason: 'unexpected-stop' });
    });

    it('boundary: workspace at threshold + 1 is treated as large (auto-skip awaiting opt-in)', () => {
      setSettings({});
      setWorkspaceSize(1001);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.details).toMatchObject({ reason: 'awaiting-opt-in' });
    });

    it('disabled-in-settings beats opted-in (defensive precedence, mirrors worker gate order)', () => {
      setSettings({ backgroundEnhancement: false, enhancementUserRequested: true });

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.details).toMatchObject({ reason: 'disabled-in-settings' });
    });

    it('treats non-true enhancementUserRequested values (null, undefined) consistently for large workspaces', () => {
      // Defensive: corrupted/legacy storage shouldn't change branch semantics.
      mockGetSettings.mockReturnValue({ enhancementUserRequested: null } as unknown as AppSettings);
      setWorkspaceSize(9_549);

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.details).toMatchObject({ reason: 'awaiting-opt-in' });
    });
  });

  describe('regression guards (existing branches)', () => {
    it('returns warn when explicitly paused mid-run (isPaused)', () => {
      mockIsRunning.mockReturnValue(true);
      mockIsPaused.mockReturnValue(true);
      mockGetState.mockReturnValue(makeState(100, 25));

      const result = checkEnhancementHealth();

      expect(result.status).toBe('warn');
      expect(result.message).toBe('Enhancement service is paused');
    });

    it('returns pass with progress when running', () => {
      mockIsRunning.mockReturnValue(true);
      mockIsPaused.mockReturnValue(false);
      mockGetState.mockReturnValue(makeState(100, 42));
      setSettings({ enhancementUserRequested: true });

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toMatch(/running.*42%/);
    });

    it('returns pass when there are no chunks at all', () => {
      mockIsRunning.mockReturnValue(false);
      mockGetState.mockReturnValue(makeState(0, 0));

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toBe('No chunks to enhance');
    });

    it('returns pass when all chunks are enhanced (worker has finished naturally)', () => {
      mockIsRunning.mockReturnValue(false);
      mockGetState.mockReturnValue(makeState(100, 100));
      setSettings({ enhancementUserRequested: true });

      const result = checkEnhancementHealth();

      expect(result.status).toBe('pass');
      expect(result.message).toBe('Enhancement complete');
    });
  });
});
