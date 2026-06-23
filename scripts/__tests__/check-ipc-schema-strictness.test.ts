import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countPattern,
  findSchemaStrictnessViolations,
  walkDir,
} from '../check-ipc-schema-strictness';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'schema-strictness-'));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

describe('check-ipc-schema-strictness', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('walkDir', () => {
    it('collects .ts files recursively', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', '');
      writeFixtureFile(root, 'ipc/channels/test.ts', '');

      const files = walkDir(join(root, 'ipc'));
      expect(files).toHaveLength(2);
    });

    it('skips node_modules and __tests__', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', '');
      writeFixtureFile(root, 'ipc/node_modules/pkg.ts', '');
      writeFixtureFile(root, 'ipc/__tests__/test.ts', '');

      const files = walkDir(join(root, 'ipc'));
      expect(files).toHaveLength(1);
    });

    it('returns empty array for missing directory', () => {
      const files = walkDir('/nonexistent/path');
      expect(files).toEqual([]);
    });
  });

  describe('countPattern', () => {
    it('counts z.any() occurrences', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, 'const schema = z.object({ data: z.any() });\n');

      const result = countPattern([file], /z\.any\(\)/g, root);
      expect(result.count).toBe(1);
      expect(result.locations).toHaveLength(1);
    });

    it('counts multiple occurrences per line', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, 'z.object({ a: z.any(), b: z.any(), c: z.any() })\n');

      const result = countPattern([file], /z\.any\(\)/g, root);
      expect(result.count).toBe(3);
    });

    it('does not match z.anyType or z.anything', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(file, 'z.anyType();\nz.anything();\n');

      const result = countPattern([file], /z\.any\(\)/g, root);
      expect(result.count).toBe(0);
    });

    it('does not match z.unknown() inside line comments (regression: 260523 Stage 1)', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(
        file,
        '// JsonValueSchema replaces z.unknown() for typed metadata.\nconst x = z.string();\n',
      );

      const result = countPattern([file], /z\.unknown\(\)/g, root);
      expect(result.count).toBe(0);
    });

    it('does not match z.unknown() inside block comments', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(
        file,
        '/**\n * Use JsonValueSchema instead of z.unknown() for typed metadata.\n */\nconst x = z.string();\n',
      );

      const result = countPattern([file], /z\.unknown\(\)/g, root);
      expect(result.count).toBe(0);
    });

    it('still matches z.unknown() in actual code', () => {
      const root = createTempRoot();
      const file = join(root, 'test.ts');
      writeFileSync(
        file,
        '// comment mentioning z.unknown() in prose\nconst real = z.unknown();\n',
      );

      const result = countPattern([file], /z\.unknown\(\)/g, root);
      expect(result.count).toBe(1);
      expect(result.locations[0]).toContain(':2:');
    });

    it('includes file:line:content in locations', () => {
      const root = createTempRoot();
      const file = join(root, 'contracts.ts');
      writeFileSync(file, 'line1\nconst x = z.unknown();\nline3\n');

      const result = countPattern([file], /z\.unknown\(\)/g, root);
      expect(result.locations[0]).toMatch(/contracts\.ts:2: const x = z\.unknown\(\);/);
    });
  });

  describe('findSchemaStrictnessViolations', () => {
    it('passes when counts are within baselines', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', [
        'import { z } from "zod";',
        'const schema = z.object({ name: z.string() });',
      ].join('\n'));

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 5,
        zUnknownBaseline: 5,
      });

      expect(result.failed).toBe(false);
      expect(result.zAny.count).toBe(0);
      expect(result.zUnknown.count).toBe(0);
    });

    it('fails when z.any() exceeds baseline', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', [
        'import { z } from "zod";',
        'const a = z.any();',
        'const b = z.any();',
        'const c = z.any();',
      ].join('\n'));

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 2,
        zUnknownBaseline: 5,
      });

      expect(result.failed).toBe(true);
      expect(result.zAny.exceeded).toBe(true);
      expect(result.zAny.count).toBe(3);
    });

    it('fails when z.unknown() exceeds baseline', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', [
        'import { z } from "zod";',
        'const a = z.unknown();',
        'const b = z.unknown();',
      ].join('\n'));

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 5,
        zUnknownBaseline: 1,
      });

      expect(result.failed).toBe(true);
      expect(result.zUnknown.exceeded).toBe(true);
      expect(result.zUnknown.count).toBe(2);
    });

    it('scans nested channel files', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', 'import { z } from "zod";\n');
      writeFixtureFile(root, 'ipc/channels/agent.ts', 'const data = z.any();\n');
      writeFixtureFile(root, 'ipc/channels/settings.ts', 'const cfg = z.unknown();\n');

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 5,
        zUnknownBaseline: 5,
      });

      expect(result.fileCount).toBe(3);
      expect(result.zAny.count).toBe(1);
      expect(result.zUnknown.count).toBe(1);
    });

    it('reports correct fileCount', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/a.ts', '');
      writeFixtureFile(root, 'ipc/b.ts', '');
      writeFixtureFile(root, 'ipc/channels/c.ts', '');

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
      });

      expect(result.fileCount).toBe(3);
    });

    it('handles empty directory', () => {
      const root = createTempRoot();
      mkdirSync(join(root, 'ipc'), { recursive: true });

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 0,
        zUnknownBaseline: 0,
      });

      expect(result.fileCount).toBe(0);
      expect(result.failed).toBe(false);
    });

    it('counts both z.any() and z.unknown() independently', () => {
      const root = createTempRoot();
      writeFixtureFile(root, 'ipc/contracts.ts', [
        'import { z } from "zod";',
        'const schema = z.object({',
        '  data: z.any(),',
        '  meta: z.unknown(),',
        '  extra: z.any(),',
        '});',
      ].join('\n'));

      const result = findSchemaStrictnessViolations({
        ipcDir: join(root, 'ipc'),
        zAnyBaseline: 10,
        zUnknownBaseline: 10,
      });

      expect(result.zAny.count).toBe(2);
      expect(result.zUnknown.count).toBe(1);
    });
  });
});
