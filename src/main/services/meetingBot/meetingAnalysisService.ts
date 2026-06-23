/**
 * Meeting Analysis Service
 *
 * Triggers automatic meeting analysis after transcript save.
 * Runs as a fire-and-forget background process that creates an inbox item.
 */

import * as fs from 'node:fs/promises';
import type { AgentEvent, AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import { relativePortablePath } from '@core/utils/portablePath';
import { resolveActiveWorkingSingleModelAuxiliaryTurnOverrides } from '@shared/utils/auxiliaryTurnConfig';
import {
  createMeetingAnalysisSessionId,
  runMeetingAnalysisFromTranscript,
} from '@core/services/meeting/analysis';
import { markAnalysisTriggered, markAnalysisCompleted } from './pendingTranscriptsStore';
import { findPrepForTranscript } from './transcriptStorage';
import { formatMeetingContext, type ConversationState } from './conversationStateService';

const log = createScopedLogger({ service: 'meeting-analysis' });

export type MeetingAnalysisDeps = {
  runHeadlessTurn: (params: {
    prompt: string;
    onEvent: (event: AgentEvent) => void;
    options: HeadlessTurnOptions;
  }) => Promise<void>;
  getSettings: () => AppSettings;
};

let deps: MeetingAnalysisDeps | null = null;

export const initializeMeetingAnalysisService = (dependencies: MeetingAnalysisDeps): void => {
  deps = dependencies;
  log.info('Meeting analysis service initialized');
};

export type TriggerMeetingAnalysisResult = { ran: boolean; error?: string };

export type TriggerMeetingAnalysisOptions = {
  /** Skip writing to pendingTranscriptsStore (used for physical recordings which have their own store) */
  skipMeetingBotTracking?: boolean;
  /** Serialized conversation state persisted in pendingTranscriptsStore */
  conversationState?: string;
};

export const triggerMeetingAnalysis = async (
  botId: string,
  transcriptPath: string,
  _spacePath?: string,
  options?: TriggerMeetingAnalysisOptions
): Promise<TriggerMeetingAnalysisResult> => {
  const currentDeps = deps;
  if (!currentDeps) {
    log.warn('Meeting analysis service not initialized, skipping analysis');
    return { ran: false, error: 'Service not initialized' };
  }

  const settings = currentDeps.getSettings();
  const coreDirectory = settings.coreDirectory;

  if (!coreDirectory) {
    log.warn('No core directory configured, skipping meeting analysis');
    return { ran: false, error: 'No core directory configured' };
  }

  // Mark as triggered AFTER validating deps (so early-returns don't block retries)
  // Skip for physical recordings which use their own pendingPhysicalRecordingsStore
  if (!options?.skipMeetingBotTracking) {
    markAnalysisTriggered(botId);
  }

  try {
    const workspaceRelativePath = relativePortablePath(coreDirectory, transcriptPath);

    // Check if a prep file exists and read it for context
    let prepContent: string | undefined;
    let prepPath: string | undefined;
    const foundPrepPath = await findPrepForTranscript(transcriptPath);
    if (foundPrepPath) {
      try {
        prepContent = await fs.readFile(foundPrepPath, 'utf8');
        prepPath = relativePortablePath(coreDirectory, foundPrepPath);
        log.info({ botId, prepPath }, 'Found prep file, including in analysis context');
      } catch (err) {
        log.warn({ error: err, prepPath: foundPrepPath }, 'Failed to read prep file');
      }
    }

    // Use prefixed session ID to exclude from time-saved tracking (see agentMessageHandler.ts)
    const sessionId = createMeetingAnalysisSessionId('meeting-analysis');

    let meetingContextBlock = '';
    if (options?.conversationState) {
      try {
        const parsedState = JSON.parse(options.conversationState) as ConversationState;
        meetingContextBlock = formatMeetingContext(parsedState);
      } catch (error) {
        log.warn({ error }, 'Failed to parse persisted conversation state for analysis prompt');
      }
    }

    const contextBlocks: string[] = [];
    if (prepContent && prepPath) {
      contextBlocks.push(`[MEETING PREP CONTEXT]
A meeting prep was generated before this meeting. Use it to:
- Check if expected topics were covered
- Note any unresolved questions from prep
- Compare outcomes to stated goals
- Highlight any surprises vs expectations

Prep file: ${prepPath}
---
${prepContent}
---`);
    }
    if (meetingContextBlock) {
      contextBlocks.push(meetingContextBlock);
    }

    log.info({ botId, transcriptPath, workspaceRelativePath, sessionId, hasPrep: !!prepContent }, 'Triggering meeting analysis');
    const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(settings);

    await runMeetingAnalysisFromTranscript({
      transcriptPath,
      workspaceRelativePath,
      sessionId,
      resetConversation: true,
      contextBlocks,
      onEvent: (event) => {
        if (event.type === 'error') {
          log.warn({ error: event.error, botId, sessionId }, 'Meeting analysis error event');
        }
      },
      execute: async ({ sessionId: requestSessionId, resetConversation, prompt, attachments, onEvent }) => currentDeps.runHeadlessTurn({
        prompt,
        onEvent,
        options: {
          sessionType: 'automation',
          persistMode: { kind: 'none' },
          sessionId: requestSessionId,
          resetConversation,
          attachments,
          modelOverride: auxiliaryOverrides.modelOverride,
          workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
          thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
        },
      }),
    });

    // Mark as completed when runHeadlessTurn resolves successfully
    // Skip for physical recordings which use their own pendingPhysicalRecordingsStore
    if (!options?.skipMeetingBotTracking) {
      markAnalysisCompleted(botId);
    }
    log.info({ botId, transcriptPath, sessionId }, 'Meeting analysis completed');
    return { ran: true };
  } catch (error) {
    log.error({ error, botId, transcriptPath }, 'Failed to trigger meeting analysis');
    return { ran: false, error: error instanceof Error ? error.message : String(error) };
  }
};
