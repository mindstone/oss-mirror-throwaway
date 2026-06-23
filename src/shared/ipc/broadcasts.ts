import { z } from 'zod';
// Deep imports (NOT the `@rebel/shared` barrel) — load-bearing. This module is
// pulled into the low-level `@core/broadcastService` graph by the contract
// sink-seam, which is imported by very widely-used code. The `@rebel/shared`
// barrel re-exports `humanizeAgentError`/`classifyErrorUx`; importing it here
// dragged those into that broad graph and perturbed vitest module-mocking in
// unrelated suites (agentEventDispatcher) — a real regression. Importing the
// schemas from their leaf modules keeps this module side-effect-light.
import {
  MemoryFileStagedBroadcastSchema,
  MemoryWriteApprovalRequestBroadcastSchema,
  MemoryWriteApprovalResolvedBroadcastSchema,
  ToolSafetyApprovalRequestBroadcastSchema,
  ToolSafetyApprovalResolvedBroadcastSchema,
  ToolSafetyStagedCallBroadcastSchema,
  ToolSafetyStagedCallUpdatedBroadcastSchema,
  type MemoryFileStagedBroadcast,
  type MemoryWriteApprovalRequestBroadcast,
  type MemoryWriteApprovalResolvedBroadcast,
  type ToolSafetyApprovalRequestBroadcast,
  type ToolSafetyApprovalResolvedBroadcast,
  type ToolSafetyStagedCallBroadcast,
  type ToolSafetyStagedCallUpdatedBroadcast,
} from '@rebel/shared/safety/approvalBroadcasts';
import { ExternalContext as ExternalContextSchema } from '@rebel/shared/types/externalContext';
import type { BlockSource, ToolBlockSource } from '@rebel/shared/safety/blockSource';
import {
  AgentRoutePlanResolvedEventSchema,
  type AgentRoutePlanResolvedEvent,
} from '../agentEvents';
import { SessionOriginSchema } from './schemas/common';

export const AGENT_ROUTE_PLAN_RESOLVED_CHANNEL = 'agent:route-plan-resolved' as const;
export const CONVERSATIONS_START_REQUESTED_CHANNEL = 'conversations:start-requested' as const;
export const DRIVE_AWARE_SYNC_DEFERRED_CHANNEL = 'cloud:drive-aware-sync-deferred' as const;
export const MEMORY_FILE_STAGED_CHANNEL = 'memory:file-staged' as const;
export const MEMORY_WRITE_APPROVAL_REQUEST_CHANNEL = 'memory:write-approval-request' as const;
export const MEMORY_WRITE_APPROVAL_RESOLVED_CHANNEL = 'memory:write-approval-resolved' as const;
// `memory:staged-files-changed` is payloadless; leave it out of the one-payload typed map.
export const TOOL_SAFETY_APPROVAL_REQUEST_CHANNEL = 'tool-safety:approval-request' as const;
export const TOOL_SAFETY_APPROVAL_RESOLVED_CHANNEL = 'tool-safety:approval-resolved' as const;
export const TOOL_SAFETY_STAGED_CALL_CHANNEL = 'tool-safety:staged-call' as const;
export const TOOL_SAFETY_STAGED_CALL_UPDATED_CHANNEL = 'tool-safety:staged-call-updated' as const;

/**
 * Replay metadata for Slack-inbound broadcasts that survived a deferred queue
 * before reaching the renderer. Lets the agent surface (and tests) reason about
 * staleness instead of treating every replayed broadcast as fresh.
 */
export const ConversationsStartReplayMetadataSchema = z.object({
  /** Original Slack `event_id` for end-to-end correlation. */
  eventId: z.string().min(1).optional(),
  /** Wall-clock at which the original event was received by the cloud. */
  receivedAt: z.number().optional(),
  /** Wall-clock at which this replay was attempted. */
  replayedAt: z.number().optional(),
  /** Age (ms) at the time of replay; rendered for staleness checks. */
  ageMs: z.number().optional(),
  /** State at replay time (pending / broadcast-deferred). */
  state: z.string().optional(),
});
export type ConversationsStartReplayMetadata = z.infer<typeof ConversationsStartReplayMetadataSchema>;

export const ConversationsStartRequestedEventSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string(),
  sendMessage: z.boolean(),
  switchToConversation: z.boolean(),
  origin: SessionOriginSchema.optional(),
  // Operator personalisation seed prefix. Capped defensively at 20KB so a
  // malformed payload can't bloat the broadcast or system prompt.
  systemPromptPrefix: z.string().min(1).max(20_000).optional(),
  externalContext: ExternalContextSchema.optional(),
  replayMetadata: ConversationsStartReplayMetadataSchema.optional(),
});
export type ConversationsStartRequestedEvent = z.infer<typeof ConversationsStartRequestedEventSchema>;

export const DriveAwareSyncDeferredEventSchema = z.object({
  workspaceFingerprint: z.string().min(1),
  timestamp: z.number(),
  relPath: z.string().min(1).optional(),
  cycle: z.number().int().positive().optional(),
  ageMs: z.number().nonnegative().optional(),
});
export type DriveAwareSyncDeferredEvent = z.infer<typeof DriveAwareSyncDeferredEventSchema>;

