import { z } from 'zod';
import { AGENT_ERROR_KINDS } from '../../utils/agentErrorCatalog';
import { UserQuestionAnswerSchema, UserQuestionSchema } from '../../types/userQuestion';
import { FulfillmentProviderSchema } from '../../types/providerMetadata';
import { ThinkingEffortSchema, SessionOriginSchema, JsonValueSchema } from './common';
import { ExternalContext as ExternalContextSchema } from '@rebel/shared';
import { AgentErrorResolutionSchema, McpAppUiMetaSchema } from '../../contracts/agentEventManifest';
import { OUTPUT_SHAPE_BUCKETS } from '../../utils/outputShapeMetrics';
import { FINISH_LINE_MAX_LENGTH } from '@shared/utils/finishLine';
import { PROVIDER_CREDENTIAL_SOURCES } from '../../types/providerRoute';
import type {
  AgentSession as ManualAgentSession,
  AssetResolutionReason as ManualAssetResolutionReason,
} from '../../types/agent';

/** Agent attachment meta */
export const AgentAttachmentMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  relativePath: z.string(),
  size: z.number(),
});

/** Agent attachment payload (with content) */
export const AgentAttachmentPayloadSchema = AgentAttachmentMetaSchema.extend({
  content: z.string(),
});

/** Image attachment MIME types */
export const ImageAttachmentMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Document attachment MIME types (PDFs) */
export const DocumentAttachmentMimeTypeSchema = z.enum(['application/pdf']);

/** Office document attachment MIME types (DOCX, DOC, XLSX, XLS, PPTX, RTF) */
export const OfficeDocumentMimeTypeSchema = z.enum([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'text/rtf',
]);

/** Image attachment payload for sending images to the agent */
export const ImageAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('image'),
  mimeType: ImageAttachmentMimeTypeSchema,
  base64Data: z.string(),
  previewBase64Data: z.string().optional(),
  sizeBytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  originalPath: z.string().optional(),
});

/** Document attachment payload for sending PDFs to the agent */
export const DocumentAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('document'),
  mimeType: DocumentAttachmentMimeTypeSchema,
  base64Data: z.string(),
  sizeBytes: z.number(),
  pageCount: z.number().optional(),
  extractedText: z.string().optional(),
  originalPath: z.string().optional(),
});

/** Extracted PDF attachment payload (large PDF text extraction fallback) */
export const ExtractedPdfAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('extracted-pdf'),
  mimeType: DocumentAttachmentMimeTypeSchema,
  extractedText: z.string(),
  originalSizeBytes: z.number(),
  extractedSizeBytes: z.number(),
  base64Data: z.string().optional(),
  pageCount: z.number().optional(),
  originalPath: z.string().optional(),
});

/** Office document attachment payload (Word/Excel/PowerPoint/RTF with text extraction) */
export const OfficeDocumentAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('office'),
  mimeType: OfficeDocumentMimeTypeSchema,
  extractedText: z.string(),
  originalSizeBytes: z.number(),
  extractedSizeBytes: z.number(),
  base64Data: z.string().optional(),
  officeType: z.enum(['word', 'excel', 'powerpoint', 'rtf']),
  originalPath: z.string().optional(),
});

/** Text file attachment payload */
export const TextFileAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('textfile'),
  mimeType: z.string(),
  content: z.string(),
  originalSizeBytes: z.number(),
  contentSizeBytes: z.number(),
  originalPath: z.string().optional(),
});

/** Binary file attachment payload for unsupported extraction types (ZIP, video, audio, etc.) */
export const BinaryFileAttachmentPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('binary'),
  mimeType: z.string(),
  sizeBytes: z.number(),
  originalPath: z.string().optional(),
  base64Data: z.string().optional(),
});

/** Union of all attachment types */
export const AnyAttachmentPayloadSchema = z.union([
  AgentAttachmentPayloadSchema,
  ImageAttachmentPayloadSchema,
  DocumentAttachmentPayloadSchema,
  ExtractedPdfAttachmentPayloadSchema,
  OfficeDocumentAttachmentPayloadSchema,
  TextFileAttachmentPayloadSchema,
  BinaryFileAttachmentPayloadSchema,
]);

