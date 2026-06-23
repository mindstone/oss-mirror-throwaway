import { describe, it, expect } from 'vitest';
import {
  scanSourceForFailOpen,
  partitionViolations,
  findFailOpenScopeReaders,
  baselineKey,
  FAIL_OPEN_READER_BASELINE,
  type FailOpenViolation,
} from '../check-failopen-scope-readers';

describe('scanSourceForFailOpen — fires on the 260531 bug shape (non-vacuous)', () => {
  it('flags getScopeTier() that swallows and returns a permissive scope literal', () => {
    const src = `
      async function getScopeTier(): Promise<string> {
        try {
          const data = await fs.readFile(p, 'utf8');
          return JSON.parse(data).tier;
        } catch {
          return 'full';
        }
      }
    `;
    const v = scanSourceForFailOpen(src, 'resources/mcp/x/server.ts');
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('permissive-scope-literal');
    expect(v[0].functionName).toBe('getScopeTier');
  });

  it('flags loadToken() that returns null on any error', () => {
    const src = `
      async function loadToken() {
        try { return JSON.parse(await fs.readFile(p)); }
        catch { return null; }
      }
    `;
    const v = scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts');
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('null-or-undefined');
  });

  it('flags loadAccounts() returning empty array on corrupt config', () => {
    const src = `
      class P {
        async loadAccounts() {
          try { return JSON.parse(await fs.readFile(p)).accounts; }
          catch { return []; }
        }
      }
    `;
    const v = scanSourceForFailOpen(src, 'resources/mcp/shared/tokenProvider.ts');
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('empty-array');
    expect(v[0].functionName).toBe('loadAccounts');
  });
});

describe('scanSourceForFailOpen — clears fail-closed forms (no false positives)', () => {
  it('does not flag a reader that rethrows', () => {
    const src = `
      async function loadToken() {
        try { return JSON.parse(await fs.readFile(p)); }
        catch (e) { log.error(e); throw e; }
      }
    `;
    expect(scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts')).toEqual([]);
  });

  it('does not flag a reader that discriminates ENOENT then rethrows', () => {
    const src = `
      async function loadToken() {
        try { return JSON.parse(await fs.readFile(p)); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return null;
          throw error;
        }
      }
    `;
    expect(scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts')).toEqual([]);
  });

  it('STILL flags a conditional throw + bare permissive return (throw does not clear the block)', () => {
    // cross-family review BLOCKER: `if (rare) throw e; return null;` — the bare
    // `return null` is NOT inside an ENOENT branch and must stay flagged.
    const src = `
      async function loadToken(error) {
        try { return read(); }
        catch (e) {
          if (someRareCondition) throw e;
          return null;
        }
      }
    `;
    const v = scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts');
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('null-or-undefined');
  });

  it('STILL flags a bare return null after a mere ENOENT mention (not an ENOENT branch)', () => {
    // cross-family review BLOCKER: `log('ENOENT'); return null;` — mentioning the
    // string is not discrimination; the bare return must stay flagged.
    const src = `
      async function loadToken() {
        try { return read(); }
        catch (e) {
          log.warn('ENOENT maybe?');
          return null;
        }
      }
    `;
    const v = scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts');
    expect(v).toHaveLength(1);
  });

  it('clears a reader carrying a FAIL_CLOSED_OK marker', () => {
    const src = `
      async function getScopeTier() {
        try { return readTier(); }
        catch {
          // FAIL_CLOSED_OK: 'readonly' is the least-privileged tier here
          return 'readonly';
        }
      }
    `;
    expect(scanSourceForFailOpen(src, 'resources/mcp/x/server.ts')).toEqual([]);
  });

  it('does not flag non-reader functions (name heuristic)', () => {
    const src = `
      function renderWidget() {
        try { return compute(); } catch { return null; }
      }
    `;
    expect(scanSourceForFailOpen(src, 'src/main/services/foo.ts')).toEqual([]);
  });

  it('does not flag a non-permissive return (e.g. a thrown-equivalent error object)', () => {
    const src = `
      async function loadToken() {
        try { return read(); }
        catch { return { error: 'failed' }; }
      }
    `;
    // returning a non-permissive object is out of scope (not empty/null/privilege literal)
    expect(scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts')).toEqual([]);
  });

  it('does not attribute a nested helper return to the outer reader', () => {
    const src = `
      async function loadToken() {
        try {
          const fallback = () => { return null; };
          return read();
        } catch (e) { throw e; }
      }
    `;
    expect(scanSourceForFailOpen(src, 'src/main/services/fooAuthService.ts')).toEqual([]);
  });
});

describe('partitionViolations + baseline', () => {
  it('separates baselined from fresh violations', () => {
    const baselinedSample: FailOpenViolation = {
      relativePath: 'src/main/services/githubAuthService.ts',
      functionName: 'readTokensFile',
      line: 1,
      kind: 'null-or-undefined',
      detail: 'return null',
    };
    const fresh: FailOpenViolation = {
      relativePath: 'src/main/services/newAuthService.ts',
      functionName: 'loadToken',
      line: 5,
      kind: 'null-or-undefined',
      detail: 'return null',
    };
    const { fresh: f, baselinedKeys } = partitionViolations([baselinedSample, fresh]);
    expect(f).toHaveLength(1);
    expect(f[0].relativePath).toBe('src/main/services/newAuthService.ts');
    expect(baselinedKeys.has(baselineKey(baselinedSample))).toBe(true);
  });

  it('flags an EXTRA occurrence beyond the baselined count (dup not absorbed)', () => {
    // githubAuthService::readTokensFile baseline count is 1; a 2nd is fresh.
    const mk = (line: number): FailOpenViolation => ({
      relativePath: 'src/main/services/githubAuthService.ts',
      functionName: 'readTokensFile',
      line,
      kind: 'null-or-undefined',
      detail: 'return null',
    });
    const { fresh } = partitionViolations([mk(1), mk(2)]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].line).toBe(2);
  });
});

describe('live tree', () => {
  it('has zero FRESH fail-open readers (all known sites are baselined)', () => {
    const { fresh } = partitionViolations(findFailOpenScopeReaders());
    expect(
      fresh,
      `unexpected NEW fail-open readers: ${fresh.map((v) => baselineKey(v)).join(', ')}`,
    ).toEqual([]);
  });

  it('baseline has no stale entries (live count matches each baselined key)', () => {
    const { staleKeys } = partitionViolations(findFailOpenScopeReaders());
    expect(staleKeys, `stale baseline entries to prune: ${staleKeys.join(', ')}`).toEqual([]);
  });
});
