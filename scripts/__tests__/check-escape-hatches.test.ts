import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countOccurrences,
  findBareDisablesInSources,
  findEscapeHatchViolations,
  isTestFile,
  reportBareDisables,
} from '../check-escape-hatches';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'escape-hatches-'));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

describe('check-escape-hatches', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('isTestFile', () => {
    it('identifies __tests__ directory files', () => {
      expect(isTestFile('src/__tests__/foo.ts')).toBe(true);
    });

    it('identifies .test. files', () => {
      expect(isTestFile('src/foo.test.ts')).toBe(true);
    });

    it('identifies .spec. files', () => {
      expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    });

    it('does not flag production files', () => {
      expect(isTestFile('src/services/agent.ts')).toBe(false);
    });

    it('handles Windows-style separators', () => {
      expect(isTestFile('src\\__tests__\\foo.ts')).toBe(true);
    });
  });

  describe('countOccurrences', () => {
    it('counts word-boundary "as any" matches', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, 'const x = foo as any;\nconst y = bar as  any;\n');

      const result = countOccurrences([file], /\bas\s+any\b/g, root);
      expect(result.count).toBe(2);
      expect(result.locations).toHaveLength(2);
    });

    it('does not match "has any" (false positive)', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, '// This function has any number of args\nconst x = "has any value";\n');

      const result = countOccurrences([file], /\bas\s+any\b/g, root);
      expect(result.count).toBe(0);
    });

    it('counts multiple occurrences on one line', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, 'fn(x as any, y as any, z as any);\n');

      const result = countOccurrences([file], /\bas\s+any\b/g, root);
      expect(result.count).toBe(3);
    });

    it('counts eslint-disable variants', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, [
        '/* eslint-disable */',
        '// eslint-disable-next-line no-console',
        '/* eslint-disable-next-line @typescript-eslint/no-explicit-any */',
      ].join('\n'));

      const result = countOccurrences(
        [file],
        /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/g,
        root,
        { useStripped: false },
      );
      expect(result.count).toBe(3);
    });

    it('ignores narrative eslint-disable mentions when using the tightened pattern', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, [
        '// We rely on `eslint-disable` annotations elsewhere.',
        '// eslint-disable-next-line foo',
      ].join('\n'));

      const result = countOccurrences(
        [file],
        /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/g,
        root,
        { useStripped: false },
      );
      expect(result.count).toBe(1);
    });

    it('strips comments by default for narrative-prone patterns', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, '// use as any here for legacy\nconst x: number = 1;');

      const result = countOccurrences([file], /\bas\s+any\b/g, root);
      expect(result.count).toBe(0);
    });

    it('caps location reporting at 20 entries', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      const lines = Array.from({ length: 25 }, () => 'const x = foo as any;').join('\n');
      writeFileSync(file, lines);

      const result = countOccurrences([file], /\bas\s+any\b/g, root);
      expect(result.count).toBe(25);
      expect(result.locations).toHaveLength(20);
    });
  });

  describe('findEscapeHatchViolations', () => {
    it('passes when counts are within baselines', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', 'const x: string = "hello";\n');

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 5 },
        ],
      });

      expect(result.failed).toBe(false);
      expect(result.results[0].count).toBe(0);
      expect(result.results[0].exceeded).toBe(false);
    });

    it('fails when count exceeds baseline', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', [
        'const a = x as any;',
        'const b = y as any;',
        'const c = z as any;',
      ].join('\n'));

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 2 },
        ],
      });

      expect(result.failed).toBe(true);
      expect(result.results[0].count).toBe(3);
      expect(result.results[0].exceeded).toBe(true);
    });

    it('excludes test files from counting', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', 'const a = x as any;\n');
      writeFixtureFile(root, 'src/service.test.ts', [
        'const b = y as any;',
        'const c = z as any;',
      ].join('\n'));

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 5 },
        ],
      });

      // Only the production file should be counted
      expect(result.results[0].count).toBe(1);
    });

    it('excludes __tests__ directories from counting', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', 'const a = x as any;\n');
      writeFixtureFile(root, 'src/__tests__/service.ts', 'const b = y as any;\nconst c = z as any;\n');

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 5 },
        ],
      });

      expect(result.results[0].count).toBe(1);
    });

    it('scans multiple source directories', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/a.ts', 'const x = a as any;\n');
      writeFixtureFile(root, 'cloud-service/src/b.ts', 'const y = b as any;\n');

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src', 'cloud-service/src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 5 },
        ],
      });

      expect(result.results[0].count).toBe(2);
    });

    it('runs multiple checks independently', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', [
        'const a = x as any;',
        '// @ts-ignore',
        '// eslint-disable-next-line',
      ].join('\n'));

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 5 },
          { name: 'ts-directives', pattern: /@ts-ignore|@ts-expect-error/g, baseline: 5, useStripped: false },
          {
            name: 'eslint-disable',
            pattern: /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/g,
            baseline: 5,
            useStripped: false,
          },
        ],
      });

      expect(result.results).toHaveLength(3);
      expect(result.results[0].count).toBe(1);
      expect(result.results[1].count).toBe(1);
      expect(result.results[2].count).toBe(1);
      expect(result.failed).toBe(false);
    });

    it('handles empty source directories gracefully', () => {
      const root = createTempRoot();
      mkdirSync(join(root, 'src'), { recursive: true });

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 0 },
        ],
      });

      expect(result.fileCount).toBe(0);
      expect(result.failed).toBe(false);
    });

    it('handles missing source directory gracefully', () => {
      const root = createTempRoot();

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['nonexistent'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 0 },
        ],
      });

      expect(result.fileCount).toBe(0);
      expect(result.failed).toBe(false);
    });

    it('only scans .ts and .tsx files', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/service.ts', 'const a = x as any;\n');
      writeFixtureFile(root, 'src/component.tsx', 'const b = y as any;\n');
      writeFixtureFile(root, 'src/readme.md', 'cast as any type\n');
      writeFixtureFile(root, 'src/data.json', '{"as any": true}\n');

      const result = findEscapeHatchViolations({
        repoRoot: root,
        sourceDirs: ['src'],
        checks: [
          { name: 'as any', pattern: /\bas\s+any\b/g, baseline: 10 },
        ],
      });

      expect(result.fileCount).toBe(2);
      expect(result.results[0].count).toBe(2);
    });
  });

  describe('reportBareDisables / findBareDisablesInSources', () => {
    it('counts bare disables per rule, excluding rationaled ones', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/a.ts', [
        '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
        'const a: any = 1;',
        '// eslint-disable-next-line no-console -- pre-bootstrap diagnostic',
        'console.log(a);',
        '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarded',
        'const b: any = 2;',
        '// eslint-disable-next-line no-console',
        'console.warn(b);',
      ].join('\n'));

      const report = reportBareDisables([join(root, 'src/a.ts')], root);
      expect(report.totalBare).toBe(2);
      expect(report.byRule['@typescript-eslint/no-explicit-any']).toBe(1);
      expect(report.byRule['no-console']).toBe(1);
    });

    it('excludes test paths from bare-disable counts', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/prod.ts', '// eslint-disable-next-line foo\nconst x = 1;');
      writeFixtureFile(root, 'src/__tests__/test.ts', '// eslint-disable-next-line bar\nconst y = 1;');
      writeFixtureFile(root, 'src/file.test.ts', '// eslint-disable-next-line baz\nconst z = 1;');

      const report = reportBareDisables([
        join(root, 'src/prod.ts'),
        join(root, 'src/__tests__/test.ts'),
        join(root, 'src/file.test.ts'),
      ], root);
      expect(report.totalBare).toBe(1);
      expect(report.byRule['foo']).toBe(1);
      expect(report.byRule['bar']).toBeUndefined();
      expect(report.byRule['baz']).toBeUndefined();
    });

    it('ignores narrative eslint-disable mentions', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/a.ts', [
        '// This file uses eslint-disable elsewhere — see hooks.',
        'const x = 1;',
      ].join('\n'));

      const report = reportBareDisables([join(root, 'src/a.ts')], root);
      expect(report.totalBare).toBe(0);
    });

    it('counts multi-rule directives separately', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/a.ts', [
        '// eslint-disable-next-line no-console, no-restricted-syntax',
        'const x = 1;',
      ].join('\n'));

      const report = reportBareDisables([join(root, 'src/a.ts')], root);
      expect(report.totalBare).toBe(2);
      expect(report.byRule['no-console']).toBe(1);
      expect(report.byRule['no-restricted-syntax']).toBe(1);
    });

    it('findBareDisablesInSources walks the source tree and reports per rule', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'src/a.ts', '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst x: any = 1;');
      writeFixtureFile(root, 'src/b.ts', '// eslint-disable-next-line no-console -- ok\nconsole.log(1);');

      const report = findBareDisablesInSources({ repoRoot: root, sourceDirs: ['src'] });
      expect(report.totalBare).toBe(1);
      expect(report.byRule['@typescript-eslint/no-explicit-any']).toBe(1);
    });
  });
});
