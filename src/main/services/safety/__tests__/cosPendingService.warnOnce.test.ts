/**
 * Tests for the "warn-once-per-filePath" behaviour added in REBEL-H7a.
 *
 * Frontmatter validation in `parsePendingFile` is deterministic: a file that
 * fails once will keep failing on every refresh. Repeated warns are pure
 * noise (Hannah's diagnostics showed >9 occurrences of the same warn in 90s).
 *
 * Contract: first encounter per `filePath` logs at `warn`; subsequent
 * encounters log at `debug` until the in-process Set is reset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warnSpy, debugSpy, infoSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: infoSpy,
    warn: warnSpy,
    debug: debugSpy,
    error: errorSpy,
  }),
}));

import {
  parsePendingFile,
  _resetInvalidFrontmatterWarnedForTests,
} from '../cosPendingService';

const INVALID_FRONTMATTER = [
  '---',
  '# missing pending_destination, staged_at, session_id',
  'unrelated_field: value',
  '---',
  '',
  'Body',
].join('\n');

describe('parsePendingFile — invalid frontmatter warn-once', () => {
  beforeEach(() => {
    _resetInvalidFrontmatterWarnedForTests();
    warnSpy.mockReset();
    debugSpy.mockReset();
    infoSpy.mockReset();
    errorSpy.mockReset();
  });

  it('warns on first encounter and demotes subsequent encounters to debug', () => {
    const filePath = '/tmp/pending/260218_repeating-invalid.pending.md';

    const first = parsePendingFile(INVALID_FRONTMATTER, filePath);
    const second = parsePendingFile(INVALID_FRONTMATTER, filePath);
    const third = parsePendingFile(INVALID_FRONTMATTER, filePath);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe(
      'Pending file missing or invalid required frontmatter fields',
    );
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[0][1]).toBe(
      'Pending file frontmatter still invalid (warned once earlier)',
    );
  });

  it('still warns the first time for a different filePath', () => {
    parsePendingFile(INVALID_FRONTMATTER, '/tmp/pending/a.pending.md');
    parsePendingFile(INVALID_FRONTMATTER, '/tmp/pending/b.pending.md');

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('does not log anything when frontmatter is valid', () => {
    const validMarkdown = [
      '---',
      'pending_destination: Chief-of-Staff/memory/topics/Foo.md',
      'staged_at: "2026-04-06T10:00:00.000Z"',
      'session_id: session-abc-123',
      '---',
      '',
      'Body',
    ].join('\n');

    const result = parsePendingFile(validMarkdown, '/tmp/pending/ok.pending.md');

    expect(result).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
