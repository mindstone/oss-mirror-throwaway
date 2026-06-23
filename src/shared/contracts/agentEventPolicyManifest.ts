/**
 * # Agent event **policy** manifest — Zod-free sibling
 *
 * Cloud-client and mobile bundles must be able to consult the
 * manifest's **policy** axes (compaction, persistence, ordering, …)
 * without paying the Zod runtime tax. They never construct or parse
 * events — that work lives on the desktop main process and the cloud
 * service. This file exposes the same 19 axes as `agentEventManifest`
 * minus the `payloadSchema` field, with **zero Zod imports** —
 * neither runtime nor type-only.
 *
 * **Why a separate file rather than a derivation?** Tree-shaking can in
 * principle drop the Zod schemas from a bundle that only reads policy
 * axes, but in practice the discriminated-union construction at module
 * load time (see chunked-plan § S2-C) makes Zod a required side-effect.
 * The policy sibling sidesteps this by never re-exporting the
 * Zod-typed `AgentEventManifestEntry` and never importing the
 * Zod-bearing module. Axis types are factored into
 * `agentEventManifestAxes.ts` (Zod-free) so this file imports nothing
 * from `agentEventManifest.ts`.
 *
 * **S2-A2 status:** this file now ships an independently declared,
 * Zod-free 19-variant policy manifest. The Zod-bearing manifest spreads
 * these policy rows and adds payload schemas; tests assert the two stay
 * identical modulo `payloadSchema`.
 *
 * @see ./agentEventManifest.ts (the Zod-bearing canonical source)
 * @see ./agentEventManifestAxes.ts (the Zod-free axis types)
 * @see docs/plans/260427_refactor_contract_manifest.md § "Manifest axes (locked, 2026-04-28)"
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md § S2-A1, S2-C
 */

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
import { applicabilityTag } from './applicabilityTag';

/**
 * The policy view of a manifest entry — every axis from
 * `AgentEventManifestEntry` **except** `payloadSchema`. Cloud-client
 * and mobile read this shape; they never produce or parse events, so
 * the Zod schema is dead weight from their perspective.
 *
 * Mirrors `AgentEventManifestEntry` field-by-field (closed-strict, no
 * index signature) so the two stay in lockstep. The manifest-guard CI
 * script (chunk S2-CG) verifies that for every axis added to one
 * type, the matching axis is added to the other.
 */