/** Agent turn request */
export const MeetingCompanionTriggerMetaSchema = z.object({
  triggerSource: z.enum(['voice-trigger', 'quick-ask-button']),
  triggerSourceSpeaker: z.string(),
  triggeredAt: z.number(),
  triggerExtracted: z.string().optional(),
});

/**
 * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3):
 * marker the renderer threads back into the next `agent:turn` after a
 * `userQuestion`/`continuation` accumulator has already injected context, so
 * the proactive prepend in `agentTurnExecute` does not double-inject.
 */
export const ContinuationContextMetaSchema = z.object({
  headerIncluded: z.boolean(),
  headerBytes: z.number().int().min(0),
  historyIncluded: z.boolean(),
  historyBytes: z.number().int().min(0),
  truncated: z.boolean(),
});
export const ContinuationContextHandoffSchema = z.object({
  /** Sentinel — signals the proactive prepend in agentTurnExecute to skip. */
  alreadyInjected: z.literal(true),
  meta: ContinuationContextMetaSchema,
});

export const AgentTurnRequestSchema = z.object({
  prompt: z.string(),
  sessionId: z.string(),
  /**
   * When set, the prior accumulator (e.g. continuation flow) has already
   * injected `<prior_turns>` + `<conversation_history>` into the prompt.
   * agentTurnExecute MUST skip its proactive prepend to avoid double
   * injection. See F3 in the planning doc.
   */
  continuationContext: ContinuationContextHandoffSchema.optional(),
  /** Client-generated idempotency key for this turn request (stable across retries). */
  clientTurnId: z.string().optional(),
  resetConversation: z.boolean().optional(),
  attachments: z.array(AnyAttachmentPayloadSchema).optional(),
  /**
   * Admission policy when the target session already has an active turn.
   * 'supersede' (default when absent): cancel the existing turn (legacy
   * server-side dedup / interrupt backstop). 'reject': refuse admission with
   * a typed error (`AGENT_TURN_TARGET_BUSY`) — a non-interrupt (queue-mode)
   * send must never abort an active turn. Absent-field parses (legacy
   * requests). See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 2.
   */
  supersedePolicy: z.enum(['supersede', 'reject']).optional(),
  /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
  privateMode: z.boolean().optional(),
  /** System continuation: skip clearing coaching when this turn is a system-initiated retry/continuation (e.g., memory approval, tool approval) */
  isSystemContinuation: z.boolean().optional(),
  /** 260622 Stage 4: bypass the Chief-of-Staff admission gate for this one turn (the "Run without my instructions" recovery escape). Never persisted. */
  proceedWithoutChiefOfStaff: z.boolean().optional(),
  /** Override the model for this turn only. Falls back to settings.models.model if not specified. */
  modelOverride: z.string().optional(),
  /** Override the thinking model for this turn only. Falls back to settings.models.thinkingModel if not specified. */
  thinkingModelOverride: z.string().optional(),
  /** Override the working profile for this turn only. Falls back to settings.models.workingProfileId if not specified. */
  workingProfileOverrideId: z.string().optional(),
  /** Override the thinking profile for this turn only. Falls back to settings.models.thinkingProfileId if not specified. */
  thinkingProfileOverrideId: z.string().optional(),
  /** Override the thinking effort for this turn only. Falls back to settings.models.thinkingEffort if not specified. */
  thinkingEffortOverride: ThinkingEffortSchema.optional(),
  /** Enable unleashed mode (looser auto-continue stopping criteria) for fire-and-forget tasks */
  unleashedMode: z.boolean().optional(),
  /** Session type: 'manual' for interactive UI, 'automation' for background tasks like onboarding discovery */
  sessionType: z.enum(['manual', 'automation']).optional(),
  /** Bypass tool safety evaluation (for automation sessions that use their own safety gate) */
  bypassToolSafety: z.boolean().optional(),
  /** Input source for this turn (voice vs text). Used for badge tracking. */
  inputSource: z.enum(['voice', 'text']).optional(),
  /** Activate council mode for this turn (dispatch parallel subagents on different model providers) */
  councilMode: z.boolean().optional(),
  /** Active Space path for prompt-time Operator discovery scoping. */
  activeSpacePath: z.string().nullable().optional(),
  /** Session origin hint — enables server-side context injection (e.g., 'focus' for Focus conversations). */
  origin: SessionOriginSchema.optional(),
  /** Cloud meeting session ID — injects rolling transcript context into the prompt for Ask Rebel during meetings. */
  meetingSessionId: z.string().optional(),
  /** Indicates a live meeting recording is active for this turn (used when cloud meeting id is not yet available). */
  recordingActive: z.boolean().optional(),
  /** Canonical metadata for companion turns started from an in-meeting trigger or quick-ask action. */
  triggerMeta: MeetingCompanionTriggerMetaSchema.optional(),
  /**
   * User-set success criterion for this turn. When present, takes precedence
   * over `AgentSession.finishLine` at admission time. See
   * `docs/plans/260515_finish_line.md`.
   */
  finishLine: z.string().max(FINISH_LINE_MAX_LENGTH).optional(),
  /**
   * External provenance for cloud-routed inbound turns (Slack thread / Slack
   * poll-mention). Populated by cloud-side webhook handlers so the resulting
   * session keeps the originating channel context after merge into the desktop
   * session graph. Manual desktop turns leave this unset.
   */
  externalContext: ExternalContextSchema.optional(),
  /**
   * Optional system-prompt prefix prepended to the resolved composite system
   * prompt for this turn. Used by Operator personalisation conversations to
   * seed the agent with the target Operator's persona context.
   */
  systemPromptPrefix: z.string().min(1).optional(),
});

