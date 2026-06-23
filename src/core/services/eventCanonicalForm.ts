import { createHash } from 'node:crypto';
import type { AgentEvent } from '@shared/types/agent';

/**
 * Deterministic canonical form for cross-runtime checksum agreement.
 *
 * Only top-level volatile event envelope fields are excluded. Nested content
 * fields intentionally remain part of the checksum identity.
 */
const TOP_LEVEL_EXCLUDED_KEYS = new Set([
  'seq', // server-assigned; can differ across reconciliation attempts
  'serverSeq', // legacy/transport-assigned sequence field
  'cloudUpdatedAt', // server-stamped metadata clock
]);

export function canonicalizeEvent(event: AgentEvent): string {
  return JSON.stringify(canonicalize(event, 0));
}

function canonicalize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const sortedKeys = Object.keys(record).sort();

  for (const key of sortedKeys) {
    if (depth === 0 && TOP_LEVEL_EXCLUDED_KEYS.has(key)) continue;
    result[key] = canonicalize(record[key], depth + 1);
  }

  return result;
}

export function computeTurnChecksum(events: AgentEvent[]): string {
  const canonicalized = events.map(canonicalizeEvent).join('\n');
  return createHash('sha256').update(canonicalized).digest('hex');
}
