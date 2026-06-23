/**
 * S2-D Stage 3: policy parity tests.
 *
 * Layer 3.1 (literal-oracle parity for `COMPACTION_POLICY_FROM_MANIFEST` and
 * `SANITIZATION_POLICY_FROM_MANIFEST` against hand-authored ground truth) lives
 * in `agentEventManifest.test.ts` to avoid duplicating the oracle bodies and
 * to prevent re-registering tests when both files run together. This file
 * adds a sentinel assertion confirming the manifest exports both policy maps
 * with the expected variant coverage; the full per-variant oracle parity
 * remains in `agentEventManifest.test.ts`.
 */
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  AgentEventSchemaFromManifest,
  COMPACTION_POLICY_FROM_MANIFEST,
  SANITIZATION_POLICY_FROM_MANIFEST,
} from '@shared/contracts/agentEventManifest';
import {
  COMPACTION_POLICY_FROM_POLICY_MANIFEST,
  SANITIZATION_POLICY_FROM_POLICY_MANIFEST,
} from '@shared/contracts/agentEventPolicyManifest';
import type { AgentEvent } from '@shared/types';
import { compactTurnEvents } from '@shared/utils/eventCompaction';
import { sanitizeEventForMainAccumulation } from '@shared/utils/eventSanitization';

import { parityFixtures, type ParityFixture } from './parityFixtures';

type PositiveFixture = ParityFixture & { category: 'positive' };
type ManifestVariant = keyof typeof COMPACTION_POLICY_FROM_MANIFEST;
type CompactionPolicy = (typeof COMPACTION_POLICY_FROM_MANIFEST)[ManifestVariant];
type SanitizationPolicy = (typeof SANITIZATION_POLICY_FROM_MANIFEST)[ManifestVariant];

const POSITIVE_FIXTURES = parityFixtures.filter(
  (fixture): fixture is PositiveFixture => fixture.category === 'positive',
);
const POLICY_VARIANTS = Object.keys(COMPACTION_POLICY_FROM_MANIFEST) as ManifestVariant[];

/**
 * Look up the positive fixture for a variant, throwing if missing. Per Gemini
 * Phase 7 review: iterating directly over fixtures via `it.each(POSITIVE_FIXTURES)`
 * silently skips a variant if its fixture is missing. Driving the test loop
 * from `POLICY_VARIANTS` instead and looking up the fixture explicitly makes
 * coverage gaps fail loudly.
 */
function requirePositiveFixture(variant: ManifestVariant): PositiveFixture {
  const fixture = POSITIVE_FIXTURES.find((candidate) => candidate.variant === variant);
  if (!fixture) {
    throw new Error(
      `parityFixtures missing positive fixture for variant "${variant}" — ` +
        `Stage 3 policy parity coverage requires every variant to have a positive fixture.`,
    );
  }
  return fixture;
}

const TOOL_SANITIZATION_SOURCE_PACKAGE_ID = 'com.example.policy-parity';
const TOOL_SANITIZATION_PROMPT = `Policy parity prompt:\n${'x'.repeat(15_000)}`;

const parseInputEvent = (fixture: PositiveFixture): AgentEvent =>
  AgentEventSchemaFromManifest.parse(fixture.input);

const deriveCompactionPolicyFromObservation = (
  inputEvent: AgentEvent,
  compactedEvents: AgentEvent[],
): CompactionPolicy => {
  if (compactedEvents.length === 0) {
    return 'drop';
  }

  if (compactedEvents.length !== 1) {
    throw new Error(`Expected compaction output length 0 or 1, got ${compactedEvents.length}`);
  }

  return isDeepStrictEqual(compactedEvents[0], inputEvent) ? 'keep' : 'compact';
};

const deriveSanitizationPolicyFromObservation = (
  inputEvent: AgentEvent,
  sanitizedEvent: AgentEvent,
): SanitizationPolicy =>
  isDeepStrictEqual(sanitizedEvent, inputEvent)
    ? 'pass-through'
    : 'truncate-tool-detail-with-subagent-identity';

const buildToolSanitizationProbe = (
  baseEvent: Extract<AgentEvent, { type: 'tool' }>,
): Extract<AgentEvent, { type: 'tool' }> => ({
  ...baseEvent,
  toolName: 'Task',
  stage: 'start',
  detail: JSON.stringify({
    subagent_type: 'researcher-gpt5.5-high',
    description: 'Run Stage 3 policy parity checks.',
    prompt: TOOL_SANITIZATION_PROMPT,
    run_in_background: false,
  }, null, 2),
  mcpAppUiMeta: {
    resourceUri: 'mcp://policy-parity/view',
    sourcePackageId: TOOL_SANITIZATION_SOURCE_PACKAGE_ID,
  },
});

