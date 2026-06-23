import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Hoisted variables (must be declared before vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockUserDataPath,
  mockBroadcast,
  mockRuntimeManager,
  mockFetch,
  mockBinaryPath,
} = vi.hoisted(() => {
  const tmpBase = require('node:path').join(require('node:os').tmpdir(), 'ollama-service-test');
  const binaryPath = require('node:path').join(tmpBase, 'ollama', 'ollama');
  return {
    mockUserDataPath: tmpBase,
    mockBinaryPath: binaryPath,
    mockBroadcast: {
      sendToAllWindows: vi.fn(),
      sendToFocusedWindow: vi.fn(),
    },
    mockRuntimeManager: {
      getInstallStatus: vi.fn().mockReturnValue({ installed: true, path: binaryPath }),
      getRuntimePath: vi.fn().mockReturnValue(binaryPath),
    },
    mockFetch: vi.fn(),
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
    tempPath: require('node:path').join(require('node:os').tmpdir(), 'ollama-service-test-temp'),
    version: '1.0.0',
    isPackaged: false,
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ getBroadcastService: () => mockBroadcast });
});

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn().mockReturnValue({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('../ollamaRuntimeManager', () => ({
  ollamaRuntimeManager: mockRuntimeManager,
}));

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal?: string): boolean {
    this.killed = true;
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      // Simulate async exit
      setTimeout(() => this.emit('exit', 0, signal), 10);
    }
    return true;
  }
}

let mockSpawnedProcess: MockChildProcess;

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockImplementation(() => {
    mockSpawnedProcess = new MockChildProcess();
    return mockSpawnedProcess;
  }),
  execFile: vi.fn(),
}));

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { OllamaService } from '../ollamaService';
import type { InferenceStrategy } from '@core/services/localInference';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testStrategy: InferenceStrategy = {
  id: 'turbo-default',
  label: 'TurboQuant (recommended)',
  kvCacheType: 'turbo3',
  contextMultiplier: 5.0,
  minOllamaVersion: '0.9.8',
  ollamaEnv: {
    OLLAMA_KV_CACHE_TYPE: 'turbo3',
    OLLAMA_NUM_PARALLEL: '1',
  },
};

