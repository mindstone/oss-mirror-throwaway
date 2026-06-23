/**
 * Cloud Meeting Fallback Analysis
 *
 * Receives meeting transcripts from the worker (when desktop was offline)
 * and runs post-meeting analysis: saves transcript to workspace, then runs
 * a headless agent turn with the analysis prompt to create an inbox item.
 *
 * Uses MEETING_ANALYSIS_PROMPT from @core/services/meetingAnalysisPrompt (shared with desktop).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createScopedLogger } from '@core/logger';
import {
  createMeetingAnalysisSessionId,
  runMeetingAnalysisFromTranscript,
} from '@core/services/meeting/analysis';
import { derivePolicy } from '@core/services/turnPolicy';
import type { AgentEvent, AgentAttachmentPayload } from '@shared/types';
import type { CompanionQAEntry } from '@core/services/meetings/meetingSessionTypes';
import type { TurnPolicy } from '@core/types/turnPolicy';

const log = createScopedLogger({ service: 'cloud-meeting-analysis' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeetingConversationState {
  currentTopic?: string;
  summary?: string;
  openQuestions?: string[];
  recentDecisions?: string[];
}

export type { CompanionQAEntry };

export interface FallbackAnalysisPayload {
  botId: string;
  userId: string;
  meetingTitle: string;
  transcript: string;
  participants: string[];
  meetingStartTime: number | null;
  /** Conversation state accumulated during the meeting (topics, decisions, questions) */
  conversationState?: MeetingConversationState;
  /** Q&A history from the companion session (Ask Rebel during meeting) */
  companionQAHistory?: CompanionQAEntry[];
}

export interface CloudMeetingAnalysisDeps {
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      resetConversation: boolean;
      bypassToolSafety?: boolean;
      attachments?: AgentAttachmentPayload[];
      onEvent: (event: AgentEvent) => void;
      policy?: TurnPolicy;
    },
  ) => Promise<void>;
  getSettings: () => { coreDirectory?: string };
}

// ---------------------------------------------------------------------------
// Month abbreviations for folder names (matching desktop transcriptStorage.ts)
// ---------------------------------------------------------------------------
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Transcript saving
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a filename component.
 */
function sanitizeForFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Build the transcript file path using the sources architecture layout:
 * {workspace}/Chief-of-Staff/memory/sources/YYYY/MM-MMM/DD/{filename}.md
 */
function buildTranscriptPath(
  workspacePath: string,
  meetingTitle: string,
  meetingDate: Date,
  sourceSystem: string = 'cloud-fallback',
): { dirPath: string; filePath: string; workspaceRelativePath: string } {
  const year = String(meetingDate.getFullYear());
  const yy = year.slice(-2);
  const month = String(meetingDate.getMonth() + 1).padStart(2, '0');
  const monthAbbrev = MONTH_ABBREVS[meetingDate.getMonth()];
  const day = String(meetingDate.getDate()).padStart(2, '0');
  const hours = String(meetingDate.getHours()).padStart(2, '0');
  const minutes = String(meetingDate.getMinutes()).padStart(2, '0');

  const smartTitle = sanitizeForFilename(meetingTitle) || 'meeting';
  const subfolder = path.join(year, `${month}-${monthAbbrev}`, day);
  const filename = `${yy}${month}${day}_${hours}${minutes}_meeting_${sourceSystem}_${smartTitle}.md`;

  const dirPath = path.join(workspacePath, 'Chief-of-Staff', 'memory', 'sources', subfolder);
  const filePath = path.join(dirPath, filename);
  const workspaceRelativePath = path.join('Chief-of-Staff', 'memory', 'sources', subfolder, filename);

  return { dirPath, filePath, workspaceRelativePath };
}

/**
 * Format the transcript as markdown with YAML frontmatter.
 * Simplified version of desktop's formatTranscriptMarkdown for cloud fallback.
 */
