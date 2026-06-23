export const OUTPUT_SHAPE_BUCKETS = [
  'empty',
  'short_answer',
  'chat_response',
  'structured_response',
  'report_in_chat',
] as const;

export type OutputShapeBucket = typeof OUTPUT_SHAPE_BUCKETS[number];

export type OutputShapeMetrics = {
  wordCount: number;
  headingCount: number;
  bulletCount: number;
  numberedListCount: number;
  codeBlockCount: number;
  tableLineCount: number;
  linkCount: number;
  hasSourceSection: boolean;
  shapeBucket: OutputShapeBucket;
};

const FENCE_LINE_PATTERN = /^\s*(?:```|~~~)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+\S/;
const BULLET_PATTERN = /^\s{0,3}[-*+]\s+\S/;
const NUMBERED_LIST_PATTERN = /^\s{0,3}\d+[.)]\s+\S/;
const TABLE_LINE_PATTERN = /^\s*\|.*\|/;
const SOURCE_SECTION_PATTERN =
  /^\s*(?:#{1,6}\s+)?(?:\*\*)?(?:sources?|references?|citations?)\s*:?(?:\*\*)?\s*$/i;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/g;
const BARE_URL_PATTERN = /\bhttps?:\/\/[^\s)]+/g;

const countMatches = (text: string, pattern: RegExp): number =>
  text.match(pattern)?.length ?? 0;

const countWords = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.match(/\S+/g)?.length ?? 0;
};

const countLinks = (text: string): number => {
  const markdownLinkCount = countMatches(text, MARKDOWN_LINK_PATTERN);
  const textWithoutMarkdownLinks = text.replace(MARKDOWN_LINK_PATTERN, '');
  return markdownLinkCount + countMatches(textWithoutMarkdownLinks, BARE_URL_PATTERN);
};

const classifyShape = (metrics: Omit<OutputShapeMetrics, 'shapeBucket'>): OutputShapeBucket => {
  if (metrics.wordCount === 0) return 'empty';

  if (
    metrics.wordCount >= 1_000 ||
    metrics.headingCount >= 10 ||
    (metrics.headingCount >= 5 && (metrics.bulletCount + metrics.numberedListCount) >= 20)
  ) {
    return 'report_in_chat';
  }

  if (
    metrics.wordCount >= 500 ||
    metrics.headingCount >= 3 ||
    (metrics.bulletCount + metrics.numberedListCount) >= 12 ||
    metrics.tableLineCount >= 3 ||
    metrics.hasSourceSection
  ) {
    return 'structured_response';
  }

  if (metrics.wordCount <= 120 && metrics.headingCount === 0 && metrics.tableLineCount === 0) {
    return 'short_answer';
  }

  return 'chat_response';
};

export const computeOutputShapeMetrics = (text: string): OutputShapeMetrics => {
  const wordCount = countWords(text);
  let headingCount = 0;
  let bulletCount = 0;
  let numberedListCount = 0;
  let tableLineCount = 0;
  let hasSourceSection = false;
  let codeFenceLineCount = 0;
  let inCodeFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (FENCE_LINE_PATTERN.test(line)) {
      codeFenceLineCount += 1;
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) continue;

    if (HEADING_PATTERN.test(line)) headingCount += 1;
    if (BULLET_PATTERN.test(line)) bulletCount += 1;
    if (NUMBERED_LIST_PATTERN.test(line)) numberedListCount += 1;
    if (TABLE_LINE_PATTERN.test(line)) tableLineCount += 1;
    if (SOURCE_SECTION_PATTERN.test(line)) hasSourceSection = true;
  }

  const metricsWithoutBucket = {
    wordCount,
    headingCount,
    bulletCount,
    numberedListCount,
    codeBlockCount: Math.ceil(codeFenceLineCount / 2),
    tableLineCount,
    linkCount: countLinks(text),
    hasSourceSection,
  };

  return {
    ...metricsWithoutBucket,
    shapeBucket: classifyShape(metricsWithoutBucket),
  };
};