/** Agent event schema */
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

/** Runtime-authored per-role model binding (annotation over modelUsage). @see ModelRoleBinding in shared/types/agent.ts */
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

export const ImageRefSchema = z.object({
  assetId: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnailAssetId: z.string().optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'missing']).optional(),
}).passthrough();

export const ContentRefSchema = z.object({
  contentId: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  summary: z.string().optional(),
  etag: z.string().optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'missing']).optional(),
}).passthrough();

export const KnownAssetResolutionReasonSchema = z.enum([
  'ok',
  'pending-sync',
  'not-found',
  'permission-denied',
  'mime-rejected',
  'corrupt',
  'oversized',
  'upload-failed',
  'quota-exceeded',
  'unknown',
]);

/**
 * Open-union schema per D12: accept known reason literals + forward-compatible
 * string codes without rejecting payloads at IPC/cloud boundaries.
 */
export const AssetResolutionReasonSchema = z.union([
  KnownAssetResolutionReasonSchema,
  z.string(),
]) as z.ZodType<ManualAssetResolutionReason>;

export const AssetResolutionContextSchema = z.enum([
  'hydrate',
  'protocol',
  'cloud-get',
  'lifecycle',
  'persist',
  'upload',
  'quota',
  'curation',
]);

export const ResolutionFailureSchema = z.object({
  timestamp: z.number(),
  sessionIdHash: z.string(),
  assetIdHash: z.string().optional(),
  reason: AssetResolutionReasonSchema,
  context: AssetResolutionContextSchema,
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

const ToolResultImageContentSourceSchema = z.object({
  type: z.literal('base64'),
  media_type: z.string(),
  data: z.string(),
});

const ToolResultImageContentBlockSchema = z.object({
  type: z.literal('image'),
  source: ToolResultImageContentSourceSchema.optional(),
  imageRef: ImageRefSchema.optional(),
}).passthrough();

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

const AgentEventSeqSchema = z.object({
  seq: z.number().int().positive().optional(),
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
} as const;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    message: z.string(),
    timestamp: z.number(),
    // Quit-vs-crash discriminator for synthetic turn-interruption statuses.
    // Optional: absent on regular statuses and pre-existing persisted events.
    // Must stay in parity with contracts/agentEventManifest.ts (parity-gated).
    source: z.enum(['shutdown', 'startup-correction']).optional(),
    // SOFT "still waiting" marker for an interactive awaiting_api stall (Stage 1b).
    // Optional + additive: present ONLY on the one-shot soft-stall status; absent
    // everywhere else (= today's behaviour). Must stay in parity with types/agent.ts
    // and contracts/agentEventManifest.ts (parity-gated).
    // @see src/core/services/watchdog/watchdogTracker.ts isAwaitingApiSoftStall
    stall: z.object({
      phase: z.literal('awaiting_api'),
      sinceMs: z.number(),
    }).optional(),
  }),
  z.object({
    type: z.literal('assistant'),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('result'),
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
      // contracts/agentEventManifest.ts. See docs/plans/260621_paid-fallback-indicator/.
      billingSource: z.enum(['subscription', 'pool', 'pay-per-use', 'local']).nullable().optional(),
    })).optional(),
    /** Runtime-authored per-role model bindings. Additive/optional (absent on legacy turns). */
    roles: z.array(ModelRoleBindingSchema).optional(),
    /** Why this turn ended. @see docs/plans/260415_silent_stop_detection_improvement.md */
    turnEndReason: z.enum(['completed', 'user_stopped', 'superseded', 'awaiting_user', 'error']).optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('tool'),
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
    contentRef: z.array(ContentRefSchema.nullable()).optional(),
    mcpAppUiMeta: McpAppUiMetaSchema.optional(),
    toolResult: z.object({
      content: z.array(z.union([ToolResultContentBlockSchema, z.unknown()])).optional(),
      structuredContent: z.unknown().optional(),
    }).optional(),
    _origin: z.enum(['real', 'synthetic-plan-seed', 'pre-turn-context']).optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    /**
     * Top-level raw upstream error body, populated by `dispatchAgentErrorEvent`
     * when `errorSource === 'main'` for **every** error kind (not just rate-limit
     * and billing). Redacted (Bearer/sk-/AIza/Authorization/api_key/JWT) and
     * truncated to 4 KB before persistence so eval diagnostics can recover the
     * provider's original message even when the humanized copy strips it.
     */
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
    /**
     * Set when `errorKind === 'managed_model_not_allowed'` so the renderer can
     * render the requested model and (when known) the allow-list without
     * re-parsing the raw upstream body. See
     * docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
     */
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
  }),
  z.object({
    type: z.literal('warning'),
    message: z.string(),
    category: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('user_question'),
    batchId: z.string(),
    toolUseId: z.string(),
    questions: z.array(UserQuestionSchema),
    // Authoritative origin session for this question. See
    // docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
    sessionId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('user_question_answered'),
    batchId: z.string(),
    answers: z.array(UserQuestionAnswerSchema),
    skipped: z.boolean().optional(),
    sessionId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('assistant_delta'),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('thinking_delta'),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('context_overflow'),
    originalPrompt: z.string(),
    timestamp: z.number(),
  }),
  /**
   * @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  z.object({
    type: z.literal('compaction_started'),
    depth: z.number(),
    sessionId: z.string(),
    timestamp: z.number(),
  }),
  /**
   * @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  z.object({
    type: z.literal('compaction_summary_ready'),
    summary: z.string(),
    depth: z.number(),
    timestamp: z.number(),
  }),
  /**
   * @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  z.object({
    type: z.literal('compaction_retrying'),
    depth: z.number(),
    timestamp: z.number(),
  }),
  /**
   * @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  z.object({
    type: z.literal('compaction_completed'),
    timestamp: z.number(),
  }),
  /**
   * @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md.
   */
  z.object({
    type: z.literal('compaction_failed'),
    error: z.string(),
    depth: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('recovery:started'),
    ...RecoveryCommonShape,
    phase: RecoveryPhaseSchema,
  }),
  z.object({
    type: z.literal('recovery:compacting'),
    ...RecoveryCommonShape,
  }),
  z.object({
    type: z.literal('recovery:summary_ready'),
    ...RecoveryCommonShape,
    summary: z.string(),
    revealDurationMs: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('recovery:retrying'),
    ...RecoveryCommonShape,
  }),
  z.object({
    type: z.literal('recovery:fallback_attempting'),
    ...RecoveryCommonShape,
    target: RecoveryTargetSchema,
  }),
  z.object({
    type: z.literal('recovery:fallback_succeeded'),
    ...RecoveryCommonShape,
    target: RecoveryTargetSchema,
  }),
  z.object({
    type: z.literal('recovery:skeleton_attempting'),
    ...RecoveryCommonShape,
  }),
  z.object({
    type: z.literal('recovery:depth4_attempting'),
    ...RecoveryCommonShape,
    profileId: z.string(),
    modelName: z.string(),
    costEstimate: z.literal('high'),
  }),
  z.object({
    type: z.literal('recovery:succeeded'),
    ...RecoveryCommonShape,
    finalDepth: z.number().int().min(0).max(4),
    totalDurationMs: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('recovery:failed'),
    ...RecoveryCommonShape,
    error: z.string(),
    exhaustedReason: RecoveryExhaustedReasonSchema,
  }),
  z.object({
    type: z.literal('recovery:last_resort_skipped'),
    ...RecoveryCommonShape,
    reason: z.enum(['no_qualifying_profile', 'rate_limited']),
    userFacingTitle: z.string(),
    userFacingMessage: z.string(),
    action: z.string(),
  }),
  z.object({
    type: z.literal('turn_superseded'),
    newTurnId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('user_message'),
    text: z.string(),
    isHidden: z.boolean().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('turn_started'),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('answer_phase_started'),
    timestamp: z.number(),
  }),
]).and(AgentEventSeqSchema);

