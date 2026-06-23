import {
  extractLibraryPath,
  getLibraryProtocol,
  isLibraryUrl,
  parseFileUrl,
  stripQueryAndFragmentFromPath,
} from '../libraryUrls';

describe('libraryUrls', () => {
  describe('getLibraryProtocol', () => {
    it('matches the canonical rebel://library/ form (Stage H)', () => {
      expect(getLibraryProtocol('rebel://library/file.md')).toBe('rebel://library/');
      expect(getLibraryProtocol('REBEL://LIBRARY/file.md')).toBe('rebel://library/');
      expect(getLibraryProtocol('Rebel://Library/file.md')).toBe('rebel://library/');
    });

    it('matches library:// case-insensitively and returns lowercase (legacy)', () => {
      expect(getLibraryProtocol('library://file.md')).toBe('library://');
      expect(getLibraryProtocol('LIBRARY://file.md')).toBe('library://');
      expect(getLibraryProtocol('Library://file.md')).toBe('library://');
    });

    it('matches workspace:// case-insensitively and returns lowercase (legacy)', () => {
      expect(getLibraryProtocol('workspace://file.md')).toBe('workspace://');
      expect(getLibraryProtocol('WORKSPACE://file.md')).toBe('workspace://');
      expect(getLibraryProtocol('Workspace://file.md')).toBe('workspace://');
    });

    it('returns null for non-library rebel:// subprotocols', () => {
      expect(getLibraryProtocol('rebel://conversation/123')).toBeNull();
      expect(getLibraryProtocol('rebel://space/Exec/q1.md')).toBeNull();
      expect(getLibraryProtocol('rebel://action/start-voice')).toBeNull();
    });

    it('returns null for non-library protocols', () => {
      expect(getLibraryProtocol('http://example.com')).toBeNull();
      expect(getLibraryProtocol('file:///tmp/test.md')).toBeNull();
      expect(getLibraryProtocol('')).toBeNull();
      expect(getLibraryProtocol(undefined)).toBeNull();
    });
  });

  describe('isLibraryUrl', () => {
    it('returns true for library/workspace URLs only', () => {
      expect(isLibraryUrl('library://file.md')).toBe(true);
      expect(isLibraryUrl('WORKSPACE://file.md')).toBe(true);
      expect(isLibraryUrl('https://example.com')).toBe(false);
      expect(isLibraryUrl(null)).toBe(false);
    });
  });

  describe('extractLibraryPath', () => {
    it('extracts from canonical rebel://library/ form (Stage H)', () => {
      expect(extractLibraryPath('rebel://library/docs%2Ffile.md')).toBe('docs/file.md');
      expect(extractLibraryPath('rebel://library/file.md')).toBe('file.md');
    });

    it('decodes percent-encoded paths', () => {
      expect(extractLibraryPath('library://%2Fpath%2Ffile.md')).toBe('/path/file.md');
    });

    it('supports legacy workspace:// paths', () => {
      expect(extractLibraryPath('Workspace://foo/bar.md')).toBe('foo/bar.md');
    });

    it('strips trailing markdown punctuation', () => {
      expect(extractLibraryPath('library://foo.md)')).toBe('foo.md');
      expect(extractLibraryPath('library://foo.md]')).toBe('foo.md');
      expect(extractLibraryPath('library://foo.md}>')).toBe('foo.md');
      expect(extractLibraryPath('library://foo.md)]}>')).toBe('foo.md');
    });

    // Inherited-gap fix: previously `/[)\]}>]+$/` blindly stripped every trailing
    // closer, which clobbered legitimate paths like `notes(v2)` → `notes(v2`.
    // The balanced-pair algorithm preserves the path when parens are balanced
    // but still strips unbalanced wrappers added by markdown autolinkers.
    it('preserves balanced brackets inside the path (inherited-gap fix)', () => {
      expect(extractLibraryPath('library://notes(v2)')).toBe('notes(v2)');
      expect(extractLibraryPath('library://file(copy).md')).toBe('file(copy).md');
      expect(extractLibraryPath('library://a[1].md')).toBe('a[1].md');
      expect(extractLibraryPath('library://foo{bar}.md')).toBe('foo{bar}.md');
    });

    it('strips only the unbalanced wrapper closers', () => {
      // `(see [x](library://notes(v2)))` → URL token ends with an extra `)`
      expect(extractLibraryPath('library://notes(v2))')).toBe('notes(v2)');
      expect(extractLibraryPath('library://a[1]]')).toBe('a[1]');
      expect(extractLibraryPath('library://foo{bar}}')).toBe('foo{bar}');
    });

    it('falls back to the raw path on malformed encoding', () => {
      expect(extractLibraryPath('library://%G')).toBe('%G');
    });

    it('returns null for non-library URLs', () => {
      expect(extractLibraryPath('https://example.com')).toBeNull();
      expect(extractLibraryPath('file:///tmp/test.md')).toBeNull();
    });
  });

  describe('stripQueryAndFragmentFromPath', () => {
    it('strips queries and fragments in either order', () => {
      expect(stripQueryAndFragmentFromPath('docs/file.md#heading')).toBe('docs/file.md');
      expect(stripQueryAndFragmentFromPath('docs/file.md?line=42')).toBe('docs/file.md');
      expect(stripQueryAndFragmentFromPath('docs/file.md?line=42#heading')).toBe('docs/file.md');
      expect(stripQueryAndFragmentFromPath('docs/file.md#heading?line=42')).toBe('docs/file.md');
    });

    it('returns unchanged paths when there is no query or fragment', () => {
      expect(stripQueryAndFragmentFromPath('docs/file.md')).toBe('docs/file.md');
    });
  });

  describe('parseFileUrl', () => {
    it('parses unix file URLs', () => {
      expect(parseFileUrl('file:///Users/you/Dropbox/skills/demo-script.md')).toEqual({
        path: '/Users/you/Dropbox/skills/demo-script.md',
        isUnc: false,
      });
    });

    it('parses windows drive-letter URLs', () => {
      expect(parseFileUrl('file:///C:/Users/test/Documents/file.md')).toEqual({
        path: 'C:/Users/test/Documents/file.md',
        isUnc: false,
      });
    });

    it('decodes encoded file paths', () => {
      expect(parseFileUrl('file:///Users/test/My%20Documents/file%20name.md')).toEqual({
        path: '/Users/test/My Documents/file name.md',
        isUnc: false,
      });
    });

    it('drops localhost hostnames', () => {
      expect(parseFileUrl('file://localhost/Users/you/docs/file.md')).toEqual({
        path: '/Users/you/docs/file.md',
        isUnc: false,
      });
    });

    it('reconstructs UNC paths from hostnames', () => {
      expect(parseFileUrl('file://server/share/path/file.md')).toEqual({
        path: '\\\\server\\share\\path\\file.md',
        isUnc: true,
      });
    });

    it('returns null for non-file URLs', () => {
      expect(parseFileUrl('library://docs/file.md')).toBeNull();
    });

    it('does not throw on malformed percent encoding', () => {
      // Regression: unguarded decodeURIComponent would throw on bad escape sequences.
      // A thrown error crashes the mobile onLinkPress handler — see Stage 2 review.
      expect(() => parseFileUrl('file:///tmp/%G.md')).not.toThrow();
      const result = parseFileUrl('file:///tmp/%G.md');
      expect(result).not.toBeNull();
      expect(result?.isUnc).toBe(false);
    });

    it('does not throw on malformed URL with bad percent encoding in UNC fallback', () => {
      // The URL constructor succeeds but pathname decode might fail; safeDecode catches it.
      expect(() => parseFileUrl('file:///tmp/%XYZ')).not.toThrow();
    });
  });
});
