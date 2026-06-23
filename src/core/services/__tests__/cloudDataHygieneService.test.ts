import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loggerModule from '@core/logger';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';
import {
  purgeDeletedSessions,
  removeLegacyFiles,
  runCloudDataHygiene,
} from '../cloudDataHygieneService';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_LOG_RESULT = {
  deleted: 0,
  errors: 0,
  remainingCount: 0,
  remainingBytes: 0,
};

function deletedSessionFilename(sessionId: string, timestampMs: number): string {
  return `${sessionId}_${timestampMs}.json`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileWithSize(filePath: string, sizeBytes: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(sizeBytes, 'x'));
}

let testDataPath = '';

beforeAll(async () => {
  testDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-data-hygiene-'));
  process.env.REBEL_USER_DATA = testDataPath;
});

beforeEach(async () => {
  await fs.rm(testDataPath, { recursive: true, force: true });
  await fs.mkdir(testDataPath, { recursive: true });
  vi.restoreAllMocks();
  vi.mocked(loggerModule.cleanupSessionLogs).mockResolvedValue({ ...DEFAULT_SESSION_LOG_RESULT });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(testDataPath, { recursive: true, force: true });
  delete process.env.REBEL_USER_DATA;
});

describe('purgeDeletedSessions', () => {
  it('deletes files older than ttlDays using filename timestamps and keeps newer/unparseable files', async () => {
    const now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const deletedDir = path.join(testDataPath, 'sessions-deleted');
    await fs.mkdir(deletedDir, { recursive: true });

    const oldFile = path.join(deletedDir, deletedSessionFilename('memory-update_abc_def', now - 10 * DAY_MS));
    const oldFile2 = path.join(deletedDir, deletedSessionFilename('plain-session', now - 9 * DAY_MS));
    const newerFile = path.join(deletedDir, deletedSessionFilename('newer-session', now - 2 * DAY_MS));
    const exactCutoffFile = path.join(deletedDir, deletedSessionFilename('exact-cutoff', now - 7 * DAY_MS));
    const invalidFile = path.join(deletedDir, 'notes.json');

    await writeFileWithSize(oldFile, 11);
    await writeFileWithSize(oldFile2, 5);
    await writeFileWithSize(newerFile, 9);
    await writeFileWithSize(exactCutoffFile, 7);
    await writeFileWithSize(invalidFile, 3);

    const result = await purgeDeletedSessions(deletedDir, 7);

    expect(result).toEqual({
      deleted: 2,
      bytesFreed: 16,
      errors: [],
    });
    expect(await pathExists(oldFile)).toBe(false);
    expect(await pathExists(oldFile2)).toBe(false);
    expect(await pathExists(newerFile)).toBe(true);
    expect(await pathExists(exactCutoffFile)).toBe(true);
    expect(await pathExists(invalidFile)).toBe(true);
  });

  it('handles missing sessions-deleted directory without errors', async () => {
    const result = await purgeDeletedSessions(path.join(testDataPath, 'missing-sessions-deleted'));

    expect(result).toEqual({
      deleted: 0,
      bytesFreed: 0,
      errors: [],
    });
  });

  it('aggregates per-file failures while continuing other deletions', async () => {
    const now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const deletedDir = path.join(testDataPath, 'sessions-deleted');
    await fs.mkdir(deletedDir, { recursive: true });

    const okFile = path.join(deletedDir, deletedSessionFilename('ok-session', now - 9 * DAY_MS));
    const failFile = path.join(deletedDir, deletedSessionFilename('fail-session', now - 9 * DAY_MS));
    await writeFileWithSize(okFile, 4);
    await fs.symlink(path.join(deletedDir, 'missing-target'), failFile);

    const result = await purgeDeletedSessions(deletedDir, 7);

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(path.basename(failFile));
    expect(await pathExists(okFile)).toBe(false);
  });
});

