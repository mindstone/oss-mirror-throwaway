/**
 * Transcript Storage Service
 *
 * Formats and saves meeting transcripts as source files with YAML frontmatter.
 * Routes transcripts to appropriate spaces based on participant count.
 * Follows the memory sources architecture (see docs/plans/finished/251228_memory_sources_architecture.md).
 *
 * File Organization:
 * - Folder structure: memory/sources/YYYY/MM-MMM/DD/ (e.g., 2025/12-Dec/15/)
 * - Filename format: yyMMdd_HHmm_meeting_{provider}_{smart-title}.md
 * - Smart title: uses meeting title if meaningful, otherwise derives from participants
 *
 * Schema follows sources architecture:
 * - source_type: meeting
 * - source_system: recall | fireflies | fathom
 * - source_uid: stable ID for deduplication
 * - source_url: canonical URL or URN for provenance
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { writeFile as atomicWriteFile } from 'atomically';
import type { MeetingSourceInput } from '@core/meetingSource';
import { createScopedLogger } from '@core/logger';
import { saveMeetingSource, upgradeWithGuardAndEmit } from '@core/meetingSource/saveMeetingSource';
import { callBehindTheScenesWithAuth } from '../behindTheScenesClient';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { getSettings } from '@core/services/settingsStore';
import { extractTextFromBtsResponse } from './btsResponseUtils';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { scanSpaces, getSpaceDisplayName, type SpaceInfo } from '../spaceService';
import { buildSaveMeetingSourceDeps } from './saveMeetingSourceDeps';

const log = createScopedLogger({ service: 'transcript-storage' });

/** Generic meeting titles that should be replaced with participant-based names */
const GENERIC_TITLES = [
  'meeting',
  'untitled',
  'zoom meeting',
  'google meet',
  'teams meeting',
  'call',
  'chat',
  'untitled meeting',
  'new meeting',
  'scheduled meeting',
  '',
];

/** Transcript quality level - 'captions' (initial), 'recallai_async' (upgraded), or 'desktop_sdk' (local recording) */
export type TranscriptQuality = 'captions' | 'recallai_async' | 'desktop_sdk';

const CHAT_SECTION_MARKER = '## Chat Messages';

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: string; // ISO timestamp for correlation with transcript
}

export interface TranscriptData {
  botId: string;
  meetingTitle: string;
  meetingUrl?: string;
  participants: string[];
  duration: number; // in seconds
  startTime: string; // ISO timestamp
  rawTranscript: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  /** Decisions captured during the meeting (from ConversationState) */
  decisions?: string[];
  /** Open questions at meeting end (from ConversationState) */
  openQuestions?: string[];
  /** Optional calendar event ID for future calendar linking */
  calendarId?: string;
  /** Recording ID for async transcription upgrade */
  recordingId?: string;
  /** Transcript quality level - 'captions' (initial) or 'recallai_async' (upgraded) */
  transcriptQuality?: TranscriptQuality;
  /** Source system - 'recall' for cloud bot, 'desktop_sdk' for desktop SDK recording ('local' kept for legacy callers) */
  sourceSystem?: 'recall' | 'local' | 'desktop_sdk';
  /** Calendar event ID for linking to calendar meeting */
  calendarEventId?: string;
  /** Calendar source (google, microsoft) for collision-safe meeting ID */
  calendarSource?: string;
  chatMessages?: ChatMessage[];
}

/** Data for external provider transcripts (Fireflies, Fathom) */
export interface ExternalTranscriptData {
  externalId: string;
  provider: 'fireflies' | 'fathom';
  meetingTitle: string;
  meetingUrl?: string;
  /** Optional transcript page URL (Fathom provides this) */
  transcriptUrl?: string;
  participants: string[];
  duration: number;
  startTime: string;
  rawTranscript: string;
  summary?: string;
  actionItems?: string[];
  /** Optional calendar event ID for future calendar linking */
  calendarId?: string;
}

/** Month abbreviations for folder names */
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Maximum content size before truncation (1MB) */
const MAX_CONTENT_SIZE = 1024 * 1024;
const TRANSCRIPT_CLEANUP_MIN_LENGTH_RATIO = 0.5;

function isBenignDirReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Strip sensitive credentials from conference URLs (e.g., Zoom passwords).
 */
function stripUrlCredentials(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    // Remove common credential params
    parsed.searchParams.delete('pwd');
    parsed.searchParams.delete('password');
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('tk');
    return parsed.toString();
  } catch {
    // Not a valid URL, return as-is but strip obvious patterns
    return url.replace(/[?&](pwd|password|token|tk)=[^&]*/gi, '');
  }
}

/**
 * Generate source_url for a transcript.
 * Uses real URL if available (e.g., Fathom), otherwise URN.
 */
function generateSourceUrl(
  provider: string,
  stableId: string,
  transcriptUrl?: string
): string {
  // If we have a real transcript page URL, use it
  if (transcriptUrl && transcriptUrl.startsWith('http')) {
    return transcriptUrl;
  }
  // Otherwise, use a URN for provenance
  return `urn:${provider}:transcript:${stableId}`;
}

export interface TranscriptStorageResult {
  success: boolean;
  filePath?: string;
  spacePath?: string;
  error?: string;
  /** True if transcript already existed (deduplication) */
  alreadyExists?: boolean;
  /** True if transcript was staged for review instead of saved directly. Callers should suppress emitTranscriptSaved when staged. */
  staged?: boolean;
  /** The intended final destination path (set when staged, so callers can defer events) */
  destinationPath?: string;
}

/**
 * Find an existing transcript by stable ID and provider.
 * Searches both new sources/ location and legacy meeting-transcripts/ location.
 * Optimized to check specific date folders first when meetingDate is provided.
 *
 * @param spacePath - Absolute path to the space
 * @param stableId - The botId, externalId, or source_uid to search for
 * @param provider - The provider/source_system (recall, fireflies, fathom)
 * @param meetingDate - Optional date to optimize search (checks ±1 day)
 * @returns File path if found, null otherwise
 */
