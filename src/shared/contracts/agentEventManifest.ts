/**
 * # Agent event manifest — type contract
 *
 * Single source of truth for **every** axis a producer must declare
 * when adding a new agent-event variant. The manifest is the structural
 * defence against the parallel-declaration drift captured in the parent
 * plan (`docs/plans/260427_refactor_contract_manifest.md`): events
 * whose compaction policy, sanitization strategy, persistence flags,
 * identity key, etc. live in five different files and disagree about
 * the same variant.
 *
 * **S2-C status (2026-04-29):** this file ships the 19 populated AgentEvent
 * variants AND the 6 manifest-derived surfaces — `AgentEventFromManifest`
 * (`InferEventUnion<typeof agentEventManifest>`), `AgentEventSchemaFromManifest`,
 * `COMPACTION_POLICY_FROM_MANIFEST`, `SANITIZATION_POLICY_FROM_MANIFEST`,
 * `policyFor`, `buildAgentEvent`. Hand-authored `AgentEvent` in
 * `src/shared/types/agent.ts` remains for Stage 2 shadow-derive; Stage 3
 * cutover migrates consumers to `AgentEventFromManifest`.
 *
 * **Closed-strict invariant**: the manifest accepts no `extra` escape
 * hatch. Every variant declares every axis; adding a new axis triggers
 * a compile error in every variant that has not declared it. Closed-
 * strict is enforced **both at the literal site and against pre-bound
 * variables** via the `NoExtraKeys` pattern in `defineAgentEvent` /
 * `defineAgentEvents` (see § 1).
 *
 * **Sibling**: `agentEventPolicyManifest.ts` exposes the same axes
 * **without** Zod, so cloud-client / mobile bundles do not pay the Zod
 * tax for read-only policy lookups. Axis types are factored into
 * `agentEventManifestAxes.ts` (Zod-free) so both manifests stay in
 * lockstep with no Zod-bearing transitive type imports.
 *
 * ## 1) Closed-strict enforcement
 *
 * TypeScript is structurally typed. A naive `defineAgentEvent(entry: T)`
 * helper relies on the literal-site "object literal may only specify
 * known properties" check (TS-2353), which protects inline literals but
 * **not** pre-bound variables:
 *
 *   ```ts
 *   const smuggled = { ...legalFields, extra: 'bad' };  //  type widens
 *   defineAgentEvent(smuggled);                         //  silently OK
 *   ```
 *
 * To close that bypass we use the `NoExtraKeys<T, Base>` pattern: an
 * intersection of `T` with `{ [K in Exclude<keyof T, keyof Base>]: never }`.
 * On a clean entry, `Exclude<>` is `never` and the intersection is a
 * no-op; on a smuggled entry, the extra keys are constrained to `never`,
 * which the smuggled value cannot satisfy. The result is a TS error
 * regardless of whether the entry is literal or pre-bound.
 *
 * The Vitest type-test in `__tests__/agentEventManifest.test.ts`
 * documents both the literal and pre-bound negative paths
 * (`@ts-expect-error` directives) so that a future agent who weakens
 * the helper signatures gets a hard compile failure.
 *
 * ## 2) Per-variant axis applicability
 *
 * Some axes only apply to a subset of variants — for example
 * `errorClassPolicy` only makes sense for `error` and `result`. Rather
 * than make that axis optional (which would defeat closed-strict), the
 * axis type is a union with `ApplicabilityTag`: variants that don't use
 * the axis declare `applicabilityTag('not-applicable', '<rationale>')`.
 * Reviewers can grep for `'not-applicable'` to audit the set of
 * opt-outs. See `applicabilityTag.ts` for the tagged-object shape.
 *
 * ## 3) Manifest key ↔ entry.type lock
 *
 * `defineAgentEvents` constrains its argument so the **record key**
 * matches the entry's `type` discriminator. This prevents a bug class
 * where `{ tool: defineAgentEvent({ type: 'result', ... }) }` would
 * compile but produce wrong projections in S2-C derivations
 * (`Object.entries` iterates over keys, not `entry.type`). See § 1
 * in `defineAgentEvents` below for the type-level encoding.
 *
 * ## 4) Projection contract (verbatim port of Stage 1.2 spike contract)
 *
 * The manifest is **structurally one-way**: every other surface is
 * computed from it. Manual edits to a derived surface are overwritten by
 * the next regeneration. Six derivations exist; this section is a
 * verbatim port of `tmp/agent-tests/r2_stage1_spike/manifest.projection.md`
 * with the 2026-04-28 sanitization correction explicit.
 *
 * Single source of truth: `agentEventManifest`.
 *
 * ### 4.1) `AgentEvent` type
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   inferEventUnion(m) =
 *     union over entry in values(m) of { type: entry.type } & infer(entry.payloadSchema)
 *   ```
 *
 * - **Why structurally one-way:** manual edits to a handwritten
 *   `AgentEvent` type are overwritten by recomputing from manifest
 *   entries; adding/removing an entry changes the projected union.
 *
 * ### 4.2) `AgentEventSchema` (Zod discriminated union)
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   schemaFromManifest(m) =
 *     z.discriminatedUnion(
 *       'type',
 *       values(m).map((entry) => entry.payloadSchema.extend({ type: z.literal(entry.type) }))
 *     )
 *   ```
 *
 * - **Why structurally one-way:** hand-editing one schema branch cannot
 *   survive a manifest change, because branches are reconstructed from
 *   every manifest entry and its payload schema.
 *
 * ### 4.3) `COMPACTION_POLICY`
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   compactionPolicyFromManifest(m) =
 *     Object.fromEntries(Object.entries(m).map(([type, entry]) => [type, entry.compactionPolicy]))
 *   ```
 *
 * - **Why structurally one-way:** policy map keys/value pairs are
 *   generated from manifest keys and `entry.compactionPolicy`; direct
 *   edits drift immediately on next derivation.
 *
 * ### 4.4) `SANITIZATION_POLICY`
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   sanitizationPolicyFromManifest(m) =
 *     Object.fromEntries(Object.entries(m).map(([type, entry]) => [type, entry.sanitization]))
 *   ```
 *
 *   *(Corrected 2026-04-28 Phase 6: original draft incorrectly used
 *   `entry.unknownRuntimePolicy` — that is the `unknownRuntimePolicy`
 *   axis, a separate concept governing what to do with unknown
 *   persisted variants. `SANITIZATION_POLICY` derives from the
 *   `sanitization` axis, which names a strategy from the
 *   `eventSanitization` registry.)*
 *
 * - **Why structurally one-way:** sanitization policy is computed from
 *   per-entry metadata; manual overrides are non-authoritative and do
 *   not persist through regeneration.
 *
 * ### 4.5) `policyFor(type)`
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   policyFor(type, m) = m[type]
 *   ```
 *
 * - **Why structurally one-way:** lookup is indexed directly into
 *   canonical entries; there is no separate mutable policy registry to
 *   hand-maintain.
 *
 * ### 4.6) `buildAgentEvent.<type>`
 *
 * - **Source:** `agentEventManifest`
 * - **Projection function (pseudocode):**
 *
 *   ```ts
 *   buildAgentEvent = Object.fromEntries(
 *     Object.entries(m).map(([type, entry]) => [
 *       type,
 *       (payload, envelope) => ({
 *         type,
 *         ...entry.payloadSchema.parse(payload),
 *         ...validateEnvelope(entry.envelope, envelope)
 *       })
 *     ])
 *   )
 *   ```
 *
 * - **Why structurally one-way:** constructors are generated from the
 *   same typed manifest rows that define payload and envelope
 *   requirements; editing one builder manually cannot remain correct
 *   once manifest metadata changes.
 *
 * ## 5) Axes — 19 total (10 payload + 9 envelope)
 *
 * See parent plan § "Manifest axes (locked, 2026-04-28 — Stage 1.5)"
 * for the locked axis list and per-axis postmortem evidence. Axis
 * types live in `./agentEventManifestAxes.ts` (Zod-free); widening the
 * set of values for any axis is itself a manifest-version bump and
 * requires a parent-doc amendment.
 *
 * @see docs/plans/260427_refactor_contract_manifest.md
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md
 * @see ./agentEventManifestAxes.ts (the axes — Zod-free)
 * @see ./agentEventPolicyManifest.ts (Zod-free policy sibling)
 * @see ./applicabilityTag.ts (per-variant applicability tag)
 */

