/**
 * Closed-strict invariant tests for `agentEventManifest`.
 *
 * The most important assertions in this file are **type-level**: a
 * manifest entry literal that includes any property outside the
 * 19-axis contract MUST trigger a TS error. The `@ts-expect-error`
 * directives below capture those negative paths; the file compiles
 * only if the errors fire.
 *
 * Closed-strict is enforced both at the literal site (TS-2353) and at
 * pre-bound variables (via the `NoExtraKeys` intersection in the
 * helpers). The pre-bound bypass test is the load-bearing addition
 * from the Round 2 review (2026-04-29) — without it, an attacker
 * could smuggle an extra field through an intermediate variable.
 *
 * @see ../agentEventManifest.ts § "Closed-strict enforcement"
 * @see docs/plans/260427_refactor_contract_manifest.md § Manifest axes locked
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  agentEventManifest,
  AgentErrorResolutionActionSchema,
  AgentErrorResolutionSchema,
  defineAgentEvent,
  defineAgentEvents,
  type AgentEventFromManifest,
  type AgentEventManifest,
} from '../agentEventManifest';
import { agentEventPolicyManifest } from '../agentEventPolicyManifest';
import { applicabilityTag, isApplicabilityTag } from '../applicabilityTag';

// ============================================================================
//   Helper: minimal-yet-complete entry factory.
//
// S2-A1 ships the type contract only — there are no canonical 19
// variants yet. To exercise the closed-strict invariant we need at
// least one legal literal entry. This builder constructs one with all
// 19 axes populated.
// ============================================================================

function makeLegalEntry<const TType extends string>(type: TType) {
  return defineAgentEvent({
    type,
    payloadSchema: z.object({ ok: z.boolean() }),

    // Payload axes (10)
    compactionPolicy: 'keep',
    sanitization: 'identity',
    runtimeEffect: 'transient',
    uiVisibility: 'transcript',
    modelContextVisibility: 'replay-into-history',
    producerSurface: 'core',
    legacyCompatibility: { policy: 'strict-modern', notes: '' },
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag(
      'not-applicable',
      'fixture entry — applicability test only',
    ),

    // Envelope axes (9)
    envelope: {
      requiredForNewEvents: ['turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: false },
      dedupeKey: 'none',
      orderingSemantics: 'per-turn-ordered',
      idempotencyAndRetry: 'idempotent',
      cancellationBehavior: 'abort-on-disconnect',
      serializationConstraints: 'json-only',
    },
  });
}

// ============================================================================
//   Type-level: closed-strict negative tests (literal site)
// ============================================================================

describe('AgentEventManifestEntry — closed-strict invariant (type-level)', () => {
  it('rejects extra properties at the literal site (TS-2353 / NoExtraKeys)', () => {
    // The `@ts-expect-error` directive immediately below MUST fire — if
    // it does not, the closed-strict invariant has been weakened (e.g.,
    // by adding an index signature, or by re-typing the helper
    // signatures). That weakening is the exact failure mode the
    // manifest exists to prevent (parallel-declaration drift via
    // "extras" bag), so this directive is a load-bearing test.
    const offending = defineAgentEvent({
      type: 'fixture-with-extra',
      payloadSchema: z.object({ ok: z.boolean() }),

      compactionPolicy: 'keep',
      sanitization: 'identity',
      runtimeEffect: 'transient',
      uiVisibility: 'transcript',
      modelContextVisibility: 'replay-into-history',
      producerSurface: 'core',
      legacyCompatibility: { policy: 'strict-modern', notes: '' },
      unknownRuntimePolicy: 'preserve',
      telemetryPolicy: 'log-only',
      errorClassPolicy: applicabilityTag('not-applicable', 'fixture'),

      envelope: {
        requiredForNewEvents: ['turnId'],
        identityKey: 'turn-scoped',
        crossSessionRouting: 'drop-on-mismatch',
        persistence: { mainAccumulator: true, rendererStore: true, cloud: false },
        dedupeKey: 'none',
        orderingSemantics: 'per-turn-ordered',
        idempotencyAndRetry: 'idempotent',
        cancellationBehavior: 'abort-on-disconnect',
        serializationConstraints: 'json-only',
      },

      // @ts-expect-error closed-strict: an extras bag is the exact escape hatch
      //   the manifest forbids. This directive is the negative type-test;
      //   if it stops firing, the invariant has been broken — see file header.
      extra: { foo: 'bar' },
    });

    expect(offending.type).toBe('fixture-with-extra');
  });

  it('documents nested-extra coverage under E5 — ALL nested extras (literal AND pre-bound) routed to S2-CG', () => {
    // **E5 trade-off (2026-04-29, refined Phase-6)**: the original
    // `NoExtraKeysDeep` recursed into nested objects to catch
    // `envelope: { ..., envelopeExtra: 42 }` at compile time. The
    // recursion exploded TS Type/Instantiation counts on the
    // closed-strict 19×19 manifest by ~+400% and triggered the S2-E
    // re-probe failure (commit `e7e524594`).
    //
    // E5 scopes `NoExtraKeys` to top-level keys only. **Be honest
    // about what's lost**: because `defineAgentEvent` infers a generic
    // `TEntry` parameter, the inference widens to absorb any nested
    // extras BEFORE top-level `NoExtraKeys` runs — so even
    // inline-literal nested extras slip through the helper. Phase-6
    // review (gpt5.5-high) flagged this as P1: the docs initially
    // claimed inline-literal nested extras were still caught by
    // TS-2353, but the generic widening makes that unreliable.
    //
    // Pre-bound top-level "extras bag" smuggling — the historical
    // attack the manifest exists to prevent — IS still caught by
    // `NoExtraKeys` (see "pre-bound bypass attempt" describe below).
    //
    // ALL nested smuggle vectors (inline literal + pre-bound +
    // spread-via-Identifier like `envelope: { ...baseEnv }`) are closed
    // at lint time by the S2-CG manifest-guard AST walker, which must
    // be spread-aware (Phase-6 review by gemini3.1-pro flagged that
    // TS-2353 does NOT fire on spread properties even in inline
    // literals, so a spread bypass would slip past every TS-level
    // defence — S2-CG is the only line of defence).
    //
    // This test demonstrates that the entry below COMPILES under E5
    // (no `@ts-expect-error` directive needed), and serves as the
    // canary for detecting if `NoExtraKeysDeep` is reintroduced.
    const offending = defineAgentEvent({
      type: 'fixture-envelope-extra',
      payloadSchema: z.object({ ok: z.boolean() }),

      compactionPolicy: 'keep',
      sanitization: 'identity',
      runtimeEffect: 'transient',
      uiVisibility: 'transcript',
      modelContextVisibility: 'replay-into-history',
      producerSurface: 'core',
      legacyCompatibility: { policy: 'strict-modern', notes: '' },
      unknownRuntimePolicy: 'preserve',
      telemetryPolicy: 'log-only',
      errorClassPolicy: applicabilityTag('not-applicable', 'fixture'),

      envelope: {
        requiredForNewEvents: ['turnId'],
        identityKey: 'turn-scoped',
        crossSessionRouting: 'drop-on-mismatch',
        persistence: { mainAccumulator: true, rendererStore: true, cloud: false },
        dedupeKey: 'none',
        orderingSemantics: 'per-turn-ordered',
        idempotencyAndRetry: 'idempotent',
        cancellationBehavior: 'abort-on-disconnect',
        serializationConstraints: 'json-only',
        // envelopeExtra: 42  <- under E5 this would NOT be caught here;
        //                       the S2-CG walker is the defence.
      },
    });

    expect(offending.type).toBe('fixture-envelope-extra');
  });
});

describe('AgentEventManifestEntry — required-field enforcement (type-level)', () => {
  it('rejects an entry that omits a required axis', () => {
    // The @ts-expect-error directive below MUST fire — the missing-axis
    // case fails because `TEntry extends AgentEventManifestEntry<...>`
    // cannot be satisfied by a literal that omits `compactionPolicy`.
    // @ts-expect-error closed-strict: omitting `compactionPolicy` must be a TS error.
    const offending = defineAgentEvent({
      type: 'fixture-missing-axis',
        payloadSchema: z.object({ ok: z.boolean() }),

        // compactionPolicy: 'keep',   <-- intentionally omitted
        sanitization: 'identity',
        runtimeEffect: 'transient',
        uiVisibility: 'transcript',
        modelContextVisibility: 'replay-into-history',
        producerSurface: 'core',
        legacyCompatibility: { policy: 'strict-modern', notes: '' },
        unknownRuntimePolicy: 'preserve',
        telemetryPolicy: 'log-only',
        errorClassPolicy: applicabilityTag('not-applicable', 'fixture'),

        envelope: {
          requiredForNewEvents: ['turnId'],
          identityKey: 'turn-scoped',
          crossSessionRouting: 'drop-on-mismatch',
          persistence: { mainAccumulator: true, rendererStore: true, cloud: false },
          dedupeKey: 'none',
          orderingSemantics: 'per-turn-ordered',
          idempotencyAndRetry: 'idempotent',
          cancellationBehavior: 'abort-on-disconnect',
          serializationConstraints: 'json-only',
        },
      });

    expect(offending.type).toBe('fixture-missing-axis');
  });
});

// ============================================================================
//   Type-level: pre-bound variable bypass — must also be rejected
// ============================================================================

describe('AgentEventManifestEntry — pre-bound bypass attempt (NoExtraKeys)', () => {
  it('rejects extra properties on a pre-bound entry (Round 2 MUST-FIX)', () => {
    // Round 2 review (2026-04-29) found that the v1 design accepted
    // pre-bound variables with extras because TS excess-property checks
    // only fire on inline literals. The `NoExtraKeys` intersection in
    // `defineAgentEvent` closes that bypass; this test is the
    // regression canary. If `@ts-expect-error` stops firing, the
    // bypass has reopened — block the merge.
    const smuggledEntry = {
      type: 'pre-bound-attempt' as const,
      payloadSchema: z.object({ ok: z.boolean() }),

      compactionPolicy: 'keep' as const,
      sanitization: 'identity' as const,
      runtimeEffect: 'transient' as const,
      uiVisibility: 'transcript' as const,
      modelContextVisibility: 'replay-into-history' as const,
      producerSurface: 'core' as const,
      legacyCompatibility: { policy: 'strict-modern' as const, notes: '' },
      unknownRuntimePolicy: 'preserve' as const,
      telemetryPolicy: 'log-only' as const,
      errorClassPolicy: applicabilityTag('not-applicable', 'fixture'),

      envelope: {
        requiredForNewEvents: ['turnId'] as const,
        identityKey: 'turn-scoped' as const,
        crossSessionRouting: 'drop-on-mismatch' as const,
        persistence: { mainAccumulator: true, rendererStore: true, cloud: false },
        dedupeKey: 'none' as const,
        orderingSemantics: 'per-turn-ordered' as const,
        idempotencyAndRetry: 'idempotent' as const,
        cancellationBehavior: 'abort-on-disconnect' as const,
        serializationConstraints: 'json-only' as const,
      },

      // The smuggled extra — at the literal site of `smuggledEntry`,
      // TS doesn't yet flag this, because it's just a value with extra
      // structure. The flag fires when we pass it to `defineAgentEvent`
      // below, where `NoExtraKeys` requires `extra: never`.
      extra: 'smuggled' as const,
    };

    // @ts-expect-error pre-bound bypass attempt — NoExtraKeys forces `extra: never`.
    const result = defineAgentEvent(smuggledEntry);

    // Touch the result so the variable isn't dead-code-eliminated.
    expect(result.type).toBe('pre-bound-attempt');
  });
});

// ============================================================================
//   Type-level: manifest key ↔ entry.type lock
// ============================================================================

describe('defineAgentEvents — key/type lock (Round 2 MUST-FIX)', () => {
  it('rejects a manifest where the record key does not match entry.type', () => {
    // Round 2 review found that the v1 `defineAgentEvents` accepted
    // `{ tool: defineAgentEvent({ type: 'result', ... }) }` because the
    // record-key constraint was not encoded. This is a real bug class:
    // S2-C derivations iterate via `Object.entries` and would emit
    // wrong policy keys. The lock encoded in `defineAgentEvents` rejects
    // the mismatch at compile time.
    const offending = defineAgentEvents({
      // @ts-expect-error key-lock: record key 'tool' must match entry.type 'result'.
      tool: makeLegalEntry('result'),
    });

    expect(Object.keys(offending)).toEqual(['tool']);
  });

  it('accepts a manifest where keys match types', () => {
    const ok: AgentEventManifest = defineAgentEvents({
      a: makeLegalEntry('a'),
      b: makeLegalEntry('b'),
    });
    expect(Object.keys(ok)).toEqual(['a', 'b']);
  });
});

// ============================================================================
//   Runtime-level: helpers compose, manifest aggregate type round-trips
// ============================================================================

describe('defineAgentEvent / defineAgentEvents — runtime', () => {
  it('returns the entry verbatim and preserves the literal type', () => {
    const entry = makeLegalEntry('fixture');
    expect(entry.type).toBe('fixture');
    expect(entry.compactionPolicy).toBe('keep');
    expect(entry.envelope.requiredForNewEvents).toEqual(['turnId']);
  });

  it('aggregates entries into a closed-strict manifest', () => {
    const manifest = defineAgentEvents({
      a: makeLegalEntry('a'),
      b: makeLegalEntry('b'),
    });

    expect(Object.keys(manifest)).toEqual(['a', 'b']);
    expect(manifest.a.type).toBe('a');
    expect(manifest.b.type).toBe('b');
  });
});

// ============================================================================
//   Populated manifest: S2-A2 shadow data
// ============================================================================

const EXPECTED_VARIANT_KEYS = [
  'status',
  'assistant',
  'result',
  'tool',
  'error',
  'warning',
  'user_question',
  'user_question_answered',
  'assistant_delta',
  'thinking_delta',
  'context_overflow',
  'compaction_started',
  'compaction_summary_ready',
  'compaction_retrying',
  'compaction_completed',
  'compaction_failed',
  'recovery:started',
  'recovery:fallback_attempting',
  'recovery:fallback_succeeded',
  'recovery:compacting',
  'recovery:summary_ready',
  'recovery:retrying',
  'recovery:skeleton_attempting',
  'recovery:depth4_attempting',
  'recovery:succeeded',
  'recovery:failed',
  'recovery:last_resort_skipped',
  'turn_superseded',
  'user_message',
  'turn_started',
  'answer_phase_started',
] as const;

type ExpectedVariantKey = typeof EXPECTED_VARIANT_KEYS[number];

// Mirrors src/shared/utils/eventCompaction.ts:86-111. COMPACTION_POLICY is
// intentionally private there today, so this literal is the parity oracle
// until S2-C derives the production map from the manifest.
const EXPECTED_COMPACTION_POLICY = {
  result: 'keep',
  error: 'keep',
  user_message: 'keep',
  user_question: 'keep',
  user_question_answered: 'keep',
  tool: 'compact',
  assistant: 'compact',
  status: 'drop',
  warning: 'drop',
  assistant_delta: 'drop',
  thinking_delta: 'drop',
  context_overflow: 'drop',
  turn_superseded: 'drop',
  compaction_started: 'drop',
  compaction_summary_ready: 'drop',
  compaction_retrying: 'drop',
  compaction_completed: 'drop',
  compaction_failed: 'drop',
  'recovery:started': 'keep',
  'recovery:fallback_attempting': 'drop',
  'recovery:fallback_succeeded': 'drop',
  'recovery:compacting': 'drop',
  'recovery:summary_ready': 'drop',
  'recovery:retrying': 'drop',
  'recovery:skeleton_attempting': 'drop',
  'recovery:depth4_attempting': 'drop',
  'recovery:succeeded': 'keep',
  'recovery:failed': 'keep',
  'recovery:last_resort_skipped': 'keep',
  turn_started: 'drop',
  answer_phase_started: 'drop',
} satisfies Record<ExpectedVariantKey, 'keep' | 'compact' | 'drop'>;

const manifestPolicyAxesFor = (key: ExpectedVariantKey) => {
  const { payloadSchema: _payloadSchema, ...policyAxes } = agentEventManifest[key];
  return policyAxes;
};

describe('agentEventManifest — populated S2-A2 data', () => {
  it('has exactly the 31 expected variant keys in AgentEventSchema order', () => {
    expect(Object.keys(agentEventManifest)).toEqual(EXPECTED_VARIANT_KEYS);
  });

  it('locks every manifest record key to entry.type', () => {
    for (const key of EXPECTED_VARIANT_KEYS) {
      expect(agentEventManifest[key].type).toBe(key);
    }
  });

  it('preserves tool.mcpAppUiMeta.sourcePackageId through payloadSchema parsing', () => {
    const parsed = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'example_mcp_tool',
      toolUseId: 'tool-use-1',
      parentToolUseId: null,
      detail: 'Rendered an MCP app view',
      stage: 'end',
      timestamp: 123,
      seq: 7,
      imageContent: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }],
      mcpAppUiMeta: {
        resourceUri: 'ui://example/view',
        sourcePackageId: 'pkg-alpha',
        protocolUrl: 'mcp://example/view',
        originalFilePath: '/tmp/example-view.html',
        visibility: ['model', 'app'],
        csp: {
          connectDomains: ['https://api.example.com'],
          resourceDomains: ['https://cdn.example.com'],
          frameDomains: ['https://frame.example.com'],
        },
        permissions: {
          camera: true,
          microphone: false,
          geolocation: true,
          clipboardWrite: false,
        },
      },
    });

    expect(parsed.mcpAppUiMeta?.sourcePackageId).toBe('pkg-alpha');
    expect(parsed.mcpAppUiMeta?.protocolUrl).toBe('mcp://example/view');
    expect(parsed.mcpAppUiMeta?.permissions?.clipboardWrite).toBe(false);
  });

  it('accepts null tool.mcpAppUiMeta.sourcePackageId through payloadSchema parsing', () => {
    const parsed = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'example_mcp_tool',
      detail: 'Rendered an MCP app view',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://example/view',
        sourcePackageId: null,
      },
    });

    expect(parsed.mcpAppUiMeta?.sourcePackageId).toBeNull();
  });

  it('accepts additive tool.imageRef combinations (imageRef-only, both, or neither)', () => {
    const withImageRef = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'capture',
      detail: 'Rendered a screenshot',
      stage: 'end',
      timestamp: 123,
      imageRef: [{
        assetId: 'turn-1-0-0',
        mimeType: 'image/png',
        byteSize: 2048,
      }],
      toolResult: {
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUg==',
          },
          imageRef: {
            assetId: 'turn-1-0-0',
            mimeType: 'image/png',
            byteSize: 2048,
          },
        }],
      },
    });

    expect(withImageRef.imageRef?.[0]?.assetId).toBe('turn-1-0-0');

    const withBoth = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'capture',
      detail: 'Rendered a screenshot',
      stage: 'end',
      timestamp: 124,
      imageContent: [{ type: 'image', data: 'legacy-base64', mimeType: 'image/png' }],
      imageRef: [{
        assetId: 'turn-1-0-1',
        mimeType: 'image/png',
        byteSize: 4096,
      }],
    });

    expect(withBoth.imageContent).toHaveLength(1);
    expect(withBoth.imageRef).toHaveLength(1);

    const withNeither = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'capture',
      detail: 'No image payload',
      stage: 'end',
      timestamp: 125,
    });

    expect(withNeither.imageContent).toBeUndefined();
    expect(withNeither.imageRef).toBeUndefined();
  });

  it('preserves A3a mcpAppUiMeta fields through payloadSchema parsing', () => {
    const parsed = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'compose_workspace_email',
      toolUseId: 'tool-use-a3a',
      parentToolUseId: null,
      detail: 'Rendered an editable email draft',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: '  Email draft to person@example.com — subject "Hello".  ',
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: {
            to: ['person@example.com'],
            cc: [],
            bcc: [],
            subject: 'Hello',
            body: 'Draft body.',
          },
        },
      },
    });

    expect(parsed.mcpAppUiMeta?.presentation).toBe('primary');
    expect(parsed.mcpAppUiMeta?.viewSummary).toBe('Email draft to person@example.com — subject "Hello".');
    expect(parsed.mcpAppUiMeta?.viewRoleLabel).toBe('Editable email draft');
    expect(parsed.mcpAppUiMeta?.structuredFallback).toEqual({
      kind: 'email-draft',
      payload: {
        to: ['person@example.com'],
        cc: [],
        bcc: [],
        subject: 'Hello',
        body: 'Draft body.',
      },
    });
  });

  it('rejects primary mcpAppUiMeta without viewSummary with a structured field path', () => {
    const parsed = agentEventManifest.tool.payloadSchema.safeParse({
      toolName: 'compose_workspace_email',
      toolUseId: 'tool-use-a3a-invalid',
      detail: 'Rendered an editable email draft',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['mcpAppUiMeta', 'viewSummary'] }),
        ]),
      );
    }
  });

  it('truncates viewSummary above display cap but below hard schema ceiling', () => {
    const parsed = agentEventManifest.tool.payloadSchema.parse({
      toolName: 'compose_workspace_email',
      detail: 'Rendered an editable email draft',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'x'.repeat(281),
      },
    });

    expect(parsed.mcpAppUiMeta?.viewSummary).toBe('x'.repeat(280));
  });

  it('rejects viewSummary above the hard schema ceiling', () => {
    const parsed = agentEventManifest.tool.payloadSchema.safeParse({
      toolName: 'compose_workspace_email',
      detail: 'Rendered an editable email draft',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'x'.repeat(501),
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['mcpAppUiMeta', 'viewSummary'] }),
        ]),
      );
    }
  });

  it('rejects ANSI-bearing viewSummary as non-plaintext', () => {
    const parsed = agentEventManifest.tool.payloadSchema.safeParse({
      toolName: 'compose_workspace_email',
      detail: 'Rendered an editable email draft',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: '\x1b[31mhello',
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['mcpAppUiMeta', 'viewSummary'],
            message: 'viewSummary must be plaintext without ANSI escape sequences',
          }),
        ]),
      );
    }
  });

  it('type-rejects invalid structuredFallback email-draft payloads', () => {
    type ToolEventFromManifest = Extract<AgentEventFromManifest, { type: 'tool' }>;
    const valid: ToolEventFromManifest = {
      type: 'tool',
      toolName: 'compose_workspace_email',
      toolUseId: 'tool-use-valid',
      detail: 'Valid structured fallback',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Hello".',
        structuredFallback: {
          kind: 'email-draft',
          payload: {
            to: ['person@example.com'],
            subject: 'Hello',
            body: 'Draft body.',
          },
        },
      },
    };

    const invalidMissingTo: ToolEventFromManifest = {
      type: 'tool',
      toolName: 'compose_workspace_email',
      detail: 'Invalid structured fallback',
      stage: 'end',
      timestamp: 123,
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to someone — subject "Hello".',
        structuredFallback: {
          kind: 'email-draft',
          // @ts-expect-error A3a closed-strict invariant: email-draft payload requires `to`.
          payload: {
            subject: 'Hello',
            body: 'Draft body.',
          },
        },
      },
    };

    expect(valid.mcpAppUiMeta?.structuredFallback?.kind).toBe('email-draft');
    expect(invalidMissingTo.type).toBe('tool');
  });

  it('preserves tool._origin (real / synthetic-plan-seed / pre-turn-context) through payloadSchema parsing', () => {
    // `_origin` is on the canonical TS type at `src/shared/types/agent.ts:646-651`
    // and is preserved through compaction at `src/shared/utils/eventCompaction.ts:157-160`.
    // Phase-5 review (2026-04-29, reviewer-gpt5.5-high) flagged that the original
    // S2-A2 draft omitted `_origin` from `tool.payloadSchema`, which would have
    // silently stripped provenance via `payloadSchema.parse` after Stage 3 cutover.
    for (const origin of ['real', 'synthetic-plan-seed', 'pre-turn-context'] as const) {
      const parsed = agentEventManifest.tool.payloadSchema.parse({
        toolName: 'Task',
        toolUseId: `tool-use-${origin}`,
        parentToolUseId: null,
        detail: '{"subagent_type":"worker"}',
        stage: 'start',
        timestamp: 456,
        _origin: origin,
      });
      expect(parsed._origin).toBe(origin);
    }
  });

  it('uses real errorClassPolicy values only for result/error and ApplicabilityTag elsewhere', () => {
    for (const key of EXPECTED_VARIANT_KEYS) {
      const policy = agentEventManifest[key].errorClassPolicy;
      if (key === 'result' || key === 'error') {
        expect(isApplicabilityTag(policy)).toBe(false);
        expect(policy).toBe('unknown');
      } else {
        expect(isApplicabilityTag(policy)).toBe(true);
        if (isApplicabilityTag(policy)) {
          expect(policy.rationale).toContain(`${key} events do not carry rate-limit/billing semantics`);
        }
      }
    }
  });

  it('matches the current production COMPACTION_POLICY map for all 31 variants', () => {
    const actual = Object.fromEntries(
      EXPECTED_VARIANT_KEYS.map((key) => [key, agentEventManifest[key].compactionPolicy]),
    );

    expect(actual).toEqual(EXPECTED_COMPACTION_POLICY);
  });
});

describe('agentEventPolicyManifest — Zod-free mirror of manifest axes', () => {
  it('has exactly the same 31 variant keys as the Zod-bearing manifest', () => {
    expect(Object.keys(agentEventPolicyManifest)).toEqual(EXPECTED_VARIANT_KEYS);
  });

  it('has matching key/type locks', () => {
    for (const key of EXPECTED_VARIANT_KEYS) {
      expect(agentEventPolicyManifest[key].type).toBe(key);
    }
  });

  it('matches every non-payload axis from agentEventManifest', () => {
    for (const key of EXPECTED_VARIANT_KEYS) {
      expect(agentEventPolicyManifest[key]).toEqual(manifestPolicyAxesFor(key));
    }
  });
});

// ============================================================================
//   S2-C derivations: structural projections + builder enforcement
// ============================================================================

import {
  AgentEventSchemaFromManifest,
  COMPACTION_POLICY_FROM_MANIFEST,
  SANITIZATION_POLICY_FROM_MANIFEST,
  buildAgentEvent,
  discriminatedUnionFromManifest,
  policyFor,
} from '../agentEventManifest';
import { AgentEventSchema } from '../../ipc/schemas/agent';
import {
  COMPACTION_POLICY_FROM_POLICY_MANIFEST,
  SANITIZATION_POLICY_FROM_POLICY_MANIFEST,
} from '../agentEventPolicyManifest';

describe('S2-C: COMPACTION_POLICY_FROM_MANIFEST — derived projection', () => {
  it('matches the production COMPACTION_POLICY parity oracle', () => {
    expect(COMPACTION_POLICY_FROM_MANIFEST).toEqual(EXPECTED_COMPACTION_POLICY);
  });

  it('is mirrored by the Zod-free policy-manifest projection', () => {
    expect(COMPACTION_POLICY_FROM_POLICY_MANIFEST).toEqual(
      COMPACTION_POLICY_FROM_MANIFEST,
    );
  });
});

describe('S2-C: SANITIZATION_POLICY_FROM_MANIFEST — derived projection', () => {
  it('has all 31 variant keys', () => {
    expect(Object.keys(SANITIZATION_POLICY_FROM_MANIFEST)).toEqual(
      EXPECTED_VARIANT_KEYS,
    );
  });

  it('is mirrored by the Zod-free policy-manifest projection', () => {
    expect(SANITIZATION_POLICY_FROM_POLICY_MANIFEST).toEqual(
      SANITIZATION_POLICY_FROM_MANIFEST,
    );
  });

  it('derives sanitization values from `entry.sanitization` (not `entry.unknownRuntimePolicy`) — Phase-6 correction in projection.md', () => {
    // Per `tmp/agent-tests/r2_stage1_spike/manifest.projection.md`
    // Phase-6 correction: SANITIZATION_POLICY MUST derive from
    // `entry.sanitization`, NOT `entry.unknownRuntimePolicy`. Asserting
    // the actual values in the manifest catches any future re-routing.
    // The `tool` variant is the only one with a non-`pass-through`
    // strategy; all 18 others use `pass-through`.
    expect(SANITIZATION_POLICY_FROM_MANIFEST.tool).toBe(
      'truncate-tool-detail-with-subagent-identity',
    );
    for (const key of EXPECTED_VARIANT_KEYS) {
      if (key !== 'tool') {
        expect(SANITIZATION_POLICY_FROM_MANIFEST[key]).toBe('pass-through');
      }
    }
  });
});

describe('S2-C: policyFor — manifest lookup helper', () => {
  it('returns the full per-variant entry for a known type', () => {
    const entry = policyFor('tool');
    expect(entry.type).toBe('tool');
    expect(entry.compactionPolicy).toBe('compact');
    expect(entry.envelope.requiredForNewEvents).toContain('turnId');
  });
});

describe('S2-C: AgentEventSchemaFromManifest — derived Zod schema', () => {
  it('parses a valid `tool` event round-trip', () => {
    const parsed = AgentEventSchemaFromManifest.parse({
      type: 'tool',
      toolName: 'example_tool',
      toolUseId: 'tool-use-7',
      parentToolUseId: null,
      detail: 'parsed via schema',
      stage: 'end',
      timestamp: 1700000000000,
      seq: 3,
    });
    expect(parsed.type).toBe('tool');
  });

  it('parses a valid `error` event round-trip with errorKind', () => {
    const parsed = AgentEventSchemaFromManifest.parse({
      type: 'error',
      error: 'Test error',
      errorKind: 'unknown',
      timestamp: 1700000000000,
    });
    expect(parsed.type).toBe('error');
  });

  it('round-trips billingMeta.managedSubscription.resetsAt through manifest and IPC schemas', () => {
    const rawEvent = {
      type: 'error' as const,
      error: 'Managed allowance exhausted',
      errorKind: 'billing' as const,
      billingMeta: {
        subtype: 'credits' as const,
        managedSubscription: {
          tier: 'dash',
          resetsAt: '2026-06-01T00:00:00.000Z',
        },
      },
      timestamp: 1700000000000,
    };

    const manifestParsed = AgentEventSchemaFromManifest.parse(rawEvent);
    const ipcParsed = AgentEventSchema.parse(manifestParsed);

    expect(ipcParsed.type).toBe('error');
    if (ipcParsed.type === 'error') {
      expect(ipcParsed.billingMeta?.managedSubscription?.resetsAt).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    }
  });

  it('rejects an unknown discriminator value', () => {
    expect(() =>
      AgentEventSchemaFromManifest.parse({
        type: 'unknown_event_type_not_in_manifest',
        timestamp: 1700000000000,
      }),
    ).toThrow();
  });
});

describe('S2-C: parity gate — manifest variant set vs hand-authored AgentEventSchema', () => {
  // **Phase-6 review (gemini3.1-pro P0.2)** — without `IsExactStrict<>` in
  // production, type-only drift between hand-authored `AgentEvent` and
  // `AgentEventFromManifest` could slip past S2-D's runtime fixture
  // corpus (a property going from `optional?: string` to `string`, a
  // union arity change, etc.).
  //
  // **Why no compile-time `IsExactStrict<>` here**: Failure Mode A REJECTED
  // (parent-doc Amendment log). `IsExactStrict<>` forces bidirectional
  // materialisation of `InferEventUnion` and `AgentEvent`, the exact
  // structural cost E5 corrects. Even in test files, a heavy
  // bidirectional check pays the same per-compile penalty.
  //
  // **What this gate covers**: variant-set equality (the most common
  // and impactful drift vector — adding or removing a variant). For
  // structural drift WITHIN a variant (optional vs required, union
  // arity), S2-D parity corpus is the line of defence; once Stage 3
  // migrates consumers to `AgentEventFromManifest`, structural drift
  // becomes impossible because the hand-authored type is gone.

  it('manifest variant set matches hand-authored AgentEventSchema discriminator set', () => {
    // Hand-authored `AgentEventSchema` is `discriminatedUnion ∩ {seq?:
    // number}` (see `src/shared/ipc/schemas/agent.ts`). Walk into
    // `def.left.def.options` to enumerate the 30 variants, extracting
    // `def.shape.type.def.values[0]` for each variant's discriminator.
    //
    // Comparison: this set must match `EXPECTED_VARIANT_KEYS` (the
    // manifest's exposed key set). If they diverge — a new variant
    // added to the manifest but not the hand-authored schema, or
    // vice-versa — the parity gate fires immediately.
    type ZodNode = {
      def: {
        type: string;
        left?: ZodNode;
        right?: ZodNode;
        options?: ZodNode[];
        shape?: Record<string, ZodNode>;
        values?: string[];
      };
    };
    const root = AgentEventSchema as unknown as ZodNode;
    expect(root.def.type).toBe('intersection');
    const union = root.def.left;
    expect(union?.def.type).toBe('union');

    const handAuthoredVariants = new Set<string>();
    for (const option of union?.def.options ?? []) {
      const literal = option.def.shape?.type?.def.values?.[0];
      if (typeof literal === 'string') {
        handAuthoredVariants.add(literal);
      }
    }

    const manifestVariants = new Set(EXPECTED_VARIANT_KEYS as readonly string[]);

    expect(handAuthoredVariants.size).toBe(manifestVariants.size);
    for (const variant of manifestVariants) {
      expect(handAuthoredVariants.has(variant)).toBe(true);
    }
    for (const variant of handAuthoredVariants) {
      expect(manifestVariants.has(variant)).toBe(true);
    }
  });
});

describe('S2-C: discriminatedUnionFromManifest — bounds + correctness', () => {
  it('throws when called with fewer than 2 variants', () => {
    // Phase-6 (gemini3.1-pro): the `<2 variants` branch was previously
    // untested. `z.discriminatedUnion` requires a `[V, V, ...V[]]` tuple.
    expect(() =>
      discriminatedUnionFromManifest({
        only: makeLegalEntry('only'),
      } as unknown as Parameters<typeof discriminatedUnionFromManifest>[0]),
    ).toThrow(/requires ≥ 2 variants/);
  });
});

describe('S2-C: buildAgentEvent — envelope-required-fields enforcement', () => {
  it('builds a `tool` event with all required envelope fields at runtime', () => {
    const event = buildAgentEvent.tool(
      {
        toolName: 'example_tool',
        toolUseId: 'tool-use-1',
        parentToolUseId: null,
        detail: 'via builder',
        stage: 'start',
        timestamp: 1700000000000,
      },
      { sessionId: 'session-xyz', turnId: 'turn-abc', toolUseId: 'tool-use-1' },
    );

    expect(event.type).toBe('tool');
    expect(event.turnId).toBe('turn-abc');
    expect(event.sessionId).toBe('session-xyz');
  });

  it('throws at runtime when a required envelope field is missing (defence-in-depth)', () => {
    expect(() =>
      buildAgentEvent.tool(
        {
          toolName: 'example_tool',
          toolUseId: 'tool-use-2',
          parentToolUseId: null,
          detail: 'via builder',
          stage: 'start',
          timestamp: 1700000000000,
        },
        // Force a non-TS path: cast through unknown to bypass the compile-time
        // guard. The runtime check still rejects with a clear envelope-field error.
        {} as unknown as { sessionId: string; turnId: string; toolUseId: string },
      ),
    ).toThrow(/buildAgentEvent\.tool requires envelope\./);
  });

  it('rejects a tool event missing required envelope fields at compile time', () => {
    // Pairs the runtime defence above with the compile-time guarantee:
    // the `tool` entry's `envelope.requiredForNewEvents` is
    // `['sessionId', 'turnId', 'toolUseId']`; omitting any of them
    // must trigger TS-2345 at the builder call. If this directive
    // stops firing, the load-bearing envelope-required-fields
    // enforcement has been weakened — block the merge.
    expect(() => {
      buildAgentEvent.tool(
        {
          toolName: 'example_tool',
          toolUseId: 'tool-use-3',
          parentToolUseId: null,
          detail: 'via builder',
          stage: 'start',
          timestamp: 1700000000000,
        },
        // @ts-expect-error envelope fields required by `tool` entry's `envelope.requiredForNewEvents`
        {},
      );
    }).toThrow(); // runtime defence-in-depth still throws
  });
});

// ============================================================================
//   AgentErrorResolutionSchema — alternatives cap (cognitive-load guard)
//
//   FOX-3267 Stage 2 reviewer (C1): the SessionErrorNotice surface
//   shows at most one default action plus a small set of alternatives.
//   Per chief-designer scope tightening, alternatives are capped at 2
//   to keep the notice scannable. This invariant must be enforced at
//   the schema layer so renderer and producer agree by construction.
// ============================================================================

// FOX-3494 (round-2 S2): pin the switch-model `failedRole` payload field so the
// producer (classifyErrorUx), the IPC contract, and the manifest stay in lockstep.
// It carries the route role whose model the switch-model action must repair, so
// the claude-under-codex recovery doesn't loop back into the same planning slot.
describe('AgentErrorResolutionActionSchema — switch-model failedRole payload', () => {
  it('accepts a switch-model action carrying failedRole', () => {
    for (const failedRole of ['execution', 'planning', 'bts', 'subagent'] as const) {
      const parsed = AgentErrorResolutionActionSchema.safeParse({
        label: 'Switch to GPT-5.5',
        action: 'switch-model',
        payload: { model: 'gpt-5.5', failedRole },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.payload?.failedRole).toBe(failedRole);
      }
    }
  });

  it('accepts a switch-model action without failedRole (legacy / generic switch)', () => {
    const parsed = AgentErrorResolutionActionSchema.safeParse({
      label: 'Use GPT-5.5',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown failedRole value', () => {
    const parsed = AgentErrorResolutionActionSchema.safeParse({
      label: 'Switch',
      action: 'switch-model',
      payload: { model: 'gpt-5.5', failedRole: 'orchestrator' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('AgentErrorResolutionSchema — alternatives cap', () => {
  const makeAction = (label: string) => ({
    label,
    action: 'switch-model' as const,
    payload: { model: 'gpt-5.5' },
  });

  it('accepts a resolution with zero alternatives', () => {
    const parsed = AgentErrorResolutionSchema.safeParse({
      category: 'unsupported-feature',
      kind: 'unsupported_model',
      title: 'Model not available',
      body: 'Switch model or change provider.',
      alternatives: [],
      persistent: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a resolution with two alternatives', () => {
    const parsed = AgentErrorResolutionSchema.safeParse({
      category: 'unsupported-feature',
      kind: 'unsupported_model',
      title: 'Model not available',
      body: 'Switch model or change provider.',
      alternatives: [makeAction('Switch to GPT-5.2'), makeAction('Switch to GPT-5.1')],
      persistent: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a resolution with three or more alternatives', () => {
    const parsed = AgentErrorResolutionSchema.safeParse({
      category: 'unsupported-feature',
      kind: 'unsupported_model',
      title: 'Model not available',
      body: 'Switch model or change provider.',
      alternatives: [
        makeAction('Switch to GPT-5.2'),
        makeAction('Switch to GPT-5.1'),
        makeAction('Switch to GPT-5.0'),
      ],
      persistent: true,
    });
    expect(parsed.success).toBe(false);
  });
});
