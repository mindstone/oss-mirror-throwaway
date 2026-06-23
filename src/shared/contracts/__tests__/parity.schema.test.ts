/**
 * S2-D Stage 2: schema parity. Asserts that the manifest-derived
 * `AgentEventSchemaFromManifest` and the production `AgentEventSchema` (Zod
 * hand-authored) accept and reject the same inputs across the 142-fixture
 * corpus, AND that their normalised output is byte-equal for accept-cells.
 *
 * Uses `IsExactStrict<AgentEvent, AgentEventFromManifest>` as a TS-level
 * cross-check (closes Opus's TS-type parity surface gap, per Phase-2 Critique
 * Amendment 1).
 *
 * Test pattern: `it.each(parityFixtures)('$variant/$category/$label', ...)`
 * for richer failure messages (per Phase-2 Critique Amendment 10).
 */
import { describe, expect, it } from 'vitest';

import {
  AgentEventSchema,
  type AgentEvent as ZodAgentEvent,
} from '@shared/ipc/schemas/agent';
import {
  AgentEventSchemaFromManifest,
  type AgentEventFromManifest,
} from '@shared/contracts/agentEventManifest';
import type { AssertExact, IsExactStrict } from '@shared/types/typeAssertions';

import { parityFixtures, type ParityFixture } from './parityFixtures';

// TS-level type parity: AgentEvent (Zod-inferred) MUST equal AgentEventFromManifest
// (manifest-derived) per Phase-2 Critique Amendment 1.
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time parity gate sentinel
type _ManifestParityCheck = AssertExact<IsExactStrict<ZodAgentEvent, AgentEventFromManifest>>;

function formatIssues(result: {
  success: boolean;
  error?: { issues?: unknown };
}): string {
  if (result.success) {
    return 'none';
  }

  return JSON.stringify(result.error?.issues ?? [], null, 2);
}

describe('AgentEvent schema parity', () => {
  it.each<ParityFixture>(parityFixtures)('$variant/$category/$label', (fixture) => {
    const productionResult = AgentEventSchema.safeParse(fixture.input);
    const manifestResult = AgentEventSchemaFromManifest.safeParse(fixture.input);

    if (fixture.expectedAccept) {
      expect(
        productionResult.success,
        `production schema rejected: ${formatIssues(productionResult)}`,
      ).toBe(true);
      expect(
        manifestResult.success,
        `manifest schema rejected: ${formatIssues(manifestResult)}`,
      ).toBe(true);

      if (productionResult.success && manifestResult.success) {
        expect(manifestResult.data).toEqual(productionResult.data);

        if (fixture.expectedNormalised !== undefined) {
          expect(productionResult.data).toEqual(fixture.expectedNormalised);
          expect(manifestResult.data).toEqual(fixture.expectedNormalised);
        }
      }

      return;
    }

    expect(
      productionResult.success,
      `production schema accepted what should be rejected: ${JSON.stringify(productionResult, null, 2)}`,
    ).toBe(false);
    expect(
      manifestResult.success,
      `manifest schema accepted what should be rejected: ${JSON.stringify(manifestResult, null, 2)}`,
    ).toBe(false);
  });
});