export async function findTranscriptByStableId(
  spacePath: string,
  stableId: string,
  provider?: string,
  meetingDate?: Date
): Promise<string | null> {
  // Helper to check frontmatter for matching ID
  const checkFile = async (filePath: string): Promise<boolean> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!fm.test(content)) return false;
      const { attributes } = fm<Record<string, unknown>>(content);
      
      // Check all possible ID fields (new and legacy)
      const matchesId = 
        String(attributes?.source_uid) === stableId ||
        String(attributes?.bot_id) === stableId ||
        String(attributes?.external_id) === stableId;
      
      // If provider specified, also check it matches
      if (matchesId && provider) {
        const sourceSystem = String(attributes?.source_system);
        const sourceSystemMatchesProvider =
          sourceSystem === provider ||
          (provider === 'desktop_sdk' && sourceSystem === 'local');
        const matchesProvider =
          sourceSystemMatchesProvider ||
          String(attributes?.provider) === provider;
        return matchesProvider;
      }
      
      return matchesId;
    } catch {
      return false;
    }
  };

  // Reuse module-level constant for month abbreviations
  const monthAbbrevs = MONTH_ABBREVS;

  // Helper to scan a date folder (YYYY/MM-MMM/DD/ format for sources/)
  const scanSourcesDateFolder = async (year: string, mmAbbrev: string, dd: string): Promise<string | null> => {
    const folder = path.join(spacePath, 'memory', 'sources', year, mmAbbrev, dd);
    try {
      const files = await fs.readdir(folder, { withFileTypes: true });
      for (const fileEntry of files) {
        if (fileEntry.isDirectory()) continue;
        const file = fileEntry.name;
        if (!file.endsWith('.md') || !file.includes('_meeting_')) continue;
        const filePath = path.join(folder, file);
        if (await checkFile(filePath)) {
          log.debug({ stableId, provider, filePath }, 'Found existing transcript in sources/');
          return filePath;
        }
      }
    } catch (error) {
      if (!isBenignDirReadError(error)) {
        throw error;
      }
    }
    return null;
  };

  // Helper to format date as folder components { year, mmAbbrev, dd }
  const formatDateFolder = (d: Date): { year: string; mmAbbrev: string; dd: string } => {
    const year = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const abbrev = monthAbbrevs[d.getMonth()];
    return { year, mmAbbrev: `${mm}-${abbrev}`, dd };
  };

  // 1. If we have a meeting date, check specific date folders first (±1 day for timezone)
  if (meetingDate) {
    const dates = [
      meetingDate,
      new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000), // day before
      new Date(meetingDate.getTime() + 24 * 60 * 60 * 1000), // day after
    ];
    for (const d of dates) {
      const { year, mmAbbrev, dd } = formatDateFolder(d);
      const result = await scanSourcesDateFolder(year, mmAbbrev, dd);
      if (result) return result;
    }
  }

  // 2. Scan all of sources/ (for when date is unknown or not in expected range)
  // Structure: sources/YYYY/MM-MMM/DD/
  const sourcesDir = path.join(spacePath, 'memory', 'sources');
  const checkedPaths = new Set<string>();
  if (meetingDate) {
    const dates = [
      meetingDate,
      new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000),
      new Date(meetingDate.getTime() + 24 * 60 * 60 * 1000),
    ];
    for (const d of dates) {
      const { year, mmAbbrev, dd } = formatDateFolder(d);
      checkedPaths.add(path.join(year, mmAbbrev, dd));
    }
  }
  try {
    const yearFolders = await fs.readdir(sourcesDir, { withFileTypes: true });
    for (const yearFolderEntry of yearFolders) {
      // Preserve prior behavior: follow symlink-to-dir entries; symlink-to-file ENOTDIR is benign-skipped.
      if (!yearFolderEntry.isDirectory() && !yearFolderEntry.isSymbolicLink()) continue;
      const yearFolder = yearFolderEntry.name;
      const yearPath = path.join(sourcesDir, yearFolder);

      const monthFolders = await fs.readdir(yearPath, { withFileTypes: true });
      for (const monthFolderEntry of monthFolders) {
        if (!monthFolderEntry.isDirectory() && !monthFolderEntry.isSymbolicLink()) continue;
        const mmAbbrev = monthFolderEntry.name;
        const mmPath = path.join(yearPath, mmAbbrev);

        const dayFolders = await fs.readdir(mmPath, { withFileTypes: true });
        for (const dayFolderEntry of dayFolders) {
          if (!dayFolderEntry.isDirectory() && !dayFolderEntry.isSymbolicLink()) continue;
          const dd = dayFolderEntry.name;
          // Skip if we already checked this folder
          if (checkedPaths.has(path.join(yearFolder, mmAbbrev, dd))) continue;

          const result = await scanSourcesDateFolder(yearFolder, mmAbbrev, dd);
          if (result) return result;
        }
      }
    }
  } catch (error) {
    if (!isBenignDirReadError(error)) {
      throw error;
    }
  }

  // 3. Check legacy flat memory/sources/yyMMdd/ layout for backwards compatibility
  try {
    const flatFolders = await fs.readdir(sourcesDir, { withFileTypes: true });
    for (const folderEntry of flatFolders) {
      if (!folderEntry.isDirectory() && !folderEntry.isSymbolicLink()) continue;
      const folder = folderEntry.name;
      // Match flat yyMMdd folders (6 digits)
      if (!/^\d{6}$/.test(folder)) continue;
      const flatPath = path.join(sourcesDir, folder);
      const files = await fs.readdir(flatPath, { withFileTypes: true });
      for (const fileEntry of files) {
        if (fileEntry.isDirectory()) continue;
        const file = fileEntry.name;
        if (!file.endsWith('.md') || !file.includes('_meeting_')) continue;
        const filePath = path.join(flatPath, file);
        if (await checkFile(filePath)) {
          log.debug({ stableId, provider, filePath }, 'Found existing transcript in legacy flat sources/');
          return filePath;
        }
      }
    }
  } catch (error) {
    if (!isBenignDirReadError(error)) {
      throw error;
    }
  }

  // 4. Check legacy meeting-transcripts/ location for backwards compatibility
  const legacyDir = path.join(spacePath, 'memory', 'meeting-transcripts');
  try {
    const years = await fs.readdir(legacyDir, { withFileTypes: true });
    for (const yearEntry of years) {
      if (!yearEntry.isDirectory() && !yearEntry.isSymbolicLink()) continue;
      const year = yearEntry.name;
      const yearPath = path.join(legacyDir, year);

      const months = await fs.readdir(yearPath, { withFileTypes: true });
      for (const monthEntry of months) {
        if (!monthEntry.isDirectory() && !monthEntry.isSymbolicLink()) continue;
        const month = monthEntry.name;
        const monthPath = path.join(yearPath, month);

        const files = await fs.readdir(monthPath, { withFileTypes: true });
        for (const fileEntry of files) {
          if (fileEntry.isDirectory()) continue;
          const file = fileEntry.name;
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(monthPath, file);
          if (await checkFile(filePath)) {
            log.debug({ stableId, provider, filePath }, 'Found existing transcript in legacy meeting-transcripts/');
            return filePath;
          }
        }
      }
    }
  } catch (error) {
    if (!isBenignDirReadError(error)) {
      throw error;
    }
  }

  return null;
}

/**
 * Check if a meeting title is generic and should be replaced.
 */
function isGenericTitle(title: string): boolean {
  if (!title) return true;
  return GENERIC_TITLES.includes(title.toLowerCase().trim());
}

/**
 * Sanitize a participant name for use in filename.
 * Removes organization suffixes, titles, and special characters.
 */
function sanitizeName(name: string): string {
  let cleaned = name.split(' - ')[0].trim(); // Remove org suffix like "- Mindstone"
  
  // Remove common titles and suffixes
  cleaned = cleaned
    .replace(/^(Dr\.?|Mr\.?|Ms\.?|Mrs\.?|Prof\.?)\s+/i, '')
    .replace(/\s+(Jr\.?|Sr\.?|III|II|IV)$/i, '');
  
  // Normalize and convert to safe filename format
  cleaned = cleaned
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens
  
  return cleaned;
}

/**
 * Extract first name from a participant name.
 */
function extractFirstName(name: string): string {
  return sanitizeName(name).split('-')[0];
}

/**
 * Normalize name parts for comparison.
 */
function normalizeNameParts(name: string): string[] {
  return name
    .toLowerCase()
    .split(' - ')[0] // Remove org suffix
    .split(/[^a-z]+/) // Split into words
    .filter((w) => w.length > 1); // Remove single chars
}

/**
 * Check if a participant is the current user.
 */
