import { describe, expect, it } from 'vitest';

import {
  AgentEventSchemaFromManifest,
  COMPACTION_POLICY_FROM_MANIFEST,
  buildAgentEvent,
  policyFor,
} from '@shared/contracts/agentEventManifest';
import { AgentEventSchema } from '@shared/ipc/schemas/agent';

import { parityFixtures, type ParityFixture } from './parityFixtures';

type ManifestVariant = keyof typeof COMPACTION_POLICY_FROM_MANIFEST;
type PositiveFixture = ParityFixture & { category: 'positive'; variant: ManifestVariant };

const VARIANTS = Object.keys(COMPACTION_POLICY_FROM_MANIFEST) as ManifestVariant[];

const POSITIVE_FIXTURES = parityFixtures.filter(
  (fixture): fixture is PositiveFixture =>
    fixture.category === 'positive' &&
    VARIANTS.includes(fixture.variant as ManifestVariant),
);

const ENVELOPE_SHAPE_REPRESENTATIVES = Object.values(
  VARIANTS.reduce<Record<string, ManifestVariant>>((representatives, variant) => {
    const signature = policyFor(variant).envelope.requiredForNewEvents.join('|');
    if (!representatives[signature]) {
      representatives[signature] = variant;
    }
    return representatives;
  }, {}),
);

const RUNTIME_DEFENCE_VARIANTS = ENVELOPE_SHAPE_REPRESENTATIVES.slice(0, 4);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPositiveFixtureInput(variant: ManifestVariant): Record<string, unknown> {
  const fixture = POSITIVE_FIXTURES.find((candidate) => candidate.variant === variant);

  if (!fixture) {
    throw new Error(`Missing positive fixture for variant "${variant}"`);
  }

  if (!isRecord(fixture.input)) {
    throw new Error(`Positive fixture for "${variant}" is not an object input.`);
  }

  return fixture.input;
}

function payloadForVariant(variant: ManifestVariant): unknown {
  const entry = policyFor(variant);
  const fixtureInput = getPositiveFixtureInput(variant);
  const payloadShapeKeys = new Set<string>(Object.keys(entry.payloadSchema.shape));
  const requiredEnvelopeFields = new Set<string>(entry.envelope.requiredForNewEvents);

  const payloadCandidate = Object.fromEntries(
    Object.entries(fixtureInput).filter(([key]) => {
      if (key === 'type') {
        return false;
      }

      return !requiredEnvelopeFields.has(key) || payloadShapeKeys.has(key);
    }),
  );

  const payloadParse = entry.payloadSchema.safeParse(payloadCandidate);
  if (!payloadParse.success) {
    throw new Error(
      `Failed to derive builder payload from positive fixture for "${variant}": ${JSON.stringify(payloadParse.error.issues)}`,
    );
  }

  return payloadParse.data;
}

function envelopeForVariant(variant: ManifestVariant): Record<string, string> {
  const entry = policyFor(variant);
  const envelope: Record<string, string> = {};

  for (const field of entry.envelope.requiredForNewEvents) {
    envelope[field] = `${variant}-${field}`;
  }

  return envelope;
}

function unsafeBuildForVariant(
  variant: ManifestVariant,
  payload: unknown,
  envelope: Record<string, string>,
): unknown {
  const builder = buildAgentEvent[variant] as (
    inputPayload: unknown,
    inputEnvelope: Record<string, string>,
  ) => unknown;

  return builder(payload, envelope);
}

function formatIssues(result: { error?: { issues: unknown } } | undefined): string {
  if (!result?.error) {
    return '<no issues>';
  }
  return JSON.stringify(result.error.issues, null, 2);
}

