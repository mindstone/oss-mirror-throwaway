import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHotlist, findNewestRunDir, runRecsHotlist } from '../recs-hotlist';

// All fixtures live in mkdtemp dirs — NEVER in the repo working tree.
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-hotlist-test-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function makeRunDir(name: string): string {
  const runDir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(runDir, 'data'), { recursive: true });
  return runDir;
}

function writeNdjson(runDir: string, filename: string, rows: unknown[]): void {
  fs.writeFileSync(
    path.join(runDir, 'data', filename),
    rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n',
    'utf8',
  );
}

const FP_A = 'a1b2c3d4e5f60718';
const FP_B = '00ff00ff00ff00ff';

describe('findNewestRunDir', () => {
  it('returns null for a missing root', () => {
    expect(findNewestRunDir(path.join(tmpRoot, 'does-not-exist'))).toBeNull();
  });

  it('returns null when no dir matches the run pattern', () => {
    fs.mkdirSync(path.join(tmpRoot, 'random-folder'));
    expect(findNewestRunDir(tmpRoot)).toBeNull();
  });

  it('picks the newest run by name-sort and ignores non-matching entries', () => {
    makeRunDir('260601_0900_chief_pathologist_30d');
    makeRunDir('260610_2214_chief_pathologist_7d');
    fs.mkdirSync(path.join(tmpRoot, 'not-a-run'));
    // A matching FILE (not dir) must be ignored.
    fs.writeFileSync(path.join(tmpRoot, '260611_0000_chief_pathologist_x'), '', 'utf8');
    expect(findNewestRunDir(tmpRoot)).toBe(
      path.join(tmpRoot, '260610_2214_chief_pathologist_7d'),
    );
  });
});

describe('buildHotlist', () => {
  it('aggregates fingerprints across bugs with ids, dates and counts, sorted by demand', () => {
    const runDir = makeRunDir('260610_2214_chief_pathologist_7d');
    writeNdjson(runDir, 'augmentations.ndjson', [
      { bug_id: '260601_first_bug', prior_recommendation_fingerprints: [FP_A] },
      { bug_id: '260605_second_bug', prior_recommendation_fingerprints: [FP_A, FP_B] },
      { bug_id: '260607_no_field_bug' },
      { bug_id: '260608_null_field_bug', prior_recommendation_fingerprints: null },
    ]);

    const hotlist = buildHotlist(runDir);

    expect(hotlist).toEqual([
      {
        fingerprint: FP_A,
        n_bugs: 2,
        bugs: [
          { bug_id: '260601_first_bug', date: '2026-06-01' },
          { bug_id: '260605_second_bug', date: '2026-06-05' },
        ],
      },
      {
        fingerprint: FP_B,
        n_bugs: 1,
        bugs: [{ bug_id: '260605_second_bug', date: '2026-06-05' }],
      },
    ]);
  });

  it('filters malformed fingerprints and skips malformed ndjson lines', () => {
    const runDir = makeRunDir('260610_2214_chief_pathologist_7d');
    writeNdjson(runDir, 'augmentations.ndjson', [
      {
        bug_id: '260601_bug',
        prior_recommendation_fingerprints: ['JUNK', FP_A, 'abc', 42],
      },
      'this is not json {{{',
    ]);

    const hotlist = buildHotlist(runDir);

    expect(hotlist).toHaveLength(1);
    expect(hotlist[0].fingerprint).toBe(FP_A);
  });

  it('backstops from qa13 implicated_fingerprints when augment rows are missing', () => {
    const runDir = makeRunDir('260610_2214_chief_pathologist_7d');
    writeNdjson(runDir, 'qa13_prior_recommendations.ndjson', [
      { bucket: 'prior_rec_not_implemented', n_bugs: 1, implicated_fingerprints: [FP_B] },
      { bucket: 'no_prior_recommendation', n_bugs: 3, implicated_fingerprints: [] },
    ]);

    const hotlist = buildHotlist(runDir);

    expect(hotlist).toEqual([{ fingerprint: FP_B, n_bugs: 0, bugs: [] }]);
  });

  it('returns an empty list when the data files are absent', () => {
    const runDir = makeRunDir('260610_2214_chief_pathologist_7d');
    expect(buildHotlist(runDir)).toEqual([]);
  });
});

describe('runRecsHotlist (end to end, degrade behaviors)', () => {
  it('missing reports root: empty hot-list, clear message, output still written', () => {
    const outPath = path.join(tmpRoot, 'out', 'hotlist.json');
    const payload = runRecsHotlist({
      reportsRoot: path.join(tmpRoot, 'missing-root'),
      outPath,
    });

    expect(payload.hotlist).toEqual([]);
    expect(payload.run_dir).toBeNull();
    expect(payload.message).toContain('No pathologist run dirs found');
    const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(onDisk.n_fingerprints).toBe(0);
  });

  it('run without fingerprint data: empty hot-list with forward-only explanation', () => {
    const runDir = makeRunDir('260610_2214_chief_pathologist_7d');
    writeNdjson(runDir, 'augmentations.ndjson', [{ bug_id: '260601_old_style_bug' }]);
    const outPath = path.join(tmpRoot, 'hotlist.json');

    const payload = runRecsHotlist({ reportsRoot: tmpRoot, outPath });

    expect(payload.hotlist).toEqual([]);
    expect(payload.run_dir).toBe('260610_2214_chief_pathologist_7d');
    expect(payload.message).toContain('forward-only');
  });

  it('happy path: reads the NEWEST run and writes the aggregated payload', () => {
    const oldRun = makeRunDir('260601_0900_chief_pathologist_30d');
    writeNdjson(oldRun, 'augmentations.ndjson', [
      { bug_id: '260530_stale_bug', prior_recommendation_fingerprints: [FP_B] },
    ]);
    const newRun = makeRunDir('260610_2214_chief_pathologist_7d');
    writeNdjson(newRun, 'augmentations.ndjson', [
      { bug_id: '260609_fresh_bug', prior_recommendation_fingerprints: [FP_A] },
    ]);
    const outPath = path.join(tmpRoot, 'hotlist.json');

    const payload = runRecsHotlist({ reportsRoot: tmpRoot, outPath });

    expect(payload.run_dir).toBe('260610_2214_chief_pathologist_7d');
    expect(payload.n_fingerprints).toBe(1);
    expect(payload.hotlist[0].fingerprint).toBe(FP_A);
    const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(onDisk.hotlist).toEqual(payload.hotlist);
  });
});
