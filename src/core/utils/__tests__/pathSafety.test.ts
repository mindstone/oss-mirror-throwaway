import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PathSafetyError,
  assertWithinRoot,
  isWindowsDangerousPath,
  isWithinRoot,
  rejectDangerousPath,
} from '../pathSafety';

describe('pathSafety.rejectDangerousPath', () => {
  describe('null / empty / overlong inputs', () => {
    it('rejects empty string', () => {
      expect(() => rejectDangerousPath('')).toThrow(PathSafetyError);
      try { rejectDangerousPath(''); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('empty_path');
      }
    });

    it('rejects undefined/number input as non-string', () => {
      // @ts-expect-error -- deliberate type violation for defensive check
      expect(() => rejectDangerousPath(undefined)).toThrow(PathSafetyError);
      // @ts-expect-error -- deliberate type violation
      expect(() => rejectDangerousPath(42)).toThrow(PathSafetyError);
    });

    it('rejects null byte', () => {
      try { rejectDangerousPath('foo\0bar'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('null_byte');
      }
    });

    it('rejects overlong path', () => {
      const overlong = 'a/'.repeat(3000) + 'x';
      try { rejectDangerousPath(overlong); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('too_long');
      }
    });
  });

  describe('Windows UNC and device paths', () => {
    it('rejects UNC share path (\\\\server\\share\\file)', () => {
      try { rejectDangerousPath('\\\\server\\share\\file.txt'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('unc_path');
      }
    });

    it('rejects UNC with forward slashes (//server/share/file)', () => {
      try { rejectDangerousPath('//server/share/file.txt'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('unc_path');
      }
    });

    it('rejects device namespace (\\\\?\\C:\\Windows\\System32\\config\\SAM)', () => {
      try { rejectDangerousPath('\\\\?\\C:\\Windows\\System32\\config\\SAM'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('device_path');
      }
    });

    it('rejects local device namespace (\\\\.\\pipe\\foo)', () => {
      try { rejectDangerousPath('\\\\.\\pipe\\foo'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('device_path');
      }
    });
  });

  describe('URL schemes', () => {
    it('rejects file:// URL', () => {
      try { rejectDangerousPath('file:///etc/passwd'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('url_scheme');
      }
    });

    it('rejects data URL', () => {
      try { rejectDangerousPath('data:text/plain;base64,AAAA'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('url_scheme');
      }
    });

    it('rejects http URL', () => {
      try { rejectDangerousPath('http://evil.com/file'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('url_scheme');
      }
    });

    it('allows path with colon that is not a scheme (relative windows drive-less path)', () => {
      // A bare ":" with no preceding scheme characters is not a scheme.
      expect(() => rejectDangerousPath('foo/bar:baz.txt')).not.toThrow();
    });
  });

  describe('absolute paths', () => {
    it('rejects absolute path by default', () => {
      const abs = process.platform === 'win32' ? 'C:\\Windows\\file.txt' : '/etc/passwd';
      try { rejectDangerousPath(abs); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('absolute_path');
      }
    });

    it('allows absolute path when allowAbsolute=true', () => {
      const abs = process.platform === 'win32' ? 'C:\\Users\\Public\\file.txt' : '/tmp/file.txt';
      expect(() => rejectDangerousPath(abs, { allowAbsolute: true })).not.toThrow();
    });
  });

  describe('parent-directory escapes', () => {
    it('rejects path with .. segment', () => {
      try { rejectDangerousPath('foo/../bar'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('parent_escape');
      }
    });

    it('rejects bare ..', () => {
      try { rejectDangerousPath('..'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('parent_escape');
      }
    });

    it('rejects leading ..', () => {
      try { rejectDangerousPath('../foo'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('parent_escape');
      }
    });

    it('rejects parent-escape with backslashes', () => {
      try { rejectDangerousPath('foo\\..\\bar'); } catch (e) {
        expect((e as PathSafetyError).reason).toBe('parent_escape');
      }
    });

    it('allows ".." as a substring inside a segment (e.g. file..name)', () => {
      expect(() => rejectDangerousPath('foo/bar..baz/file.txt')).not.toThrow();
    });
  });

  describe('legitimate relative paths', () => {
    it('accepts simple relative path', () => {
      expect(() => rejectDangerousPath('foo/bar.txt')).not.toThrow();
    });

    it('accepts dotfile', () => {
      expect(() => rejectDangerousPath('.gitignore')).not.toThrow();
    });

    it('accepts nested relative path', () => {
      expect(() => rejectDangerousPath('a/b/c/d/file.txt')).not.toThrow();
    });

    it('accepts current-dir prefix', () => {
      expect(() => rejectDangerousPath('./foo.txt')).not.toThrow();
    });
  });
});

describe('pathSafety.isWindowsDangerousPath', () => {
  it('returns true for UNC paths', () => {
    expect(isWindowsDangerousPath('\\\\server\\share')).toBe(true);
    expect(isWindowsDangerousPath('//server/share')).toBe(true);
  });

  it('returns true for device paths', () => {
    expect(isWindowsDangerousPath('\\\\?\\C:\\foo')).toBe(true);
    expect(isWindowsDangerousPath('\\\\.\\pipe\\foo')).toBe(true);
  });

  it('returns false for normal relative paths', () => {
    expect(isWindowsDangerousPath('foo/bar')).toBe(false);
    expect(isWindowsDangerousPath('foo\\bar')).toBe(false);
  });

  it('returns false for absolute POSIX path', () => {
    expect(isWindowsDangerousPath('/etc/passwd')).toBe(false);
  });

  it('returns false for absolute Windows path (single slash, has drive letter)', () => {
    expect(isWindowsDangerousPath('C:\\Users\\Public')).toBe(false);
  });
});

describe('pathSafety.assertWithinRoot', () => {
  const root = process.platform === 'win32' ? 'C:\\data\\sandbox' : '/data/sandbox';
  const sep = path.sep;

  it('accepts path equal to root', () => {
    expect(() => assertWithinRoot(root, root)).not.toThrow();
  });

  it('accepts path deep inside root', () => {
    const deep = `${root}${sep}sub${sep}dir${sep}file.txt`;
    expect(() => assertWithinRoot(deep, root)).not.toThrow();
  });

  it('rejects path outside root', () => {
    const outside = process.platform === 'win32' ? 'C:\\data\\other\\file.txt' : '/data/other/file.txt';
    try { assertWithinRoot(outside, root); } catch (e) {
      expect((e as PathSafetyError).reason).toBe('root_escape');
    }
  });

  it('rejects sibling with same prefix (prevents /foo vs /foobar)', () => {
    const sibling = process.platform === 'win32' ? 'C:\\data\\sandbox2\\file.txt' : '/data/sandbox2/file.txt';
    try { assertWithinRoot(sibling, root); } catch (e) {
      expect((e as PathSafetyError).reason).toBe('root_escape');
    }
  });

  it('rejects non-absolute resolved path', () => {
    try { assertWithinRoot('relative/path', root); } catch (e) {
      expect((e as PathSafetyError).reason).toBe('root_escape');
    }
  });

  it('rejects non-absolute root', () => {
    try { assertWithinRoot(root, 'relative/root'); } catch (e) {
      expect((e as PathSafetyError).reason).toBe('root_escape');
    }
  });

  it('is idempotent to trailing separator on root', () => {
    const deep = `${root}${sep}file.txt`;
    const rootWithTrailingSep = `${root}${sep}`;
    expect(() => assertWithinRoot(deep, rootWithTrailingSep)).not.toThrow();
  });
});

describe('pathSafety.isWithinRoot (approved lexical-containment predicate)', () => {
  const sep = path.sep;
  const root = path.resolve('/var/data/app');

  it('returns true for the root itself', () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it('returns true for a descendant', () => {
    expect(isWithinRoot(`${root}${sep}sub${sep}file.txt`, root)).toBe(true);
  });

  it('returns true regardless of a trailing separator on the root', () => {
    expect(isWithinRoot(`${root}${sep}file.txt`, `${root}${sep}`)).toBe(true);
  });

  // The whole point of the helper: a bare `startsWith(root)` would wrongly say a
  // sibling whose name merely has the root as a prefix is "inside" the root.
  it('returns false for a sibling that only shares a name prefix (the bypass class)', () => {
    expect(isWithinRoot(path.resolve('/var/data/application'), root)).toBe(false);
    expect(isWithinRoot(path.resolve('/var/data/app-2'), root)).toBe(false);
  });

  it('returns false for a parent or an unrelated path', () => {
    expect(isWithinRoot(path.resolve('/var/data'), root)).toBe(false);
    expect(isWithinRoot(path.resolve('/etc/passwd'), root)).toBe(false);
  });

  it('throws on a non-absolute argument (contract violation, never silent false)', () => {
    expect(() => isWithinRoot('relative/path', root)).toThrow(PathSafetyError);
    expect(() => isWithinRoot(root, 'relative/root')).toThrow(PathSafetyError);
  });

  it('assertWithinRoot and isWithinRoot agree (assert throws iff predicate is false)', () => {
    const within = `${root}${sep}ok.txt`;
    const outside = path.resolve('/var/data/application');
    expect(isWithinRoot(within, root)).toBe(true);
    expect(() => assertWithinRoot(within, root)).not.toThrow();
    expect(isWithinRoot(outside, root)).toBe(false);
    expect(() => assertWithinRoot(outside, root)).toThrow(PathSafetyError);
  });
});
