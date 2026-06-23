import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';
import { StateDB } from '../state.ts';
import { fingerprintTightHash, type StackFrame } from '../triage/fingerprint.ts';
import { inFlightDedupGate } from '../triage/inFlightDedupGate.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inflight-dedup-'));
  dirs.push(dir);
  return dir;
}

function makeConfig(stateDir: string, overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'sentry-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir,
    maxConcurrent: 2,
    maxHourly: 10,
    maxDaily: 50,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
    inFlightDedupEnabled: true,
    inFlightDedupWindowHours: 6,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'SENTRY-INFLIGHT',
    sentryUrl: 'https://sentry.io/issues/SENTRY-INFLIGHT',
    title: 'In-flight dedup fixture',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 10,
    users: 4,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
    ...overrides,
  };
}

function sentryDetailResponse(frames: StackFrame[] | null): Response {
  const payload = frames
    ? {
        latestEvent: {
          entries: [
            {
              data: {
                values: [
                  {
                    stacktrace: {
                      frames,
                    },
                  },
                ],
              },
            },
          ],
        },
      }
    : { latestEvent: { entries: [] } };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seedActive(db: StateDB, sentryId: string, fingerprintHash: string): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: `Active ${sentryId}`,
    status: 'dispatched',
    fingerprint_hash: fingerprintHash,
    max_retries: 2,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('inFlightDedupGate', () => {
  const frames: StackFrame[] = [
    { filename: '/app/src/main.ts', function: 'handleError', lineno: 11 },
    { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 22 },
    { filename: '/app/src/index.ts', function: 'main', lineno: 33 },
  ];

  it('passes when disabled', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        inFlightDedupGate(makeIssue(), { config: makeConfig(dir, { inFlightDedupEnabled: false }), db }),
      ).resolves.toEqual({ decision: 'dispatch' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('fails open when no tight fingerprint is computable', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => sentryDetailResponse(null)));

      await expect(inFlightDedupGate(makeIssue(), { config: makeConfig(dir), db })).resolves.toEqual({
        decision: 'dispatch',
      });
    } finally {
      db.close();
    }
  });

  it('passes with fingerprint context when no active match exists', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => sentryDetailResponse(frames)));
      const hash = fingerprintTightHash(frames);

      await expect(inFlightDedupGate(makeIssue(), { config: makeConfig(dir), db })).resolves.toEqual({
        decision: 'dispatch',
        context: {
          fingerprint_hash: hash,
        },
      });
    } finally {
      db.close();
    }
  });

  it('defers when an active same-fingerprint row exists within the lookback window', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => sentryDetailResponse(frames)));
      const hash = fingerprintTightHash(frames);
      if (!hash) throw new Error('expected fingerprint hash for fixture frames');
      seedActive(db, 'SENTRY-ACTIVE', hash);

      await expect(inFlightDedupGate(makeIssue(), { config: makeConfig(dir), db })).resolves.toEqual({
        decision: 'defer',
        gate: 'inflight-dedup',
        reason: `inflight-dedup:fingerprint=${hash}:active=SENTRY-ACTIVE`,
        context: {
          fingerprint_hash: hash,
        },
      });
    } finally {
      db.close();
    }
  });

  it('passes when the only same-fingerprint match is outside the lookback window', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => sentryDetailResponse(frames)));
      const hash = fingerprintTightHash(frames);
      if (!hash) throw new Error('expected fingerprint hash for fixture frames');
      seedActive(db, 'SENTRY-OLD-ACTIVE', hash);
      (
        db as unknown as {
          db: {
            prepare: (sql: string) => { run: (params: Record<string, unknown>) => void };
          };
        }
      ).db
        .prepare(`UPDATE issues SET updated_at = datetime('now', '-7 hours') WHERE sentry_id = @sentry_id`)
        .run({ sentry_id: 'SENTRY-OLD-ACTIVE' });

      await expect(inFlightDedupGate(makeIssue(), { config: makeConfig(dir), db })).resolves.toEqual({
        decision: 'dispatch',
        context: {
          fingerprint_hash: hash,
        },
      });
    } finally {
      db.close();
    }
  });

  it('passes when the only active match is the same sentry issue id', async () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => sentryDetailResponse(frames)));
      const hash = fingerprintTightHash(frames);
      if (!hash) throw new Error('expected fingerprint hash for fixture frames');
      seedActive(db, 'SENTRY-INFLIGHT', hash);

      await expect(inFlightDedupGate(makeIssue(), { config: makeConfig(dir), db })).resolves.toEqual({
        decision: 'dispatch',
        context: {
          fingerprint_hash: hash,
        },
      });
    } finally {
      db.close();
    }
  });
});
