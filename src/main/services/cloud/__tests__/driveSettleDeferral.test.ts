import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRIVE_SETTLE_MAX_AGE_MS,
  DRIVE_SETTLE_MAX_DEFERRALS,
  _resetDriveSettleDeferralsForTesting,
  evaluateDriveSettleDeferral,
  getActiveDriveSettleDeferrals,
} from '../driveSettleDeferral';

const CORE_DIR = '/tmp/test-drive-settle/workspace';
const REL_PATH = 'sources/2026/05-May/18/meeting.md';
const LOCAL_PATH = path.join(CORE_DIR, REL_PATH);

function cleanup(): void {
  try {
    fs.rmSync('/tmp/test-drive-settle', { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

describe('driveSettleDeferral', () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(CORE_DIR, { recursive: true });
    _resetDriveSettleDeferralsForTesting();
  });

  afterEach(() => {
    _resetDriveSettleDeferralsForTesting();
    cleanup();
  });

  it('defers for first five cycles and force-pulls on the sixth', () => {
    const now = 1_000_000;
    for (let cycle = 1; cycle <= DRIVE_SETTLE_MAX_DEFERRALS; cycle += 1) {
      const result = evaluateDriveSettleDeferral({
        coreDirectory: CORE_DIR,
        relativePath: REL_PATH,
        localPath: LOCAL_PATH,
        nowMs: now + cycle,
      });
      expect(result.action).toBe('defer');
      expect(result.deferralCount).toBe(cycle);
    }

    const forced = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: now + DRIVE_SETTLE_MAX_DEFERRALS + 1,
    });
    expect(forced.action).toBe('force_pull');
    expect(forced.deferralCount).toBe(DRIVE_SETTLE_MAX_DEFERRALS + 1);
  });

  it('force-pulls once deferral age reaches 15 minutes', () => {
    const start = 5_000_000;
    const first = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: start,
    });
    expect(first.action).toBe('defer');
    expect(first.deferralCount).toBe(1);

    const timeout = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: start + DRIVE_SETTLE_MAX_AGE_MS,
    });
    expect(timeout.action).toBe('force_pull');
    expect(timeout.ageMs).toBeGreaterThanOrEqual(DRIVE_SETTLE_MAX_AGE_MS);
  });

  it('marks delivered and clears deferral state when Drive creates the file', () => {
    const start = 9_000_000;
    const deferred = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: start,
    });
    expect(deferred.action).toBe('defer');

    fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_PATH, 'delivered', 'utf8');

    const delivered = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: start + 10_000,
    });
    expect(delivered.action).toBe('delivered');
    expect(delivered.deferralCount).toBe(1);

    fs.rmSync(LOCAL_PATH, { force: true });
    const reset = evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: REL_PATH,
      localPath: LOCAL_PATH,
      nowMs: start + 20_000,
    });
    expect(reset.action).toBe('defer');
    expect(reset.deferralCount).toBe(1);
  });

  it('returns active deferrals scoped to one workspace', () => {
    const otherWorkspace = '/tmp/test-drive-settle/other-workspace';
    const now = 13_000_000;

    evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: 'sources/2026/05-May/18/a.md',
      localPath: path.join(CORE_DIR, 'sources/2026/05-May/18/a.md'),
      nowMs: now,
    });
    evaluateDriveSettleDeferral({
      coreDirectory: CORE_DIR,
      relativePath: 'sources/2026/05-May/18/b.md',
      localPath: path.join(CORE_DIR, 'sources/2026/05-May/18/b.md'),
      nowMs: now + 5_000,
    });
    evaluateDriveSettleDeferral({
      coreDirectory: otherWorkspace,
      relativePath: 'sources/2026/05-May/18/c.md',
      localPath: path.join(otherWorkspace, 'sources/2026/05-May/18/c.md'),
      nowMs: now + 10_000,
    });

    const active = getActiveDriveSettleDeferrals(CORE_DIR, now + 60_000);
    const normalizeExpected = (relativePath: string): string => (
      process.platform === 'darwin' || process.platform === 'win32'
        ? relativePath.toLowerCase()
        : relativePath
    );
    expect(active).toHaveLength(2);
    expect(active.map(entry => entry.relativePath)).toEqual([
      normalizeExpected('sources/2026/05-May/18/a.md'),
      normalizeExpected('sources/2026/05-May/18/b.md'),
    ]);
    expect(active[0].ageMs).toBe(60_000);
    expect(active[0].deferralCount).toBe(1);
    expect(active[1].ageMs).toBe(55_000);
    expect(active[1].deferralCount).toBe(1);
  });
});
