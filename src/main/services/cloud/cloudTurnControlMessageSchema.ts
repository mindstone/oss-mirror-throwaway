/**
 * Cloud agent turn WebSocket — control-message Zod schema.
 *
 * The cloud /api/agent/turn WebSocket multiplexes two distinct shapes over the
 * same channel:
 *
 *  1. Control frames    — `turn_started`, `turn_persisted`, `turn_in_flight`,
 *                         `session_tombstoned`, `error` (pre-turnId variant).
 *                         These gate the turnId lifecycle and are NOT
 *                         AgentEvents — they have a different field shape and a
 *                         different consumer (Promise resolve/reject + lifecycle
 *                         handlers).
 *  2. AgentEvent frames — assistant/tool/result/error/etc. Validated by
 *                         `AgentEventSchemaFromManifest` and dispatched to
 *                         `onEvent`.
 *
 * The post-cutover ingress (R2 Stage 3a-D1) tries control-frame parsing FIRST.
 * If the message is a valid control frame, the lifecycle branch handles it.
 * Otherwise (and only after `turnId` is set), it tries AgentEvent parsing.
 *
 * **CRITICAL — `.strict()` on every member**: Phase-2 P0-1 finding. AgentEvent
 * `error` events have shape `{ type: 'error', error: string, sessionId, turnId,
 * timestamp, rawError?, ... }`. Without `.strict()`, Zod's default object mode
 * strips unknown keys, and a real AgentEvent error would PASS the control-frame
 * `safeParse`, returning stripped `{ type: 'error', error: 'foo' }`. With
 * `turnId` already set, the rejection branch wouldn't fire, and the AgentEvent
 * error would be silently dropped — exact silent-failure-is-a-bug regression.
 * With `.strict()`, AgentEvent errors fail control-frame parsing (because their
 * envelope fields are unknown keys) and proceed to the AgentEvent branch as
 * intended.
 *
 * Source-correct wire-protocol shapes verified against `cloud-service/src/
 * routes/agent.ts` on 2026-05-02:
 *   - turn_started (line 573):   { type, turnId, clientTurnId?, supportsPersistedAck: true }
 *   - turn_persisted (152-158, 432-438): { type, clientTurnId, turnId,
 *                                          sessionId, status, outcome?, seq?,
 *                                          idempotentReplay? }
 *   - turn_in_flight (line 166): { type, clientTurnId, turnId?, sessionId,
 *                                  status }
 *   - session_tombstoned (agent.ts:305): { type, sessionId, clientTurnId? }
 *     — emitted when a turn targets a server-tombstoned (deleted) session; the
 *     turn never ran. The WS consumer rejects so the client recreates the
 *     conversation under a fresh id. Mirrors the session-events 410 semantics.
 *   - error (lines 132, 138, 608): { type, error: string }
 *
 * Refs: docs/plans/260502_r2_stage3a_residual_implementation_plan.md § S3a-D1;
 *       docs/plans/260622_mobile-record-recreated-session/PLAN.md (Stage 1b / 2c F2)
 */

import { z } from 'zod';

const TurnStartedSchema = z
  .object({
    type: z.literal('turn_started'),
    turnId: z.string(),
    clientTurnId: z.string().optional(),
    supportsPersistedAck: z.literal(true).optional(),
  })
  .strict();

const TurnPersistedSchema = z
  .object({
    type: z.literal('turn_persisted'),
    clientTurnId: z.string(),
    turnId: z.string(),
    sessionId: z.string(),
    status: z.string(),
    outcome: z.unknown().optional(),
    seq: z.number().int().optional(),
    idempotentReplay: z.literal(true).optional(),
  })
  .strict();

const TurnInFlightSchema = z
  .object({
    type: z.literal('turn_in_flight'),
    clientTurnId: z.string(),
    turnId: z.string().optional(),
    sessionId: z.string(),
    status: z.string(),
  })
  .strict();

const SessionTombstonedSchema = z
  .object({
    type: z.literal('session_tombstoned'),
    sessionId: z.string(),
    clientTurnId: z.string().optional(),
  })
  .strict();

const ControlErrorSchema = z
  .object({
    type: z.literal('error'),
    error: z.string(),
  })
  .strict();

export const CloudTurnControlMessageSchema = z.discriminatedUnion('type', [
  TurnStartedSchema,
  TurnPersistedSchema,
  TurnInFlightSchema,
  SessionTombstonedSchema,
  ControlErrorSchema,
]);

export type CloudTurnControlMessage = z.infer<typeof CloudTurnControlMessageSchema>;
