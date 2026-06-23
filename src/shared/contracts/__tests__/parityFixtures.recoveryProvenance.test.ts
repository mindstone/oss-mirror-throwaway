import { describe, expect, it } from 'vitest';

import { AgentEventSchema } from '@shared/ipc/schemas/agent';
import { AgentEventSchemaFromManifest } from '@shared/contracts/agentEventManifest';

import { parityFixtures } from './parityFixtures';

const REQUIRED_RECOVERY_FIELDS = [
  'turnId',
  'sessionId',
  'originalSessionId',
  'totalCalls',
] as const;

const recoveryPositiveFixtures = parityFixtures.filter((fixture) =>
  fixture.category === 'positive' &&
  typeof fixture.variant === 'string' &&
  fixture.variant.startsWith('recovery:'),
);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected fixture input to be an object');
  }
  return value as Record<string, unknown>;
}

describe('recovery parity fixtures provenance contract', () => {
  it('positive fixtures carry turnId, sessionId, originalSessionId, and totalCalls', () => {
    // 11 generated (one per recovery:* spec) + 2 REBEL-5BM recovery:failed
    // positives (agent_loop_error_after_recovery + long_context_fallback_failed).
    expect(recoveryPositiveFixtures).toHaveLength(13);

    for (const fixture of recoveryPositiveFixtures) {
      const input = asRecord(fixture.input);
      expect(input.type).toBe(fixture.variant);
      expect(typeof input.turnId, fixture.variant).toBe('string');
      expect(typeof input.sessionId, fixture.variant).toBe('string');
      expect(typeof input.originalSessionId, fixture.variant).toBe('string');
      expect(typeof input.totalCalls, fixture.variant).toBe('number');

      expect(AgentEventSchema.parse(input)).toEqual(input);
      expect(AgentEventSchemaFromManifest.parse(input)).toEqual(input);
    }
  });

  it.each(REQUIRED_RECOVERY_FIELDS)('rejects recovery fixtures when %s is removed', (field) => {
    for (const fixture of recoveryPositiveFixtures) {
      const input = { ...asRecord(fixture.input) };
      delete input[field];

      expect(
        AgentEventSchema.safeParse(input).success,
        `${fixture.variant} production schema should reject missing ${field}`,
      ).toBe(false);
      expect(
        AgentEventSchemaFromManifest.safeParse(input).success,
        `${fixture.variant} manifest schema should reject missing ${field}`,
      ).toBe(false);
    }
  });
});
