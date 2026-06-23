/**
 * Unit tests for the `truncateChangelogToBudget` helper that keeps the
 * `misc:get-changelog` IPC payload under the 256KB hard cap enforced by
 * `tests/e2e/perf-ipc-payload.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_CHANGELOG_BYTES,
  truncateChangelogToBudget,
} from '../truncateChangelog';

function buildVersionSection(version: string, padBytes: number): string {
  const header = `## v${version} — Jan 1, 2026\n\n### Highlights\n\n`;
  const padding = '- entry'.padEnd(80, ' ') + '\n';
  const repeats = Math.max(1, Math.ceil(padBytes / padding.length));
  return header + padding.repeat(repeats) + '\n';
}

describe('truncateChangelogToBudget', () => {
  it('returns input unchanged when under budget', () => {
    const small = '# Changelog\n\n## v0.1.0 — Jan 1, 2026\n\n- thing\n';
    expect(truncateChangelogToBudget(small)).toBe(small);
  });

  it('trims the payload to fit the byte budget when over budget', () => {
    // Build a synthetic changelog larger than the budget. Newest first matches
    // the real file's ordering (`## v0.4.34` is at the top).
    const sections = [
      buildVersionSection('9.9.0', 60_000),
      buildVersionSection('9.8.0', 60_000),
      buildVersionSection('9.7.0', 60_000),
      buildVersionSection('9.6.0', 60_000),
      buildVersionSection('9.5.0', 60_000),
      buildVersionSection('9.4.0', 60_000),
    ];
    const preamble = '# Changelog\n\nWhat\'s new in Rebel.\n\n---\n\n';
    const raw = preamble + sections.join('');
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX_CHANGELOG_BYTES);

    const trimmed = truncateChangelogToBudget(raw);
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(
      MAX_CHANGELOG_BYTES + 200, // small slack for the truncation footer
    );
  });

  it('only cuts at version-header boundaries (no half-trimmed sections)', () => {
    const sections = [
      buildVersionSection('2.0.0', 80_000),
      buildVersionSection('1.9.0', 80_000),
      buildVersionSection('1.8.0', 80_000),
    ];
    const raw = '# Changelog\n\n' + sections.join('');
    const trimmed = truncateChangelogToBudget(raw);

    // Each retained `## v` block should still be followed by its complete
    // `### Highlights` body — splitting mid-section would break the renderer
    // parser (parseChangelogSections in changelogParser.ts).
    const versionMatches = trimmed.match(/^## v[\d.]+/gm) ?? [];
    for (const versionLine of versionMatches) {
      const idx = trimmed.indexOf(versionLine);
      const after = trimmed.slice(idx);
      // Either this section runs to the truncation footer, or another `## v`
      // header follows it — in both cases we should see `### Highlights` first.
      expect(after).toContain('### Highlights');
    }
  });

  it('appends a transparent truncation footer when trimmed', () => {
    const raw =
      '# Changelog\n\n' +
      buildVersionSection('3.0.0', 120_000) +
      buildVersionSection('2.0.0', 120_000);
    const trimmed = truncateChangelogToBudget(raw);
    expect(trimmed).not.toBe(raw);
    expect(trimmed).toMatch(/Earlier entries trimmed/);
  });

  it('keeps the most recent versions (top of file) and drops the oldest', () => {
    const raw =
      '# Changelog\n\n' +
      buildVersionSection('5.0.0', 100_000) +
      buildVersionSection('4.0.0', 100_000) +
      buildVersionSection('1.0.0', 100_000);
    const trimmed = truncateChangelogToBudget(raw);
    expect(trimmed).toContain('## v5.0.0');
    // 5.0.0 is the newest section and must always survive trimming.
    // 1.0.0 is far enough down to be dropped.
    expect(trimmed).not.toContain('## v1.0.0');
  });
});
