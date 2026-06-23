import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Hoisted variables (must be declared before vi.mock factories)
// ---------------------------------------------------------------------------

const { mockExecFile, mockUserDataPath } = vi.hoisted(() => {
  const fn = vi.fn();
  // Add custom promisify symbol so util.promisify(execFile) resolves with { stdout, stderr }
   
  const { promisify } = require('node:util') as typeof import('node:util');
  const customSymbol = promisify.custom as unknown as symbol;
  (fn as unknown as Record<symbol, unknown>)[customSymbol] = (...args: unknown[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };
  return {
    mockExecFile: fn,
    mockUserDataPath: require('node:path').join(require('node:os').tmpdir(), 'ollama-runtime-test'),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn().mockReturnValue({
    userDataPath: mockUserDataPath,
    platform: 'darwin',
    arch: 'arm64',
    tempPath: require('node:path').join(require('node:os').tmpdir(), 'ollama-runtime-test-temp'),
    version: '1.0.0',
    isPackaged: false,
  }),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: vi.fn().mockReturnValue({
    sendToAllWindows: vi.fn(),
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn().mockReturnValue({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { OllamaRuntimeManager } from '../ollamaRuntimeManager';

describe('OllamaRuntimeManager', () => {
  let manager: OllamaRuntimeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new OllamaRuntimeManager();

    // Ensure test directory exists
    fs.mkdirSync(mockUserDataPath, { recursive: true });

    // Default: execFile succeeds (used by getInstalledVersion, extractTgz, verifyCodeSignature)
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
        // Handle promisified form (no callback = 4th arg is undefined)
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) {
          callback(null, 'ollama version 0.9.6', '');
        }
        return { stdout: '', stderr: '' };
      },
    );
  });

  afterEach(() => {
    // Clean up test directories
    try {
      fs.rmSync(mockUserDataPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // getInstallDir / getRuntimePath
  // -------------------------------------------------------------------------

  describe('getInstallDir', () => {
    it('returns path under userDataPath/ollama', () => {
      const dir = manager.getInstallDir();
      expect(dir).toBe(path.join(mockUserDataPath, 'ollama'));
    });
  });

  describe('getRuntimePath', () => {
    it('returns path to ollama binary under install dir', () => {
      const runtimePath = manager.getRuntimePath();
      expect(runtimePath).toBe(path.join(mockUserDataPath, 'ollama', 'ollama'));
    });
  });

  // -------------------------------------------------------------------------
  // getInstallStatus
  // -------------------------------------------------------------------------

  describe('getInstallStatus', () => {
    it('returns installed: false when binary does not exist', () => {
      const status = manager.getInstallStatus();
      expect(status.installed).toBe(false);
    });

    it('returns installed: true when binary exists and is executable', () => {
      const installDir = manager.getInstallDir();
      fs.mkdirSync(installDir, { recursive: true });
      const binaryPath = manager.getRuntimePath();
      fs.writeFileSync(binaryPath, '#!/bin/sh\necho hello');
      fs.chmodSync(binaryPath, 0o755);

      const status = manager.getInstallStatus();
      expect(status.installed).toBe(true);
      expect(status.path).toBe(binaryPath);
    });

    it('returns installed: false when binary exists but is not executable', () => {
      const installDir = manager.getInstallDir();
      fs.mkdirSync(installDir, { recursive: true });
      const binaryPath = manager.getRuntimePath();
      fs.writeFileSync(binaryPath, '#!/bin/sh\necho hello');
      fs.chmodSync(binaryPath, 0o444); // read-only, not executable

      const status = manager.getInstallStatus();
      expect(status.installed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getInstalledVersion
  // -------------------------------------------------------------------------

  describe('getInstalledVersion', () => {
    it('returns null when binary is not installed', async () => {
      const version = await manager.getInstalledVersion();
      expect(version).toBeNull();
    });

    it('parses version from "ollama version X.Y.Z" output', async () => {
      // Create a fake binary so getInstallStatus returns installed
      const installDir = manager.getInstallDir();
      fs.mkdirSync(installDir, { recursive: true });
      const binaryPath = manager.getRuntimePath();
      fs.writeFileSync(binaryPath, '#!/bin/sh\necho hello');
      fs.chmodSync(binaryPath, 0o755);

      // promisify(execFile) calls execFile(cmd, args, opts, callback)
      // The callback is the 4th argument (index 3) when all args are provided
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (typeof callback === 'function') {
            process.nextTick(() => callback(null, 'ollama version 0.9.6\n', ''));
          }
        },
      );

      const version = await manager.getInstalledVersion();
      expect(version).toBe('0.9.6');
    });

    it('returns null on execFile error', async () => {
      const installDir = manager.getInstallDir();
      fs.mkdirSync(installDir, { recursive: true });
      const binaryPath = manager.getRuntimePath();
      fs.writeFileSync(binaryPath, '#!/bin/sh\necho hello');
      fs.chmodSync(binaryPath, 0o755);

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (typeof callback === 'function') {
            process.nextTick(() => callback(new Error('spawn error'), '', ''));
          }
        },
      );

      const version = await manager.getInstalledVersion();
      expect(version).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // downloadRuntime — error cases
  // -------------------------------------------------------------------------

  describe('downloadRuntime', () => {
    it('throws on unsupported platform', async () => {
      const { getPlatformConfig } = await import('@core/platform');
      (getPlatformConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        userDataPath: mockUserDataPath,
        platform: 'linux',
        arch: 'x64',
        tempPath: os.tmpdir(),
        version: '1.0.0',
        isPackaged: false,
      });

      // Need a fresh instance to pick up the new platform config
      const linuxManager = new OllamaRuntimeManager();
      await expect(linuxManager.downloadRuntime()).rejects.toThrow('not yet supported');
    });

    it('prevents concurrent downloads', async () => {
      // Start a download that will hang (never resolves the network request)
      // We can't easily mock the full download pipeline, but we can test
      // that calling downloadRuntime while inProgress throws
      const controller = new AbortController();

      // Access private state via any-cast for testing
       
      (manager as any).downloadState.inProgress = true;

      await expect(manager.downloadRuntime()).rejects.toThrow('already in progress');

      // Reset
       
      (manager as any).downloadState.inProgress = false;
      controller.abort();
    });
  });

  // -------------------------------------------------------------------------
  // cancelDownload
  // -------------------------------------------------------------------------

  describe('cancelDownload', () => {
    it('does not throw when no download is in progress', () => {
      expect(() => manager.cancelDownload()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // removeRuntime
  // -------------------------------------------------------------------------

  describe('removeRuntime', () => {
    it('removes the install directory', () => {
      const installDir = manager.getInstallDir();
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'ollama'), 'binary');

      manager.removeRuntime();
      expect(fs.existsSync(installDir)).toBe(false);
    });

    it('does not throw when install directory does not exist', () => {
      expect(() => manager.removeRuntime()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // cleanupStaleStaging
  // -------------------------------------------------------------------------

  describe('cleanupStaleStaging', () => {
    it('removes stale staging directory', () => {
      const stagingDir = path.join(mockUserDataPath, 'ollama.staging');
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, 'partial'), 'data');

      manager.cleanupStaleStaging();
      expect(fs.existsSync(stagingDir)).toBe(false);
    });

    it('does nothing when no staging directory exists', () => {
      expect(() => manager.cleanupStaleStaging()).not.toThrow();
    });

    it('does nothing when download is in progress', () => {
      const stagingDir = path.join(mockUserDataPath, 'ollama.staging');
      fs.mkdirSync(stagingDir, { recursive: true });

       
      (manager as any).downloadState.inProgress = true;

      manager.cleanupStaleStaging();
      // Staging dir should still exist
      expect(fs.existsSync(stagingDir)).toBe(true);

      // Reset
       
      (manager as any).downloadState.inProgress = false;
    });
  });
});