function isCurrentUser(participant: string, userName: string | null): boolean {
  if (!userName) return false;

  const participantParts = normalizeNameParts(participant);
  const userParts = normalizeNameParts(userName);

  // Match if any significant name part matches
  for (const pp of participantParts) {
    for (const up of userParts) {
      if (pp.length >= 3 && up.length >= 3) {
        if (pp === up || pp.startsWith(up) || up.startsWith(pp)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Generate a smart title based on meeting title and participants.
 * - If title is meaningful: use it
 * - If 1:1: "with-{other-person}"
 * - If small group (2-3 others): "name1-name2-name3"
 * - If large group (4+): "team-meeting"
 */
function generateSmartTitle(
  meetingTitle: string,
  participants: string[],
  userName: string | null
): string {
  // Use meaningful title if available
  if (!isGenericTitle(meetingTitle)) {
    return meetingTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  // Get other participants (excluding current user)
  const others = participants.filter((p) => !isCurrentUser(p, userName));

  if (others.length === 0) {
    return 'solo-meeting';
  }

  if (others.length === 1) {
    // 1:1 meeting
    return 'with-' + sanitizeName(others[0]);
  }

  if (others.length <= 3) {
    // Small group - use first names
    return others.map((p) => extractFirstName(p)).join('-');
  }

  // Large group
  return 'team-meeting';
}

/**
 * Generate filename with date, provider, time, and smart title.
 * Format: yyMMdd_HHmm_meeting_{provider}_{smart-title}.md
 * Folder: YYYY/MM-MMM/DD/ (e.g., 2025/12-Dec/15/)
 * 
 * The "meeting" keyword is always included for searchability across all providers.
 */
export function generateFilename(
  meetingTitle: string,
  date: Date,
  participants: string[],
  userName: string | null,
  provider: string
): { subfolder: string; filename: string } {
  const year = String(date.getFullYear());
  const yy = year.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthAbbrev = MONTH_ABBREVS[date.getMonth()];
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  const smartTitle = generateSmartTitle(meetingTitle, participants, userName);
  const subfolder = path.join(year, `${month}-${monthAbbrev}`, day); // YYYY/MM-MMM/DD/ format
  const filename = `${yy}${month}${day}_${hours}${minutes}_meeting_${provider}_${smartTitle}.md`;

  return { subfolder, filename };
}

/**
 * Get a unique file path, appending -2, -3, etc. if file exists.
 */
export async function getUniqueFilePath(filePath: string): Promise<string> {
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
 * Format chat messages as a markdown section with local-time timestamps.
 */
function formatChatSection(chatMessages?: ChatMessage[]): string {
  if (!chatMessages || chatMessages.length === 0) return '';

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines: string[] = [CHAT_SECTION_MARKER, ''];

  for (const message of chatMessages) {
    const trimmedText = message.text.trim();
    if (!trimmedText) continue;

    const parsedTimestamp = new Date(message.timestamp);
    const formattedTime = Number.isNaN(parsedTimestamp.getTime())
      ? message.timestamp
      : parsedTimestamp.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone,
        });

    const sender = message.sender.trim() || 'Unknown';
    const oneLineText = trimmedText.replace(/\s*\n\s*/g, ' ');
    lines.push(`**[${formattedTime}] ${sender}**: ${oneLineText}`);
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

/**
 * Format transcript as markdown with sources-compatible YAML frontmatter.
 */
export function formatTranscriptMarkdown(data: TranscriptData, userEmail: string | null): string {
  const durationMinutes = Math.round(data.duration / 60);
  const occurredAt = data.startTime.split('T')[0]; // YYYY-MM-DD
  const startedAt = new Date(data.startTime).toISOString(); // Full ISO timestamp for precise matching
  const storedAt = new Date().toISOString().split('T')[0]; // Today's date
  // This legacy formatter defaults source_url to the Recall-style URN.
  // saveMeetingSourceDeps now aligns source_* fields from kernel frontmatter
  // after formatting for migrated save paths.
  const sourceUrl = generateSourceUrl('recall', data.botId);
  
  // Check if content needs truncation
  const isTruncated = data.rawTranscript.length > MAX_CONTENT_SIZE;
  const truncatedTranscript = isTruncated 
    ? data.rawTranscript.slice(0, MAX_CONTENT_SIZE - 200) + '\n\n*[Content truncated due to size]*'
    : data.rawTranscript;
  
  // Build YAML frontmatter (sources schema)
  const sourceSystem = data.sourceSystem ?? 'recall';
  const frontmatter = [
    '---',
    `description: "${data.meetingTitle.replace(/"/g, '\\"')}"`,
    'source_type: meeting',
    `source_system: ${sourceSystem}`,
    `source_account: ${userEmail || 'unknown'}`,
    `source_uid: ${data.botId}`,
    `source_url: "${sourceUrl}"`,
    `occurred_at: ${occurredAt}`,
    `started_at: ${startedAt}`,
    `stored_at: ${storedAt}`,
    `truncated: ${isTruncated}`,
    `duration_minutes: ${durationMinutes}`,
  ];
  
  if (data.participants.length > 0) {
    frontmatter.push('participants:');
    for (const p of data.participants) {
      frontmatter.push(`  - "${p.replace(/"/g, '\\"')}"`);
    }
  }
  if (data.decisions && data.decisions.length > 0) {
    frontmatter.push('decisions:');
    for (const d of data.decisions) {
      frontmatter.push(`  - "${d.replace(/"/g, '\\"')}"`);
    }
  }
  if (data.openQuestions && data.openQuestions.length > 0) {
    frontmatter.push('open_questions:');
    for (const q of data.openQuestions) {
      frontmatter.push(`  - "${q.replace(/"/g, '\\"')}"`);
    }
  }
  
  // Strip credentials from conference URL
  const safeConferenceUrl = stripUrlCredentials(data.meetingUrl);
  if (safeConferenceUrl) {
    frontmatter.push(`conference_url: "${safeConferenceUrl}"`);
  }
  
  if (data.calendarId) {
    frontmatter.push(`calendar_id: ${data.calendarId}`);
  }

  // Calendar event linkage for meeting history reconciliation
  if (data.calendarEventId) {
    frontmatter.push(`calendar_event_id: ${data.calendarEventId}`);
  }
  if (data.calendarSource) {
    frontmatter.push(`calendar_source: ${data.calendarSource}`);
  }
  
  if (data.recordingId) {
    frontmatter.push(`recording_id: ${data.recordingId}`);
  }
  
  // Track transcript quality for async upgrade flow
  frontmatter.push(`transcript_quality: ${data.transcriptQuality ?? 'captions'}`);
  
  frontmatter.push('---');
  
  // Build content sections
  const sections: string[] = [];
  
  // Title
  sections.push(`# ${data.meetingTitle}\n`);
  
  // Summary section
  if (data.summary) {
    sections.push('## Summary\n');
    sections.push(data.summary);
    sections.push('');
  }
  
  // Key Takeaways section (renamed from Key Points for consistency with sources)
  if (data.keyPoints && data.keyPoints.length > 0) {
    sections.push('## Key Takeaways\n');
    for (const point of data.keyPoints) {
      sections.push(`- ${point}`);
    }
    sections.push('');
  }
  
  // Action items section
  if (data.actionItems && data.actionItems.length > 0) {
    sections.push('## Action Items\n');
    for (const item of data.actionItems) {
      sections.push(`- [ ] ${item}`);
    }
    sections.push('');
  }

  // Decisions section (from conversation state)
  if (data.decisions && data.decisions.length > 0) {
    sections.push('## Decisions\n');
    for (const decision of data.decisions) {
      sections.push(`- ${decision}`);
    }
    sections.push('');
  }

  // Open Questions section (from conversation state)
  if (data.openQuestions && data.openQuestions.length > 0) {
    sections.push('## Open Questions\n');
    for (const question of data.openQuestions) {
      sections.push(`- ${question}`);
    }
    sections.push('');
  }
  
  // Full Content section (renamed from Full Transcript for consistency)
  sections.push('## Full Content\n');
  if (isTruncated) {
    sections.push(`*Content truncated due to size. See full source at ${sourceUrl}*\n`);
  }
  sections.push(truncatedTranscript);

  const chatSection = formatChatSection(data.chatMessages);
  if (chatSection) {
    sections.push('');
    sections.push(chatSection);
  }
  
  return frontmatter.join('\n') + '\n\n' + sections.join('\n');
}

/** Result from determineTargetSpace with optional space metadata for sensitivity evaluation */
export interface TargetSpaceResult {
  spacePath: string;
  absolutePath: string;
  sharing: string;
  spaceName?: string;
  description?: string;
}

/** Extract space metadata from a SpaceInfo object for the target space result */
function spaceInfoToTargetResult(space: SpaceInfo): TargetSpaceResult {
  return {
    spacePath: space.path,
    absolutePath: space.absolutePath,
    sharing: space.sharing ?? 'private',
    spaceName: getSpaceDisplayName(space),
    description: space.description,
  };
}

/**
 * Determine the target space for a transcript.
 *
 * All transcripts are routed to Chief-of-Staff (private space) regardless of
 * participant count. Content-aware distribution to other spaces happens later
 * via the transcript-distribution-ready automation.
 *
 * Returns space metadata (sharing, spaceName, description) when available from
 * SpaceInfo, for use by the transcript sensitivity guard.
 *
 * Exported for use by meeting prep storage in bundledInboxBridge.
 */
export async function determineTargetSpace(
  _participantCount: number,
  coreDirectory: string
): Promise<TargetSpaceResult | null> {
  // Scan available spaces.
  // Read-only: transcript routing must not mutate frontmatter.
  // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
  let spaces: SpaceInfo[] = [];
  try {
    spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
  } catch (error) {
    log.warn({ error }, 'Failed to scan spaces');
  }

  // Always route to Chief of Staff
  const chiefOfStaff = spaces.find(s => s.type === 'chief-of-staff');
  if (chiefOfStaff) {
    return spaceInfoToTargetResult(chiefOfStaff);
  }
  
  // Last resort: try Chief-of-Staff directory directly (in case scanSpaces failed)
  for (const dirName of ['Chief-of-Staff', 'chief-of-staff']) {
    const chiefOfStaffPath = path.join(coreDirectory, dirName);
    try {
      const stat = await fs.stat(chiefOfStaffPath);
      if (stat.isDirectory()) {
        log.info({ chiefOfStaffPath }, 'Using Chief-of-Staff directory directly (space scan may have failed)');
        return { spacePath: dirName, absolutePath: chiefOfStaffPath, sharing: 'private' };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.debug({ err, chiefOfStaffPath }, 'Failed to stat Chief-of-Staff directory');
      }
    }
  }
  
  log.error({ coreDirectory }, 'No Chief-of-Staff space found — cannot save transcript');
  return null;
}

/**
 * Save a transcript to the appropriate space as a source file.
 *
 * File organization (sources architecture):
 * - Folder: {space}/memory/sources/YYYY/MM-MMM/DD/
 * - Filename: yyMMdd_HHmm_meeting_recall_{smart-title}.md
 */
function toMeetingSourceInput(data: TranscriptData): MeetingSourceInput | null {
  if (data.sourceSystem === 'desktop_sdk' || data.sourceSystem === 'local') {
    return {
      kind: 'desktop_sdk',
      transcript: {
        sessionId: data.botId,
        meetingTitle: data.meetingTitle,
        meetingUrl: data.meetingUrl,
        participants: data.participants,
        durationMs: data.duration * 1000,
        startTime: data.startTime,
        rawTranscript: data.rawTranscript,
      },
      fallbackTitleStrategy: () => data.meetingTitle || 'Local Recording',
    };
  }

  if (!data.sourceSystem || data.sourceSystem === 'recall') {
    return {
      kind: 'recall',
      provider: 'recall',
      transcript: {
        botId: data.botId,
        meetingTitle: data.meetingTitle,
        meetingUrl: data.meetingUrl,
        participants: data.participants,
        durationMs: data.duration * 1000,
        startTime: data.startTime,
        rawTranscript: data.rawTranscript,
        summary: data.summary,
        keyPoints: data.keyPoints,
        actionItems: data.actionItems,
        decisions: data.decisions,
        openQuestions: data.openQuestions,
        recordingId: data.recordingId,
        transcriptQuality: data.transcriptQuality,
        calendarEventId: data.calendarEventId,
        calendarSource: data.calendarSource,
        chatMessages: data.chatMessages,
        isLiveTranscriptInitial: data.transcriptQuality === 'captions',
      },
    };
  }

  return null;
}

function mapKernelFailureReasonToError(reason: string): string {
  switch (reason) {
    case 'no_workspace':
      return 'Core directory not configured';
    case 'no_target_space':
      return 'No suitable space found for transcript';
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

function createSaveMeetingSourceDeps() {
  return buildSaveMeetingSourceDeps({
    determineTargetSpace,
    findTranscriptByStableId,
    formatTranscriptMarkdown,
    formatExternalTranscriptMarkdown,
    generateFilename,
    getUniqueFilePath,
    linkTranscriptToExistingPrep,
  });
}

function mapKernelResultToStorageResult(
  result: Awaited<ReturnType<typeof saveMeetingSource>>,
): TranscriptStorageResult {
  if (result.kind === 'saved') {
    return {
      success: true,
      filePath: result.filePath,
      spacePath: result.emittedEvent.spacePath,
      alreadyExists: result.alreadyExists,
    };
  }

  if (result.kind === 'staged') {
    return {
      success: true,
      staged: true,
      destinationPath: result.destinationPath,
    };
  }

  const message = result.error?.message ?? mapKernelFailureReasonToError(result.reason);
  return { success: false, error: message };
}

export async function saveTranscript(data: TranscriptData): Promise<TranscriptStorageResult> {
  try {
    const input = toMeetingSourceInput(data);
    if (!input) {
      return {
        success: false,
        error: `Unsupported transcript source system: ${String(data.sourceSystem)}`,
      };
    }

    const result = await saveMeetingSource(input, createSaveMeetingSourceDeps());
    return mapKernelResultToStorageResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, botId: data.botId }, 'Failed to save transcript');
    return { success: false, error: message };
  }
}

/**
 * Run a post-processing cleanup pass over transcript text.
 * Returns cleaned text when successful, or null when cleanup is disabled/fails validation.
 */
export async function cleanTranscriptText(
  rawTranscript: string,
  options?: { sessionId?: string; botId?: string }
): Promise<string | null> {
  try {
    if (!rawTranscript || rawTranscript.trim().length === 0) {
      return null;
    }

    const settings = getSettings();
    if (settings.meetingBot?.enableTranscriptCleanup === false) {
      return null;
    }

    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        messages: [
          {
            role: 'user',
            content: `${getPrompt(PROMPT_IDS.UTILITY_TRANSCRIPT_CLEANUP)}\n\n${rawTranscript}`,
          },
        ],
        maxTokens: 16384,
        timeout: 60000,
      },
      {
        category: 'meeting-summary',
        sessionId: options?.sessionId,
      },
    );

    const cleaned = extractTextFromBtsResponse(response)?.trim();
    if (!cleaned) {
      return null;
    }

    if (cleaned.length < rawTranscript.length * TRANSCRIPT_CLEANUP_MIN_LENGTH_RATIO) {
      log.warn(
        { botId: options?.botId, rawLength: rawTranscript.length, cleanedLength: cleaned.length },
        'Transcript cleanup output rejected due to suspiciously short length'
      );
      return null;
    }

    return cleaned;
  } catch (error) {
    log.warn(
      { error, botId: options?.botId, sessionId: options?.sessionId },
      'Transcript cleanup failed, falling back to raw transcript'
    );
    return null;
  }
}

/**
 * Upgrade an existing transcript file with higher-quality async transcription.
 * Overwrites the transcript content while preserving other frontmatter fields.
 *
 * @param filePath - Absolute path to the existing transcript file
 * @param newTranscript - The upgraded transcript content
 * @param newQuality - The new quality level ('recallai_async')
 * @returns Success status
 */
export async function upgradeTranscriptQuality(
  filePath: string,
  newTranscript: string,
  newQuality: TranscriptQuality,
  extraFrontmatter?: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  try {
    // Read existing file
    const content = await fs.readFile(filePath, 'utf-8');

    if (!fm.test(content)) {
      return { success: false, error: 'File does not contain valid frontmatter' };
    }

    const { attributes, body } = fm<Record<string, unknown>>(content);

    // Update quality in frontmatter
    attributes.transcript_quality = newQuality;
    if (extraFrontmatter) {
      for (const [key, value] of Object.entries(extraFrontmatter)) {
        if (value !== undefined) {
          attributes[key] = value;
        }
      }
    }

    // Rebuild frontmatter
    const frontmatterLines = ['---'];
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value)) {
        frontmatterLines.push(`${key}:`);
        for (const item of value) {
          frontmatterLines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
        }
      } else if (typeof value === 'string' && (value.includes('\n') || value.includes('"'))) {
        frontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
      } else {
        frontmatterLines.push(`${key}: ${value}`);
      }
    }
    frontmatterLines.push('---');

    // Extract non-transcript sections from body (Summary, Key Takeaways, Action Items)
    // Chat Messages section is preserved separately to keep it after Full Content
    const sections: string[] = [];
    const bodyLines = body.split('\n');
    let inTranscript = false;
    let inChat = false;
    const currentSection: string[] = [];
    const chatSection: string[] = [];

    for (const line of bodyLines) {
      if (line.startsWith('## Full Content') || line.startsWith('## Full Transcript')) {
        inTranscript = true;
        inChat = false;
        continue;
      }
      if (line.trim() === CHAT_SECTION_MARKER) {
        inTranscript = false;
        inChat = true;
        chatSection.push(line);
        continue;
      }
      if (line.startsWith('## ') && (inTranscript || inChat)) {
        inTranscript = false;
        inChat = false;
      }
      if (inChat) {
        chatSection.push(line);
      } else if (!inTranscript) {
        currentSection.push(line);
      }
    }

    // Add preserved sections (before transcript)
    if (currentSection.length > 0) {
      sections.push(currentSection.join('\n').trim());
    }

    // Add new transcript (use "Full Content" to match sources schema)
    sections.push('## Full Content\n');
    sections.push(newTranscript);

    // Preserve chat section after transcript
    if (chatSection.length > 0) {
      sections.push('');
      sections.push(chatSection.join('\n').trim());
    }

    // Write updated file
    const newContent = frontmatterLines.join('\n') + '\n\n' + sections.filter(s => s).join('\n\n');
    await fs.writeFile(filePath, newContent, 'utf-8');

    log.info({ filePath, newQuality }, 'Transcript quality upgraded successfully');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, filePath }, 'Failed to upgrade transcript quality');
    return { success: false, error: message };
  }
}