import { z } from 'zod';
import type {
  CancellationBehavior,
  CompactionPolicy,
  CrossSessionRouting,
  DedupeKey,
  EnvelopeRequiredField,
  ErrorClassPolicy,
  IdempotencyAndRetry,
  IdentityKey,
  LegacyCompatibility,
  ModelContextVisibility,
  OrderingSemantics,
  PersistenceFlags,
  ProducerSurface,
  RuntimeEffect,
  SanitizationStrategy,
  SerializationConstraints,
  TelemetryPolicy,
  UiVisibility,
  UnknownRuntimePolicy,
} from './agentEventManifestAxes';
import { AGENT_ERROR_KINDS } from '../utils/agentErrorCatalog';
import { OUTPUT_SHAPE_BUCKETS } from '../utils/outputShapeMetrics';
import { UserQuestionAnswerSchema, UserQuestionSchema } from '../types/userQuestion';
import { FulfillmentProviderSchema } from '../types/providerMetadata';
import { PROVIDER_CREDENTIAL_SOURCES } from '../types/providerRoute';
import { ThinkingEffortSchema } from '../ipc/schemas/common';
import { agentEventPolicyManifest } from './agentEventPolicyManifest';

// ----------------------------------------------------------------------------
//   The closed-strict manifest entry type
// ----------------------------------------------------------------------------

/**
 * **All 19 axes**, declared on every variant.
 *
 * Closed-strict: any extra property triggers a TS error at the
 * `defineAgentEvent` call site via the `NoExtraKeys` pattern (see
 * helpers below). Reviewers can rely on the compile error rather than
 * maintaining a separate "no-extra-fields" lint rule.
 *
 * @typeParam TType    - the discriminator literal (e.g., `'tool'`).
 * @typeParam TPayload - the Zod payload schema raw shape.
 */
export type AgentEventManifestEntry<
  TType extends string,
  TPayload extends z.ZodRawShape,
> = Readonly<{
  // Identity
  type: TType;
  payloadSchema: z.ZodObject<TPayload>;

  // Payload axes (10) — see parent plan § 296-330 and ./agentEventManifestAxes.ts
  compactionPolicy: CompactionPolicy;
  sanitization: SanitizationStrategy;
  runtimeEffect: RuntimeEffect;
  uiVisibility: UiVisibility;
  modelContextVisibility: ModelContextVisibility;
  producerSurface: ProducerSurface;
  legacyCompatibility: LegacyCompatibility;
  unknownRuntimePolicy: UnknownRuntimePolicy;
  telemetryPolicy: TelemetryPolicy;
  errorClassPolicy: ErrorClassPolicy;

  // Envelope axes (9)
  envelope: Readonly<{
    requiredForNewEvents: readonly EnvelopeRequiredField[];
    identityKey: IdentityKey;
    crossSessionRouting: CrossSessionRouting;
    persistence: PersistenceFlags;
    dedupeKey: DedupeKey;
    orderingSemantics: OrderingSemantics;
    idempotencyAndRetry: IdempotencyAndRetry;
    cancellationBehavior: CancellationBehavior;
    serializationConstraints: SerializationConstraints;
  }>;
}>;

/**
 * The manifest is a string-keyed record of entries, **with the record
 * key locked to the entry's `type` discriminator** (see § 3 above).
 * `defineAgentEvents` enforces the lock at the type level.
 */
export type AgentEventManifest = Readonly<
  Record<string, AgentEventManifestEntry<string, z.ZodRawShape>>
>;

// ----------------------------------------------------------------------------
//   Helpers: literal-narrowing factories that enforce closed-strict
// ----------------------------------------------------------------------------

