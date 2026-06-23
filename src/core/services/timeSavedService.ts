/**
 * Time Saved Estimation Service
 *
 * Estimates how much time a user saved by using Rebel for a task.
 * Runs as a fire-and-forget background process after turn completion.
 * Uses Sonnet with structured output for accurate, conservative estimates.
 */

import _axios from 'axios';
import type {
  AppSettings,
  BroadcastTimeSavedStatus,
  TimeSavedEstimate,
  ImpactLevel,
  CommunityShareEligibility,
} from '@shared/types';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import { addTimeSavedEntry, addTimeSavedEntryAt, hasTimeSavedEntryForTurn } from './timeSavedStore';
import { hasValidAuth } from '../utils/authEnvUtils';
import {
  getEffectiveModelName,
} from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { checkSessionEligibility } from './communityShareService';
import { humanizeAgentError } from '@rebel/shared';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  isOptedOut as isShareOptedOut,
  isSessionEvaluated as isShareEvaluated,
  markSessionEvaluated as markShareEvaluated,
  getDailyCount as getShareDailyCount,
  incrementDailyCount as incrementShareDailyCount,
  storeEligibility as storeShareEligibility,
} from './communityShareStore';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { BroadcastTimeSavedStatusSchema } from '@shared/ipc/schemas/agent';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { createUseCaseClient, type UseCaseClientSpec } from './bts/clients/useCaseClient';

const log = createScopedLogger({ service: 'timeSaved' });

type TimeSavedUnavailableReason = 'parse_failure' | 'invalid_structure' | 'error';

function emitTimeSavedUnavailable(
  reason: TimeSavedUnavailableReason,
  context: { sessionId: string; turnId: string; detail?: string },
): void {
  try {
    captureKnownCondition('time_saved_unavailable', {
      extra: {
        sessionId: context.sessionId,
        turnId: context.turnId,
        reason,
        detail: context.detail ?? null,
      },
    });
  } catch (emitError) {
    log.warn(
      { err: emitError instanceof Error ? emitError.message : String(emitError) },
      'Failed to emit time_saved_unavailable known condition',
    );
  }
}

const TIME_SAVED_TIMEOUT_MS = 30000;
const MIN_TURN_DURATION_MS = 30000; // Skip turns under 30 seconds

export interface TurnContextForTimeSaved {
  turnId: string;
  sessionId: string;
  userPrompt: string;
  finalSummary: string;
  toolSummary: string;
  durationSeconds: number;
}

export type TimeSavedDeps = {
  getSettings: () => AppSettings;
  broadcastTimeSavedStatus: (status: BroadcastTimeSavedStatus) => void;
  broadcastCommunityShareEligible: (sessionId: string, eligibility: CommunityShareEligibility) => void;
};

let deps: TimeSavedDeps | null = null;

export const initializeTimeSavedService = (dependencies: TimeSavedDeps): void => {
  deps = dependencies;
  log.info('Time saved service initialized');
};

function assertBroadcastHasOriginalSessionId(
  payload: BroadcastTimeSavedStatus,
  callsite: string,
): BroadcastTimeSavedStatus {
  const parsed = BroadcastTimeSavedStatusSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { callsite, issues: parsed.error.issues },
      'Time saved broadcast missing required originalSessionId',
    );
    throw new Error(`Invalid time saved broadcast payload at ${callsite}`);
  }
  return parsed.data;
}

