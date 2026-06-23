import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import {
  PLAN_OUTPUT_FORMAT,
  PLAN_RESPONSE_SCHEMA,
  PLAN_RESPONSE_SCHEMA_OPENAI_STRICT,
} from '../planningMode';

/**
 * Provider-compatibility CI gate for the planner's structured-output schemas.
 *
 * Two recursive walkers encode dialect rules sourced from live provider
 * 400 errors and the existing schema-design comments in `planningMode.ts`.
 * Each schema is validated against the dialect rules of the provider(s) it
 * is actually shipped to (per `openaiClient.toOpenAIResponseFormat` dialect
 * routing):
 *
 * - `PLAN_OUTPUT_FORMAT.schema` (the canonical universal-subset
 *   `PLAN_RESPONSE_SCHEMA`) is sent to Anthropic + Cohere/Together/etc.
 *   compat providers — must satisfy the Anthropic constrained-decoding
 *   validator. After the §9b post-Phase-7 flatten it shares the same
 *   flat-discriminator shape as the strict dialect; the two schemas
 *   differ only in nullability encoding (universal-subset uses nested
 *   `anyOf:[{type},{type:'null'}]`, strict uses `type:['T','null']`
 *   arrays). See `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
 *
 * - `PLAN_RESPONSE_SCHEMA_OPENAI_STRICT` is sent only to OpenAI strict mode —
 *   must satisfy the OpenAI strict validator (root is a flat `type:'object'`
 *   with a nested `type` discriminator enum in `properties`, NO top-level
 *   `anyOf`/`oneOf`/`allOf`/`not`/`enum` regardless of sibling `type:'object'`,
 *   every nested object has `additionalProperties:false`, every property
 *   declared in `properties` is also in `required`).
 *
 * Speculative restrictions are deliberately avoided — only rules backed
 * by an observed rejection or documented provider behaviour are encoded.
 *
 * - OpenAI strict mode: rejected `f1b4d44b-…` (April 2026) with
 *   "schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/
 *   'enum'/'not' at the top level". The May-5 fix `7bea3bed0` introduced a
 *   carve-out claiming OpenAI accepts `type:'object'` adjacent to `anyOf` —
 *   this was incorrect (the fix wrote the unit test against the schema
 *   shape, not against live provider behaviour). The May-8 trace
 *   (`tmp/agent-tests/eval-overnight/smoke_openai_20260508_135939.log:65-90`)
 *   reproduced the same rejection on the May-5 schema, proving the rule:
 *   **OpenAI strict forbids `anyOf`/`oneOf`/`allOf`/`not`/`enum` at the top
 *   level UNCONDITIONALLY, even with sibling `type:'object'`.** This guard
 *   was tightened in `260508_planner_schema_openai_strict_flatten_discriminator.md`
 *   to enforce the unconditional rule. Plus the documented strict-mode rule
 *   that every object must have `additionalProperties: false` and every
 *   `properties` key must appear in `required`.
 *
 * - Anthropic constrained decoding: rejected `2feaa34a-…` with
 *   "Enum value 'low' does not match declared type '['string', 'null']'".
 *   Plus the existing Anthropic-comment-documented `additionalProperties:
 *   false` requirement on every object.
 */

type SchemaNode = Record<string, unknown>;

const isObject = (value: unknown): value is SchemaNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const declaresObjectType = (node: SchemaNode): boolean => {
  const type = node.type;
  if (type === 'object') return true;
  if (Array.isArray(type) && type.includes('object')) return true;
  return false;
};