/**
 * Format external transcript as markdown with sources-compatible YAML frontmatter.
 */
export function formatExternalTranscriptMarkdown(data: ExternalTranscriptData, userEmail: string | null): string {
  const durationMinutes = Math.round(data.duration / 60);
  const occurredAt = data.startTime.split('T')[0]; // YYYY-MM-DD
  const startedAt = new Date(data.startTime).toISOString(); // Full ISO timestamp for precise matching
  const storedAt = new Date().toISOString().split('T')[0]; // Today's date
  const sourceUrl = generateSourceUrl(data.provider, data.externalId, data.transcriptUrl);

  // Check if content needs truncation
  const isTruncated = data.rawTranscript.length > MAX_CONTENT_SIZE;
  const truncatedTranscript = isTruncated 
    ? data.rawTranscript.slice(0, MAX_CONTENT_SIZE - 200) + '\n\n*[Content truncated due to size]*'
    : data.rawTranscript;

  // Build YAML frontmatter (sources schema)
  const frontmatter = [
    '---',
    `description: "${data.meetingTitle.replace(/"/g, '\\"')}"`,
    'source_type: meeting',
    `source_system: ${data.provider}`,
    `source_account: ${userEmail || 'unknown'}`,
    `source_uid: ${data.externalId}`,
    `source_url: "${sourceUrl}"`,
    `occurred_at: ${occurredAt}`,
    `started_at: ${startedAt}`,
    `stored_at: ${storedAt}`,
    `truncated: ${isTruncated}`,
    `duration_minutes: ${durationMinutes}`,
  ];

  if (data.participants.length > 0) {
    frontmatter.push('participants:');
    for (const p of data.participants) {
      frontmatter.push(`  - "${p.replace(/"/g, '\\"')}"`);
    }
  }

  // Strip credentials from conference URL
  const safeConferenceUrl = stripUrlCredentials(data.meetingUrl);
  if (safeConferenceUrl) {
    frontmatter.push(`conference_url: "${safeConferenceUrl}"`);
  }

  if (data.calendarId) {
    frontmatter.push(`calendar_id: ${data.calendarId}`);
  }

  frontmatter.push('---');

  // Build content sections
  const sections: string[] = [];

  // Title
  sections.push(`# ${data.meetingTitle}\n`);

  // Summary section
  if (data.summary) {
    sections.push('## Summary\n');
    sections.push(data.summary);
    sections.push('');
  }

  // Action items section
  if (data.actionItems && data.actionItems.length > 0) {
    sections.push('## Action Items\n');
    for (const item of data.actionItems) {
      sections.push(`- [ ] ${item}`);
    }
    sections.push('');
  }

  // Full Content section
  sections.push('## Full Content\n');
  if (isTruncated) {
    sections.push(`*Content truncated due to size. See full source at ${sourceUrl}*\n`);
  }
  sections.push(truncatedTranscript);

  return frontmatter.join('\n') + '\n\n' + sections.join('\n');
}