describe('buildAgentEvent parity', () => {
  describe('round-trip across both schemas', () => {
    it.each(VARIANTS)('%s', (variant) => {
      const payload = payloadForVariant(variant);
      const envelope = envelopeForVariant(variant);
      const builtEvent = unsafeBuildForVariant(variant, payload, envelope);
      const entry = policyFor(variant);

      if (!isRecord(builtEvent)) {
        throw new Error(`Builder output for "${variant}" is not an object.`);
      }

      expect(builtEvent.type).toBe(variant);
      for (const field of entry.envelope.requiredForNewEvents) {
        expect(
          typeof builtEvent[field],
          `Expected envelope.${field} to be a string on raw builder output for "${variant}"`,
        ).toBe('string');
        expect(builtEvent[field]).toBe(envelope[field]);
      }

      const productionResult = AgentEventSchema.safeParse(builtEvent);
      const manifestResult = AgentEventSchemaFromManifest.safeParse(builtEvent);

      expect(
        productionResult.success,
        `AgentEventSchema rejected builder output for "${variant}":\n${formatIssues(productionResult)}`,
      ).toBe(true);
      expect(
        manifestResult.success,
        `AgentEventSchemaFromManifest rejected builder output for "${variant}":\n${formatIssues(manifestResult)}`,
      ).toBe(true);

      if (!productionResult.success || !manifestResult.success) {
        throw new Error(`Builder output failed schema parse for "${variant}"`);
      }

      // Per Gemini Phase 7 review: assert raw builder output equals the
      // schema-parsed output PLUS the envelope fields.
      //
      // The production schema strips envelope fields (`sessionId`, `turnId`,
      // etc.) from the parsed output — those fields exist on the runtime
      // event for routing/dispatch, but the schema's job is to validate
      // the persistable payload + discriminator. So the canonical equation
      // is: `builtEvent === { ...productionResult.data, ...envelope }`.
      // If both schemas were configured to silently strip *unknown* extras
      // from the payload, this assertion would still catch builder drift on
      // the canonical-output axis.
      const expectedBuilderOutput = { ...productionResult.data, ...envelope };
      expect(builtEvent).toEqual(expectedBuilderOutput);

      // And the manifest schema's parsed output MUST match the production
      // schema's parsed output exactly (this is the core S2-D promise).
      expect(manifestResult.data).toEqual(productionResult.data);
      expect(productionResult.data.type).toBe(variant);
      expect(manifestResult.data.type).toBe(variant);
    });
  });

  describe('envelope-extras rejection (per AgentEventSchema strict-strip)', () => {
    // Per GPT Phase 7 review: prove that builders do not allow envelope-bypass
    // attacks via extra fields injected through the envelope record. The
    // builder should pick only declared envelope fields; extras must NOT
    // appear on the resulting event.
    it.each(VARIANTS)('%s strips envelope extras', (variant) => {
      const payload = payloadForVariant(variant);
      const envelope = envelopeForVariant(variant);
      const envelopeWithExtras: Record<string, string> = {
        ...envelope,
        notARealEnvelopeField: 'should-be-stripped',
        anotherExtra: 'also-stripped',
      };

      const builtEvent = unsafeBuildForVariant(variant, payload, envelopeWithExtras);

      if (!isRecord(builtEvent)) {
        throw new Error(`Builder output for "${variant}" is not an object.`);
      }

      expect(builtEvent.notARealEnvelopeField).toBeUndefined();
      expect(builtEvent.anotherExtra).toBeUndefined();
    });
  });

  describe('runtime defence-in-depth on missing envelope fields', () => {
    it('covers at least four unique requiredForNewEvents envelope shapes', () => {
      expect(ENVELOPE_SHAPE_REPRESENTATIVES.length).toBeGreaterThanOrEqual(4);
      expect(RUNTIME_DEFENCE_VARIANTS).toHaveLength(4);
    });

    it.each(RUNTIME_DEFENCE_VARIANTS)('%s throws on empty envelope', (variant) => {
      const payload = payloadForVariant(variant);
      const firstRequiredField = policyFor(variant).envelope.requiredForNewEvents[0];

      expect(firstRequiredField).toBeDefined();
      if (!firstRequiredField) {
        throw new Error(`No required envelope fields declared for "${variant}"`);
      }

      expect(() =>
        unsafeBuildForVariant(
          variant,
          payload,
          {} as unknown as Record<string, string>,
        )).toThrowError(
        new RegExp(`buildAgentEvent\\.${variant} requires envelope\\.${firstRequiredField}`),
      );
    });
  });

  it('compile-time enforcement of envelope shape', () => {
    const toolPayload: Parameters<typeof buildAgentEvent.tool>[0] = {
      toolName: 'parity-tool',
      detail: 'compile-time envelope enforcement',
      stage: 'start',
      timestamp: 1700000000000,
    };

    const userQuestionPayload: Parameters<typeof buildAgentEvent.user_question>[0] = {
      batchId: 'batch-compile-time',
      toolUseId: 'tool-use-compile-time',
      questions: [],
      timestamp: 1700000000000,
    };

    // @ts-expect-error - missing required envelope.sessionId/turnId/toolUseId
    void (() => buildAgentEvent.tool(toolPayload, {}));

    // @ts-expect-error - missing required envelope.sessionId/turnId/batchId/toolUseId
    void (() => buildAgentEvent.user_question(userQuestionPayload, {}));

    expect(true).toBe(true);
  });
});
