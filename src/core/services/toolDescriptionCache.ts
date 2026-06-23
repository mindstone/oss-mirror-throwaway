/**
 * Tool Description Cache
 *
 * Lightweight, synchronous lookup for MCP tool descriptions.
 * Populated by toolIndexService.refreshToolIndex() on startup and MCP config changes.
 * Consumed by toolSafetyService to pass tool descriptions to the LLM safety evaluator.
 *
 * Maps canonicalToolId → description string.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'toolDescriptionCache' });

let cache = new Map<string, string>();

/**
 * Look up a tool's description by its canonical tool ID.
 * Returns undefined if no description is cached.
 */
export function getToolDescription(toolId: string): string | undefined {
  return cache.get(toolId.toLowerCase());
}

/**
 * Atomically replace the entire description cache.
 * Avoids a transient empty-cache window during rehydration.
 */
export function replaceDescriptions(tools: Array<{ toolId: string; description: string }>): void {
  const nextCache = new Map<string, string>();
  for (const { toolId, description } of tools) {
    if (toolId && description) {
      nextCache.set(toolId.toLowerCase(), description);
    }
  }
  cache = nextCache;
  log.debug({ count: tools.length }, 'Replaced tool description cache');
}