/**
 * Save an external provider transcript to the appropriate space as a source file.
 * Similar to saveTranscript but for external providers (Fireflies, Fathom).
 *
 * File organization (sources architecture):
 * - Folder: {space}/memory/sources/YYYY/MM-MMM/DD/
 * - Filename: yyMMdd_HHmm_meeting_{provider}_{smart-title}.md
 */
export async function saveExternalTranscript(data: ExternalTranscriptData): Promise<TranscriptStorageResult> {
  try {
    const input: MeetingSourceInput = {
      kind: 'external',
      provider: data.provider,
      meetingUrl: data.meetingUrl ?? null,
      calendarEventId: data.calendarId ?? null,
      transcript: {
        externalId: data.externalId,
        meetingTitle: data.meetingTitle,
        meetingUrl: data.meetingUrl,
        transcriptUrl: data.transcriptUrl,
        participants: data.participants,
        durationMs: data.duration * 1000,
        startTime: data.startTime,
        rawTranscript: data.rawTranscript,
        summary: data.summary,
        actionItems: data.actionItems,
      },
    };

    const result = await saveMeetingSource(input, createSaveMeetingSourceDeps());
    return mapKernelResultToStorageResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, externalId: data.externalId, provider: data.provider }, 'Failed to save external transcript');
    return { success: false, error: message };
  }
}

/**
 * Find the prep file path for a transcript (if it exists).
 * Prep files are named: {transcript-basename}-prep.md
 */
