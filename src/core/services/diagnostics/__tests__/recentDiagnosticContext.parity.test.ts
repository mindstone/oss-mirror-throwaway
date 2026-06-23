import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';

import { createFsDiagnosticEventsLedger } from '../createFsDiagnosticEventsLedger';
import { getRecentDiagnosticContext } from '../recentDiagnosticContext';
import {
  setDiagnosticEventsLedgerReader,
  resetDiagnosticEventsLedgerForTests,
} from '@core/services/diagnosticEventsLedger';
import {
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  type DiagnosticEventEntry,
} from '../manifest';

const silentLogger = pino({ level: 'silent' });
const NOW_MS = 1_700_000_100_000;

describe('recentDiagnosticContext parity desktop vs cloud', () => {
  let desktopDir: string;
  let cloudDir: string;

  beforeEach(async () => {
    resetDiagnosticEventsLedgerForTests();
    desktopDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-desktop-ledger-'));
    cloudDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-cloud-ledger-'));
  });

  afterEach(async () => {
    resetDiagnosticEventsLedgerForTests();
    await Promise.all([
      fs.rm(desktopDir, { recursive: true, force: true }),
      fs.rm(cloudDir, { recursive: true, force: true }),
    ]);
  });

  it('returns identical context shape for identical desktop and cloud fs ledgers', async () => {
    const desktopLedger = createFsDiagnosticEventsLedger({
      resolveDir: () => desktopDir,
      logger: silentLogger,
    });
    const cloudLedger = createFsDiagnosticEventsLedger({
      resolveDir: () => cloudDir,
      logger: silentLogger,
    });
    const fixture = buildFixture();

    for (const event of fixture) {
      desktopLedger.writer.append(event);
      cloudLedger.writer.append(event);
    }
    await Promise.all([desktopLedger.flush(), cloudLedger.flush()]);

    setDiagnosticEventsLedgerReader(desktopLedger.reader);
    const desktopContext = await getRecentDiagnosticContext({
      limit: 5,
      windowHours: 24,
      nowMs: NOW_MS,
    });

    setDiagnosticEventsLedgerReader(cloudLedger.reader);
    const cloudContext = await getRecentDiagnosticContext({
      limit: 5,
      windowHours: 24,
      nowMs: NOW_MS,
    });

    expect(cloudContext).toEqual(desktopContext);
    expect(cloudContext.totalEvents).toBe(5);
    expect(cloudContext.counts).toEqual({
      abort_event: 1,
      cooldown_enter: 2,
      known_condition: 2,
    });
    expect(Object.keys(cloudContext.entriesByKind).sort()).toEqual([
      'abort_event',
      'cooldown_enter',
      'known_condition',
    ]);
  });
});

function buildFixture(): DiagnosticEventEntry[] {
  return [
    cooldownEnter(NOW_MS - 5_000),
    knownCondition(NOW_MS - 4_000),
    cooldownEnter(NOW_MS - 3_000),
    abortEvent(NOW_MS - 2_000),
    knownCondition(NOW_MS - 1_000, 'info'),
  ];
}

function cooldownEnter(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'cooldown_enter',
    data: {
      scope: 'api',
      untilMs: ts + 1_000,
      retryAfterProvided: false,
      durationMs: 1_000,
    },
  };
}

function abortEvent(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'abort_event',
    data: {
      reason: 'user_cancel',
      durationBucketMs: 1_000,
    },
  };
}

function knownCondition(
  ts: number,
  level: Extract<DiagnosticEventEntry, { kind: 'known_condition' }>['data']['level'] = 'warning',
): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'known_condition',
    data: {
      condition: 'model_error',
      level,
    },
  };
}

function baseEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'cloud' as const,
  };
}
