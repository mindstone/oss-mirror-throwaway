/**
 * ============================================================================
 * ensureChangelogSection — pure, idempotent, insert-only changelog opener
 * ============================================================================
 *
 * Opens (once) the `## v<version> — <today>` section in the user-facing
 * changelog so the heading every release-time gate requires is already present
 * — without a human ever hand-editing it. This is the producer side of S10; the
 * heading-match rule it satisfies is `changelogHasVersionHeading` (the single
 * source of truth in scripts/promote-preflight.ts).
 *
 * GUARANTEES:
 * - PURE: no I/O. Takes content + version + today, returns the new content.
 * - IDEMPOTENT: if `changelogHasVersionHeading(content, version)` is already
 *   true, returns `content` UNCHANGED (referentially — the same string). So a
 *   second run, or a run mid-cycle once the section exists, is a guaranteed
 *   no-op (one open section per version-cycle, never one per beta).
 * - NEVER CLOBBERS: insert-only. It only adds a new heading + a blank line; it
 *   never modifies, reorders, deletes, or even re-indents any existing line.
 *   Every original character survives verbatim, in order, after the inserted
 *   block.
 *
 * INSERTION POINT: immediately after the front-matter/header block (the first
 * top-level `---` separator that follows the leading `# Changelog` heading and
 * intro), i.e. above the most-recent `## v<...>` section. If no such `---`
 * exists, it falls back to inserting just above the first `## ` section; if
 * there is no `## ` section at all, it appends after the header. In every case
 * the rule above holds — existing content is preserved verbatim.
 */

import { changelogHasVersionHeading } from '../promote-preflight';

/** Matches a top-level `---` thematic break on its own line. */
const HR_LINE = /^---\s*$/;
/** Matches any `## ` section heading (e.g. `## v0.4.49 — …`, `## Unreleased`). */
const SECTION_HEADING = /^## /;

/**
 * Returns `content` with a `## v<version> — <today>` section inserted at the top
 * of the entries, UNLESS the version heading already exists (then `content` is
 * returned unchanged). Pure + insert-only — see file header for the guarantees.
 *
 * @param content the full changelog file content
 * @param version the version to open a section for (e.g. `0.4.50`)
 * @param today   the date string for the heading (e.g. `Jun 19, 2026`)
 */
export function ensureChangelogSection(content: string, version: string, today: string): string {
  // Idempotent: already present ⇒ exact same string back, no mutation.
  if (changelogHasVersionHeading(content, version)) {
    return content;
  }

  const newSection = `## v${version} — ${today}\n\n`;
  const lines = content.split('\n');

  // Find the insertion index (a line index; we splice the new section in BEFORE it).
  const insertAt = findInsertionIndex(lines);

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  // Reassemble insert-only: the new section, then a blank separator line, then
  // the untouched remainder. `after` still contains every original line verbatim.
  const rebuilt = [...before, newSection.replace(/\n+$/, ''), '', ...after].join('\n');
  return rebuilt;
}

/**
 * The line index to insert the new section BEFORE. Preference order:
 *   1. one line past the first top-level `---` separator (the front-matter
 *      break), so the new section sits above the most-recent version section;
 *   2. the first `## ` section heading (if there is no `---`);
 *   3. the end of file (header-only changelog).
 * Skips any blank lines between the chosen anchor and the next content so the
 * inserted block lands flush, without disturbing existing spacing afterward.
 */
function findInsertionIndex(lines: string[]): number {
  const hrIndex = lines.findIndex((line) => HR_LINE.test(line));
  if (hrIndex !== -1) {
    // Insert just after the `---`, skipping the blank line(s) that follow it so
    // the new heading is the first content under the header block.
    let i = hrIndex + 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    return i;
  }

  const sectionIndex = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (sectionIndex !== -1) {
    return sectionIndex;
  }

  return lines.length;
}