export async function findPrepForTranscript(transcriptPath: string): Promise<string | null> {
  const dir = path.dirname(transcriptPath);
  const basename = path.basename(transcriptPath, '.md');
  const prepPath = path.join(dir, `${basename}-prep.md`);
  
  try {
    await fs.access(prepPath);
    return prepPath;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TRANSCRIPT FUNCTIONS
// Write transcript to disk during meeting for agent access and crash recovery.
// Uses "atomically" library for safe writes, never loses data.
// ═══════════════════════════════════════════════════════════════════════════

/** Transcript segment from live captions */
export interface LiveTranscriptSegment {
  speaker: string;
  text: string;
  timestamp: number;
  wordCount: number;
}

/** Data needed to create a live transcript file */
export interface LiveTranscriptData {
  botId: string;
  meetingUrl?: string;
  meetingTitle?: string;
  startTime: string; // ISO timestamp
  participants: string[];
  calendarEventId?: string;
  calendarSource?: string;
  chatMessages?: ChatMessage[];
}

/** Result of reading live transcript frontmatter */
export interface LiveTranscriptFrontmatter {
  live: boolean;
  source_uid: string;
  started_at?: string;
  last_updated?: string;
  transcript_quality?: string;
  conference_url?: string;
  calendar_event_id?: string;
  calendar_source?: string;
  participants?: string[];
}

/**
 * Generate a title for live transcript based on participants.
 * Falls back to "meeting-in-progress" if no valid speakers.
 */
function generateLiveTitle(participants: string[]): string {
  // Filter out generic/unknown speakers
  const validSpeakers = participants.filter(p => {
    const lower = p.toLowerCase();
    return !lower.includes('unknown') && !lower.includes('speaker') && p.length > 0;
  });

  if (validSpeakers.length === 0) {
    return 'meeting-in-progress';
  }

  if (validSpeakers.length === 1) {
    return 'with-' + sanitizeName(validSpeakers[0]);
  }

  if (validSpeakers.length <= 3) {
    return validSpeakers.map(p => extractFirstName(p)).join('-');
  }

  return 'team-meeting';
}

/**
 * Format live transcript segments as markdown content.
 */
function formatLiveTranscriptContent(segments: LiveTranscriptSegment[]): string {
  if (segments.length === 0) return '';

  const lines: string[] = [];
  let lastSpeaker = '';

  for (const segment of segments) {
    if (segment.speaker !== lastSpeaker) {
      if (lines.length > 0) lines.push(''); // Blank line between speakers
      lines.push(`**${segment.speaker}**: ${segment.text}`);
      lastSpeaker = segment.speaker;
    } else {
      // Same speaker continues - append to previous line or add continuation
      lines.push(segment.text);
    }
  }

  return lines.join('\n');
}

/**
 * Create a new live transcript file with initial segments.
 * This is called on the first caption received.
 *
 * @returns The absolute file path where the transcript was saved
 */
export async function saveLiveTranscript(
  data: LiveTranscriptData,
  segments: LiveTranscriptSegment[],
  chatMessages?: ChatMessage[]
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const settings = getSettings();
  const coreDirectory = settings.coreDirectory;

  if (!coreDirectory) {
    return { success: false, error: 'Core directory not configured' };
  }

  try {
    // Determine target space based on participants
    const participantCount = data.participants.length || 2; // Default to 2 (1:1)
    const target = await determineTargetSpace(participantCount, coreDirectory);

    if (!target) {
      return { success: false, error: 'No suitable space found for live transcript' };
    }

    // Get user info
    const authState = getRebelAuthProvider().getAuthState();
    const userName = authState?.user?.name ?? null;
    const userEmail = authState?.user?.email ?? null;

    // Generate filename
    const meetingDate = new Date(data.startTime);
    const smartTitle = data.meetingTitle && !isGenericTitle(data.meetingTitle)
      ? data.meetingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
      : generateLiveTitle(data.participants);

    const { subfolder, filename } = generateFilename(
      smartTitle,
      meetingDate,
      data.participants,
      userName,
      'recall'
    );

    // Build the sources folder path
    const sourcesFolder = path.join(
      target.absolutePath,
      'memory',
      'sources',
      subfolder
    );

    // Ensure the folder exists
    await fs.mkdir(sourcesFolder, { recursive: true });

    // Get unique file path
    const basePath = path.join(sourcesFolder, filename);
    const filePath = await getUniqueFilePath(basePath);

    // Build frontmatter
    const now = new Date().toISOString();
    const occurredAt = data.startTime.split('T')[0];
    const safeConferenceUrl = stripUrlCredentials(data.meetingUrl);

    const frontmatterLines = [
      '---',
      `description: "${(data.meetingTitle || smartTitle).replace(/"/g, '\\"')}"`,
      'source_type: meeting',
      'source_system: recall',
      `source_account: ${userEmail || 'unknown'}`,
      `source_uid: ${data.botId}`,
      `source_url: "urn:recall:transcript:${data.botId}"`,
      `occurred_at: ${occurredAt}`,
      `started_at: ${data.startTime}`,
      `stored_at: ${now.split('T')[0]}`,
      `last_updated: ${now}`,
      'truncated: false',
      'live: true', // Key flag: indicates this is a live transcript being written
      'transcript_quality: captions',
    ];

    if (data.participants.length > 0) {
      frontmatterLines.push('participants:');
      for (const p of data.participants) {
        frontmatterLines.push(`  - "${p.replace(/"/g, '\\"')}"`);
      }
    }

    if (safeConferenceUrl) {
      frontmatterLines.push(`conference_url: "${safeConferenceUrl}"`);
    }

    if (data.calendarEventId) {
      frontmatterLines.push(`calendar_event_id: ${data.calendarEventId}`);
    }
    if (data.calendarSource) {
      frontmatterLines.push(`calendar_source: ${data.calendarSource}`);
    }

    frontmatterLines.push('---');

    // Build content
    const title = data.meetingTitle || 'Meeting in Progress';
    const content = formatLiveTranscriptContent(segments);
    const chatSection = formatChatSection(chatMessages ?? data.chatMessages);

    const markdownSections = [
      frontmatterLines.join('\n'),
      '',
      `# ${title}`,
      '',
      '## Full Content',
      '',
      content,
    ];

    if (chatSection) {
      markdownSections.push('', chatSection);
    }

    const markdown = markdownSections.join('\n');

    // Write atomically
    await atomicWriteFile(filePath, markdown, 'utf8');

    log.info(
      { botId: data.botId, filePath, segmentCount: segments.length },
      'Created live transcript file'
    );

    return { success: true, filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, botId: data.botId }, 'Failed to create live transcript');
    return { success: false, error: message };
  }
}

/**
 * Append new segments to an existing live transcript file.
 * Reads the existing file, appends new content, and writes atomically.
 *
 * @param filePath - Absolute path to the live transcript file
 * @param allSegments - All segments (including previously written ones)
 * @param lastPersistedIndex - Index of last segment already in file
 * @returns Number of new segments written
 */
export async function appendToLiveTranscript(
  filePath: string,
  allSegments: LiveTranscriptSegment[],
  lastPersistedIndex: number,
  chatMessages?: ChatMessage[]
): Promise<{ success: boolean; newSegmentsWritten: number; error?: string }> {
  try {
    // Get new segments to append
    const newSegments = allSegments.slice(lastPersistedIndex);
    const hasChatUpdate = chatMessages !== undefined && chatMessages.length > 0;
    if (newSegments.length === 0 && !hasChatUpdate) {
      return { success: true, newSegmentsWritten: 0 };
    }

    // Read existing file
    const content = await fs.readFile(filePath, 'utf-8');

    if (!fm.test(content)) {
      return { success: false, newSegmentsWritten: 0, error: 'File does not contain valid frontmatter' };
    }

    const { attributes, body } = fm<Record<string, unknown>>(content);

    // Update last_updated timestamp
    attributes.last_updated = new Date().toISOString();

    // Rebuild frontmatter
    const frontmatterLines = ['---'];
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value)) {
        frontmatterLines.push(`${key}:`);
        for (const item of value) {
          frontmatterLines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
        }
      } else if (typeof value === 'boolean') {
        frontmatterLines.push(`${key}: ${value}`);
      } else if (typeof value === 'string' && (value.includes('\n') || value.includes('"'))) {
        frontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
      } else {
        frontmatterLines.push(`${key}: ${value}`);
      }
    }
    frontmatterLines.push('---');

    // Format new content
    const newContent = formatLiveTranscriptContent(newSegments);

    const bodyLines = body.split('\n');
    const chatMarkerIndex = bodyLines.findIndex((line) => line.trim() === CHAT_SECTION_MARKER);

    const transcriptBody = (
      chatMarkerIndex >= 0
        ? bodyLines.slice(0, chatMarkerIndex).join('\n')
        : body
    ).trimEnd();

    const existingChatSection = chatMarkerIndex >= 0
      ? bodyLines.slice(chatMarkerIndex).join('\n').trim()
      : '';

    // Append new transcript content before any chat section
    const separator = transcriptBody.endsWith('\n') || transcriptBody.length === 0 ? '' : '\n';
    const updatedTranscriptBody = `${transcriptBody}${separator}${newContent}`.trimEnd();

    const rebuiltChatSection = chatMessages === undefined || chatMessages.length === 0
      ? existingChatSection
      : formatChatSection(chatMessages);

    const updatedBody = [updatedTranscriptBody, rebuiltChatSection]
      .filter((section) => section.length > 0)
      .join('\n\n') + '\n';

    // Write atomically
    const updatedMarkdown = frontmatterLines.join('\n') + '\n' + updatedBody;
    await atomicWriteFile(filePath, updatedMarkdown, 'utf8');

    log.debug(
      { filePath, newSegmentsWritten: newSegments.length, totalSegments: allSegments.length },
      'Appended segments to live transcript'
    );

    return { success: true, newSegmentsWritten: newSegments.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, filePath }, 'Failed to append to live transcript');
    return { success: false, newSegmentsWritten: 0, error: message };
  }
}

/**
 * Read frontmatter from a live transcript file.
 * Used to check `live` flag and other metadata for upgrade decisions.
 */
