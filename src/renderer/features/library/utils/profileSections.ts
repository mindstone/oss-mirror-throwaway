import fm from 'front-matter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileSection {
  id: string;
  heading: string;
  body: string;
  isKnown: boolean;
}

export interface ParsedProfile {
  frontmatter: string;
  preamble: string;
  sections: ProfileSection[];
  hasStructuredSections: boolean;
}

// ---------------------------------------------------------------------------
// Known section keyword mappings (case-insensitive containment check)
// ---------------------------------------------------------------------------

// Ordered specific → general so "how i work" matches working-style before role's "work"
const KNOWN_SECTION_KEYWORDS: [string, string[]][] = [
  ['working-style', [
    'working style', 'how i work', 'work style',
    'schedule', 'availability',
  ]],
  ['communication', [
    'communication', 'voice', 'tone', 'preferences',
    'writing style', 'how i communicate',
  ]],
  ['goals', [
    'goals', 'objectives', 'priorities', 'okr',
    'milestones', 'what i\'m working on',
  ]],
  ['role', [
    'role', 'about', 'about me', 'work', 'background',
    'experience', 'context', 'who i am',
  ]],
];

function matchSectionId(headingText: string): { id: string; isKnown: boolean } {
  const normalised = headingText.toLowerCase().trim();
  for (const [id, keywords] of KNOWN_SECTION_KEYWORDS) {
    if (keywords.some((kw) => normalised.includes(kw))) {
      return { id, isKnown: true };
    }
  }
  return { id: 'unknown', isKnown: false };
}

// ---------------------------------------------------------------------------
// Content scanning — detect whether a known section's topics appear in the
// full profile body even if they don't have their own heading.
// ---------------------------------------------------------------------------

const CONTENT_SIGNALS: Record<string, RegExp[]> = {
  goals: [
    /\b(goal|objective|priority|priorities|quarter|okr|milestone|target|kpi|deadline)\b/i,
    /\bworking (toward|on|towards)\b/i,
    /\bship\b.*\bby\b/i,
  ],
  communication: [
    /\b(direct|concise|formal|informal|casual|tone|verbose|brevity|bullet\s*point)\b/i,
    /\b(british|american)\s*english\b/i,
    /\bprefer\b.*\b(communication|writing|format)\b/i,
  ],
  'working-style': [
    /\b(deep\s*focus|async|synchronous|morning|afternoon|meeting|calendar)\b/i,
    /\b(verification|evidence|check\s*before|proactive)\b/i,
    /\bwork\s*style\b/i,
  ],
};

/**
 * Extract lines from the full profile that are relevant to a known section.
 * Used to pre-fill empty sections when the content exists elsewhere.
 * Returns a cleaned-up string ready to paste into the section, or '' if nothing found.
 */
export function extractContentForSection(profile: ParsedProfile, sectionId: string): string {
  const patterns = CONTENT_SIGNALS[sectionId];
  if (!patterns) return '';

  const allLines: string[] = [];
  for (const section of profile.sections) {
    if (section.id === sectionId) continue;
    allLines.push(...section.body.split('\n'));
  }
  if (profile.preamble) {
    allLines.push(...profile.preamble.split('\n'));
  }

  const matched: string[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (patterns.some((re) => re.test(line))) {
      const trimmed = line.replace(/^[-*•]\s*/, '').trim();
      if (trimmed && !matched.includes(trimmed)) {
        matched.push(trimmed);
      }
    }
  }

  if (matched.length === 0) return '';
  return matched.map((l) => `- ${l}`).join('\n');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Extract frontmatter (with delimiters) from raw content.
 * Returns the frontmatter block verbatim and the remaining body.
 */
function extractFrontmatter(content: string): { frontmatter: string; rest: string } {
  try {
    const parsed = fm<Record<string, unknown>>(content);
    if (parsed.frontmatter) {
      const fmBlock = `---\n${parsed.frontmatter}\n---`;
      return { frontmatter: fmBlock, rest: parsed.body };
    }
  } catch {
    // No valid frontmatter — treat entire content as body
  }
  return { frontmatter: '', rest: content };
}

/**
 * Parse a Chief-of-Staff README.md into structured profile sections.
 *
 * Splits on `## ` (h2) headings only, with fence-awareness to skip
 * headings inside code blocks. Frontmatter is preserved verbatim.
 */
export function parseProfileSections(content: string): ParsedProfile {
  if (!content.trim()) {
    return { frontmatter: '', preamble: '', sections: [], hasStructuredSections: false };
  }

  const { frontmatter, rest } = extractFrontmatter(content);
  const lines = rest.split('\n');
  const sections: ProfileSection[] = [];
  const preambleLines: string[] = [];
  let currentHeading: string | null = null;
  let currentBodyLines: string[] = [];
  let inCodeBlock = false;
  let foundFirstHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
    }

    const isH2 = !inCodeBlock && /^## /.test(line);

    if (isH2) {
      if (currentHeading !== null) {
        const { id, isKnown } = matchSectionId(currentHeading);
        sections.push({
          id,
          heading: currentHeading,
          body: currentBodyLines.join('\n').replace(/^\n+/, '').trimEnd(),
          isKnown,
        });
      }
      foundFirstHeading = true;
      currentHeading = line.replace(/^## /, '');
      currentBodyLines = [];
    } else if (!foundFirstHeading) {
      preambleLines.push(line);
    } else {
      currentBodyLines.push(line);
    }
  }

  if (currentHeading !== null) {
    const { id, isKnown } = matchSectionId(currentHeading);
    sections.push({
      id,
      heading: currentHeading,
      body: currentBodyLines.join('\n').replace(/^\n+/, '').trimEnd(),
      isKnown,
    });
  }

  return {
    frontmatter,
    preamble: preambleLines.join('\n').replace(/^\n+/, '').trimEnd(),
    sections,
    hasStructuredSections: sections.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/**
 * Serialise a ParsedProfile back to markdown.
 *
 * Preserves section order, frontmatter verbatim, and formatting.
 * Never reorders sections.
 */
export function serialiseProfileSections(profile: ParsedProfile): string {
  const parts: string[] = [];

  if (profile.frontmatter) {
    parts.push(profile.frontmatter);
  }

  if (profile.preamble) {
    parts.push(profile.preamble);
  }

  for (const section of profile.sections) {
    const sectionBlock = `## ${section.heading}\n\n${section.body}`;
    parts.push(sectionBlock);
  }

  let result = parts.join('\n\n');
  result = result.replace(/[ \t]+$/gm, '');
  if (result && !result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}
