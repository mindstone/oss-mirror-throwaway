/**
 * Stage 2 of docs/plans/260610_queue-drain-cancels-turn/PLAN.md (GPT F5) —
 * cloud-side schema parity for `AgentTurnRequest.supersedePolicy`.
 *
 * The cloud agent route (`routes/agent.ts`) gates every WS/HTTP turn request
 * through `AgentTurnRequestSchema.safeParse` — the SAME import used here. If
 * the field were added to the desktop channel contract but the shared schema
 * regressed (or cloud pinned a divergent copy), a desktop client running
 * Stage 3 would have its queue-mode sends rejected as "Invalid request body"
 * at the cloud boundary. These cases pin acceptance of both values, the
 * absent-field (legacy / version-skewed old client) shape, and rejection of
 * invalid values.
 */
import { describe, expect, it } from 'vitest';
// Exact import path used by cloud-service/src/routes/agent.ts.
import { AgentTurnRequestSchema } from '@shared/ipc/schemas/agent';

const baseRequest = {
  prompt: 'Summarise the meeting notes.',
  sessionId: 'session-cloud-1',
};

describe('cloud agent route — AgentTurnRequestSchema supersedePolicy parity', () => {
  it("accepts supersedePolicy: 'reject' (queue-mode send)", () => {
    const parsed = AgentTurnRequestSchema.safeParse({
      ...baseRequest,
      supersedePolicy: 'reject',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.supersedePolicy).toBe('reject');
  });

  it("accepts supersedePolicy: 'supersede' (explicit legacy)", () => {
    const parsed = AgentTurnRequestSchema.safeParse({
      ...baseRequest,
      supersedePolicy: 'supersede',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.supersedePolicy).toBe('supersede');
  });

  it('parses a legacy request without the field (absent stays absent — old desktop/mobile clients)', () => {
    const parsed = AgentTurnRequestSchema.safeParse(baseRequest);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'supersedePolicy' in parsed.data && parsed.data.supersedePolicy !== undefined).toBe(false);
  });

  it('rejects invalid supersedePolicy values', () => {
    for (const bad of ['defer', '', 42, true, {}]) {
      const parsed = AgentTurnRequestSchema.safeParse({
        ...baseRequest,
        supersedePolicy: bad,
      });
      expect(parsed.success, `value ${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });
});
