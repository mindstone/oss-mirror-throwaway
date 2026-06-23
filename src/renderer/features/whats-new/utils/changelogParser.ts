import semver from 'semver';

/** Category for changelog highlights */
export type ChangeCategory = 'for-you' | 'general' | 'feedback' | 'tools';

/** Changelog highlight data structure */
export interface ChangelogHighlight {
  title: string;
  description: string;
  /** Optional suggested prompt to try this feature */
  suggestedPrompt?: string;
  /** Relevance score for personalization (0-100) */
  relevanceScore?: number;
  /** Whether this highlight is personalized for the user */
  isPersonalized?: boolean;
  /** Explicit category from changelog metadata */
  category?: ChangeCategory;
  /** Tags from metadata for relevance matching */
  tags?: string[];
  /** Author attribution (e.g., "Josh Smith") */
  author?: string;
  /** Image URL for feature preview */
  imageUrl?: string;
  /** Action URL for deep linking (e.g., "rebel://settings") */
  actionUrl?: string;
  /** Detailed explanation for tooltip/popover (1-2 paragraphs) */
  detail?: string;
}

/**
 * Compare two semantic version strings.
 * Returns:
 *   - negative number if a < b
 *   - 0 if a === b
 *   - positive number if a > b
 * 
 * Uses semver library to handle edge cases like 0.3.10 vs 0.3.9
 * which would fail with simple string comparison.
 */
export function compareVersions(a: string, b: string): number {
  // Normalize: remove 'v' prefix if present
  const normalizedA = a.replace(/^v/, '');
  const normalizedB = b.replace(/^v/, '');
  
  // Coerce to handle incomplete versions (e.g., "1.0" -> "1.0.0")
  const semverA = semver.coerce(normalizedA);
  const semverB = semver.coerce(normalizedB);
  
  if (!semverA || !semverB) {
    // Fallback to string comparison if semver parsing fails
    return normalizedA.localeCompare(normalizedB);
  }
  
  return semver.compare(semverA, semverB);
}

/**
 * Check if version a is newer than version b.
 * Handles semver edge cases properly (e.g., 0.3.10 > 0.3.9).
 */
