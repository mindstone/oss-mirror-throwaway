/**
 * Unit tests for `scripts/boundary-hints.ts`.
 *
 * Tests the pure helpers (`compileEntry`, `loadRegistry`, `matchPaths`,
 * `matchRegexes`) against fixture registries + synthetic file sets.
 *
 * Critical invariants:
 *   - `match.exclude_paths` is a per-file filter (not entry-wide suppression).
 *     A file matching both include and exclude is removed for that file only;
 *     other include matches in the same change still fire the entry.
 *   - `match.exclude_paths` is optional; omitted field behaves identically
 *     to pre-`exclude_paths` script behavior (backward-compat).
 *   - Invalid `exclude_paths` types (non-array, non-string element) fail
 *     closed via `BoundaryHintsError`.
 *
 * @see scripts/boundary-hints.ts
 * @see docs/project/BOUNDARY_REGISTRY.md
 * @see docs/plans/260422_oss_migration_audit_followups.md (Stage 1)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoundaryHintsError,
  compileEntry,
  loadRegistry,
  matchPaths,
  matchRegexes,
  normalize,
} from '../boundary-hints';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/boundary-hints');

describe('compileEntry (schema validation)', () => {
  const validEntry = {
    id: 'x',
    category: 'test',
    description: 'd',
    spec_doc: 'docs/project/BOUNDARY_REGISTRY.md',
    match: { paths: ['src/core/**/*.ts'], identifiers: ['FOO'] },
    rationale: 'r',
    postmortems: ['foo.md'],
  };

  it('accepts a minimal entry without exclude_paths', () => {
    const compiled = compileEntry(validEntry, 0);
    expect(compiled.id).toBe('x');
    expect(compiled.match.exclude_paths).toEqual([]);
  });

  it('accepts exclude_paths as a string array', () => {
    const entry = { ...validEntry, match: { ...validEntry.match, exclude_paths: ['a.ts'] } };
    const compiled = compileEntry(entry, 0);
    expect(compiled.match.exclude_paths).toEqual(['a.ts']);
  });

  it('rejects exclude_paths that is not an array', () => {
    const entry = { ...validEntry, match: { ...validEntry.match, exclude_paths: 'not-an-array' } };
    expect(() => compileEntry(entry, 0)).toThrow(BoundaryHintsError);
    expect(() => compileEntry(entry, 0)).toThrow(/exclude_paths must be an array/);
  });

  it('rejects exclude_paths with a non-string element', () => {
    const entry = { ...validEntry, match: { ...validEntry.match, exclude_paths: [123 as unknown as string] } };
    expect(() => compileEntry(entry, 0)).toThrow(BoundaryHintsError);
    expect(() => compileEntry(entry, 0)).toThrow(/exclude_paths\[0\] must be non-empty string/);
  });

  it('rejects exclude_paths with empty string', () => {
    const entry = { ...validEntry, match: { ...validEntry.match, exclude_paths: ['  '] } };
    expect(() => compileEntry(entry, 0)).toThrow(/exclude_paths\[0\] must be non-empty string/);
  });
});