function validateForOpenAIStrict(schema: SchemaNode): string[] {
  const violations: string[] = [];

  if (schema.type !== 'object') {
    violations.push('<root>: type must be "object" for OpenAI strict mode');
  }
  // OpenAI strict mode forbids these combinators at the top level
  // UNCONDITIONALLY — even when sibling `type:'object'` is also present.
  // The May-5 carve-out (was: "accepts type:'object' adjacent to anyOf")
  // was based on a unit test written off the schema shape rather than live
  // provider behaviour; the May-8 production trace reproduced the rejection
  // on that exact shape. See planning doc
  // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`
  // and `docs/project/REBEL_CORE.md:171-203` for the canonical rule.
  for (const forbidden of ['anyOf', 'oneOf', 'allOf', 'not', 'enum'] as const) {
    if (schema[forbidden] !== undefined) {
      violations.push(`<root>: top-level "${forbidden}" is not allowed in OpenAI strict mode`);
    }
  }

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;

    if (declaresObjectType(node)) {
      const hasProperties = isObject(node.properties);
      // A "discriminator hub" node (type:'object' + anyOf, no own properties)
      // delegates the constraint surface to its branches and doesn't need its
      // own additionalProperties:false. Only enforce it on nodes that actually
      // declare properties.
      if (hasProperties && node.additionalProperties !== false) {
        violations.push(`${path || '<root>'}: additionalProperties must be false (OpenAI strict mode)`);
      }
      const properties = node.properties;
      if (isObject(properties) && Object.keys(properties).length > 0) {
        const required = Array.isArray(node.required) ? new Set(node.required) : new Set<string>();
        for (const key of Object.keys(properties)) {
          if (!required.has(key)) {
            violations.push(
              `${path || '<root>'}.${key}: declared in properties but missing from required (OpenAI strict mode)`,
            );
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`);
    }
  };
  walk(schema, '');

  return violations;
}

const declaresArrayType = (node: SchemaNode): boolean => {
  const type = node.type;
  if (type === 'array') return true;
  if (Array.isArray(type) && type.includes('array')) return true;
  return false;
};

function validateForAnthropicConstrained(schema: SchemaNode): string[] {
  const violations: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;

    if (declaresObjectType(node)) {
      if (node.additionalProperties !== false) {
        violations.push(
          `${path || '<root>'}: additionalProperties must be false (Anthropic constrained decoding)`,
        );
      }
    }

    if (Array.isArray(node.type) && Array.isArray(node.enum)) {
      violations.push(
        `${path || '<root>'}: combines array-form type ${JSON.stringify(node.type)} with enum (Anthropic rejects this combo)`,
      );
    }

    if (declaresArrayType(node) && typeof node.minItems === 'number') {
      if (node.minItems !== 0 && node.minItems !== 1) {
        violations.push(
          `${path || '<root>'}: minItems=${node.minItems} not allowed (Anthropic constrained decoding accepts only 0 or 1)`,
        );
      }
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`);
    }
  };
  walk(schema, '');

  return violations;
}

describe('planSchemaProviderCompat', () => {
  describe('PLAN_OUTPUT_FORMAT.schema (universal-subset, sent to Anthropic + Cohere/Together compat)', () => {
    it('passes the Anthropic constrained-decoding validator', () => {
      const violations = validateForAnthropicConstrained(PLAN_OUTPUT_FORMAT.schema);
      expect(violations).toEqual([]);
    });
  });

  describe('PLAN_RESPONSE_SCHEMA_OPENAI_STRICT (sent only to OpenAI strict mode)', () => {
    it('passes the OpenAI strict-mode validator', () => {
      const violations = validateForOpenAIStrict(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT);
      expect(violations).toEqual([]);
    });
  });

  // The prompt at `rebel-system/prompts/agent/planning-instructions.md` ships
  // a single unified key spec to ALL providers and instructs the model to
  // emit every listed key in every output (with inactive variant fields set
  // to null/[]). If the two dialects' top-level `required` arrays diverge,
  // exactly one of them will reject every prompt-conformant output —
  // that is the §9b cross-surface miss caught by Phase 7 review on
  // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
  // This guard ensures any future schema edit that updates one dialect's
  // required-key set without updating the other fails CI here, not in
  // production.
  describe('schema-prompt contract (cross-dialect symmetry)', () => {
    it('both dialects require the same top-level keys in the same order', () => {
      const universal = PLAN_RESPONSE_SCHEMA.required as readonly string[];
      const strict = PLAN_RESPONSE_SCHEMA_OPENAI_STRICT.required as readonly string[];
      expect(universal).toEqual(strict);
    });

    it('both dialects expose the same top-level property keys', () => {
      const universalProps = Object.keys(
        (PLAN_RESPONSE_SCHEMA.properties ?? {}) as Record<string, unknown>,
      ).sort();
      const strictProps = Object.keys(
        (PLAN_RESPONSE_SCHEMA_OPENAI_STRICT.properties ?? {}) as Record<string, unknown>,
      ).sort();
      expect(universalProps).toEqual(strictProps);
    });

    it('top-level required matches the unified prompt schema (10 keys)', () => {
      const expected = [
        'type',
        'confidence',
        'answer',
        'reasoning',
        'goal',
        'assumptions',
        'steps',
        'risks',
        'done_criteria',
        'routing',
      ];
      expect(PLAN_RESPONSE_SCHEMA.required).toEqual(expected);
      expect(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT.required).toEqual(expected);
    });

    // The §9b symmetry argument applies recursively. If only one dialect's
    // nested `steps[].properties` or `routing.properties` is updated (e.g.
    // adding a new step field), the other will silently reject every
    // prompt-conformant plan. These guards extend the cross-dialect check
    // one level deeper into the variant fields the model populates.
    const stepsItemsProps = (schema: typeof PLAN_RESPONSE_SCHEMA): readonly string[] => {
      const steps = (schema.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>)
        .steps;
      return Object.keys(steps?.items?.properties ?? {}).sort();
    };

    it('steps[] item properties are symmetric across dialects', () => {
      expect(stepsItemsProps(PLAN_RESPONSE_SCHEMA)).toEqual(
        stepsItemsProps(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT),
      );
    });

    const routingProps = (schema: typeof PLAN_RESPONSE_SCHEMA): readonly string[] => {
      // Universal-subset wraps `routing` in `anyOf:[{...object...},{type:'null'}]`,
      // strict uses `type:['object','null']` directly. Reach into either
      // shape to extract the actual property bag.
      const routing = (schema.properties as Record<string, unknown>).routing as
        | { properties?: Record<string, unknown>; anyOf?: Array<{ properties?: Record<string, unknown> }> }
        | undefined;
      const props =
        routing?.properties ?? routing?.anyOf?.find((branch) => branch.properties)?.properties ?? {};
      return Object.keys(props).sort();
    };

    it('routing object properties are symmetric across dialects', () => {
      expect(routingProps(PLAN_RESPONSE_SCHEMA)).toEqual(routingProps(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT));
    });
  });

  describe('validateForOpenAIStrict (positive controls)', () => {
    it('flags top-level oneOf without sibling type:object', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
        oneOf: [],
      };
      const violations = validateForOpenAIStrict(bad);
      expect(violations.some((v) => v.includes('top-level "oneOf"'))).toBe(true);
    });

    // Canonical-rule guard from
    // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
    // The May-5 fix `7bea3bed0` permitted root `anyOf` when sibling
    // `type:'object'` was present; the May-8 production trace reproduced the
    // rejection on that exact shape. This test ensures any future schema
    // edit that re-introduces the wrong shape fails CI.
    it('flags top-level anyOf even when sibling type:"object" is present', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
        anyOf: [
          { type: 'object', additionalProperties: false, properties: {}, required: [] },
        ],
      };
      const violations = validateForOpenAIStrict(bad);
      expect(violations.some((v) => v.includes('top-level "anyOf"'))).toBe(true);
    });

    it('flags missing additionalProperties:false on a nested object', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          nested: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        },
        required: ['nested'],
      };
      const violations = validateForOpenAIStrict(bad);
      expect(violations.some((v) => v.includes('additionalProperties must be false'))).toBe(true);
    });

    it('flags a property declared in properties but absent from required', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
        },
        required: ['a'],
      };
      const violations = validateForOpenAIStrict(bad);
      expect(violations.some((v) => v.includes('.b: declared in properties but missing from required'))).toBe(true);
    });

    it('flags non-object root', () => {
      const bad: SchemaNode = { type: 'string' };
      const violations = validateForOpenAIStrict(bad);
      expect(violations.some((v) => v.includes('type must be "object"'))).toBe(true);
    });
  });

  describe('validateForAnthropicConstrained (positive controls)', () => {
    it('flags array-form type combined with enum', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          effort: { type: ['string', 'null'], enum: ['low', 'medium'] },
        },
        required: ['effort'],
      };
      const violations = validateForAnthropicConstrained(bad);
      expect(violations.some((v) => v.includes('combines array-form type'))).toBe(true);
    });

    it('flags missing additionalProperties:false on a nested object', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          nested: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        required: ['nested'],
      };
      const violations = validateForAnthropicConstrained(bad);
      expect(violations.some((v) => v.includes('additionalProperties must be false'))).toBe(true);
    });

    it('accepts nullable enums expressed via nested anyOf', () => {
      const ok: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          effort: {
            anyOf: [
              { type: 'string', enum: ['low', 'medium'] },
              { type: 'null' },
            ],
          },
        },
        required: ['effort'],
      };
      const violations = validateForAnthropicConstrained(ok);
      expect(violations).toEqual([]);
    });

    // Anthropic constrained decoding limits array minItems to 0 or 1 — any other
    // value is rejected at runtime even though the JSON Schema spec permits it.
    // Documented in Debugger 3 evidence in the diagnosis doc; encoded here so a
    // future schema edit setting minItems > 1 fails CI instead of users.
    it('flags array minItems > 1', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          tags: { type: 'array', items: { type: 'string' }, minItems: 5 },
        },
        required: ['tags'],
      };
      const violations = validateForAnthropicConstrained(bad);
      expect(violations.some((v) => v.includes('minItems=5 not allowed'))).toBe(true);
    });

    it('flags array minItems = 2 (smallest disallowed value)', () => {
      const bad: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
        },
        required: ['tags'],
      };
      const violations = validateForAnthropicConstrained(bad);
      expect(violations.some((v) => v.includes('minItems=2 not allowed'))).toBe(true);
    });

    it('accepts minItems = 0 and minItems = 1', () => {
      const ok: SchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: 'array', items: { type: 'string' }, minItems: 0 },
          b: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['a', 'b'],
      };
      const violations = validateForAnthropicConstrained(ok);
      expect(violations).toEqual([]);
    });
  });

  // The dialect-rule walkers above prove the schemas are *shaped* in a way
  // each provider accepts, but they don't prove a real model output actually
  // validates. Ajv-backed roundtrip tests close that gap deterministically:
  // a planner output conforming to the unified prompt spec is fed through
  // both schemas and must validate as expected. This is the strongest
  // unit-cost equivalent of the live-API smoke for the schema contract —
  // see `coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md` for prevention protocols.
  describe('Ajv roundtrip: representative planner outputs validate', () => {
    // Ajv 8 default-mode rejects some non-spec patterns OpenAI strict accepts
    // (notably `enum:[null]` combined with array-form `type`). Providers
    // perform output-validation only — they don't meta-check the schema.
    // strict:false mirrors that: focus on whether the OUTPUT validates,
    // not whether the schema is strictest-mode JSON Schema.
    const ajv = new Ajv({ strict: false, allErrors: true });
    const universalValidate = ajv.compile(PLAN_RESPONSE_SCHEMA);
    const strictValidate = ajv.compile(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT);

    const directAnswer = {
      type: 'direct_answer',
      confidence: 0.97,
      answer: 'The capital of France is Paris.',
      reasoning: 'Direct factual recall from pre-loaded context.',
      goal: null,
      assumptions: [],
      steps: [],
      risks: [],
      done_criteria: [],
      routing: null,
    };

    const planNonAdaptive = {
      type: 'plan',
      confidence: null,
      answer: null,
      reasoning: null,
      goal: 'Send the meeting prep summary to the team.',
      assumptions: ['User has Slack access', 'Team channel is #team-alpha'],
      steps: [
        {
          id: 's1',
          description: 'Read calendar for today',
          success_signal: 'Found at least one event',
          suggested_tools: ['calendar_read'],
          depends_on: [],
          parallel_group: null,
          model: null,
          effort: null,
          sub_agents: null,
        },
      ],
      risks: ['Calendar may be empty'],
      done_criteria: ['Summary posted to Slack'],
      routing: null,
    };

    const planAdaptive = {
      type: 'plan',
      confidence: null,
      answer: null,
      reasoning: null,
      goal: 'Triage inbox and reply to high-priority threads.',
      assumptions: [],
      steps: [
        {
          id: 's1',
          description: 'Fetch unread emails',
          success_signal: 'List of unread emails returned',
          suggested_tools: ['email_search'],
          depends_on: [],
          parallel_group: null,
          model: 'claude-haiku-4-5',
          effort: 'low',
          sub_agents: [
            {
              task: 'Classify priority for each email',
              model: 'claude-haiku-4-5',
              effort: 'low',
              context: 'scoped',
            },
          ],
        },
      ],
      risks: ['Inbox may have unread spam mixed with priority threads'],
      done_criteria: ['Each high-priority thread has a draft reply'],
      routing: {
        default_model: 'claude-haiku-4-5',
        default_effort: 'low',
        escalation: {
          at_step: 's1',
          to_model: 'claude-sonnet-4-6',
          to_effort: 'medium',
          reason: 'Ambiguous priority assessments',
        },
        rationale: 'Cheap classifier first, escalate on uncertainty',
      },
    };

    const cases = [
      { name: 'direct_answer', output: directAnswer },
      { name: 'plan (no adaptive routing)', output: planNonAdaptive },
      { name: 'plan (adaptive routing + sub_agents)', output: planAdaptive },
    ];

    for (const { name, output } of cases) {
      it(`PLAN_RESPONSE_SCHEMA accepts ${name}`, () => {
        const ok = universalValidate(output);
        expect(universalValidate.errors).toBeNull();
        expect(ok).toBe(true);
      });

      it(`PLAN_RESPONSE_SCHEMA_OPENAI_STRICT accepts ${name}`, () => {
        const ok = strictValidate(output);
        expect(strictValidate.errors).toBeNull();
        expect(ok).toBe(true);
      });
    }

    // Negative control: an output missing the discriminator key MUST be
    // rejected by both dialects. Confirms the validators are wired and
    // not silently passing.
    it('both dialects reject an output missing the type discriminator', () => {
      const bad: Record<string, unknown> = { ...directAnswer };
      delete bad.type;
      expect(universalValidate(bad)).toBe(false);
      expect(strictValidate(bad)).toBe(false);
    });
  });
});
