/**
 * Storage Service for Physical Recordings
 *
 * Saves physical recording transcripts to memory spaces with appropriate metadata.
 * Follows the same memory sources architecture as meeting transcripts.
 *
 * File organization (matches transcriptStorage.ts):
 * - Folder: {space}/memory/sources/YYYY/MM-MMM/DD/
 * - Filename: yyMMdd_HHmm_meeting_{source}_{smart-title}.md
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { MeetingSourceInput } from '@core/meetingSource';
import { saveMeetingSource } from '@core/meetingSource/saveMeetingSource';
import { createScopedLogger } from '@core/logger';
import { buildSaveMeetingSourceDeps } from '@main/services/meetingBot/saveMeetingSourceDeps';
import { findTranscriptByStableId } from '@main/services/meetingBot/transcriptStorage';
import { scanSpaces, getSpaceDisplayName, type SpaceInfo } from '@main/services/spaceService';
import type { PhysicalRecordingMetadata } from './types';

const log = createScopedLogger({ service: 'physical-storage' });

// Month abbreviations for folder structure (matches transcriptStorage.ts)
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DEFAULT_SOURCE_SYSTEM = 'limitless';

/** Result of saving a physical recording */
export interface PhysicalRecordingSaveResult {
  filePath: string;
  /** True if transcript was staged for review instead of saved directly */
  staged?: boolean;
  /** The intended final destination path (set when staged, so callers can defer events) */
  destinationPath?: string;
}

export interface StorageOptions {
  sourceSystem?: string;
  sourceUidPrefix?: string;
  filenameInfix?: string;
  deviceDescription?: string;
  sourceUrlPrefix?: string;
  /** MIME type of the raw audio (determines sidecar file extension). Defaults to 'audio/wav'. */
  audioMimeType?: string;
}

function mapKernelFailureReasonToError(reason: string): string {
  switch (reason) {
    case 'no_workspace':
      return 'No workspace configured';
    case 'no_target_space':
      return 'No suitable space found for physical recording';
    case 'cos_unavailable':
      return 'Staging required but Chief-of-Staff space is unavailable. Please configure a Chief-of-Staff space.';
    case 'guard_error':
      return 'Transcript sensitivity guard failed';
    case 'dedup_lookup_error':
      return 'Failed to check for existing transcript';
    case 'content_build_error':
      return 'Failed to build transcript content';
    case 'fs_error':
      return 'Failed to write transcript file';
    default:
      return 'Unknown transcript save failure';
  }
}

function toMeetingSourceInput(
  transcript: string,
  metadata: PhysicalRecordingMetadata,
  sourceSystem: string,
): MeetingSourceInput {
  if (sourceSystem === 'quick_capture') {
    return {
      kind: 'quick_capture',
      transcript: {
        sessionId: metadata.id,
        title: metadata.title,
        startTime: metadata.startTime,
        durationMs: metadata.duration * 1000,
        rawTranscript: transcript,
      },
      fallbackTitleStrategy: async () => metadata.title,
    };
  }

  if (sourceSystem === 'limitless') {
    return {
      kind: 'limitless',
      transcript: {
        lifelogId: metadata.id,
        title: metadata.title,
        startTime: metadata.startTime,
        durationMs: metadata.duration * 1000,
        rawTranscript: transcript,
      },
      fallbackTitleStrategy: () => metadata.title,
    };
  }

  throw new Error(`Unsupported physical recording source system: ${sourceSystem}`);
}

function createPhysicalRecordingSaveMeetingSourceDeps() {
  return buildSaveMeetingSourceDeps({
    determineTargetSpace: async (_participantCount, coreDirectory) => {
      const target = await determineTargetSpace(coreDirectory);
      if (!target) {
        return null;
      }
      return {
        spacePath: target.path,
        absolutePath: target.absolutePath,
        spaceName: getSpaceDisplayName(target),
        sharing: target.sharing,
        description: target.description,
      };
    },
    findTranscriptByStableId,
    formatTranscriptMarkdown: () => '',
    formatExternalTranscriptMarkdown: () => '',
    generateFilename: (title, date, _participants, _userName, provider) =>
      generateFilename(date, title, provider),
    getUniqueFilePath,
    linkTranscriptToExistingPrep: async () => undefined,
  });
}

/**
 * Save a physical recording transcript to the appropriate space.
 * Returns the result including path and staging status.
 */