export const buildTimeSavedPrompt = (context: TurnContextForTimeSaved): string => {
  return `You are a skeptical productivity consultant. Your estimates must be believable to a user who wasn't impressed with the output. You would rather undersell than oversell.

Estimate how long it would take a human to produce a FINAL OUTPUT that actually satisfies the user's request—not to replicate the assistant's steps.

## CRITICAL: ESTIMATE VALUE, NOT ACTIVITY
- Activity is NOT value. Tool calls and time spent do NOT equal user benefit.
- If 10 tools were used to find 1 fact, estimate finding 1 fact (<1 min), NOT using 10 tools.
- Ignore the assistant's completion time—a slow agent does NOT mean a hard task.
- Ask: "Would a skeptical user who wasn't impressed agree with this estimate?"

## First decide if the work is actually usable
- If the user could use the result largely as-is, estimate the manual effort for that deliverable.
- If the user would discard it, redo it from scratch, or it is only rough notes with no reusable synthesis, return 0 minutes.
- If the user could reuse the structure, summary, or hypotheses as a starting point, give a small non-zero estimate instead of forcing 0.
- A sourced summary, structured outline, or risk/options list counts as reusable synthesis even if later validation is still needed.
- Polished output in the wrong direction still counts as 0.
- If a human could do it in under 1 minute, set BOTH estimate_minutes_low and estimate_minutes_high to 0.

## Return 0 minutes when:
- A human could do this in under 1 minute (simple lookups, fact checks, one-click operations)
- The output is incomplete, uncertain, clearly tentative, or needs major validation before use
- The assistant answered a different question or went in the wrong direction
- The work was abandoned before a concrete deliverable was produced
- Brainstorming or exploration produced ideas/notes but no directly reusable deliverable
- Output would require substantial rework to be usable
- The response indicates failure ("I can't", "unable", "need more info")
- This was meta-conversation about preferences, configuration, or the assistant itself
- **AI-only overhead**: Work that wouldn't have been necessary without AI (setting up integrations, customizing prompts, troubleshooting AI issues, teaching the system preferences). If the user wouldn't have spent time on this without the AI, it's not time saved.

## User Request
${context.userPrompt}

## What Was Done
${context.finalSummary}

## Tools Used (ignore this for complexity—more tools ≠ more value)
${context.toolSummary}

## Calibration (for SUCCESSFUL, VALUABLE output only)
- Quick lookup / fact check / contact lookup: 0-5 min (0 if a single search or glance suffices)
- Simple file search: 1-3 min
- Short email (no research): 2-5 min
- Meeting follow-up or status update from existing notes: 5-12 min
- Email with research: 10-20 min
- Multi-vendor comparison from public info: 20-60 min
- Structured draft from known context (job description, report outline, formatted summary): 15-45 min
- Data extraction / formatting from messy notes: 10-30 min
- Basic meeting prep: 15-30 min
- Board / exec outline from existing source material: 45-120 min
- Comprehensive meeting prep: 30-60 min
- Strategic analysis: 90-180 min

## For low-value outcomes, use these instead:
- Partial output that materially shortens the next step: 1-5 min
- Brainstorming without a concrete deliverable: 0 min
- Exploratory synthesis with concrete facts, structure, or sourced estimates: 5-20 min
- Wrong direction / needs redo from scratch: 0 min

## Confidence calibration
- high: Complete, correct, directly usable, little or no verification/rework needed
- medium: Partially useful, limited in scope, or needs some checking/editing
- low: Tentative, exploratory, incomplete, or likely needs major verification/rework
- Never use "high" for wrong-direction, abandoned, or clearly tentative outputs. Correct trivial lookups may still be "high".
- If the assistant explicitly says key data was missing or the task could not be fully completed, confidence cannot be "high".
- Exploratory research or "general sense" summaries are usually "medium", not "high", unless it is a simple static fact lookup.
- High confidence is rare: use it only for directly usable output or a clearly correct trivial lookup, not for incomplete research or "couldn't find it" outcomes.

## Impact Assessment

Rate the organizational impact of what was delivered.

IMPORTANT: Impact is independent of time. A 2-minute task can be critical. A 2-hour task can be trivial. Rate based on organizational consequence, not effort.
- If the work should be 0 because it was wrong-direction, AI-only overhead, or busywork, impact should usually be "trivial".
- Preliminary work on an important business question can still be "medium" or "high" impact when it produced a reusable synthesis. If it produced no usable deliverable, keep impact "trivial" or "low".

- critical: Strategic, high-stakes, or unlocks others' work. Examples: board presentation, contract negotiation prep, crisis response.
- high: Important deliverable with real consequence. Examples: client-facing email, meeting prep for key stakeholder, polished report.
- medium: Standard work task, expected output. This is the baseline—most tasks are medium. Examples: internal status update, routine research, draft for review.
- low: Nice-to-have, no deadline or direct consequence. Examples: organizing files, exploratory brainstorming, "just curious" research.
- trivial: Work that shouldn't have been done, or has no real benefit. Examples: premature optimization, solving the wrong problem, busywork.

Default to "medium" when uncertain. Only use "critical" for genuinely high-stakes work.

## Output format for reasoning fields

"reasoning": A single sentence describing what the user accomplished. Lead with the outcome, not the process. Be specific — mention names, numbers, or domains when available. This is shown to the user as a record of their work, so make them feel good about what they got done without being sycophantic.

Good: "Competitive analysis across 5 vendors with full pricing matrix and recommendation"
Good: "Meeting prep for the Acme board review — attendee research, agenda, talking points"
Bad: "Drafted a document for user" (too vague)
Bad: "Compiled an incredibly amazing analysis!!!" (sycophantic)

"reasoning_detail": The manual effort justification — approach taken, why it was non-trivial, time estimate breakdown. One paragraph. Shown in detailed/expanded views only.

Example: "Finding the meeting transcript, reviewing CRM history for context, drafting personalized talking points. Manual effort: 15-25 min."

## IMPORTANT
- Default to 0 when uncertain. Not claiming credit is better than overclaiming.
- If confidence is "low", keep estimates under 15 minutes unless output is obviously substantial.
- Failed, wrong-direction, or abandoned tasks = 0 minutes.
- Exploratory work only gets >0 if it produced a clearly reusable synthesis or summary.`;
};

