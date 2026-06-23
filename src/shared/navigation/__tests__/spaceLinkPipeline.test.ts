import { describe, it, expect } from 'vitest';
import { parseNavigationUrl, formatNavigationUrl } from '../urlParser';
import type { NavigationTarget } from '../types';

/**
 * End-to-end pipeline tests for space links.
 * Validates the full round-trip from NavigationTarget → URL → NavigationTarget,
 * including realistic multi-segment paths, special characters, and edge cases
 * that only emerge when parser + formatter interact.
 */
describe('space link pipeline', () => {
  describe('format → parse round-trip', () => {
    const cases: Array<{ label: string; target: NavigationTarget }> = [
      {
        label: 'space root (no path)',
        target: { type: 'space', spaceName: 'Mindstone Exec' },
      },
      {
        label: 'file in nested path',
        target: { type: 'space', spaceName: 'Mindstone Exec', filePath: 'memory/topics/Q1-priorities.md' },
      },
      {
        label: 'folder',
        target: { type: 'space', spaceName: 'Mindstone General', folderPath: 'skills/weekly-report' },
      },
      {
        label: 'space name with special chars',
        target: { type: 'space', spaceName: 'Acme & Co (2026)', filePath: 'notes.md' },
      },
      {
        label: 'space name with slash',
        target: { type: 'space', spaceName: 'Team/Engineering', filePath: 'README.md' },
      },
      {
        label: 'space name with unicode',
        target: { type: 'space', spaceName: 'Projet Recherche', filePath: 'rapport.md' },
      },
      {
        label: 'deeply nested file',
        target: { type: 'space', spaceName: 'Work', filePath: 'memory/topics/2026/Q1/sales-report.md' },
      },
    ];

    it.each(cases)('$label', ({ target }) => {
      const url = formatNavigationUrl(target);
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual(target);
    });
  });

  describe('parse → format → parse round-trip (from raw URLs)', () => {
    const cases = [
      {
        label: 'human-readable URL (literal slashes in path)',
        url: 'rebel://space/Mindstone%20Exec/memory/topics/Q1.md',
        expected: { type: 'space', spaceName: 'Mindstone Exec', filePath: 'memory/topics/Q1.md' },
      },
      {
        label: 'folder URL',
        url: 'rebel://space/Exec/memory?type=folder',
        expected: { type: 'space', spaceName: 'Exec', folderPath: 'memory' },
      },
      {
        label: 'space root URL',
        url: 'rebel://space/Exec',
        expected: { type: 'space', spaceName: 'Exec' },
      },
      {
        label: 'case-insensitive host',
        url: 'rebel://SPACE/Exec/file.md',
        expected: { type: 'space', spaceName: 'Exec', filePath: 'file.md' },
      },
    ];

    it.each(cases)('$label', ({ url, expected }) => {
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual(expected);

      // Re-format and re-parse to verify stability
      const reformatted = formatNavigationUrl(parsed!);
      const reparsed = parseNavigationUrl(reformatted);
      expect(reparsed).toEqual(expected);
    });
  });

  describe('security: malicious URLs rejected at parse time', () => {
    const malicious = [
      { label: 'no space name', url: 'rebel://space' },
      { label: 'backslash in path', url: 'rebel://space/Exec/foo%5Cbar' },
      { label: 'NUL byte in path', url: 'rebel://space/Exec/foo%00bar' },
      { label: 'Windows drive letter', url: 'rebel://space/Exec/C:/Windows/System32' },
    ];
    // Note: rebel://space/Exec//etc/passwd is NOT rejected because WHATWG URL spec
    // normalizes // → / before we see it, resulting in etc/passwd as a safe relative path.
    // This matches existing library:// behavior (see urlParser.test.ts path traversal tests).

    it.each(malicious)('rejects: $label', ({ url }) => {
      expect(parseNavigationUrl(url)).toBeNull();
    });
  });

  describe('interop: space links do not interfere with existing targets', () => {
    it('library links still work', () => {
      const url = 'rebel://library/docs/readme.md';
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual({ type: 'library', filePath: 'docs/readme.md' });
    });

    it('conversation links still work', () => {
      const url = 'rebel://conversation/abc-123';
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual({ type: 'sessions', sessionId: 'abc-123' });
    });

    it('settings links still work', () => {
      const url = 'rebel://settings/spaces';
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual({ type: 'settings', tab: 'spaces', section: undefined });
    });

    it('unknown hosts still return null', () => {
      expect(parseNavigationUrl('rebel://unknown/path')).toBeNull();
    });
  });
});
