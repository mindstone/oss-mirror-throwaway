import { toPortablePath } from './utils/portablePath';

export type DimensionName =
  | 'structure'
  | 'clarity'
  | 'examples'
  | 'context'
  | 'adoption'
  | 'extensionHealth';

export type SkillQualityBand = 'seedling' | 'growing' | 'solid' | 'exemplary';

export interface SkillQualityFrontmatter {
  description?: string;
  use_cases?: string[];
  tools_required?: string[];
  author?: string;
  contributed?: string[];
  last_modified_at?: string;
  last_updated?: string;
  dependencies?: string[];
  extends?: string;
  extension_type?: string;
}

export interface ExampleMeta {
  path: string;
  description?: string;
  type: 'positive' | 'counter-example';
  hasFrontmatter: boolean;
  lastModifiedMs?: number;
}

export interface SkillQualityInput {
  name: string;
  relativePath: string;
  hasFrontmatter: boolean;
  frontmatter?: SkillQualityFrontmatter;
  examples: string[];
  exampleMetas?: ExampleMeta[];
  bodyText: string;
  usageCount?: number;
  lastUsedAt?: string | Date | null;
  sessionCount?: number;
  isExtended?: boolean;
  hasOrphanedExtensions?: boolean;
  hasExtensibilityNote?: boolean;
}

export interface SkillQualityDimensionScore {
  score: number;
  max: number;
}

export type SkillQualityBreakdown = Record<DimensionName, SkillQualityDimensionScore>;

export interface SkillQualityResult {
  total: number;
  breakdown: SkillQualityBreakdown;
  band: SkillQualityBand;
  topImprovement?: {
    dimension: DimensionName;
    suggestion: string;
  };
}

const DIMENSION_MAX = 15;
const DIMENSION_MAX_EXAMPLES = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_SCORE_MAX = DIMENSION_MAX * 5 + DIMENSION_MAX_EXAMPLES;

const DIMENSION_ORDER: readonly DimensionName[] = [
  'structure',
  'clarity',
  'examples',
  'context',
  'adoption',
  'extensionHealth',
];

const LOWERCASE_HYPHEN_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING_REGEX = /^#{1,6}\s+/gm;
const LIST_REGEX = /^[\s]*[-*\d]/m;
const PROCESS_HEADING_REGEX = /^#{1,6}\s.*\b(process|steps?|workflow|how)\b.*$/im;
const SKILL_REFERENCE_REGEX = /(?:@[a-z0-9][\w-]*|rebel-system\/skills\/|\/SKILL\.md\b)/i;
const EXTENSIBILITY_NOTE_REGEX = /\b(customi[sz](?:e|ation)|extend(?:ed|ing)?|extension)\b/i;
const DESCRIPTION_ACTION_VERB_REGEX =
  /\b(create|prepare|write|analy[sz]e|generate|draft|build|review|summari[sz]e|research|plan|design)\b/i;

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasItems = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0;

const hasExampleMetas = (value: ExampleMeta[] | undefined): value is ExampleMeta[] =>
  Array.isArray(value) && value.length > 0;

const toComparableText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toTimestamp = (value: string | Date | null | undefined): number | null => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (!hasNonEmptyString(value)) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isWithinDays = (
  value: string | Date | null | undefined,
  days: number,
  nowTimestamp: number
): boolean => {
  const timestamp = toTimestamp(value);
  if (timestamp === null) {
    return false;
  }

  return nowTimestamp - timestamp <= days * DAY_MS;
};

const normaliseCount = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const countWords = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
};

const countLines = (text: string): number => {
  if (!text) {
    return 0;
  }

  return text.split(/\r?\n/).length;
};

const hasDescriptionActionVerb = (description: string | undefined): boolean =>
  hasNonEmptyString(description) && DESCRIPTION_ACTION_VERB_REGEX.test(description);

const getDescriptionScore = (input: SkillQualityInput): number => {
  const description = input.frontmatter?.description;
  if (!input.hasFrontmatter || !hasNonEmptyString(description)) {
    return 0;
  }

  let score = 5;

  const comparableDescription = toComparableText(description);
  const comparableName = toComparableText(input.name);
  if (description.trim().length > 30 && comparableDescription !== comparableName) {
    score += 3;
  }

  if (hasDescriptionActionVerb(description)) {
    score += 2;
  }

  return score;
};

const scoreStructure = (input: SkillQualityInput): number => {
  let score = getDescriptionScore(input);

  const normalizedPath = toPortablePath(input.relativePath);
  if (normalizedPath.endsWith('/SKILL.md')) {
    score += 3;
  }

  if (LOWERCASE_HYPHEN_NAME_REGEX.test(input.name)) {
    score += 2;
  }

  if (hasItems(input.frontmatter?.use_cases)) {
    score += 2;
  }

  return clamp(score, 0, DIMENSION_MAX);
};

