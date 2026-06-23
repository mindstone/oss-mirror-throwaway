/**
 * Automation Write Classifier
 *
 * Pure, structural classifier for automation source-capture writes. Extracts the
 * source kind from frontmatter metadata ONLY — no keyword matching, no regex
 * content parsing. Never throws: returns `'unknown'` on any parsing failure.
 *
 * Used by the memoryWriteHook automation balanced path as a deterministic
 * pre-check before the LLM Safety Prompt evaluation. See planning doc:
 * `docs/plans/260415_source_capture_automation_shared_space_safety.md`.
 */

import fm from 'front-matter';

export type SourceKind = 'meeting' | 'email' | 'messaging_thread' | 'other' | 'unknown';

/**
 * Source systems (from frontmatter `source_system`) that, when paired with
 * `source_type: thread`, classify as a messaging thread.
 */
const MESSAGING_THREAD_SOURCE_SYSTEMS: readonly string[] = ['slack', 'teams', 'microsoft-teams'];

/**
 * Source types that directly indicate a messaging thread (without needing
 * `source_system`). Per the source-capture SKILL.md, `source_type: slack` is
 * a documented canonical value alongside `source_type: thread`.
 */
const MESSAGING_SOURCE_TYPES: readonly string[] = ['slack', 'teams', 'microsoft-teams'];

/**
 * Classify the structural source kind of an automation write based on
 * frontmatter metadata.
 *
 * Rules (structural — NO content parsing):
 * - `source_type === 'meeting'` → `'meeting'`
 * - `source_type === 'email'` → `'email'`
 * - `source_type === 'thread'` AND `source_system ∈ {slack, teams, microsoft-teams}` → `'messaging_thread'`
 * - `source_type` present but none of the above → `'other'`
 * - `source_type` missing, frontmatter unparseable, or content empty → `'unknown'`
 *
 * Comparisons are case-insensitive. Whitespace around values is trimmed.
 * Returns `'unknown'` on any failure — never throws.
 */
export function classifyAutomationSourceKind(content: string): SourceKind {
  if (typeof content !== 'string' || content.length === 0) {
    return 'unknown';
  }

  let attributes: unknown;
  try {
    // Reuse the existing `front-matter` parser (wraps js-yaml). It returns
    // `{ attributes: {}, body: <content> }` when there is no frontmatter, and
    // throws on malformed YAML — which we map to `'unknown'`.
    attributes = fm(content).attributes;
  } catch {
    return 'unknown';
  }

  if (!attributes || typeof attributes !== 'object') {
    return 'unknown';
  }

  const attrs = attributes as Record<string, unknown>;
  const rawSourceType = attrs.source_type;
  if (typeof rawSourceType !== 'string') {
    return 'unknown';
  }

  const sourceType = rawSourceType.trim().toLowerCase();
  if (!sourceType) {
    return 'unknown';
  }

  if (sourceType === 'meeting') {
    return 'meeting';
  }

  if (sourceType === 'email') {
    return 'email';
  }

  // Direct messaging source types (e.g., source_type: slack)
  if (MESSAGING_SOURCE_TYPES.includes(sourceType)) {
    return 'messaging_thread';
  }

  if (sourceType === 'thread') {
    const rawSourceSystem = attrs.source_system;
    if (typeof rawSourceSystem === 'string') {
      const sourceSystem = rawSourceSystem.trim().toLowerCase();
      if (MESSAGING_THREAD_SOURCE_SYSTEMS.includes(sourceSystem)) {
        return 'messaging_thread';
      }
    }
    // `source_type: thread` without a recognised messaging `source_system`
    // is treated as `'other'` — the Safety Prompt will evaluate it with
    // enriched context.
    return 'other';
  }

  return 'other';
}
