import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinPortablePath, relativePortablePath, toPortablePath } from '@core/utils/portablePath';

describe('toPortablePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPortablePath('foo\\bar\\baz')).toBe('foo/bar/baz');
  });

  it('leaves forward slashes unchanged', () => {
    expect(toPortablePath('foo/bar/baz')).toBe('foo/bar/baz');
  });

  it('handles mixed separators', () => {
    expect(toPortablePath('foo\\bar/baz\\qux')).toBe('foo/bar/baz/qux');
  });

  it('handles empty string', () => {
    expect(toPortablePath('')).toBe('');
  });

  it('handles Windows-style absolute path', () => {
    expect(toPortablePath('C:\\Users\\greg\\Documents')).toBe('C:/Users/you/Documents');
  });

  it('handles UNC path', () => {
    expect(toPortablePath('\\\\server\\share\\file.txt')).toBe('//server/share/file.txt');
  });

  it('does not collapse consecutive slashes', () => {
    expect(toPortablePath('foo//bar')).toBe('foo//bar');
  });

  it('does not resolve . or ..', () => {
    expect(toPortablePath('foo\\..\\bar\\.\\baz')).toBe('foo/../bar/./baz');
  });
});

describe('relativePortablePath', () => {
  it('computes a relative path with forward slashes', () => {
    const from = path.join('home', 'user', 'workspace');
    const to = path.join('home', 'user', 'workspace', 'src', 'file.ts');
    expect(relativePortablePath(from, to)).toBe('src/file.ts');
  });

  it('handles upward traversal', () => {
    const from = path.join('home', 'user', 'workspace', 'src');
    const to = path.join('home', 'user', 'workspace', 'docs', 'readme.md');
    expect(relativePortablePath(from, to)).toBe('../docs/readme.md');
  });

  it('returns empty for same path', () => {
    const p = path.join('home', 'user');
    expect(relativePortablePath(p, p)).toBe('');
  });

  it('handles deeply nested paths', () => {
    const from = path.join('a', 'b', 'c');
    const to = path.join('a', 'b', 'c', 'd', 'e', 'f.txt');
    expect(relativePortablePath(from, to)).toBe('d/e/f.txt');
  });
});

describe('joinPortablePath', () => {
  it('joins segments with forward slashes', () => {
    expect(joinPortablePath('memory', 'sources', 'file.txt')).toBe('memory/sources/file.txt');
  });

  it('resolves . segments', () => {
    expect(joinPortablePath('foo', '.', 'bar')).toBe('foo/bar');
  });

  it('resolves .. segments', () => {
    expect(joinPortablePath('foo', 'bar', '..', 'baz')).toBe('foo/baz');
  });

  it('collapses duplicate slashes', () => {
    expect(joinPortablePath('foo/', '/bar')).toBe('foo/bar');
  });

  it('filters out empty segments', () => {
    expect(joinPortablePath('foo', '', 'bar', '', 'baz')).toBe('foo/bar/baz');
  });

  it('handles single segment', () => {
    expect(joinPortablePath('foo')).toBe('foo');
  });

  it('returns . for no non-empty parts', () => {
    expect(joinPortablePath('', '')).toBe('.');
  });
});
