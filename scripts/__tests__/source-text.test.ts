import { describe, expect, it } from 'vitest';
import { isProductionSourcePath, stripComments } from '../lib/source-text';

describe('isProductionSourcePath', () => {
  it.each([
    ['src/services/agent.ts', true],
    ['src/__tests__/agent.test.ts', false],
    ['src/services/agent.test.ts', false],
    ['src/services/agent.spec.ts', false],
    ['src/components/Button.stories.tsx', false],
    ['src/core/__lint_fixtures__/case.fixture.ts', false],
    ['src\\__tests__\\agent.ts', false],
    ['cloud-service/src/server.ts', true],
  ])('classifies %s as production=%s', (path, expected) => {
    expect(isProductionSourcePath(path)).toBe(expected);
  });
});

describe('stripComments', () => {
  it('strips line comments to end-of-line', () => {
    const source = 'const x = 1; // comment with z.unknown()\nconst y = 2;';
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/z\.unknown\(\)/);
    expect(stripped).toMatch(/const x = 1;\s+/);
    expect(stripped).toMatch(/const y = 2;/);
  });

  it('strips block comments', () => {
    const source = '/* z.unknown() in a block comment */\nconst x = 1;';
    expect(stripComments(source)).not.toMatch(/z\.unknown/);
  });

  it('preserves line numbers across block comments', () => {
    const source = ['line1', '/* comment', 'spans lines', '*/', 'line5'].join('\n');
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(5);
    expect(stripped.split('\n')[0]).toBe('line1');
    expect(stripped.split('\n')[4]).toBe('line5');
  });

  it('preserves string literal content (single quote)', () => {
    const source = "const x = 'eslint-disable inside string';";
    expect(stripComments(source)).toContain('eslint-disable');
  });

  it('preserves string literal content (double quote)', () => {
    const source = 'const x = "z.unknown() inside string";';
    expect(stripComments(source)).toContain('z.unknown()');
  });

  it('preserves template literal content', () => {
    const source = 'const x = `template with z.unknown() inside`;';
    expect(stripComments(source)).toContain('z.unknown()');
  });

  it('handles escaped quotes inside strings', () => {
    const source = "const x = 'it\\'s fine // not a comment';";
    expect(stripComments(source)).toContain('// not a comment');
  });

  it('treats /* inside a string as part of the string', () => {
    const source = 'const x = "/* not a comment */ z.unknown()";';
    expect(stripComments(source)).toContain('z.unknown()');
  });

  it('handles eslint-disable directive in line comment (still stripped — caller must handle separately)', () => {
    const source = '// eslint-disable-next-line foo\nconst x = 1;';
    expect(stripComments(source)).not.toMatch(/eslint-disable/);
  });

  it('preserves whitespace alignment for column accuracy', () => {
    const source = 'const x = 1; // tail';
    const stripped = stripComments(source);
    expect(stripped.length).toBe(source.length);
  });

  it('handles unterminated block comment by consuming to end of input', () => {
    const source = 'const x = 1; /* unterminated';
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/unterminated/);
  });

  it('does not match z.unknown() that lives inside a doc comment', () => {
    const source = [
      '/**',
      ' * Use JsonValueSchema instead of z.unknown() for typed metadata.',
      ' */',
      'export const Foo = z.string();',
    ].join('\n');
    expect(stripComments(source)).not.toMatch(/z\.unknown/);
    expect(stripComments(source)).toMatch(/z\.string/);
  });
});
