import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures variables are available to hoisted vi.mock calls
// ---------------------------------------------------------------------------

const { mockBroadcastToAllWindows, mockExecFile, mockReaddir, mockStat } = vi.hoisted(() => ({
  mockBroadcastToAllWindows: vi.fn(),
  mockExecFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('@main/utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
}));

// Track execFile calls for assertions
type ExecFileCallback = (
  error: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...(args as [string, string[], Record<string, unknown>, ExecFileCallback])),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import type { SpaceConfig, SpaceStorageProvider } from '@shared/types';
import {
  checkDriveAppRunning,
  checkOfflineAvailability,
  runSharedDriveHealthChecks,
  type SharedDriveHealthResult,
} from '../sharedDriveHealthService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
}

function makeSpace(overrides: Partial<SpaceConfig> = {}): SpaceConfig {
  return {
    name: 'Test Space',
    path: 'work/Company/TestSpace',
    type: 'team',
    isSymlink: true,
    storageProvider: 'google_drive',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sharedDriveHealthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    restorePlatform();
    vi.useRealTimers();
  });

  // =========================================================================
  // checkDriveAppRunning
  // =========================================================================

  describe('checkDriveAppRunning', () => {
    describe('macOS (darwin)', () => {
      beforeEach(() => setPlatform('darwin'));

      it('returns "running" when pgrep exits with code 0', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '12345\n', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('running');
        expect(mockExecFile).toHaveBeenCalledWith(
          'pgrep',
          ['-f', 'Google Drive'],
          expect.objectContaining({ timeout: 5000 }),
          expect.any(Function),
        );
      });

      it('returns "not_running" when pgrep exits with code 1', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('pgrep: no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('onedrive');
        expect(result).toBe('not_running');
        expect(mockExecFile).toHaveBeenCalledWith(
          'pgrep',
          ['-f', 'OneDrive.app/Contents/MacOS/OneDrive|OneDrive Sync Service'],
          expect.any(Object),
          expect.any(Function),
        );
      });

      it('returns "unknown" when pgrep binary is not found (ENOENT)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('spawn pgrep ENOENT') as Error & { code: string };
          error.code = 'ENOENT';
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('dropbox');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" when pgrep times out', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('killed') as Error & { killed: boolean; signal: string };
          error.killed = true;
          error.signal = 'SIGTERM';
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on permission error (EPERM)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('spawn pgrep EPERM') as Error & { code: string };
          error.code = 'EPERM';
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" for unexpected exit codes', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('pgrep error') as Error & { code: number };
          error.code = 2;
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
      });

      it('uses correct process patterns per provider', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        await checkDriveAppRunning('google_drive');
        expect(mockExecFile).toHaveBeenCalledWith('pgrep', ['-f', 'Google Drive'], expect.any(Object), expect.any(Function));

        mockExecFile.mockClear();
        await checkDriveAppRunning('onedrive');
        expect(mockExecFile).toHaveBeenCalledWith('pgrep', ['-f', 'OneDrive.app/Contents/MacOS/OneDrive|OneDrive Sync Service'], expect.any(Object), expect.any(Function));

        mockExecFile.mockClear();
        await checkDriveAppRunning('dropbox');
        expect(mockExecFile).toHaveBeenCalledWith('pgrep', ['-f', 'Dropbox'], expect.any(Object), expect.any(Function));
      });
    });

    describe('Windows (win32)', () => {
      beforeEach(() => setPlatform('win32'));

      it('returns "running" when tasklist output contains the exe name', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '"GoogleDriveFS.exe","1234","Console","1","50,000 K"\r\n', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('running');
        expect(mockExecFile).toHaveBeenCalledWith(
          'tasklist',
          ['/FI', 'IMAGENAME eq GoogleDriveFS.exe', '/FO', 'CSV', '/NH'],
          expect.objectContaining({ timeout: 5000 }),
          expect.any(Function),
        );
      });

      it('returns "not_running" when tasklist reports no matching tasks', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, 'INFO: No tasks are running which match the specified criteria.\r\n', '');
        });

        const result = await checkDriveAppRunning('onedrive');
        expect(result).toBe('not_running');
      });

      it('returns "unknown" on tasklist error', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('tasklist failed') as Error & { code: string };
          error.code = 'ENOENT';
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('dropbox');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on tasklist timeout', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('killed') as Error & { killed: boolean; signal: string };
          error.killed = true;
          error.signal = 'SIGTERM';
          cb(error, '', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" when tasklist returns empty output', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '', '');
        });

        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
      });

      it('uses correct exe names per provider', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '"TestProcess.exe","1","Console","1","10 K"\r\n', '');
        });

        await checkDriveAppRunning('google_drive');
        expect(mockExecFile).toHaveBeenCalledWith('tasklist', expect.arrayContaining(['IMAGENAME eq GoogleDriveFS.exe']), expect.any(Object), expect.any(Function));

        mockExecFile.mockClear();
        await checkDriveAppRunning('onedrive');
        expect(mockExecFile).toHaveBeenCalledWith('tasklist', expect.arrayContaining(['IMAGENAME eq OneDrive.exe']), expect.any(Object), expect.any(Function));

        mockExecFile.mockClear();
        await checkDriveAppRunning('dropbox');
        expect(mockExecFile).toHaveBeenCalledWith('tasklist', expect.arrayContaining(['IMAGENAME eq Dropbox.exe']), expect.any(Object), expect.any(Function));
      });
    });

    describe('Platform guard', () => {
      it('returns "unknown" on Linux', async () => {
        setPlatform('linux');
        const result = await checkDriveAppRunning('google_drive');
        expect(result).toBe('unknown');
        expect(mockExecFile).not.toHaveBeenCalled();
      });

      it('returns "unknown" on unsupported platforms', async () => {
        setPlatform('freebsd');
        const result = await checkDriveAppRunning('onedrive');
        expect(result).toBe('unknown');
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });

    describe('Unknown provider', () => {
      it('returns "unknown" for providers without process name mapping', async () => {
        setPlatform('darwin');
        const result = await checkDriveAppRunning('box' as SpaceStorageProvider);
        expect(result).toBe('unknown');
        expect(mockExecFile).not.toHaveBeenCalled();
      });

      it('returns "unknown" for "local" provider', async () => {
        setPlatform('darwin');
        const result = await checkDriveAppRunning('local');
        expect(result).toBe('unknown');
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // runSharedDriveHealthChecks
  // =========================================================================

  describe('runSharedDriveHealthChecks', () => {
    beforeEach(() => setPlatform('darwin'));

    describe('Space filtering', () => {
      it('skips non-symlink spaces', async () => {
        const spaces = [makeSpace({ isSymlink: false })];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('skips spaces without storageProvider and no detectable sourcePath', async () => {
        const spaces = [makeSpace({ storageProvider: undefined, sourcePath: undefined })];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('detects provider from sourcePath when storageProvider is missing', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: undefined,
            sourcePath: '/Users/me/OneDrive - Company/Projects',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // Should detect onedrive from sourcePath and run a process check
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile).toHaveBeenCalledWith(
          'pgrep',
          ['-f', 'OneDrive.app/Contents/MacOS/OneDrive|OneDrive Sync Service'],
          expect.any(Object),
          expect.any(Function),
        );
      });

      it('detects Google Drive from sourcePath fallback', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: undefined,
            sourcePath: '/Users/me/Library/CloudStorage/[external-email]/My Drive/Work',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).toHaveBeenCalledWith(
          'pgrep',
          ['-f', 'Google Drive'],
          expect.any(Object),
          expect.any(Function),
        );
      });

      it('detects Dropbox from sourcePath fallback', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: undefined,
            sourcePath: '/Users/me/Dropbox/Work',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).toHaveBeenCalledWith(
          'pgrep',
          ['-f', 'Dropbox'],
          expect.any(Object),
          expect.any(Function),
        );
      });

      it('skips non-cloud providers (local, box, icloud, other)', async () => {
        const spaces = [
          makeSpace({ storageProvider: 'local' }),
          makeSpace({ storageProvider: 'box' }),
          makeSpace({ storageProvider: 'icloud' }),
          makeSpace({ storageProvider: 'other' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('checks cloud providers (google_drive, onedrive, dropbox)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD' }),
          makeSpace({ storageProvider: 'onedrive', path: 'work/Co/OD' }),
          makeSpace({ storageProvider: 'dropbox', path: 'work/Co/DB' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // 3 providers checked
        expect(mockExecFile).toHaveBeenCalledTimes(3);
      });

      it('returns early with no spaces', async () => {
        await runSharedDriveHealthChecks([]);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });
    });

    describe('Provider deduplication', () => {
      it('checks each provider only once even with multiple spaces', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD1' }),
          makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD2' }),
          makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD3' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // Only 1 check for google_drive, not 3
        expect(mockExecFile).toHaveBeenCalledTimes(1);
      });

      it('collects all space paths per provider in results', async () => {
        // Make pgrep return exit 1 (not_running) so we get a broadcast
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [
          makeSpace({ storageProvider: 'onedrive', path: 'work/Co/OD1' }),
          makeSpace({ storageProvider: 'onedrive', path: 'work/Co/OD2' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          expect.arrayContaining([
            expect.objectContaining({
              provider: 'onedrive',
              spacePaths: ['work/Co/OD1', 'work/Co/OD2'],
            }),
          ]),
        );
      });
    });

    describe('Broadcast behavior', () => {
      it('does NOT broadcast when all providers are running (nothing to warn about)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({ storageProvider: 'google_drive' }),
          makeSpace({ storageProvider: 'onedrive' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('broadcasts when a provider is not_running', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'dropbox', path: 'work/Co/DB' })];
        await runSharedDriveHealthChecks(spaces);

        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          [
            expect.objectContaining({
              provider: 'dropbox',
              appStatus: 'not_running',
              offlineStatus: 'unknown',
              spacePaths: ['work/Co/DB'],
            }),
          ],
        );
      });

      it('does NOT broadcast when a provider status is unknown (fail open)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('ENOENT') as Error & { code: string };
          error.code = 'ENOENT';
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD' })];
        await runSharedDriveHealthChecks(spaces);

        // unknown appStatus → fail open, no warning broadcast
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled(
        );
      });

      it('includes offlineStatus as "unknown" in Stage 1', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'onedrive' })];
        await runSharedDriveHealthChecks(spaces);

        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          expect.arrayContaining([
            expect.objectContaining({ offlineStatus: 'unknown' }),
          ]),
        );
      });
    });

    describe('Retry logic', () => {
      it('retries once after delay when provider is not_running and retry=true', async () => {
        let callCount = 0;
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          callCount++;
          if (callCount === 1) {
            // First call: not running
            const error = new Error('no match') as Error & { code: number };
            error.code = 1;
            cb(error, '', '');
          } else {
            // Retry: now running
            cb(null, '100\n', '');
          }
        });

        const spaces = [makeSpace({ storageProvider: 'google_drive' })];
        const promise = runSharedDriveHealthChecks(spaces, { retry: true });

        // Advance past the 10s retry delay
        await vi.advanceTimersByTimeAsync(10000);
        await promise;

        // 2 calls: initial + retry
        expect(mockExecFile).toHaveBeenCalledTimes(2);
        // No broadcast because retry found it running
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('broadcasts after retry still shows not_running', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'dropbox', path: 'work/Co/DB' })];
        const promise = runSharedDriveHealthChecks(spaces, { retry: true });

        await vi.advanceTimersByTimeAsync(10000);
        await promise;

        expect(mockExecFile).toHaveBeenCalledTimes(2);
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          [expect.objectContaining({ provider: 'dropbox', appStatus: 'not_running' })],
        );
      });

      it('does NOT retry when retry=false', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD' })];
        await runSharedDriveHealthChecks(spaces, { retry: false });

        // Only 1 call — no retry
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToAllWindows).toHaveBeenCalled();
      });

      it('does NOT retry when no options provided', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'onedrive' })];
        await runSharedDriveHealthChecks(spaces);

        expect(mockExecFile).toHaveBeenCalledTimes(1);
      });

      it('does NOT retry when status is "running" (no need)', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [makeSpace({ storageProvider: 'google_drive' })];
        await runSharedDriveHealthChecks(spaces, { retry: true });

        expect(mockExecFile).toHaveBeenCalledTimes(1);
      });

      it('does NOT retry when status is "unknown"', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('ENOENT') as Error & { code: string };
          error.code = 'ENOENT';
          cb(error, '', '');
        });

        const spaces = [makeSpace({ storageProvider: 'google_drive' })];
        await runSharedDriveHealthChecks(spaces, { retry: true });

        // Only 1 call — retry only triggers for 'not_running'
        expect(mockExecFile).toHaveBeenCalledTimes(1);
      });
    });

    describe('Mixed provider scenarios', () => {
      it('handles mix of running and not_running providers', async () => {
        mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
          const pattern = (args as string[])[1]; // '-f' arg value for pgrep
          if (pattern === 'Google Drive') {
            cb(null, '100\n', '');
          } else {
            const error = new Error('no match') as Error & { code: number };
            error.code = 1;
            cb(error, '', '');
          }
        });

        const spaces = [
          makeSpace({ storageProvider: 'google_drive', path: 'work/Co/GD' }),
          makeSpace({ storageProvider: 'onedrive', path: 'work/Co/OD' }),
          makeSpace({ storageProvider: 'dropbox', path: 'work/Co/DB' }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          expect.arrayContaining([
            expect.objectContaining({ provider: 'onedrive', appStatus: 'not_running' }),
            expect.objectContaining({ provider: 'dropbox', appStatus: 'not_running' }),
          ]),
        );

        // google_drive should NOT be in the warnings (it's running)
        const broadcastPayload = mockBroadcastToAllWindows.mock.calls[0][1] as SharedDriveHealthResult[];
        expect(broadcastPayload.find((r) => r.provider === 'google_drive')).toBeUndefined();
      });
    });

    describe('Offline availability in orchestration', () => {
      it('runs offline check when app is running and sourcePaths provided (macOS)', async () => {
        setPlatform('darwin');

        // pgrep: running
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        // fs: online-only file detected
        mockReaddir.mockResolvedValue(['report.docx', 'notes.txt']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 1024,
          blocks: 0, // dataless placeholder
        });

        const spaces = [
          makeSpace({
            storageProvider: 'onedrive',
            path: 'work/Co/OD',
            sourcePath: '/Users/test/OneDrive/SharedFolder',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // Should broadcast because offline status is 'online-only'
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          [
            expect.objectContaining({
              provider: 'onedrive',
              appStatus: 'running',
              offlineStatus: 'online-only',
            }),
          ],
        );
      });

      it('does not run offline check when app is not_running', async () => {
        setPlatform('darwin');

        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('no match') as Error & { code: number };
          error.code = 1;
          cb(error, '', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: 'onedrive',
            path: 'work/Co/OD',
            sourcePath: '/Users/test/OneDrive/SharedFolder',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // fs should NOT be called — offline check skipped when app not running
        expect(mockReaddir).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          [expect.objectContaining({ offlineStatus: 'unknown' })],
        );
      });

      it('skips offline check for google_drive (even when running)', async () => {
        setPlatform('darwin');

        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: 'google_drive',
            path: 'work/Co/GD',
            sourcePath: '/Users/test/GoogleDrive/SharedFolder',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // Google Drive → offline check is skipped
        expect(mockReaddir).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('skips offline check when space has no sourcePath', async () => {
        setPlatform('darwin');

        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        const spaces = [
          makeSpace({
            storageProvider: 'onedrive',
            path: 'work/Co/OD',
            sourcePath: undefined,
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        expect(mockReaddir).not.toHaveBeenCalled();
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('does not broadcast when offline status is "available"', async () => {
        setPlatform('darwin');

        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '100\n', '');
        });

        mockReaddir.mockResolvedValue(['report.docx']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 1024,
          blocks: 8, // locally available
        });

        const spaces = [
          makeSpace({
            storageProvider: 'dropbox',
            path: 'work/Co/DB',
            sourcePath: '/Users/test/Dropbox/SharedFolder',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // available → no warning
        expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
      });

      it('runs batched PowerShell offline check on Windows', async () => {
        setPlatform('win32');

        let execCallCount = 0;
        mockExecFile.mockImplementation((cmd, _args, _opts, cb) => {
          execCallCount++;
          if (cmd === 'tasklist') {
            // tasklist: running
            cb(null, '"OneDrive.exe","1234","Console","1","50,000 K"\r\n', '');
          } else if (cmd === 'powershell') {
            // PowerShell: online-only
            const result = JSON.stringify({ 'C:\\Users\\test\\OneDrive\\Folder1': true, 'C:\\Users\\test\\OneDrive\\Folder2': false });
            cb(null, result, '');
          }
        });

        const spaces = [
          makeSpace({
            storageProvider: 'onedrive',
            path: 'work/Co/OD1',
            sourcePath: 'C:\\Users\\test\\OneDrive\\Folder1',
          }),
          makeSpace({
            storageProvider: 'onedrive',
            path: 'work/Co/OD2',
            sourcePath: 'C:\\Users\\test\\OneDrive\\Folder2',
          }),
        ];
        await runSharedDriveHealthChecks(spaces);

        // tasklist (1 call for onedrive) + powershell (1 batched call)
        expect(execCallCount).toBe(2);

        // online-only detected → broadcast
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'shared-drive:health-warning',
          [
            expect.objectContaining({
              provider: 'onedrive',
              appStatus: 'running',
              offlineStatus: 'online-only',
            }),
          ],
        );
      });
    });
  });

  // =========================================================================
  // checkOfflineAvailability
  // =========================================================================

  describe('checkOfflineAvailability', () => {
    describe('Google Drive skip', () => {
      it('returns "unknown" for google_drive on macOS', async () => {
        setPlatform('darwin');
        const result = await checkOfflineAvailability('/path/to/gdrive', 'google_drive');
        expect(result).toBe('unknown');
        expect(mockReaddir).not.toHaveBeenCalled();
      });

      it('returns "unknown" for google_drive on Windows', async () => {
        setPlatform('win32');
        const result = await checkOfflineAvailability('C:\\path\\to\\gdrive', 'google_drive');
        expect(result).toBe('unknown');
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });

    describe('Platform guard', () => {
      it('returns "unknown" on Linux', async () => {
        setPlatform('linux');
        const result = await checkOfflineAvailability('/path/to/onedrive', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on unsupported platforms', async () => {
        setPlatform('freebsd');
        const result = await checkOfflineAvailability('/path/to/dropbox', 'dropbox');
        expect(result).toBe('unknown');
      });
    });

    describe('macOS (darwin) — fs.stat blocks check', () => {
      beforeEach(() => setPlatform('darwin'));

      it('returns "online-only" when a file has blocks=0 and size>0', async () => {
        mockReaddir.mockResolvedValue(['report.docx', 'notes.txt', 'data.xlsx']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 2048,
          blocks: 0, // dataless placeholder
        });

        const result = await checkOfflineAvailability('/Users/test/OneDrive/Work', 'onedrive');
        expect(result).toBe('online-only');
      });

      it('returns "available" when all files have blocks>0', async () => {
        mockReaddir.mockResolvedValue(['report.docx', 'notes.txt']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 2048,
          blocks: 8, // locally available
        });

        const result = await checkOfflineAvailability('/Users/test/Dropbox/Work', 'dropbox');
        expect(result).toBe('available');
      });

      it('skips hidden files (starting with .)', async () => {
        mockReaddir.mockResolvedValue(['.DS_Store', '.hidden', 'visible.txt']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 100,
          blocks: 4,
        });

        const result = await checkOfflineAvailability('/Users/test/OneDrive/Work', 'onedrive');
        expect(result).toBe('available');
        // Should only call stat for 'visible.txt', not hidden files
        expect(mockStat).toHaveBeenCalledTimes(1);
      });

      it('returns "unknown" for empty directory', async () => {
        mockReaddir.mockResolvedValue([]);

        const result = await checkOfflineAvailability('/Users/test/OneDrive/Empty', 'onedrive');
        expect(result).toBe('unknown');
        expect(mockStat).not.toHaveBeenCalled();
      });

      it('returns "unknown" when directory only has hidden files', async () => {
        mockReaddir.mockResolvedValue(['.DS_Store', '.gitkeep']);

        const result = await checkOfflineAvailability('/Users/test/OneDrive/HiddenOnly', 'onedrive');
        expect(result).toBe('unknown');
        expect(mockStat).not.toHaveBeenCalled();
      });

      it('returns "unknown" when directory only has subdirectories', async () => {
        mockReaddir.mockResolvedValue(['subdir1', 'subdir2']);
        mockStat.mockResolvedValue({
          isFile: () => false, // directories
          size: 0,
          blocks: 0,
        });

        const result = await checkOfflineAvailability('/Users/test/OneDrive/DirsOnly', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on ENOENT error (directory does not exist)', async () => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        mockReaddir.mockRejectedValue(error);

        const result = await checkOfflineAvailability('/Users/test/OneDrive/Missing', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on EACCES error (permission denied)', async () => {
        const error = new Error('EACCES') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        mockReaddir.mockRejectedValue(error);

        const result = await checkOfflineAvailability('/Users/test/OneDrive/NoAccess', 'dropbox');
        expect(result).toBe('unknown');
      });

      it('samples at most 5 files', async () => {
        mockReaddir.mockResolvedValue(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 100,
          blocks: 4,
        });

        await checkOfflineAvailability('/Users/test/OneDrive/Many', 'onedrive');
        // Only 5 files sampled, not 7
        expect(mockStat).toHaveBeenCalledTimes(5);
      });

      it('detects online-only on second file when first is available', async () => {
        mockReaddir.mockResolvedValue(['local.txt', 'cloud.txt']);
        let callCount = 0;
        mockStat.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ isFile: () => true, size: 100, blocks: 4 });
          }
          return Promise.resolve({ isFile: () => true, size: 2048, blocks: 0 });
        });

        const result = await checkOfflineAvailability('/Users/test/OneDrive/Mixed', 'onedrive');
        expect(result).toBe('online-only');
      });

      it('handles zero-size files gracefully (not treated as online-only)', async () => {
        mockReaddir.mockResolvedValue(['empty.txt']);
        mockStat.mockResolvedValue({
          isFile: () => true,
          size: 0, // empty file
          blocks: 0,
        });

        const result = await checkOfflineAvailability('/Users/test/OneDrive/EmptyFile', 'onedrive');
        // size=0 && blocks=0 is a genuinely empty file, not a placeholder
        // sampledFiles=1 but no online-only detected → 'available'
        expect(result).toBe('available');
      });
    });

    describe('Windows (win32) — PowerShell attribute check', () => {
      beforeEach(() => setPlatform('win32'));

      it('returns "online-only" when PowerShell detects recall attribute', async () => {
        const psResult = JSON.stringify({ 'C:\\Users\\test\\OneDrive\\Work': true });
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, psResult, '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\OneDrive\\Work', 'onedrive');
        expect(result).toBe('online-only');
        expect(mockExecFile).toHaveBeenCalledWith(
          'powershell',
          ['-NoProfile', '-Command', expect.stringContaining('Get-ChildItem')],
          expect.objectContaining({ timeout: 5000 }),
          expect.any(Function),
        );
      });

      it('returns "available" when PowerShell finds no recall attribute', async () => {
        const psResult = JSON.stringify({ 'C:\\Users\\test\\Dropbox\\Work': false });
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, psResult, '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\Dropbox\\Work', 'dropbox');
        expect(result).toBe('available');
      });

      it('returns "unknown" on PowerShell timeout', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('killed') as Error & { killed: boolean; signal: string };
          error.killed = true;
          error.signal = 'SIGTERM';
          cb(error, '', '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\OneDrive\\Work', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on PowerShell error', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          const error = new Error('powershell not found') as Error & { code: string };
          error.code = 'ENOENT';
          cb(error, '', '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\OneDrive\\Work', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('returns "unknown" on invalid JSON output', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, 'not valid json', '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\OneDrive\\Work', 'onedrive');
        expect(result).toBe('unknown');
      });

      it('handles paths with single quotes in PowerShell script', async () => {
        const pathWithQuote = "C:\\Users\\test\\OneDrive\\it's a folder";
        const psResult = JSON.stringify({ [pathWithQuote]: false });
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, psResult, '');
        });

        const result = await checkOfflineAvailability(pathWithQuote, 'onedrive');
        expect(result).toBe('available');

        // Verify the script contains escaped single quotes
        const scriptArg = (mockExecFile.mock.calls[0] as unknown[])[1] as string[];
        expect(scriptArg[2]).toContain("it''s a folder");
      });

      it('returns "unknown" when path not found in JSON result', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
          cb(null, '{}', '');
        });

        const result = await checkOfflineAvailability('C:\\Users\\test\\OneDrive\\Work', 'onedrive');
        expect(result).toBe('unknown');
      });
    });
  });
});