describe('loadRegistry (fixture registries)', () => {
  it('loads a valid registry with exclude_paths', async () => {
    const { entries, warnings } = await loadRegistry(join(fixturesDir, 'registry-exclude.yaml'), repoRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('test-include-exclude');
    expect(entries[0].match.exclude_paths).toEqual(['src/core/constants.ts']);
    // No warnings expected — all paths resolve against the real repo root.
    expect(warnings).toEqual([]);
  });

  it('loads a valid registry without exclude_paths (backward-compat)', async () => {
    const { entries, warnings } = await loadRegistry(join(fixturesDir, 'registry-no-exclude.yaml'), repoRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].match.exclude_paths).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('rejects a registry with invalid exclude_paths type', async () => {
    await expect(
      loadRegistry(join(fixturesDir, 'registry-invalid.yaml'), repoRoot)
    ).rejects.toThrow(BoundaryHintsError);
  });
});

describe('matchPaths (per-file filter semantics)', () => {
  // Use the real repo root so globs resolve against real files.
  // Tests pick specific synthetic file sets that include known real files.

  it('fires when an included file is in the change set', async () => {
    const include = ['src/core/**/*.ts'];
    const exclude: string[] = [];
    const changed = new Set(['src/core/platform.ts']);
    expect(await matchPaths(include, exclude, changed, repoRoot)).toBe(true);
  });

  it('does NOT fire when only excluded files are in the change set', async () => {
    const include = ['src/core/**/*.ts'];
    const exclude = ['src/core/constants.ts'];
    const changed = new Set(['src/core/constants.ts']);
    expect(await matchPaths(include, exclude, changed, repoRoot)).toBe(false);
  });

  it('STILL fires when the change set contains both excluded AND included files (per-file filter, not entry suppression)', async () => {
    // This is the critical invariant: mixed-file changes must still fire.
    const include = ['src/core/**/*.ts'];
    const exclude = ['src/core/constants.ts'];
    const changed = new Set(['src/core/constants.ts', 'src/core/platform.ts']);
    expect(await matchPaths(include, exclude, changed, repoRoot)).toBe(true);
  });

  it('fires with no exclude_paths (backward-compat path)', async () => {
    const include = ['src/core/**/*.ts'];
    const changed = new Set(['src/core/constants.ts']);
    // Empty exclude array (default when field absent) → entry fires on any include hit.
    expect(await matchPaths(include, [], changed, repoRoot)).toBe(true);
  });

  it('does not fire when the change set has no include matches', async () => {
    const include = ['src/core/**/*.ts'];
    const exclude: string[] = [];
    const changed = new Set(['README.md']);
    expect(await matchPaths(include, exclude, changed, repoRoot)).toBe(false);
  });

  it('does not fire on empty change set', async () => {
    expect(await matchPaths(['src/core/**/*.ts'], [], new Set<string>(), repoRoot)).toBe(false);
  });
});

describe('matchRegexes (identifier matching unchanged)', () => {
  it('fires when text contains the identifier', () => {
    const regexes = [/FOO/g, /BAR/g];
    expect(matchRegexes(regexes, 'this mentions FOO somewhere')).toBe(true);
  });

  it('does not fire on empty text', () => {
    expect(matchRegexes([/FOO/g], '')).toBe(false);
  });

  it('does not fire when text lacks all identifiers', () => {
    expect(matchRegexes([/FOO/g, /BAR/g], 'no matches here')).toBe(false);
  });
});

describe('normalize (path normalization)', () => {
  it('converts backslashes to forward slashes (Windows compat)', () => {
    expect(normalize('src\\main\\index.ts')).toBe('src/main/index.ts');
  });

  it('strips leading ./', () => {
    expect(normalize('./src/main/index.ts')).toBe('src/main/index.ts');
  });

  it('leaves plain paths unchanged', () => {
    expect(normalize('src/main/index.ts')).toBe('src/main/index.ts');
  });
});

describe('production registry loads cleanly', () => {
  it('loads docs/project/boundary-registry.yaml without errors', async () => {
    const { entries, warnings } = await loadRegistry(
      join(repoRoot, 'docs/project/boundary-registry.yaml'),
      repoRoot
    );
    expect(entries.length).toBeGreaterThanOrEqual(4);
    // Zero or near-zero warnings; fail loudly if a path glob drifts.
    // Allow empty warnings only; any warning is a real-world drift signal.
    expect(warnings).toEqual([]);
  });

  it('contains the mcp-apps-package-identity-routing entry', async () => {
    const { entries } = await loadRegistry(
      join(repoRoot, 'docs/project/boundary-registry.yaml'),
      repoRoot
    );
    const mcpApps = entries.find(e => e.id === 'mcp-apps-package-identity-routing');
    expect(mcpApps).toBeDefined();
    expect(mcpApps?.category).toBe('mcp-resource-routing');
    expect(mcpApps?.match.exclude_paths).toEqual(['resources/connector-catalog.json']);
  });

  it('workspace-env entry carries the REBEL_WORKSPACE_PATH forbidden term', async () => {
    // Guards the forbidden_terms schema wiring. The 260420 bug was
    // REBEL_WORKSPACE_PATH leaking into OSS-subprocess env; the registry
    // entry must still carry this as a forbidden term so Spec Reader
    // flags any plan that proposes writing it.
    const { entries } = await loadRegistry(
      join(repoRoot, 'docs/project/boundary-registry.yaml'),
      repoRoot
    );
    const wsEnv = entries.find(e => e.id === 'mcp-workspace-env-propagation');
    expect(wsEnv).toBeDefined();
    expect(wsEnv?.forbidden_terms).toContain('REBEL_WORKSPACE_PATH');
    expect(wsEnv?.allowed_terms).toContain('MCP_WORKSPACE_PATH');
  });
});

describe('CLI end-to-end regression fixtures', () => {
  // Uses --planning-doc CLI mode against stable fixtures to prove the
  // production registry behaves correctly on known-positive + known-negative
  // inputs. This is the Stage 3 regression guard from the planning doc.

  const cliPath = join(repoRoot, 'scripts/boundary-hints.ts');

  const runCli = (planningDocPath: string): string => {
    return execFileSync('npx', ['tsx', cliPath, '--planning-doc', planningDocPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      // 60s is plenty for a single registry load; guard against runaway.
      timeout: 60_000,
    });
  };

  it('fires mcp-workspace-env-propagation on workspace-env-positive.md', () => {
    const output = runCli(join(fixturesDir, 'workspace-env-positive.md'));
    // Identifier match is sufficient; path match would only fire if the
    // fixture path happened to match the narrowed glob, which it does NOT
    // (fixture is under scripts/__tests__/ not super-mcp/).
    expect(output).toMatch(/id: mcp-workspace-env-propagation\b/);
  });

  it('does NOT fire mcp-workspace-env-propagation on workspace-env-negative.md', () => {
    const output = runCli(join(fixturesDir, 'workspace-env-negative.md'));
    // This is the 260412 over-fire regression: pre-Stage-3, the broad
    // super-mcp/src/handlers/**/*.ts glob would fire the workspace-env
    // entry. After Stage 3 (paths narrowed + identifiers trimmed), the
    // negative fixture must NOT fire workspace-env.
    expect(output).not.toMatch(/id: mcp-workspace-env-propagation\b/);
    // But it SHOULD still fire the mcp-apps entry (identifier match).
    expect(output).toMatch(/id: mcp-apps-package-identity-routing\b/);
  });
});
