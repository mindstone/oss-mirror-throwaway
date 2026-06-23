/**
 * extractSourceMetadata
 *
 * Extracts source-capture metadata (description, source type, participants,
 * occurrence date) from two possible inputs:
 *
 * 1. YAML frontmatter at the top of a source-capture file's content
 *    (`extractSourceMetadata(content)`).
 * 2. A source-capture filename following the `yyMMdd_HHmm_source-type_description.md`
 *    convention (`extractSourceMetadataFromFileName(fileName)`).
 *
 * Used by the inbox approval cards to humanise approval text — e.g. turning
 * `260418_1430_meeting_q3-review.md` into "Q3 Review" / `meeting` so the
 * approval copy can read "Share Q3 Review meeting notes with your General
 * space?" instead of the raw filename.
 *
 * Both functions fail gracefully: content without frontmatter or filenames
 * that do not match the source-capture convention return `{}`, letting the
 * caller fall back to the existing (raw-filename) messaging. No YAML parser
 * dependency — frontmatter is parsed with lightweight regex, which is
 * sufficient for the flat key/value shape of source-capture frontmatter.
 *
 * Source-capture filename format reference: see
 * `rebel-system/skills/memory/source-capture/SKILL.md` step 4.
 */

export interface SourceMetadata {
  /** Human-readable title (e.g. "Q3 Review"). */
  description?: string;
  /** Source type slug (e.g. "meeting", "email", "thread", "doc"). Lowercase. */
  sourceType?: string;
  /** Participant names — only present for meetings/threads captured from YAML. */
  participants?: string[];
  /** ISO-like date (YYYY-MM-DD) when the source occurred. */
  occurredAt?: string;
}

/** Source-capture filename pattern: `yyMMdd_HHmm_source-type_description.md`. */
const SOURCE_CAPTURE_FILENAME_RE = /^(\d{6})_(\d{4})_([a-z]+)_(.+)\.md$/;

/**
 * Convert a `yyMMdd` string into `YYYY-MM-DD`. Years are assumed to be 21st century
 * (two-digit year + 2000). Returns null when the input is malformed or represents an
 * out-of-range month/day.
 */
function parseSourceDate(yyMMdd: string): string | null {
  if (!/^\d{6}$/.test(yyMMdd)) return null;
  const yy = parseInt(yyMMdd.slice(0, 2), 10);
  const mm = parseInt(yyMMdd.slice(2, 4), 10);
  const dd = parseInt(yyMMdd.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = 2000 + yy;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Capitalise each hyphen- or underscore-separated word: `"q3-review"` -> `"Q3 Review"`.
 * Words with existing mixed-case (`"iPhone"`) are preserved.
 */
function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Humanise any filename for display — strips common document extensions (.md, .txt)
 * and date prefixes, then title-cases the slug. Used in fallback paths when a file
 * is not a source capture but we still want to avoid leaking raw slugs into the UI.
 *
 * Examples:
 *   "competitive-analysis.md"           → "Competitive Analysis"
 *   "260418_project-roadmap-update.md"  → "Project Roadmap Update"
 *   "budget-2026.xlsx"                  → "budget-2026.xlsx" (non-doc extension preserved)
 */
export function humanizeFileName(fileName: string): string {
  if (!fileName) return fileName;
  const docExtMatch = fileName.match(/^(.+)\.(md|txt)$/i);
  if (!docExtMatch) return fileName;
  const withoutExt = docExtMatch[1];
  const withoutDate = withoutExt.replace(/^\d{6}(_\d{4})?_/, '');
  return humanizeSlug(withoutDate);
}

/**
 * Extract source metadata from a source-capture filename. Returns an empty object when
 * the filename does not match the `yyMMdd_HHmm_source-type_description.md` pattern —
 * signalling to the caller that the file is not a source capture and humanisation
 * should be skipped in favour of the existing fallback messaging.
 */
export function extractSourceMetadataFromFileName(fileName: string): SourceMetadata {
  if (!fileName) return {};
  const match = fileName.match(SOURCE_CAPTURE_FILENAME_RE);
  if (!match) return {};

  const [, yymmdd, , sourceType, descriptionSlug] = match;
  const occurredAt = parseSourceDate(yymmdd) ?? undefined;
  const description = humanizeSlug(descriptionSlug);

  return {
    description: description || undefined,
    sourceType,
    occurredAt,
  };
}

/**
 * Read a scalar YAML field from the frontmatter body. Returns undefined when the key
 * is missing. Strips surrounding quotes.
 */
function readScalarField(body: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm');
  const m = body.match(re);
  if (!m) return undefined;
  const raw = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
  return raw || undefined;
}

/**
 * Read a YAML list field (either inline `key: [a, b]` or block `key:\n  - a\n  - b`).
 * Returns undefined when the key is missing or the list is empty.
 */
function readListField(body: string, key: string): string[] | undefined {
  const inlineRe = new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]$`, 'm');
  const inline = body.match(inlineRe);
  if (inline) {
    const items = inline[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  const blockRe = new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, 'm');
  const block = body.match(blockRe);
  if (block) {
    const items = block[1]
      .split('\n')
      .map(line => line.replace(/^[ \t]+-[ \t]*/, '').trim())
      .map(s => s.replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

/**
 * Extract source metadata from YAML frontmatter at the top of a file's content.
 * Returns an empty object when the content has no frontmatter. Missing fields are
 * simply omitted from the result; callers should treat all fields as optional.
 */
export function extractSourceMetadata(content: string): SourceMetadata {
  if (!content) return {};

  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) return {};

  const body = frontmatterMatch[1];

  return {
    description: readScalarField(body, 'description'),
    sourceType: readScalarField(body, 'source_type'),
    participants: readListField(body, 'participants'),
    occurredAt: readScalarField(body, 'occurred_at'),
  };
}
