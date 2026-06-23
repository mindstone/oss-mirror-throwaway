/**
 * Structured-output fallback orchestration for the Behind-The-Scenes client.
 *
 * Stage 8 of the hotspot-refactor roadmap (PLAN.md Hotspot 3). Extracted verbatim
 * from `behindTheScenesClient.ts` — the three-branch structured-output fallback
 * ladder (profile-flag bypass; catch-branch JSON-capability reroute; post-response
 * parse-failure reroute with strike counter), plus its dedicated helpers, the
 * sink-boundary model decode backstop, the per-profile parse-failure strike
 * counter, the one-shot bypass notification, and the `bts_structured_output_fallback`
 * Sentry emit.
 *
 * Behaviour is preserved EXACTLY: `executeWithStructuredOutputProfileFallback`
 * keeps its 5-arg signature and `ExecutedBtsCall` return contract (pinned by
 * `behindTheScenesClient.structuredOutputFallback.test.ts` + the invariant suite),
 * and `behindTheScenesClient.ts` re-exports the public names so no consumer changes.
 *
 * ── F4 (catch-branch discrimination, invariants 7-9) ─────────────────────────
 * The catch-branch reroute executes ONLY when `isStructuredOutputCapabilityError`
 * is true — an allow-list gate that excludes rate_limit / auth / billing /
 * moderation / server_error / context_overflow / model_unavailable / abort /
 * transient network / chat-incompatibility / aborted signals. Everything else
 * rethrows so the caller sees the real operational error, never a silent reroute
 * to Claude (AGENTS.md "Silent failure is a bug"; PMs 260428 silent-reroute +
 * c2-marker-overbroad). The sticky `markProfileJsonIncompatible` mutation is gated
 * by the same allow-list (catch branch) or by `JSON_PARSE_FAILURE_STRIKE_THRESHOLD`
 * consecutive failures (parse-failure branch, PM 260521 Haiku-fallback DA), and
 * skips Codex auto-profiles (invariant 10, enforced in `profileCompatibility.ts`).
 *
 * Process-scoped state (`_jsonParseFailureStrikes` Map, `_notifiedBypassProfileIds`
 * Set, `_emittedBypassProfileIds` Set) lives here as single module-level
 * singletons — PLAN.md §"Ambient Behaviors" forbids splitting these per module
 * without preservation.
 *
 * Platform-agnostic by contract: lives in `src/core/` (inherited by cloud + mobile).
 * MUST NOT import `electron`, `@main/*`, or `@renderer/*`.
 */

import { type ModelProfile } from '@shared/types';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
import { PROFILE_PREFIX, stripStoredModelPrefix } from '@shared/utils/modelChoiceCodec';
import { createScopedLogger } from '@core/logger';
import { classifyError, isChatIncompatibilityError, type ModelErrorKind } from '@core/rebelCore/modelErrors';
import { isProfileReference, profileReferenceId } from '@core/rebelCore/providerRouteDecision';
import { captureKnownCondition, recordKnownConditionLedgerOnly } from '@core/sentry/captureKnownCondition';
import { getBroadcastService } from '@core/broadcastService';
import {
  BTS_STRUCTURED_OUTPUT_BYPASS_CHANNEL,
  BtsStructuredOutputBypassPayloadSchema,
} from '@shared/ipc/channels/bts';
import type { AuxiliaryCostCategory } from '../costLedgerService';
import { markProfileJsonIncompatible } from './profileCompatibility';
import {
  type BehindTheScenesRequestOptions,
  type BehindTheScenesResponse,
  isTransientNetworkError,
} from './transports/shared';
import type { BtsDegradedReason } from './types';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

/**
 * Process-global, profileId-keyed Sentry dedupe for steady-state bypass noise.
 *
 * Profile IDs are not globally unique (some are deterministic, e.g. `codex-*`
 * / `auto:`), so this relies on cloud-service being single-user-per-process
 * today (one AUTH_TOKEN / one REBEL_USER_DATA; see `cloud-service/src/auth.ts`
 * and `cloud-service/src/bootstrap.ts`). If cloud ever runs multiple tenants in
 * one process, this dedupe and its Sentry signal must become session/user-scoped.
 */
const _emittedBypassProfileIds = new Set<string>();

/**
 * Result of one fully-resolved BTS call attempt — the contract between the
 * structured-output fallback orchestration and the per-entry-point execution
 * closures. (Internal dispatch-core shape; the public entry points unwrap
 * `.response` to a `BehindTheScenesResponse` at the boundary.)
 */