function formatTranscriptMarkdown(payload: FallbackAnalysisPayload, meetingDate: Date, sourceSystem: string = 'cloud-fallback'): string {
  const occurredAt = meetingDate.toISOString().split('T')[0];
  const storedAt = new Date().toISOString().split('T')[0];

  const frontmatterLines = [
    '---',
    `description: "${payload.meetingTitle.replace(/"/g, '\\"')}"`,
    'source_type: meeting',
    `source_system: ${sourceSystem}`,
    `source_uid: ${payload.botId}`,
    `occurred_at: ${occurredAt}`,
    `stored_at: ${storedAt}`,
  ];

  if (payload.participants.length > 0) {
    frontmatterLines.push('participants:');
    for (const p of payload.participants) {
      frontmatterLines.push(`  - "${p.replace(/"/g, '\\"')}"`);
    }
  }

  frontmatterLines.push('---');

  const sections = [
    frontmatterLines.join('\n'),
    '',
    `# ${payload.meetingTitle}`,
    '',
    '## Transcript',
    '',
    payload.transcript,
  ];

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Analysis prompt helpers
// ---------------------------------------------------------------------------

/**
 * Build an optional meeting context block from conversation state and Q&A history.
 * Returns an empty string when neither is available (backward compatible).
 */
function buildMeetingContextBlock(
  conversationState?: MeetingConversationState,
  companionQAHistory?: CompanionQAEntry[],
): string {
  const sections: string[] = [];

  if (conversationState) {
    const stateLines: string[] = [];
    if (conversationState.currentTopic) {
      stateLines.push(`Current topic: ${conversationState.currentTopic}`);
    }
    if (conversationState.summary) {
      stateLines.push(`Summary: ${conversationState.summary}`);
    }
    if (conversationState.recentDecisions && conversationState.recentDecisions.length > 0) {
      stateLines.push('Key decisions:');
      for (const decision of conversationState.recentDecisions) {
        stateLines.push(`  - ${decision}`);
      }
    }
    if (conversationState.openQuestions && conversationState.openQuestions.length > 0) {
      stateLines.push('Open questions:');
      for (const question of conversationState.openQuestions) {
        stateLines.push(`  - ${question}`);
      }
    }
    if (stateLines.length > 0) {
      sections.push(`[MEETING CONVERSATION STATE]\n${stateLines.join('\n')}\n[/MEETING CONVERSATION STATE]`);
    }
  }

  if (companionQAHistory && companionQAHistory.length > 0) {
    const qaLines: string[] = ['The user asked these questions during the meeting via Ask Rebel:'];
    for (const entry of companionQAHistory) {
      qaLines.push(`- Q: "${entry.question}"`);
      qaLines.push(`  A: ${entry.answer}`);
    }
    sections.push(`[MEETING Q&A HISTORY]\n${qaLines.join('\n')}\n[/MEETING Q&A HISTORY]`);
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Analysis pipeline
// ---------------------------------------------------------------------------

/**
 * Run the cloud fallback meeting analysis pipeline:
 * 1. Save transcript to workspace
 * 2. Run headless agent turn with analysis prompt
 */
export async function runFallbackAnalysis(
  payload: FallbackAnalysisPayload,
  deps: CloudMeetingAnalysisDeps,
  sourceSystem: string = 'cloud-fallback',
  targetSessionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const { botId, meetingTitle, transcript } = payload;

  const settings = deps.getSettings();
  const coreDirectory = settings.coreDirectory;

  if (!coreDirectory) {
    log.warn({ botId }, 'No core directory configured, skipping cloud fallback analysis');
    return { success: false, error: 'No core directory configured' };
  }

  if (!transcript.trim()) {
    log.warn({ botId }, 'Empty transcript, skipping cloud fallback analysis');
    return { success: false, error: 'Empty transcript' };
  }

  // Determine meeting date
  const meetingDate = payload.meetingStartTime
    ? new Date(payload.meetingStartTime)
    : new Date();

  // Build file path
  const { dirPath, filePath, workspaceRelativePath } = buildTranscriptPath(
    coreDirectory,
    meetingTitle,
    meetingDate,
    sourceSystem,
  );

  // Idempotency: check if transcript file already exists
  try {
    await fs.access(filePath);
    log.info({ botId, filePath }, 'Transcript already exists, skipping save (idempotent)');
    // Still run analysis in case it failed previously — the prompt reads the file
  } catch {
    // File doesn't exist — save it
    try {
      await fs.mkdir(dirPath, { recursive: true });
      const markdown = formatTranscriptMarkdown(payload, meetingDate, sourceSystem);
      await fs.writeFile(filePath, markdown, 'utf-8');
      log.info({ botId, filePath, workspaceRelativePath }, 'Transcript saved to workspace');
    } catch (err) {
      log.error({ err, botId, filePath }, 'Failed to save transcript to workspace');
      return { success: false, error: `Failed to save transcript: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Run headless agent turn with analysis prompt
  const turnId = `cloud-meeting-analysis-${randomUUID()}`;
  const sessionId = targetSessionId || createMeetingAnalysisSessionId('meeting-analysis');

  try {
    const meetingContextBlock = buildMeetingContextBlock(
      payload.conversationState,
      payload.companionQAHistory,
    );

    const contextBlocks = meetingContextBlock ? [meetingContextBlock] : [];

    log.info({ botId, turnId, sessionId, sourceSystem, isTargeted: !!targetSessionId }, 'Starting cloud meeting analysis');

    await runMeetingAnalysisFromTranscript({
      transcriptPath: filePath,
      workspaceRelativePath,
      sessionId,
      resetConversation: !targetSessionId,
      contextBlocks,
      onEvent: (event) => {
        if (event.type === 'error') {
          log.warn({ error: event.error, botId, turnId }, 'Cloud fallback analysis error event');
        }
      },
      execute: async ({ sessionId: requestSessionId, resetConversation, prompt, attachments, onEvent }) => deps.executeAgentTurn(turnId, prompt, {
        sessionId: requestSessionId,
        resetConversation,
        bypassToolSafety: true,
        attachments,
        onEvent,
        policy: derivePolicy(undefined),
      }),
    });

    log.info({ botId, turnId, sessionId, sourceSystem }, 'Cloud meeting analysis completed');
    return { success: true };
  } catch (err) {
    log.error({ err, botId, turnId, sessionId, sourceSystem }, 'Cloud meeting analysis failed');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
