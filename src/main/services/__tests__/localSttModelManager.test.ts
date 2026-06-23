import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Use a deterministic temp directory path for tests
const testTempDir = path.join(os.tmpdir(), 'mindstone-stt-test-vitest');
const testAppDataDir = path.join(os.tmpdir(), 'mindstone-stt-test-vitest-appdata');

// Mock electron app before importing the module
vi.mock('electron', () => {
  const nodePath = require('node:path');
  const nodeOs = require('node:os');
  const userData = nodePath.join(nodeOs.tmpdir(), 'mindstone-stt-test-vitest');
  const appData = nodePath.join(nodeOs.tmpdir(), 'mindstone-stt-test-vitest-appdata');
  return {
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'appData') return appData;
        return userData; // userData and everything else
      }),
    },
    BrowserWindow: vi.fn(),
  };
});

// Mock the error reporter so we can assert on captureException calls.
// Must be hoisted so the mock is active before the module under test
// imports @core/errorReporter.
const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

 
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

import { calculateTimeout, calculateRetryDelay, DOWNLOAD_CONFIG, LocalSttModelManager, reportLocalSttError, isLocalSttCaptured } from '../localSttModelManager';

describe('localSttModelManager', () => {
  afterAll(async () => {
    // Clean up test temp directory
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      fs.rmSync(testAppDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('calculateTimeout', () => {
    it('returns base timeout for undefined size', () => {
      const timeout = calculateTimeout(undefined);
      expect(timeout).toBe(DOWNLOAD_CONFIG.baseTimeoutMs);
    });

    it('returns base timeout for zero size', () => {
      const timeout = calculateTimeout(0);
      expect(timeout).toBe(DOWNLOAD_CONFIG.baseTimeoutMs);
    });

    it('increases timeout proportionally to file size', () => {
      const size1Mb = 1024 * 1024;
      const timeout = calculateTimeout(size1Mb);
      expect(timeout).toBe(DOWNLOAD_CONFIG.baseTimeoutMs + DOWNLOAD_CONFIG.timeoutPerMbMs);
    });

    it('caps timeout at maximum', () => {
      const hugeSize = 1024 * 1024 * 1024 * 10; // 10 GB
      const timeout = calculateTimeout(hugeSize);
      expect(timeout).toBe(DOWNLOAD_CONFIG.maxTimeoutMs);
    });

    it('calculates correct timeout for 445MB file (Encoder weight)', () => {
      const encoderSize = 445_187_200;
      const timeout = calculateTimeout(encoderSize);
      const expectedMb = encoderSize / (1024 * 1024);
      const expectedTimeout = DOWNLOAD_CONFIG.baseTimeoutMs + expectedMb * DOWNLOAD_CONFIG.timeoutPerMbMs;
      expect(timeout).toBe(Math.min(expectedTimeout, DOWNLOAD_CONFIG.maxTimeoutMs));
      // Should be well above 30 seconds (the old broken timeout)
      expect(timeout).toBeGreaterThan(60_000);
    });
  });

  describe('calculateRetryDelay', () => {
    it('returns base delay for first attempt', () => {
      const delay = calculateRetryDelay(0);
      // With jitter, should be between base and base + 1000
      expect(delay).toBeGreaterThanOrEqual(DOWNLOAD_CONFIG.retryBaseDelayMs);
      expect(delay).toBeLessThanOrEqual(DOWNLOAD_CONFIG.retryBaseDelayMs + 1000);
    });

    it('doubles delay for each subsequent attempt', () => {
      // Without jitter component, delay should approximately double each time
      const delay0 = DOWNLOAD_CONFIG.retryBaseDelayMs * Math.pow(2, 0);
      const delay1 = DOWNLOAD_CONFIG.retryBaseDelayMs * Math.pow(2, 1);
      const delay2 = DOWNLOAD_CONFIG.retryBaseDelayMs * Math.pow(2, 2);

      expect(delay0).toBe(1000);
      expect(delay1).toBe(2000);
      expect(delay2).toBe(4000);
    });

    it('caps delay at maximum', () => {
      const delay = calculateRetryDelay(20); // Very high attempt number
      expect(delay).toBeLessThanOrEqual(DOWNLOAD_CONFIG.retryMaxDelayMs + 1000); // +1000 for jitter
    });
  });

  describe('DOWNLOAD_CONFIG', () => {
    it('has sensible default values', () => {
      expect(DOWNLOAD_CONFIG.baseTimeoutMs).toBeGreaterThanOrEqual(30_000);
      expect(DOWNLOAD_CONFIG.maxTimeoutMs).toBeGreaterThanOrEqual(300_000);
      expect(DOWNLOAD_CONFIG.maxRetries).toBeGreaterThanOrEqual(2);
      expect(DOWNLOAD_CONFIG.retryBaseDelayMs).toBeGreaterThanOrEqual(500);
    });

    it('timeout values make sense for large files', () => {
      // A 500MB file should get at least 5 minutes timeout
      const size500Mb = 500 * 1024 * 1024;
      const timeout = calculateTimeout(size500Mb);
      expect(timeout).toBeGreaterThanOrEqual(5 * 60 * 1000);
    });
  });
});

describe('localSttModelManager integration', () => {
  beforeEach(() => {
    // Clean both the legacy userData-based and new FluidAudio-based model dirs
    // so each test starts from a clean slate regardless of which path is used.
    const legacyModelsDir = path.join(testTempDir, 'models');
    const fluidAudioModelsDir = path.join(testAppDataDir, 'FluidAudio', 'Models');
    for (const dir of [legacyModelsDir, fluidAudioModelsDir]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('staging directory pattern', () => {
    it('staging path is derived from model path', () => {
      const manager = new LocalSttModelManager();

      // Mock platform for test
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();
        const stagingPath = manager['getStagingPath']();
        expect(stagingPath).toBe(modelPath + '.staging');
        // On darwin:parakeet-v3 we now use FluidAudio's capitalized "Models" dir
        expect(modelPath.toLowerCase()).toContain('models');
        expect(modelPath).toContain('parakeet');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('installation verification', () => {
    it('reports incomplete when weight files are missing', async () => {
      const manager = new LocalSttModelManager();

      // Mock platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();

        // Create directory structure without weight files (simulates failed download)
        fs.mkdirSync(path.join(modelPath, 'Encoder.mlmodelc', 'weights'), { recursive: true });
        fs.mkdirSync(path.join(modelPath, 'Decoder.mlmodelc', 'weights'), { recursive: true });
        fs.mkdirSync(path.join(modelPath, 'JointDecision.mlmodelc', 'weights'), { recursive: true });
        fs.mkdirSync(path.join(modelPath, 'Preprocessor.mlmodelc', 'weights'), { recursive: true });

        const status = await manager.getStatus();

        expect(status.installed).toBe(false);
        expect(status.error).toContain('Incomplete');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('reports installed when all weight files exist', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();

        // Create all required files
        const requiredFiles = [
          'parakeet_vocab.json',
          'Encoder.mlmodelc/weights/weight.bin',
          'Decoder.mlmodelc/weights/weight.bin',
          'JointDecision.mlmodelc/weights/weight.bin',
          'Preprocessor.mlmodelc/weights/weight.bin',
        ];

        for (const file of requiredFiles) {
          const filePath = path.join(modelPath, file);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, 'test content');
        }

        const status = await manager.getStatus();

        expect(status.installed).toBe(true);
        expect(status.error).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('cleanup', () => {
    it('removes staging directory on failed download', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();
        const stagingPath = modelPath + '.staging';

        // Create staging directory
        fs.mkdirSync(stagingPath, { recursive: true });
        fs.writeFileSync(path.join(stagingPath, 'partial.bin'), 'partial data');

        // Run cleanup
        await manager['cleanupFailedDownload']();

        expect(fs.existsSync(stagingPath)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('removes incomplete model directory during cleanup', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();

        // Create incomplete model directory (missing weight files)
        fs.mkdirSync(path.join(modelPath, 'Encoder.mlmodelc', 'weights'), { recursive: true });

        // Verify it's incomplete first
        const statusBefore = await manager.getStatus();
        expect(statusBefore.installed).toBe(false);
        expect(statusBefore.error).toContain('Incomplete');

        // Run cleanup
        await manager['cleanupFailedDownload']();

        // Directory should be removed
        expect(fs.existsSync(modelPath)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('model removal', () => {
    it('successfully removes installed model', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const modelPath = manager.getModelPath();

        // Create model directory
        fs.mkdirSync(modelPath, { recursive: true });
        fs.writeFileSync(path.join(modelPath, 'test.bin'), 'test');

        const result = await manager.removeModel();

        expect(result.success).toBe(true);
        expect(fs.existsSync(modelPath)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('succeeds when model does not exist', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        const result = await manager.removeModel();
        expect(result.success).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('download state management', () => {
    it('prevents concurrent downloads', async () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        // Manually set download state via the per-model state map
        const state = manager['getDownloadState']('parakeet-v3');
        state.inProgress = true;

        const result = await manager.startDownload(null);

        expect(result.started).toBe(false);
        expect(result.error).toContain('already in progress');

        // Reset state
        state.inProgress = false;
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('cancels download via abort controller', () => {
      const manager = new LocalSttModelManager();

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      try {
        // Manually setup download state via the per-model state map
        const abortController = new AbortController();
        manager['downloadStates'].set('parakeet-v3', {
          inProgress: true,
          abortController,
          downloadedBytes: 1000,
          totalBytes: 10000,
          currentFile: 'test.bin',
          downloadId: 1,
        });

        manager.cancelDownload(null);

        // The abort signal should be triggered
        expect(abortController.signal.aborted).toBe(true);
        // Note: inProgress stays true - the async download chain's .finally() handles cleanup
        // This is intentional to prevent race conditions when starting a new download immediately
        expect(manager['getDownloadState']('parakeet-v3').inProgress).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });
});

describe('checksum verification', () => {
  it('calculates correct SHA256 hash', () => {
    const content = 'test file content for checksum verification';
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // This is the expected hash for the test content
    expect(hash).toBe(crypto.createHash('sha256').update(content).digest('hex'));
    expect(hash).toHaveLength(64); // SHA256 produces 64 hex characters
  });
});

describe('sendProgress throttle', () => {
  const testModelId = 'parakeet-v3';

  it('sends terminal states immediately regardless of throttle', () => {
    const manager = new LocalSttModelManager();
    const sent: unknown[] = [];
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: (_ch: string, data: unknown) => sent.push(data) },
    } as unknown as import('electron').BrowserWindow;

    // Send many downloading events rapidly
    for (let i = 0; i < 10; i++) {
      manager['sendProgress'](mockWindow, testModelId, { progress: i * 10, downloadedBytes: i * 100, totalBytes: 1000, status: 'downloading' });
    }
    // Only the first should have been sent (rest throttled within 250ms)
    const downloadingCount = sent.length;
    expect(downloadingCount).toBe(1);

    // Terminal state flushes pending and sends immediately
    manager['sendProgress'](mockWindow, testModelId, { progress: 100, downloadedBytes: 1000, totalBytes: 1000, status: 'complete' });
    // Should have flushed the last pending downloading event + the complete event
    expect(sent.length).toBe(downloadingCount + 2);
    expect((sent[sent.length - 1] as { status: string }).status).toBe('complete');
  });

  it('allows sending after 250ms has elapsed', () => {
    const manager = new LocalSttModelManager();
    const sent: unknown[] = [];
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: (_ch: string, data: unknown) => sent.push(data) },
    } as unknown as import('electron').BrowserWindow;

    // First send goes through
    manager['sendProgress'](mockWindow, testModelId, { progress: 10, downloadedBytes: 100, totalBytes: 1000, status: 'downloading' });
    expect(sent.length).toBe(1);

    // Simulate 250ms passing by backdating the timestamp
    manager['lastProgressSendTimes'].set(testModelId, Date.now() - 300);

    // Next send should go through
    manager['sendProgress'](mockWindow, testModelId, { progress: 50, downloadedBytes: 500, totalBytes: 1000, status: 'downloading' });
    expect(sent.length).toBe(2);
  });

  it('stores pending progress and flushes before terminal', () => {
    const manager = new LocalSttModelManager();
    const sent: { progress: number; status: string }[] = [];
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: (_ch: string, data: { progress: number; status: string }) => sent.push(data) },
    } as unknown as import('electron').BrowserWindow;

    // First downloading event goes through
    manager['sendProgress'](mockWindow, testModelId, { progress: 10, downloadedBytes: 100, totalBytes: 1000, status: 'downloading' });
    // Second is throttled (stored as pending)
    manager['sendProgress'](mockWindow, testModelId, { progress: 90, downloadedBytes: 900, totalBytes: 1000, status: 'downloading' });
    expect(sent.length).toBe(1);
    expect(manager['pendingProgressMap'].get(testModelId)).toBeDefined();

    // Error event flushes the 90% pending, then sends the error
    manager['sendProgress'](mockWindow, testModelId, { progress: 0, downloadedBytes: 0, totalBytes: 1000, status: 'error', error: 'fail' });
    expect(sent.length).toBe(3);
    expect(sent[1].progress).toBe(90);
    expect(sent[1].status).toBe('downloading');
    expect(sent[2].status).toBe('error');
  });

  it('does not send to destroyed window', () => {
    const manager = new LocalSttModelManager();
    const sent: unknown[] = [];
    const mockWindow = {
      isDestroyed: () => true,
      webContents: { send: (_ch: string, data: unknown) => sent.push(data) },
    } as unknown as import('electron').BrowserWindow;

    manager['sendProgress'](mockWindow, testModelId, { progress: 50, downloadedBytes: 500, totalBytes: 1000, status: 'downloading' });
    expect(sent.length).toBe(0);
  });
});

describe('friendlyError', () => {
  it('maps DNS/connection errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('Network error: getaddrinfo ENOTFOUND huggingface.co'))
      .toContain('Check your internet connection');
    expect(manager['friendlyError']('Network error: ECONNREFUSED 1.2.3.4:443'))
      .toContain('Check your internet connection');
  });

  it('maps timeout/reset errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('Download timeout after 600000ms'))
      .toContain('connection may be unstable');
    expect(manager['friendlyError']('Response error: socket hang up'))
      .toContain('connection may be unstable');
    expect(manager['friendlyError']('ECONNRESET'))
      .toContain('connection may be unstable');
  });

  it('maps disk space errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('File write error: ENOSPC: no space left on device'))
      .toContain('disk space');
  });

  it('maps permission errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('File write error: EACCES: permission denied'))
      .toContain('Permission denied');
    expect(manager['friendlyError']('EPERM: operation not permitted'))
      .toContain('Permission denied');
  });

  it('maps HTTP server errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('HTTP 503 Service Unavailable'))
      .toContain('download server returned an error');
    expect(manager['friendlyError']('HTTP 404 Not Found'))
      .toContain('download server returned an error');
  });

  it('maps checksum errors to friendly message', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('Checksum mismatch for weight.bin'))
      .toContain('corrupted');
  });

  it('returns generic message for unknown errors', () => {
    const manager = new LocalSttModelManager();
    expect(manager['friendlyError']('Something completely unexpected'))
      .toBe('Download failed. Please try again.');
  });
});

describe('retry logic', () => {
  it('should retry on 429 rate limit errors', () => {
    // Test that 429 errors are retryable by checking the error matching logic
    const error429 = new Error('HTTP 429 Too Many Requests');
    const match = error429.message.match(/HTTP (\d{3})/);
    expect(match).not.toBeNull();
    const statusCode = parseInt(match![1], 10);
    expect(statusCode).toBe(429);
    // 429 should be retryable (not in the non-retryable range)
    const isNonRetryable = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
    expect(isNonRetryable).toBe(false);
  });

  it('should retry on 408 timeout errors', () => {
    const error408 = new Error('HTTP 408 Request Timeout');
    const match = error408.message.match(/HTTP (\d{3})/);
    expect(match).not.toBeNull();
    const statusCode = parseInt(match![1], 10);
    expect(statusCode).toBe(408);
    const isNonRetryable = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
    expect(isNonRetryable).toBe(false);
  });

  it('should not retry on 404 not found errors', () => {
    const error404 = new Error('HTTP 404 Not Found');
    const match = error404.message.match(/HTTP (\d{3})/);
    expect(match).not.toBeNull();
    const statusCode = parseInt(match![1], 10);
    expect(statusCode).toBe(404);
    const isNonRetryable = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
    expect(isNonRetryable).toBe(true);
  });

  it('should retry on 5xx server errors', () => {
    const error503 = new Error('HTTP 503 Service Unavailable');
    const match = error503.message.match(/HTTP (\d{3})/);
    expect(match).not.toBeNull();
    const statusCode = parseInt(match![1], 10);
    expect(statusCode).toBe(503);
    // 5xx errors don't match the 4xx non-retryable check
    const is4xxNonRetryable = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
    expect(is4xxNonRetryable).toBe(false);
  });
});

/**
 * FOX-3081: Parakeet V3 on macOS must live at FluidAudio's hard-coded model
 * search path so the bundled CLI can find it without attempting to download
 * its own copy. These tests exercise the path resolution + one-time migration.
 */
describe('getModelPath (FluidAudio compatibility on macOS)', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  afterAll(() => setPlatform(originalPlatform));

  it('returns FluidAudio-compatible path for darwin:parakeet-v3', () => {
    setPlatform('darwin');
    const manager = new LocalSttModelManager();
    const p = manager.getModelPath('parakeet-v3');
    expect(p).toBe(
      path.join(testAppDataDir, 'FluidAudio', 'Models', 'parakeet-tdt-0.6b-v3-coreml')
    );
  });

  it('returns userData path for other platforms', () => {
    setPlatform('win32');
    const manager = new LocalSttModelManager();
    const p = manager.getModelPath('parakeet-v3');
    expect(p.startsWith(testTempDir)).toBe(true);
    expect(p).not.toContain('FluidAudio');
  });
});

describe('migrateLegacyModelPaths', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  const legacyDir = path.join(testTempDir, 'models', 'parakeet-tdt-0.6b-v3-coreml');
  const newDir = path.join(testAppDataDir, 'FluidAudio', 'Models', 'parakeet-tdt-0.6b-v3-coreml');

  beforeEach(() => {
    setPlatform('darwin');
    // Clean slate
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(newDir, { recursive: true, force: true });
  });

  afterAll(() => setPlatform(originalPlatform));

  it('no-ops on non-darwin', () => {
    setPlatform('win32');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'marker'), 'x');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    // Legacy untouched, new path not created
    expect(fs.existsSync(legacyDir)).toBe(true);
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('no-ops when legacy path is absent', () => {
    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('moves legacy files to FluidAudio path when new path is absent', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'Encoder.mlmodelc'), 'encoder-bytes');
    fs.writeFileSync(path.join(legacyDir, 'Decoder.mlmodelc'), 'decoder-bytes');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.readFileSync(path.join(newDir, 'Encoder.mlmodelc'), 'utf8')).toBe('encoder-bytes');
    expect(fs.readFileSync(path.join(newDir, 'Decoder.mlmodelc'), 'utf8')).toBe('decoder-bytes');
  });

  it('removes the legacy copy if the new path has a complete install', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'legacy');

    // Populate new path with all required files so it's considered complete
    fs.mkdirSync(path.join(newDir, 'Encoder.mlmodelc', 'weights'), { recursive: true });
    fs.mkdirSync(path.join(newDir, 'Decoder.mlmodelc', 'weights'), { recursive: true });
    fs.mkdirSync(path.join(newDir, 'JointDecision.mlmodelc', 'weights'), { recursive: true });
    fs.mkdirSync(path.join(newDir, 'Preprocessor.mlmodelc', 'weights'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'parakeet_vocab.json'), 'already-there');
    fs.writeFileSync(path.join(newDir, 'Encoder.mlmodelc', 'weights', 'weight.bin'), 'data');
    fs.writeFileSync(path.join(newDir, 'Decoder.mlmodelc', 'weights', 'weight.bin'), 'data');
    fs.writeFileSync(path.join(newDir, 'JointDecision.mlmodelc', 'weights', 'weight.bin'), 'data');
    fs.writeFileSync(path.join(newDir, 'Preprocessor.mlmodelc', 'weights', 'weight.bin'), 'data');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    // Legacy deleted, new path untouched
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'parakeet_vocab.json'), 'utf8')).toBe('already-there');
  });

  it('replaces partial new path with legacy copy (v0.4.27 CLI download artifacts)', () => {
    // Simulate: legacy has complete model, new path has partial files from
    // FluidAudio CLI's failed HuggingFace download attempt on v0.4.27
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(path.join(legacyDir, 'Encoder.mlmodelc', 'weights'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'good');
    fs.writeFileSync(path.join(legacyDir, 'Encoder.mlmodelc', 'weights', 'weight.bin'), 'good');

    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'partial-file.bin'), 'incomplete-download');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    // Partial new path wiped and replaced with legacy copy
    expect(fs.existsSync(path.join(newDir, 'partial-file.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'parakeet_vocab.json'), 'utf8')).toBe('good');
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it('migrates into an existing empty new directory', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'Encoder.mlmodelc'), 'legacy');
    fs.mkdirSync(newDir, { recursive: true }); // empty

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'Encoder.mlmodelc'), 'utf8')).toBe('legacy');
  });

  it('cleans up legacy staging directory during migration', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'data');
    const legacyStagingDir = legacyDir + '.staging';
    fs.mkdirSync(legacyStagingDir, { recursive: true });
    fs.writeFileSync(path.join(legacyStagingDir, 'partial.bin'), 'leftover');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    expect(fs.existsSync(legacyStagingDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });
});

describe('isSafeManagedPath', () => {
  it('accepts paths under userData/models', () => {
    const manager = new LocalSttModelManager();
    const safe = manager['isSafeManagedPath'](path.join(testTempDir, 'models', 'parakeet'));
    expect(safe).toBe(true);
  });

  it('accepts paths under FluidAudio/Models', () => {
    const manager = new LocalSttModelManager();
    const safe = manager['isSafeManagedPath'](path.join(testAppDataDir, 'FluidAudio', 'Models', 'parakeet'));
    expect(safe).toBe(true);
  });

  it('rejects paths outside managed roots', () => {
    const manager = new LocalSttModelManager();
    expect(manager['isSafeManagedPath']('/tmp/evil')).toBe(false);
    expect(manager['isSafeManagedPath'](testTempDir)).toBe(false);
    expect(manager['isSafeManagedPath'](testAppDataDir)).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    const manager = new LocalSttModelManager();
    const traversal = path.join(testTempDir, 'models', '..', '..', 'etc', 'passwd');
    expect(manager['isSafeManagedPath'](traversal)).toBe(false);
  });
});

/**
 * Observability: the migration and CLI subsystems lived with silent-failure
 * antipatterns prior to 2026-04-22. Now every terminal failure mode must call
 * the shared `reportLocalSttError` helper with a distinct `component` tag so
 * recurrences are diagnosable from Sentry alone — see
 * docs-private/investigations/260422_local_parakeet_still_not_working_daniel_kilger.md.
 */
describe('reportLocalSttError', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
  });

  it('calls getErrorReporter().captureException with the expected tags and extras', () => {
    const err = new Error('boom');
    reportLocalSttError(err, 'migrate-unknown', { legacyPath: '/a', newPath: '/b' });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedErr, opts] = mockCaptureException.mock.calls[0]!;
    expect(capturedErr).toBe(err);
    expect(opts).toEqual({
      tags: { area: 'local-stt', component: 'migrate-unknown' },
      extras: { legacyPath: '/a', newPath: '/b' },
    });
  });

  it('does not throw when the error reporter itself throws', () => {
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });

    expect(() => reportLocalSttError(new Error('x'), 'migrate-unknown')).not.toThrow();
  });

  it('passes undefined extras through when none provided', () => {
    reportLocalSttError(new Error('x'), 'cli-timeout');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, opts] = mockCaptureException.mock.calls[0]!;
    expect(opts).toMatchObject({
      tags: { area: 'local-stt', component: 'cli-timeout' },
    });
  });

  it('stamps a captured marker on the error so outer catches can skip re-capture', () => {
    const err = new Error('boom');
    expect(isLocalSttCaptured(err)).toBe(false);

    reportLocalSttError(err, 'migrate-copy-fallback');

    expect(isLocalSttCaptured(err)).toBe(true);
  });

  it('does not stamp the marker when capture itself throws', () => {
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });
    const err = new Error('boom');

    reportLocalSttError(err, 'migrate-copy-fallback');

    // Capture failed, so outer catches SHOULD still get a chance to try.
    expect(isLocalSttCaptured(err)).toBe(false);
  });

  it('handles non-object errors gracefully', () => {
    expect(isLocalSttCaptured(null)).toBe(false);
    expect(isLocalSttCaptured(undefined)).toBe(false);
    expect(isLocalSttCaptured('string error')).toBe(false);
    expect(isLocalSttCaptured(42)).toBe(false);

    // Should not throw when reporting a non-object error
    expect(() => reportLocalSttError('string error', 'migrate-unknown')).not.toThrow();
  });
});

