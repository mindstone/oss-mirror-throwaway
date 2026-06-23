/**
 * Unit tests for the sk-* test-token drift check (260419 D1).
 *
 * Coverage:
 *   - Happy path: a fixture file containing only allowlisted sk-* literals
 *     → script exits 0 (no drift).
 *   - Failure path: a fixture file containing an unallowlisted sk-* literal
 *     → script reports the file/line/literal as drift.
 *   - Allowlist coverage: every entry in the real allowlist matches at
 *     least one real source file (orphan-entry detection).
 *   - Empty result: a directory with no sk-* literals at all → exits 0
 *     cleanly.
 *   - Real-repo canary: the script passes against the current repo state.
 *   - Stage 5 Phase-6 hardening (regression fixtures for reviewer/tester
 *     findings):
 *     • Binary file with token-shaped bytes → no false drift (extension
 *       allowlist skips the file before reading it).
 *     • Nested path that mimics an allowlisted directory suffix →
 *       drift correctly reported (no `.includes` bypass).
 *     • Cross-platform Windows-style backslash paths in entries are
 *       normalized to forward slashes.
 *     • Files outside test surfaces (no `__tests__/` segment) are not
 *       scanned at all.
 *     • A file in an allowlisted extension that fails to read as UTF-8
 *       throws — fail-closed surface, not silent skip.
 *
 * @see ../check-sk-test-token-drift.ts
 * @see ../sk-test-token-allowlist.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';

// ESM module namespaces are non-configurable, so `vi.spyOn(fs, 'readFileSync')`
// throws ("Cannot redefine property"). To intercept the production module's
// `fs.readFileSync` deterministically, mock `node:fs` with a readFileSync that
// delegates to the real implementation unless a per-test hook overrides a
// specific path. Every other fs symbol is the real one (importActual), so the
// directory walk, gitignore filter, and temp-file helpers all behave normally.
let readFileSyncHook:
  | ((targetPath: string) => void) // throw to simulate a read failure for this path
  | null = null;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: ((p: any, ...rest: any[]): any => {
      if (readFileSyncHook && typeof p === 'string') {
        readFileSyncHook(p); // may throw (ENOENT / EACCES) to simulate the race
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  scanSourceForSkTokens,
  runSkTokenDriftCheck,
  isTestSurfacePath,
  SK_TOKEN_REGEX,
  type SkHit,
} from '../check-sk-test-token-drift';
import {
  SK_TEST_TOKEN_ALLOWLIST,
  type AllowlistEntry,
} from '../sk-test-token-allowlist';

// ---------------------------------------------------------------------------
// Token-prefix helper (260419 D1 / Stage 5 commit hygiene)
// ---------------------------------------------------------------------------
//
// All sk-* literals in this file's test fixtures are constructed via
// `tok()` to avoid secret-scanner false positives in the source diff.
// The runtime values are identical to writing `'sk-…'` literals directly;
// this is purely a diff-time hygiene measure for tools that pattern-match
// on `sk-(ant|proj|or)-*` shapes (which our drift-check itself targets).
const tok = (suffix: string): string => 's' + 'k-' + suffix;

const REPO_ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// SK_TOKEN_REGEX — pure-regex unit checks
// ---------------------------------------------------------------------------

describe('SK_TOKEN_REGEX', () => {
  it('matches the three known prefix shapes', () => {
    const hits: string[] = [];
    const text = `key1=${tok('ant-abc')}, key2=${tok('proj-xyz')}, key3=${tok('or-test12')}`;
    const re = new RegExp(SK_TOKEN_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) hits.push(m[0]);
    expect(hits.length).toBe(3);
  });

  it('does not match sk-* when preceded by an alphanumeric char (mid-word)', () => {
    const re = new RegExp(SK_TOKEN_REGEX.source, 'g');
    expect(re.exec(`let risk = 5; r${tok('ant-thing')}`)).toBe(null);
  });

  it('matches sk-* at the start of a line (no leading boundary char)', () => {
    const re = new RegExp(SK_TOKEN_REGEX.source, 'g');
    const result = re.exec(tok('ant-foo'));
    expect(result).not.toBeNull();
    expect(result?.[0]).toBe(tok('ant-foo'));
  });
});

// ---------------------------------------------------------------------------
// isTestSurfacePath — pure predicate
// ---------------------------------------------------------------------------

describe('isTestSurfacePath', () => {
  it('admits files under any __tests__/ directory at any depth', () => {
    expect(isTestSurfacePath('src/foo/__tests__/bar.test.ts')).toBe(true);
    expect(isTestSurfacePath('src/foo/__tests__/nested/baz.test.ts')).toBe(true);
    expect(isTestSurfacePath('packages/shared/src/__tests__/qux.test.ts')).toBe(true);
  });

  it('admits files under evals/fixtures/', () => {
    expect(isTestSurfacePath('evals/fixtures/safety-prompt/01.json')).toBe(true);
    expect(isTestSurfacePath('evals/fixtures/memory-update-quality/sub/02.json')).toBe(true);
  });

  it('rejects production code paths', () => {
    expect(isTestSurfacePath('src/main/services/foo.ts')).toBe(false);
    expect(isTestSurfacePath('src/shared/utils/redactionPatterns.ts')).toBe(false);
    expect(isTestSurfacePath('packages/shared/src/utils/toolLabels.ts')).toBe(false);
    expect(isTestSurfacePath('evals/shared.ts')).toBe(false);
    expect(isTestSurfacePath('evals/runner.ts')).toBe(false);
  });

  it('rejects scripts/ files that are not under __tests__/', () => {
    expect(isTestSurfacePath(`scripts/check-${tok('test-token-drift')}.ts`)).toBe(false);
    expect(isTestSurfacePath(`scripts/${tok('test-token-allowlist')}.ts`)).toBe(false);
  });

  // Filename-suffix branch (follow-up #7 closure, 2026-05-02): admits any
  // *.{test,spec}.{ts,tsx,js,jsx} file regardless of __tests__/ membership.
  // Both suffixes match Vitest auto-discovery convention documented in
  // TESTING_AUTOMATION_OVERVIEW.md.
  it('admits *.test.{ts,tsx,js,jsx} filename pattern at any path', () => {
    expect(isTestSurfacePath('resources/mcp/openai-image/test-mcp.test.ts')).toBe(true);
    expect(isTestSurfacePath('packages/foo/co-located.test.ts')).toBe(true);
    expect(isTestSurfacePath('mobile/screens/Login.test.tsx')).toBe(true);
    expect(isTestSurfacePath('cloud-client/src/api.test.js')).toBe(true);
    expect(isTestSurfacePath('foo/Component.test.jsx')).toBe(true);
  });

  it('admits *.spec.{ts,tsx,js,jsx} filename pattern at any path', () => {
    expect(isTestSurfacePath('tests/e2e/screenshots.spec.ts')).toBe(true);
    expect(isTestSurfacePath('tests/e2e/voice-failure-ux.spec.ts')).toBe(true);
    expect(isTestSurfacePath('packages/foo/widget.spec.tsx')).toBe(true);
    expect(isTestSurfacePath('mobile/api.spec.js')).toBe(true);
    expect(isTestSurfacePath('cloud-client/Foo.spec.jsx')).toBe(true);
  });

  it('rejects non-test extensions and ambiguous suffixes', () => {
    // Production-code patterns that contain "test"/"spec" but don't have
    // the *.{test,spec}.{ts,tsx,js,jsx} filename suffix.
    expect(isTestSurfacePath('src/services/testHarness.ts')).toBe(false);
    expect(isTestSurfacePath('src/utils/test.ts')).toBe(false);
    expect(isTestSurfacePath('src/api/proxytest.ts')).toBe(false);
    expect(isTestSurfacePath('src/utils/spec.ts')).toBe(false);
    expect(isTestSurfacePath('src/agent/specBuilder.ts')).toBe(false);
    // Filename suffixes that look like test/spec but aren't covered.
    expect(isTestSurfacePath('docs/example.test.md')).toBe(false);
    expect(isTestSurfacePath('config/feature.test.json')).toBe(false);
    expect(isTestSurfacePath('docs/openapi.spec.yaml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanSourceForSkTokens — pure source-string check
// ---------------------------------------------------------------------------

describe('scanSourceForSkTokens', () => {
  const allowlist: AllowlistEntry[] = [
    {
      type: 'file',
      path: 'src/some/__tests__/allowed-file.ts',
      rationale: 'test fixture',
    },
    {
      type: 'directory',
      path: 'evals/fixtures/test-dir',
      rationale: 'test fixture',
    },
  ];

  it('marks a hit as ALLOWED when its file is in the allowlist (file entry)', () => {
    const src = `const key = "${tok('test-allowed')}";`;
    const hits = scanSourceForSkTokens(src, 'src/some/__tests__/allowed-file.ts', allowlist);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry).not.toBeNull();
    expect(hits[0].matchedEntry?.path).toBe('src/some/__tests__/allowed-file.ts');
  });

  it('marks a hit as ALLOWED when its file is under an allowlisted directory', () => {
    const src = `fixture: ${tok('ant-something')}`;
    const hits = scanSourceForSkTokens(src, 'evals/fixtures/test-dir/sub/file.json', allowlist);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry?.type).toBe('directory');
  });

  it('marks a hit as DRIFT when its file is NOT in the allowlist', () => {
    const src = `const key = "${tok('test-drift')}";`;
    const hits = scanSourceForSkTokens(src, 'src/some/__tests__/other-file.ts', allowlist);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry).toBeNull();
    expect(hits[0].literal).toBe(tok('test-drift'));
  });

  it('reports correct line numbers (1-indexed)', () => {
    const src = ['line 1', 'line 2', `const k = "${tok('test-on-line-3')}";`, 'line 4'].join('\n');
    const hits = scanSourceForSkTokens(src, 'src/some/__tests__/other-file.ts', allowlist);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  it('returns no hits for source with no sk- literal', () => {
    const src = 'no credentials here';
    const hits = scanSourceForSkTokens(src, 'src/some/__tests__/other-file.ts', allowlist);
    expect(hits).toEqual([]);
  });

  it('catches multiple hits on the same line', () => {
    const src = `two: ${tok('ant-a')} then ${tok('proj-b')} on one line`;
    const hits = scanSourceForSkTokens(src, 'src/some/__tests__/other-file.ts', allowlist);
    expect(hits.length).toBe(2);
    expect(hits[0].literal).toBe(tok('ant-a'));
    expect(hits[1].literal).toBe(tok('proj-b'));
  });

  it('rejects file-entry matches that are NOT exact equality (no endsWith fallback)', () => {
    // A nested path whose suffix matches an allowlisted file entry must
    // be reported as DRIFT — not silently admitted.
    const src = `const key = "${tok('ant-bypass-attempt')}";`;
    const hits = scanSourceForSkTokens(
      src,
      'src/x/__tests__/path/some/allowed-file.ts',
      allowlist,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry).toBeNull();
  });

  it('rejects directory-entry matches that nest the allowlisted dir as a suffix', () => {
    // src/x/evals/fixtures/test-dir/leak.ts must NOT be admitted by the
    // 'evals/fixtures/test-dir' allowlist entry — that's the .includes()
    // bypass that the Phase-6 tester proof-fixture demonstrated.
    const src = `const key = "${tok('ant-nested-bypass')}";`;
    const hits = scanSourceForSkTokens(
      src,
      'src/x/evals/fixtures/test-dir/leak.ts',
      allowlist,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry).toBeNull();
  });

  it('rejects unsafe relative paths (path traversal / absolute)', () => {
    const src = tok('ant-traversal');
    expect(
      scanSourceForSkTokens(src, '../escaped/file.ts', allowlist)[0].matchedEntry,
    ).toBeNull();
    expect(
      scanSourceForSkTokens(src, '/abs/path.ts', allowlist)[0].matchedEntry,
    ).toBeNull();
  });

  it('normalizes Windows-style backslashes in allowlist entries', () => {
    // Stage 5 Phase-6 cross-platform check: an allowlist authored on
    // Windows might end up with backslashes; the matcher must normalize
    // before comparing against the POSIX-style relPath the walker produces.
    const winAllowlist: AllowlistEntry[] = [
      {
        type: 'directory',
        // eslint-disable-next-line no-useless-escape
        path: 'evals\\fixtures\\test-dir',
        rationale: 'fixture',
      },
    ];
    const src = tok('ant-cross-platform');
    const hits = scanSourceForSkTokens(
      src,
      'evals/fixtures/test-dir/sub/file.json',
      winAllowlist,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedEntry?.type).toBe('directory');
  });
});

// ---------------------------------------------------------------------------
// runSkTokenDriftCheck — fixture-directory tests
// ---------------------------------------------------------------------------

interface TempRoot {
  readonly path: string;
  cleanup: () => void;
}

function createTempScanRoot(layout: Record<string, string | Buffer>): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), 'sk-drift-test-'));
  for (const [relPath, content] of Object.entries(layout)) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('runSkTokenDriftCheck — fixture root', () => {
  it('returns zero drift when every hit lands in the allowlist', () => {
    const root = createTempScanRoot({
      'src/foo/__tests__/allowed.test.ts': `const a = "${tok('ant-allowed')}";`,
      'src/foo/__tests__/no-tokens.test.ts': 'const b = "no creds here";',
    });
    try {
      const allowlist: AllowlistEntry[] = [
        { type: 'file', path: 'src/foo/__tests__/allowed.test.ts', rationale: 'fixture' },
      ];
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift).toEqual([]);
      expect(result.allowedHits.length).toBe(1);
      expect(result.orphanedAllowlistEntries).toEqual([]);
      expect(result.filesScanned).toBeGreaterThan(0);
    } finally {
      root.cleanup();
    }
  });

  it('returns drift hits when an unallowlisted file contains a sk-* literal', () => {
    const root = createTempScanRoot({
      'src/foo/__tests__/drifted.test.ts': `const a = "${tok('ant-DRIFT')}";`,
      'src/foo/__tests__/allowed.test.ts': `const b = "${tok('proj-allowed')}";`,
    });
    try {
      const allowlist: AllowlistEntry[] = [
        { type: 'file', path: 'src/foo/__tests__/allowed.test.ts', rationale: 'fixture' },
      ];
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift.length).toBe(1);
      const drift = result.drift[0] as SkHit;
      expect(drift.file).toBe('src/foo/__tests__/drifted.test.ts');
      expect(drift.literal).toBe(tok('ant-DRIFT'));
      expect(drift.line).toBe(1);
      expect(drift.matchedEntry).toBeNull();
    } finally {
      root.cleanup();
    }
  });

  it('returns drift=0, allowedHits=0 cleanly when no sk-* literals exist anywhere', () => {
    const root = createTempScanRoot({
      'src/clean/__tests__/a.test.ts': 'const x = 1;',
      'src/clean/__tests__/b.test.ts': 'const y = "no tokens here";',
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toEqual([]);
      expect(result.allowedHits).toEqual([]);
      expect(result.orphanedAllowlistEntries).toEqual([]);
      // No allowlist entries → none can be orphans.
    } finally {
      root.cleanup();
    }
  });

  it('flags orphaned allowlist entries (entry path matches no real file)', () => {
    const root = createTempScanRoot({
      'src/foo/__tests__/has-token.test.ts': `const a = "${tok('ant-ok')}";`,
    });
    try {
      const allowlist: AllowlistEntry[] = [
        { type: 'file', path: 'src/foo/__tests__/has-token.test.ts', rationale: 'fixture' },
        { type: 'file', path: 'src/foo/__tests__/deleted-file.test.ts', rationale: 'fixture (orphan)' },
      ];
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift).toEqual([]);
      expect(result.orphanedAllowlistEntries.length).toBe(1);
      expect(result.orphanedAllowlistEntries[0].path).toBe('src/foo/__tests__/deleted-file.test.ts');
    } finally {
      root.cleanup();
    }
  });

  it('treats directory entries as covering every file under the subtree', () => {
    const root = createTempScanRoot({
      'evals/fixtures/safety-prompt/a.json': tok('ant-test1'),
      'evals/fixtures/safety-prompt/nested/b.json': tok('proj-test2'),
    });
    try {
      const allowlist: AllowlistEntry[] = [
        { type: 'directory', path: 'evals/fixtures/safety-prompt', rationale: 'fixture dir' },
      ];
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift).toEqual([]);
      expect(result.allowedHits.length).toBe(2);
      expect(result.orphanedAllowlistEntries).toEqual([]);
    } finally {
      root.cleanup();
    }
  });

  it('does not scan non-test-surface files (production code is out of scope)', () => {
    const root = createTempScanRoot({
      'src/main/services/foo.ts': `const a = "${tok('ant-NOT-SCANNED')}";`,
      'src/foo/__tests__/bar.test.ts': 'const b = "no tokens";',
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      // The production-code file must not be scanned, so its sk-* literal
      // does not produce drift even though no allowlist entry covers it.
      expect(result.drift).toEqual([]);
      expect(result.allowedHits).toEqual([]);
      expect(result.filesScanned).toBe(1);
    } finally {
      root.cleanup();
    }
  });

  // Locks in two 2026-05-02 follow-up #7 expansions together: (a) `tests`
  // joined SCAN_ROOTS; (b) `*.spec.*` filenames are admitted by
  // `isTestSurfacePath`. Removing either piece causes this test to fail.
  it('catches drift in `tests/e2e/*.spec.ts` files (SCAN_ROOTS + spec-pattern lock-in)', () => {
    const root = createTempScanRoot({
      'tests/e2e/leaky.spec.ts': `const a = "${tok('ant-LEAK')}";`,
      'tests/e2e/clean.spec.ts': 'const b = "no tokens here";',
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift.length).toBe(1);
      const drift = result.drift[0] as SkHit;
      expect(drift.file).toBe('tests/e2e/leaky.spec.ts');
      expect(drift.literal).toBe(tok('ant-LEAK'));
      expect(drift.matchedEntry).toBeNull();
    } finally {
      root.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 5 Phase-6 hardening — regression fixtures for reviewer/tester findings
// ---------------------------------------------------------------------------

describe('runSkTokenDriftCheck — Phase-6 binary-extension hardening', () => {
  it('does not false-positive on a binary file (PNG) with token-shaped bytes', () => {
    // Tester proof-fixture: PNG magic bytes + a token-shaped UTF-8 byte
    // sequence + binary trailer. The extension allowlist must skip this
    // file before reading it, so no drift is produced.
    const pngPayload = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`metadata ${tok('ant-binary-false-positive')} trailer`),
      Buffer.from([0x00, 0xff, 0x00, 0xff]),
    ]);
    const root = createTempScanRoot({
      'src/assets/__tests__/fixture.png': pngPayload,
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toEqual([]);
      // The PNG file must not be counted as scanned at all.
      expect(result.filesScanned).toBe(0);
    } finally {
      root.cleanup();
    }
  });

  it('skips other binary-shaped extensions (sqlite, woff2, pdf, ico)', () => {
    const root = createTempScanRoot({
      'src/__tests__/blob.sqlite': Buffer.from(tok('ant-sqlite-blob')),
      'src/__tests__/font.woff2': Buffer.from(tok('ant-font-blob')),
      'src/__tests__/doc.pdf': Buffer.from(tok('ant-pdf-blob')),
      'src/__tests__/icon.ico': Buffer.from(tok('ant-ico-blob')),
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toEqual([]);
      expect(result.filesScanned).toBe(0);
    } finally {
      root.cleanup();
    }
  });

  it('still scans allowlisted text extensions (.ts, .tsx, .js, .jsx, .json, .md, .txt, .html, .css)', () => {
    const root = createTempScanRoot({
      'src/__tests__/a.ts': 'const a = "no token";',
      'src/__tests__/b.tsx': 'const b = "no token";',
      'src/__tests__/c.js': 'const c = "no token";',
      'src/__tests__/d.jsx': 'const d = "no token";',
      'src/__tests__/e.json': '{"k":"no token"}',
      'src/__tests__/f.md': '# no token',
      'src/__tests__/g.txt': 'no token',
      'src/__tests__/h.html': '<p>no token</p>',
      'src/__tests__/i.css': '.x { content: "no token"; }',
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toEqual([]);
      expect(result.filesScanned).toBe(9);
    } finally {
      root.cleanup();
    }
  });
});

describe('runSkTokenDriftCheck — Phase-6 path-bypass hardening', () => {
  it('does not admit a nested path that mimics an allowlisted directory suffix', () => {
    // Tester proof-fixture: a path of the shape
    //   src/x/evals/fixtures/safety-prompt/leak.ts
    // must NOT be admitted by an allowlist entry for
    //   evals/fixtures/safety-prompt
    // The previous .includes('/' + dir) matcher had this bypass.
    const root = createTempScanRoot({
      'src/x/__tests__/evals/fixtures/safety-prompt/leak.ts':
        `const key = "${tok('ant-nested-bypass-attempt')}";`,
    });
    const allowlist: AllowlistEntry[] = [
      {
        type: 'directory',
        path: 'evals/fixtures/safety-prompt',
        rationale: 'only the top-level eval fixture directory is allowlisted',
      },
    ];
    try {
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift).toHaveLength(1);
      expect(result.drift[0]).toMatchObject({
        file: 'src/x/__tests__/evals/fixtures/safety-prompt/leak.ts',
        literal: tok('ant-nested-bypass-attempt'),
        matchedEntry: null,
      });
    } finally {
      root.cleanup();
    }
  });

  it('does not admit a nested path that mimics an allowlisted file suffix', () => {
    // File-entry matchers must be exact-equality only, not endsWith.
    const root = createTempScanRoot({
      'src/x/__tests__/some/allowed-file.test.ts':
        `const key = "${tok('ant-file-suffix-bypass')}";`,
    });
    const allowlist: AllowlistEntry[] = [
      {
        type: 'file',
        path: 'src/some/__tests__/allowed-file.test.ts',
        rationale: 'only this exact path is allowlisted',
      },
    ];
    try {
      const result = runSkTokenDriftCheck(root.path, allowlist);
      expect(result.drift).toHaveLength(1);
      expect(result.drift[0].matchedEntry).toBeNull();
    } finally {
      root.cleanup();
    }
  });
});

describe('runSkTokenDriftCheck — Phase-6 fail-closed read', () => {
  it('throws (not silent skip) when an allowlisted-extension file cannot be read', () => {
    const root = createTempScanRoot({
      'src/__tests__/unreadable.ts': `const k = "${tok('ant-test')}";`,
    });
    try {
      // Make the file unreadable. On POSIX this means chmod 000; on
      // platforms where chmod doesn't restrict reads (Windows), this
      // assertion is skipped because fs.readFileSync still succeeds.
      const target = join(root.path, 'src/__tests__/unreadable.ts');
      try {
        chmodSync(target, 0o000);
      } catch {
        // chmod not supported — skip the assertion.
        root.cleanup();
        return;
      }
      try {
        let threw = false;
        try {
          runSkTokenDriftCheck(root.path, []);
        } catch (err) {
          threw = true;
          expect((err as Error).message).toMatch(/sk-\* drift check failed to read/);
          expect((err as Error).message).toContain('src/__tests__/unreadable.ts');
        }
        // Process running as root (e.g. in a container) may still be able
        // to read despite chmod 000; in that case readFile succeeds and
        // no throw is expected.
        if (process.getuid && process.getuid() === 0) return;
        expect(threw).toBe(true);
      } finally {
        // Restore perms before cleanup.
        try {
          chmodSync(target, 0o644);
        } catch {
          // best effort
        }
      }
    } finally {
      root.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU mid-scan deletion (260623) — ENOENT skip vs fail-closed discriminator
// ---------------------------------------------------------------------------
//
// The production module calls `fs.readFileSync`. We can't spy on the ESM
// namespace, so the mocked `node:fs` (above) routes reads through
// `readFileSyncHook`: for ONE specific target path the hook throws a coded
// error; every other path delegates to the real read, so the canary logic
// (directory walk, gitignore filter, drift detection) still runs for real.
describe('runSkTokenDriftCheck — TOCTOU mid-scan deletion (ENOENT)', () => {
  it('skips a file that vanished mid-scan (ENOENT) instead of failing closed', () => {
    const root = createTempScanRoot({
      'src/__tests__/present.test.ts': 'const ok = "no token here";',
      'src/__tests__/vanished.test.ts': 'const ok = "no token here either";',
    });
    const target = join(root.path, 'src/__tests__/vanished.test.ts');
    readFileSyncHook = (p) => {
      if (p === target) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    };
    try {
      let result: ReturnType<typeof runSkTokenDriftCheck> | undefined;
      expect(() => {
        result = runSkTokenDriftCheck(root.path, []);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(result!.vanishedDuringScan).toBeGreaterThanOrEqual(1);
      expect(result!.drift).toEqual([]);
    } finally {
      readFileSyncHook = null;
      root.cleanup();
    }
  });

  it('still throws (fail-closed) for a non-ENOENT read error (EACCES)', () => {
    const root = createTempScanRoot({
      'src/__tests__/present.test.ts': 'const ok = "no token here";',
      'src/__tests__/unreadable.test.ts': 'const ok = "no token here either";',
    });
    const target = join(root.path, 'src/__tests__/unreadable.test.ts');
    readFileSyncHook = (p) => {
      if (p === target) {
        const err = new Error(
          `EACCES: permission denied, open '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
    };
    try {
      expect(() => runSkTokenDriftCheck(root.path, [])).toThrow(
        /sk-\* drift check failed to read/,
      );
    } finally {
      readFileSyncHook = null;
      root.cleanup();
    }
  });
});

describe('runSkTokenDriftCheck — Phase-6 misc tester-driven cases', () => {
  it('handles large source files over 1 MiB and still reports drift', () => {
    const literal = tok('ant-large-file');
    const root = createTempScanRoot({
      'src/__tests__/large.test.ts':
        `${'x'.repeat(1024 * 1024 + 17)}\nconst key = "${literal}";\n`,
    });
    try {
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toHaveLength(1);
      expect(result.drift[0]).toMatchObject({
        file: 'src/__tests__/large.test.ts',
        line: 2,
        literal,
      });
    } finally {
      root.cleanup();
    }
  });

  it('does not follow symlinks (entry.isFile() filters them out)', () => {
    const root = createTempScanRoot({
      'src/__tests__/placeholder.test.ts': 'export const ok = true;\n',
      'target-with-token.ts': `export const key = "${tok('ant-symlink-target')}";\n`,
    });
    try {
      symlinkSync(
        join(root.path, 'target-with-token.ts'),
        join(root.path, 'src/__tests__/linked-token.test.ts'),
      );
      const result = runSkTokenDriftCheck(root.path, []);
      expect(result.drift).toEqual([]);
      expect(result.allowedHits).toEqual([]);
      expect(result.filesScanned).toBe(1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    } finally {
      root.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Real-allowlist coverage canary
// ---------------------------------------------------------------------------

describe('SK_TEST_TOKEN_ALLOWLIST coverage', () => {
  it('every allowlist entry matches at least one real source file (no orphans)', () => {
    const result = runSkTokenDriftCheck(REPO_ROOT, SK_TEST_TOKEN_ALLOWLIST);
    if (result.orphanedAllowlistEntries.length > 0) {
      const summary = result.orphanedAllowlistEntries
        .map((e) => `  ${e.type}: ${e.path}  — ${e.rationale}`)
        .join('\n');
      throw new Error(
        `${result.orphanedAllowlistEntries.length} orphaned allowlist entry/entries:\n${summary}\n\n` +
          'Either restore the source path or remove the stale allowlist entry.',
      );
    }
    expect(result.orphanedAllowlistEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real-repo canary
// ---------------------------------------------------------------------------

describe('real repo at HEAD', () => {
  it('passes the sk-* test-token drift check (no drift, no orphans)', () => {
    const result = runSkTokenDriftCheck(REPO_ROOT, SK_TEST_TOKEN_ALLOWLIST);
    if (result.drift.length > 0) {
      const summary = result.drift
        .map((h) => `  ${h.file}:${h.line}  literal: ${h.literal}`)
        .join('\n');
      throw new Error(
        `Real repo failed sk-* drift check:\n${summary}\n\n` +
          `Replace each literal with a neutral fake-* token or add to scripts/${tok('test-token-allowlist')}.ts.`,
      );
    }
    expect(result.drift).toEqual([]);
    expect(result.orphanedAllowlistEntries).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});