describe('removeLegacyFiles', () => {
  it('removes legacy files when incremental sessions index exists', async () => {
    const dataPath = path.join(testDataPath, 'legacy-remove');
    await fs.mkdir(path.join(dataPath, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(dataPath, 'sessions', 'index.json'), '{}');

    const legacyPath = path.join(dataPath, 'agent-session-history.json');
    const backupPath = path.join(dataPath, 'agent-session-history.json.backup.json');
    await fs.writeFile(legacyPath, 'legacy');
    await fs.writeFile(backupPath, 'backup');

    const result = await removeLegacyFiles(dataPath);

    expect(result.errors).toEqual([]);
    expect(result.removed.sort()).toEqual([
      'agent-session-history.json',
      'agent-session-history.json.backup.json',
    ]);
    // bytesFreed should reflect the actual size of removed files even when no
    // minAgeMs is supplied (regression guard for F1 reviewer suggestion).
    expect(result.bytesFreed).toBe('legacy'.length + 'backup'.length);
    expect(await pathExists(legacyPath)).toBe(false);
    expect(await pathExists(backupPath)).toBe(false);
  });

  it('does nothing when incremental sessions index is missing', async () => {
    const dataPath = path.join(testDataPath, 'legacy-safety-check');
    await fs.mkdir(dataPath, { recursive: true });

    const legacyPath = path.join(dataPath, 'agent-session-history.json');
    const backupPath = path.join(dataPath, 'agent-session-history.json.backup.json');
    await fs.writeFile(legacyPath, 'legacy');
    await fs.writeFile(backupPath, 'backup');

    const result = await removeLegacyFiles(dataPath);

    expect(result).toEqual({ removed: [], bytesFreed: 0, errors: [] });
    expect(await pathExists(legacyPath)).toBe(true);
    expect(await pathExists(backupPath)).toBe(true);
  });

  it('ignores already-absent legacy files', async () => {
    const dataPath = path.join(testDataPath, 'legacy-absent');
    await fs.mkdir(path.join(dataPath, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(dataPath, 'sessions', 'index.json'), '{}');

    const result = await removeLegacyFiles(dataPath);

    expect(result).toEqual({ removed: [], bytesFreed: 0, errors: [] });
  });

  it('honours minAgeMs and keeps fresh files', async () => {
    const dataPath = path.join(testDataPath, 'legacy-min-age');
    await fs.mkdir(path.join(dataPath, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(dataPath, 'sessions', 'index.json'), '{}');

    const legacyPath = path.join(dataPath, 'agent-session-history.json');
    const backupPath = path.join(dataPath, 'agent-session-history.json.backup.json');
    await fs.writeFile(legacyPath, 'legacy');
    await fs.writeFile(backupPath, 'backup');

    // Backdate the legacy file but leave the backup fresh.
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const oldTime = new Date(Date.now() - tenDaysMs);
    await fs.utimes(legacyPath, oldTime, oldTime);

    // minAgeMs = 5 days -> legacy (10d old) removed, backup (fresh) kept.
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    const result = await removeLegacyFiles(dataPath, { minAgeMs: fiveDaysMs });

    expect(result.removed).toEqual(['agent-session-history.json']);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(await pathExists(legacyPath)).toBe(false);
    expect(await pathExists(backupPath)).toBe(true);
  });
});

describe('runCloudDataHygiene', () => {
  it('returns an aggregated result with all category fields populated', async () => {
    const now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const deletedDir = path.join(testDataPath, 'sessions-deleted');
    await fs.mkdir(deletedDir, { recursive: true });
    const oldDeletedFile = path.join(deletedDir, deletedSessionFilename('old-deleted', now - 8 * DAY_MS));
    await writeFileWithSize(oldDeletedFile, 13);

    await fs.mkdir(path.join(testDataPath, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(testDataPath, 'sessions', 'index.json'), '{}');
    await fs.writeFile(path.join(testDataPath, 'agent-session-history.json'), 'legacy');
    await fs.writeFile(path.join(testDataPath, 'agent-session-history.json.backup.json'), 'backup');

    const transcriptsDir = path.join(testDataPath, 'transcripts');
    await fs.mkdir(transcriptsDir, { recursive: true });
    const oldTranscript = path.join(transcriptsDir, 'session-a.jsonl');
    await fs.writeFile(oldTranscript, '{"hello":"world"}\n');
    const oldDate = new Date(now - 20 * DAY_MS);
    await fs.utimes(oldTranscript, oldDate, oldDate);

    const result = await runCloudDataHygiene(testDataPath);

    expect(result.deletedSessionFiles).toBe(1);
    expect(result.deletedSessionBytes).toBe(13);
    expect(result.removedLegacyFiles.sort()).toEqual([
      'agent-session-history.json',
      'agent-session-history.json.backup.json',
    ]);
    expect(result.sessionLogResult).toEqual(DEFAULT_SESSION_LOG_RESULT);
    expect(result.oldTranscripts).toEqual({ deleted: 1, errors: 0 });
    expect(result.errors).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates errors>0 from cleanupSessionLogs into HygieneResult.errors[]', async () => {
    vi.mocked(loggerModule.cleanupSessionLogs).mockResolvedValueOnce({
      deleted: 0,
      errors: 3,
      remainingCount: 0,
      remainingBytes: 0,
    });

    const result = await runCloudDataHygiene(testDataPath);

    expect(result.sessionLogResult.errors).toBe(3);
    expect(
      result.errors.some((entry) => entry.includes('cleanupSessionLogs reported 3 file cleanup errors')),
    ).toBe(true);
  });

  it('emits a Sentry captureMessage when the run completes with errors', async () => {
    const captureMessage = vi.fn();
    const captureException = vi.fn();
    const addBreadcrumb = vi.fn();
    const reporter: ErrorReporter = {
      captureMessage,
      captureException,
      addBreadcrumb,
    };
    setErrorReporter(reporter);
    try {
      vi.mocked(loggerModule.cleanupSessionLogs).mockResolvedValueOnce({
        deleted: 0,
        errors: 4,
        remainingCount: 0,
        remainingBytes: 0,
      });

      const result = await runCloudDataHygiene(testDataPath);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(captureMessage).toHaveBeenCalledWith(
        'Cloud data hygiene completed with errors',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({ service: 'cloud-data-hygiene' }),
          extra: expect.objectContaining({
            errorCount: expect.any(Number),
            sessionLogErrors: 4,
          }),
        }),
      );
    } finally {
      setErrorReporter({ captureMessage: () => {}, captureException: () => {}, addBreadcrumb: () => {} });
    }
  });

  it('does NOT emit captureMessage when the run completes without errors', async () => {
    const captureMessage = vi.fn();
    const reporter: ErrorReporter = {
      captureMessage,
      captureException: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    setErrorReporter(reporter);
    try {
      const result = await runCloudDataHygiene(testDataPath);

      expect(result.errors).toEqual([]);
      expect(captureMessage).not.toHaveBeenCalled();
    } finally {
      setErrorReporter({ captureMessage: () => {}, captureException: () => {}, addBreadcrumb: () => {} });
    }
  });

  it('continues other categories when one category throws and records the error', async () => {
    const now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const deletedDir = path.join(testDataPath, 'sessions-deleted');
    await fs.mkdir(deletedDir, { recursive: true });
    const oldDeletedFile = path.join(deletedDir, deletedSessionFilename('old-deleted', now - 8 * DAY_MS));
    await writeFileWithSize(oldDeletedFile, 10);

    await fs.mkdir(path.join(testDataPath, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(testDataPath, 'sessions', 'index.json'), '{}');
    await fs.writeFile(path.join(testDataPath, 'agent-session-history.json'), 'legacy');

    vi.mocked(loggerModule.cleanupSessionLogs).mockRejectedValueOnce(new Error('simulated cleanupSessionLogs failure'));

    const result = await runCloudDataHygiene(testDataPath);

    expect(result.deletedSessionFiles).toBe(1);
    expect(result.removedLegacyFiles).toEqual(['agent-session-history.json']);
    expect(result.sessionLogResult).toEqual(DEFAULT_SESSION_LOG_RESULT);
    expect(
      result.errors.some(
        (entry) => entry.includes('cleanupSessionLogs failed') && entry.includes('simulated cleanupSessionLogs failure'),
      ),
    ).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
