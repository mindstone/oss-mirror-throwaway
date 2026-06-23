// cloud-client/src/types/liveMeetingIds.ts
//
// Branded (nominal) id types for live-meeting turn metadata.
//
// Three ids participate in a live-meeting companion turn and were historically
// all plain `string`, which let them be swapped silently. The 1e9ee60 postmortem
// (docs-private/postmortems/260531_stop_state_map_sync_from_demoting_1e9ee60_postmortem.md)
// records the incident: the mobile unification change passed the LOCAL recording
// id where the CLOUD meeting session id was expected, so the agent answered blind
// to the meeting transcript. Because both were `string`, the compiler could not
// catch the swap.
//
// Rec #21 (fingerprint 80e53fbe0359136e, type_constraint): "Represent live-meeting
// turn metadata as a typed object with distinct local recording id, cloud meeting
// session id, and companion conversation id fields at every submission boundary."
//
// These brands make the swap a COMPILE ERROR at every producer boundary. The brand
// is erased back to a plain `string` exactly at the wire boundary (the WebSocket
// turnRequest in submitTurnViaSocket / the cloud-client startTurn payload), so the
// shared `AgentTurnRequest` wire type, its Zod schema, and the cloud/core consumer
// (agentTurnSubmissionService, transcriptContext) stay untouched.

declare const __liveMeetingIdBrand: unique symbol;

type Branded<T, B extends string> = T & { readonly [__liveMeetingIdBrand]: B };

/** Mobile-local meeting manifest / recording id. Identifies the on-device audio
 *  recording and its chunk queue. NEVER sent as the cloud meeting session id. */
export type LocalRecordingId = Branded<string, 'LocalRecordingId'>;

/** Cloud meeting session id. The only id that crosses the wire as
 *  `AgentTurnRequest.meetingSessionId`; the cloud agent route uses it to inject
 *  the rolling transcript. Distinct from the local recording id. */
export type CloudMeetingSessionId = Branded<string, 'CloudMeetingSessionId'>;

/** Companion conversation id — the chat/session the live-meeting turn belongs to
 *  (the turn `sessionId`). Distinct from both recording ids. */
export type CompanionConversationId = Branded<string, 'CompanionConversationId'>;

/** Sanctioned brand entry points. Each takes ownership of a raw string at the
 *  boundary where its provenance is known (store rehydrate, manifest, store set). */
export const asLocalRecordingId = (value: string): LocalRecordingId => value as LocalRecordingId;
export const asCloudMeetingSessionId = (value: string): CloudMeetingSessionId =>
  value as CloudMeetingSessionId;
export const asCompanionConversationId = (value: string): CompanionConversationId =>
  value as CompanionConversationId;

/**
 * Typed live-meeting metadata carried on a turn submission. Only the cloud
 * meeting session id crosses the wire (plus the recording-active flag); the local
 * recording id and companion conversation id stay in their owning stores/context.
 * Because `cloudMeetingSessionId` is branded, a `LocalRecordingId` or
 * `CompanionConversationId` cannot be assigned into it.
 */
export interface LiveMeetingTurnMetadata {
  /** Cloud meeting session id — injects rolling transcript context server-side. */
  cloudMeetingSessionId?: CloudMeetingSessionId;
  /** Live meeting recording active for this turn (even if cloud id not yet known). */
  recordingActive?: boolean;
}
