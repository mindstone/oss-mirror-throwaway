import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsDiagnosticEventsLedger } from '../createFsDiagnosticEventsLedger';
import { type DiagnosticEventEntry } from '../manifest';
import {
  appendDiagnosticEvent,
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '../../diagnosticEventsLedger';

const silentLogger = pino({ level: 'silent' });

const AUTO_UPDATE_ERROR_CATEGORIES = [
  'network',
  'signature',
  'permission',
  'lock',
  'disk',
  'parse',
  'ssl',
  'no-update',
  'unknown',
] as const satisfies readonly NonNullable<
  Extract<DiagnosticEventEntry, { kind: 'auto_update_state_change' }>['data']['errorCategory']
>[];

const makeEntry = (
  overrides: Partial<DiagnosticEventEntry> = {},
): DiagnosticEventEntry =>
  ({
    v: 1,
    kind: 'cooldown_enter',
    ts: Date.now(),
    surface: 'desktop',
    data: { scope: 'api', untilMs: 1, retryAfterProvided: false, durationMs: 30_000 },
    ...overrides,
  }) as DiagnosticEventEntry;

describe('createFsDiagnosticEventsLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-fs-ledger-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips appends through flush + readRecent in chronological order', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });

    for (let i = 0; i < 10; i++) {
      ledger.writer.append(makeEntry({ ts: 1_700_000_000_000 + i }));
    }
    await ledger.flush();

    const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
    expect(result).toHaveLength(10);
    expect(result.map((entry) => entry.ts)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1_700_000_000_000 + i),
    );
  });

  it('keeps state per instance — two factories pointing at distinct dirs do not interfere', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-fs-ledger-other-'));
    try {
      const a = createFsDiagnosticEventsLedger({ resolveDir: () => tmpDir, logger: silentLogger });
      const b = createFsDiagnosticEventsLedger({ resolveDir: () => otherDir, logger: silentLogger });

      a.writer.append(makeEntry({ ts: 1 }));
      a.writer.append(makeEntry({ ts: 2 }));
      await a.flush();

      const aResults = await a.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
      const bResults = await b.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });

      expect(aResults).toHaveLength(2);
      expect(bResults).toHaveLength(0);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('drops appends silently when resolveDir throws', async () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => {
        throw new Error('platform config not installed');
      },
      logger: { warn, debug, info: vi.fn() } as unknown as pino.Logger,
    });

    expect(() => ledger.writer.append(makeEntry())).not.toThrow();
    await ledger.flush();
    expect(debug).toHaveBeenCalled();
  });

  it('supports an async resolveDir', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: async () => tmpDir,
      logger: silentLogger,
    });

    ledger.writer.append(makeEntry({ ts: 42 }));
    await ledger.flush();

    const result = await ledger.reader.readRecent({ limit: 5, maxBytes: 1_000_000 });
    expect(result).toHaveLength(1);
    expect(result[0]?.ts).toBe(42);
  });

  it('persists auto_update_state_change events for every producer error category', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });
    setDiagnosticEventsSurface('desktop');
    setDiagnosticEventsLedgerWriter(ledger.writer);

    try {
      AUTO_UPDATE_ERROR_CATEGORIES.forEach((errorCategory, index) => {
        appendDiagnosticEvent({
          kind: 'auto_update_state_change',
          ts: 1_700_000_100_000 + index,
          data: {
            transition: 'check_failed',
            platform: 'win32',
            errorCategory,
          },
        });
      });

      await ledger.flush();

      const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
      const autoUpdateEntries = result.filter(
        (entry): entry is Extract<DiagnosticEventEntry, { kind: 'auto_update_state_change' }> =>
          entry.kind === 'auto_update_state_change',
      );

      expect(autoUpdateEntries).toHaveLength(AUTO_UPDATE_ERROR_CATEGORIES.length);
      expect(autoUpdateEntries.map((entry) => entry.data.errorCategory)).toEqual(
        AUTO_UPDATE_ERROR_CATEGORIES,
      );
    } finally {
      resetDiagnosticEventsLedgerForTests();
      await ledger.shutdown();
    }
  });

  it('persists real pre-turn worker stats payloads through appendDiagnosticEvent', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });
    const realShapeData = {
      since: 'app_start',
      appStartedAt: 1_700_000_000_000,
      spawnCount: 2,
      restartCount: 1,
      lastCrashCategory: 'sigterm',
      lastCrashAt: 1_700_000_001_000,
      averagePreTurnDurationBucket: '<500ms',
      currentlyRestarting: false,
    } as const;
    setDiagnosticEventsSurface('desktop');
    setDiagnosticEventsLedgerWriter(ledger.writer);

    try {
      appendDiagnosticEvent({
        kind: 'worker_stats_pre_turn',
        ts: 1_700_000_002_000,
        data: realShapeData,
      });

      await ledger.flush();

      const result = await ledger.reader.readRecent({ limit: 5, maxBytes: 1_000_000 });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        kind: 'worker_stats_pre_turn',
        ts: 1_700_000_002_000,
        surface: 'desktop',
        data: realShapeData,
      });
    } finally {
      resetDiagnosticEventsLedgerForTests();
      await ledger.shutdown();
    }
  });

  it('rotates the live file once it exceeds the configured maxLines', async () => {
    const livePath = path.join(tmpDir, 'diagnostic-events.jsonl');
    const oldPath = path.join(tmpDir, 'diagnostic-events.jsonl.old');
    const seedLine =
      JSON.stringify({
        v: 1,
        ts: 1,
        surface: 'desktop',
        kind: 'cooldown_exit',
        data: { scope: 'api', reason: 'expired' },
      }) + '\n';
    await fs.writeFile(livePath, seedLine.repeat(5), 'utf8');

    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
      rotation: { maxLines: 5, maxFiles: 1 },
    });

    ledger.writer.append(makeEntry({ ts: 2 }));
    await ledger.flush();

    const oldExists = await fs
      .stat(oldPath)
      .then(() => true)
      .catch(() => false);
    expect(oldExists).toBe(true);

    const liveContent = await fs.readFile(livePath, 'utf8');
    const liveLines = liveContent.split('\n').filter((line) => line.length > 0);
    expect(liveLines.length).toBe(1);

    const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[result.length - 1]?.ts).toBe(2);
  });

  it('drops appends silently when async resolveDir rejects', async () => {
    const debug = vi.fn();
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: async () => {
        throw new Error('async resolution failed');
      },
      logger: { warn: vi.fn(), debug, info: vi.fn() } as unknown as pino.Logger,
    });

    expect(() => ledger.writer.append(makeEntry())).not.toThrow();
    await ledger.flush();
    expect(debug).toHaveBeenCalled();
  });

  it('serializes concurrent flushes when resolveDir is async — single-writer invariant', async () => {
    let resolveDirCalls = 0;
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: async () => {
        resolveDirCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return tmpDir;
      },
      logger: silentLogger,
    });

    ledger.writer.append(makeEntry({ ts: 1 }));
    ledger.writer.append(makeEntry({ ts: 2 }));
    ledger.writer.append(makeEntry({ ts: 3 }));

    await Promise.all([ledger.flush(), ledger.flush(), ledger.flush()]);

    const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
    expect(result.map((entry) => entry.ts)).toEqual([1, 2, 3]);
    expect(resolveDirCalls).toBeLessThan(10);
  });

  it('reader honors maxBytes byte budget by tailing the file', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });

    for (let i = 0; i < 50; i++) {
      ledger.writer.append(makeEntry({ ts: 1_700_000_000_000 + i }));
    }
    await ledger.flush();

    const tail = await ledger.reader.readRecent({ limit: 100, maxBytes: 200 });
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(50);
  });

  it('reader returns [] when ledger directory has no files', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });
    const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
    expect(result).toEqual([]);
  });

  it('shutdown is idempotent and resetForTests clears in-memory queue', async () => {
    const ledger = createFsDiagnosticEventsLedger({
      resolveDir: () => tmpDir,
      logger: silentLogger,
    });
    ledger.writer.append(makeEntry());
    ledger.resetForTests();
    await ledger.flush();
    await expect(ledger.shutdown()).resolves.toBeUndefined();
    await expect(ledger.shutdown()).resolves.toBeUndefined();

    const result = await ledger.reader.readRecent({ limit: 50, maxBytes: 1_000_000 });
    expect(result).toEqual([]);
  });
});
