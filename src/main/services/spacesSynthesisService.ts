/**
 * Spaces Synthesis Service
 *
 * Generates AI-powered summaries of space activity using Sonnet.
 * Provides a personalized, Rebel-voiced synthesis of what's been happening.
 */

import type { AppSettings } from '@shared/types';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { createScopedLogger } from '@core/logger';
import { getSpaceActivity } from './spaceActivityService';
import {
  getCachedSynthesis,
  setCachedSynthesis,
  clearSynthesisCache,
  type SpacesSynthesis,
} from './spacesSynthesisStore';
import { callWithModelAuthAware } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { humanizeAgentError } from '@rebel/shared';
import { ModelError } from '@core/rebelCore/modelErrors';

const log = createScopedLogger({ service: 'spacesSynthesis' });

const MAX_OUTPUT_TOKENS = 2048;
const MAX_INPUT_CHARS = 50000;
const TIMEOUT_MS = 60000;

/**
 * Thrown when synthesis is invoked under a non-Anthropic provider.
 *
 * Spaces synthesis currently relies on Anthropic-tuned prompts and Sonnet's
 * output structure ([HOOK]/[DETAIL] sections). Until OpenRouter and Codex
 * variants are validated, we fail closed rather than silently routing to a
 * different model family. See plan doc
 * `docs/plans/260514_openrouter_sonnet_bypass_remediation.md` Stage 2B.
 */
export class UnsupportedSynthesisProviderError extends Error {
  constructor(provider: string) {
    super(
      `Spaces synthesis is not supported under provider '${provider}'. ` +
        `Switch to Anthropic to regenerate the synthesis.`,
    );
    this.name = 'UnsupportedSynthesisProviderError';
  }
}

/**
 * Build the system prompt for synthesis generation.
 */
function buildSystemPrompt(focus: string): string {
  return getPrompt(PROMPT_IDS.UTILITY_SPACES_SYNTHESIS, { focus });
}

/**
 * Gather activity content from memory and skill files.
 */
async function gatherActivityContent(
  workspacePath: string,
  days: number
): Promise<string> {
  const activity = await getSpaceActivity(workspacePath, days);

  if (activity.spaces.length === 0) {
    return '';
  }

  const contentParts: string[] = [];
  let totalChars = 0;

  for (const space of activity.spaces) {
    const spacePart: string[] = [`## ${space.displayName} (${space.spaceType})`];

    // Add memory summaries
    if (space.recentMemories.length > 0) {
      spacePart.push('\n### Recent Memories:');
      for (const memory of space.recentMemories) {
        const line = `- ${memory.action}: "${memory.summary}"`;
        spacePart.push(line);
      }
    }

    // Add skill names
    if (space.recentSkills.length > 0) {
      spacePart.push('\n### Recent Skills:');
      for (const skill of space.recentSkills) {
        const line = `- ✦ ${skill.name}`;
        spacePart.push(line);
      }
    }

    const partContent = spacePart.join('\n');
    
    // Check if adding this would exceed limit
    if (totalChars + partContent.length > MAX_INPUT_CHARS) {
      contentParts.push('\n[... additional spaces truncated ...]');
      break;
    }

    contentParts.push(partContent);
    totalChars += partContent.length;
  }

  return contentParts.join('\n\n');
}

/**
 * Call Sonnet to generate synthesis.
 * Uses callWithModelAuthAware for centralized API handling and cost tracking.
 */
async function callModelForSynthesis(
  settings: AppSettings,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  if (!hasValidAuth(settings)) {
    throw new Error('No valid auth available for synthesis generation');
  }

  const activeProvider = settings.activeProvider ?? 'anthropic';
  if (activeProvider !== 'anthropic') {
    log.warn(
      { activeProvider },
      'Spaces synthesis blocked under non-Anthropic provider',
    );
    throw new UnsupportedSynthesisProviderError(activeProvider);
  }

  const model = getDefaultModelForProvider(settings, 'working');

  log.info({ model, promptLength: userPrompt.length }, 'Calling Sonnet for synthesis');

  const response = await callWithModelAuthAware(
    settings,
    model,
    {
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
      maxTokens: MAX_OUTPUT_TOKENS,
      timeout: TIMEOUT_MS,
    },
    { category: 'spacesSynthesis' }
  );

  const content = response.content?.[0];
  if (content?.type !== 'text' || !content.text) {
    throw new Error('Unexpected response format from API');
  }

  return content.text;
}

/**
 * Parse the model response into hook and detail sections.
 */
function parseResponse(response: string): { hook: string; detail: string } {
  const hookMatch = response.match(/\[HOOK\]\s*([\s\S]*?)(?=\[DETAIL\]|$)/);
  const detailMatch = response.match(/\[DETAIL\]\s*([\s\S]*?)$/);

  const hook = hookMatch?.[1]?.trim() ?? response.slice(0, 500);
  const detail = detailMatch?.[1]?.trim() ?? '';

  return { hook, detail };
}

/**
 * Generate synthesis for space activity.
 * Returns cached version if valid, otherwise generates fresh.
 */
export async function getOrGenerateSynthesis(
  settings: AppSettings,
  focus: string,
  forceRegenerate = false
): Promise<SpacesSynthesis> {
  // Check cache first (unless forcing regenerate)
  if (!forceRegenerate) {
    const cached = getCachedSynthesis(focus);
    if (cached) {
      log.debug('Returning cached synthesis');
      return cached;
    }
  }

  // Generate fresh synthesis
  log.info({ focus, forceRegenerate }, 'Generating fresh synthesis');

  if (!settings.coreDirectory) {
    throw new Error('Workspace directory not configured');
  }

  // Gather activity content
  const activityContent = await gatherActivityContent(settings.coreDirectory, 7);

  if (!activityContent) {
    // No activity - return empty synthesis with witty message
    const synthesis: SpacesSynthesis = {
      hook: "Your spaces have been quiet this week. Either very zen or slightly concerning.",
      detail: "",
      generatedAt: Date.now(),
      focus,
    };
    setCachedSynthesis(synthesis);
    return synthesis;
  }

  // Build prompts
  const systemPrompt = buildSystemPrompt(focus);
  const userPrompt = `Here's the activity from the last 7 days:\n\n${activityContent}\n\nGenerate the synthesis now.`;

  // Call model
  let response: string;
  try {
    response = await callModelForSynthesis(settings, systemPrompt, userPrompt);
  } catch (error) {
    const fallback = error instanceof Error ? error.message : String(error);
    // Stage 7 migration: classification-first humanization for observability parity.
    // See docs/plans/260421_classification_driven_error_humanizer.md.
    const humanized = humanizeAgentError(
      error instanceof ModelError
        ? {
            kind: 'classified',
            errorKind: error.__agentErrorKind,
            rawMessage: error.__rawMessage,
            provider: error.provider,
            upstreamProviderName: error.upstreamProvider,
          }
        : { kind: 'unclassified', rawMessage: fallback },
    );
    log.error({ focus, error: humanized }, 'Failed to generate synthesis');
    throw error;
  }

  // Parse response
  const { hook, detail } = parseResponse(response);

  const synthesis: SpacesSynthesis = {
    hook,
    detail,
    generatedAt: Date.now(),
    focus,
  };

  // Cache result
  setCachedSynthesis(synthesis);

  log.info({ hookLength: hook.length, detailLength: detail.length }, 'Generated synthesis');

  return synthesis;
}

/**
 * Clear the synthesis cache (for manual refresh).
 */
export { clearSynthesisCache };