/**
 * `NoExtraKeys<T, Base>`: a top-level structural-typing trick that
 * forces TS to reject any extra property at the **outermost** level
 * of `T` not present in `Base`.
 *
 * Implementation: a mapped type that walks every key of `T` at the
 * top level only —
 *   - keys not present in `Base` get `never` (excess property error);
 *   - keys present in `Base` pass through unchanged.
 *
 * On a clean entry, the mapped type is a structural no-op. On a
 * smuggled entry whose extra key sits at the top level of the entry
 * value (e.g. `{ ...legalAxes, extra: 'bad' }`), the offending key
 * collapses to `never` and the call fails to type-check.
 *
 * **Scope decision (E5, 2026-04-29)**: this type was previously a
 * recursive `NoExtraKeysDeep` that walked nested objects too. The
 * recursion exploded TS Type/Instantiation counts on the closed-strict
 * 19×19 manifest by ~+400% and triggered the S2-E re-probe failure.
 * Scoping to top-level keys cuts the cost to a single mapped type per
 * entry while preserving the load-bearing defence against pre-bound
 * top-level "extras bag" smuggling (the historical attack the manifest
 * exists to prevent — see file header § 1).
 *
 * **Lost coverage** (Phase-6 review, 2026-04-29 — be honest about scope):
 * because `defineAgentEvent` infers a generic `TEntry` parameter and
 * `NoExtraKeys` only checks top-level keys, **all nested-object extras
 * are routed to S2-CG**, regardless of whether the nested object is an
 * inline literal or a pre-bound variable. The `TEntry` widening
 * absorbs nested extras into the inferred type before `NoExtraKeys`
 * can compare top-level keys, so even an inline `envelope: { ...legal,
 * envelopeExtra: 42 }` slips through the helper. The S2-CG
 * manifest-guard CI walker (chunk S2-CG) detects nested smuggle by
 * walking `envelope:` AST positions for both:
 *   (a) literal nested objects with unknown keys, AND
 *   (b) `<Identifier>` and `...spread` references whose declarations
 *       contain unknown keys (spread-aware, per Phase-6 finding —
 *       `envelope: { ...baseEnvelope }` bypasses TS-2353 even on
 *       inline literals because TS does not excess-check spread keys).
 *
 * The combined defence is:
 *   - **Top-level closed-strict**: `NoExtraKeys` rejects pre-bound
 *     top-level "extras bag" (the historical attack vector — see file
 *     header § 1).
 *   - **Required-axis enforcement**: `TEntry extends AgentEventManifestEntry<...>`
 *     rejects entries that omit any of the 19 axes.
 *   - **Nested-key enforcement (lint-time)**: S2-CG AST walker rejects
 *     unknown nested keys in `envelope:` and other nested-axis positions,
 *     spread-aware.
 *
 * Result: structurally equivalent to the original deep recursion at
 * the prototype's program-level claim, at materially lower compile
 * cost (+4-5% Total time vs +36-46% for the recursive variant).
 *
 * @see docs/plans/260427_refactor_contract_manifest.md § Failure Mode A correction
 * @see scripts/check-manifest-guard.ts (S2-CG, lands later in Stage 2)
 */
export type NoExtraKeys<T, Base> = T extends object
  ? Base extends object
    ? T & { [K in Exclude<keyof T, keyof Base>]: never }
    : T
  : T;

/**
 * Construct a single manifest entry. Closed-strict against extras at
 * the top level — at the literal site (TS-2353) AND on pre-bound
 * variables (via the `NoExtraKeys` intersection). The discriminator
 * literal is preserved via `<const TType, const TPayload>` for
 * downstream `InferEventUnion` projection.
 *
 * **Nested-object extras** (Phase-6 honest accounting): because
 * `defineAgentEvent` infers a generic `TEntry` parameter, the inference
 * widens to absorb any nested extras BEFORE top-level `NoExtraKeys`
 * runs. ALL nested smuggle vectors — inline literal, pre-bound, AND
 * spread (`envelope: { ...baseEnv }` slips past TS-2353 even on inline
 * literals) — are routed to the S2-CG AST walker, which must be
 * spread-aware. Top-level `NoExtraKeys` still catches pre-bound
 * top-level "extras bag" smuggling (the historical attack vector).
 */
export function defineAgentEvent<
  const TType extends string,
  const TPayload extends z.ZodRawShape,
  const TEntry extends AgentEventManifestEntry<TType, TPayload>,
>(
  entry: NoExtraKeys<TEntry, AgentEventManifestEntry<TType, TPayload>>,
): TEntry {
  return entry as unknown as TEntry;
}

/**
 * Construct the full manifest. Two structural locks:
 *
 *   1. **Key ↔ type lock**: each record key must equal its entry's
 *      `type` discriminator. Encoded via the mapped-type constraint
 *      `{ [K in keyof TManifest & string]: AgentEventManifestEntry<K & string, ...> }`.
 *   2. **No-extras lock (top-level)**: each entry value rejects extra
 *      top-level fields via `NoExtraKeys`. Nested-object extras at
 *      pre-bound variables are routed to the S2-CG AST walker.
 *
 * Both locks are required for the S2-C derivations to be correct.
 */
export function defineAgentEvents<
  const TManifest extends {
    [K in keyof TManifest & string]: NoExtraKeys<
      TManifest[K],
      AgentEventManifestEntry<K, z.ZodRawShape>
    > extends AgentEventManifestEntry<infer _T, infer _P>
      ? AgentEventManifestEntry<K, _P>
      : AgentEventManifestEntry<K, z.ZodRawShape>;
  },
>(manifest: TManifest): TManifest {
  return manifest;
}

// ----------------------------------------------------------------------------
//   Populated manifest — 19 AgentEvent variants (S2-A2)
// ----------------------------------------------------------------------------

const seqPayloadShape = {
  seq: z.number().int().positive().optional(),
} as const;

const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/;
const HTML_TAG_PATTERN = /<[^>]*>/;
export const MCP_APP_VIEW_SUMMARY_DISPLAY_MAX_CHARS = 280;
export const MCP_APP_VIEW_SUMMARY_SCHEMA_MAX_CHARS = 500;

export const McpAppViewSummarySchema = z.string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: 'viewSummary must be non-empty after trimming',
  })
  .refine((value) => value.length <= MCP_APP_VIEW_SUMMARY_SCHEMA_MAX_CHARS, {
    message: `viewSummary must be ${MCP_APP_VIEW_SUMMARY_SCHEMA_MAX_CHARS} characters or fewer`,
  })
  .refine((value) => !HTML_TAG_PATTERN.test(value), {
    message: 'viewSummary must be plaintext without HTML tags',
  })
  .refine((value) => !ANSI_ESCAPE_SEQUENCE_PATTERN.test(value), {
    message: 'viewSummary must be plaintext without ANSI escape sequences',
  })
  .transform((value) => {
    if (value.length <= MCP_APP_VIEW_SUMMARY_DISPLAY_MAX_CHARS) {
      return value;
    }
    return value.slice(0, MCP_APP_VIEW_SUMMARY_DISPLAY_MAX_CHARS);
  });

export const McpAppStructuredFallbackSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email-draft'),
    payload: z.object({
      to: z.array(z.string()),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string(),
      body: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('calendar-pick'),
    payload: z.object({
      title: z.string().optional(),
      options: z.array(z.object({
        id: z.string().optional(),
        label: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
        location: z.string().optional(),
      }).strict()),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('document-outline'),
    payload: z.object({
      title: z.string().optional(),
      sections: z.array(z.object({
        heading: z.string(),
        bullets: z.array(z.string()).optional(),
      }).strict()),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('plain'),
    payload: z.object({
      markdown: z.string(),
    }).strict(),
  }).strict(),
]);

export const McpAppUiMetaSchema = z.object({
  resourceUri: z.string(),
  sourcePackageId: z.string().nullable().optional(),
  protocolUrl: z.string().optional(),
  originalFilePath: z.string().optional(),
  presentation: z.enum(['primary', 'inline']).optional(),
  viewSummary: McpAppViewSummarySchema.optional(),
  viewRoleLabel: z.string().optional(),
  structuredFallback: McpAppStructuredFallbackSchema.optional(),
  visibility: z.array(z.enum(['model', 'app'])).optional(),
  csp: z.object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
  }).optional(),
  permissions: z.object({
    camera: z.boolean().optional(),
    microphone: z.boolean().optional(),
    geolocation: z.boolean().optional(),
    clipboardWrite: z.boolean().optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.presentation === 'primary' && value.viewSummary === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "viewSummary is required when presentation is 'primary'",
      path: ['viewSummary'],
    });
  }
});

export const AgentErrorResolutionActionSchema = z.object({
  label: z.string(),
  // Keep in lockstep with the `AgentErrorResolutionAction.action` union in
  // `packages/shared/src/utils/classifyErrorUx.ts` and the IPC channel enum in
  // `src/shared/ipc/channels/agentError.ts`. 260622 Stage 4 added the two
  // Chief-of-Staff recovery verbs.
  action: z.enum([
    'switch-model',
    'switch-provider',
    'open-settings',
    'retry',
    'recreate-chief-of-staff',
    'proceed-without-chief-of-staff',
  ]),
  payload: z.object({
    model: z.string().optional(),
    provider: z.enum(['codex', 'anthropic', 'openrouter', 'openai']).optional(),
    settingsSection: z.string().optional(),
    // FOX-3494: the route role whose model a switch-model action should repair
    // (planning → thinking slot, else working). Keep in lockstep with the
    // AgentErrorResolutionAction payload type in classifyErrorUx.ts.
    failedRole: z.enum(['execution', 'planning', 'bts', 'subagent']).optional(),
  }).optional(),
  variant: z.enum(['primary', 'secondary']).optional(),
});

export const AgentErrorResolutionSchema = z.object({
  category: z.enum(['transient', 'user-fixable', 'system-broken', 'unsupported-feature', 'unknown']),
  kind: z.enum(AGENT_ERROR_KINDS),
  title: z.string(),
  body: z.string(),
  alternatives: z.array(AgentErrorResolutionActionSchema).max(2),
  defaultAction: AgentErrorResolutionActionSchema.optional(),
  persistent: z.boolean(),
});

const RecoveryPhaseSchema = z.enum(['pre_activity', 'post_activity']);
export const RecoveryExhaustedReasonSchema = z.enum([
  'depth_limit_reached',
  'attempt_limit_reached',
  'no_qualifying_profile',
  'rate_limited',
  'recovery_disabled',
  'no_messages_to_compact',
  'summary_generation_failed',
  'agent_loop_error_before_recovery',
  'agent_loop_error_after_recovery',
  'long_context_fallback_failed',
  'aborted',
]);
const RecoveryTargetSchema = z.object({
  kind: z.enum(['model', 'profile']),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  modelName: z.string().optional(),
});
const RecoveryCommonShape = {
  turnId: z.string(),
  sessionId: z.string(),
  originalSessionId: z.string(),
  depth: z.number().int().min(0).max(4),
  attempt: z.number().int().min(0),
  totalCalls: z.number().int().min(0),
  timestamp: z.number(),
  ...seqPayloadShape,
} as const;

const ModelUsageEntrySchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  costUsd: z.number().optional(),
  authMethod: z.string().optional(),
  openRouterProvider: z.string().optional(),
  providersSeen: z.array(z.string()).optional().default([]),
  fulfillmentProvider: FulfillmentProviderSchema.nullable().optional(),
});

/** Runtime-authored per-role model binding. Must match ipc/schemas/agent.ts (parity-gated). */
const ModelRoleBindingSchema = z.object({
  role: z.enum(['thinking', 'working', 'fast']),
  canonicalModelId: z.string(),
  rawModelId: z.string(),
  status: z.enum(['observed', 'configured_not_used']),
  modelUsageKey: z.string().optional(),
  authMethod: z.string().optional(),
  provider: z.string().optional(),
  pricingStatus: z.enum(['priced', 'unpriced']).optional(),
});

const OutputShapeMetricsSchema = z.object({
  wordCount: z.number().int().min(0),
  headingCount: z.number().int().min(0),
  bulletCount: z.number().int().min(0),
  numberedListCount: z.number().int().min(0),
  codeBlockCount: z.number().int().min(0),
  tableLineCount: z.number().int().min(0),
  linkCount: z.number().int().min(0),
  hasSourceSection: z.boolean(),
  shapeBucket: z.enum(OUTPUT_SHAPE_BUCKETS),
});

const ImageRefSchema = z.object({
  assetId: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnailAssetId: z.string().optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'missing']).optional(),
}).passthrough();

const ContentRefSchema = z.object({
  contentId: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  summary: z.string().optional(),
  etag: z.string().optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'missing']).optional(),
}).passthrough();

const ToolResultImageContentSourceSchema = z.object({
  type: z.literal('base64'),
  media_type: z.string(),
  data: z.string(),
});

const ToolResultImageContentBlockSchema = z.object({
  type: z.literal('image'),
  source: ToolResultImageContentSourceSchema.optional(),
  // Stage 5: closed-strict manifest explicitly accepts ref-bearing image
  // blocks after sanitization strips inline `source` bytes.
  imageRef: ImageRefSchema.optional(),
}).passthrough();

// Stage B1a (260518): closed-strict manifest accepts ref-bearing opaque-content
// blocks emitted by the content materializer; sanitization is a no-op (refs
// are never dropped/truncated; .passthrough() preserves forward-compat fields).
const ToolResultContentRefBlockSchema = z.object({
  type: z.literal('content_ref'),
  contentRef: ContentRefSchema,
  summary: z.string().optional(),
}).passthrough();

const ToolResultContentBlockSchema = z.union([
  ToolResultImageContentBlockSchema,
  ToolResultContentRefBlockSchema,
  z.object({}).passthrough(),
]);

/**
 * Shadow manifest populated from the current production `AgentEventSchema`.
 * Each payload schema intentionally omits the `type` discriminator because
 * the S2-C projection adds it via `.extend({ type: z.literal(entry.type) })`.
 */