export async function readLiveTranscriptFrontmatter(
  filePath: string
): Promise<{ success: boolean; frontmatter?: LiveTranscriptFrontmatter; error?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    if (!fm.test(content)) {
      return { success: false, error: 'File does not contain valid frontmatter' };
    }

    const { attributes } = fm<Record<string, unknown>>(content);

    const frontmatter: LiveTranscriptFrontmatter = {
      live: attributes.live === true,
      source_uid: String(attributes.source_uid || ''),
      started_at: attributes.started_at ? String(attributes.started_at) : undefined,
      last_updated: attributes.last_updated ? String(attributes.last_updated) : undefined,
      transcript_quality: attributes.transcript_quality ? String(attributes.transcript_quality) : undefined,
      conference_url: attributes.conference_url ? String(attributes.conference_url) : undefined,
      calendar_event_id: attributes.calendar_event_id ? String(attributes.calendar_event_id) : undefined,
      calendar_source: attributes.calendar_source ? String(attributes.calendar_source) : undefined,
      participants: Array.isArray(attributes.participants) 
        ? attributes.participants.map(String) 
        : undefined,
    };

    return { success: true, frontmatter };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, filePath }, 'Failed to read live transcript frontmatter');
    return { success: false, error: message };
  }
}

/**
 * Parse a live transcript file back into segments.
 * Used to rehydrate in-memory transcript buffers after app restart.
 * Parses the `**Speaker**: text` markdown format produced by formatLiveTranscriptContent.
 */
export async function parseLiveTranscriptSegments(
  filePath: string
): Promise<{ success: boolean; segments: LiveTranscriptSegment[]; error?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    if (!fm.test(content)) {
      return { success: false, segments: [], error: 'File does not contain valid frontmatter' };
    }

    const { body } = fm<Record<string, unknown>>(content);

    // Strip markdown headers (# Title, ## Full Content) to get just transcript lines
    const lines = body.split('\n');
    const segments: LiveTranscriptSegment[] = [];
    let currentSpeaker = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === CHAT_SECTION_MARKER) break;
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Match **Speaker**: text
      const speakerMatch = trimmed.match(/^\*\*(.+?)\*\*:\s*(.*)$/);
      if (speakerMatch) {
        currentSpeaker = speakerMatch[1];
        const text = speakerMatch[2].trim();
        if (text) {
          const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
          segments.push({ speaker: currentSpeaker, text, timestamp: Date.now(), wordCount });
        }
      } else if (currentSpeaker) {
        // Continuation line for same speaker
        const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
        segments.push({ speaker: currentSpeaker, text: trimmed, timestamp: Date.now(), wordCount });
      }
    }

    log.info({ filePath, segmentCount: segments.length }, 'Parsed live transcript segments for rehydration');
    return { success: true, segments };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, filePath }, 'Failed to parse live transcript segments');
    return { success: false, segments: [], error: message };
  }
}

/**
 * Upgrade an existing live transcript file with Recall API data.
 * Only upgrades if Recall data is non-empty (guards against 66% failure rate).
 *
 * @param filePath - Absolute path to the live transcript file
 * @param recallData - Data from Recall API
 * @returns Result indicating success, already upgraded, or skipped due to empty data
 */
