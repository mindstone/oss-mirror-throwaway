/**
 * Transcript Sensitivity Guard
 *
 * Evaluates whether a meeting transcript should be directly saved to a shared space
 * or staged in the Chief-of-Staff pending folder for user review.
 *
 * Uses the Safety Prompt evaluation pipeline (evaluateSafetyPrompt + shouldAllow)
 * for balanced mode, matching the pattern used by memoryWriteHook's primary path.
 */

import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { createScopedLogger } from '@core/logger';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { getSafetyPrompt, getSafetyPromptVersion, isMigrationComplete } from '@core/safetyPromptStore';
import type { ActionContext } from '@core/safetyPromptTypes';
import { getSettings } from '@core/services/settingsStore';
import { hasValidAuth } from '../../utils/authEnvUtils';
import {
  resolveMemorySafetyLevel,
  isVerifiedChiefOfStaff,
  normalizeSharing,
  summarizeContent,
} from '../safety/memoryWriteHook';

const log = createScopedLogger({ service: 'transcript-sensitivity-guard' });

/** Target space metadata from determineTargetSpace */
interface TargetSpace {
  spacePath: string;
  absolutePath: string;
  sharing: string;
  spaceName?: string;
  description?: string;
}

/** Result of transcript sensitivity evaluation */
export interface TranscriptSensitivityResult {
  decision: 'allow' | 'stage';
  reason?: string;
  summary?: string;
}

/**
 * Evaluate whether a transcript should be allowed to save directly to a shared space
 * or staged for user review.
 *
 * Decision flow:
 * 1. Private spaces → allow (user's own space)
 * 2. Verified Chief-of-Staff → allow (personal space)
 * 3. Permissive safety level → allow (user opted out of checks)
 * 4. No auth available → stage (can't run LLM evaluation)
 * 5. Balanced: run Safety Prompt eval → stage if blocked, failed, or migration incomplete
 * 6. Cautious: always stage with summary
 */
export async function evaluateTranscriptForSharedSpace(
  transcriptContent: string,
  targetSpace: TargetSpace,
  _coreDirectory: string
): Promise<TranscriptSensitivityResult> {
  const { spacePath, sharing, spaceName, description } = targetSpace;
  const normalizedSharing = normalizeSharing(sharing);

  // Private spaces don't need sensitivity checks
  if (normalizedSharing === 'private') {
    log.debug({ spacePath }, 'Private space, allowing transcript save');
    return { decision: 'allow' };
  }

  // Verified Chief-of-Staff is the user's personal space
  const settings = getSettings();
  if (isVerifiedChiefOfStaff(spacePath, settings)) {
    log.debug({ spacePath }, 'Verified Chief-of-Staff, allowing transcript save');
    return { decision: 'allow' };
  }

  // Resolve safety level for this space
  const { level } = resolveMemorySafetyLevel(spacePath, normalizedSharing, settings, false);
  log.debug({ spacePath, level, normalizedSharing }, 'Resolved safety level for transcript');

  // Permissive: user opted out of checks
  if (level === 'permissive') {
    log.debug({ spacePath }, 'Permissive safety level, allowing transcript save');
    return { decision: 'allow' };
  }

  // Check auth before attempting LLM evaluation
  if (!hasValidAuth(settings)) {
    log.warn({ spacePath }, 'No auth available for transcript sensitivity evaluation, staging');
    return { decision: 'stage', reason: 'No auth available for sensitivity evaluation' };
  }

  // Balanced: evaluate via Safety Prompt
  if (level === 'balanced') {
    // Stage if safety system not ready (conservative, non-blocking)
    if (!isMigrationComplete()) {
      log.warn({ spacePath }, 'Safety migration incomplete, staging transcript');
      const summary = await summarizeContent(transcriptContent);
      return { decision: 'stage', reason: 'Safety system initializing', summary };
    }

    try {
      const safetyPrompt = getSafetyPrompt();
      const promptVersion = getSafetyPromptVersion();
      // Use 'memory_create' so shouldAllow() matches the 'create' side-effect verb
      // and requires HIGH confidence. 'write' is not in SIDE_EFFECT_VERBS.
      const actionContext: ActionContext = {
        toolName: 'memory_create',
        toolInput: {
          spaceName: spaceName ?? spacePath,
          sharing: normalizedSharing,
          contentPreview: transcriptContent.slice(0, 2000),
        },
        toolDescription: `Auto-save meeting transcript to "${spaceName ?? spacePath}" space (${normalizedSharing ?? 'unknown'} sharing)`,
        spaceDescription: description,
        sessionType: 'automation',
      };

      const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext);
      const allowed = shouldAllow(evalResult, 'memory_create');

      if (!allowed) {
        log.info({ spacePath, decision: evalResult.decision, confidence: evalResult.confidence }, 'Safety eval blocked transcript, staging');
        const summary = await summarizeContent(transcriptContent);
        return { decision: 'stage', reason: evalResult.reason, summary };
      }

      log.debug({ spacePath, decision: evalResult.decision }, 'Safety eval allowed transcript save');
      return { decision: 'allow' };
    } catch (err) {
      log.warn({ spacePath, err }, 'Safety evaluation failed for transcript, staging');
      const summary = await summarizeContent(transcriptContent);
      return { decision: 'stage', reason: 'Safety evaluation failed', summary };
    }
  }

  // Cautious: always stage with summary
  if (level === 'cautious') {
    const summary = await summarizeContent(transcriptContent);
    log.info({ spacePath }, 'Cautious mode, staging transcript for approval');
    return {
      decision: 'stage',
      reason: 'Cautious mode requires approval for all transcript saves to shared spaces',
      summary,
    };
  }

  // Unexpected level — default to stage (conservative safety)
  log.warn({ spacePath, level }, 'Unexpected safety level, staging transcript for review');
  return { decision: 'stage', reason: `Unexpected safety level: ${level}` };
}

/**
 * Broadcast staging events to all renderer windows, matching the pattern
 * used by memoryWriteHook for staged memory writes.
 *
 * Emits:
 * - memory:file-staged: carries payload for future subscribers
 * - memory:staged-files-changed: triggers useStagedFiles UI refresh
 */
export function broadcastTranscriptStagingEvents(
  pendingFile: { id: string; filename: string },
  filePath: string,
  spaceName: string,
  summary: string
): void {
  const broadcast = getBroadcastService();
  broadcastTypedPayload(broadcast, 'memory:file-staged', {
    id: pendingFile.id,
    realPath: filePath,
    spaceName,
    summary,
    stagedAt: Date.now(),
  });
  broadcast.sendToAllWindows('memory:staged-files-changed');
  log.debug({ pendingFileId: pendingFile.id, spaceName }, 'Broadcast transcript staging events');
}