type StripIndexSignature<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

type NormalizeAgentEventFromSchema<T> = T extends { type: 'tool' }
  ? StripIndexSignature<T>
  : T;

type AgentEventFromSchema = z.infer<typeof AgentEventSchema>;

export type AgentEvent = NormalizeAgentEventFromSchema<AgentEventFromSchema>;

/** Agent turn message */
export const AgentTurnMessageSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  role: z.enum(['user', 'assistant', 'result']),
  text: z.string(),
  usage: z.string().optional(),
  createdAt: z.number(),
  deletedAt: z.number().optional(),
  attachments: z.array(AgentAttachmentMetaSchema).optional(),
  isHidden: z.boolean().optional(),
  isApprovalReceipt: z.boolean().optional(),
  isWarning: z.boolean().optional(),
  attachmentTexts: z.record(z.string(), z.string()).optional(),
  messageOrigin: z.enum(['user-typed', 'queue-drain', 'system-continuation', 'voice', 'automation']).optional(),
  triggerSource: z.enum(['voice-trigger', 'quick-ask-button']).optional(),
  triggerSourceSpeaker: z.string().optional(),
  triggeredAt: z.number().optional(),
  triggerExtracted: z.string().optional(),
  displayText: z.string().optional(),
  endedWith: z.enum(['transient_error', 'superseded']).optional(),
});