export async function upgradeExistingLiveTranscript(
  filePath: string,
  recallData: TranscriptData
): Promise<{ success: boolean; alreadyUpgraded?: boolean; skippedEmpty?: boolean; staged?: boolean; error?: string }> {
  try {
    // Guard: Only upgrade if Recall data is non-empty
    if (!recallData.rawTranscript || recallData.rawTranscript.trim().length === 0) {
      log.warn(
        { filePath, botId: recallData.botId },
        'Skipping upgrade - Recall returned empty transcript'
      );
      return { success: false, skippedEmpty: true };
    }

    // Read existing file to check state
    const content = await fs.readFile(filePath, 'utf-8');

    if (!fm.test(content)) {
      return { success: false, error: 'File does not contain valid frontmatter' };
    }

    const { attributes, body: existingBody } = fm<Record<string, unknown>>(content);

    // Check if already upgraded
    if (attributes.live !== true) {
      log.debug({ filePath }, 'Live transcript already upgraded');
      return { success: true, alreadyUpgraded: true };
    }

    // Verify botId matches
    if (attributes.source_uid !== recallData.botId) {
      return { 
        success: false, 
        error: `Bot ID mismatch: file has ${attributes.source_uid}, upgrade data has ${recallData.botId}` 
      };
    }

    // Get user info
    const authState = getRebelAuthProvider().getAuthState();
    const userEmail = authState?.user?.email ?? null;

    // Preserve key frontmatter from live file, update with Recall data
    const durationMinutes = Math.round(recallData.duration / 60);
    const isTruncated = recallData.rawTranscript.length > MAX_CONTENT_SIZE;
    const truncatedTranscript = isTruncated
      ? recallData.rawTranscript.slice(0, MAX_CONTENT_SIZE - 200) + '\n\n*[Content truncated due to size]*'
      : recallData.rawTranscript;

    // Build new frontmatter (merge live + Recall)
    const frontmatterLines = [
      '---',
      `description: "${recallData.meetingTitle.replace(/"/g, '\\"')}"`,
      'source_type: meeting',
      `source_system: ${recallData.sourceSystem ?? 'recall'}`,
      `source_account: ${userEmail || 'unknown'}`,
      `source_uid: ${recallData.botId}`,
      `source_url: "urn:recall:transcript:${recallData.botId}"`,
      `occurred_at: ${recallData.startTime.split('T')[0]}`,
      `started_at: ${new Date(recallData.startTime).toISOString()}`,
      `stored_at: ${new Date().toISOString().split('T')[0]}`,
      `truncated: ${isTruncated}`,
      `duration_minutes: ${durationMinutes}`,
      `transcript_quality: ${recallData.transcriptQuality ?? 'recallai_async'}`,
      // Note: no 'live: true' - this indicates upgrade complete
    ];

    // Use Recall participants if available, otherwise preserve existing
    const participants = recallData.participants.length > 0 
      ? recallData.participants 
      : (Array.isArray(attributes.participants) ? attributes.participants.map(String) : []);
    
    if (participants.length > 0) {
      frontmatterLines.push('participants:');
      for (const p of participants) {
        frontmatterLines.push(`  - "${p.replace(/"/g, '\\"')}"`);
      }
    }

    // Preserve conference URL from live file (Recall might not have it)
    const conferenceUrl = recallData.meetingUrl || String(attributes.conference_url || '');
    const safeConferenceUrl = stripUrlCredentials(conferenceUrl);
    if (safeConferenceUrl) {
      frontmatterLines.push(`conference_url: "${safeConferenceUrl}"`);
    }

    // Preserve calendar linkage from live file
    const calendarEventId = recallData.calendarEventId || String(attributes.calendar_event_id || '');
    const calendarSource = recallData.calendarSource || String(attributes.calendar_source || '');
    if (calendarEventId) {
      frontmatterLines.push(`calendar_event_id: ${calendarEventId}`);
    }
    if (calendarSource) {
      frontmatterLines.push(`calendar_source: ${calendarSource}`);
    }

    if (recallData.recordingId) {
      frontmatterLines.push(`recording_id: ${recallData.recordingId}`);
    }

    frontmatterLines.push('---');

    // Build content sections
    const sections: string[] = [];

    // Title
    sections.push(`# ${recallData.meetingTitle}\n`);

    // Summary section (from Recall AI summary if available)
    if (recallData.summary) {
      sections.push('## Summary\n');
      sections.push(recallData.summary);
      sections.push('');
    }

    // Key Takeaways
    if (recallData.keyPoints && recallData.keyPoints.length > 0) {
      sections.push('## Key Takeaways\n');
      for (const point of recallData.keyPoints) {
        sections.push(`- ${point}`);
      }
      sections.push('');
    }

    // Action items
    if (recallData.actionItems && recallData.actionItems.length > 0) {
      sections.push('## Action Items\n');
      for (const item of recallData.actionItems) {
        sections.push(`- [ ] ${item}`);
      }
      sections.push('');
    }

    // Full Content (Recall transcript replaces captions)
    sections.push('## Full Content\n');
    if (isTruncated) {
      sections.push(`*Content truncated due to size. See full source at urn:recall:transcript:${recallData.botId}*\n`);
    }
    sections.push(truncatedTranscript);

    // Chat section: use Recall data if available, otherwise preserve from live file
    let chatSectionContent = formatChatSection(recallData.chatMessages);
    if (!chatSectionContent) {
      // Preserve existing chat section from the live file (guards against backend fetch failure)
      const bodyLines = existingBody.split('\n');
      const chatIdx = bodyLines.findIndex((line: string) => line.trim() === CHAT_SECTION_MARKER);
      if (chatIdx >= 0) {
        chatSectionContent = bodyLines.slice(chatIdx).join('\n').trim();
      }
    }
    if (chatSectionContent) {
      sections.push('');
      sections.push(chatSectionContent);
    }

    // Replace file content and run sensitivity guard before final emit.
    const markdown = frontmatterLines.join('\n') + '\n\n' + sections.join('\n');
    const inputForTargetResolution = toMeetingSourceInput({
      ...recallData,
      sourceSystem: 'recall',
    });
    if (!inputForTargetResolution || inputForTargetResolution.kind !== 'recall') {
      return {
        success: false,
        error: 'Unable to resolve upgrade target input',
      };
    }

    const kernelDeps = createSaveMeetingSourceDeps();
    const coreDirectory = kernelDeps.getCoreDirectory();
    if (!coreDirectory) {
      return {
        success: false,
        error: mapKernelFailureReasonToError('no_workspace'),
      };
    }

    let target = null;
    try {
      target = await kernelDeps.resolveTargetSpace(coreDirectory, inputForTargetResolution);
    } catch (error) {
      log.warn(
        { err: error, filePath, botId: recallData.botId },
        'Failed to resolve target space for live transcript upgrade',
      );
      return {
        success: false,
        error: mapKernelFailureReasonToError('no_target_space'),
      };
    }

    if (!target) {
      return {
        success: false,
        error: mapKernelFailureReasonToError('no_target_space'),
      };
    }

    const savedEvent = {
      sourceSystem: 'recall' as const,
      sourceUid: recallData.botId,
      filePath,
      spacePath: target.spacePath,
      meetingTitle: recallData.meetingTitle,
      startTime: recallData.startTime,
      participants,
      duration: recallData.duration,
      alreadyExists: false,
      timestamp: Date.now(),
      meetingUrl: safeConferenceUrl || undefined,
      calendarEventId: calendarEventId || undefined,
    };

    const upgraded = await upgradeWithGuardAndEmit(
      {
        upgrade: {
          filePath,
          newTranscript: markdown,
          newQuality: recallData.transcriptQuality === 'desktop_sdk' ? 'desktop_sdk' : 'recallai_async',
          sourceUid: recallData.botId,
          sourceSystem: 'recall',
          spacePath: target.spacePath,
          meetingTitle: recallData.meetingTitle,
          meetingUrl: safeConferenceUrl || undefined,
          calendarEventId: calendarEventId || undefined,
          emitSavedFirst: { event: savedEvent },
        },
        rawTranscript: recallData.rawTranscript,
        coreDirectory,
        target,
        stageSessionId: `transcript-upgrade-${recallData.botId}`,
      },
      {
        evaluateGuard: kernelDeps.evaluateGuard,
        writeToPending: kernelDeps.writeToPending,
        broadcastStaging: kernelDeps.broadcastStaging,
        deferTranscriptSaved: kernelDeps.deferTranscriptSaved,
        writeFile: async (targetPath, content) => {
          await atomicWriteFile(targetPath, content, 'utf8');
        },
        readFile: async (targetPath) => fs.readFile(targetPath, 'utf-8'),
        emitTranscriptSaved: kernelDeps.emitTranscriptSaved,
        emitTranscriptDistributionReady: kernelDeps.emitTranscriptDistributionReady,
        logger: log,
      },
    );

    if (!upgraded.success) {
      return {
        success: false,
        error: upgraded.error?.message ?? mapKernelFailureReasonToError(upgraded.reason),
      };
    }

    if (upgraded.staged) {
      log.info(
        { filePath, botId: recallData.botId },
        'Upgraded live transcript staged for review, event deferred until approval',
      );
      return { success: true, staged: true };
    }

    log.info(
      {
        filePath,
        botId: recallData.botId,
        quality: recallData.transcriptQuality,
        alreadyUpgraded: upgraded.alreadyUpgraded ?? false,
      },
      'Upgraded live transcript with Recall data'
    );

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, filePath, botId: recallData.botId }, 'Failed to upgrade live transcript');
    return { success: false, error: message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PREP/TRANSCRIPT LINKING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the transcript file path for a prep file (if it exists).
 * Transcripts are named: {prep-basename without -prep}.md
 */
export async function findTranscriptForPrep(prepPath: string): Promise<string | null> {
  const dir = path.dirname(prepPath);
  const basename = path.basename(prepPath, '.md');
  
  if (!basename.endsWith('-prep')) {
    return null;
  }
  
  const transcriptBasename = basename.slice(0, -5); // Remove '-prep'
  const transcriptPath = path.join(dir, `${transcriptBasename}.md`);
  
  try {
    await fs.access(transcriptPath);
    return transcriptPath;
  } catch {
    return null;
  }
}

/**
 * Update a markdown file's frontmatter to add a link field.
 * Creates the field if it doesn't exist, updates if it does.
 */
async function updateFrontmatterLink(
  filePath: string,
  linkField: 'prep' | 'transcript',
  linkedPath: string
): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    if (!fm.test(content)) {
      log.warn({ filePath }, 'File does not contain valid frontmatter for linking');
      return false;
    }
    
    const { attributes, body } = fm<Record<string, unknown>>(content);
    
    // Use relative path for the link (same directory)
    const relativePath = `./${path.basename(linkedPath)}`;
    
    // Check if already linked
    if (attributes[linkField] === relativePath) {
      return true; // Already linked
    }
    
    // Add/update the link
    attributes[linkField] = relativePath;
    
    // Rebuild frontmatter
    const frontmatterLines = ['---'];
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value)) {
        frontmatterLines.push(`${key}:`);
        for (const item of value) {
          frontmatterLines.push(`  - ${JSON.stringify(item)}`);
        }
      } else if (typeof value === 'object' && value !== null) {
        frontmatterLines.push(`${key}: ${JSON.stringify(value)}`);
      } else if (typeof value === 'string' && value.includes('\n')) {
        frontmatterLines.push(`${key}: |`);
        for (const line of value.split('\n')) {
          frontmatterLines.push(`  ${line}`);
        }
      } else {
        frontmatterLines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    frontmatterLines.push('---');
    
    const newContent = frontmatterLines.join('\n') + '\n' + body;
    await fs.writeFile(filePath, newContent, 'utf-8');
    
    log.info({ filePath, linkField, linkedPath: relativePath }, 'Updated frontmatter with link');
    return true;
  } catch (error) {
    log.error({ error, filePath, linkField }, 'Failed to update frontmatter link');
    return false;
  }
}

/**
 * Create two-way links between a transcript and its prep file.
 * Call this after saving a transcript or prep file.
 */
export async function linkPrepAndTranscript(
  transcriptPath: string,
  prepPath: string
): Promise<void> {
  // Update transcript to link to prep
  await updateFrontmatterLink(transcriptPath, 'prep', prepPath);
  
  // Update prep to link to transcript
  await updateFrontmatterLink(prepPath, 'transcript', transcriptPath);
}

/**
 * After saving a transcript, check if a prep file exists and create two-way links.
 */
export async function linkTranscriptToExistingPrep(transcriptPath: string): Promise<void> {
  const prepPath = await findPrepForTranscript(transcriptPath);
  if (prepPath) {
    await linkPrepAndTranscript(transcriptPath, prepPath);
  }
}

/**
 * After saving a prep file, check if a transcript exists and create two-way links.
 */
export async function linkPrepToExistingTranscript(prepPath: string): Promise<void> {
  const transcriptPath = await findTranscriptForPrep(prepPath);
  if (transcriptPath) {
    await linkPrepAndTranscript(transcriptPath, prepPath);
  }
}