const VALID_IMPACT_LEVELS = ['trivial', 'low', 'medium', 'high', 'critical'] as const;
const VALID_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
const VALID_TASK_TYPES = ['research', 'writing', 'coordination', 'analysis', 'automation', 'mixed'] as const;

export const TimeSavedWireOutputSchema = z.object({
  estimate_minutes_low: z
    .number()
    .describe('Conservative lower bound of estimated manual time in minutes.'),
  estimate_minutes_high: z
    .number()
    .describe('Upper bound of estimated manual time in minutes.'),
  confidence: z
    .enum(VALID_CONFIDENCE_LEVELS)
    .describe('Confidence in the estimate based on task clarity.'),
  task_type: z
    .enum(VALID_TASK_TYPES)
    .describe('Primary category of the task.'),
  reasoning: z
    .string()
    .describe('One sentence describing the outcome the user accomplished.'),
  reasoning_detail: z
    .string()
    .describe('Manual effort justification paragraph for detailed views.'),
  impact: z
    .enum(VALID_IMPACT_LEVELS)
    .describe('Organizational impact level of the deliverable.'),
});

export type TimeSavedWireOutput = z.infer<typeof TimeSavedWireOutputSchema>;

type TimeSavedRawResponse = Partial<TimeSavedWireOutput> & Record<string, unknown>;

type TimeSavedParseResult =
  | { kind: 'success'; estimate: TimeSavedEstimate }
  | { kind: 'parse_failure' }
  | { kind: 'invalid_structure'; detail?: string };

const asNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const normalizeTimeSavedModelResponse = (data: unknown): unknown => {
  if (!data || typeof data !== 'object') return data;

  const response = data as TimeSavedRawResponse;
  const nestedEstimate =
    response.estimate && typeof response.estimate === 'object'
      ? response.estimate as Record<string, unknown>
      : {};

  const exactMinutes = asNumber(
    response.estimate_minutes,
    response.estimateMinutes,
    response.minutes,
    nestedEstimate.minutes,
    nestedEstimate.midpoint,
  );

  const lowMinutes = asNumber(
    response.estimate_minutes_low,
    response.estimateMinutesLow,
    response.lowMinutes,
    response.low,
    nestedEstimate.lowMinutes,
    nestedEstimate.low,
    exactMinutes,
  );
  const highMinutes = asNumber(
    response.estimate_minutes_high,
    response.estimateMinutesHigh,
    response.highMinutes,
    response.high,
    nestedEstimate.highMinutes,
    nestedEstimate.high,
    exactMinutes,
  );

  const rawConfidence = typeof response.confidence === 'string' ? response.confidence.toLowerCase() : '';
  const confidence = VALID_CONFIDENCE_LEVELS.includes(rawConfidence as typeof VALID_CONFIDENCE_LEVELS[number])
    ? rawConfidence as TimeSavedWireOutput['confidence']
    : null;
  const rawTaskType = typeof response.task_type === 'string'
    ? response.task_type
    : typeof response.taskType === 'string'
      ? response.taskType
      : '';
  const taskType = VALID_TASK_TYPES.includes(rawTaskType as typeof VALID_TASK_TYPES[number])
    ? rawTaskType as TimeSavedWireOutput['task_type']
    : 'mixed';
  const reasoning = typeof response.reasoning === 'string'
    ? response.reasoning
    : typeof response.summary === 'string'
      ? response.summary
      : typeof response.description === 'string'
        ? response.description
        : null;
  const normalizedReasoning = reasoning === '' ? null : reasoning;
  
  const impact: ImpactLevel = VALID_IMPACT_LEVELS.includes(response.impact as typeof VALID_IMPACT_LEVELS[number])
    ? response.impact as ImpactLevel
    : 'medium';

  return {
    estimate_minutes_low: lowMinutes,
    estimate_minutes_high: highMinutes,
    confidence,
    task_type: taskType,
    reasoning: normalizedReasoning,
    reasoning_detail: typeof response.reasoning_detail === 'string' ? response.reasoning_detail : '',
    impact,
  };
};

