/**
 * Tool Output Curator — LLM-based intelligent curation of large tool outputs.
 *
 * Instead of blindly truncating tool outputs that exceed a threshold, this module
 * uses a cheap LLM call to extract only the relevant portions based on the
 * agent's mission and current task context.
 *
 * Kill switch: ENABLE_TOOL_OUTPUT_CURATION defaults to false (opt-in).
 * Threshold: only outputs > CURATION_THRESHOLD_CHARS are considered.
 * Fail-open: if curation fails for any reason, raw output is returned.
 *
 * Complements SuperMCP auto-materialization (100K+ chars) — curation targets
 * the 8K-100K range that isn't materialized but still bloats context.
 */
import { createScopedLogger } from '@core/logger';
import type { ModelClient } from './modelClient';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';

const log = createScopedLogger({ service: 'toolOutputCurator' });

export const ENABLE_TOOL_OUTPUT_CURATION = false;
export const CURATION_THRESHOLD_CHARS = 8_000;
const CURATION_TIMEOUT_MS = 10_000;
const CURATION_MAX_OUTPUT_TOKENS = 2_048;

export interface CurationContext {
  client: ModelClient;
  model: RoutingModelId;
  missionGoal?: string;
  currentTask?: string;
}

export interface CurationResult {
  output: string;
  wasCurated: boolean;
  originalSize: number;
  curatedSize?: number;
}

/**
 * Get the curation system prompt (lazy access via prompt file service).
 */
function getCurationSystemPrompt(): string {
  return getPrompt(PROMPT_IDS.AGENT_TOOL_OUTPUT_CURATOR);
}

export async function curateToolOutput(
  toolName: string,
  rawOutput: string,
  context: CurationContext,
  signal?: AbortSignal,
): Promise<CurationResult> {
  if (!ENABLE_TOOL_OUTPUT_CURATION) {
    return { output: rawOutput, wasCurated: false, originalSize: rawOutput.length };
  }

  if (rawOutput.length <= CURATION_THRESHOLD_CHARS) {
    return { output: rawOutput, wasCurated: false, originalSize: rawOutput.length };
  }

  try {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), CURATION_TIMEOUT_MS);

    // Combine parent signal with timeout
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const userMessage = [
      context.missionGoal ? `Mission: ${context.missionGoal}` : '',
      context.currentTask ? `Current task: ${context.currentTask}` : '',
      `Tool: ${toolName}`,
      `Output (${rawOutput.length} chars):`,
      rawOutput,
    ].filter(Boolean).join('\n\n');

    const result = await context.client.stream(
      {
        model: context.model,
        maxTokens: CURATION_MAX_OUTPUT_TOKENS,
        systemPrompt: getCurationSystemPrompt(),
        messages: [{ role: 'user', content: userMessage }],
        signal: combinedSignal,
      },
      () => {},
    );

    clearTimeout(timeout);

    const curatedText = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    if (!curatedText || curatedText.length >= rawOutput.length) {
      return { output: rawOutput, wasCurated: false, originalSize: rawOutput.length };
    }

    log.info(
      { toolName, originalSize: rawOutput.length, curatedSize: curatedText.length },
      'Tool output curated',
    );

    return {
      output: curatedText,
      wasCurated: true,
      originalSize: rawOutput.length,
      curatedSize: curatedText.length,
    };
  } catch (error) {
    log.warn({ err: error, toolName }, 'Tool output curation failed — using raw output');
    return { output: rawOutput, wasCurated: false, originalSize: rawOutput.length };
  }
}
