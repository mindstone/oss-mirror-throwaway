/**
 * Trim the bundled `rebel-system/help-for-humans/changelog.md` payload before
 * sending it across IPC.
 *
 * The renderer's What's New surface only displays the most recent N version
 * sections (3 initially, +5 per "Load more"), so it does not need the full
 * historical changelog. The IPC transport, however, has a 256KB hard cap
 * enforced by `tests/e2e/perf-ipc-payload.spec.ts`, and the file grows
 * indefinitely as we ship new versions. Returning the entire file would
 * eventually breach that cap (it already did in v0.4.34 — see the original
 * E2E perf-ipc-payload failure on the Apr 24 release run).
 *
 * Strategy: keep the file's preamble plus the most recent version sections
 * (anchored on `## v...` headers) until we cross the byte budget, then cut at
 * the next header boundary so we never split a version. Falls back to the
 * raw content unchanged when it already fits.
 */

/**
 * Maximum byte budget for the trimmed changelog payload.
 *
 * Sized well below the 256KB IPC hard cap (enforced by
 * `tests/e2e/perf-ipc-payload.spec.ts`) to leave headroom for IPC framing
 * overhead (~5KB observed empirically) and for short-term changelog growth
 * between releases.
 */
export const MAX_CHANGELOG_BYTES = 200 * 1024;

/** Matches a top-level version header like `## v0.4.34 — Apr 23-24, 2026`. */
const VERSION_HEADER_RE = /^##\s+v[\d.]+/;

/** Footer appended when the changelog is trimmed, so the renderer surfaces this transparently. */
const TRUNCATION_NOTE =
  '\n\n---\n\n_Earlier entries trimmed for transport. The full history lives in the repo._\n';

/**
 * Trim a changelog markdown payload to fit `MAX_CHANGELOG_BYTES`, cutting only
 * at version-header boundaries so individual version sections stay intact.
 *
 * Returns the input unchanged when it already fits the budget.
 */
export function truncateChangelogToBudget(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') <= MAX_CHANGELOG_BYTES) {
    return raw;
  }

  const lines = raw.split(/\r?\n/);
  const footerBytes = Buffer.byteLength(TRUNCATION_NOTE, 'utf8');
  const effectiveBudget = MAX_CHANGELOG_BYTES - footerBytes;

  // Walk forward, tracking the bytes accumulated up to (but not including)
  // each version-header line. The greatest such header position whose
  // accumulated bytes still fit the effective budget is the latest safe
  // cutoff — keeping every line before it preserves complete sections only.
  let bytes = 0;
  let bestCutoffExclusive = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (VERSION_HEADER_RE.test(line)) {
      if (bytes <= effectiveBudget) {
        bestCutoffExclusive = i;
      } else {
        break;
      }
    }
    // +1 accounts for the newline stripped by .split(/\r?\n/).
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }

  if (bestCutoffExclusive <= 0) {
    // Either no version header was seen, or the very first one already
    // overflows the budget. Conservative fallback: return raw and let the
    // IPC payload guard fire — better than silently emitting an empty file.
    return raw;
  }

  const kept = lines
    .slice(0, bestCutoffExclusive)
    .join('\n')
    .replace(/\s+$/, '');
  return `${kept}${TRUNCATION_NOTE}`;
}