export async function savePhysicalRecording(
  transcript: string,
  metadata: PhysicalRecordingMetadata,
  audioBuffer?: Buffer,
  options: StorageOptions = {}
): Promise<PhysicalRecordingSaveResult> {
  const sourceSystem = options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
  const input = toMeetingSourceInput(transcript, metadata, sourceSystem);
  const result = await saveMeetingSource(input, createPhysicalRecordingSaveMeetingSourceDeps());

  if (result.kind === 'failed') {
    throw new Error(result.error?.message ?? mapKernelFailureReasonToError(result.reason));
  }

  if (result.kind === 'staged') {
    return {
      filePath: result.destinationPath,
      staged: true,
      destinationPath: result.destinationPath,
    };
  }

  const fullFilePath = result.filePath;
  log.info({ path: fullFilePath, sourceSystem }, 'Transcript saved to sources/');

  // Optionally save raw audio alongside transcript
  if (audioBuffer && !result.alreadyExists) {
    const mimeToExt: Record<string, string> = {
      'audio/wav': '.wav',
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/mp3': '.mp3',
      'audio/mpeg': '.mp3',
    };
    // Strip codec parameters (e.g., 'audio/webm;codecs=opus' → 'audio/webm')
    const baseMime = (options.audioMimeType ?? 'audio/wav').split(';')[0].trim();
    const audioExt = mimeToExt[baseMime] ?? '.wav';
    const audioPath = fullFilePath.replace('.md', audioExt);
    await fs.writeFile(audioPath, audioBuffer);
    log.info({ path: audioPath }, 'Raw audio saved');
  }

  return { filePath: fullFilePath };
}

/**
 * Determine which space to save the recording to.
 * All physical recordings route to Chief-of-Staff. Content-aware distribution
 * to other spaces happens later via the transcript-distribution-ready automation.
 */
async function determineTargetSpace(coreDirectory: string): Promise<SpaceInfo | null> {
  let spaces: SpaceInfo[] = [];
  try {
    // Read-only: routing a recording to an existing space — must not
    // mutate frontmatter. See docs/plans/260411_shared_space_maintenance.md
    // Stage 3 Refinement.
    spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
  } catch (error) {
    log.warn({ error }, 'Failed to scan spaces');
  }

  // Always route to Chief of Staff
  const chiefOfStaff = spaces.find(s => s.type === 'chief-of-staff');
  if (chiefOfStaff) return chiefOfStaff;

  if (spaces.length === 0) {
    // Last resort: try Chief-of-Staff directory directly
    for (const dirName of ['Chief-of-Staff', 'chief-of-staff']) {
      const chiefOfStaffPath = path.join(coreDirectory, dirName);
      try {
        const stat = await fs.stat(chiefOfStaffPath);
        if (stat.isDirectory()) {
          return {
            name: 'Chief of Staff',
            path: dirName,
            absolutePath: chiefOfStaffPath,
            type: 'chief-of-staff',
            isSymlink: false,
            hasReadme: false,
          };
        }
      } catch {
        // Directory doesn't exist, try next
      }
    }
  }

  log.error({ coreDirectory }, 'No Chief-of-Staff space found — cannot save physical recording');
  return null;
}

/**
 * Generate filename with date and smart title.
 * Format: yyMMdd_HHmm_meeting_{source}_{smart-title}.md
 * Folder: YYYY/MM-MMM/DD/ (e.g., 2025/12-Dec/15/)
 *
 * Uses "meeting" keyword for consistency with other transcripts.
 */
function generateFilename(
  date: Date,
  title: string,
  filenameInfix: string
): { subfolder: string; filename: string } {
  const year = String(date.getFullYear());
  const yy = year.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthAbbrev = MONTH_ABBREVS[date.getMonth()];
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  // Sanitize title for filename
  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const safeFilenameInfix = filenameInfix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'recording';

  const subfolder = path.join(year, `${month}-${monthAbbrev}`, day);
  const filename = `${yy}${month}${day}_${hours}${minutes}_meeting_${safeFilenameInfix}_${safeTitle}.md`;

  return { subfolder, filename };
}

/**
 * Get a unique file path, appending -2, -3, etc. if file exists.
 */
async function getUniqueFilePath(filePath: string): Promise<string> {
  const ext = path.extname(filePath);
  const baseWithoutExt = filePath.slice(0, -ext.length);

  let currentPath = filePath;
  let counter = 2;

  while (counter < 100) {
    try {
      await fs.access(currentPath);
      // File exists, try next number
      currentPath = `${baseWithoutExt}-${counter}${ext}`;
      counter++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return currentPath;
      }
      throw err;
    }
  }
  throw new Error('Too many file collisions');
}

/**
 * Get all pending physical recordings (review_status: pending).
 */
export async function getPendingRecordings(_coreDirectory: string): Promise<{
  id: string;
  title: string;
  startTime: string;
  duration: number;
  filePath: string;
}[]> {
  // TODO (v2): Implement by querying sourceMetadataStore for files with:
  //   - source_system: 'limitless' | 'plaud'
  //   - review_status: 'pending'
  // This requires indexing review_status in sourceMetadataStore, which is significant work.
  // For now, physical recordings are auto-saved without a review queue.
  return [];
}

export default {
  savePhysicalRecording,
  getPendingRecordings,
};
