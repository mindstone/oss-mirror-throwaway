/**
 * Regression tests for packaged-build logger fallback handling.
 *
 * Uses real temp-dir fixtures to verify the defensive cleanup/archive helpers
 * without touching the user's actual app logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

// Opt out of the global no-op logger mock (vitest.setup.ts) — these tests
// exercise the real logger module's fallback helpers.
vi.unmock('@core/logger');

const FALLBACK_MARKER = 'Rotating log transport unavailable';
const FALLBACK_THRESHOLD_BYTES = 50 * 1024 * 1024;

let testDir: string;
let logsDir: string;
let destinationPath: string;

const setMtime = (filePath: string, mtimeMs: number): void => {
  const timeSeconds = mtimeMs / 1000;
  utimesSync(filePath, timeSeconds, timeSeconds);
};

const writeLogFile = (name: string, content: string, mtimeMs: number): string => {
  const filePath = path.join(logsDir, name);
  writeFileSync(filePath, content);
  setMtime(filePath, mtimeMs);
  return filePath;
};

const fallbackLine = () => JSON.stringify({
  level: 40,
  msg: `${FALLBACK_MARKER}; using fallback log destination`,
});

const repeatedJsonLogContent = (targetBytes: number): string => {
  const line = `${JSON.stringify({
    level: 30,
    msg: 'normal later log content',
    details: 'x'.repeat(1024),
  })}\n`;
  return line.repeat(Math.ceil(targetBytes / Buffer.byteLength(line)));
};

const importLoggerHelpers = async () => {
  vi.resetModules();
  return import('@core/logger');
};

describe('logger fallback handling', () => {
  beforeEach(() => {
    testDir = mkdtempSync(path.join(os.tmpdir(), 'rebel-logger-fallback-'));
    logsDir = path.join(testDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    destinationPath = path.join(logsDir, 'mindstone-rebel.log');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('warns when registering a bundler path override fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registerBundlerPathOverride } = await importLoggerHelpers();
    const error = new Error("Cannot find module 'pino-roll'") as NodeJS.ErrnoException;
    error.code = 'MODULE_NOT_FOUND';
    const overrides: Record<string, string> = {};

    const updated = registerBundlerPathOverride(
      overrides,
      'pino-roll',
      'pino-roll',
      () => {
        throw error;
      },
    );

    expect(updated).toBe(false);
    expect(overrides).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      '[logger] failed to register __bundlerPathsOverrides — packaged build may fall back to unbounded log destination',
      {
        pkg: 'pino-roll',
        code: 'MODULE_NOT_FOUND',
        message: "Cannot find module 'pino-roll'",
      },
    );
  });

  it('deletes a stale bare fallback log only after rotation has newer rolled siblings', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    const fallbackContent = `${fallbackLine()}\nnormal later log\n`;
    writeLogFile('mindstone-rebel.log', fallbackContent, now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = cleanupStaleFallback({
      rotationOk: true,
      destinationPath,
      logger: logger as Parameters<typeof cleanupStaleFallback>[0]['logger'],
      now: () => now,
    });

    expect(result).toEqual({ deleted: true, reason: 'deleted' });
    expect(existsSync(destinationPath)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: Buffer.byteLength(fallbackContent) }),
      'Cleaned up stale fallback log file',
    );
    const [payload] = logger.info.mock.calls[0] ?? [];
    expect(payload?.ageMs).toBeCloseTo(60_000, 0);
  });

  it('deletes a stale fallback log when the marker is at the head and missing from the tail', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    const fallbackContent = `${fallbackLine()}\n${repeatedJsonLogContent(200 * 1024)}`;
    writeLogFile('mindstone-rebel.log', fallbackContent, now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: true, reason: 'deleted' });
    expect(existsSync(destinationPath)).toBe(false);
  });

  it('deletes a stale fallback log when the marker is only in the tail', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    const fallbackContent = `${repeatedJsonLogContent(200 * 1024)}${fallbackLine()}\n`;
    writeLogFile('mindstone-rebel.log', fallbackContent, now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: true, reason: 'deleted' });
    expect(existsSync(destinationPath)).toBe(false);
  });

  it('deletes a stale fallback log when the marker straddles the tail scan boundary', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    const fallbackContent = [
      'x'.repeat(100 * 1024),
      FALLBACK_MARKER,
      'x'.repeat((64 * 1024) - 5),
    ].join('');
    writeLogFile('mindstone-rebel.log', fallbackContent, now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: true, reason: 'deleted' });
    expect(existsSync(destinationPath)).toBe(false);
  });

  it('keeps the bare fallback log when there are no rolled siblings', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    writeLogFile('mindstone-rebel.log', `${fallbackLine()}\n`, Date.now() - 60_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: false, reason: 'no-rolled-siblings' });
    expect(existsSync(destinationPath)).toBe(true);
  });

  it('keeps the bare log when it lacks the historical fallback marker', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    writeLogFile('mindstone-rebel.log', 'normal active log\n', now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: false, reason: 'marker-missing' });
    expect(existsSync(destinationPath)).toBe(true);
  });

  it('keeps the bare fallback log when it is newer than the newest rolled sibling', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    writeLogFile('mindstone-rebel.log', `${fallbackLine()}\n`, now - 10_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 60_000);

    const result = cleanupStaleFallback({ rotationOk: true, destinationPath });

    expect(result).toEqual({ deleted: false, reason: 'newer-than-rolled' });
    expect(existsSync(destinationPath)).toBe(true);
  });

  it('keeps the bare fallback log when rotation did not initialize successfully', async () => {
    const { cleanupStaleFallback } = await importLoggerHelpers();
    const now = Date.now();
    writeLogFile('mindstone-rebel.log', `${fallbackLine()}\n`, now - 60_000);
    writeLogFile('mindstone-rebel.0001.log', 'rolled log\n', now - 10_000);

    const result = cleanupStaleFallback({ rotationOk: false, destinationPath });

    expect(result).toEqual({ deleted: false, reason: 'rotation-not-ready' });
    expect(existsSync(destinationPath)).toBe(true);
  });

  it('archives a 50 MB or larger fallback file before reopening the fallback destination', async () => {
    const { prepareFallbackDestination } = await importLoggerHelpers();
    writeFileSync(destinationPath, '');
    truncateSync(destinationPath, FALLBACK_THRESHOLD_BYTES);

    const result = prepareFallbackDestination(destinationPath, () => 123_456);

    const archivedPath = `${destinationPath}.fallback-stale-123456.log`;
    expect(result).toEqual({
      archived: true,
      archivedPath,
      sizeBytes: FALLBACK_THRESHOLD_BYTES,
    });
    expect(existsSync(destinationPath)).toBe(false);
    expect(statSync(archivedPath).size).toBe(FALLBACK_THRESHOLD_BYTES);
  });

  it('leaves a small fallback file in place', async () => {
    const { prepareFallbackDestination } = await importLoggerHelpers();
    writeFileSync(destinationPath, 'small log\n');

    const result = prepareFallbackDestination(destinationPath, () => 123_456);

    expect(result).toEqual({ archived: false, sizeBytes: 10 });
    expect(existsSync(destinationPath)).toBe(true);
    expect(readdirSync(logsDir).filter((name) => name.includes('.fallback-stale-'))).toEqual([]);
  });
});