export interface ExecutedBtsCall {
  response: BehindTheScenesResponse;
  resolvedModel: string;
  profile: ModelProfile | null;
  resolvedAuth?: string;
  usedOperationalFallback?: boolean;
}

/** Sink-boundary backstop. Strips the codec's `model:` storage prefix and emits
 *  a structured warning when stripping was necessary. This is the last-resort
 *  guard against direct-read bypasses; per-site decoders (S2) should normally
 *  have stripped this already. A warn emission from this helper means a new
 *  bypass site exists. */
export function decodeSinkBoundaryModel(rawModel: string, sinkName: string): string | null {
  const decoded = stripStoredModelPrefix(rawModel);
  if (isProfileReference(rawModel)) {
    return decoded ? `${PROFILE_PREFIX}${decoded}` : null;
  }
  if (decoded !== rawModel) {
    log.warn(
      { sinkName, rawTruncated: rawModel.slice(0, 32) },
      'sink-boundary backstop stripped a `model:` prefix — upstream caller bypassed S2; investigate',
    );
  }
  return decoded;
}

/**
 * Resolve a model profile from a `profile:<id>` encoded model string.
 * Returns null if the model string is not profile-encoded or the profile doesn't exist.
 */
export function resolveProfileFromModel(
  model: string,
  profiles: ModelProfile[] | undefined
): ModelProfile | null {
  if (!isProfileReference(model)) return null;
  const profileId = profileReferenceId(model) ?? '';
  if (!profiles?.length) return null;
  return profiles.find(p => p.id === profileId) ?? null;
}

// ─── Structured-output parse-failure strike counter ─────────────────────────
/**
 * Per-profile counter of consecutive structured-output parse failures observed
 * in the post-response (200 OK, non-JSON body) fallback path.
 *
 * Why: the catch-branch path can gate sticky marking with
 * `isStructuredOutputCapabilityError`, because it has a real provider error to
 * inspect. The parse-failure path has no error — only a parseable-but-not-JSON
 * 200 response, which can result from a transient model hiccup, brief tool
 * overflow, or a one-shot prompt-formatting glitch rather than a true capability
 * gap. To avoid stickying the flag on a single transient failure (DA finding for
 * the 260521 BTS Haiku-fallback bug), we require
 * `JSON_PARSE_FAILURE_STRIKE_THRESHOLD` consecutive parse failures before marking.
 * The counter resets on the first parseable response.
 *
 * Process-scoped state — single module-level Map (PLAN.md §Ambient Behaviors).
 */
const JSON_PARSE_FAILURE_STRIKE_THRESHOLD = 2;
const _jsonParseFailureStrikes = new Map<string, number>();

function recordJsonParseFailureStrike(profileId: string): number {
  const next = (_jsonParseFailureStrikes.get(profileId) ?? 0) + 1;
  _jsonParseFailureStrikes.set(profileId, next);
  return next;
}

function clearJsonParseFailureStrikes(profileId: string): void {
  if (_jsonParseFailureStrikes.has(profileId)) {
    _jsonParseFailureStrikes.delete(profileId);
  }
}

/** @internal — test seam for resetting strike state between cases. */
export function __resetJsonParseFailureStrikesForTesting(): void {
  _jsonParseFailureStrikes.clear();
}

