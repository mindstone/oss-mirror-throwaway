import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findForbiddenTermViolations,
  type DiffProvider,
} from '../check-boundary-forbidden-terms';

interface BoundaryFixture {
  id: string;
  forbiddenTerms: string[];
  paths?: string[];
  excludePaths?: string[];
}

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'boundary-forbidden-terms-'));
  tempRoots.push(root);
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source, 'utf8');
}

function buildRegistryYaml(boundaries: BoundaryFixture[]): string {
  const blocks = boundaries.map((boundary) => {
    const includePaths = (boundary.paths ?? ['src/**/*.ts'])
      .map((path) => `        - ${path}`)
      .join('\n');
    const excludePaths = boundary.excludePaths && boundary.excludePaths.length > 0
      ? `\n      exclude_paths:\n${boundary.excludePaths.map((path) => `        - ${path}`).join('\n')}`
      : '';
    const forbiddenTerms = boundary.forbiddenTerms
      .map((term) => `      - ${term}`)
      .join('\n');

    return [
      `  - id: ${boundary.id}`,
      '    category: test-boundary',
      `    description: Test boundary ${boundary.id}`,
      `    spec_doc: docs/specs/${boundary.id}.md`,
      '    match:',
      '      paths:',
      includePaths,
      excludePaths,
      '      identifiers:',
      `        - ${boundary.id}`,
      '    forbidden_terms:',
      forbiddenTerms,
      '    rationale: test rationale',
      '    postmortems:',
      '      - postmortem.md',
    ].join('\n');
  });

  return `version: 1\nboundaries:\n${blocks.join('\n')}\n`;
}

function buildAddedDiff(file: string, startLine: number, addedLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${startLine},${addedLines.length} @@`,
    ...addedLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function buildRemovedDiff(file: string, startLine: number, removedLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine},${removedLines.length} +${startLine},0 @@`,
    ...removedLines.map((line) => `-${line}`),
    '',
  ].join('\n');
}

async function runFixtureCheck(opts: {
  boundaries: BoundaryFixture[];
  changedFiles: string[];
  perFileDiff: Record<string, string>;
  fileContents?: Record<string, string>;
}): ReturnType<typeof findForbiddenTermViolations> {
  const root = createTempRoot();
  const fileContents = opts.fileContents ?? {};

  // Keep path-glob validation warnings out of tests.
  writeFixture(root, 'src/placeholder.ts', 'export const placeholder = true;\n');

  for (const boundary of opts.boundaries) {
    writeFixture(root, `docs/specs/${boundary.id}.md`, `# ${boundary.id}\n`);
  }
  writeFixture(root, 'registry.yaml', buildRegistryYaml(opts.boundaries));

  for (const file of opts.changedFiles) {
    writeFixture(root, file, fileContents[file] ?? 'export const fixture = 1;\n');
  }

  const diffProvider: DiffProvider = (query) => {
    if (query.mode === 'name-only') {
      return opts.changedFiles.join('\n');
    }
    return opts.perFileDiff[query.file] ?? '';
  };

  return findForbiddenTermViolations({
    registryPath: 'registry.yaml',
    cwdOverride: root,
    diffProvider,
    fileReader: (path) => readFileSync(path, 'utf8'),
  });
}

describe('check-boundary-forbidden-terms', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no violations on a clean diff', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 10, ['const value = safeCall();']),
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it('catches a forbidden-term violation on an added line', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 11, ['const value = forbiddenCall();']),
      },
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        file,
        line: 11,
        entryId: 'provider-routing-boundary',
        pattern: 'forbiddenCall',
      }),
    ]);
  });

  it('ignores removed lines even when they match forbidden terms', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildRemovedDiff(file, 20, ['const value = forbiddenCall();']),
      },
    });

    expect(result.violations).toEqual([]);
  });

  it('supports escape hatches with mandatory reason', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 33, [
          'const value = forbiddenCall(); // boundary-allow: provider-routing-boundary — temporary migration guard',
        ]),
      },
    });

    expect(result.violations).toEqual([]);
  });

  it('requires escape hatch reason text after em dash', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 5, [
          'const value = forbiddenCall(); // boundary-allow: provider-routing-boundary',
        ]),
      },
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        file,
        line: 5,
        entryId: 'provider-routing-boundary',
      }),
    ]);
  });

  it("only scans files that match an entry's path globs", async () => {
    const file = 'docs/notes.md';
    const result = await runFixtureCheck({
      boundaries: [{ id: 'provider-routing-boundary', forbiddenTerms: ['forbiddenCall'] }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 1, ['forbiddenCall()']),
      },
      fileContents: {
        [file]: 'forbiddenCall()\n',
      },
    });

    expect(result.violations).toEqual([]);
  });

  it('honors exclude_paths when include and exclude both match', async () => {
    const file = 'src/generated/example.ts';
    const result = await runFixtureCheck({
      boundaries: [{
        id: 'provider-routing-boundary',
        forbiddenTerms: ['forbiddenCall'],
        paths: ['src/**/*.ts'],
        excludePaths: ['src/generated/**'],
      }],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 2, ['const value = forbiddenCall();']),
      },
    });

    expect(result.violations).toEqual([]);
  });

  it('checks multiple matching boundary entries for the same file', async () => {
    const file = 'src/services/example.ts';
    const result = await runFixtureCheck({
      boundaries: [
        { id: 'boundary-one', forbiddenTerms: ['forbiddenOne'] },
        { id: 'boundary-two', forbiddenTerms: ['forbiddenTwo'] },
      ],
      changedFiles: [file],
      perFileDiff: {
        [file]: buildAddedDiff(file, 14, [
          'const first = forbiddenOne();',
          'const second = forbiddenTwo();',
        ]),
      },
    });

    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((violation) => violation.entryId).sort()).toEqual([
      'boundary-one',
      'boundary-two',
    ]);
  });
});
