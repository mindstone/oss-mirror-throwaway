import { describe, it, expect } from 'vitest';
import {
  yamlEscape,
  parsePendingFile,
  serializePendingFile,
  generatePendingFilename,
  validateDestination,
  type PendingFileFrontmatter,
} from '../cosPendingService';

// ---------------------------------------------------------------------------
// yamlEscape
// ---------------------------------------------------------------------------
describe('yamlEscape', () => {
  it('returns simple strings unquoted', () => {
    expect(yamlEscape('hello')).toBe('hello');
    expect(yamlEscape('Chief-of-Staff')).toBe('Chief-of-Staff');
    expect(yamlEscape('simple_value')).toBe('simple_value');
  });

  it('quotes strings with YAML structural indicators', () => {
    // Starts with "- "
    expect(yamlEscape('- list item')).toMatch(/^"/);
    // Starts with "> "
    expect(yamlEscape('> block quote')).toMatch(/^"/);
    // Starts with ":"
    expect(yamlEscape(': colon start')).toMatch(/^"/);
    // Starts with "? "
    expect(yamlEscape('? question')).toMatch(/^"/);
  });

  it('escapes strings with newlines and internal double quotes', () => {
    const withNewline = yamlEscape('line1\nline2');
    expect(withNewline).toBe('"line1\\nline2"');

    const withQuotes = yamlEscape('say "hello"');
    expect(withQuotes).toBe('"say \\"hello\\""');
  });

  it('handles empty string', () => {
    expect(yamlEscape('')).toBe('');
  });

  it('quotes YAML boolean-like values', () => {
    expect(yamlEscape('true')).toBe('"true"');
    expect(yamlEscape('false')).toBe('"false"');
    expect(yamlEscape('null')).toBe('"null"');
  });

  it('quotes numeric-like values', () => {
    expect(yamlEscape('42')).toBe('"42"');
    expect(yamlEscape('3.14')).toBe('"3.14"');
  });

  it('quotes strings with special YAML characters', () => {
    expect(yamlEscape('key: value')).toMatch(/^"/);
    expect(yamlEscape('a # comment')).toMatch(/^"/);
    expect(yamlEscape('item & other')).toMatch(/^"/);
    expect(yamlEscape('*alias')).toMatch(/^"/);
  });
});

// ---------------------------------------------------------------------------
// parsePendingFile
// ---------------------------------------------------------------------------
describe('parsePendingFile', () => {
  const validMarkdown = [
    '---',
    'pending_destination: Chief-of-Staff/memory/topics/meeting-notes.md',
    'staged_at: "2026-04-06T10:00:00.000Z"',
    'session_id: session-abc-123',
    'summary: Meeting notes from standup',
    'original_space: Chief-of-Staff',
    'base_hash: abc123def456',
    '---',
    '',
    '# Meeting Notes',
    '',
    'Discussed project timeline.',
  ].join('\n');

  it('parses valid markdown with all required frontmatter', () => {
    const result = parsePendingFile(validMarkdown, '/tmp/test.pending.md');

    expect(result).not.toBeNull();
    expect(result!.frontmatter.pending_destination).toBe(
      'Chief-of-Staff/memory/topics/meeting-notes.md'
    );
    expect(result!.frontmatter.staged_at).toBe('2026-04-06T10:00:00.000Z');
    expect(result!.frontmatter.session_id).toBe('session-abc-123');
    expect(result!.frontmatter.summary).toBe('Meeting notes from standup');
    expect(result!.frontmatter.original_space).toBe('Chief-of-Staff');
    expect(result!.frontmatter.base_hash).toBe('abc123def456');
  });

  it('returns null for missing required fields', () => {
    const missingDestination = [
      '---',
      'staged_at: "2026-04-06T10:00:00.000Z"',
      'session_id: session-abc-123',
      '---',
      '',
      'Some content',
    ].join('\n');

    expect(parsePendingFile(missingDestination, '/tmp/test.pending.md')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    const malformed = [
      '---',
      'pending_destination: [invalid yaml',
      '  : broken indentation',
      '---',
      '',
      'Content',
    ].join('\n');

    expect(parsePendingFile(malformed, '/tmp/test.pending.md')).toBeNull();
  });

  it('extracts content body correctly', () => {
    const result = parsePendingFile(validMarkdown, '/tmp/test.pending.md');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('# Meeting Notes');
    expect(result!.content).toContain('Discussed project timeline.');
    // Content should NOT contain frontmatter delimiters
    expect(result!.content).not.toContain('pending_destination:');
  });

  it('defaults summary and original_space when missing', () => {
    const minimalValid = [
      '---',
      'pending_destination: some/path.md',
      'staged_at: "2026-04-06T10:00:00.000Z"',
      'session_id: session-xyz',
      '---',
      '',
      'Content here',
    ].join('\n');

    const result = parsePendingFile(minimalValid, '/tmp/test.pending.md');

    expect(result).not.toBeNull();
    expect(result!.frontmatter.summary).toBe('Memory update');
    expect(result!.frontmatter.original_space).toBe('Unknown');
    expect(result!.frontmatter.base_hash).toBe('unknown');
  });

  it('parses blocked_by field when present', () => {
    const withBlockedBy = [
      '---',
      'pending_destination: some/path.md',
      'staged_at: "2026-04-06T10:00:00.000Z"',
      'session_id: session-xyz',
      'summary: Test',
      'original_space: Test',
      'base_hash: abc',
      'blocked_by: sensitivity_eval',
      '---',
      '',
      'Content',
    ].join('\n');

    const result = parsePendingFile(withBlockedBy, '/tmp/test.pending.md');

    expect(result).not.toBeNull();
    expect(result!.frontmatter.blocked_by).toBe('sensitivity_eval');
  });
});

// ---------------------------------------------------------------------------
// serializePendingFile
// ---------------------------------------------------------------------------
describe('serializePendingFile', () => {
  it('produces valid YAML frontmatter block', () => {
    const frontmatter: PendingFileFrontmatter = {
      pending_destination: 'work/notes.md',
      staged_at: '2026-04-06T12:00:00.000Z',
      session_id: 'session-1',
      summary: 'Test summary',
      original_space: 'Work',
      base_hash: 'hash123',
    };

    const result = serializePendingFile(frontmatter, '# Hello\n\nWorld');

    expect(result).toMatch(/^---\n/);
    expect(result).toContain('pending_destination: work/notes.md');
    expect(result).toContain('session_id: session-1');
    expect(result).toContain('summary: Test summary');
    // The closing --- is followed by an empty line then content
    expect(result).toContain('# Hello\n\nWorld');
    // Verify the YAML block structure: opens and closes with ---
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines.indexOf('---', 1)).toBeGreaterThan(0);
  });

  it('includes optional fields when present', () => {
    const frontmatter: PendingFileFrontmatter = {
      pending_destination: 'work/notes.md',
      staged_at: '2026-04-06T12:00:00.000Z',
      session_id: 'session-1',
      summary: 'Test',
      original_space: 'Work',
      base_hash: 'hash123',
      blocked_by: 'safety_prompt',
      pending_transcript_meta: '{"key":"value"}',
    };

    const result = serializePendingFile(frontmatter, 'content');

    expect(result).toContain('blocked_by:');
    expect(result).toContain('pending_transcript_meta:');
  });

  it('roundtrips with parsePendingFile', () => {
    const originalFrontmatter: PendingFileFrontmatter = {
      pending_destination: 'Chief-of-Staff/memory/topics/test.md',
      staged_at: '2026-04-06T14:30:00.000Z',
      session_id: 'roundtrip-session',
      summary: 'Roundtrip test with special chars: "hello" & world',
      original_space: 'Chief-of-Staff',
      base_hash: 'roundtrip-hash-abc',
    };
    const originalContent = '# Test Document\n\nThis is a test with **bold** text.\n';

    const serialized = serializePendingFile(originalFrontmatter, originalContent);
    const parsed = parsePendingFile(serialized, '/tmp/roundtrip.pending.md');

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.pending_destination).toBe(originalFrontmatter.pending_destination);
    expect(parsed!.frontmatter.staged_at).toBe(originalFrontmatter.staged_at);
    expect(parsed!.frontmatter.session_id).toBe(originalFrontmatter.session_id);
    expect(parsed!.frontmatter.summary).toBe(originalFrontmatter.summary);
    expect(parsed!.frontmatter.original_space).toBe(originalFrontmatter.original_space);
    expect(parsed!.frontmatter.base_hash).toBe(originalFrontmatter.base_hash);
    expect(parsed!.content).toBe(originalContent);
  });

  it('roundtrips sharing field through serialize/parse', () => {
    const frontmatter: PendingFileFrontmatter = {
      pending_destination: 'work/General/notes.md',
      staged_at: '2026-04-30T09:00:00.000Z',
      session_id: 'sharing-test',
      summary: 'Test sharing roundtrip',
      original_space: 'General',
      base_hash: 'abc',
      sharing: 'company-wide',
    };

    const serialized = serializePendingFile(frontmatter, 'content');
    expect(serialized).toContain('sharing: company-wide');

    const parsed = parsePendingFile(serialized, '/tmp/sharing.pending.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.sharing).toBe('company-wide');
  });

  it('ignores invalid sharing values in frontmatter', () => {
    const markdown = [
      '---',
      'pending_destination: some/path.md',
      'staged_at: "2026-04-30T09:00:00.000Z"',
      'session_id: session-xyz',
      'summary: Test',
      'original_space: Test',
      'base_hash: abc',
      'sharing: bogus-value',
      '---',
      '',
      'Content',
    ].join('\n');

    const result = parsePendingFile(markdown, '/tmp/test.pending.md');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.sharing).toBeUndefined();
  });

  it('parses old pending files without sharing gracefully', () => {
    const markdown = [
      '---',
      'pending_destination: some/path.md',
      'staged_at: "2026-04-30T09:00:00.000Z"',
      'session_id: session-xyz',
      'summary: Test',
      'original_space: Test',
      'base_hash: abc',
      '---',
      '',
      'Content',
    ].join('\n');

    const result = parsePendingFile(markdown, '/tmp/test.pending.md');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.sharing).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generatePendingFilename
// ---------------------------------------------------------------------------
describe('generatePendingFilename', () => {
  it('produces timestamped .pending.md filename', () => {
    const result = generatePendingFilename('work/notes/meeting.md');

    // Format: YYMMDD_HHmmss_sanitized-name.pending.md
    expect(result).toMatch(/^\d{6}_\d{6}_.*\.pending\.md$/);
    expect(result).toContain('meeting');
  });

  it('sanitizes special characters in path', () => {
    const result = generatePendingFilename('work/notes/file:with*special?"chars.md');

    expect(result).not.toContain(':');
    expect(result).not.toContain('*');
    expect(result).not.toContain('?');
    expect(result).not.toContain('"');
    expect(result).toMatch(/\.pending\.md$/);
  });

  it('truncates long filenames', () => {
    const longName = 'a'.repeat(200) + '.md';
    const result = generatePendingFilename(longName);

    // The sanitized basename portion should be truncated to 50 chars
    // Total format: YYMMDD_HHmmss_ + (up to 50 chars) + _HASH(6) + .pending.md
    // 6 + 1 + 6 + 1 + 50 + 1 + 6 + 11 = 82 max
    expect(result.length).toBeLessThanOrEqual(82);
    expect(result).toMatch(/\.pending\.md$/);
  });

  it('handles paths without extension', () => {
    const result = generatePendingFilename('work/Makefile');

    expect(result).toMatch(/\.pending\.md$/);
    expect(result).toContain('Makefile');
  });

  it('falls back to "memory" when basename is empty after sanitization', () => {
    // All chars in basename are special characters
    const result = generatePendingFilename('/:*?"<>|.md');

    expect(result).toContain('memory');
    expect(result).toMatch(/\.pending\.md$/);
  });
});

// ---------------------------------------------------------------------------
// validateDestination
// ---------------------------------------------------------------------------
describe('validateDestination', () => {
  // Use a test workspace path appropriate for the current platform
  const coreDirectory = process.platform === 'win32'
    ? 'C:\\Users\\test\\workspace'
    : '/home/test/workspace';

  it('returns true for paths within workspace', () => {
    expect(validateDestination('Chief-of-Staff/memory/test.md', coreDirectory)).toBe(true);
    expect(validateDestination('work/Acme/notes.md', coreDirectory)).toBe(true);
  });

  it('returns false for path traversal attempts', () => {
    // Relative path traversal
    expect(validateDestination('../../../etc/passwd', coreDirectory)).toBe(false);
    expect(validateDestination('work/../../outside.md', coreDirectory)).toBe(false);
  });

  it('returns false for paths in rebel-system (protected)', () => {
    expect(validateDestination('rebel-system/config.md', coreDirectory)).toBe(false);
  });

  it('accepts absolute paths within workspace', () => {
    const absoluteInWorkspace = process.platform === 'win32'
      ? 'C:\\Users\\test\\workspace\\notes\\file.md'
      : '/home/test/workspace/notes/file.md';

    expect(validateDestination(absoluteInWorkspace, coreDirectory)).toBe(true);
  });

  it('rejects absolute paths outside workspace', () => {
    const absoluteOutside = process.platform === 'win32'
      ? 'C:\\Users\\other\\secrets.md'
      : '/home/other/secrets.md';

    expect(validateDestination(absoluteOutside, coreDirectory)).toBe(false);
  });
});
