/**
 * Regression tests for local-STT CLI failure telemetry.
 *
 * Context: until 2026-04-22, `runFluidAudioCli()` reached every terminal
 * failure mode (spawn error, non-zero exit, timeout) with log-only output
 * and no Sentry capture. That left users like [external-email] invisible to
 * ops — we could only diagnose his v0.4.27→v0.4.28 stale-version issue via a
 * manually shared screenshot.
 *
 * These tests assert that every failure mode now calls the shared
 * `reportLocalSttError` helper with a distinct `component` tag so the next
 * recurrence is diagnosable from Sentry alone.
 *
 * See: docs-private/investigations/260422_local_parakeet_still_not_working_daniel_kilger.md
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before vi.mock factories
// ---------------------------------------------------------------------------

const { mockCaptureException, mockGetModelPath, mockSpawn } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockGetModelPath: vi.fn(() => '/fake/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml'),
  mockSpawn: vi.fn(),
}));

// Mock electron — localSttService imports the manager, which imports electron.
 
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'appData') return '/tmp/mindstone-stt-service-appdata';
      return '/tmp/mindstone-stt-service-userdata';
    }),
  },
  BrowserWindow: vi.fn(),
}));

 
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

// The service looks up the model path via the manager's singleton.
 
vi.mock('../localSttModelManager', async () => {
  // Keep the real reportLocalSttError so we exercise the real capture path;
  // only stub the singleton methods that depend on electron runtime state.
  const actual = await vi.importActual<typeof import('../localSttModelManager')>(
    '../localSttModelManager'
  );
  return {
    ...actual,
    localSttModelManager: {
      getModelPath: mockGetModelPath,
      getStatus: vi.fn(),
      startDownload: vi.fn(),
      cancelDownload: vi.fn(),
      removeModel: vi.fn(),
      cleanupStaleStaging: vi.fn(),
      migrateLegacyModelPaths: vi.fn(),
    },
  };
});

 
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock ChildProcess that exposes the surface `runFluidAudioCli`
 * actually uses: stdout/stderr as EventEmitters plus `on()` for `close`/
 * `error` plus a noop `kill()`.
 */
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

