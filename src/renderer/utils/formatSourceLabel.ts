/**
 * Centralized formatting for automation/skill source labels.
 *
 * Raw source labels (kebab-case skill folder names, file paths, etc.)
 * are transformed into warm, human-friendly display text following
 * Rebel's UX voice — empowering, practical, personal.
 *
 * Three tiers of matching:
 *   1. Exact slug match  → curated friendly name
 *   2. Normalised match  → catches Title Case / spaced variants the LLM might produce
 *   3. Kebab-case format → generic Title Case conversion for unknown skills
 *   4. Pass-through      → already human-friendly (e.g. "Acme Corp meeting")
 */

import { isTranscriptSource } from '@rebel/shared';

/**
 * Known skill folder names → friendly display labels.
 * Keys are kebab-case slugs (the folder name in rebel-system/skills/).
 * Values are the warm, lowercase phrases used after "Surfaced by your".
 * Add entries here as new system automations ship.
 */
const FRIENDLY_SKILL_NAMES: Record<string, string> = {
  'wins-and-learnings-uncover': 'daily wins & learnings review',
  'session-coaching-reflection': 'session coaching review',
  'source-capture': 'source capture',
  'transcript-analysis': 'transcript analysis',
  'community-highlights': 'community highlights',
  'calendar-sync': 'calendar sync',
  'onboarding-discovery': 'onboarding discovery',
  'process-plaud-recording': 'recording processing',
};

/**
 * Reverse lookup: normalised string → friendly name.
 * Lets us match "Wins And Learnings Uncover", "wins and learnings uncover",
 * "Onboarding Discovery", etc. back to a curated label.
 */
const NORMALISED_LOOKUP: Record<string, string> = {};
for (const [slug, friendly] of Object.entries(FRIENDLY_SKILL_NAMES)) {
  // Index by normalised slug ("wins and learnings uncover")
  const normSlug = slug.replace(/[-_]/g, ' ').toLowerCase();
  NORMALISED_LOOKUP[normSlug] = friendly;
  // Index by normalised friendly name too ("daily wins & learnings review")
  NORMALISED_LOOKUP[friendly.toLowerCase()] = friendly;
}

function normalise(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/&/g, 'and').toLowerCase().trim();
}

/**
 * Convert kebab-case or snake_case to Title Case.
 */
function kebabToTitleCase(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract the skill folder name from a file path.
 * "rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md" → "wins-and-learnings-uncover"
 */
function extractSkillSlug(input: string): string | null {
  const clean = input.replace(/^@/, '');
  const parts = clean.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] ?? '';

  if (/^(SKILL|AUTOMATION)\.md$/i.test(fileName) && parts.length >= 2) {
    return parts[parts.length - 2] ?? null;
  }
  return null;
}

/**
 * Try to resolve a string to a known friendly name via exact or normalised match.
 */
function resolveKnown(input: string): string | undefined {
  // Exact slug match
  const exact = FRIENDLY_SKILL_NAMES[input];
  if (exact) return exact;

  // Normalised match (catches Title Case, spaced, & variants)
  return NORMALISED_LOOKUP[normalise(input)];
}

/**
 * Resolve a raw source label (skill name, file path, or free text)
 * into a clean, human-friendly name — lowercase, no "your" prefix.
 *
 * Examples:
 *   "wins-and-learnings-uncover"         → "daily wins & learnings review"
 *   "Wins And Learnings Uncover"         → "daily wins & learnings review"
 *   "rebel-system/skills/.../SKILL.md"   → "daily wins & learnings review"
 *   "Onboarding Discovery"               → "onboarding discovery"
 *   "my-custom-skill"                    → "My Custom Skill"
 *   "Acme Corp meeting"                  → "Acme Corp meeting"
 *   "Gmail"                              → "Gmail"
 */
export function friendlySourceName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // 1. Direct / normalised match
  const known = resolveKnown(trimmed);
  if (known) return known;

  // 2. File path → extract slug → try known match → fallback to Title Case
  const slug = extractSkillSlug(trimmed);
  if (slug) {
    return resolveKnown(slug) ?? kebabToTitleCase(slug);
  }

  // 3. Looks like a kebab-case or snake_case identifier → format it
  if (/^[a-z0-9]+[-_][a-z0-9]+/i.test(trimmed) && !trimmed.includes(' ')) {
    return resolveKnown(trimmed) ?? kebabToTitleCase(trimmed);
  }

  // 4. Already human-friendly — return as-is
  return trimmed;
}

/**
 * Returns true when the resolved friendly name matches a known automation skill.
 */
function isKnownAutomation(friendly: string): boolean {
  const norm = normalise(friendly);
  return norm in NORMALISED_LOOKUP;
}

/**
 * Format a source label for use as a subtitle line (e.g. on Today cards).
 * Produces the full "Surfaced by your X" sentence for known automations,
 * or a simpler "From X" for external/unknown sources.
 *
 * "wins-and-learnings-uncover"  → "Surfaced by your daily wins & learnings review"
 * "Onboarding Discovery"        → "Surfaced by your onboarding discovery"
 * "Acme Corp meeting"           → "From Acme Corp meeting"
 * "Gmail"                       → "From Gmail"
 */
export function formatSourceSubtitle(raw: string): string {
  const friendly = friendlySourceName(raw);

  if (isKnownAutomation(friendly)) {
    return `Surfaced by your ${friendly}`;
  }

  return `From ${friendly}`;
}

/**
 * Format a source label for use as a short badge (e.g. in Inbox list).
 * Returns just the friendly name, capitalised for badge display.
 *
 * "wins-and-learnings-uncover"  → "Daily Wins & Learnings Review"
 * "Acme Corp meeting"           → "Acme Corp meeting"
 * "Gmail"                       → "Gmail"
 */
export function formatSourceBadge(raw: string): string {
  const friendly = friendlySourceName(raw);
  return friendly.charAt(0).toUpperCase() + friendly.slice(1);
}

export { isTranscriptSource };