export function isNewerVersion(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

/**
 * Parse a single metadata comment line.
 * Supports fields in any order, separated by |.
 * Format: <!-- field: value | field2: value2 | ... -->
 */
function parseMetadataComment(line: string): Partial<ChangelogHighlight> {
  const result: Partial<ChangelogHighlight> = {};
  
  // Match the full comment
  const commentMatch = line.match(/<!--\s*(.+?)\s*-->/);
  if (!commentMatch) return result;
  
  const content = commentMatch[1];
  
  // Split by | and parse each field
  const fields = content.split('|').map(f => f.trim());
  
  for (const field of fields) {
    const colonIndex = field.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = field.slice(0, colonIndex).trim().toLowerCase();
    const value = field.slice(colonIndex + 1).trim();
    
    if (!value) continue;
    
    switch (key) {
      case 'category':
        if (['for-you', 'general', 'feedback', 'tools'].includes(value.toLowerCase())) {
          result.category = value.toLowerCase() as ChangeCategory;
        }
        break;
      case 'tags':
        result.tags = value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        break;
      case 'author':
        result.author = value;
        break;
      case 'image':
        result.imageUrl = value;
        break;
      case 'action':
        result.actionUrl = value;
        break;
      case 'detail':
        result.detail = value;
        break;
    }
  }
  
  return result;
}

/** A version section in the changelog */
export interface ChangelogSection {
  version: string;
  date?: string;
  isCurrentVersion: boolean;
  highlights: ChangelogHighlight[];
  improvements: string[];
}

/**
 * Parse changelog markdown into version sections with full metadata support.
 * 
 * Supports metadata comments before highlight items in any field order:
 * <!-- category: feedback | tags: voice, memory | author: Josh -->
 * - **Title** — Description
 * 
 * @param markdown - Full changelog markdown content
 * @param currentVersion - Optional current app version to mark as current (without 'v' prefix)
 * @returns Array of version sections with highlights and improvements
 */
export function parseChangelogSections(
  markdown: string,
  currentVersion?: string
): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let currentSection: ChangelogSection | null = null;
  let inHighlights = false;
  let inImprovements = false;
  let previousLine = '';

  // Normalize version for comparison
  const normalizedCurrentVersion = currentVersion?.replace(/^v/, '');

  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    // Match version headers like "## v0.3.5 — Jan 5-6, 2026"
    const versionMatch = line.match(/^## (v[\d.]+)\s*[-—]?\s*(.*)$/);
    if (versionMatch) {
      if (currentSection) {
        sections.push(currentSection);
      }
      const version = versionMatch[1];
      const versionNumber = version.replace(/^v/, '');
      currentSection = {
        version,
        date: versionMatch[2]?.trim() || undefined,
        isCurrentVersion: normalizedCurrentVersion ? versionNumber === normalizedCurrentVersion : false,
        highlights: [],
        improvements: [],
      };
      inHighlights = false;
      inImprovements = false;
    } else if (currentSection) {
      if (line.startsWith('### Highlights')) {
        inHighlights = true;
        inImprovements = false;
      } else if (line.startsWith('### Improvements')) {
        inHighlights = false;
        inImprovements = true;
      } else if (line.startsWith('### ')) {
        // Any other h3 section ends both
        inHighlights = false;
        inImprovements = false;
      } else if (line.startsWith('- **') && inHighlights) {
        // Parse highlight items
        const match = line.match(/^- \*\*(.+?)\*\*\s*[-—]?\s*(.*)$/);
        if (match) {
          const highlight: ChangelogHighlight = {
            title: match[1],
            description: match[2] || '',
          };

          // Check previous line for metadata comment
          const metadata = parseMetadataComment(previousLine);
          if (metadata.category) highlight.category = metadata.category;
          if (metadata.tags) highlight.tags = metadata.tags;
          if (metadata.author) highlight.author = metadata.author;
          if (metadata.imageUrl) highlight.imageUrl = metadata.imageUrl;
          if (metadata.actionUrl) highlight.actionUrl = metadata.actionUrl;
          if (metadata.detail) highlight.detail = metadata.detail;

          currentSection.highlights.push(highlight);
        }
      } else if (line.startsWith('- ') && inImprovements) {
        currentSection.improvements.push(line.replace(/^- /, ''));
      }
    }
    previousLine = line;
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Parse changelog markdown and extract highlights for the specified version.
 * 
 * Supports metadata comments before highlight items in any field order:
 * <!-- category: feedback | tags: voice, memory | author: Josh -->
 * - **Title** — Description
 * 
 * @param markdown - Full changelog markdown content
 * @param currentVersion - Version to extract highlights for (without 'v' prefix)
 * @returns Array of parsed highlights for the specified version
 */
export function parseChangelogHighlights(
  markdown: string, 
  currentVersion?: string
): ChangelogHighlight[] {
  if (!currentVersion) return [];
  
  // Normalize version (remove 'v' prefix if present)
  const normalizedVersion = currentVersion.replace(/^v/, '');
  
  const highlights: ChangelogHighlight[] = [];
  const lines = markdown.split(/\r?\n/);
  
  let inCurrentVersion = false;
  let inHighlights = false;
  let previousLine = '';
  
  for (const line of lines) {
    // Match version headers like "## v0.3.5 — Jan 5-6, 2026"
    const versionMatch = line.match(/^## (v[\d.]+)\s*[-—]?\s*(.*)$/);
    if (versionMatch) {
      const version = versionMatch[1].replace(/^v/, '');
      // Check if this is the current version
      inCurrentVersion = version === normalizedVersion;
      inHighlights = false;
      
      // If we've moved past the current version, stop parsing
      if (!inCurrentVersion && highlights.length > 0) {
        break;
      }
    } else if (inCurrentVersion) {
      if (line.startsWith('### Highlights')) {
        inHighlights = true;
      } else if (line.startsWith('### ')) {
        // Any other h3 section ends highlights
        inHighlights = false;
      } else if (line.startsWith('- **') && inHighlights) {
        // Parse highlight items like "- **Title** — Description"
        const match = line.match(/^- \*\*(.+?)\*\*\s*[-—]?\s*(.*)$/);
        if (match) {
          const highlight: ChangelogHighlight = {
            title: match[1],
            description: match[2] || '',
          };
          
          // Check previous line for metadata comment
          const metadata = parseMetadataComment(previousLine);
          if (metadata.category) highlight.category = metadata.category;
          if (metadata.tags) highlight.tags = metadata.tags;
          if (metadata.author) highlight.author = metadata.author;
          if (metadata.imageUrl) highlight.imageUrl = metadata.imageUrl;
          if (metadata.actionUrl) highlight.actionUrl = metadata.actionUrl;
          if (metadata.detail) highlight.detail = metadata.detail;
          
          highlights.push(highlight);
        }
      }
    }
    
    previousLine = line;
  }
  
  return highlights;
}
