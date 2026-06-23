import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';

export type ChiefOfStaffHygieneTriggerReason =
  | 'readme_size_exceeded'
  | 'section_length_exceeded'
  | 'duplicate_instruction_block'
  | 'stale_current_section';

export type ChiefOfStaffHygieneNoOpReason =
  | 'healthy'
  | 'missing_readme'
  | 'unchanged_since_last_run'
  | 'read_error';

export type ChiefOfStaffHygieneRiskKind =
  | 'long_identity_or_profile_section'
  | 'long_preferences_or_goals_section';

export interface ChiefOfStaffHygieneThresholds {
  maxReadmeBytes: number;
  maxSectionCharacters: number;
  maxSectionLines: number;
  staleCurrentSectionAgeDays: number;
  duplicateInstructionBlockMinCharacters: number;
}

export interface ChiefOfStaffHygieneSectionMetric {
  heading: string;
  level: number;
  characterCount: number;
  lineCount: number;
}

export interface ChiefOfStaffHygieneDuplicateMetric {
  normalizedPreview: string;
  occurrences: number;
}

export interface ChiefOfStaffHygieneStaleCurrentSectionMetric {
  heading: string;
  isoDate: string;
  ageDays: number;
}

export interface ChiefOfStaffHygieneRiskIndicator {
  kind: ChiefOfStaffHygieneRiskKind;
  heading: string;
  characterCount: number;
}

export interface ChiefOfStaffHygieneMetrics {
  byteSize: number;
  characterCount: number;
  lineCount: number;
  sectionCount: number;
  readmeHash: string;
  longestSections: ChiefOfStaffHygieneSectionMetric[];
  duplicateInstructionBlocks: ChiefOfStaffHygieneDuplicateMetric[];
  staleCurrentSections: ChiefOfStaffHygieneStaleCurrentSectionMetric[];
}

export interface ChiefOfStaffHygieneEvaluationOptions {
  thresholds?: Partial<ChiefOfStaffHygieneThresholds>;
  lastRunReadmeHash?: string | null;
  now?: Date;
}

export interface ChiefOfStaffHygieneEvaluationResult {
  eligible: boolean;
  triggerReasons: ChiefOfStaffHygieneTriggerReason[];
  metrics: ChiefOfStaffHygieneMetrics;
  thresholds: ChiefOfStaffHygieneThresholds;
  riskIndicators: ChiefOfStaffHygieneRiskIndicator[];
  noOpReason: ChiefOfStaffHygieneNoOpReason | null;
  error: string | null;
}

export const DEFAULT_CHIEF_OF_STAFF_HYGIENE_THRESHOLDS: ChiefOfStaffHygieneThresholds = {
  maxReadmeBytes: 10 * 1024,
  maxSectionCharacters: 2_000,
  maxSectionLines: 45,
  staleCurrentSectionAgeDays: 45,
  duplicateInstructionBlockMinCharacters: 160,
};

