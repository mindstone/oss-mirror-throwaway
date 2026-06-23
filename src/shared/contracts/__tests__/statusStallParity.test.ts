/**
 * Stage 1b (260617_bricked-state-0448-electron42) — `status.stall` wire-contract
 * parity guard.
 *
 * The soft "still waiting" marker is an OPTIONAL + ADDITIVE field on the `status`
 * AgentEvent, dual-sourced + parity-gated across THREE lockstep surfaces:
 *   1. the TS discriminated union (`src/shared/types/agent.ts`),
 *   2. the IPC Zod schema (`src/shared/ipc/schemas/agent.ts`, `AgentEventSchema`),
 *   3. the parity-gated manifest (`src/shared/contracts/agentEventManifest.ts`,
 *      `AgentEventSchemaFromManifest`).
 *
 * This test pins the runtime contract on the two Zod surfaces:
 *   - a `status` event WITHOUT `stall` still parses (back-compat — absent =
 *     today's behaviour),
 *   - a `status` event WITH a well-formed `stall` parses and round-trips,
 *   - a malformed `stall` (wrong `phase`, missing `sinceMs`, wrong type) FAILS.
 *
 * The compile-time `AgentEventFromSchema` parity assertion (schemas/agent.ts)
 * + the manifest parity gate (`npm run validate:fast`) cover the TS-union ↔ Zod
 * alignment; this file is the runtime half.
 */
import { describe, expect, it } from 'vitest';

import { AgentEventSchema } from '@shared/ipc/schemas/agent';
import { AgentEventSchemaFromManifest } from '@shared/contracts/agentEventManifest';
import type { AgentEvent } from '@shared/types';

describe('status.stall wire-contract parity (Stage 1b, 260617)', () => {
  const statusWithoutStall: AgentEvent = {
    type: 'status',
    message: 'Working on it…',
    timestamp: 1_000,
  };

  const statusWithStall: AgentEvent = {
    type: 'status',
    message: 'Still on this one — it is taking longer than usual.',
    timestamp: 2_000,
    stall: { phase: 'awaiting_api', sinceMs: 30_000 },
  };

  it('parses a status event WITHOUT stall (back-compat) on the IPC schema', () => {
    expect(AgentEventSchema.parse(statusWithoutStall)).toMatchObject({
      type: 'status',
      message: 'Working on it…',
    });
    // Absent stall stays absent — no implicit default.
    const parsed = AgentEventSchema.parse(statusWithoutStall) as { stall?: unknown };
    expect(parsed.stall).toBeUndefined();
  });

  it('parses a status event WITH a well-formed stall on the IPC schema', () => {
    expect(AgentEventSchema.parse(statusWithStall)).toMatchObject({
      type: 'status',
      stall: { phase: 'awaiting_api', sinceMs: 30_000 },
    });
  });

  it('parses both shapes on the manifest schema (lockstep parity)', () => {
    expect(AgentEventSchemaFromManifest.safeParse(statusWithoutStall).success).toBe(true);
    expect(AgentEventSchemaFromManifest.safeParse(statusWithStall).success).toBe(true);
  });

  it('round-trips the stall marker on both schemas unchanged', () => {
    expect(AgentEventSchema.parse(statusWithStall)).toMatchObject({
      stall: statusWithStall.stall,
    });
    expect(AgentEventSchemaFromManifest.parse(statusWithStall)).toMatchObject({
      stall: statusWithStall.stall,
    });
  });

  it('REJECTS a stall with the wrong phase', () => {
    const bad = { ...statusWithStall, stall: { phase: 'streaming', sinceMs: 30_000 } };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
    expect(AgentEventSchemaFromManifest.safeParse(bad).success).toBe(false);
  });

  it('REJECTS a stall missing sinceMs', () => {
    const bad = { ...statusWithStall, stall: { phase: 'awaiting_api' } };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });

  it('REJECTS a stall with a non-numeric sinceMs', () => {
    const bad = { ...statusWithStall, stall: { phase: 'awaiting_api', sinceMs: 'soon' } };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });
});