/** Compaction boundary schema - marks where context was compacted */
export const CompactionBoundarySchema = z.object({
  afterMessageIndex: z.number(),
  summary: z.string(),
  timestamp: z.number(),
  depth: z.number(),
});

/** Memory update status schema */
export const MemoryUpdateStatusSchema = z.object({
  originalTurnId: z.string(),
  // Optional for persisted backwards compatibility; producer broadcasts require it.
  originalSessionId: z.string().optional(),
  status: z.enum(['running', 'success', 'error', 'skipped', 'pending_approval']),
  summary: z.string().optional(),
  entityUpdates: z.array(z.object({
    entity: z.string(),
    visibility: z.enum(['private', 'shared']),
    action: z.enum(['created', 'updated']),
    summary: z.string(),
    filePath: z.string().optional(),
    autoApproveReason: z.enum([
      'private_space', 'permissive_setting', 'space_override_permissive',
      'low_sensitivity', 'safety_prompt_allowed', 'pre_approved', 'remembered_choice',
    ]).optional(),
    sharing: z.enum(['private', 'restricted', 'company-wide', 'public']).optional(),
  })).optional(),
  error: z.string().optional(),
  timestamp: z.number(),
});

/** Broadcast payload schema — producer must always include originalSessionId. */
export const BroadcastMemoryUpdateStatusSchema = MemoryUpdateStatusSchema.extend({
  originalSessionId: z.string(),
});

