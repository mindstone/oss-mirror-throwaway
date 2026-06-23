import { createHash } from 'node:crypto';
import { resolveSourceDisplayName } from '@shared/utils/mcpAppDisplayNames';
import type {
  IframeMessageMethod,
  RateLimitTier,
  TrustBoundaryLogEvent,
  TrustBoundaryLogKind,
  TrustBoundaryRejectionReason,
} from '@shared/types/agent';

export interface TrustLogInput {
  sourcePackageId: string;
  sessionId: string;
  conversationId: string;
  method: IframeMessageMethod | string;
  nonce?: string;
  reason: TrustBoundaryRejectionReason;
  kind: TrustBoundaryLogKind;
  attemptedContentBytes: number;
  subkind?: string;
  toolUseId?: string;
  resourceUri?: string;
  rateLimitTier?: RateLimitTier;
  attemptCount?: number;
  timeSinceFirstAttemptMs?: number;
  attemptedContentHash?: string;
  attemptedContentOversize?: boolean;
}

export function deriveSourcePackageFamily(sourcePackageId: string | undefined | null): string {
  return resolveSourceDisplayName(sourcePackageId).displayName;
}

export function hashSourcePackageId(sourcePackageId: string): string {
  return createHash('sha256').update(sourcePackageId).digest('hex').slice(0, 16);
}

export function hashAttemptedContent(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildTrustBoundaryLogEvent(input: TrustLogInput): TrustBoundaryLogEvent {
  return {
    boundary: 'mcp-apps-bidirectional-trust',
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    sourcePackageFamily: deriveSourcePackageFamily(input.sourcePackageId),
    sourcePackageHash: hashSourcePackageId(input.sourcePackageId),
    kind: input.kind,
    method: input.method,
    nonce: input.nonce || 'none',
    reason: input.reason,
    attemptedContentBytes: input.attemptedContentBytes,
    ...(input.subkind ? { subkind: input.subkind } : {}),
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    ...(input.resourceUri ? { resourceUri: input.resourceUri } : {}),
    ...(input.rateLimitTier ? { rateLimitTier: input.rateLimitTier } : {}),
    ...(typeof input.attemptCount === 'number' ? { attemptCount: input.attemptCount } : {}),
    ...(typeof input.timeSinceFirstAttemptMs === 'number'
      ? { timeSinceFirstAttemptMs: input.timeSinceFirstAttemptMs }
      : {}),
    ...(input.attemptedContentHash ? { attemptedContentHash: input.attemptedContentHash } : {}),
    ...(input.attemptedContentOversize ? { attemptedContentOversize: true } : {}),
  };
}