const toTimeSavedEstimate = (output: TimeSavedWireOutput): TimeSavedEstimate => {
  return {
    lowMinutes: output.estimate_minutes_low,
    highMinutes: output.estimate_minutes_high,
    confidence: output.confidence,
    taskType: output.task_type,
    reasoning: output.reasoning,
    reasoningDetail: output.reasoning_detail,
    impact: output.impact,
  };
};

export const timeSavedUseCaseSpec = {
  name: 'timeSaved',
  category: 'timeSaved',
  outputSchema: TimeSavedWireOutputSchema,
  buildPrompt: (context) => ({
    codexConnectivity: resolveCodexConnectivity(),
    messages: [{ role: 'user', content: buildTimeSavedPrompt(context) }],
    maxTokens: 512,
    timeout: TIME_SAVED_TIMEOUT_MS,
  }),
  parseTextToJson: ({ text }) => safeJsonParseFromModelText<unknown>(text, 'timeSaved.estimate', log),
  normalizeParsedJson: ({ parsedJson }) => normalizeTimeSavedModelResponse(parsedJson),
  buildInvalidStructureDetail: ({ rawParsedJson }) => {
    if (rawParsedJson && typeof rawParsedJson === 'object') {
      return Object.entries(rawParsedJson as Record<string, unknown>)
        .slice(0, 12)
        .map(([key, value]) => `${key}:${Array.isArray(value) ? 'array' : typeof value}`)
        .join(',');
    }
    return typeof rawParsedJson;
  },
  getRetryModelOnFailure: ({ input, settings, failureKind, resolvedModel }) => {
    if (failureKind !== 'invalid_structure') {
      return null;
    }
    const primaryResolvedModel = resolvedModel || getEffectiveModelName(settings);
    const fallbackModel = resolveBtsModel(settings, 'timeSaved');
    if (primaryResolvedModel === fallbackModel) {
      return null;
    }
    log.warn(
      { turnId: input.turnId, originalModel: primaryResolvedModel, fallbackModel },
      'Time saved estimate had invalid structure — retrying with timeSaved BTS resolver model',
    );
    return fallbackModel;
  },
} satisfies UseCaseClientSpec<TurnContextForTimeSaved, TimeSavedWireOutput>;

const timeSavedClient = createUseCaseClient(timeSavedUseCaseSpec);

export const TIME_SAVED_JSON_SCHEMA = timeSavedClient.wireOutputSchema;

/**
 * Run the BTS-based estimator for a turn and return the parsed estimate or a
 * typed failure reason. Pure of broadcast/persist side effects — the trigger
 * path layers those on top, and the backfill path uses the bare estimator
 * directly so it can write a timestamp-preserving entry without producing
 * UI noise for sessions the user is not currently viewing.
 *
 * The structured-output schema-invalid retry against the resolver-selected
 * time-saved BTS model is kept inside this helper so every caller benefits from
 * the same fallback policy described in
 * `docs-private/investigations/260520_time_saved_zero_or_missing.md`.
 */