const scoreClarity = (bodyText: string): number => {
  let score = 0;

  const headingCount = bodyText.match(HEADING_REGEX)?.length ?? 0;
  if (headingCount >= 2) {
    score += 4;
  }

  if (LIST_REGEX.test(bodyText)) {
    score += 3;
  }

  const wordCount = countWords(bodyText);
  if (wordCount >= 50 && wordCount <= 2000) {
    score += 4;
  }

  if (PROCESS_HEADING_REGEX.test(bodyText)) {
    score += 4;
  }

  return clamp(score, 0, DIMENSION_MAX);
};

const scoreExamples = (input: SkillQualityInput, nowTimestamp: number): number => {
  const exampleCount = input.examples.length;
  if (exampleCount === 0) {
    return 0;
  }

  let score = 6;

  if (exampleCount >= 3) {
    score += 4;
  }

  if (exampleCount >= 5) {
    score += 2;
  }

  // Example freshness: use frontmatter date as proxy (avoids fs.stat on cloud mounts)
  const effectiveDate = input.frontmatter?.last_modified_at ?? input.frontmatter?.last_updated;
  if (isWithinDays(effectiveDate, 180, nowTimestamp)) {
    score += 3;
  }

  if (hasExampleMetas(input.exampleMetas)) {
    if (
      input.exampleMetas.some(
        (exampleMeta) => exampleMeta.hasFrontmatter && hasNonEmptyString(exampleMeta.description)
      )
    ) {
      score += 3;
    }

    if (input.exampleMetas.some((exampleMeta) => exampleMeta.type === 'counter-example')) {
      score += 3;
    }

    const withFrontmatterCount = input.exampleMetas.filter(
      (exampleMeta) => exampleMeta.hasFrontmatter
    ).length;

    if (withFrontmatterCount / input.exampleMetas.length >= 0.5) {
      score += 4;
    }
  }

  return clamp(score, 0, DIMENSION_MAX_EXAMPLES);
};

const scoreContext = (input: SkillQualityInput, nowTimestamp: number): number => {
  let score = 0;

  if (hasItems(input.frontmatter?.tools_required)) {
    score += 4;
  }

  if (hasNonEmptyString(input.frontmatter?.author)) {
    score += 3;
  }

  if (hasItems(input.frontmatter?.contributed)) {
    score += 2;
  }

  const effectiveDate = input.frontmatter?.last_modified_at ?? input.frontmatter?.last_updated;
  if (isWithinDays(effectiveDate, 90, nowTimestamp)) {
    score += 4;
  }

  const referencesOtherSkills = SKILL_REFERENCE_REGEX.test(input.bodyText);
  const hasDependencies = hasItems(input.frontmatter?.dependencies);
  if (!referencesOtherSkills || hasDependencies) {
    score += 2;
  }

  return clamp(score, 0, DIMENSION_MAX);
};

const scoreAdoption = (input: SkillQualityInput, nowTimestamp: number): number => {
  const usageCount = normaliseCount(input.usageCount);
  const sessionCount = normaliseCount(input.sessionCount);

  let score = 0;

  if (usageCount >= 1) {
    score += 3;
  }

  if (usageCount >= 3) {
    score += 3;
  }

  if (usageCount >= 10) {
    score += 3;
  }

  if (isWithinDays(input.lastUsedAt, 30, nowTimestamp)) {
    score += 3;
  }

  if (sessionCount >= 3) {
    score += 3;
  }

  return clamp(score, 0, DIMENSION_MAX);
};

const isExtensionSkill = (input: SkillQualityInput): boolean =>
  hasNonEmptyString(input.frontmatter?.extends);

const scoreExtensionHealth = (input: SkillQualityInput): number => {
  if (isExtensionSkill(input)) {
    let score = 5;

    const lineCount = countLines(input.bodyText);
    if (lineCount < 100) {
      score += 5;
    } else if (lineCount < 200) {
      score += 3;
    }

    if (hasNonEmptyString(input.frontmatter?.extension_type)) {
      score += 5;
    }

    return clamp(score, 0, DIMENSION_MAX);
  }

  let score = 0;

  if (input.isExtended) {
    score += 5;
  }

  if (!input.hasOrphanedExtensions) {
    score += 5;
  }

  const hasExtensibilityNote = input.hasExtensibilityNote ?? EXTENSIBILITY_NOTE_REGEX.test(input.bodyText);
  if (hasExtensibilityNote) {
    score += 5;
  }

  return clamp(score, 0, DIMENSION_MAX);
};

const suggestionByDimension: Record<Exclude<DimensionName, 'extensionHealth' | 'examples' | 'structure'>, string> = {
  clarity: 'The instructions could use some structure -- headings and clear steps help Rebel follow your intent',
  context: 'Add some context -- who owns this, what tools it needs, when it was last updated',
  adoption: 'Take this skill for a spin in a real conversation. Practice makes permanent.',
};