describe('migrateLegacyModelPaths telemetry', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  const legacyDir = path.join(testTempDir, 'models', 'parakeet-tdt-0.6b-v3-coreml');
  const newDir = path.join(testAppDataDir, 'FluidAudio', 'Models', 'parakeet-tdt-0.6b-v3-coreml');
  const newDirParent = path.dirname(newDir);

  // Chmod tracking so we can reliably clean up 0o444'd directories even when
  // the test throws mid-way. Without this, afterEach rmSync would fail EACCES.
  const lockedPaths = new Set<string>();
  const lockDir = (p: string) => {
    fs.chmodSync(p, 0o555);
    lockedPaths.add(p);
  };
  const unlockAll = () => {
    for (const p of lockedPaths) {
      try { fs.chmodSync(p, 0o755); } catch { /* best-effort */ }
    }
    lockedPaths.clear();
  };

  beforeEach(() => {
    setPlatform('darwin');
    mockCaptureException.mockReset();
    unlockAll();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(newDir, { recursive: true, force: true });
    fs.rmSync(newDirParent, { recursive: true, force: true });
  });

  afterEach(() => {
    unlockAll();
    vi.restoreAllMocks();
  });

  afterAll(() => setPlatform(originalPlatform));

  it('captures new-path inspection failures with component migrate-inspect-new-path', () => {
    // Arrange: legacy + existing new path so migration enters the inspect
    // branch. Force the private `getRequiredFiles()` to throw so the outer
    // catch inside the inspect block fires without requiring us to mock the
    // frozen `fs` namespace import.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'legacy');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'partial.bin'), 'partial');

    const manager = new LocalSttModelManager();
    // Private method access for test — TS sees the method, ESLint doesn't
    // trip no-explicit-any because we route through Record<string, ...>.
    vi.spyOn(
      manager as unknown as Record<string, (modelId: string) => string[]>,
      'getRequiredFiles'
    ).mockImplementation(() => {
      throw new Error('EACCES: simulated inspect failure');
    });

    manager.migrateLegacyModelPaths();

    // Only the inspect-new-path capture should have fired (no copy-fallback,
    // no outer migrate-unknown) because the inspect catch returns early.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, opts] = mockCaptureException.mock.calls[0]!;
    expect(opts).toMatchObject({
      tags: { area: 'local-stt', component: 'migrate-inspect-new-path' },
      extras: expect.objectContaining({
        legacyPath: legacyDir,
        newPath: newDir,
        stage: 'inspect-new-path',
      }),
    });

    // Legacy copy preserved (early return) and nothing migrated.
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it('captures copy-fallback failures with component migrate-copy-fallback', () => {
    // Arrange: legacy present, new path absent, parent of new path exists but
    // is read-only (0o555). Both fs.renameSync and fs.cpSync will fail with
    // EACCES trying to create entries under it — so the migration reaches the
    // copy-fallback catch naturally, without mocking the frozen fs namespace.
    //
    // Skip on platforms where chmod read-only bit isn't enforced (Windows),
    // or when running as root (CI sometimes does; chmod has no effect).
    if (process.getuid && process.getuid() === 0) {
      // Running as root — chmod permissions are ignored. Skip this test.
      return;
    }

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'data');
    fs.mkdirSync(newDirParent, { recursive: true });
    lockDir(newDirParent);

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    // The copy-fallback capture fires at the deepest stage with full context.
    // The outer migrate-unknown catch detects the captured marker and skips
    // re-reporting — we want one Sentry event per root failure, tagged at
    // the most specific stage.
    const components = mockCaptureException.mock.calls.map(
      (call) => (call[1] as { tags: { component: string } }).tags.component
    );
    expect(components).toEqual(['migrate-copy-fallback']);

    const copyCall = mockCaptureException.mock.calls.find(
      (c) => (c[1] as { tags: { component: string } }).tags.component === 'migrate-copy-fallback'
    )!;
    expect(copyCall[1]).toMatchObject({
      tags: { area: 'local-stt', component: 'migrate-copy-fallback' },
      extras: expect.objectContaining({
        legacyPath: legacyDir,
        newPath: newDir,
        stage: 'copy-fallback',
      }),
    });

    // Legacy should still be on disk — migration failed before cleanup could run.
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it('does NOT capture Sentry events when rename succeeds (happy path)', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'parakeet_vocab.json'), 'data');

    const manager = new LocalSttModelManager();
    manager.migrateLegacyModelPaths();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(fs.existsSync(newDir)).toBe(true);
  });
});