const estimateTimeSavedForTurn = async (
  settings: AppSettings,
  context: TurnContextForTimeSaved,
): Promise<TimeSavedParseResult> => {
  const trackingMeta = { sessionId: context.sessionId, turnId: context.turnId };

  const parseResult = await timeSavedClient.run(settings, context, {
    tracking: {
      ...trackingMeta,
    },
  });

  switch (parseResult.kind) {
    case 'no_text':
      throw new Error(parseResult.detail ?? 'No text content in response');
    case 'parse_failure':
      return { kind: 'parse_failure' };
    case 'invalid_structure':
      return { kind: 'invalid_structure', detail: parseResult.detail };
    case 'success':
      return { kind: 'success', estimate: toTimeSavedEstimate(parseResult.value) };
  }
};

export const triggerTimeSavedEstimation = async (context: TurnContextForTimeSaved): Promise<void> => {
  log.info({ turnId: context.turnId, durationSeconds: context.durationSeconds }, 'triggerTimeSavedEstimation called');
  
  if (!deps) {
    log.warn('Time saved service not initialized - deps is null');
    return;
  }

  const settings = deps.getSettings();

  // Check if feature is enabled (default: true)
  if (settings.timeSavedEstimation?.enabled === false) {
    log.debug('Time saved estimation disabled in settings');
    return;
  }

  // Skip trivial turns
  if (context.durationSeconds < MIN_TURN_DURATION_MS / 1000) {
    log.debug({ durationSeconds: context.durationSeconds }, 'Skipping time saved estimation for short turn');
    return;
  }

  if (!hasValidAuth(settings)) {
    log.warn('Cannot estimate time saved: no valid auth');
    return;
  }

  const { turnId } = context;
  log.info({ turnId }, 'Triggering time saved estimation');

  deps.broadcastTimeSavedStatus(
    assertBroadcastHasOriginalSessionId(
      {
        turnId,
        originalSessionId: context.sessionId,
        status: 'running',
        timestamp: Date.now(),
      },
      'triggerTimeSavedEstimation:running',
    ),
  );

  try {
    log.debug({ model: getEffectiveModelName(settings) }, 'Calling LLM for time saved estimate');

    const parseResult = await estimateTimeSavedForTurn(settings, context);

    if (parseResult.kind === 'parse_failure') {
      // No entry is written, but the renderer must see a terminal status so
      // weekly aggregate consumers refresh and the modal can distinguish
      // unavailable-this-turn from a true zero. See
      // docs-private/investigations/260520_time_saved_zero_or_missing.md — without the
      // terminal broadcast, parse failures masquerade as `0 min` in the hero.
      log.debug({ turnId }, 'Skipping time saved estimation due to non-JSON response');
      emitTimeSavedUnavailable('parse_failure', { sessionId: context.sessionId, turnId });
      deps.broadcastTimeSavedStatus(
        assertBroadcastHasOriginalSessionId(
          {
            turnId,
            originalSessionId: context.sessionId,
            status: 'error',
            error: 'Time saved estimate unavailable for this turn.',
            timestamp: Date.now(),
          },
          'triggerTimeSavedEstimation:parse_failure',
        ),
      );
      return;
    }

    if (parseResult.kind === 'invalid_structure') {
      emitTimeSavedUnavailable('invalid_structure', { sessionId: context.sessionId, turnId, detail: parseResult.detail });
      throw new Error('Invalid response structure');
    }

    const { estimate } = parseResult;

    log.info(
      { turnId, lowMinutes: estimate.lowMinutes, highMinutes: estimate.highMinutes, taskType: estimate.taskType, impact: estimate.impact },
      'Time saved estimation completed'
    );

    // Persist to store for cumulative tracking
    const writeResult = addTimeSavedEntry(turnId, context.sessionId, estimate);

    // Emit a per-turn analytics event mirroring `Cost Incurred`
    // (costLedgerService.ts) so time-saved unifies downstream like cost — the
    // daily aggregate (`Daily Time Saved Summary`) alone can't reconstruct
    // per-call data. SINGLE EMIT SITE: this is the shared
    // `triggerTimeSavedEstimation` path, which runs once per turn on whichever
    // surface executes the turn AND has the service initialized — the single
    // emit / no-double-count design holds across surfaces by construction.
    // CAVEAT (260619): today the service is initialized (initializeTimeSavedService)
    // ONLY in the desktop main process (src/main/index.ts); it is NOT wired in
    // cloud-service/src/bootstrap.ts, so on a cloud/mobile-executed turn this
    // function hits the deps-null guard near the top and returns before reaching
    // here — i.e. cloud-executed turns do not currently emit this event or a
    // time-saved:status broadcast. The "mobile turns execute on cloud → tagged
    // client_surface:'cloud'" behavior is the intended shape once cloud wiring
    // lands, not current behavior. No second emit anywhere — this is the only
    // per-turn time-saved event, by design (no double-count across surfaces).
    // Categorical/metric props only — no free-text reasoning. `client_surface`
    // auto-attaches via the merge.
    //
    // GATED ON PERSISTED ACCEPTANCE: only emit when the store actually wrote the
    // entry (`added: true`). If the store rejected the write (a same-turn
    // `duplicate`, or `read_only` protective mode), do NOT emit — otherwise the
    // analytics count would diverge from persisted turns and double-count
    // retries. One event per persisted turn.
    if (writeResult.added) {
      try {
        const tracker = getTracker();
        if (tracker.isAvailable()) {
          tracker.track('Time Saved Estimated', {
            turnId,
            sessionId: context.sessionId,
            lowMinutes: estimate.lowMinutes,
            highMinutes: estimate.highMinutes,
            taskType: estimate.taskType,
            confidence: estimate.confidence,
            ...(estimate.impact ? { impact: estimate.impact } : {}),
          });
        }
      } catch (err) {
        log.warn(
          { err, turnId, sessionId: context.sessionId },
          'Failed to emit Time Saved Estimated analytics'
        );
        // Fire-and-forget — never block the turn path.
      }
    }

    // Inline community share eligibility check — fires immediately when threshold crossed
    if (!isShareOptedOut() && !isShareEvaluated(context.sessionId) && getShareDailyCount() < 1) {
      const eligibility = checkSessionEligibility(context.sessionId);
      if (eligibility) {
        markShareEvaluated(context.sessionId);
        storeShareEligibility(eligibility);
        incrementShareDailyCount();
        deps.broadcastCommunityShareEligible(context.sessionId, eligibility);
        log.info({ sessionId: context.sessionId, timeSaved: eligibility.timeSavedMinutes }, 'Community share eligibility triggered inline');
      }
    }

    deps.broadcastTimeSavedStatus(
      assertBroadcastHasOriginalSessionId(
        {
          turnId,
          originalSessionId: context.sessionId,
          status: 'success',
          estimate,
          actualDurationSeconds: context.durationSeconds,
          timestamp: Date.now(),
        },
        'triggerTimeSavedEstimation:success',
      ),
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Stage 7 migration: classification-first humanization. See docs/plans/260421.
    const humanizedError = humanizeAgentError(
      error instanceof ModelError
        ? {
            kind: 'classified',
            errorKind: error.__agentErrorKind,
            rawMessage: error.__rawMessage,
            provider: error.provider,
            upstreamProviderName: error.upstreamProvider,
          }
        : { kind: 'unclassified', rawMessage: errorMessage },
    );
    const axiosError = error as { response?: { data?: unknown; status?: number } };
    log.warn(
      { turnId, error: humanizedError, status: axiosError.response?.status, responseData: axiosError.response?.data },
      'Time saved estimation failed'
    );

    if (errorMessage !== 'Invalid response structure') {
      emitTimeSavedUnavailable('error', {
        sessionId: context.sessionId,
        turnId,
        detail: errorMessage.slice(0, 200),
      });
    }

    deps.broadcastTimeSavedStatus(
      assertBroadcastHasOriginalSessionId(
        {
          turnId,
          originalSessionId: context.sessionId,
          status: 'error',
          error: humanizedError,
          timestamp: Date.now(),
        },
        'triggerTimeSavedEstimation:error',
      ),
    );
  }
};

export const getEstimateMidpoint = (estimate: TimeSavedEstimate): number => {
  return Math.round((estimate.lowMinutes + estimate.highMinutes) / 2);
};

export const formatEstimateForDisplay = (estimate: TimeSavedEstimate): string => {
  const midpoint = getEstimateMidpoint(estimate);
  if (midpoint < 60) {
    return `${midpoint} min`;
  }
  const hours = midpoint / 60;
  if (hours < 10) {
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(hours)}h`;
};

/**
 * Outcome of an attempt to recover a single missed time-saved entry. The
 * backfill service aggregates these per-turn outcomes into a run summary.
 */
export type RecoverTimeSavedOutcome =
  | { status: 'persisted'; estimate: TimeSavedEstimate; timestamp: number }
  | {
      status:
        | 'skipped_disabled'
        | 'skipped_short'
        | 'skipped_no_auth'
        | 'skipped_duplicate'
        | 'parse_failure'
        | 'invalid_structure'
        | 'error'
        | 'not_initialized';
      detail?: string;
    };

/**
 * Recover a missed time-saved entry for a past turn.
 *
 * Mirrors the gating in {@link triggerTimeSavedEstimation} so the same
 * conservative estimation policy applies (estimation must be enabled, the
 * turn must be long enough, valid auth must be present). Differs in two
 * important ways: it preserves the original turn timestamp via
 * {@link addTimeSavedEntryAt}, and it intentionally does NOT broadcast a
 * `BroadcastTimeSavedStatus` — the live UI is not waiting on a status for
 * a turn that completed weeks ago, and emitting one would mis-route through
 * the cross-session provenance logic. Community-share evaluation is also
 * skipped: a backfilled entry should not trigger a fresh share toast.
 *
 * See docs-private/investigations/260520_time_saved_zero_or_missing.md for the
 * recovery design notes.
 */
export const recoverTimeSavedEntryForTurn = async (
  context: TurnContextForTimeSaved,
  originalTimestamp: number,
): Promise<RecoverTimeSavedOutcome> => {
  if (!deps) {
    log.warn('Time saved service not initialized — cannot recover entry');
    return { status: 'not_initialized' };
  }

  const settings = deps.getSettings();

  if (settings.timeSavedEstimation?.enabled === false) {
    return { status: 'skipped_disabled' };
  }

  if (context.durationSeconds < MIN_TURN_DURATION_MS / 1000) {
    return { status: 'skipped_short' };
  }

  if (!hasValidAuth(settings)) {
    return { status: 'skipped_no_auth' };
  }

  // Cheap pre-check avoids burning an LLM call on a turn that is already
  // represented in the store. The store-level dedup in writeTimeSavedEntry()
  // is the authoritative safety net; this is a perf optimisation.
  if (hasTimeSavedEntryForTurn(context.turnId)) {
    return { status: 'skipped_duplicate' };
  }

  try {
    const parseResult = await estimateTimeSavedForTurn(settings, context);

    if (parseResult.kind === 'parse_failure') {
      emitTimeSavedUnavailable('parse_failure', {
        sessionId: context.sessionId,
        turnId: context.turnId,
        detail: 'recover',
      });
      return { status: 'parse_failure' };
    }

    if (parseResult.kind === 'invalid_structure') {
      emitTimeSavedUnavailable('invalid_structure', {
        sessionId: context.sessionId,
        turnId: context.turnId,
        detail: parseResult.detail ? `recover:${parseResult.detail}` : 'recover',
      });
      return { status: 'invalid_structure', detail: parseResult.detail };
    }

    const { estimate } = parseResult;
    const writeResult = addTimeSavedEntryAt(context.turnId, context.sessionId, estimate, originalTimestamp);

    if (!writeResult.added) {
      return { status: 'skipped_duplicate', detail: writeResult.reason };
    }

    log.info(
      {
        turnId: context.turnId,
        sessionId: context.sessionId,
        lowMinutes: estimate.lowMinutes,
        highMinutes: estimate.highMinutes,
        impact: estimate.impact,
        originalTimestamp,
      },
      'Recovered time saved entry for past turn',
    );

    return { status: 'persisted', estimate, timestamp: writeResult.timestamp };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn({ turnId: context.turnId, sessionId: context.sessionId, error: errorMessage }, 'Recover time saved entry failed');
    if (errorMessage !== 'Invalid response structure') {
      emitTimeSavedUnavailable('error', {
        sessionId: context.sessionId,
        turnId: context.turnId,
        detail: errorMessage.slice(0, 200),
      });
    }
    return { status: 'error', detail: errorMessage.slice(0, 200) };
  }
};