export interface BroadcastPayloadByChannel {
  [AGENT_ROUTE_PLAN_RESOLVED_CHANNEL]: AgentRoutePlanResolvedEvent;
  [CONVERSATIONS_START_REQUESTED_CHANNEL]: ConversationsStartRequestedEvent;
  [DRIVE_AWARE_SYNC_DEFERRED_CHANNEL]: DriveAwareSyncDeferredEvent;
  [MEMORY_FILE_STAGED_CHANNEL]: MemoryFileStagedBroadcast;
  [MEMORY_WRITE_APPROVAL_REQUEST_CHANNEL]: MemoryWriteApprovalRequestBroadcast;
  [MEMORY_WRITE_APPROVAL_RESOLVED_CHANNEL]: MemoryWriteApprovalResolvedBroadcast;
  [TOOL_SAFETY_APPROVAL_REQUEST_CHANNEL]: ToolSafetyApprovalRequestBroadcast;
  [TOOL_SAFETY_APPROVAL_RESOLVED_CHANNEL]: ToolSafetyApprovalResolvedBroadcast;
  [TOOL_SAFETY_STAGED_CALL_CHANNEL]: ToolSafetyStagedCallBroadcast;
  [TOOL_SAFETY_STAGED_CALL_UPDATED_CHANNEL]: ToolSafetyStagedCallUpdatedBroadcast;
}

/**
 * Producer-side payload contract — STRICTER than {@link BroadcastPayloadByChannel}.
 *
 * Consumers (and cloud replay/catch-up of legacy records) must tolerate a missing
 * `blockedBy`, so the live schemas / `BroadcastPayloadByChannel` mark it optional.
 * But a LOCAL producer emitting a fresh block/stage *request* always knows the
 * block source, and the S2 invariant requires it to be carried (the historical
 * automation `blockedBy`-omission bug). `broadcastTypedPayload()` types its payload
 * against THIS map, so dropping `blockedBy` from these three request producers is a
 * compile error — while consumers stay permissive. Other channels inherit the
 * permissive shape unchanged.
 */
export interface ProducerBroadcastPayloadByChannel extends BroadcastPayloadByChannel {
  [MEMORY_WRITE_APPROVAL_REQUEST_CHANNEL]: MemoryWriteApprovalRequestBroadcast & { blockedBy: BlockSource };
  [TOOL_SAFETY_APPROVAL_REQUEST_CHANNEL]: ToolSafetyApprovalRequestBroadcast & { blockedBy: ToolBlockSource };
  [TOOL_SAFETY_STAGED_CALL_CHANNEL]: ToolSafetyStagedCallBroadcast & { blockedBy: ToolBlockSource };
}

// Each entry must be a schema whose parsed output matches the channel's payload
// type — a swapped/mismatched schema is a compile error (not just `ZodTypeAny`).
export const BROADCAST_SCHEMAS: { [K in keyof BroadcastPayloadByChannel]: z.ZodType<BroadcastPayloadByChannel[K]> } = {
  [AGENT_ROUTE_PLAN_RESOLVED_CHANNEL]: AgentRoutePlanResolvedEventSchema,
  [CONVERSATIONS_START_REQUESTED_CHANNEL]: ConversationsStartRequestedEventSchema,
  [DRIVE_AWARE_SYNC_DEFERRED_CHANNEL]: DriveAwareSyncDeferredEventSchema,
  [MEMORY_FILE_STAGED_CHANNEL]: MemoryFileStagedBroadcastSchema,
  [MEMORY_WRITE_APPROVAL_REQUEST_CHANNEL]: MemoryWriteApprovalRequestBroadcastSchema,
  [MEMORY_WRITE_APPROVAL_RESOLVED_CHANNEL]: MemoryWriteApprovalResolvedBroadcastSchema,
  [TOOL_SAFETY_APPROVAL_REQUEST_CHANNEL]: ToolSafetyApprovalRequestBroadcastSchema,
  [TOOL_SAFETY_APPROVAL_RESOLVED_CHANNEL]: ToolSafetyApprovalResolvedBroadcastSchema,
  [TOOL_SAFETY_STAGED_CALL_CHANNEL]: ToolSafetyStagedCallBroadcastSchema,
  [TOOL_SAFETY_STAGED_CALL_UPDATED_CHANNEL]: ToolSafetyStagedCallUpdatedBroadcastSchema,
};

/**
 * Minimal structural broadcast sink — matches `BroadcastService.sendToAllWindows`
 * without importing it (keeps this shared module free of a core dependency).
 */
type BroadcastSink = { sendToAllWindows(channel: string, ...args: unknown[]): void };

/**
 * Type-checked broadcast emit for registered channels. Producers route their
 * `sendToAllWindows` emits through this so the payload is checked against the
 * (stricter, provenance-required) {@link ProducerBroadcastPayloadByChannel} shape
 * — dropping a required field (e.g. `blockedBy` on a block/stage request) becomes
 * a compile error. Lives here (not on the `BroadcastService` singleton module) so
 * that a test `vi.mock('@core/broadcastService')` can't shadow it. Pure passthrough.
 */
export function broadcastTypedPayload<C extends keyof ProducerBroadcastPayloadByChannel>(
  broadcast: BroadcastSink,
  channel: C,
  payload: ProducerBroadcastPayloadByChannel[C],
): void {
  // dynamic-broadcast-reviewed: type-checked passthrough — `channel` is a typed parameter the
  // caller supplies (a literal/constant declared at that call site). This helper adds no channel,
  // and the cloud-push allowlist gate now scans the `broadcastTypedPayload(...)` CALL SITES directly
  // (channel arg index 1) — so each forwarded channel is enforced at its own emit-site, not merely
  // attested here. See scripts/check-cloud-push-allowlist-coverage.ts (Amendment A2).
  broadcast.sendToAllWindows(channel, payload);
}
