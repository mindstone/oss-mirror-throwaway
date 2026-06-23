import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// ESM module namespaces are non-configurable, so `vi.spyOn(fs, 'readFileSync')`
// throws. To intercept the production scanner's `readFileToleratingVanished`
// (which calls `fs.readFileSync` internally), mock `node:fs` with a
// readFileSync that delegates to the real implementation unless a per-test hook
// overrides a specific path. Every other fs symbol is the real one
// (importActual), so the temp-dir helpers and git walk behave normally. Mirrors
// the token-drift check's unit test (sibling under scripts/__tests__/).
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

import {
  ORPHAN_MCP_FIXTURE_REF_ALLOWLIST,
  checkOrphanedMcpFixtureRefs,
  collectMcpGeneratedReferences,
} from '../check-orphaned-mcp-fixture-refs';

const tempRoots: string[] = [];

function makeGitRepo(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'orphaned-mcp-fixture-refs-'));
  tempRoots.push(repoRoot);
  execFileSync('git', ['init', '-q'], { cwd: repoRoot, stdio: 'ignore' });
  return repoRoot;
}

function writeFixtureTest(repoRoot: string, connector = 'ghost-connector'): void {
  const testPath = path.join(repoRoot, 'src', '__tests__', 'bundle.integration.test.ts');
  mkdirSync(path.dirname(testPath), { recursive: true });
  writeFileSync(
    testPath,
    [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('bundle path', () => {",
      "  it('keeps generated path', () => {",
      `    expect('/app/resources/mcp-generated/${connector}/server.cjs').toContain('${connector}');`,
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

function writePathJoinFixtureTest(repoRoot: string, connector = 'ghost-connector'): void {
  const testPath = path.join(repoRoot, 'src', '__tests__', 'bundle-path-join.test.ts');
  mkdirSync(path.dirname(testPath), { recursive: true });
  writeFileSync(
    testPath,
    [
      "import path from 'node:path';",
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('bundle path join', () => {",
      "  it('keeps generated path segments', () => {",
      `    const serverPath = path.join('/app/Resources', 'mcp-generated', '${connector}', 'server.cjs');`,
      `    expect(serverPath).toContain('${connector}');`,
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

afterEach(() => {
  readFileSyncHook = null;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('checkOrphanedMcpFixtureRefs', () => {
  it('fails when a test references a generated MCP artifact with no source dir and no exemption', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);

    const result = checkOrphanedMcpFixtureRefs(repoRoot, { allowlist: [] });

    expect(result.ok).toBe(false);
    expect(result.scannedTestFiles).toBe(1);
    expect(result.sourceAbsentReferencedConnectors).toEqual(['ghost-connector']);
    expect(result.orphanedReferences).toHaveLength(1);
    expect(result.orphanedReferences[0].connector).toBe('ghost-connector');
    expect(result.orphanedReferences[0].references[0].file).toBe('src/__tests__/bundle.integration.test.ts');
  });

  it('fails when a path.join-style generated MCP artifact reference has no source dir and no exemption', () => {
    const repoRoot = makeGitRepo();
    writePathJoinFixtureTest(repoRoot);

    const result = checkOrphanedMcpFixtureRefs(repoRoot, { allowlist: [] });

    expect(result.ok).toBe(false);
    expect(result.scannedTestFiles).toBe(1);
    expect(result.sourceAbsentReferencedConnectors).toEqual(['ghost-connector']);
    expect(result.orphanedReferences).toHaveLength(1);
    expect(result.orphanedReferences[0].connector).toBe('ghost-connector');
    expect(result.orphanedReferences[0].references[0].file).toBe('src/__tests__/bundle-path-join.test.ts');
  });

  it('passes for the same source-absent generated artifact reference when it has a rationale-backed exemption', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);

    const result = checkOrphanedMcpFixtureRefs(repoRoot, {
      allowlist: [
        {
          name: 'ghost-connector',
          rationale: 'Intentional mock persisted-config string; the test does not stat or spawn the artifact.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.sourceAbsentReferencedConnectors).toEqual(['ghost-connector']);
    expect(result.orphanedReferences).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual([]);
  });

  it('flags an exemption as stale when GENUINE connector source returns (has real content)', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);
    // Genuine source = real content (a package.json), not just build output.
    const srcDir = path.join(repoRoot, 'resources', 'mcp', 'ghost-connector');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'package.json'), '{ "name": "ghost-connector" }\n');

    const result = checkOrphanedMcpFixtureRefs(repoRoot, {
      allowlist: [
        {
          name: 'ghost-connector',
          rationale: 'Used to be source-absent, but the source directory has returned.',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.orphanedReferences).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual([
      { name: 'ghost-connector', reason: 'source-restored' },
    ]);
    expect(result.staleLocalBuildArtifacts).toEqual([]);
  });

  it('does NOT flag stale when the connector dir is only local build cruft; surfaces an advisory instead', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);
    // Build-only cruft: build/ + node_modules/, no source — the post-OSS-migration
    // local artifact that used to masquerade as 'source-restored'.
    const cruftDir = path.join(repoRoot, 'resources', 'mcp', 'ghost-connector');
    mkdirSync(path.join(cruftDir, 'build'), { recursive: true });
    mkdirSync(path.join(cruftDir, 'node_modules'), { recursive: true });

    const result = checkOrphanedMcpFixtureRefs(repoRoot, {
      allowlist: [
        {
          name: 'ghost-connector',
          rationale: 'Intentional mock persisted-config string; the test does not stat or spawn the artifact.',
        },
      ],
    });

    // The build cruft is treated like an absent source: exemption stays valid,
    // check still passes, and the cruft is surfaced as a non-failing advisory.
    expect(result.ok).toBe(true);
    expect(result.staleAllowlistEntries).toEqual([]);
    expect(result.orphanedReferences).toEqual([]);
    expect(result.staleLocalBuildArtifacts).toEqual(['ghost-connector']);
  });

  it('orphans a NON-allowlisted reference whose dir is only build-cruft (local now matches clean CI)', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);
    // Stale build cruft, no source, NOT allowlisted: clean CI (dir absent) would
    // flag this as orphaned, so the local run must too — the old mere-existence
    // check would have masked it.
    const cruftDir = path.join(repoRoot, 'resources', 'mcp', 'ghost-connector');
    mkdirSync(path.join(cruftDir, 'build'), { recursive: true });

    const result = checkOrphanedMcpFixtureRefs(repoRoot, { allowlist: [] });

    expect(result.ok).toBe(false);
    expect(result.sourceAbsentReferencedConnectors).toEqual(['ghost-connector']);
    expect(result.orphanedReferences).toHaveLength(1);
    expect(result.orphanedReferences[0].connector).toBe('ghost-connector');
    expect(result.staleLocalBuildArtifacts).toEqual(['ghost-connector']);
  });

  it('treats an empty connector dir as build cruft, not restored source', () => {
    const repoRoot = makeGitRepo();
    writeFixtureTest(repoRoot);
    mkdirSync(path.join(repoRoot, 'resources', 'mcp', 'ghost-connector'), { recursive: true });

    const result = checkOrphanedMcpFixtureRefs(repoRoot, {
      allowlist: [
        {
          name: 'ghost-connector',
          rationale: 'Intentional mock persisted-config string; the test does not stat or spawn the artifact.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.staleAllowlistEntries).toEqual([]);
    expect(result.staleLocalBuildArtifacts).toEqual(['ghost-connector']);
  });

  it('passes on the current repo tree', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = checkOrphanedMcpFixtureRefs(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.orphanedReferences).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual([]);
    expect(result.sourceAbsentReferencedConnectors).toEqual(
      ORPHAN_MCP_FIXTURE_REF_ALLOWLIST.map((entry) => entry.name).sort(),
    );
  });

  it('real-tree scan sees generated artifact path references in test files', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const refs = collectMcpGeneratedReferences(repoRoot);

    expect(refs.map((ref) => `${ref.connector}:${ref.file}:${ref.line}`)).toEqual(
      expect.arrayContaining([
        'slack:src/main/services/__tests__/bundledMcpCloudRegistration.test.ts:82',
        'microsoft-mail:src/main/services/__tests__/bundledMcpCloudRegistration.test.ts:98',
        'salesforce:src/main/services/__tests__/credential-loss-prod-readiness.test.ts:209',
        'salesforce:src/main/services/__tests__/bundledMcpManager.test.ts:3612',
        'google-workspace:src/main/services/__tests__/mcpConfigManager.test.ts:612',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// TOCTOU mid-scan deletion (260623) — counters sink wiring
// ---------------------------------------------------------------------------
//
// Pins the optional `counters` sink added in Stage 2: when a file enumerated by
// the walk is deleted before its read (ENOENT), collectMcpGeneratedReferences
// must increment `counters.vanished`, skip the file (no reference, no throw),
// and still scan the surviving files. Uses the same `node:fs` module-mock as
// the token-drift test — readFileToleratingVanished calls `fs.readFileSync`, which
// the hook intercepts for one specific enumerated path.
describe('collectMcpGeneratedReferences — counters sink (ENOENT vanished)', () => {
  it('increments counters.vanished and skips a file that vanished mid-scan', () => {
    const repoRoot = makeGitRepo();
    // Enumerate two files explicitly so the test does not depend on git
    // collection. One vanishes (ENOENT); the other holds a real generated
    // reference that must still be collected.
    const vanishedRel = 'src/__tests__/vanished.integration.test.ts';
    const survivorRel = 'src/__tests__/survivor.integration.test.ts';
    const vanishedAbs = path.join(repoRoot, vanishedRel);
    const survivorAbs = path.join(repoRoot, survivorRel);
    mkdirSync(path.dirname(survivorAbs), { recursive: true });
    // Build the `mcp-generated/<name>/` reference at runtime so THIS test
    // file's own source doesn't trip the real-tree canary scan (which reads
    // every committed test file, including this one).
    const generatedSegment = ['mcp', 'generated'].join('-');
    writeFileSync(
      survivorAbs,
      `expect('/app/resources/${generatedSegment}/survivor-connector/server.cjs').toContain('x');\n`,
    );

    readFileSyncHook = (p) => {
      if (p === vanishedAbs) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    };

    const counters = { vanished: 0 };
    let refs: ReturnType<typeof collectMcpGeneratedReferences> | undefined;
    expect(() => {
      refs = collectMcpGeneratedReferences(repoRoot, [vanishedRel, survivorRel], counters);
    }).not.toThrow();

    expect(counters.vanished).toBeGreaterThanOrEqual(1);
    // The vanished file produced no reference; the survivor was still scanned.
    expect(refs!.map((ref) => ref.file)).not.toContain(vanishedRel);
    expect(refs!.map((ref) => ref.connector)).toContain('survivor-connector');
  });
});
