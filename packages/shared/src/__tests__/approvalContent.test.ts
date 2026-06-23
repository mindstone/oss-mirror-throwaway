import { describe, it, expect } from 'vitest';
import {
  detectConflict,
  detectChangeType,
  isLikelyBinary,
  classifyReadError,
} from '../approvalContent';

// =============================================================================
// detectConflict
// =============================================================================

describe('detectConflict', () => {
  it.each([
    // [staged, original, expected]
    ['a', 'a', false],
    ['a', 'b', true],
    ['', '', false],
    ['', 'x', true],
    ['x', '', true],
    // Whitespace-only differences count as conflict (meaningful bytes).
    ['hello\nworld\n', 'hello\nworld', true],
    // CRLF vs LF: different bytes → conflict.
    ['hello\r\nworld', 'hello\nworld', true],
    // Unicode surrogate pairs identical → no conflict.
    ['🎉 party', '🎉 party', false],
    // Unicode differing → conflict.
    ['🎉 party', '🎊 party', true],
    // Tabs vs spaces → conflict.
    ['line\ta', 'line a', true],
  ])('staged=%p original=%p → %p', (staged, original, expected) => {
    expect(detectConflict(staged, original)).toBe(expected);
  });

  it.each([
    // Null on either side → false (not a conflict; it's create/delete).
    [null, 'x', false],
    ['x', null, false],
    [null, null, false],
    [null, '', false],
    ['', null, false],
  ])('staged=%p original=%p (null handling) → %p', (staged, original, expected) => {
    expect(detectConflict(staged, original)).toBe(expected);
  });
});

// =============================================================================
// detectChangeType
// =============================================================================

describe('detectChangeType', () => {
  it('returns create when original does not exist on disk', () => {
    expect(detectChangeType('new content', null, false)).toBe('create');
    expect(detectChangeType('', null, false)).toBe('create');
    // Even if `_original` is non-null but existsOnDisk=false, the flag wins.
    expect(detectChangeType('x', 'y', false)).toBe('create');
  });

  it('returns delete when staged is null and original exists', () => {
    expect(detectChangeType(null, 'current content', true)).toBe('delete');
    expect(detectChangeType(null, '', true)).toBe('delete');
  });

  it('returns modify when both sides exist', () => {
    expect(detectChangeType('new', 'old', true)).toBe('modify');
    expect(detectChangeType('same', 'same', true)).toBe('modify');
    expect(detectChangeType('', 'old', true)).toBe('modify');
  });

  it('null staged + missing disk → create (create beats delete)', () => {
    // Corner case: if both signals point away (staged=null AND no disk), we
    // prefer create because "remote missing" is the stronger signal.
    expect(detectChangeType(null, null, false)).toBe('create');
  });
});

// =============================================================================
// isLikelyBinary
// =============================================================================

describe('isLikelyBinary', () => {
  it.each([
    // Common binary extensions — full paths
    ['/foo/bar/image.png', true],
    ['assets/logo.jpg', true],
    ['video.mp4', true],
    ['/tmp/archive.zip', true],
    ['C:\\Users\\x\\doc.pdf', true],
    ['/etc/fonts/nice.woff2', true],
    ['library/budget.xlsx', true],
    ['cache/app.sqlite', true],
    ['assets/font.ttf', true],
    // Case-insensitive
    ['IMAGE.PNG', true],
    ['report.PDF', true],
    // Uncommon-but-included
    ['package.dmg', true],
    ['libs/native.so', true],
    // Bare extension forms
    ['.zip', true],
    ['.png', true],
    // No leading dot - treated as bare extension
    ['mp3', true],
  ])('%p → true (binary)', (input) => {
    expect(isLikelyBinary(input)).toBe(true);
  });

  it.each([
    // Text files are NOT binary
    ['notes.md', false],
    ['README.md', false],
    ['index.ts', false],
    ['app.tsx', false],
    ['style.css', false],
    ['data.json', false],
    ['main.py', false],
    ['config.yaml', false],
    ['doc.html', false],
    ['data.xml', false],
    ['script.sh', false],
    // SVG is text (XML) — allow diffing
    ['icon.svg', false],
    // Dotfiles without a "real" extension
    ['.gitignore', false],
    ['.env', false],
    // No dot at all and not a bare extension
    ['Makefile', false],
    ['', false],
    // Dot-only basename: treated as bare ext — ".." doesn't match any allowlist entry
    ['..', false],
    // Path with parent dir containing a dot (should NOT match)
    ['/foo.bar/notes.md', false],
    // SVG is intentionally text-like
    ['icon.svg', false],
  ])('%p → false (not binary)', (input) => {
    expect(isLikelyBinary(input)).toBe(false);
  });

  it('handles query/fragment suffixes defensively', () => {
    expect(isLikelyBinary('image.png?v=1')).toBe(true);
    expect(isLikelyBinary('notes.md#heading')).toBe(false);
  });
});

