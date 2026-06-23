import { createHash } from 'node:crypto';
import type { McpServers } from '@core/agentRuntimeTypes';

// Anthropic API enforces a hard 200 character limit for tool names.
// Rebel Core namespaces MCP tools using the server ID (e.g. "mcp__serverId__toolName"),
// so very long server IDs (e.g. email-based instance IDs) can cause 400 errors like:
//   tool_use.name: String should have at most 200 characters
//
// Budget: 200 − 5 ("mcp__") − 2 ("__") − 64 = 129 chars for tool names.
const MAX_SERVER_ID_FOR_TOOL_NAMESPACE = 64;
const HASH_HEX_CHARS = 10;

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const shortenWithHash = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;

  const hash = sha256Hex(value).slice(0, HASH_HEX_CHARS);
  const suffix = `-${hash}`;
  const prefixLength = Math.max(1, maxLength - suffix.length);
  return `${value.slice(0, prefixLength)}${suffix}`;
};

/**
 * In direct MCP mode, alias long server IDs to a shorter, stable ID to avoid
 * Anthropic tool name length limits.
 */
export const aliasMcpServersForClaudeSdk = (
  servers: McpServers
): { servers: McpServers; aliasMap: Record<string, string> } => {
  const entries = Object.entries(servers ?? {});
  if (entries.length === 0) {
    return { servers, aliasMap: {} };
  }

  const aliasMap: Record<string, string> = {};
  const seen = new Set<string>();
  const result: NonNullable<McpServers> = {};

  for (const [originalId, config] of entries) {
    let candidate = shortenWithHash(originalId, MAX_SERVER_ID_FOR_TOOL_NAMESPACE);

    // Ensure unique keys (avoid collisions with existing or previously aliased keys).
    if (seen.has(candidate)) {
      // Extremely unlikely, but guard deterministically by hashing a disambiguated key.
      let nonce = 1;
      while (seen.has(candidate)) {
        candidate = shortenWithHash(`${originalId}#${nonce}`, MAX_SERVER_ID_FOR_TOOL_NAMESPACE);
        nonce += 1;
      }
    }

    seen.add(candidate);
    result[candidate] = config;
    if (candidate !== originalId) {
      aliasMap[originalId] = candidate;
    }
  }

  // Avoid churning object identity if nothing changed.
  if (Object.keys(aliasMap).length === 0) {
    return { servers, aliasMap };
  }

  return { servers: result, aliasMap };
};
