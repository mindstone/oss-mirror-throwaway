/**
 * Tool Alias Cache
 *
 * Lightweight, synchronous alias resolution for MCP tool names.
 * Populated by toolIndexService.refreshToolIndex() on startup and MCP config changes.
 * Consumed by toolSafetyService.getEffectiveToolIdentifier() and stagedToolCallsService.
 *
 * Maps (packageId, aliasName) → canonicalToolName so that safety evaluation,
 * session approvals, and staged call display all use canonical names regardless
 * of whether the LLM used an alias.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'toolAliasCache' });

// packageId → (alias → canonical)
const cache = new Map<string, Map<string, string>>();

/**
 * Update the alias map for a single package.
 * Called from toolIndexService after fetching /api/tools.
 *
 * @param packageId - The MCP package identifier (e.g., "gmail")
 * @param aliasMap - Mapping of alias name → canonical tool name
 */
export function updateAliases(packageId: string, aliasMap: Record<string, string>): void {
  const entries = Object.entries(aliasMap);
  if (entries.length === 0) {
    cache.delete(packageId);
    return;
  }
  const inner = new Map<string, string>(entries);
  cache.set(packageId, inner);
  log.debug({ packageId, aliasCount: inner.size }, 'Updated alias cache for package');
}

/**
 * Resolve an alias to its canonical tool name.
 * Returns the canonical name if an alias mapping exists, otherwise returns toolId unchanged.
 * Synchronous — safe for use in getEffectiveToolIdentifier().
 *
 * @param packageId - The MCP package identifier
 * @param toolId - The tool name (may be an alias or already canonical)
 * @returns The canonical tool name
 */
export function resolveAlias(packageId: string, toolId: string): string {
  const inner = cache.get(packageId);
  if (!inner) return toolId;
  return inner.get(toolId) ?? toolId;
}

/**
 * Clear all cached aliases.
 * Used for testing and full resets.
 */
export function clearAliases(): void {
  cache.clear();
  log.debug('Alias cache cleared');
}