// Import under test AFTER mocks are in place.
const { runFluidAudioCli, checkMacOSCompatibility } = await import('../localSttService');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFluidAudioCli telemetry', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    mockSpawn.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures spawn errors with component cli-spawn-error', async () => {
    const proc = new MockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const pending = runFluidAudioCli('/fake/fluidaudiocli', '/tmp/input.wav');

    // Simulate a synchronous spawn failure (e.g., ENOENT when the CLI binary
    // is missing from the packaged resources).
    queueMicrotask(() => proc.emit('error', new Error('ENOENT: no such file')));

    await expect(pending).rejects.toThrow(/Failed to start transcription/);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedErr, opts] = mockCaptureException.mock.calls[0]!;
    expect(capturedErr).toBeInstanceOf(Error);
    expect((capturedErr as Error).message).toContain('ENOENT');
    expect(opts).toMatchObject({
      tags: { area: 'local-stt', component: 'cli-spawn-error' },
      extras: expect.objectContaining({
        cliPath: '/fake/fluidaudiocli',
        modelPath: '/fake/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml',
      }),
    });
    expect((opts as { extras: { elapsedMs: number } }).extras.elapsedMs).toBeTypeOf('number');
  });

  it('captures non-zero exits with component cli-exit-nonzero and stderrTail', async () => {
    const proc = new MockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const pending = runFluidAudioCli('/fake/fluidaudiocli', '/tmp/input.wav');

    // Simulate stderr output then a non-zero exit.
    queueMicrotask(() => {
      proc.stderr.emit(
        'data',
        Buffer.from('FluidAudio: failed to load model from /Users/dk/Library/Application Support/FluidAudio/Models/parakeet\n')
      );
      proc.emit('close', 1);
    });

    await expect(pending).rejects.toThrow(/Transcription failed/);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedErr, opts] = mockCaptureException.mock.calls[0]!;
    expect((capturedErr as Error).message).toContain('exited with code 1');
    expect(opts).toMatchObject({
      tags: { area: 'local-stt', component: 'cli-exit-nonzero' },
    });
    const extras = (opts as { extras: Record<string, unknown> }).extras;
    expect(extras).toMatchObject({
      cliPath: '/fake/fluidaudiocli',
      modelPath: '/fake/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml',
      exitCode: 1,
    });
    expect(extras.stderrTail).toMatch(/failed to load model/);
    // stderrTail must be capped at 500 chars to avoid leaking oversized payloads.
    expect((extras.stderrTail as string).length).toBeLessThanOrEqual(500);
  });

  it('retries once after timeout and captures final timeout with component cli-timeout', async () => {
    vi.useFakeTimers();

    const firstProc = new MockChildProcess();
    const retryProc = new MockChildProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(retryProc);

    // Attach a rejection handler eagerly so Node doesn't briefly see the
    // rejection as unhandled between the fake-timer fire and the await.
    const pending = runFluidAudioCli('/fake/fluidaudiocli', '/tmp/input.wav');
    const settled = pending.then(
      () => ({ kind: 'resolve' as const }),
      (err: Error) => ({ kind: 'reject' as const, err })
    );

    // Advance past the initial 120s timeout and the retry's 240s timeout
    // without emitting close/error.
    await vi.advanceTimersByTimeAsync(361_000);
    vi.useRealTimers();

    const result = await settled;
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.err.message).toMatch(/timed out after 240 seconds/);
    }

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedErr, opts] = mockCaptureException.mock.calls[0]!;
    expect((capturedErr as Error).message).toMatch(/timed out after 240 seconds/);
    expect(opts).toMatchObject({
      tags: { area: 'local-stt', component: 'cli-timeout' },
      extras: expect.objectContaining({
        cliPath: '/fake/fluidaudiocli',
        modelPath: '/fake/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml',
        attempt: 2,
      }),
    });
    expect(firstProc.kill).toHaveBeenCalled();
    expect(retryProc.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not capture telemetry when retry succeeds after the first timeout', async () => {
    vi.useFakeTimers();

    const firstProc = new MockChildProcess();
    const retryProc = new MockChildProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(retryProc);

    const pending = runFluidAudioCli('/fake/fluidaudiocli', '/tmp/input.wav');

    await vi.advanceTimersByTimeAsync(121_000);
    queueMicrotask(() => {
      retryProc.stdout.emit('data', Buffer.from('Recovered transcription\n'));
      retryProc.emit('close', 0);
    });
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();

    await expect(pending).resolves.toMatchObject({ text: 'Recovered transcription' });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(firstProc.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does NOT capture telemetry on success (happy path)', async () => {
    const proc = new MockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const pending = runFluidAudioCli('/fake/fluidaudiocli', '/tmp/input.wav');

    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from('Hello world transcription\n'));
      proc.emit('close', 0);
    });

    await expect(pending).resolves.toMatchObject({ text: 'Hello world transcription' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe('checkMacOSCompatibility', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('throws on macOS 13.x (Darwin 22)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => checkMacOSCompatibility('22.5.0')).toThrow(
      /Local transcription requires macOS 14/
    );
    expect(() => checkMacOSCompatibility('22.5.0')).toThrow(
      /You're running macOS 13/
    );
  });

  it('throws on macOS 12.x (Darwin 21)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => checkMacOSCompatibility('21.6.0')).toThrow(
      /You're running macOS 12/
    );
  });

  it('does not throw on macOS 14.0 (Darwin 23)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => checkMacOSCompatibility('23.0.0')).not.toThrow();
  });

  it('does not throw on macOS 15.x (Darwin 24)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => checkMacOSCompatibility('24.6.0')).not.toThrow();
  });

  it('skips check on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => checkMacOSCompatibility('5.15.0')).not.toThrow();
  });
});
