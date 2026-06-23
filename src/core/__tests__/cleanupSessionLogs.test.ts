/**
 * Tests for the enhanced cleanupSessionLogs() function.
 *
 * Uses real filesystem (os.tmpdir() + mkdtempSync) to verify age, count,
 * and size bounds, the 60-second grace floor, concurrency guard, and
 * per-file error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';

// Opt out of the global no-op logger mock (vitest.setup.ts) — these tests
// exercise the real logger module's cleanupSessionLogs() implementation.
vi.unmock('@core/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;
let sessionsDir: string;

function createTestDirs() {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'rebel-cleanup-test-'));
  sessionsDir = path.join(testDir, 'logs', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
}

/** Create a dummy .log file with a given size (bytes) and mtime (epoch ms). */
function createLogFile(name: string, sizeBytes: number, mtimeMs: number): void {
  const filePath = path.join(sessionsDir, name);
  // Write a buffer of the requested size
  writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x41)); // fill with 'A'
  // Set access and modification times
  const timeSec = mtimeMs / 1000;
  utimesSync(filePath, timeSec, timeSec);
}

/** Create a non-.log file. */
function createNonLogFile(name: string, sizeBytes: number, mtimeMs: number): void {
  const filePath = path.join(sessionsDir, name);
  writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x42));
  const timeSec = mtimeMs / 1000;
  utimesSync(filePath, timeSec, timeSec);
}

/** Create a subdirectory (not a file) with a .log name. */
function createLogDir(name: string): void {
  mkdirSync(path.join(sessionsDir, name), { recursive: true });
}

/** List remaining .log files in the sessions directory. */
function remainingLogFiles(): string[] {
  return fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.log') && fs.statSync(path.join(sessionsDir, n)).isFile());
}

// ---------------------------------------------------------------------------
// Fresh module import helper (bypasses pino/logger initialization)
// ---------------------------------------------------------------------------

