import type { TrustedTool } from '../types';
import type { BareToolId } from '../types/bareToolId';
// Re-export from canonical location so existing consumers don't break.
export type { BareToolId } from '../types/bareToolId';

/**
 * Extract the bare tool ID from a potentially compound identifier.
 *
 * Legacy UI code stored trusted-tool entries as "packageId/toolId" (slash-delimited).
 * The backend runtime resolves effective tool IDs to just the bare tool name.
 * This helper strips any leading "packageId/" prefix so comparisons succeed
 * regardless of which format was persisted.
 *
 * Trade-off: This makes trust global by tool name rather than scoped per package.
 * In practice, MCP tools use globally unique underscore-delimited names (e.g.,
 * "gmail_send_email", not "send_email"), so cross-package collisions are unlikely.
 * If package-scoped trust is ever needed, TrustedTool should gain a packageId field.
 */
export function bareToolId(id: string): BareToolId {
  const slashIdx = id.lastIndexOf('/');
  return (slashIdx >= 0 ? id.slice(slashIdx + 1) : id) as BareToolId;
}

/**
 * Normalize a trustedTools array: strip compound prefixes and deduplicate.
 * Returns a new array (never mutates the input).
 */
export function normalizeTrustedTools(tools: TrustedTool[]): TrustedTool[] {
  const seen = new Set<string>();
  const result: TrustedTool[] = [];

  for (const tool of tools) {
    const canonical = bareToolId(tool.toolId);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical !== tool.toolId ? { ...tool, toolId: canonical } : tool);
  }

  return result;
}