/** Impact level schema for time-saved weighting */
export const ImpactLevelSchema = z.enum(['trivial', 'low', 'medium', 'high', 'critical', 'unknown']);

/** Time saved estimate schema (reusable) */
export const TimeSavedEstimateSchema = z.object({
  lowMinutes: z.number(),
  highMinutes: z.number(),
  confidence: z.enum(['low', 'medium', 'high']),
  taskType: z.enum(['research', 'writing', 'coordination', 'analysis', 'automation', 'mixed']),
  reasoning: z.string().optional(),
  reasoningDetail: z.string().optional(),
  impact: ImpactLevelSchema.optional(),
});

/** Time saved status schema */
export const TimeSavedStatusSchema = z.object({
  turnId: z.string(),
  // Optional for persisted backwards compatibility; producer broadcasts require it.
  originalSessionId: z.string().optional(),
  status: z.enum(['running', 'success', 'error']),
  estimate: TimeSavedEstimateSchema.optional(),
  actualDurationSeconds: z.number().optional(),
  error: z.string().optional(),
  timestamp: z.number(),
});

/** Broadcast payload schema — producer must always include originalSessionId. */
export const BroadcastTimeSavedStatusSchema = TimeSavedStatusSchema.extend({
  originalSessionId: z.string(),
});

/** Draft content schema for unsent composer text */
export const DraftContentSchema = z.object({
  text: z.string(),
  updatedAt: z.number(),
});

/** Pending conversation annotation schema */
export const ConversationAnnotationSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  text: z.string(),
  comment: z.string(),
  createdAt: z.number(),
  startOffset: z.number(),
  endOffset: z.number(),
});

export const SessionSetupContextSchema = z.object({
  kind: z.literal('bundled-app-bridge'),
  pairSessionId: z.string().optional(),
  /**
   * Pending bundled-app announcement state — surfaced after pairing succeeds /
   * expires / is cancelled. Mirrors `ManualAgentSession.setupContext.pendingAnnouncement`
   * (`src/shared/types/agent.ts` AgentSession.setupContext). Restored under S2-CI
   * after S2-CH's strengthened type-parity gate surfaced the prior silent drift.
   */
  pendingAnnouncement: z.object({
    status: z.enum(['connected', 'expired', 'cancelled']),
    emittedAt: z.number(),
  }).optional(),
});