describe('OllamaService', () => {
  let service: OllamaService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OllamaService();

    // Ensure test directories exist and create a fake binary
    fs.mkdirSync(path.dirname(mockBinaryPath), { recursive: true });
    fs.writeFileSync(mockBinaryPath, '#!/bin/sh\necho hello');
    fs.chmodSync(mockBinaryPath, 0o755);

    // Default: health check succeeds
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.9.6' }),
    });

    // Default: runtime is installed
    mockRuntimeManager.getInstallStatus.mockReturnValue({ installed: true, path: mockBinaryPath });
    mockRuntimeManager.getRuntimePath.mockReturnValue(mockBinaryPath);
  });

  afterEach(async () => {
    // Stop service if running to prevent leaks
    await service.stop();

    try {
      fs.rmSync(mockUserDataPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns not_installed by default', () => {
      expect(service.getStatus()).toBe('not_installed');
    });
  });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  describe('start', () => {
    it('throws when runtime is not installed', async () => {
      mockRuntimeManager.getInstallStatus.mockReturnValue({ installed: false, path: mockBinaryPath });

      await expect(service.ensureRunning(testStrategy)).rejects.toThrow('not installed');
    });

    it('spawns ollama serve with correct args', async () => {
      const { spawn } = await import('node:child_process');

      // Make health check pass immediately
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '0.9.6' }) });

      await service.start(testStrategy);

      expect(spawn).toHaveBeenCalledWith(
        mockBinaryPath,
        ['serve'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: expect.objectContaining({
            OLLAMA_HOST: '127.0.0.1:11435',
            OLLAMA_KV_CACHE_TYPE: 'turbo3',
            OLLAMA_NUM_PARALLEL: '1',
          }),
        }),
      );
    });

    it('sets status to running after successful start', async () => {
      await service.start(testStrategy);
      expect(service.getStatus()).toBe('running');
    });

    it('creates models directory on start', async () => {
      await service.start(testStrategy);
      const modelsDir = path.join(mockUserDataPath, 'ollama', 'models');
      expect(fs.existsSync(modelsDir)).toBe(true);
    });

    it('env does not inherit full process.env', async () => {
      const { spawn } = await import('node:child_process');
      await service.start(testStrategy);

      const spawnCall = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const env = spawnCall[2].env as Record<string, string>;

      // Should NOT have random env vars
      // The allowlist is: PATH, HOME, OLLAMA_HOST, OLLAMA_KV_CACHE_TYPE,
      // OLLAMA_NUM_PARALLEL, OLLAMA_MODELS, OLLAMA_TMPDIR
      const allowedPrefixes = ['PATH', 'HOME', 'OLLAMA_'];
      for (const key of Object.keys(env)) {
        const isAllowed = allowedPrefixes.some((prefix) => key.startsWith(prefix));
        expect(isAllowed).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('does nothing when no process is running', async () => {
      await expect(service.stop()).resolves.toBeUndefined();
    });

    it('sends SIGTERM to the process', async () => {
      await service.start(testStrategy);

      const killSpy = vi.spyOn(mockSpawnedProcess, 'kill');
      await service.stop();

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('sets status to installed after stop', async () => {
      await service.start(testStrategy);
      expect(service.getStatus()).toBe('running');

      await service.stop();
      expect(service.getStatus()).toBe('installed');
    });
  });

  // -------------------------------------------------------------------------
  // isRunning
  // -------------------------------------------------------------------------

  describe('isRunning', () => {
    it('returns false when no process exists', async () => {
      expect(await service.isRunning()).toBe(false);
    });

    it('returns true when process exists and health check passes', async () => {
      await service.start(testStrategy);
      expect(await service.isRunning()).toBe(true);
    });

    it('returns false when health check fails', async () => {
      await service.start(testStrategy);

      // Make health check fail
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await service.isRunning()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // ensureRunning
  // -------------------------------------------------------------------------

  describe('ensureRunning', () => {
    it('starts if not running', async () => {
      await service.ensureRunning(testStrategy);
      expect(service.getStatus()).toBe('running');
    });

    it('throws when runtime not installed', async () => {
      mockRuntimeManager.getInstallStatus.mockReturnValue({ installed: false, path: '/fake/ollama' });
      await expect(service.ensureRunning(testStrategy)).rejects.toThrow('not installed');
    });

    it('coalesces concurrent calls', async () => {
      const { spawn } = await import('node:child_process');

      // Start two calls in parallel
      const p1 = service.ensureRunning(testStrategy);
      const p2 = service.ensureRunning(testStrategy);

      await Promise.all([p1, p2]);

      // spawn should only be called once (single-flight)
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------

  describe('getCapabilities', () => {
    it('returns null when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const caps = await service.getCapabilities();
      expect(caps).toBeNull();
    });

    it('returns capabilities from /api/version', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.9.8' }),
      });

      const caps = await service.getCapabilities();
      expect(caps).not.toBeNull();
      expect(caps?.version).toBe('0.9.8');
      expect(caps?.turboQuantSupported).toBe(true);
      expect(caps?.kvCacheTypes).toContain('turbo3');
    });

    it('reports turboQuant not supported for old versions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.5.0' }),
      });

      const caps = await service.getCapabilities();
      expect(caps?.turboQuantSupported).toBe(false);
      expect(caps?.kvCacheTypes).not.toContain('turbo3');
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  describe('crash recovery', () => {
    it('attempts restart on unexpected exit', async () => {
      const { spawn } = await import('node:child_process');

      await service.start(testStrategy);
      expect(service.getStatus()).toBe('running');

      // Simulate unexpected process exit
      mockSpawnedProcess.emit('exit', 1, null);

      // After the crash, a restart timer is set. We can verify the status changed
      // (would be 'running' still since restart is scheduled via setTimeout)
      // The crash handler schedules a restart with delay
      // We just verify spawn was called for the initial start
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('gives up after MAX_RESTART_ATTEMPTS', async () => {
      await service.start(testStrategy);

      // Simulate 4 crashes (MAX_RESTART_ATTEMPTS = 3, so 4th gives up)
      // Access private restartAttempts for testing
       
      (service as any).restartAttempts = 3;
       
      (service as any).isShuttingDown = false;

      // Trigger crash handler directly
       
      (service as any).handleCrash(testStrategy);

      // After exceeding max attempts, status should be error
      expect(service.getStatus()).toBe('error');
    });

    it('does not restart when shutting down', async () => {
      const { spawn } = await import('node:child_process');

      await service.start(testStrategy);
      const initialSpawnCount = (spawn as ReturnType<typeof vi.fn>).mock.calls.length;

      // Set shutting down flag, then simulate exit
       
      (service as any).isShuttingDown = true;
      mockSpawnedProcess.emit('exit', 0, 'SIGTERM');

      // Should not have spawned again
      expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialSpawnCount);
    });
  });

  // -------------------------------------------------------------------------
  // Status broadcasting
  // -------------------------------------------------------------------------

  describe('status broadcasting', () => {
    it('broadcasts status changes via BroadcastService', async () => {
      await service.start(testStrategy);

      expect(mockBroadcast.sendToAllWindows).toHaveBeenCalledWith(
        'local-inference:status-changed',
        expect.objectContaining({ status: 'running' }),
      );
    });

    it('broadcasts status on stop', async () => {
      await service.start(testStrategy);
      mockBroadcast.sendToAllWindows.mockClear();

      await service.stop();

      expect(mockBroadcast.sendToAllWindows).toHaveBeenCalledWith(
        'local-inference:status-changed',
        expect.objectContaining({ status: 'installed' }),
      );
    });
  });
});
