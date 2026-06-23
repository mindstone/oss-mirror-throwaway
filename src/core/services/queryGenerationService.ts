/**
 * Query Generation Service
 *
 * Makes a single BTS LLM call to generate 4 optimized search queries,
 * each tailored to a specific retrieval index (files, tools, conversations, skills).
 * Replaces the single-embedding approach with purpose-built queries for better
 * retrieval quality across different index types.
 *
 * Returns null on ANY failure (timeout, parse error, API error) — callers
 * fall back to the raw user prompt for all embeddings.
 *
 * @see docs/plans/260328_smart_query_generation_preturn_pipeline.md
 */

import { callWithModelAuthAware, CodexDisconnectedBtsError } from '@core/services/behindTheScenesClient';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { createScopedLogger } from '@core/logger';
import type { AppSettings } from '@shared/types';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'queryGeneration' });

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Optimized search queries for each retrieval index */
export interface SearchQueries {
  file_query: string;
  tool_query: string;
  conversation_query: string;
  skill_query: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TOKENS = 1024;

/** JSON schema for structured output */
export const SEARCH_QUERIES_SCHEMA = {
  type: 'object',
  properties: {
    file_query: { type: 'string', description: 'Query optimized for file/document content similarity search' },
    tool_query: { type: 'string', description: 'Query describing the capability needed from tools/integrations' },
    conversation_query: { type: 'string', description: 'Query for finding past conversations about similar topics' },
    skill_query: { type: 'string', description: 'Query for finding procedural skills/workflows for this task type' },
  },
  required: ['file_query', 'tool_query', 'conversation_query', 'skill_query'],
  additionalProperties: false,
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Parse and validate the LLM response into SearchQueries.
 * Handles malformed JSON, missing fields, and non-string values robustly.
 * Returns null if the response cannot be parsed into valid queries.
 *
 * @internal Exported for testing
 */
export function parseSearchQueries(text: string): SearchQueries | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn({ textSnippet: text.slice(0, 100) }, 'Failed to parse query generation response as JSON');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    log.warn('Query generation response is not an object');
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const fields = ['file_query', 'tool_query', 'conversation_query', 'skill_query'] as const;

  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = obj[field];
    if (value === undefined || value === null) {
      // Missing field → treat as empty (skip this index)
      result[field] = '';
    } else if (typeof value === 'string') {
      result[field] = value;
    } else {
      // Non-string value (number, boolean, object) → invalid
      log.warn({ field, valueType: typeof value }, 'Query generation response has non-string field');
      return null;
    }
  }

  return result as unknown as SearchQueries;
}

// -----------------------------------------------------------------------------
// Main function
// -----------------------------------------------------------------------------

/**
 * Generate optimized search queries for each retrieval index.
 *
 * Makes a single BTS LLM call to produce 4 purpose-built queries from the
 * user's prompt. Returns null on any failure — callers should fall back to
 * using the raw prompt for all embeddings.
 *
 * @param prompt - The user's message text
 * @param settings - App settings (for model resolution and auth)
 * @param options - Optional timeout and abort signal
 * @returns SearchQueries on success, null on failure
 */
export async function generateSearchQueries(
  prompt: string,
  settings: AppSettings,
  options?: { timeout?: number; signal?: AbortSignal; urlDomainHints?: string }
): Promise<SearchQueries | null> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const model = resolveBtsModel(settings, 'queryGeneration');

  // Enrich the system prompt with URL domain hints when URLs are present in the user message.
  // This helps the LLM generate better tool_query values (e.g., "read Google Docs document"
  // instead of generic queries). See docs/plans/260403_document_prefetch_pipeline.md Stage 2.
  let systemPrompt = getPrompt(PROMPT_IDS.INTELLIGENCE_QUERY_GENERATION);
  if (options?.urlDomainHints) {
    systemPrompt += `\n\nThe user's message references URLs from these services: ${options.urlDomainHints}. Consider tools for reading/fetching content from these services when generating tool search queries.`;
  }

  try {
    const response = await callWithModelAuthAware(
      settings,
      model,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: prompt }],
        system: systemPrompt,
        maxTokens: MAX_TOKENS,
        timeout,
        signal: options?.signal,
        outputFormat: { type: 'json_schema', schema: SEARCH_QUERIES_SCHEMA },
      },
      { category: 'queryGeneration' }
    );

    const content = response.content?.[0];
    if (content?.type !== 'text' || !content.text) {
      log.warn({ model }, 'Query generation returned no text content');
      return null;
    }

    const queries = parseSearchQueries(content.text);
    if (!queries) {
      return null;
    }

    log.debug(
      {
        fileQueryLen: queries.file_query.length,
        toolQueryLen: queries.tool_query.length,
        conversationQueryLen: queries.conversation_query.length,
        skillQueryLen: queries.skill_query.length,
      },
      'Generated search queries'
    );

    return queries;
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      log.error(
        { reason: 'codex-profile-bts-blocked', caller: 'queryGeneration' },
        'Query generation BTS blocked'
      );
    } else {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), model },
        'Query generation failed, caller should fall back to raw prompt'
      );
    }
    return null;
  }
}