/** Agent session schema */
export const AgentSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  cloudUpdatedAt: z.number().optional(),
  messages: z.array(AgentTurnMessageSchema),
  _deletedMessages: z.record(z.string(), z.number()).optional(),
  _destructiveOpsLedger: z.array(z.object({
    op: z.enum(['truncateTurn', 'deleteEventIdentity']),
    target: z.string(),
    appliedAt: z.number(),
  })).optional(),
  eventsByTurn: z.record(z.string(), z.array(AgentEventSchema)),
  quotaWarning: z.object({
    kind: z.enum(['asset-count-exceeded', 'asset-bytes-exceeded']),
    count: z.number().optional(),
    bytes: z.number().optional(),
  }).optional(),
  assetResolutionFailures: z.array(ResolutionFailureSchema).max(100).optional(),
  maxSeq: z.number().int().positive().optional(),
  activeTurnId: z.string().nullable(),
  isBusy: z.boolean(),
  lastError: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  /** Canonical lifecycle field (non-null = Done). */
  doneAt: z.number().nullable().optional(),
  starredAt: z.number().nullable().optional(),
  deletedAt: z.number().nullable().optional(),
  autoTitleGeneratedAt: z.number().optional(),
  autoTitleTurnCount: z.number().optional(),
  isCorrupted: z.boolean().optional(),
  origin: SessionOriginSchema.optional(),
  externalContext: ExternalContextSchema.optional(),
  /** Memory update status by original turn ID */
  memoryUpdateStatusByTurn: z.record(z.string(), MemoryUpdateStatusSchema).optional(),
  /** Time saved estimation status by turn ID */
  timeSavedStatusByTurn: z.record(z.string(), TimeSavedStatusSchema).optional(),
  /** One grounded sentence summarising what the agent did, keyed by turn ID. */
  activitySummaryByTurn: z.record(z.string(), z.string()).optional(),
  automationId: z.string().nullable().optional(),
  automationRunId: z.string().nullable().optional(),
  compactionBoundaries: z.array(CompactionBoundarySchema).optional(),
  /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
  privateMode: z.boolean().optional(),
  /** Turn ID that was interrupted when the app closed (for auto-resume on next startup) */
  interruptedTurnId: z.string().nullable().optional(),
  /** Draft content (unsent composer text) for crash resilience */
  draft: DraftContentSchema.optional(),
  /** Pending conversation annotations scoped to this session */
  annotations: z.array(ConversationAnnotationSchema).optional(),
  /** App/setup metadata tied to the conversation lifecycle */
  setupContext: SessionSetupContextSchema.optional(),
  /** Archive of tool call details preserved before in-memory compaction */
  toolDetailArchive: z.record(z.string(), z.object({
    toolName: z.string(),
    input: z.string(),
    output: z.string(),
    outputChars: z.number(),
  })).optional(),
  /** Per-conversation working model override (Claude model string, e.g. 'claude-opus-4-7') */
  sessionWorkingModel: z.string().optional(),
  /** Per-conversation thinking model override (Claude model string) */
  sessionThinkingModel: z.string().optional(),
  /** Per-conversation working profile override (ModelProfile id) */
  sessionWorkingProfileId: z.string().optional(),
  /** Per-conversation thinking profile override (ModelProfile id) */
  sessionThinkingProfileId: z.string().optional(),
  /** Per-conversation thinking effort override */
  sessionThinkingEffort: ThinkingEffortSchema.optional(),
  /** Meeting companion metadata (for meeting-linked conversations) */
  meetingCompanion: z.object({
    /** Meeting URL - stable identifier that survives bot retries */
    meetingUrl: z.string(),
    /** Current bot ID (may change on retry) */
    botId: z.string().optional(),
    /** Meeting title for display */
    meetingTitle: z.string(),
    /** When the companion session started */
    startedAt: z.number(),
    /** Path to prep notes file (if available) */
    prepPath: z.string().optional(),
    /** Coach configuration (optional) */
    coach: z.object({
      skillPath: z.string(),
      skillName: z.string(),
      showAllChecks: z.boolean().optional(),
    }).optional(),
    /** Tracks which coach was last injected (for re-injection on coach change) */
    lastInjectedCoachPath: z.string().nullable().optional(),
  }).optional(),
  /**
   * User-set success criterion for this conversation; fed into the
   * auto-continue evaluator and injected into the system prompt when set.
   * See `docs/plans/260515_finish_line.md`.
   */
  finishLine: z.string().max(FINISH_LINE_MAX_LENGTH).optional(),
  /**
   * Optional system-prompt prefix applied at every turn for this conversation.
   * Used by Operator personalisation to seed the agent with the operator's
   * persona context. Persists with the session.
   */
  systemPromptPrefix: z.string().min(1).optional(),
});
type AgentSessionFromSchema = z.infer<typeof AgentSessionSchema>;
export type AgentSession = Omit<AgentSessionFromSchema, 'eventsByTurn'> & {
  eventsByTurn: ManualAgentSession['eventsByTurn'];
};
