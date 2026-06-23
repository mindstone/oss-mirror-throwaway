import fs from 'node:fs';
import path from 'node:path';
import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import {
  PREP_ENRICHMENT_FIELDS,
  type MeetingUtility,
  type PrepEnrichment,
  type PrepGoalAlignment,
} from '@core/services/prepAlignmentTypes';

const log = createScopedLogger({ service: 'prepDocScanner' });

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const PREP_FILE_SUFFIX = '-prep.md';
const MEETING_UTILITY_VALUES: ReadonlySet<MeetingUtility> = new Set([
  'productive',
  'blocker',
  'noise',
  'travel',
]);

export interface PrepDocPathMetadata {
  path: string;
  title: string;
  meetingStartTime: string;
  hasEnrichment: boolean;
  /** Calendar meeting ID from frontmatter (e.g. 'google:abc123_...'), when present. */
  meetingId?: string;
}

function getNormalizedRange(startDate: Date, endDate: Date): { start: Date; end: Date } {
  const start = startDate.getTime() <= endDate.getTime() ? startDate : endDate;
  const end = startDate.getTime() <= endDate.getTime() ? endDate : startDate;
  return { start, end };
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildDayFolderPath(basePath: string, date: Date): string {
  const year = String(date.getFullYear());
  const monthIndex = date.getMonth();
  const month = String(monthIndex + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const monthFolder = `${month}-${MONTH_ABBREVS[monthIndex]}`;
  return path.join(basePath, 'memory', 'sources', year, monthFolder, day);
}

function enumerateDayFoldersInRange(basePaths: string[], startDate: Date, endDate: Date): string[] {
  const { start, end } = getNormalizedRange(startDate, endDate);
  const folders: string[] = [];
  const cursor = startOfLocalDay(start);
  const endDay = startOfLocalDay(end);

  while (cursor.getTime() <= endDay.getTime()) {
    for (const basePath of basePaths) {
      folders.push(buildDayFolderPath(basePath, cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return folders;
}

function listPrepFilesInFolder(dayFolder: string): string[] {
  try {
    const entries = fs.readdirSync(dayFolder, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith(PREP_FILE_SUFFIX))
      .map(entry => path.join(dayFolder, entry.name));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      log.warn({ err, dayFolder }, 'Failed to read prep day folder');
    }
    return [];
  }
}

function normalizeIsoLike(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function isMeetingUtility(value: unknown): value is MeetingUtility {
  return typeof value === 'string' && MEETING_UTILITY_VALUES.has(value as MeetingUtility);
}

function parseGoalAlignment(value: unknown): PrepGoalAlignment[] {
  if (!Array.isArray(value)) {
    throw new Error('goal_alignment must be an array');
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`goal_alignment[${index}] must be an object`);
    }

    const candidate = item as Record<string, unknown>;
    if (typeof candidate.goal !== 'string' || candidate.goal.trim().length === 0) {
      throw new Error(`goal_alignment[${index}].goal must be a non-empty string`);
    }
    if (typeof candidate.space !== 'string' || candidate.space.trim().length === 0) {
      throw new Error(`goal_alignment[${index}].space must be a non-empty string`);
    }

    return { goal: candidate.goal, space: candidate.space };
  });
}

function parsePrepEnrichment(attributes: Record<string, unknown>): PrepEnrichment | null {
  const rawGoalAlignment = attributes[PREP_ENRICHMENT_FIELDS.goalAlignment];
  const rawMeetingUtility = attributes[PREP_ENRICHMENT_FIELDS.meetingUtility];
  const rawEnrichedAt = attributes[PREP_ENRICHMENT_FIELDS.enrichedAt];
  const rawEnrichedBy = attributes[PREP_ENRICHMENT_FIELDS.enrichedBy];

  const hasAnyEnrichmentField =
    rawGoalAlignment !== undefined ||
    rawMeetingUtility !== undefined ||
    rawEnrichedAt !== undefined ||
    rawEnrichedBy !== undefined;

  if (!hasAnyEnrichmentField) {
    return null;
  }

  const goalAlignment = parseGoalAlignment(rawGoalAlignment);
  if (!isMeetingUtility(rawMeetingUtility)) {
    throw new Error('meeting_utility must be one of productive|blocker|noise|travel');
  }

  const enrichedAt = normalizeIsoLike(rawEnrichedAt);
  if (!enrichedAt) {
    throw new Error('enriched_at must be a valid ISO string');
  }
  if (typeof rawEnrichedBy !== 'string' || rawEnrichedBy.trim().length === 0) {
    throw new Error('enriched_by must be a non-empty string');
  }

  return {
    goalAlignment,
    meetingUtility: rawMeetingUtility,
    enrichedAt,
    enrichedBy: rawEnrichedBy,
  };
}

function parsePrepFrontmatter(filePath: string): Record<string, unknown> | null {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!fm.test(content)) {
    return null;
  }
  return fm<Record<string, unknown>>(content).attributes;
}

function extractMeetingStartTime(attributes: Record<string, unknown>): string | null {
  return normalizeIsoLike(attributes.meetingStartTime);
}

function extractMeetingId(attributes: Record<string, unknown>): string | undefined {
  const raw = attributes.meetingId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractTitle(attributes: Record<string, unknown>, filePath: string): string {
  if (typeof attributes.title === 'string' && attributes.title.trim().length > 0) {
    return attributes.title;
  }
  return path.basename(filePath, '.md');
}

function getPrepFilePathsInRange(basePaths: string[], startDate: Date, endDate: Date): string[] {
  const files: string[] = [];
  for (const dayFolder of enumerateDayFoldersInRange(basePaths, startDate, endDate)) {
    files.push(...listPrepFilesInFolder(dayFolder));
  }
  return files;
}

/**
 * Scan prep docs within date range and return enrichment data keyed by meeting start time.
 *
 * @param sourcesBasePaths - Absolute paths to directories containing `memory/sources/`.
 *   Typically the Chief-of-Staff space absolute path (where prep docs are saved).
 *   Accepts an array to support future multi-space scanning.
 */
export function scanPrepDocsInRange(
  sourcesBasePaths: string | string[],
  startDate: Date,
  endDate: Date,
): Map<string, PrepEnrichment> {
  const basePaths = Array.isArray(sourcesBasePaths) ? sourcesBasePaths : [sourcesBasePaths];
  const enrichments = new Map<string, PrepEnrichment>();
  const prepFilePaths = getPrepFilePathsInRange(basePaths, startDate, endDate);

  for (const prepPath of prepFilePaths) {
    try {
      const attributes = parsePrepFrontmatter(prepPath);
      if (!attributes) {
        continue;
      }

      const meetingStartTime = extractMeetingStartTime(attributes);
      if (!meetingStartTime) {
        log.warn({ prepPath }, 'Skipping prep doc without meetingStartTime');
        continue;
      }

      const enrichment = parsePrepEnrichment(attributes);
      if (!enrichment) {
        continue;
      }

      enrichments.set(meetingStartTime, enrichment);
    } catch (err) {
      log.warn({ err, prepPath }, 'Skipping malformed prep doc while scanning enrichment');
    }
  }

  return enrichments;
}

/**
 * Find prep doc paths within date range, returning metadata for each.
 *
 * @param sourcesBasePaths - Absolute paths to directories containing `memory/sources/`.
 *   Typically the Chief-of-Staff space absolute path.
 */
export function findPrepDocPaths(
  sourcesBasePaths: string | string[],
  startDate: Date,
  endDate: Date,
): PrepDocPathMetadata[] {
  const basePaths = Array.isArray(sourcesBasePaths) ? sourcesBasePaths : [sourcesBasePaths];
  const prepFilePaths = getPrepFilePathsInRange(basePaths, startDate, endDate);
  const results: PrepDocPathMetadata[] = [];

  for (const prepPath of prepFilePaths) {
    try {
      const attributes = parsePrepFrontmatter(prepPath);
      if (!attributes) {
        continue;
      }

      const meetingStartTime = extractMeetingStartTime(attributes);
      if (!meetingStartTime) {
        log.warn({ prepPath }, 'Skipping prep doc metadata without meetingStartTime');
        continue;
      }

      let hasEnrichment = false;
      try {
        hasEnrichment = parsePrepEnrichment(attributes) !== null;
      } catch (err) {
        log.warn({ err, prepPath }, 'Prep doc has invalid enrichment fields');
      }

      results.push({
        path: prepPath,
        title: extractTitle(attributes, prepPath),
        meetingStartTime,
        hasEnrichment,
        meetingId: extractMeetingId(attributes),
      });
    } catch (err) {
      log.warn({ err, prepPath }, 'Skipping malformed prep doc while collecting paths');
    }
  }

  results.sort((a, b) => a.meetingStartTime.localeCompare(b.meetingStartTime));
  return results;
}
