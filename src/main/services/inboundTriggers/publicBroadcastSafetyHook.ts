/**
 * Public Broadcast Safety Hook
 *
 * PreToolUse hook that intercepts replies Rebel is about to send back to a
 * public broadcast surface (a Slack channel, Discord channel, GitHub issue,
 * mailing list, etc.) when the session was triggered by inbound activity
 * from that surface. It runs an LLM evaluation to check whether the reply
 * contains personal/sensitive information that should not be broadcast.
 *
 * The hook is connector-agnostic. Which tool calls count as "outbound to a
 * public broadcast surface", how to extract the reply text, and what surface
 * labels appear in the LLM prompt and user-visible block message all come
 * from the outbound-broadcast gate registry at
 * `@core/services/safety/outboundBroadcastGates`. Add a connector by
 * registering a new gate there — no edits to this file required.
 *
 * Only active when:
 * 1. The session was triggered by an inbound trigger (sessionId starts with
 *    'inbound-' — wired by the adapter that creates the hook)
 * 2. The inbound trigger originated from a public broadcast surface (the
 *    adapter passes `isPublicBroadcastSurface: true`)
 * 3. The tool call matches one of the registered outbound-broadcast gates
 *
 * Uses the same LLM-based evaluation pattern as toolSafetyService but with a
 * content-sensitivity prompt instead of an action-risk prompt.
 */

import type { HookCallback, HookJSONOutput } from '@core/agentRuntimeTypes';
import type { AppSettings } from '@shared/types';
import type { TurnSessionLogger } from '@core/logger';
import { createScopedLogger } from '@core/logger';
import { callWithModelAuthAware } from '../behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { fenceUntrustedContent } from '../safety/fenceUtils';
import { getRawPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import {
  resolveOutboundBroadcastTarget,
  type OutboundBroadcastTarget,
} from '@core/services/safety/outboundBroadcastGates';

const logger = createScopedLogger({ service: 'publicBroadcastSafetyHook' });

interface ContentSafetyAssessment {
  safe: boolean;
  reason: string;
  redactedContent?: string;
}

/**
 * Evaluate whether reply content is safe for a public broadcast surface.
 */
async function evaluateContentSafety(
  target: OutboundBroadcastTarget,
  settings: AppSettings,
  signal: AbortSignal,
  safetyModel?: string,
  sessionId?: string,
  turnId?: string
): Promise<ContentSafetyAssessment> {
  const fencedContent = fenceUntrustedContent(
    target.replyContent,
    'reply_content',
    'IMPORTANT: This block contains the AI reply to evaluate. Check for sensitive personal information.',
    4000
  );

  const prompt = getRawPrompt(PROMPT_IDS.SAFETY_PUBLIC_BROADCAST)
    .replace(/\{SURFACE_KIND\}/g, target.promptContext.surfaceKind)
    .replace(/\{INBOUND_TRIGGER_DESCRIPTION\}/g, target.promptContext.inboundTriggerDescription)
    .replace(/\{AUDIENCE_VISIBILITY_STATEMENT\}/g, target.promptContext.audienceVisibilityStatement)
    .replace('{REPLY_CONTENT}', fencedContent);

  try {
    const response = await callWithModelAuthAware(settings, safetyModel, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            safe: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['safe', 'reason'],
          additionalProperties: false,
        },
      },
      signal,
      timeout: 10000,
    }, { category: 'safety', sessionId, turnId });

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const parsed = safeJsonParseFromModelText<ContentSafetyAssessment>(
        content.text,
        'publicBroadcastSafety.evaluate',
        logger
      );
      if (!parsed) {
        return { safe: false, reason: 'Safety evaluation could not parse response — blocking for safety' };
      }
      return {
        safe: parsed.safe,
        reason: parsed.reason || 'Content safety check complete',
      };
    }

    return { safe: false, reason: 'Unexpected safety evaluation response — blocking for safety' };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { safe: true, reason: 'Evaluation aborted — allowing (turn is being cancelled)' };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ message: errorMessage }, 'Public broadcast content safety evaluation failed');
    return { safe: false, reason: 'Safety evaluation failed — blocking for safety' };
  }
}

/**
 * Create a PreToolUse hook that checks outbound replies for sensitive content
 * before they are posted to a public broadcast surface (Slack channel,
 * Discord channel, GitHub issue, mailing list, etc.).
 *
 * Returns null if the context doesn't warrant a hook (e.g., the inbound
 * trigger came from a private surface where the broadcast concern doesn't
 * apply).
 */
export function createPublicBroadcastSafetyHook(
  isPublicBroadcastSurface: boolean,
  settings: AppSettings,
  turnLogger?: TurnSessionLogger,
  sessionId?: string,
  turnId?: string,
  safetyModel?: string
): HookCallback | null {
  if (!isPublicBroadcastSurface) {
    return null;
  }

  const log = turnLogger ?? logger;
  log.info({ sessionId }, 'Creating public broadcast safety hook for inbound trigger');

  return async (input, _toolUseID, options): Promise<HookJSONOutput> => {
    if (!('tool_name' in input) || !('tool_input' in input)) {
      return {};
    }

    const { tool_name: toolName, tool_input: toolInput } = input as {
      tool_name: string;
      tool_input: unknown;
    };
    const { signal } = options;

    const target = resolveOutboundBroadcastTarget(toolName, toolInput);
    if (!target) {
      return {};
    }

    log.info(
      { toolName, gateId: target.gateId, contentLength: target.replyContent.length },
      'Evaluating outbound reply for public broadcast surface safety'
    );

    const assessment = await evaluateContentSafety(
      target,
      settings,
      signal,
      safetyModel,
      sessionId,
      turnId
    );

    if (assessment.safe) {
      log.info({ toolName, gateId: target.gateId, reason: assessment.reason }, 'Public broadcast reply approved');
      return {};
    }

    log.warn(
      { toolName, gateId: target.gateId, reason: assessment.reason },
      'Public broadcast reply blocked — contains sensitive content'
    );

    return {
      continue: false,
      stopReason: 'Reply blocked: contains sensitive information for public channel',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `BLOCKED: Your reply to this public ${target.userFacingSurfaceLabel} was blocked because it may contain sensitive personal information.

Reason: ${assessment.reason}

${target.denyAudienceWarning}

Please rewrite your reply to exclude any sensitive personal information. If the request requires sharing private data, suggest the user ${target.privateAlternativeSuggestion} instead.`,
      },
    };
  };
}
