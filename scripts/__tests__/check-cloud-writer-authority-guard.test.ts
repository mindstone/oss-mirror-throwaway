import { describe, it, expect } from 'vitest';
import {
  scanSourceForRawWrites,
  partitionRawWrites,
  findCloudRawWrites,
  writerBaselineKey,
  WRITER_BASELINE,
  SCANNED_FILES,
  type RawWriteViolation,
} from '../check-cloud-writer-authority-guard';

const CLOUD_SYNC = 'src/main/services/cloud/cloudWorkspaceSync.ts';
const STAGING = 'src/main/services/cloud/cloudStagingBridge.ts';

describe('scanSourceForRawWrites — fires on raw in-place writes (non-vacuous)', () => {
  it('flags a NEW fs.writeFileSync — the REBEL-696 dual-writer shape', () => {
    const src = `
      function pull(localPath, content) {
        fs.writeFileSync(somethingNew, content, 'utf8');
      }
    `;
    const v = scanSourceForRawWrites(src, CLOUD_SYNC);
    expect(v).toHaveLength(1);
    expect(v[0].callee).toBe('writeFileSync');
    expect(v[0].firstArg).toBe('somethingNew');
  });

  it('flags a bare (destructured-import) writeFileSync', () => {
    const src = `function f(p, c) { writeFileSync(p, c, 'utf8'); }`;
    const v = scanSourceForRawWrites(src, CLOUD_SYNC);
    expect(v).toHaveLength(1);
    expect(v[0].callee).toBe('writeFileSync');
  });

  it('flags fs.writeFile / fs.appendFile / fs.promises.writeFile (property tail)', () => {
    const src = `function f(p, c) {
      fs.writeFile(a, c);
      fs.appendFile(b, c);
      fs.promises.writeFile(d, c);
    }`;
    const callees = scanSourceForRawWrites(src, STAGING).map((v) => v.callee).sort();
    expect(callees).toEqual(['appendFile', 'writeFile', 'writeFile']);
  });
});

describe('scanSourceForRawWrites — clears sanctioned forms (low FP)', () => {
  it('does NOT flag the atomic seam writeFileAtomicInTargetDirSync', () => {
    const src = `function f(p, c) { writeFileAtomicInTargetDirSync(p, c, 'utf8'); }`;
    expect(scanSourceForRawWrites(src, CLOUD_SYNC)).toEqual([]);
  });

  it('does NOT flag the async atomic seam writeFileAtomicInTargetDir', () => {
    const src = `async function f(p, c) { await writeFileAtomicInTargetDir(p, c, 'utf8'); }`;
    expect(scanSourceForRawWrites(src, STAGING)).toEqual([]);
  });

  it('respects a WRITER_AUTHORITY_OK marker (internal-state escape hatch)', () => {
    const src = `function f(p, c) {
      // WRITER_AUTHORITY_OK: Rebel-internal sync state, never an OS-owned workspace path
      fs.writeFileSync(internalStatePath, c, 'utf8');
    }`;
    expect(scanSourceForRawWrites(src, STAGING)).toEqual([]);
  });

  it('does NOT flag an unrelated method named e.g. write() on another object', () => {
    const src = `function f(stream, c) { stream.write(c); manifest.set(k, v); }`;
    expect(scanSourceForRawWrites(src, CLOUD_SYNC)).toEqual([]);
  });
});

describe('partitionRawWrites + baseline', () => {
  it('separates baselined from fresh', () => {
    const baselined: RawWriteViolation = {
      relativePath: CLOUD_SYNC,
      callee: 'writeFileSync',
      firstArg: 'this.filePath',
      line: 10,
    };
    const fresh: RawWriteViolation = {
      relativePath: CLOUD_SYNC,
      callee: 'writeFileSync',
      firstArg: 'somethingNew',
      line: 1,
    };
    const { fresh: f, baselinedKeys } = partitionRawWrites([baselined, fresh]);
    expect(f).toHaveLength(1);
    expect(f[0].firstArg).toBe('somethingNew');
    expect(baselinedKeys.has(writerBaselineKey(baselined))).toBe(true);
  });

  it('flags an EXTRA occurrence beyond the baselined count (dup not absorbed)', () => {
    // cloudWorkspaceSync.ts::writeFileSync::localPath baseline count is 1; a 2nd is fresh.
    const mk = (line: number): RawWriteViolation => ({
      relativePath: CLOUD_SYNC,
      callee: 'writeFileSync',
      firstArg: 'localPath',
      line,
    });
    const { fresh } = partitionRawWrites([mk(1), mk(2)]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].line).toBe(2);
  });
});

describe('baseline + scanned-file invariants', () => {
  it('scans exactly the two cloud→desktop delivery surfaces (narrow by design)', () => {
    expect([...SCANNED_FILES].sort()).toEqual([STAGING, CLOUD_SYNC].sort());
  });

  it('every baseline key targets a scanned file', () => {
    for (const key of WRITER_BASELINE.keys()) {
      const file = key.split('::')[0];
      expect(SCANNED_FILES, `baseline key ${key} is outside SCANNED_FILES`).toContain(file);
    }
  });
});

describe('live tree', () => {
  it('has zero FRESH raw in-place writers (all current writers baselined)', () => {
    const { fresh } = partitionRawWrites(findCloudRawWrites());
    expect(
      fresh,
      `unexpected NEW raw cloud writers: ${fresh.map(writerBaselineKey).join(', ')}`,
    ).toEqual([]);
  });

  it('baseline has no stale entries (live count matches each baselined key)', () => {
    const { staleKeys } = partitionRawWrites(findCloudRawWrites());
    expect(staleKeys, `stale baseline entries to prune: ${staleKeys.join(', ')}`).toEqual([]);
  });
});
