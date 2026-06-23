import { describe, expect, it } from 'vitest';

import { changelogHasVersionHeading } from '../promote-preflight';
import { ensureChangelogSection } from '../lib/ensure-changelog-section';

const TODAY = 'Jun 19, 2026';

/** A realistic changelog: header + intro + `---` front-matter break, then sections. */
function realisticChangelog(): string {
  return [
    '# Changelog',
    '',
    "What's new in Rebel. We ship fast, so there's always something.",
    '',
    '---',
    '',
    '## v0.4.49 — Jun 16-18, 2026',
    '',
    '### Highlights',
    '',
    '- **One-click meeting recorder** — A button for it now.',
    '',
    '## v0.4.48 — Jun 15-16, 2026',
    '',
    '### Fixes',
    '',
    '- **Something** — fixed.',
    '',
  ].join('\n');
}

describe('ensureChangelogSection', () => {
  describe('idempotency (already present)', () => {
    it('returns content UNCHANGED when the version heading already exists', () => {
      const content = realisticChangelog();
      const out = ensureChangelogSection(content, '0.4.49', TODAY);
      expect(out).toBe(content); // referentially identical — no mutation
    });

    it('is a no-op on a second run (insert then re-ensure)', () => {
      const content = realisticChangelog();
      const once = ensureChangelogSection(content, '0.4.50', TODAY);
      expect(once).not.toBe(content);
      const twice = ensureChangelogSection(once, '0.4.50', TODAY);
      expect(twice).toBe(once); // second run is a pure no-op
    });

    it('matches the existing version even with a bare heading (no date suffix)', () => {
      const content = '# Changelog\n\n---\n\n## v0.4.49\n\n- thing\n';
      expect(ensureChangelogSection(content, '0.4.49', TODAY)).toBe(content);
    });
  });

  describe('insertion position (missing)', () => {
    it('inserts the new section immediately after the `---` front-matter, above the most-recent version', () => {
      const content = realisticChangelog();
      const out = ensureChangelogSection(content, '0.4.50', TODAY);

      // New heading present, with the correct date format.
      expect(changelogHasVersionHeading(out, '0.4.50')).toBe(true);
      expect(out).toContain('## v0.4.50 — Jun 19, 2026');

      // The `---` block is immediately followed by the new section, which is
      // immediately followed by the previously-most-recent section.
      const idxHr = out.indexOf('\n---\n');
      const idxNew = out.indexOf('## v0.4.50');
      const idxPrev = out.indexOf('## v0.4.49');
      expect(idxHr).toBeGreaterThanOrEqual(0);
      expect(idxNew).toBeGreaterThan(idxHr);
      expect(idxPrev).toBeGreaterThan(idxNew);
    });

    it('places the new heading ABOVE every existing version section', () => {
      const out = ensureChangelogSection(realisticChangelog(), '0.5.0', TODAY);
      const headings = out.match(/^## v[\d.]+/gm) ?? [];
      expect(headings[0]).toBe('## v0.5.0');
      expect(headings).toEqual(['## v0.5.0', '## v0.4.49', '## v0.4.48']);
    });

    it('falls back to inserting above the first `## ` section when there is no `---`', () => {
      const content = '# Changelog\n\n## v0.4.49 — old\n\n- thing\n';
      const out = ensureChangelogSection(content, '0.4.50', TODAY);
      const idxNew = out.indexOf('## v0.4.50');
      const idxOld = out.indexOf('## v0.4.49');
      expect(idxNew).toBeGreaterThanOrEqual(0);
      expect(idxNew).toBeLessThan(idxOld);
    });

    it('appends after a header-only changelog (no sections)', () => {
      const content = '# Changelog\n\nIntro line.\n\n---\n';
      const out = ensureChangelogSection(content, '0.4.50', TODAY);
      expect(out).toContain('# Changelog');
      expect(out).toContain('## v0.4.50 — Jun 19, 2026');
      expect(out.indexOf('# Changelog')).toBeLessThan(out.indexOf('## v0.4.50'));
    });
  });

  describe('never clobbers existing content (insert-only)', () => {
    it('preserves every original line verbatim and in order after insertion', () => {
      const content = realisticChangelog();
      const out = ensureChangelogSection(content, '0.4.50', TODAY);

      // Every original line must still appear, in the same relative order.
      const originalLines = content.split('\n');
      const outLines = out.split('\n');
      let cursor = 0;
      for (const line of originalLines) {
        const found = outLines.indexOf(line, cursor);
        expect(found, `missing or reordered line: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(cursor);
        cursor = found + 1;
      }
    });

    it('does not modify, rename, or remove the existing most-recent section', () => {
      const content = realisticChangelog();
      const out = ensureChangelogSection(content, '0.4.50', TODAY);
      expect(out).toContain('## v0.4.49 — Jun 16-18, 2026');
      expect(out).toContain('- **One-click meeting recorder** — A button for it now.');
      expect(out).toContain('## v0.4.48 — Jun 15-16, 2026');
      expect(out).toContain('- **Something** — fixed.');
    });

    it('does not touch an existing `## Unreleased` section — only adds the version heading above it', () => {
      const content = '# Changelog\n\n---\n\n## Unreleased\n\n- pending\n';
      const out = ensureChangelogSection(content, '0.4.50', TODAY);
      expect(out).toContain('## Unreleased'); // preserved, never renamed
      expect(out).toContain('- pending');
      expect(out).toContain('## v0.4.50 — Jun 19, 2026');
      expect(out.indexOf('## v0.4.50')).toBeLessThan(out.indexOf('## Unreleased'));
    });

    it('only adds the heading + a blank line (no stray content, no reflow)', () => {
      const content = realisticChangelog();
      const out = ensureChangelogSection(content, '0.4.50', TODAY);
      const added = out.length - content.length;
      // Exactly the inserted heading + the two newlines that frame it.
      expect(out).toContain('## v0.4.50 — Jun 19, 2026\n\n');
      expect(added).toBe('## v0.4.50 — Jun 19, 2026\n\n'.length);
    });
  });

  describe('heading format + version forms', () => {
    it('uses the exact `## v<version> — <today>` format', () => {
      const out = ensureChangelogSection(realisticChangelog(), '0.4.50', TODAY);
      expect(out).toMatch(/^## v0\.4\.50 — Jun 19, 2026$/m);
    });

    it('handles minor and major bumps', () => {
      const minor = ensureChangelogSection(realisticChangelog(), '0.5.0', TODAY);
      expect(changelogHasVersionHeading(minor, '0.5.0')).toBe(true);
      const major = ensureChangelogSection(realisticChangelog(), '1.0.0', TODAY);
      expect(changelogHasVersionHeading(major, '1.0.0')).toBe(true);
    });

    it('regex-significant: a heading for a prefix version (0.4.490) does NOT count as 0.4.49', () => {
      const content = '# Changelog\n\n---\n\n## v0.4.490 — typo\n\n- thing\n';
      // 0.4.49 is absent (only 0.4.490 exists), so it must insert a real 0.4.49 section.
      const out = ensureChangelogSection(content, '0.4.49', TODAY);
      expect(out).not.toBe(content);
      expect(changelogHasVersionHeading(out, '0.4.49')).toBe(true);
      expect(out).toContain('## v0.4.490 — typo'); // the prefix typo line is preserved
    });

    it('regex-significant: dots are literal — a `0X4X49` heading does NOT satisfy 0.4.49', () => {
      const content = '# Changelog\n\n---\n\n## v0X4X49 — weird\n';
      const out = ensureChangelogSection(content, '0.4.49', TODAY);
      expect(out).not.toBe(content); // inserted, because the dotted version is genuinely absent
      expect(changelogHasVersionHeading(out, '0.4.49')).toBe(true);
    });
  });
});
