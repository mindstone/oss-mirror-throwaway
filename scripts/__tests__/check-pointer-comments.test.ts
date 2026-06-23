import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPointerComments,
  findPointerCommentsInSource,
} from '../check-pointer-comments';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pointer-comments-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFixture(relativePath: string, contents: string): void {
  const absolutePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

describe('check-pointer-comments', () => {
  it('finds plan-doc pointers in comments without scanning strings', () => {
    const source = [
      'const notAComment = "See docs/plans/missing-from-string.md";',
      '// See docs/plans/260507_unified_interactive_ui_architecture.md § Phase A3.',
      '/*',
      ' * See docs/plans/260507_unified_interactive_ui_architecture_sequencing.md',
      ' */',
    ].join('\n');

    const pointers = findPointerCommentsInSource(source, 'src/example.ts');

    expect(pointers.map((pointer) => pointer.pointerPath)).toEqual([
      'docs/plans/260507_unified_interactive_ui_architecture.md',
      'docs/plans/260507_unified_interactive_ui_architecture_sequencing.md',
    ]);
  });

  it('passes when every plan-doc pointer resolves', async () => {
    writeFixture('docs/plans/existing.md', '# Existing plan\n');
    writeFixture(
      'src/good.ts',
      '// See docs/plans/existing.md for the contract.\nexport const ok = true;\n',
    );

    const result = await checkPointerComments({
      repoRoot: fixtureRoot,
      sourceGlobs: ['src/**/*.ts'],
    });

    expect(result.ok).toBe(true);
    expect(result.pointers).toHaveLength(1);
    expect(result.missingPointers).toEqual([]);
    expect(result.report).toContain('Pointers failed: 0');
  });

  it('fails when a comment points to a missing plan doc', async () => {
    writeFixture(
      'src/broken.ts',
      '// See docs/plans/nonexistent.md for the contract.\nexport const broken = true;\n',
    );

    const result = await checkPointerComments({
      repoRoot: fixtureRoot,
      sourceGlobs: ['src/**/*.ts'],
    });

    expect(result.ok).toBe(false);
    expect(result.missingPointers).toHaveLength(1);
    expect(result.missingPointers[0]).toMatchObject({
      pointerPath: 'docs/plans/nonexistent.md',
      line: 1,
    });
    expect(result.report).toContain('Pointers failed: 1');
  });
});