// =============================================================================
// classifyReadError
// =============================================================================

describe('classifyReadError', () => {
  it('recognizes ENOENT by ErrnoException.code', () => {
    const err = Object.assign(new Error('something'), { code: 'ENOENT' });
    const result = classifyReadError(err);
    expect(result.kind).toBe('missing');
    expect(result.detail).toContain('something');
  });

  it('recognizes ENOENT from message text when code is lost through IPC', () => {
    expect(classifyReadError(new Error('ENOENT: no such file or directory')).kind).toBe('missing');
    expect(classifyReadError(new Error('File does not exist: /foo')).kind).toBe('missing');
    expect(classifyReadError(new Error('requested path not found')).kind).toBe('missing');
    expect(classifyReadError(new Error('No such file')).kind).toBe('missing');
  });

  it('recognizes EACCES/EPERM by ErrnoException.code', () => {
    expect(classifyReadError(Object.assign(new Error('x'), { code: 'EACCES' })).kind).toBe('permission');
    expect(classifyReadError(Object.assign(new Error('x'), { code: 'EPERM' })).kind).toBe('permission');
  });

  it('recognizes permission errors from message text', () => {
    expect(classifyReadError(new Error('EACCES: permission denied')).kind).toBe('permission');
    expect(classifyReadError(new Error('EPERM: operation not permitted')).kind).toBe('permission');
    expect(classifyReadError(new Error('Permission denied')).kind).toBe('permission');
  });

  it('recognizes network errors', () => {
    expect(classifyReadError(new Error('Failed to fetch')).kind).toBe('network');
    expect(classifyReadError(new Error('Network request failed')).kind).toBe('network');
    expect(classifyReadError(new Error('ETIMEDOUT')).kind).toBe('network');
    expect(classifyReadError(new Error('ECONNRESET')).kind).toBe('network');
    expect(classifyReadError(new Error('ECONNREFUSED')).kind).toBe('network');
    expect(classifyReadError(new Error('Timed out after 10s')).kind).toBe('network');
    expect(classifyReadError(new Error('network unreachable')).kind).toBe('network');
  });

  it('falls back to "other" when no pattern matches', () => {
    expect(classifyReadError(new Error('Something odd happened')).kind).toBe('other');
    expect(classifyReadError('string error').kind).toBe('other');
    expect(classifyReadError(undefined).kind).toBe('other');
    expect(classifyReadError(null).kind).toBe('other');
    expect(classifyReadError({}).kind).toBe('other');
  });

  it('preserves a human-readable detail string', () => {
    const result = classifyReadError(new Error('Custom detail text'));
    expect(result.detail).toBe('Custom detail text');
  });

  it('AbortError classifies as other', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifyReadError(abort).kind).toBe('other');
  });

  it('prefers code over message text when both present', () => {
    // Errno-like error where message mentions permission but code says ENOENT
    // → code wins.
    const err = Object.assign(new Error('permission denied'), { code: 'ENOENT' });
    expect(classifyReadError(err).kind).toBe('missing');
  });

  it('handles non-Error inputs without crashing', () => {
    expect(() => classifyReadError(42)).not.toThrow();
    expect(classifyReadError(42).kind).toBe('other');
  });
});