const getStructureSuggestion = (input: SkillQualityInput): string => {
  const description = input.frontmatter?.description;
  if (!hasNonEmptyString(description) || !hasItems(input.frontmatter?.use_cases)) {
    return 'Give this skill a description and list when you\'d actually use it';
  }

  if (!hasDescriptionActionVerb(description)) {
    return 'The description could be sharper -- mention what this skill creates or produces';
  }

  return 'Give this skill a description and list when you\'d actually use it';
};

const getExamplesSuggestion = (input: SkillQualityInput, band: SkillQualityBand): string => {
  if (input.examples.length === 0) {
    return 'Show Rebel what good output looks like. One real example is worth a thousand words of instruction.';
  }

  if (!hasExampleMetas(input.exampleMetas)) {
    return 'Your examples are there -- adding a short description to each would help Rebel understand what they demonstrate.';
  }

  const hasCounterExample = input.exampleMetas.some(
    (exampleMeta) => exampleMeta.type === 'counter-example'
  );

  if (!hasCounterExample && (band === 'solid' || band === 'exemplary')) {
    return 'Show what "not quite right" looks like too. Counter-examples sharpen the output dramatically.';
  }

  const hasDescribedFrontmatter = input.exampleMetas.some(
    (exampleMeta) => exampleMeta.hasFrontmatter && hasNonEmptyString(exampleMeta.description)
  );

  if (!hasDescribedFrontmatter) {
    return 'Your examples are there -- adding a short description to each would help Rebel understand what they demonstrate.';
  }

  return 'Another example showing a different scenario would give Rebel more to work with.';
};

const getImprovementSuggestion = (
  dimension: DimensionName,
  input: SkillQualityInput,
  band: SkillQualityBand,
  extensionSkill: boolean
): string => {
  if (dimension === 'extensionHealth') {
    return extensionSkill
      ? 'Keep your personal additions focused -- a few clear preferences beat a wall of text'
      : 'This skill could be personalised for your workflow. Make it yours.';
  }

  if (dimension === 'structure') {
    return getStructureSuggestion(input);
  }

  if (dimension === 'examples') {
    return getExamplesSuggestion(input, band);
  }

  return suggestionByDimension[dimension];
};

export function normaliseSkillQualityTotal(rawScore: number): number {
  if (!Number.isFinite(rawScore)) {
    return 0;
  }

  const normalized = Math.round((rawScore / RAW_SCORE_MAX) * 100);
  return clamp(normalized, 0, 100);
}

export function getSkillQualityBand(total: number): SkillQualityBand {
  const clamped = clamp(Math.round(total), 0, 100);

  if (clamped <= 22) {
    return 'seedling';
  }

  if (clamped <= 45) {
    return 'growing';
  }

  if (clamped <= 68) {
    return 'solid';
  }

  return 'exemplary';
}

const getTopImprovementDimension = (breakdown: SkillQualityBreakdown): DimensionName | null => {
  let weakestDimension: DimensionName | null = null;
  let weakestRatio = 1;

  for (const dimension of DIMENSION_ORDER) {
    const { score, max } = breakdown[dimension];
    const ratio = max === 0 ? 1 : score / max;

    if (ratio < 1 && (weakestDimension === null || ratio < weakestRatio)) {
      weakestDimension = dimension;
      weakestRatio = ratio;
    }
  }

  return weakestDimension;
};

export function computeSkillQualityScore(input: SkillQualityInput): SkillQualityResult {
  const nowTimestamp = Date.now();

  const breakdown: SkillQualityBreakdown = {
    structure: {
      score: scoreStructure(input),
      max: DIMENSION_MAX,
    },
    clarity: {
      score: scoreClarity(input.bodyText),
      max: DIMENSION_MAX,
    },
    examples: {
      score: scoreExamples(input, nowTimestamp),
      max: DIMENSION_MAX_EXAMPLES,
    },
    context: {
      score: scoreContext(input, nowTimestamp),
      max: DIMENSION_MAX,
    },
    adoption: {
      score: scoreAdoption(input, nowTimestamp),
      max: DIMENSION_MAX,
    },
    extensionHealth: {
      score: scoreExtensionHealth(input),
      max: DIMENSION_MAX,
    },
  };

  const rawScore = DIMENSION_ORDER.reduce((sum, dimension) => {
    return sum + breakdown[dimension].score;
  }, 0);

  const total = normaliseSkillQualityTotal(rawScore);
  const band = getSkillQualityBand(total);

  const weakestDimension = getTopImprovementDimension(breakdown);
  const topImprovement = weakestDimension
    ? {
        dimension: weakestDimension,
        suggestion: getImprovementSuggestion(
          weakestDimension,
          input,
          band,
          isExtensionSkill(input)
        ),
      }
    : undefined;

  return {
    total,
    breakdown,
    band,
    topImprovement,
  };
}