describe('policy parity', () => {
  describe('Layer 3.1 sentinel — manifest exports exist with expected coverage', () => {
    it('COMPACTION_POLICY_FROM_MANIFEST has all 31 variants', () => {
      expect(POLICY_VARIANTS).toHaveLength(31);
      for (const variant of POLICY_VARIANTS) {
        expect(['keep', 'compact', 'drop']).toContain(COMPACTION_POLICY_FROM_MANIFEST[variant]);
      }
    });

    it('SANITIZATION_POLICY_FROM_MANIFEST has all 31 variants', () => {
      expect(Object.keys(SANITIZATION_POLICY_FROM_MANIFEST)).toHaveLength(31);
      for (const variant of POLICY_VARIANTS) {
        expect(['pass-through', 'truncate-tool-detail-with-subagent-identity']).toContain(
          SANITIZATION_POLICY_FROM_MANIFEST[variant],
        );
      }
    });
  });

  describe('Layer 3.2 — behavioural-compaction parity', () => {
    it.each<ManifestVariant>(POLICY_VARIANTS)('%s', (variant) => {
      const fixture = requirePositiveFixture(variant);
      const inputEvent = parseInputEvent(fixture);
      const compactedEvents = compactTurnEvents([inputEvent]);
      const observedPolicy = deriveCompactionPolicyFromObservation(inputEvent, compactedEvents);

      if (observedPolicy === 'keep') {
        expect(compactedEvents).toHaveLength(1);
        expect(compactedEvents[0]).toEqual(inputEvent);
      } else if (observedPolicy === 'drop') {
        expect(compactedEvents).toHaveLength(0);
      } else {
        expect(compactedEvents).toHaveLength(1);
        const compactedEvent = compactedEvents[0];
        expect(compactedEvent.type).toBe(inputEvent.type);

        if (inputEvent.type === 'assistant') {
          expect(compactedEvent.type).toBe('assistant');
          if (compactedEvent.type === 'assistant') {
            expect(compactedEvent.text).toBe('');
          }
        } else if (inputEvent.type === 'tool') {
          expect(compactedEvent.type).toBe('tool');
          if (compactedEvent.type === 'tool') {
            // Positive fixture uses non-JSON detail, so canonical compact detail is ''.
            expect(compactedEvent.detail).toBe('');
          }
        } else {
          throw new Error(`Observed compact policy on unexpected variant ${inputEvent.type}`);
        }
      }

      expect(observedPolicy).toEqual(COMPACTION_POLICY_FROM_MANIFEST[variant]);
    });
  });

  describe('Layer 3.3 — sanitization parity', () => {
    it.each<ManifestVariant>(POLICY_VARIANTS)('%s', (variant) => {
      const fixture = requirePositiveFixture(variant);
      const parsedEvent = parseInputEvent(fixture);
      const inputEvent = parsedEvent.type === 'tool'
        ? buildToolSanitizationProbe(parsedEvent)
        : parsedEvent;
      const sanitizedEvent = sanitizeEventForMainAccumulation(inputEvent);
      const observedPolicy = deriveSanitizationPolicyFromObservation(
        inputEvent,
        sanitizedEvent,
      );

      if (observedPolicy === 'pass-through') {
        expect(sanitizedEvent).toEqual(inputEvent);
      } else {
        expect(inputEvent.type).toBe('tool');
        expect(sanitizedEvent.type).toBe('tool');

        if (inputEvent.type === 'tool' && sanitizedEvent.type === 'tool') {
          expect(inputEvent.detail.length).toBeGreaterThan(10_000);
          expect(sanitizedEvent.detail.length).toBeLessThan(inputEvent.detail.length);
          expect(sanitizedEvent.detail.length).toBeLessThanOrEqual(10_000);

          const sanitizedDetail = JSON.parse(sanitizedEvent.detail) as Record<string, unknown>;
          expect(sanitizedDetail.__detailTruncated).toBe(true);
          expect(sanitizedDetail.__originalDetailLength).toBe(inputEvent.detail.length);
          expect(sanitizedDetail.subagent_type).toBe('researcher-gpt5.5-high');

          expect(sanitizedEvent.mcpAppUiMeta?.sourcePackageId).toBe(
            TOOL_SANITIZATION_SOURCE_PACKAGE_ID,
          );
          expect(sanitizedEvent.toolName).toBe('Task');
          expect(sanitizedEvent.stage).toBe('start');
          expect(sanitizedEvent.timestamp).toBe(inputEvent.timestamp);
        }
      }

      expect(observedPolicy).toEqual(SANITIZATION_POLICY_FROM_MANIFEST[variant]);
    });
  });

  describe('Layer 3.4 — Zod-free sibling parity', () => {
    it.each<ManifestVariant>(POLICY_VARIANTS)('compaction policy parity for %s', (variant) => {
      expect(COMPACTION_POLICY_FROM_POLICY_MANIFEST[variant]).toEqual(
        COMPACTION_POLICY_FROM_MANIFEST[variant],
      );
    });

    it.each<ManifestVariant>(POLICY_VARIANTS)('sanitization policy parity for %s', (variant) => {
      expect(SANITIZATION_POLICY_FROM_POLICY_MANIFEST[variant]).toEqual(
        SANITIZATION_POLICY_FROM_MANIFEST[variant],
      );
    });
  });
});