const EMPTY_README_METRICS: ChiefOfStaffHygieneMetrics = {
  byteSize: 0,
  characterCount: 0,
  lineCount: 0,
  sectionCount: 0,
  readmeHash: createReadmeHash(''),
  longestSections: [],
  duplicateInstructionBlocks: [],
  staleCurrentSections: [],
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ISO_DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const CURRENT_SECTION_HEADING_RE = /\b(current|now|today|priority|priorities|focus|active)\b/i;
const IDENTITY_PROFILE_HEADING_RE = /\b(identity|profile|bio|about me|personal context)\b/i;
const PREFERENCES_GOALS_HEADING_RE = /\b(preference|preferences|goal|goals|objective|objectives|principle|principles)\b/i;
const INSTRUCTION_BLOCK_RE =
  /\b(rebel|agent|assistant|instruction|system|prompt|always|never|must|should|guideline|guidelines)\b/i;

type ParsedSection = ChiefOfStaffHygieneSectionMetric & {
  body: string;
};

export function createReadmeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function evaluateChiefOfStaffReadmeHygiene(
  readmeContent: string,
  options: ChiefOfStaffHygieneEvaluationOptions = {},
): ChiefOfStaffHygieneEvaluationResult {
  const thresholds = {
    ...DEFAULT_CHIEF_OF_STAFF_HYGIENE_THRESHOLDS,
    ...options.thresholds,
  };
  const now = options.now ?? new Date();
  const readmeHash = createReadmeHash(readmeContent);
  const sections = parseMarkdownSections(readmeContent);
  const duplicateInstructionBlocks = findDuplicateInstructionBlocks(
    readmeContent,
    thresholds.duplicateInstructionBlockMinCharacters,
  );
  const staleCurrentSections = findStaleCurrentSections(
    sections,
    now,
    thresholds.staleCurrentSectionAgeDays,
  );
  const longestSections = [...sections]
    .sort((a, b) => b.characterCount - a.characterCount)
    .slice(0, 5)
    .map(({ body: _body, ...metric }) => metric);
  const metrics: ChiefOfStaffHygieneMetrics = {
    byteSize: Buffer.byteLength(readmeContent, 'utf8'),
    characterCount: readmeContent.length,
    lineCount: readmeContent.length === 0 ? 0 : readmeContent.split(/\r?\n/).length,
    sectionCount: sections.length,
    readmeHash,
    longestSections,
    duplicateInstructionBlocks,
    staleCurrentSections,
  };

  const triggerReasons = new Set<ChiefOfStaffHygieneTriggerReason>();
  if (metrics.byteSize > thresholds.maxReadmeBytes) {
    triggerReasons.add('readme_size_exceeded');
  }
  if (sections.some((section) => isSectionTooLong(section, thresholds))) {
    triggerReasons.add('section_length_exceeded');
  }
  if (duplicateInstructionBlocks.length > 0) {
    triggerReasons.add('duplicate_instruction_block');
  }
  if (staleCurrentSections.length > 0) {
    triggerReasons.add('stale_current_section');
  }

  const riskIndicators = findRiskIndicators(sections, thresholds);
  const triggerReasonsArray = [...triggerReasons];

  if (options.lastRunReadmeHash && options.lastRunReadmeHash === readmeHash) {
    return {
      eligible: false,
      triggerReasons: triggerReasonsArray,
      metrics,
      thresholds,
      riskIndicators,
      noOpReason: 'unchanged_since_last_run',
      error: null,
    };
  }

  return {
    eligible: triggerReasonsArray.length > 0,
    triggerReasons: triggerReasonsArray,
    metrics,
    thresholds,
    riskIndicators,
    noOpReason: triggerReasonsArray.length > 0 ? null : 'healthy',
    error: null,
  };
}

export async function evaluateChiefOfStaffReadmeHygieneFile(
  readmePath: string,
  options: ChiefOfStaffHygieneEvaluationOptions = {},
): Promise<ChiefOfStaffHygieneEvaluationResult> {
  const thresholds = {
    ...DEFAULT_CHIEF_OF_STAFF_HYGIENE_THRESHOLDS,
    ...options.thresholds,
  };

  try {
    const readmeContent = await fsp.readFile(readmePath, 'utf8');
    return evaluateChiefOfStaffReadmeHygiene(readmeContent, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const noOpReason: ChiefOfStaffHygieneNoOpReason = code === 'ENOENT' ? 'missing_readme' : 'read_error';
    return {
      eligible: false,
      triggerReasons: [],
      metrics: EMPTY_README_METRICS,
      thresholds,
      riskIndicators: [],
      noOpReason,
      error: code === 'ENOENT' ? null : formatError(error),
    };
  }
}

function parseMarkdownSections(content: string): ParsedSection[] {
  const lines = stripFrontmatter(content).split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let current: { heading: string; level: number; bodyLines: string[] } | null = null;

  const flushCurrent = (): void => {
    if (!current) return;
    const body = current.bodyLines.join('\n').trim();
    sections.push({
      heading: current.heading,
      level: current.level,
      body,
      characterCount: body.length,
      lineCount: body.length === 0 ? 0 : body.split(/\r?\n/).length,
    });
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flushCurrent();
      current = {
        heading: match[2].trim(),
        level: match[1].length,
        bodyLines: [],
      };
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    }
  }

  flushCurrent();
  return sections;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return lines.slice(index + 1).join('\n');
    }
  }
  return content;
}

function findDuplicateInstructionBlocks(
  content: string,
  minCharacters: number,
): ChiefOfStaffHygieneDuplicateMetric[] {
  const counts = new Map<string, number>();
  for (const block of stripFrontmatter(content).split(/\n\s*\n/)) {
    const normalized = normalizeBlock(block);
    if (normalized.length < minCharacters || !INSTRUCTION_BLOCK_RE.test(normalized)) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([normalized, occurrences]) => ({
      normalizedPreview: normalized.slice(0, 120),
      occurrences,
    }));
}

function normalizeBlock(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => !HEADING_RE.test(line.trim()))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findStaleCurrentSections(
  sections: ParsedSection[],
  now: Date,
  staleCurrentSectionAgeDays: number,
): ChiefOfStaffHygieneStaleCurrentSectionMetric[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return [];
  }

  return sections.flatMap((section) => {
    if (!CURRENT_SECTION_HEADING_RE.test(section.heading)) {
      return [];
    }
    const match = `${section.heading}\n${section.body}`.match(ISO_DATE_RE);
    if (!match) {
      return [];
    }
    const isoDate = match[0];
    const datedAt = new Date(`${isoDate}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(datedAt)) {
      return [];
    }
    const ageDays = Math.floor((nowMs - datedAt) / (24 * 60 * 60 * 1000));
    return ageDays > staleCurrentSectionAgeDays
      ? [{ heading: section.heading, isoDate, ageDays }]
      : [];
  });
}

function findRiskIndicators(
  sections: ParsedSection[],
  thresholds: ChiefOfStaffHygieneThresholds,
): ChiefOfStaffHygieneRiskIndicator[] {
  return sections.flatMap((section) => {
    if (!isSectionTooLong(section, thresholds)) {
      return [];
    }
    if (IDENTITY_PROFILE_HEADING_RE.test(section.heading)) {
      const indicators: ChiefOfStaffHygieneRiskIndicator[] = [{
        kind: 'long_identity_or_profile_section',
        heading: section.heading,
        characterCount: section.characterCount,
      }];
      return indicators;
    }
    if (PREFERENCES_GOALS_HEADING_RE.test(section.heading)) {
      const indicators: ChiefOfStaffHygieneRiskIndicator[] = [{
        kind: 'long_preferences_or_goals_section',
        heading: section.heading,
        characterCount: section.characterCount,
      }];
      return indicators;
    }
    return [];
  });
}

function isSectionTooLong(
  section: ChiefOfStaffHygieneSectionMetric,
  thresholds: ChiefOfStaffHygieneThresholds,
): boolean {
  return section.characterCount > thresholds.maxSectionCharacters
    || section.lineCount > thresholds.maxSectionLines;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
