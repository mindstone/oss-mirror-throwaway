import { formatDurationShort } from '@renderer/utils/formatters';

/**
 * Numeric inputs for the per-turn activity recap.
 *
 * `filesTouched`, `durationMs`, and `errors` match the `storylineStats` shown in
 * the Behind-the-Scenes drawer. `toolCount` intentionally describes the INLINE
 * work disclosure's own contents (the steps that expand directly below this
 * recap) — i.e. the deduped per-step tool summaries, which exclude primary
 * MCP-app views (those render as their own primary views, not as steps). That
 * can differ slightly from the drawer's raw `tool/start` count; the recap labels
 * what it expands into, so it stays consistent with the disclosure the user
 * actually opens, not the separate drawer.
 */
export interface TurnActivityRecapInput {
  /** Distinct file paths touched this turn (read/write/edit/etc.). */
  filesTouched: number;
  /** Tool calls shown in the inline work disclosure this recap expands into (deduped; excludes primary MCP-app views). */
  toolCount: number;
  /**
   * Turn duration in milliseconds. Omitted when the surface cannot source a
   * per-turn duration without new plumbing.
   */
  durationMs?: number;
  /** Number of errors this turn. Shown only when > 0, as a muted "hiccup". */
  errors: number;
}

/**
 * The composed recap strings. `label` is the visible muted line (uses ` · `
 * separators and the short duration format); `ariaLabel` is a naturally-read
 * screen-reader sentence that does not depend on the visual middot.
 */
export interface TurnActivityRecap {
  /** Visible muted line, e.g. `3 files · 12 tools · 1m 20s`. */
  label: string;
  /** Screen-reader label, e.g. "Show how Rebel worked: 3 files, 12 tools, 1m 20s." */
  ariaLabel: string;
}

const pluralize = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

const hiccupTerm = (errors: number): string | null =>
  errors > 0 ? pluralize(errors, 'hiccup', 'hiccups') : null;

/**
 * Derive a calm, one-line recap of what Rebel did this turn from the per-turn
 * counts that already exist.
 *
 * Pure and total: no React, no I/O, just string composition. Handles all-zero
 * input gracefully (returns an empty label). This is also the deterministic
 * fallback for the later AI-summary stage, so the signature is intentionally
 * clean and self-contained.
 *
 * Rules (locked by Chief Designer — brand voice, no em dashes, no hype):
 * - Lead with files when `filesTouched > 0`, else with tools when
 *   `toolCount > 0`, else duration-only (`Took 18s`).
 * - Cap at three work terms (files · tools · duration); drop any zero term.
 * - Errors appear ONLY when `errors > 0`, always as the LAST term, phrased as a
 *   muted `1 hiccup` / `N hiccups` (never destructive).
 * - Singular/plural everywhere; separator is ` · ` (space-middot-space).
 */
export function deriveTurnActivityRecap(input: TurnActivityRecapInput): TurnActivityRecap {
  const filesTouched = Math.max(0, Math.trunc(input.filesTouched));
  const toolCount = Math.max(0, Math.trunc(input.toolCount));
  const errors = Math.max(0, Math.trunc(input.errors));
  const hasDuration = typeof input.durationMs === 'number' && input.durationMs > 0;

  // Visible terms (label) and their spoken equivalents (ariaLabel) kept in
  // lockstep so they describe the same facts.
  const visualTerms: string[] = [];
  const spokenTerms: string[] = [];

  if (filesTouched > 0) {
    visualTerms.push(pluralize(filesTouched, 'file', 'files'));
    spokenTerms.push(pluralize(filesTouched, 'file', 'files'));
  }
  if (toolCount > 0) {
    visualTerms.push(pluralize(toolCount, 'tool', 'tools'));
    spokenTerms.push(pluralize(toolCount, 'tool', 'tools'));
  }

  if (hasDuration) {
    const durationLabel = formatDurationShort(input.durationMs as number);
    // When there is genuinely no other work to lead with, frame the
    // duration-only case as "Took Ns" rather than a bare count.
    if (visualTerms.length === 0) {
      visualTerms.push(`Took ${durationLabel}`);
      spokenTerms.push(`Took ${spokenDuration(input.durationMs as number)}`);
    } else {
      visualTerms.push(durationLabel);
      spokenTerms.push(spokenDuration(input.durationMs as number));
    }
  }

  const hiccup = hiccupTerm(errors);
  if (hiccup) {
    visualTerms.push(hiccup);
    spokenTerms.push(hiccup);
  }

  const label = visualTerms.join(' · ');
  const ariaLabel = spokenTerms.length > 0
    ? `Show how Rebel worked: ${spokenTerms.join(', ')}.`
    : 'Show how Rebel worked.';

  return { label, ariaLabel };
}

const spokenUnit = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

/**
 * Spoken (screen-reader) duration — spells out units so it reads naturally and
 * doesn't depend on the compact `1m 20s` glyph form. Mirrors the bucket logic
 * of `formatDurationShort` so the visible and spoken durations stay in sync.
 */
function spokenDuration(ms: number): string {
  if (ms <= 0) return '0 seconds';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return spokenUnit(totalSeconds, 'second', 'seconds');
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    const parts = [spokenUnit(hours, 'hour', 'hours')];
    if (remainingMinutes > 0) parts.push(spokenUnit(remainingMinutes, 'minute', 'minutes'));
    if (seconds > 0) parts.push(spokenUnit(seconds, 'second', 'seconds'));
    return parts.join(' ');
  }
  if (seconds === 0) {
    return spokenUnit(minutes, 'minute', 'minutes');
  }
  return `${spokenUnit(minutes, 'minute', 'minutes')} ${spokenUnit(seconds, 'second', 'seconds')}`;
}
