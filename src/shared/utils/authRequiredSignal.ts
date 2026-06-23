import type { AgentEvent } from '@shared/types';
import { safeParseDetail } from '@shared/utils/safeParseDetail';

export const AUTH_REQUIRED_ACTION = 'auth_required' as const;

export type AuthRequiredReason = 'token_expired' | 'not_connected';

export interface AuthRequiredSignal {
  packageId: string;
  authTool: string;
  reason: AuthRequiredReason;
  turnId: string;
  timestamp: number;
  rawError?: string;
}

type JsonRecord = Record<string, unknown>;

interface SuperMcpEnvelope {
  package_id?: string;
  innerText: string;
}

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseJsonRecord = (value: string): JsonRecord | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  // BOUNDED via safeParseDetail: this is fed by `event.detail` (and its
  // super-mcp innerText, ≤ detail) — malformed OR over-budget input yields null.
  const result = safeParseDetail(value);
  if (!result.ok) return null;
  const parsed = result.value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonRecord;
};

const unwrapSuperMcpEnvelope = (detail: string): SuperMcpEnvelope | null => {
  const envelope = parseJsonRecord(detail);
  if (!envelope) return null;

  const result = envelope.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;

  const content = (result as JsonRecord).content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    const record = block as JsonRecord;
    if (record.type !== 'text') continue;
    const text = asNonEmptyString(record.text);
    if (!text) continue;
    return {
      package_id: asNonEmptyString(envelope.package_id) ?? undefined,
      innerText: text,
    };
  }

  return null;
};

const isAuthRequiredReason = (value: unknown): value is AuthRequiredReason =>
  value === 'token_expired' || value === 'not_connected';

export function parseAuthRequiredSignal(
  event: AgentEvent,
  turnId: string,
): AuthRequiredSignal | null {
  if (event.type !== 'tool' || event.stage !== 'end') return null;

  const unwrapped = unwrapSuperMcpEnvelope(event.detail);
  const innerPayload = parseJsonRecord(unwrapped?.innerText ?? event.detail);
  if (!innerPayload) return null;
  if (innerPayload.action !== AUTH_REQUIRED_ACTION) return null;

  const packageId =
    asNonEmptyString(innerPayload.package_id)
    ?? asNonEmptyString(unwrapped?.package_id);
  const authTool = asNonEmptyString(innerPayload.auth_tool);
  const reason = innerPayload.reason;

  if (!packageId || !authTool || !isAuthRequiredReason(reason)) {
    return null;
  }

  const rawError = asNonEmptyString(innerPayload.error) ?? undefined;
  return {
    packageId,
    authTool,
    reason,
    turnId,
    timestamp: event.timestamp,
    ...(rawError ? { rawError } : {}),
  };
}

export function extractLatestAuthRequiredByPackage(
  eventsByTurn: Record<string, AgentEvent[]>,
): Map<string, AuthRequiredSignal> {
  const latestByPackage = new Map<string, AuthRequiredSignal>();

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    for (const event of events) {
      const signal = parseAuthRequiredSignal(event, turnId);
      if (!signal) continue;

      const existing = latestByPackage.get(signal.packageId);
      if (!existing || signal.timestamp >= existing.timestamp) {
        latestByPackage.set(signal.packageId, signal);
      }
    }
  }

  return latestByPackage;
}

export function buildAuthRequiredKey(
  packageId: string,
  reason: AuthRequiredReason,
): string {
  return `${packageId}:${reason}`;
}