export const agentEventManifest = defineAgentEvents({
  // status: derived from AgentEventSchema agent.ts:183-187, COMPACTION_POLICY:97.
  status: defineAgentEvent({
    ...agentEventPolicyManifest.status,
    type: 'status',
    payloadSchema: z.object({
      message: z.string(),
      timestamp: z.number(),
      // Quit-vs-crash discriminator for synthetic turn-interruption statuses.
      // Optional: absent on regular statuses and pre-existing persisted events.
      // See src/shared/constants/turnInterruption.ts.
      source: z.enum(['shutdown', 'startup-correction']).optional(),
      // SOFT "still waiting" marker for an interactive awaiting_api stall (Stage 1b).
      // Optional + additive. Must match ipc/schemas/agent.ts and types/agent.ts.
      // See src/core/services/watchdog/watchdogTracker.ts isAwaitingApiSoftStall.
      stall: z.object({
        phase: z.literal('awaiting_api'),
        sinceMs: z.number(),
      }).optional(),
      ...seqPayloadShape,
    }),
  }),

  // assistant: derived from AgentEventSchema agent.ts:188-192, COMPACTION_POLICY:110.
  assistant: defineAgentEvent({
    ...agentEventPolicyManifest.assistant,
    type: 'assistant',
    payloadSchema: z.object({
      text: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // result: derived from AgentEventSchema agent.ts:193-234, COMPACTION_POLICY:88.
  result: defineAgentEvent({
    ...agentEventPolicyManifest.result,
    type: 'result',
    payloadSchema: z.object({
      text: z.string(),
      model: z.string().optional(),
      planningModel: z.string().optional(),
      modelUsage: z.record(z.string(), ModelUsageEntrySchema).optional(),
      usage: z.object({
        inputTokens: z.number().nullable().optional(),
        outputTokens: z.number().nullable().optional(),
        cacheCreationTokens: z.number().nullable().optional(),
        cacheReadTokens: z.number().nullable().optional(),
        costUsd: z.number().nullable().optional(),
        contextUtilization: z.number().nullable().optional(),
        contextWindow: z.number().nullable().optional(),
      }).optional(),
      toolMetrics: z.object({
        totalToolCalls: z.number(),
        failedToolCalls: z.number(),
        filesCreated: z.number(),
        filesEdited: z.number(),
        workArtifactsCreated: z.number().optional(),
        workArtifactsCreatedByType: z.record(z.string(), z.number()).optional(),
        toolUsageByCategory: z.record(z.string(), z.number()),
        mcpServerUsage: z.record(z.string(), z.number()),
        totalToolOutputChars: z.number(),
        mcpToolOutputChars: z.number(),
        builtinToolOutputChars: z.number(),
      }).optional(),
      outputShapeMetrics: OutputShapeMetricsSchema.optional(),
      subAgentMetrics: z.object({
        usedSubAgents: z.boolean(),
        subAgentCount: z.number(),
        subAgentToolCount: z.number(),
      }).optional(),
      thinkingEffort: ThinkingEffortSchema.optional(),
      authMethod: z.string().optional(),
      fallbacks: z.array(z.object({
        type: z.enum(['auth', 'model', 'context', 'tier_model', 'provider']),
        from: z.string(),
        to: z.string(),
        reason: z.string(),
        // "Who pays" for a provider failover destination. Additive/optional —
        // absent on legacy turns and non-provider fallbacks. Must match
        // ipc/schemas/agent.ts. See docs/plans/260621_paid-fallback-indicator/.
        billingSource: z.enum(['subscription', 'pool', 'pay-per-use', 'local']).nullable().optional(),
      })).optional(),
      /** Runtime-authored per-role model bindings. Additive/optional (absent on legacy turns). Must match ipc/schemas/agent.ts. */
      roles: z.array(ModelRoleBindingSchema).optional(),
      turnEndReason: z.enum(['completed', 'user_stopped', 'superseded', 'awaiting_user', 'error']).optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // tool: derived from AgentEventSchema agent.ts:235-267, COMPACTION_POLICY:109.
  tool: defineAgentEvent({
    ...agentEventPolicyManifest.tool,
    type: 'tool',
    payloadSchema: z.object({
      toolName: z.string(),
      toolUseId: z.string().optional(),
      parentToolUseId: z.string().nullable().optional(),
      detail: z.string(),
      stage: z.enum(['start', 'end']),
      isError: z.boolean().optional(),
      outputChars: z.number().optional(),
      timestamp: z.number(),
      imageContent: z.array(z.object({
        type: z.literal('image'),
        data: z.string(),
        mimeType: z.string(),
      })).optional(),
      imageRef: z.array(ImageRefSchema.nullable()).optional(),
      // Stage B1a (260518): positional refs for opaque-content blocks
      // offloaded to the session-scoped ContentStore. Aligned to the
      // position of the `content_ref` block within `toolResult.content`
      // after materialization; a `null` entry means materialization failed
      // for that block and the inline content is preserved.
      contentRef: z.array(ContentRefSchema.nullable()).optional(),
      mcpAppUiMeta: McpAppUiMetaSchema.optional(),
      toolResult: z.object({
        content: z.array(z.union([ToolResultContentBlockSchema, z.unknown()])).optional(),
        structuredContent: z.unknown().optional(),
      }).optional(),
      // `_origin` is declared on the canonical TS type at
      // `src/shared/types/agent.ts:646-651` (with values `'real'` /
      // `'synthetic-plan-seed'` / `'pre-turn-context'`) and is preserved
      // through compaction at `src/shared/utils/eventCompaction.ts:157-160`.
      // The current `AgentEventSchema` Zod schema does NOT declare it
      // (parallel-declaration drift the manifest unifies). The manifest
      // declares `_origin` so the S2-C-projected schema preserves it
      // through `payloadSchema.parse()` rather than silently stripping it
      // — see Phase-5 review by `reviewer-gpt5.5-high` (2026-04-29).
      _origin: z.enum(['real', 'synthetic-plan-seed', 'pre-turn-context']).optional(),
      ...seqPayloadShape,
    }),
  }),

  // error: derived from AgentEventSchema agent.ts:268-302, COMPACTION_POLICY:89.
  error: defineAgentEvent({
    ...agentEventPolicyManifest.error,
    type: 'error',
    payloadSchema: z.object({
      error: z.string(),
      // Top-level raw upstream error body — populated by
      // `dispatchAgentErrorEvent` for every error kind when
      // `errorSource === 'main'`. Redacted + truncated to 4 KB before
      // persistence. See src/core/services/agentEventDispatcher.ts and
      // docs/plans/260429_eval_reliability_judge_panel.md § S2.
      rawError: z.string().optional(),
      isTransient: z.boolean().optional(),
      errorSource: z.enum(['main', 'renderer']).optional(),
      errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
      limitScope: z.enum(['provider', 'plan', 'account']).optional(),
      credentialSource: z.enum(PROVIDER_CREDENTIAL_SOURCES).optional(),
      headlineClass: z.enum(['rate_limit', 'billing_quota', 'subscription_entitlement', 'auth', 'other']).optional(),
      resolution: AgentErrorResolutionSchema.optional(),
      rateLimitMeta: z.object({
        rawError: z.string().optional(),
        retryAfterMs: z.number().optional(),
        resetAtMs: z.number().optional(),
      }).optional(),
      billingMeta: z.object({
        subtype: z.enum(['credits', 'key_limit', 'spend_limit', 'free_tier_exhausted', 'negative_balance', 'unknown']),
        upstreamProviderName: z.string().optional(),
        rawError: z.string().optional(),
        // Present iff the failing turn routed through the Mindstone-managed
        // subscription credential. See
        // docs/plans/260513a_subscription_consumer_audit_gaps.md § E.
        managedSubscription: z.object({
          tier: z.string(),
          resetsAt: z.string().optional(),
        }).optional(),
      }).optional(),
      // Set when errorKind === 'managed_model_not_allowed'. Carries requested
      // model id, the tier-allowlisted model ids, and the raw upstream error so
      // the renderer can produce a clear "model not included in your
      // subscription" banner. See
      // docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
      managedModelMeta: z.object({
        requested: z.string().optional(),
        allowed: z.array(z.string()).optional(),
        rawError: z.string().optional(),
      }).optional(),
      provider: z.string().optional(),
      timeoutDiagnostic: z.object({
        kind: z.enum(['anthropic_issue', 'internet_unreachable', 'transient_stall']),
        indicator: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      watchdogDiagnostic: z.object({
        phase: z.string(),
        messageCount: z.number(),
        rawStreamEventCount: z.number(),
        rawStreamLastEventType: z.string().nullable(),
        rawStreamLastEventAgeMs: z.number().nullable(),
        watchdogLevel: z.number(),
        maxWatchdogLevel: z.number(),
        effectiveAbortMs: z.number(),
        model: z.string().optional(),
      }).optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // warning: derived from AgentEventSchema agent.ts:303-308, COMPACTION_POLICY:98.
  warning: defineAgentEvent({
    ...agentEventPolicyManifest.warning,
    type: 'warning',
    payloadSchema: z.object({
      message: z.string(),
      category: z.string().optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // user_question: derived from AgentEventSchema agent.ts:309-318, COMPACTION_POLICY:91.
  user_question: defineAgentEvent({
    ...agentEventPolicyManifest.user_question,
    type: 'user_question',
    payloadSchema: z.object({
      batchId: z.string(),
      toolUseId: z.string(),
      questions: z.array(UserQuestionSchema),
      sessionId: z.string().optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // user_question_answered: derived from AgentEventSchema agent.ts:319-326, COMPACTION_POLICY:92.
  user_question_answered: defineAgentEvent({
    ...agentEventPolicyManifest.user_question_answered,
    type: 'user_question_answered',
    payloadSchema: z.object({
      batchId: z.string(),
      answers: z.array(UserQuestionAnswerSchema),
      skipped: z.boolean().optional(),
      sessionId: z.string().optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // assistant_delta: derived from AgentEventSchema agent.ts:327-331, COMPACTION_POLICY:99.
  assistant_delta: defineAgentEvent({
    ...agentEventPolicyManifest.assistant_delta,
    type: 'assistant_delta',
    payloadSchema: z.object({
      text: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // thinking_delta: derived from AgentEventSchema agent.ts:332-336, COMPACTION_POLICY:100.
  thinking_delta: defineAgentEvent({
    ...agentEventPolicyManifest.thinking_delta,
    type: 'thinking_delta',
    payloadSchema: z.object({
      text: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // context_overflow: derived from AgentEventSchema agent.ts:337-341, COMPACTION_POLICY:101.
  context_overflow: defineAgentEvent({
    ...agentEventPolicyManifest.context_overflow,
    type: 'context_overflow',
    payloadSchema: z.object({
      originalPrompt: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_started: derived from AgentEventSchema agent.ts:342-347, COMPACTION_POLICY:103.
  compaction_started: defineAgentEvent({
    ...agentEventPolicyManifest.compaction_started,
    type: 'compaction_started',
    payloadSchema: z.object({
      depth: z.number(),
      sessionId: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_summary_ready: derived from AgentEventSchema agent.ts:348-353, COMPACTION_POLICY:104.
  compaction_summary_ready: defineAgentEvent({
    ...agentEventPolicyManifest.compaction_summary_ready,
    type: 'compaction_summary_ready',
    payloadSchema: z.object({
      summary: z.string(),
      depth: z.number(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_retrying: derived from AgentEventSchema agent.ts:354-358, COMPACTION_POLICY:105.
  compaction_retrying: defineAgentEvent({
    ...agentEventPolicyManifest.compaction_retrying,
    type: 'compaction_retrying',
    payloadSchema: z.object({
      depth: z.number(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_completed: derived from AgentEventSchema agent.ts:359-362, COMPACTION_POLICY:106.
  compaction_completed: defineAgentEvent({
    ...agentEventPolicyManifest.compaction_completed,
    type: 'compaction_completed',
    payloadSchema: z.object({
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_failed: derived from AgentEventSchema agent.ts:363-368, COMPACTION_POLICY:107.
  compaction_failed: defineAgentEvent({
    ...agentEventPolicyManifest.compaction_failed,
    type: 'compaction_failed',
    payloadSchema: z.object({
      error: z.string(),
      depth: z.number(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),


  'recovery:started': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:started'],
    type: 'recovery:started',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      phase: RecoveryPhaseSchema,
    }),
  }),

  'recovery:fallback_attempting': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:fallback_attempting'],
    type: 'recovery:fallback_attempting',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      target: RecoveryTargetSchema,
    }),
  }),

  'recovery:fallback_succeeded': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:fallback_succeeded'],
    type: 'recovery:fallback_succeeded',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      target: RecoveryTargetSchema,
    }),
  }),

  'recovery:compacting': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:compacting'],
    type: 'recovery:compacting',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
    }),
  }),

  'recovery:summary_ready': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:summary_ready'],
    type: 'recovery:summary_ready',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      summary: z.string(),
      revealDurationMs: z.number().int().min(0).optional(),
    }),
  }),

  'recovery:retrying': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:retrying'],
    type: 'recovery:retrying',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
    }),
  }),

  'recovery:skeleton_attempting': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:skeleton_attempting'],
    type: 'recovery:skeleton_attempting',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
    }),
  }),

  'recovery:depth4_attempting': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:depth4_attempting'],
    type: 'recovery:depth4_attempting',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      profileId: z.string(),
      modelName: z.string(),
      costEstimate: z.literal('high'),
    }),
  }),

  'recovery:succeeded': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:succeeded'],
    type: 'recovery:succeeded',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      finalDepth: z.number().int().min(0).max(4),
      totalDurationMs: z.number().int().min(0),
    }),
  }),

  'recovery:failed': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:failed'],
    type: 'recovery:failed',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      error: z.string(),
      exhaustedReason: RecoveryExhaustedReasonSchema,
    }),
  }),

  'recovery:last_resort_skipped': defineAgentEvent({
    ...agentEventPolicyManifest['recovery:last_resort_skipped'],
    type: 'recovery:last_resort_skipped',
    payloadSchema: z.object({
      ...RecoveryCommonShape,
      reason: z.enum(['no_qualifying_profile', 'rate_limited']),
      userFacingTitle: z.string(),
      userFacingMessage: z.string(),
      action: z.string(),
    }),
  }),

  // turn_superseded: derived from AgentEventSchema agent.ts:369-373, COMPACTION_POLICY:102.
  turn_superseded: defineAgentEvent({
    ...agentEventPolicyManifest.turn_superseded,
    type: 'turn_superseded',
    payloadSchema: z.object({
      newTurnId: z.string(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // user_message: derived from AgentEventSchema agent.ts:374-379, COMPACTION_POLICY:90.
  user_message: defineAgentEvent({
    ...agentEventPolicyManifest.user_message,
    type: 'user_message',
    payloadSchema: z.object({
      text: z.string(),
      isHidden: z.boolean().optional(),
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // turn_started: derived from AgentEventSchema agent.ts:380-383, COMPACTION_POLICY:108.
  turn_started: defineAgentEvent({
    ...agentEventPolicyManifest.turn_started,
    type: 'turn_started',
    payloadSchema: z.object({
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),

  // answer_phase_started: desktop-renderer-IPC-only lifecycle marker (260508 Stage 2).
  // Dispatched ONLY via dispatchRendererOnlyAgentEvent — never reaches CLI/cloud/mobile.
  answer_phase_started: defineAgentEvent({
    ...agentEventPolicyManifest.answer_phase_started,
    type: 'answer_phase_started',
    payloadSchema: z.object({
      timestamp: z.number(),
      ...seqPayloadShape,
    }),
  }),
});

// ----------------------------------------------------------------------------
//   S2-C: structural derivations from the populated manifest
// ----------------------------------------------------------------------------

/**
 * **Failure Mode A correction (E5, 2026-04-29)**: the original Failure
 * Mode A wiring (commit `e7e524594`) retained the hand-authored
 * `AgentEvent` and bound the manifest back to it via an
 * `IsExactStrict<AgentEvent, InferEventUnion<typeof manifest>>` parity gate.
 * The S2-E-bis re-probe found that wiring was structurally HEAVIER
 * than the original derivation (+46.59% Total time vs S2-E's +36.67%)
 * because `IsExactStrict<>`'s bidirectional `<T>() => T extends A ? 1 : 2`
 * forces both sides of the comparison to fully materialise.
 *
 * E5 reverts that wiring: the manifest exposes the structural
 * derivation directly as `AgentEventFromManifest`, scopes
 * `NoExtraKeys` to top-level keys (~+30 LOC reduction in mapped-type
 * cost), and routes nested smuggle detection to the S2-CG AST walker.
 * Full-project tsc re-probe (3-iter cold-start, both `tsconfig.node.json`
 * and `tsconfig.renderer.json`): node +4.4% Total time / renderer +4.0%
 * Total time — well inside the < 15% gate. Stage 3 cutover will
 * re-probe with consumers actually consuming `AgentEventFromManifest`.
 *
 * Stage 2 ships the derivation alongside the hand-authored
 * `src/shared/types/agent.ts` `AgentEvent` (shadow-derive). Stage 3
 * cutover migrates consumers and eventually deletes the hand-authored
 * union. Drift between the two during Stage 2 is detected by the S2-D
 * parity corpus.
 *
 * @see docs/plans/260427_refactor_contract_manifest.md § Amendment log entry C9
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md § S2-C E5 path
 */

/**
 * Per-variant projection: discriminator + payload, with the optional
 * `seq` factored out to match the canonical `AgentEvent` shape in
 * `src/shared/types/agent.ts` (which threads `AgentEventWithSeq` as a
 * separate intersection rather than embedding `seq` in every variant).
 */
type EventFromManifestEntry<
  TEntry extends AgentEventManifestEntry<string, z.ZodRawShape>,
> = {
  type: TEntry['type'];
} & Omit<z.infer<TEntry['payloadSchema']>, 'seq'>;

/**
 * Structural derivation of the full discriminated union from a
 * manifest's per-entry payload schemas. The optional `seq` is hoisted
 * onto the union so the inferred shape matches the canonical
 * `AgentEventWithSeq & (...)` factoring of `src/shared/types/agent.ts`.
 */
export type InferEventUnion<TManifest extends AgentEventManifest> = {
  seq?: number;
} & {
  [K in keyof TManifest]: EventFromManifestEntry<TManifest[K]>;
}[keyof TManifest];

/**
 * Structural alias for Stage 3 cutover. Consumers migrating off the
 * hand-authored `src/shared/types/agent.ts` `AgentEvent` import this
 * alias instead. Stage 3's S2-D parity corpus enforces shape parity
 * between the two during the migration window.
 */
export type AgentEventFromManifest = InferEventUnion<typeof agentEventManifest>;

type DiscriminatedVariantSchema = z.ZodObject<z.ZodRawShape>;

/**
 * Build a Zod discriminated union over `type` from every entry's
 * `payloadSchema`. The runtime schema is the validation source of
 * truth for derived consumers (cloud router, replay canonicalizer,
 * sanitization pipeline).
 */
export function discriminatedUnionFromManifest<
  TManifest extends AgentEventManifest,
>(manifest: TManifest): z.ZodType<InferEventUnion<TManifest>> {
  const variants = Object.values(manifest).map((entry) =>
    entry.payloadSchema.extend({ type: z.literal(entry.type) }),
  ) as DiscriminatedVariantSchema[];

  if (variants.length < 2) {
    throw new Error('discriminatedUnionFromManifest requires ≥ 2 variants.');
  }

  return z.discriminatedUnion('type', variants as [
    DiscriminatedVariantSchema,
    DiscriminatedVariantSchema,
    ...DiscriminatedVariantSchema[],
  ]) as unknown as z.ZodType<InferEventUnion<TManifest>>;
}

export const AgentEventSchemaFromManifest =
  discriminatedUnionFromManifest(agentEventManifest);

/**
 * Runtime-validated shape — the result of `AgentEventSchemaFromManifest.parse(...)`.
 * Equivalent to `AgentEventFromManifest` modulo Zod transform inference.
 */
export type AgentEventFromSchema = z.infer<typeof AgentEventSchemaFromManifest>;

/**
 * Per-variant compaction-policy lookup, derived from the manifest.
 * Shadow-published in Stage 2 next to the existing
 * `eventCompaction.ts` `COMPACTION_POLICY` map. Stage 3 cutover
 * migrates consumers off the private map onto this exported one.
 */
export const COMPACTION_POLICY_FROM_MANIFEST = Object.fromEntries(
  Object.entries(agentEventManifest).map(([type, entry]) => [
    type,
    entry.compactionPolicy,
  ]),
) as Record<
  keyof typeof agentEventManifest,
  AgentEventManifestEntry<string, z.ZodRawShape>['compactionPolicy']
>;

/**
 * Per-variant sanitization-strategy lookup, derived from the manifest.
 * Shadow-published in Stage 2 alongside the existing functional
 * sanitization pipeline; Stage 3 cutover migrates consumers onto this
 * exported map.
 */
export const SANITIZATION_POLICY_FROM_MANIFEST = Object.fromEntries(
  Object.entries(agentEventManifest).map(([type, entry]) => [
    type,
    entry.sanitization,
  ]),
) as Record<
  keyof typeof agentEventManifest,
  AgentEventManifestEntry<string, z.ZodRawShape>['sanitization']
>;

/**
 * Look up the full per-variant policy axes from the manifest by type.
 * Preferred over scattered per-axis maps because the manifest is the
 * single source of truth for axis values.
 */
export function policyFor<T extends keyof typeof agentEventManifest>(type: T) {
  return agentEventManifest[type];
}

// ----------------------------------------------------------------------------
//   buildAgentEvent: envelope-required-fields enforcement
// ----------------------------------------------------------------------------

/**
 * Per-variant envelope shape. Each entry's
 * `envelope.requiredForNewEvents` declares which envelope fields the
 * builder enforces at compile time (and at runtime as a defence-in-depth
 * check). Missing a required envelope field is a TS-2345 error at the
 * builder call site.
 */
type RequiredEnvelopeForEntry<
  TEntry extends AgentEventManifestEntry<string, z.ZodRawShape>,
> = {
  [K in TEntry['envelope']['requiredForNewEvents'][number]]: string;
};

type BuiltAgentEventForEntry<
  TEntry extends AgentEventManifestEntry<string, z.ZodRawShape>,
> = { seq?: number } & EventFromManifestEntry<TEntry> &
  RequiredEnvelopeForEntry<TEntry>;

type BuildAgentEventMap<TManifest extends AgentEventManifest> = {
  readonly [K in keyof TManifest]: (
    payload: z.input<TManifest[K]['payloadSchema']>,
    envelope: RequiredEnvelopeForEntry<TManifest[K]>,
  ) => BuiltAgentEventForEntry<TManifest[K]>;
};

/**
 * Validates required envelope fields and **picks only the declared
 * required fields** from the supplied envelope — extra envelope keys
 * are dropped silently rather than spread onto the event.
 *
 * Phase-6 review (S2-C, 2026-04-29) flagged that the prior
 * implementation returned the full envelope object, which was then
 * spread last in `buildAgentEvent`. A bypass-caller (e.g. one casting
 * through `unknown`) could pass `{ type: 'malicious', timestamp: 0,
 * payloadField: '...' }` as the envelope and override the parsed
 * payload + discriminator. Picking only the declared
 * `requiredForNewEvents` fields closes that vector — the discriminator
 * comes from `entry.type`, the payload comes from the schema parse, and
 * the envelope contributes only what the manifest entry declared as
 * required.
 */
function validateEnvelopeForEntry<
  TEntry extends AgentEventManifestEntry<string, z.ZodRawShape>,
>(
  entry: TEntry,
  envelope: RequiredEnvelopeForEntry<TEntry>,
): RequiredEnvelopeForEntry<TEntry> {
  const envelopeRecord = envelope as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const field of entry.envelope.requiredForNewEvents) {
    const value = envelopeRecord[field];
    if (typeof value !== 'string') {
      throw new Error(
        `buildAgentEvent.${entry.type} requires envelope.${field}`,
      );
    }
    picked[field] = value;
  }
  return picked as RequiredEnvelopeForEntry<TEntry>;
}

/**
 * Per-variant event constructor. Closed-strict against missing
 * envelope fields — the type system rejects `buildAgentEvent.tool(payload, {})`
 * because `RequiredEnvelopeForEntry<tool entry>` requires the fields in
 * `entry.envelope.requiredForNewEvents` (e.g. `sessionId`, `turnId`,
 * `toolUseId` for `tool` events).
 *
 * Runtime defence-in-depth: `validateEnvelopeForEntry` re-checks at
 * runtime AND picks only the declared required fields, so non-TypeScript
 * callers (boundary-crossing code paths that pass through `unknown`)
 * cannot smuggle extra envelope keys that override the parsed payload
 * or discriminator.
 *
 * Spread order is intentional: the parsed payload comes after the
 * discriminator, then the picked envelope. The picked envelope cannot
 * override `type` (the discriminator literal is always last to win
 * over any envelope-supplied `type` field — wait, actually `type`
 * comes first; we set it once and the envelope-pick is restricted to
 * `requiredForNewEvents` which never contains `type`).
 */
export const buildAgentEvent = Object.fromEntries(
  Object.entries(agentEventManifest).map(([type, entry]) => [
    type,
    (payload: unknown, envelope: Record<string, string>) => ({
      type: entry.type,
      ...entry.payloadSchema.parse(payload),
      ...validateEnvelopeForEntry(
        entry,
        envelope as RequiredEnvelopeForEntry<typeof entry>,
      ),
    }),
  ]),
) as unknown as BuildAgentEventMap<typeof agentEventManifest>;
