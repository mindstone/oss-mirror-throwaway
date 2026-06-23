import { describe, it, expect } from 'vitest';
import {
  findReadlinkViolations,
  GUARDED_FILES,
  FORBIDDEN_SYNC_PRIMITIVES,
  FORBIDDEN_ASYNC_METHODS,
} from '../check-cloud-readlink-only';

describe('check-cloud-readlink-only (RS-F5 readlink-only gate)', () => {
  it('catches a planted realpathSync call', () => {
    const src = [
      "import { realpathSync } from 'node:fs';",
      'function classify(p: string) {',
      '  return realpathSync(p);',
      '}',
    ].join('\n');
    const violations = findReadlinkViolations(src, 'src/core/utils/readlinkChain.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].symbol).toBe('realpathSync');
    expect(violations[0].line).toBe(3);
  });

  it('catches a planted statSync call', () => {
    const src = 'const s = statSync(target);';
    const violations = findReadlinkViolations(src, 'src/core/services/cloudSpaceContainment.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].symbol).toBe('statSync');
  });

  it('catches a planted async fs.stat / fs.realpath call (qualified + awaited)', () => {
    const src = [
      'const a = await fs.stat(p);',
      'const b = await fsp.realpath(p);',
      'const c = await fs.readdir(dir);',
    ].join('\n');
    const violations = findReadlinkViolations(src, 'src/core/services/cloudSpaceContainment.ts');
    const symbols = violations.map((v) => v.symbol).sort();
    expect(symbols).toEqual(['fs.readdir', 'fs.realpath', 'fs.stat']);
  });

  it('ALLOWS readlinkSync (the safe primitive)', () => {
    const src = [
      "import { readlinkSync } from 'node:fs';",
      'const t = readlinkSync(linkPath);',
    ].join('\n');
    expect(findReadlinkViolations(src, 'src/core/utils/readlinkChain.ts')).toHaveLength(0);
  });

  it('ALLOWS existsSync (does not park on a dead mount)', () => {
    const src = 'if (existsSync(workerPath)) return workerPath;';
    expect(findReadlinkViolations(src, 'src/core/services/cloudLivenessProbe.types.ts')).toHaveLength(0);
  });

  it('does NOT flag references inside comments', () => {
    const src = [
      '// the verdict-cache uses fs.realpath of an entry under a cloud symlink',
      '/* startup `fs.realpath` ENOENT or realpathSync(p) historically */',
      'const x = 1;',
    ].join('\n');
    expect(findReadlinkViolations(src, 'src/core/services/cloudSpaceContainment.ts')).toHaveLength(0);
  });

  it('does NOT flag the import line itself', () => {
    const src = "import { realpathSync, statSync } from 'node:fs';";
    expect(findReadlinkViolations(src, 'src/core/utils/readlinkChain.ts')).toHaveLength(0);
  });

  it('does NOT flag an identifier that merely ends in a primitive name', () => {
    const src = 'const myStatSync = makeStatSync(); customRealpathSyncHelper(p);';
    // `myStatSync`/`customRealpathSyncHelper` have a preceding word char before the
    // guarded suffix, so the (?<!\\w) lookbehind excludes them.
    expect(findReadlinkViolations(src, 'src/core/utils/readlinkChain.ts')).toHaveLength(0);
  });

  it('the live guarded files are clean (no dereferencing fs calls)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '..', '..');
    for (const rel of GUARDED_FILES) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `guarded file should exist: ${rel}`).toBe(true);
      const src = fs.readFileSync(abs, 'utf8');
      expect(findReadlinkViolations(src, rel), `${rel} must be readlink-only`).toHaveLength(0);
    }
  });

  it('guards the dereferencing primitives but not readlinkSync/existsSync', () => {
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).toContain('realpathSync');
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).toContain('statSync');
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).not.toContain('readlinkSync');
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).not.toContain('existsSync');
    expect([...FORBIDDEN_ASYNC_METHODS]).toContain('realpath');
    expect([...FORBIDDEN_ASYNC_METHODS]).not.toContain('readlink');
  });
});
