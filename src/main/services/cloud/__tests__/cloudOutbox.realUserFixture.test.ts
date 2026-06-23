import * as fs from 'fs';
import * as path from 'path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-migration-safety-fixture',
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_PATH = path.join(
  '/tmp/test-cloud-outbox-migration-safety-fixture',
  'sessions',
  'cloud-outbox.json',
);

// Synthetic snapshot pinned in the repo. Replaces a previous variant of this
// test that read the maintainer's live `~/Library/Application Support/...`
// outbox; that approach drifted as the live cloud state moved on and only ever
// ran on a single machine. The synthetic fixture is hand-built to exercise the
// migration code paths (_lastFullPutAt seeding from enqueuedAt, _cloudUpdatedAtTracker
// >50 entries, legacy 'failed'-status normalisation, permanent_failure preservation).
const FIXTURE_SOURCE = path.join(
  __dirname,
  'fixtures',
  'cloud-outbox-synthetic-snapshot.json',
);

// Synthetic UUID for the "stuck" session — high attempts, still pending, no
// _lastFullPutAt entry, no _lastPushedSeqTracker entry. Drives the migration
// safety assertions below.
const STUCK_SESSION_ID = '00000000-0000-4000-8000-000000000001';

describe('CloudOutbox migration safety against synthetic pre-migration fixture', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.copyFileSync(FIXTURE_SOURCE, OUTBOX_PATH);
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('loads the pre-migration outbox without throwing or quarantining', () => {
    expect(() => outbox.load()).not.toThrow();
    const entries = outbox.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const stuck = entries.find((e) => e.sessionId === STUCK_SESSION_ID);
    expect(stuck).toBeDefined();
    expect(stuck?.status).toBe('pending');
    // Migration-safety contract: attempts must NEVER reset/decrease across
    // migration. Fixture pins the stuck session at attempts=24.
    expect(stuck?.attempts).toBeGreaterThanOrEqual(24);
  });

  it('seeds _lastFullPutAt from enqueuedAt for the stuck session on first load', () => {
    outbox.load();
    expect(outbox.getLastFullPutAt(STUCK_SESSION_ID)).toBe(1778336192884);
  });

  it('leaves _lastPushedSeqTracker empty for sessions with no prior cursor', () => {
    outbox.load();
    expect(outbox.getLastPushedSeq(STUCK_SESSION_ID)).toBeUndefined();
    expect(outbox.getLastPushedMessageIds(STUCK_SESSION_ID)).toEqual([]);
    expect(outbox.getDeltaCount(STUCK_SESSION_ID)).toBe(0);
    expect(outbox.getOversizedEvents(STUCK_SESSION_ID)).toEqual([]);
  });

  it('round-trips: save reproduces all original keys plus new Stage-4 keys without dropping data', () => {
    outbox.load();
    outbox.flush();
    const after = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Record<string, unknown>;
    expect(after._cloudUrl).toBe('https://rebel-cloud-test.fly.dev');
    const stuck = after[STUCK_SESSION_ID] as Record<string, unknown>;
    expect(stuck).toMatchObject({
      sessionId: STUCK_SESSION_ID,
      status: 'pending',
    });
    expect(stuck.attempts as number).toBeGreaterThanOrEqual(24);
    const trackers = after._cloudUpdatedAtTracker as Record<string, number>;
    expect(Object.keys(trackers).length).toBeGreaterThan(50);
  });

  it('does not classify the stuck session as permanent_failure on load', () => {
    outbox.load();
    const stuck = outbox.getAll().find((e) => e.sessionId === STUCK_SESSION_ID);
    expect(stuck?.status).not.toBe('permanent_failure');
  });

  it('preserves permanent_failure entries from the snapshot (no silent drop)', () => {
    outbox.load();
    const permFailure = outbox.getAll().find((e) => e.status === 'permanent_failure');
    expect(permFailure).toBeDefined();
    expect(permFailure?.sessionId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('normalises legacy "failed"-status entries to "pending" on load', () => {
    outbox.load();
    const normalised = outbox.getAll().find(
      (e) => e.sessionId === '00000000-0000-4000-8000-000000000003',
    );
    expect(normalised).toBeDefined();
    expect(normalised?.status).toBe('pending');
  });
});