function extractTextContent(response: BehindTheScenesResponse): string {
  return response.content
    .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function hasParseableStructuredOutput(response: BehindTheScenesResponse): boolean {
  if ('structured_output' in response) return true;
  const text = extractTextContent(response);
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a primary structured-output failure looks like a JSON-capability
 * problem (provider doesn't support `output_format` / `response_format`) versus
 * an unrelated failure (rate-limit, auth, billing, network blip, abort).
 *
 * Used by `executeWithStructuredOutputProfileFallback`'s catch-branch to gate
 * BOTH the silent reroute to DEFAULT_AUXILIARY_MODEL and the sticky
 * `markProfileJsonIncompatible()` call. False positives are costly twice over:
 *   1. A 429/auth/abort silently rerouting to Claude is the silent-failure
 *      pattern AGENTS.md explicitly forbids — the user expects to see the
 *      operational error, not "everything is fine" from a different model.
 *   2. The marker is persisted to settings and permanently bypasses the
 *      profile for structured output until manually reset.
 *
 * Heuristic: skip everything in the kind skip-list, then require an
 * invalid_request-shaped error (400/422) AND a structured-output token AND
 * a "not supported"-shaped phrase in the raw upstream body. The kind skip
 * relies on callProfileHttp throwing classifiedError — without it,
 * profile-direct 4xx errors arrive unclassified and the kind gate becomes a
 * no-op. See merge resolution review (260428) and the 260428 follow-up
 * commit that extended this gate from marking-only to execution-as-well.
 *
 * @internal — module-private. The F4 catch-branch behaviour is exercised through
 * the public entry points (see `behindTheScenesClient.invariants.test.ts` INV-7),
 * not by importing this predicate directly, so it is NOT exported (avoids a
 * `knip` unused-export flag).
 */
function isStructuredOutputCapabilityError(primaryError: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (isTransientNetworkError(primaryError)) return false;
  if (isChatIncompatibilityError(primaryError)) return false;

  const classified = classifyError(primaryError, signal);

  // Skip kinds that indicate the failure is unrelated to JSON capability.
  // Any profile that previously succeeded with structured output won't suddenly
  // become "JSON-incompatible" because a 429 hit it.
  const NON_JSON_CAPABILITY_KINDS = new Set<ModelErrorKind>([
    'rate_limit',
    'auth',
    'billing',
    'moderation',
    'server_error',
    'network',
    'context_overflow',
    'model_unavailable',
    'abort',
  ]);
  if (NON_JSON_CAPABILITY_KINDS.has(classified.kind)) return false;

  // Only invalid_request / 400 / 422 plausibly indicates a request-shape
  // issue with output_format / response_format. Other shapes (unknown kind
  // without status, etc) are too noisy to auto-mark on.
  const status = classified.status;
  const isCandidateStatus =
    (classified.kind === 'invalid_request' && (status === undefined || status === 400)) ||
    status === 422;
  if (!isCandidateStatus) return false;

  // Search the raw upstream body for a structured-output token AND a
  // "not supported"-shaped phrase. Single token alone (e.g. "json mode" in a
  // 5xx-leaked log) isn't enough; the conjunction is the discriminator.
  const message = (classified.__rawMessage ?? classified.message).toLowerCase();
  const hasStructuredOutputToken = [
    'response_format',
    'output_format',
    'output_config',
    'json_object',
    'json_schema',
    'json mode',
    'structured output',
  ].some((token) => message.includes(token));
  if (!hasStructuredOutputToken) return false;

  return [
    'not supported',
    'unsupported',
    'invalid',
    'unknown',
    'unrecognized',
    'not available',
  ].some((phrase) => message.includes(phrase));
}

export async function executeWithStructuredOutputProfileFallback(
  model: string,
  options: BehindTheScenesRequestOptions,
  profiles: ModelProfile[] | undefined,
  category: AuxiliaryCostCategory | undefined,
  executeForModel: (
    modelToUse: string,
    context: { backgroundFallbackAttempted: boolean },
  ) => Promise<ExecutedBtsCall>,
): Promise<ExecutedBtsCall> {
  const decodedModel = decodeSinkBoundaryModel(model, 'executeWithStructuredOutputProfileFallback');
  if (decodedModel === null) {
    throw new Error(
      `executeWithStructuredOutputProfileFallback: invalid model value '${model}' after sink-boundary decode. ` +
      'Empty model id after stripping prefix.',
    );
  }
  model = decodedModel;
  const originalProfile = resolveProfileFromModel(model, profiles);
  const shouldBypassProfile = Boolean(
    options.outputFormat &&
    originalProfile?.jsonCompatibility === 'incompatible'
  );
  const primaryModel = shouldBypassProfile ? DEFAULT_AUXILIARY_MODEL : model;
  let backgroundFallbackAttempted = false;
  const executeWithFallbackLatch = async (modelToUse: string): Promise<ExecutedBtsCall> => {
    const result = await executeForModel(modelToUse, { backgroundFallbackAttempted });
    if (result.usedOperationalFallback) {
      backgroundFallbackAttempted = true;
    }
    return result;
  };

  if (shouldBypassProfile && originalProfile) {
    log.warn(
      { profileId: originalProfile.id, profileName: originalProfile.name, category },
      'JSON-incompatible profile bypassed — falling back to default auxiliary model',
    );
    if (!_emittedBypassProfileIds.has(originalProfile.id)) {
      _emittedBypassProfileIds.add(originalProfile.id);
      emitStructuredOutputFallback({
        caller: category,
        attemptedProfile: originalProfile.name,
        attemptedProfileId: originalProfile.id,
        fellBackTo: DEFAULT_AUXILIARY_MODEL,
        trigger: 'profile-flag-bypass',
      });
    } else {
      recordKnownConditionLedgerOnly('bts_structured_output_fallback');
    }
    notifyStructuredOutputFallbackBypass({
      profileId: originalProfile.id,
      profileName: originalProfile.name,
      fellBackTo: DEFAULT_AUXILIARY_MODEL,
      caller: category,
    });
  }

  let primaryResult: ExecutedBtsCall;
  try {
    primaryResult = await executeWithFallbackLatch(primaryModel);
  } catch (primaryError) {
    // Catch-branch fallback executes ONLY when the primary error looks
    // JSON-capability-specific (provider 400/422 rejecting response_format /
    // output_format with a "not supported" phrase). For everything else —
    // rate-limit, auth, abort, billing, server error, transient — rethrow
    // so the caller sees the actual operational failure rather than a
    // silent reroute to Claude. See AGENTS.md "Silent failure is a bug" and
    // the 260428 follow-up to commit 7bc32dbb6.
    //
    // The post-response parse-failure path (below this try/catch) still
    // covers profiles that respond 200 with non-JSON content.
    if (
      options.outputFormat &&
      originalProfile &&
      !shouldBypassProfile &&
      isStructuredOutputCapabilityError(primaryError, options.signal)
    ) {
      const classified = classifyError(primaryError, options.signal);
      log.warn(
        {
          model,
          category,
          errorKind: classified.kind,
          status: classified.status,
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        },
        'Structured output request failed with JSON-capability error — retrying with default auxiliary model',
      );
      emitStructuredOutputFallback({
        caller: category,
        attemptedProfile: originalProfile.name,
        attemptedProfileId: originalProfile.id,
        fellBackTo: DEFAULT_AUXILIARY_MODEL,
        trigger: 'json-capability',
      });
      const fallbackResult = await executeWithFallbackLatch(DEFAULT_AUXILIARY_MODEL);
      // Auto-mark the original profile as JSON-incompatible when fallback
      // succeeds with parseable output. Already gated by the catch-branch
      // execution check above, so this just confirms the fallback worked.
      // The marker is persisted to settings and permanently bypasses the
      // profile for structured output, so this branch is sticky by design.
      if (originalProfile.id && hasParseableStructuredOutput(fallbackResult.response)) {
        markProfileJsonIncompatible(originalProfile.id);
      }
      return fallbackResult;
    }
    throw primaryError;
  }

  const primaryResponseIsParseable = options.outputFormat
    ? hasParseableStructuredOutput(primaryResult.response)
    : false;

  // Parse-failure fallback applies to ANY non-default primary model when the
  // response is not parseable structured output — including raw auxiliary
  // models (e.g. `minimax/minimax-m2.7`) selected without a profile. Without
  // this broadening, raw non-Anthropic auxiliary models that return non-JSON
  // text would silently leave callers with an unparseable response, breaking
  // structured-output consumers like timeSavedService that then write no
  // entry. See docs-private/investigations/260520_time_saved_zero_or_missing.md.
  //
  // Guards:
  //   - `!options.outputFormat`: only structured-output calls care about parse.
  //   - `shouldBypassProfile`: caller already swapped to DEFAULT_AUXILIARY_MODEL
  //     because the profile was previously marked JSON-incompatible.
  //   - `primaryModel === DEFAULT_AUXILIARY_MODEL`: prevent fallback loops; if
  //     the default model itself returned non-JSON, escalate to the caller.
  //   - `primaryResponseIsParseable`: nothing to recover from.
  if (
    !options.outputFormat ||
    shouldBypassProfile ||
    primaryModel === DEFAULT_AUXILIARY_MODEL ||
    primaryResponseIsParseable
  ) {
    if (originalProfile?.id && !shouldBypassProfile && primaryResponseIsParseable) {
      // First parseable structured-output response after a streak of failures
      // clears the strike counter (the parse-failure path's analog of the
      // catch-branch `isStructuredOutputCapabilityError` gate — see the strike
      // counter declaration for rationale). Profile-only and non-bypass-only
      // so a successful default fallback does not accidentally clear strikes
      // for a skipped profile.
      clearJsonParseFailureStrikes(originalProfile.id);
    }
    return primaryResult;
  }

  log.warn(
    { model, category, hasProfile: !!originalProfile },
    'Structured output parse failed — retrying with default auxiliary model',
  );
  emitStructuredOutputFallback({
    caller: category,
    attemptedProfile: originalProfile?.name ?? primaryModel,
    attemptedProfileId: originalProfile?.id,
    fellBackTo: DEFAULT_AUXILIARY_MODEL,
    trigger: 'parse-failure',
  });
  const fallbackResult = await executeWithFallbackLatch(DEFAULT_AUXILIARY_MODEL);
  // Only mark JSON-incompatibility when the original selection was a profile
  // and the primary call did not already recover through an operational
  // fallback. Raw model selections have no profile to persist a marker for.
  if (
    originalProfile?.id &&
    hasParseableStructuredOutput(fallbackResult.response) &&
    !primaryResult.usedOperationalFallback
  ) {
    // Single transient non-JSON output is not enough to sticky-mark the
    // profile (DA finding for the 260521 BTS Haiku-fallback bug). Only
    // mark after JSON_PARSE_FAILURE_STRIKE_THRESHOLD consecutive failures
    // — analogous to the catch-branch's `isStructuredOutputCapabilityError`
    // heuristic, which it cannot use here because there is no provider
    // error to inspect (the primary call returned 200 with non-JSON text).
    const strikes = recordJsonParseFailureStrike(originalProfile.id);
    if (strikes >= JSON_PARSE_FAILURE_STRIKE_THRESHOLD) {
      markProfileJsonIncompatible(originalProfile.id);
      clearJsonParseFailureStrikes(originalProfile.id);
    } else {
      log.info(
        {
          profileId: originalProfile.id,
          profileName: originalProfile.name,
          strikes,
          threshold: JSON_PARSE_FAILURE_STRIKE_THRESHOLD,
        },
        'Structured-output parse failure recorded; marking deferred until threshold',
      );
    }
  }
  return fallbackResult;
}

function emitStructuredOutputFallback(context: {
  caller: AuxiliaryCostCategory | undefined;
  attemptedProfile: string;
  attemptedProfileId?: string;
  fellBackTo: string;
  trigger: BtsDegradedReason;
}): void {
  try {
    captureKnownCondition('bts_structured_output_fallback', {
      extra: {
        caller: context.caller ?? null,
        attemptedProfile: context.attemptedProfile,
        profileId: context.attemptedProfileId ?? null,
        fellBackTo: context.fellBackTo,
        trigger: context.trigger,
      },
    });
  } catch (emitError) {
    log.warn(
      { err: emitError instanceof Error ? emitError.message : String(emitError) },
      'Failed to emit bts_structured_output_fallback known condition',
    );
  }
}

/**
 * Surfaces a one-time-per-process notification when the resolver bypasses the
 * user's chosen profile because of a stored `jsonCompatibility: 'incompatible'`
 * flag. The bypass itself is logged on every call, but a notification helps
 * the user discover that their selected model is being skipped — without it
 * the swap is invisible (see 260521 BTS Haiku-fallback investigation).
 *
 * Broadcasts directly via `getBroadcastService()` so both desktop (Electron
 * BroadcastService → BrowserWindow.webContents.send) and cloud (cloud event
 * broadcaster → SSE to mobile / cloud-client) emit the toast without
 * surface-specific wiring. The channel is allowlisted in
 * `src/main/services/cloud/cloudEventChannel.ts`.
 */
type StructuredOutputBypassNotice = {
  profileId: string;
  profileName: string;
  fellBackTo: string;
  caller: AuxiliaryCostCategory | undefined;
};

const _notifiedBypassProfileIds = new Set<string>();

/** @internal — test seam for resetting one-shot dedupe between cases. */
export function __resetStructuredOutputBypassNoticesForTesting(): void {
  _notifiedBypassProfileIds.clear();
  _emittedBypassProfileIds.clear();
}

function notifyStructuredOutputFallbackBypass(notice: StructuredOutputBypassNotice): void {
  if (_notifiedBypassProfileIds.has(notice.profileId)) return;
  _notifiedBypassProfileIds.add(notice.profileId);
  const payloadParse = BtsStructuredOutputBypassPayloadSchema.safeParse({
    profileId: notice.profileId,
    profileName: notice.profileName,
    fellBackTo: notice.fellBackTo,
    caller: notice.caller ?? null,
  });
  if (!payloadParse.success) {
    log.warn(
      { err: payloadParse.error.message, profileId: notice.profileId },
      'Structured-output bypass payload failed schema validation; skipping broadcast',
    );
    return;
  }
  try {
    getBroadcastService().sendToAllWindows(
      BTS_STRUCTURED_OUTPUT_BYPASS_CHANNEL,
      payloadParse.data,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Structured-output bypass broadcast threw',
    );
  }
}