async function importCleanup() {
  vi.doMock('@core/utils/dataPaths', () => ({
    getDataPath: () => testDir,
    getAppVersion: () => '0.0.0-test',
  }));

  const mod = await import('@core/logger');
  return mod;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('cleanupSessionLogs', () => {
  beforeEach(() => {
    vi.resetModules();
    createTestDirs();
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Timestamps for test files
  const now = Date.now();
  const ONE_DAY = 86_400_000;
  const daysAgo = (d: number) => now - d * ONE_DAY;

  it('returns zeros for an empty directory', async () => {
    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result).toEqual({ deleted: 0, errors: 0, remainingCount: 0, remainingBytes: 0 });
  });

  it('returns zeros gracefully for a non-existent directory', async () => {
    // Remove the sessions dir so it doesn't exist
    rmSync(sessionsDir, { recursive: true, force: true });

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result).toEqual({ deleted: 0, errors: 0, remainingCount: 0, remainingBytes: 0 });
  });

  it('deletes files older than retention, keeps newer', async () => {
    // 3 old files (20 days ago) and 2 recent files (5 days ago)
    createLogFile('old-1.log', 100, daysAgo(20));
    createLogFile('old-2.log', 100, daysAgo(25));
    createLogFile('old-3.log', 100, daysAgo(30));
    createLogFile('recent-1.log', 100, daysAgo(5));
    createLogFile('recent-2.log', 100, daysAgo(3));

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result.deleted).toBe(3);
    expect(result.remainingCount).toBe(2);
    expect(remainingLogFiles().sort()).toEqual(['recent-1.log', 'recent-2.log']);
  });

  it('enforces count cap — deletes oldest when over maxFiles', async () => {
    // Create 205 recent files (all within retention)
    for (let i = 0; i < 205; i++) {
      createLogFile(`file-${String(i).padStart(3, '0')}.log`, 100, daysAgo(1) + i * 1000);
    }

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result.deleted).toBe(5);
    expect(result.remainingCount).toBe(200);
    expect(remainingLogFiles().length).toBe(200);
  });

  it('enforces size cap — deletes oldest when over maxBytes', async () => {
    const MB100 = 100 * 1024 * 1024;
    // 3 × 100 MB files all within retention (total 300 MB, cap 250 MB)
    createLogFile('big-newest.log', MB100, daysAgo(1));
    createLogFile('big-middle.log', MB100, daysAgo(2));
    createLogFile('big-oldest.log', MB100, daysAgo(3));

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    // Should keep 2 (200 MB), delete 1 (the oldest)
    expect(result.deleted).toBe(1);
    expect(result.remainingCount).toBe(2);
    expect(result.remainingBytes).toBe(2 * MB100);
    expect(remainingLogFiles().sort()).toEqual(['big-middle.log', 'big-newest.log']);
  });

  it('enforces combined bounds — age + count + size together', async () => {
    const MB50 = 50 * 1024 * 1024;
    // 2 old files (deleted by age), 6 recent files (4 kept by count cap of 4)
    createLogFile('aged-out-1.log', MB50, daysAgo(20));
    createLogFile('aged-out-2.log', MB50, daysAgo(25));
    for (let i = 0; i < 6; i++) {
      createLogFile(`recent-${i}.log`, MB50, daysAgo(1) + i * 1000);
    }

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 4, maxBytes: 500 * 1024 * 1024 });
    // 2 aged out + 2 over count cap = 4 deleted
    expect(result.deleted).toBe(4);
    expect(result.remainingCount).toBe(4);
  });

  it('protects files within 60-second grace floor even if over caps', async () => {
    // Create files that are "just now" (within 60 seconds)
    const veryRecent = Date.now() - 5000; // 5 seconds ago
    createLogFile('grace-1.log', 100, veryRecent);
    createLogFile('grace-2.log', 100, veryRecent + 1000);
    createLogFile('grace-3.log', 100, veryRecent + 2000);

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    // Set all caps to 1 — grace floor should still protect all 3
    const result = await cleanupSessionLogs({ retentionDays: 1, maxFiles: 1, maxBytes: 1 });
    expect(result.deleted).toBe(0);
    expect(result.remainingCount).toBe(3);
    expect(remainingLogFiles().length).toBe(3);
  });

  it('ignores non-.log files', async () => {
    createNonLogFile('notes.txt', 100, daysAgo(20));
    createNonLogFile('data.json', 100, daysAgo(20));
    createLogFile('old.log', 100, daysAgo(20));

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result.deleted).toBe(1);
    // Non-.log files should still exist
    expect(fs.existsSync(path.join(sessionsDir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'data.json'))).toBe(true);
  });

  it('ignores non-file entries (directory named test.log)', async () => {
    createLogDir('test.log');
    createLogFile('old.log', 100, daysAgo(20));

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });
    expect(result.deleted).toBe(1);
    // Directory named test.log should still exist
    expect(fs.existsSync(path.join(sessionsDir, 'test.log'))).toBe(true);
    expect(fs.statSync(path.join(sessionsDir, 'test.log')).isDirectory()).toBe(true);
  });

  it('concurrency guard — second concurrent call returns early', async () => {
    createLogFile('file.log', 100, daysAgo(20));

    const { cleanupSessionLogs, _resetCleanupGuard, _isCleanupRunning } = await importCleanup();
    _resetCleanupGuard();

    // Start first cleanup (don't await yet)
    const first = cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });

    // The flag should be set while first is in-flight
    // (since we're in the same microtask turn, the async function has entered the try block)
    // Start second cleanup immediately
    const second = cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    // One should have done the work, the other should be a no-op
    expect(firstResult.deleted + secondResult.deleted).toBe(1);
    // The guard-skipped call returns all zeros
    const skipped = firstResult.deleted === 0 ? firstResult : secondResult;
    expect(skipped).toEqual({ deleted: 0, errors: 0, remainingCount: 0, remainingBytes: 0 });
  });

  it('handles per-file stat failures gracefully — cleanup continues', async () => {
    // Create 1 old file and 1 recent file
    createLogFile('old-ok.log', 100, daysAgo(20));
    createLogFile('recent.log', 100, daysAgo(1));

    // Create a broken symlink that readdir will list but stat will fail on (ENOENT).
    // This simulates a TOCTOU race where a file vanishes between readdir and stat.
    fs.symlinkSync(
      path.join(sessionsDir, 'nonexistent-target'),
      path.join(sessionsDir, 'broken-link.log')
    );

    const { cleanupSessionLogs, _resetCleanupGuard } = await importCleanup();
    _resetCleanupGuard();

    const result = await cleanupSessionLogs({ retentionDays: 14, maxFiles: 200, maxBytes: 250 * 1024 * 1024 });

    // broken-link.log stat fails (skipped gracefully), old-ok.log deleted by age, recent.log kept
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.remainingCount).toBe(1);
    // Broken symlink should still exist (not touched by cleanup)
    expect(fs.lstatSync(path.join(sessionsDir, 'broken-link.log')).isSymbolicLink()).toBe(true);
  });
});
