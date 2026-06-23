import { parseProfileSections, extractContentForSection, type ParsedProfile } from './profileSections';

const SECTION_BODY_THRESHOLD = 10;

const KNOWN_IDS = ['role', 'goals', 'communication', 'working-style'] as const;

/**
 * For a given section ID, check if content exists — either in a dedicated
 * section or extractable from elsewhere in the profile.
 */
function sectionHasContent(profile: ParsedProfile, id: string): boolean {
  const direct = profile.sections.find((s) => s.id === id);
  if (direct && direct.body.trim().length > SECTION_BODY_THRESHOLD) return true;

  const extracted = extractContentForSection(profile, id);
  return extracted.trim().length > SECTION_BODY_THRESHOLD;
}

/**
 * Compute completion from a pre-parsed profile structure.
 *
 * Checks the 4 user-facing sections (Role, Goals, Communication, Working Style)
 * plus file existence. Each is worth 20 points. Content is found either in
 * dedicated sections or extracted from elsewhere in the profile.
 */
export function calculateProfileCompletionFromSections(profile: ParsedProfile): number {
  let score = 20; // file exists

  for (const id of KNOWN_IDS) {
    if (sectionHasContent(profile, id)) score += 20;
  }

  return score;
}

/**
 * Compute a 0-100 completion percentage for the Chief-of-Staff profile.
 *
 * Parses internally and delegates to `calculateProfileCompletionFromSections`.
 * Maintains backward compatibility for callers that pass raw content.
 */
export function calculateProfileCompletion(content: string | null, fileExists: boolean): number {
  if (!fileExists) return 0;
  if (!content) return 20;

  const profile = parseProfileSections(content);
  return calculateProfileCompletionFromSections(profile);
}