export type AgentEventPolicyManifestEntry<TType extends string> = Readonly<{
  // Identity (no payloadSchema!)
  type: TType;

  // Payload axes (10)
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
 * Aggregate type for the policy manifest. Closed-strict; no index
 * signature; same closed-strict mechanics as `AgentEventManifest`.
 */
export type AgentEventPolicyManifest = Readonly<
  Record<string, AgentEventPolicyManifestEntry<string>>
>;

const standardLegacyCompatibility = {
  policy: 'permissive-parse-strict-produce',
  notes: '`seq` is optional for persisted/broadcast legacy events; S2-C builders require `sessionId` and `turnId` on the envelope for new events.',
} as const satisfies LegacyCompatibility;

const userQuestionLegacyCompatibility = {
  policy: 'permissive-parse-strict-produce',
  notes: '`seq` and payload `sessionId` are optional for persisted AskUserQuestion events created before the cross-session-routing fix; S2-C builders require envelope `sessionId`, `turnId`, `batchId`, and `toolUseId` for new events.',
} as const satisfies LegacyCompatibility;

const userQuestionAnsweredLegacyCompatibility = {
  policy: 'permissive-parse-strict-produce',
  notes: '`seq` and payload `sessionId` are optional for persisted AskUserQuestion answer events created before the cross-session-routing fix; S2-C builders require envelope `sessionId`, `turnId`, and `batchId` for new events.',
} as const satisfies LegacyCompatibility;

const recoveryLegacyCompatibility = {
  policy: 'permissive-parse-strict-produce',
  notes: 'Stage 3 dual-write window: recovery:* events coexist with deprecated compaction_* events; producers must include provenance and totalCalls.',
} as const satisfies LegacyCompatibility;

const recoveryEnvelope = {
  requiredForNewEvents: ['sessionId', 'turnId', 'originalSessionId'],
  identityKey: 'turn-scoped',
  crossSessionRouting: 'drop-on-mismatch',
  persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
  dedupeKey: 'none',
  orderingSemantics: 'per-session-monotonic-by-seq',
  idempotencyAndRetry: 'non-idempotent-no-retry',
  cancellationBehavior: 'continue-on-disconnect',
  serializationConstraints: 'json-only-small',
} as const;

const recoveryPolicy = <const TType extends string>(
  type: TType,
  compactionPolicy: CompactionPolicy,
): AgentEventPolicyManifestEntry<TType> => ({
  type,
  compactionPolicy,
  sanitization: 'pass-through',
  runtimeEffect: 'lifecycle-only',
  uiVisibility: 'timeline',
  modelContextVisibility: 'ui-only',
  producerSurface: 'core',
  legacyCompatibility: recoveryLegacyCompatibility,
  unknownRuntimePolicy: 'preserve',
  telemetryPolicy: 'log-only',
  errorClassPolicy: applicabilityTag('not-applicable', `${type} events do not carry rate-limit/billing semantics`),
  envelope: recoveryEnvelope,
});

/**
 * Zod-free policy manifest populated from current production behavior.
 * Variant order mirrors `AgentEventSchema` exactly for mechanical review.
 */
export const agentEventPolicyManifest = {
  // status: derived from AgentEventSchema agent.ts:183-187, COMPACTION_POLICY:97, dispatcher/runtime handling agentEventDispatcher.ts:289-343 + runtimeState.ts:58-90.
  status: {
    type: 'status',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'mixed',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'status events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // assistant: derived from AgentEventSchema agent.ts:188-192, COMPACTION_POLICY:110, conversationState.ts:289-349.
  assistant: {
    type: 'assistant',
    compactionPolicy: 'compact',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'transcript',
    modelContextVisibility: 'replay-into-history',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'assistant events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // result: derived from AgentEventSchema agent.ts:193-234, COMPACTION_POLICY:88, terminal checkpoint agentEventDispatcher.ts:321-343.
  result: {
    type: 'result',
    compactionPolicy: 'keep',
    sanitization: 'pass-through',
    runtimeEffect: 'terminal',
    uiVisibility: 'transcript',
    modelContextVisibility: 'replay-into-history',
    producerSurface: 'mixed',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: 'unknown',
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'cache-continuation-result',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // tool: derived from AgentEventSchema agent.ts:235-267, COMPACTION_POLICY:109, sanitization eventSanitization.ts:215-239.
  tool: {
    type: 'tool',
    compactionPolicy: 'compact',
    sanitization: 'truncate-tool-detail-with-subagent-identity',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'transcript+timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'mixed',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'tool events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId', 'toolUseId'],
      identityKey: 'tool-use-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'tool-use-id',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // error: derived from AgentEventSchema agent.ts:268-302, COMPACTION_POLICY:89, dispatchAgentErrorEvent agentEventDispatcher.ts:441-591.
  // S2 (260429_eval_reliability_judge_panel): added optional top-level
  // `rawError` payload; sanitization stays `pass-through` because the
  // dispatcher already redacts + truncates before persistence (see
  // src/core/utils/redactRawError.ts).
  error: {
    type: 'error',
    compactionPolicy: 'keep',
    sanitization: 'pass-through',
    runtimeEffect: 'terminal',
    uiVisibility: 'transcript',
    modelContextVisibility: 'ui-only',
    producerSurface: 'mixed',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: 'unknown',
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'cache-continuation-result',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // warning: derived from AgentEventSchema agent.ts:303-308, COMPACTION_POLICY:98, conversationState.ts:445-465.
  warning: {
    type: 'warning',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'transcript',
    modelContextVisibility: 'ui-only',
    producerSurface: 'main',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'warning events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // user_question: derived from AgentEventSchema agent.ts:309-318, COMPACTION_POLICY:91, cross-session drop useUserQuestions.ts:177-232.
  user_question: {
    type: 'user_question',
    compactionPolicy: 'keep',
    sanitization: 'pass-through',
    runtimeEffect: 'pause-and-await-user',
    uiVisibility: 'transcript',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: userQuestionLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'user_question events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId', 'batchId', 'toolUseId'],
      identityKey: 'batch-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'turn-and-batch',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'idempotent',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // user_question_answered: derived from AgentEventSchema agent.ts:319-326, COMPACTION_POLICY:92, cloud bootstrap persistence bootstrap.ts:610-644.
  user_question_answered: {
    type: 'user_question_answered',
    compactionPolicy: 'keep',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'transcript',
    modelContextVisibility: 'ui-only',
    producerSurface: 'mixed',
    legacyCompatibility: userQuestionAnsweredLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'user_question_answered events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId', 'batchId'],
      identityKey: 'batch-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'turn-and-batch',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'idempotent',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // assistant_delta: derived from AgentEventSchema agent.ts:327-331, COMPACTION_POLICY:99, transient dispatcher path agentEventDispatcher.ts:298-319.
  assistant_delta: {
    type: 'assistant_delta',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'transient',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'assistant_delta events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: false, rendererStore: false, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // thinking_delta: derived from AgentEventSchema agent.ts:332-336, COMPACTION_POLICY:100, renderer transient buffer useAgentSessionEngine.ts:1001-1005.
  thinking_delta: {
    type: 'thinking_delta',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'transient',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'thinking_delta events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: false, rendererStore: false, cloud: false },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // context_overflow: derived from AgentEventSchema agent.ts:337-341, COMPACTION_POLICY:101, renderer recovery useAgentSessionEngine.ts:1015-1018.
  context_overflow: {
    type: 'context_overflow',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-and-sentry-with-pii-scrub',
    errorClassPolicy: applicabilityTag('not-applicable', 'context_overflow events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: false, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_started: derived from AgentEventSchema agent.ts:342-347, COMPACTION_POLICY:103, diagnostics use RawEventsTab.tsx:123-128.
  compaction_started: {
    type: 'compaction_started',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'compaction_started events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_summary_ready: derived from AgentEventSchema agent.ts:348-353, COMPACTION_POLICY:104, diagnostics use RawEventsTab.tsx:123-128.
  compaction_summary_ready: {
    type: 'compaction_summary_ready',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'compaction_summary_ready events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_retrying: derived from AgentEventSchema agent.ts:354-358, COMPACTION_POLICY:105, diagnostics use RawEventsTab.tsx:123-128.
  compaction_retrying: {
    type: 'compaction_retrying',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'compaction_retrying events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_completed: derived from AgentEventSchema agent.ts:359-362, COMPACTION_POLICY:106, diagnostics use RawEventsTab.tsx:123-128.
  compaction_completed: {
    type: 'compaction_completed',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'compaction_completed events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  /**
   * @deprecated Stage 4 retires this in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  // compaction_failed: derived from AgentEventSchema agent.ts:363-368, COMPACTION_POLICY:107, diagnostics use IssuesTab.tsx:138-152.
  compaction_failed: {
    type: 'compaction_failed',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'timeline',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'compaction_failed events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },


  'recovery:started': recoveryPolicy('recovery:started', 'keep'),
  'recovery:fallback_attempting': recoveryPolicy('recovery:fallback_attempting', 'drop'),
  'recovery:fallback_succeeded': recoveryPolicy('recovery:fallback_succeeded', 'drop'),
  'recovery:compacting': recoveryPolicy('recovery:compacting', 'drop'),
  'recovery:summary_ready': recoveryPolicy('recovery:summary_ready', 'drop'),
  'recovery:retrying': recoveryPolicy('recovery:retrying', 'drop'),
  'recovery:skeleton_attempting': recoveryPolicy('recovery:skeleton_attempting', 'drop'),
  'recovery:depth4_attempting': recoveryPolicy('recovery:depth4_attempting', 'drop'),
  'recovery:succeeded': recoveryPolicy('recovery:succeeded', 'keep'),
  'recovery:failed': recoveryPolicy('recovery:failed', 'keep'),
  'recovery:last_resort_skipped': recoveryPolicy('recovery:last_resort_skipped', 'keep'),

  // turn_superseded: derived from AgentEventSchema agent.ts:369-373, COMPACTION_POLICY:102, renderer cleanup useAgentSessionEngine.ts:1020-1042.
  turn_superseded: {
    type: 'turn_superseded',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'main',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'log-only',
    errorClassPolicy: applicabilityTag('not-applicable', 'turn_superseded events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: false, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // user_message: derived from AgentEventSchema agent.ts:374-379, COMPACTION_POLICY:90, conversationState.ts:466-478.
  user_message: {
    type: 'user_message',
    compactionPolicy: 'keep',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'transcript',
    modelContextVisibility: 'replay-into-history',
    producerSurface: 'main',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'user_message events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only',
    },
  },

  // turn_started: derived from AgentEventSchema agent.ts:380-383, COMPACTION_POLICY:108, runtimeState.ts:43-57.
  turn_started: {
    type: 'turn_started',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'lifecycle-only',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'main',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'turn_started events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: true, rendererStore: true, cloud: true },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },

  // answer_phase_started: desktop-renderer-IPC-only lifecycle marker emitted via
  // dispatchRendererOnlyAgentEvent on the FIRST assistant_delta of each turn.
  // Per 260508 plan Stage 2 (R2-3 / R2-4): never reaches CLI listeners, cloud
  // SSE subscribers, the main accumulator, the renderer Zustand store, or the
  // cloud broadcast path. Compaction drops it.
  // Consumer disposition:
  //   desktopRenderer: 'consume-and-drop' (clearThinkingBuffer + return)
  //   cli:             'never-receives'
  //   cloud:           'never-receives'
  //   mobile:          'never-receives'
  answer_phase_started: {
    type: 'answer_phase_started',
    compactionPolicy: 'drop',
    sanitization: 'pass-through',
    runtimeEffect: 'transient',
    uiVisibility: 'none',
    modelContextVisibility: 'ui-only',
    producerSurface: 'core',
    legacyCompatibility: standardLegacyCompatibility,
    unknownRuntimePolicy: 'preserve',
    telemetryPolicy: 'none',
    errorClassPolicy: applicabilityTag('not-applicable', 'answer_phase_started events do not carry rate-limit/billing semantics'),
    envelope: {
      requiredForNewEvents: ['sessionId', 'turnId'],
      identityKey: 'turn-scoped',
      crossSessionRouting: 'drop-on-mismatch',
      persistence: { mainAccumulator: false, rendererStore: false, cloud: false },
      dedupeKey: 'none',
      orderingSemantics: 'per-session-monotonic-by-seq',
      idempotencyAndRetry: 'non-idempotent-no-retry',
      cancellationBehavior: 'continue-on-disconnect',
      serializationConstraints: 'json-only-small',
    },
  },
} as const satisfies AgentEventPolicyManifest;

// ----------------------------------------------------------------------------
//   S2-C: Zod-free policy projections
// ----------------------------------------------------------------------------

/**
 * Compaction-policy projection from the Zod-free policy manifest. This
 * is the cloud-client / mobile entry point — it inherits the Zod-free
 * property of `agentEventPolicyManifest`, so consumers in those
 * bundles can read compaction policy without paying the Zod tax.
 */
export const COMPACTION_POLICY_FROM_POLICY_MANIFEST = Object.fromEntries(
  Object.entries(agentEventPolicyManifest).map(([type, entry]) => [
    type,
    entry.compactionPolicy,
  ]),
) as Record<
  keyof typeof agentEventPolicyManifest,
  AgentEventPolicyManifestEntry<string>['compactionPolicy']
>;

/**
 * Sanitization-policy projection from the Zod-free policy manifest.
 * Same Zod-free guarantee as the compaction projection above.
 */
export const SANITIZATION_POLICY_FROM_POLICY_MANIFEST = Object.fromEntries(
  Object.entries(agentEventPolicyManifest).map(([type, entry]) => [
    type,
    entry.sanitization,
  ]),
) as Record<
  keyof typeof agentEventPolicyManifest,
  AgentEventPolicyManifestEntry<string>['sanitization']
>;

/**
 * Look up the full per-variant policy axes from the Zod-free manifest.
 * Mirrors `policyFor` in `agentEventManifest.ts` but without the Zod
 * dependency, suitable for cloud-client / mobile bundles.
 */
export function policyFor<T extends keyof typeof agentEventPolicyManifest>(
  type: T,
) {
  return agentEventPolicyManifest[type];
}
