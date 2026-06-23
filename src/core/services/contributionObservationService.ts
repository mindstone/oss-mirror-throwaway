/**
 * Contribution Observation Service — Stage 3.D (260426).
 *
 * The single chokepoint for every readiness observation that flows into
 * the contribution lifecycle. Replaced the volatile in-memory promotion-
 * signal registry that Stage 3.F deleted (matrix #23 — restart loses
 * truth) with a durable, store-backed reducer + per-canonical-path
 * mutex.
 *
 * ─── Architecture ───
 *
 * Four ingress sites (Stage 3.E) call `observeContribution(obs)`:
 *
 *   1. `mcpBuildAutoDetectHook.handleMcpServerFileDetection` —
 *      `kind: 'build_detected'` from `npm run build` / `tsc` Bash.
 *   2. `mcpBuildAutoDetectHook.handleTestPassPromotion` —
 *      `kind: 'test_passed'` from `npm test` / `vitest` Bash.
 *   3. `mcpBuildAutoDetectHook` PostToolUse `rebel_mcp_add_server` —
 *      `kind: 'server_registered'` (post-tool-add-server).
 *   4. `bundledInboxBridge` POST /contribution/report-state —
 *      `kind: 'ready_requested'` (the agent's own readiness assertion).
 *
 * Plus the boot-time + post-turn sweeps (`contributionStartupSweep`,
 * `runPromotionSweep`) re-emit `build_detected` / `server_registered`
 * observations for cross-restart recovery.
 *
 * Each call:
 *   1. Canonicalises the path (Stage 2.B).
 *   2. Acquires the per-canonical-path mutex (Decision 1).
 *   3. Computes the build fingerprint from `package.json` mtime+size
 *      (Decision 3) — best-effort; `undefined` on filesystem-unavailable.
 *   4. Looks up the existing record (path-first / session-fallback —
 *      Stage 2.D).
 *   5. Runs the pure synchronous reducer (Decision 7).
 *   6. Persists field writes via the Stage 3.C store helpers.
 *   7. Releases the mutex via `finally`.
 *
 * ─── Promotion predicate (the new ready_to_submit gate) ───
 *
 *   `lastReadyRequestedAt` is set
 *   AND (`lastTestPassedAt` is set OR `lastRegisteredAt` is set)
 *   AND `fingerprintMatches(observed, state.lastBuildFingerprint)`.
 *
 * Fingerprint mismatches (rebuild between test-pass and ready-requested)
 * clear `lastTestPassedAt` + `lastReadyRequestedAt`. Real-world facts
 * (`lastBuildDetectedAt`, `lastRegisteredAt`) survive rebuilds because
 * they describe disk / config state, not stale agent assertions.
 *
 * ─── Reducer purity ───
 *
 * The reducer is a pure synchronous function. It has zero IO, zero
 * `Date.now()`, zero `Math.random()`. The caller (this service's
 * entrypoint) injects `now: string` and the observed fingerprint.
 * This makes the 22 reducer tests trivial to set up — no fake timers,
 * no fs mocks, no awaits.
 *
 * ─── Footgun (G2) ───
 *
 * The per-canonical-path mutex is non-reentrant. Future code that
 * triggers a follow-up `observeContribution` from inside a reducer or
 * post-write hook will deadlock if it re-enters the same canonical
 * path. Drop the mutex (move follow-up calls outside `withMutex`) or
 * add re-entry tracking before introducing recursive observations.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md (Stage 3.D)
 */

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { createScopedLogger } from '@core/logger';
import { canonicalizeConnectorPath } from '@core/utils/canonicalConnectorPath';
import {
  addLinkedSession,
  clearStaleReadinessOnFingerprintChange,
  clearLastSoftwareEngineerTaskCompletedAt,
  clearSoftwareEngineerEvidenceInvalidation,
  createContribution,
  getActiveContributionBySession,
  getContributionById,
  getContributionByPath,
  listContributions,
  setLastSoftwareEngineerTaskCompletedAt,
  setLastBuildDetectedAt,
  setLastBuildFingerprint,
  setLastReadyRequestedAt,
  setLastRegisteredAt,
  setSoftwareEngineerEvidenceInvalidation,
  setLastTestPassedAt,
  setTurnIndexWindow,
  updateContribution,
} from './contributionStore';
import type {
  ConnectorContribution,
  ContributionStatus,
  ContributionTurnIndexWindow,
  SoftwareEngineerEvidenceInvalidatedReason,
} from './contributionTypes';
import { applySingleActiveBuildInvariant } from './seTaskDetection';
import { agentTurnRegistry } from './agentTurnRegistry';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import type { AgentEvent } from '@shared/types';

const log = createScopedLogger({ service: 'contributionObservation' });

// ─── Observation discriminated union ─────────────────────────────────

/**
 * Observation source label — names the ingress that fired the
 * observation. Used for telemetry and log correlation. Keep in sync with
 * the Stage 3.E migration sites in `mcpBuildAutoDetectHook`,
 * `bundledInboxBridge`, and `contributionStartupSweep`.
 */
export type ObservationSource =
  | 'post-tool-bash'
  | 'post-tool-use-tool'
  | 'post-tool-add-server'
  | 'post-turn-sweep'
  | 'startup-sweep'
  | 'bridge-report-state';

/**
 * The four observation shapes. Each carries `localServerPath` (required)
 * because the path-keyed identity model (Stage 2.B) is canonicalised
 * here — the entrypoint rejects observations with a missing or empty
 * path with `decision: 'rejected', reason: 'missing_path'`.
 */
export type Observation =
  | {
      kind: 'build_detected';
      sessionId: string;
      localServerPath: string;
      connectorName: string;
      source: 'post-tool-bash' | 'post-turn-sweep' | 'startup-sweep';
    }
  | {
      kind: 'test_passed';
      sessionId: string;
      localServerPath: string;
      source: 'post-tool-bash' | 'post-tool-use-tool';
    }
  | {
      kind: 'server_registered';
      sessionId: string;
      localServerPath: string;
      connectorName: string;
      source: 'post-tool-add-server' | 'post-turn-sweep' | 'startup-sweep';
    }
  | {
      kind: 'ready_requested';
      sessionId: string;
      localServerPath: string;
      connectorName: string;
      /**
       * Cloud/mobile fail-closed contract (Decision 4): when the
       * observation pipeline runs on a surface without filesystem access
       * (cloud HTTP, mobile RN), the agent supplies the fingerprint via
       * a manifest file written at build time. Desktop callers leave
       * this undefined — the entrypoint falls back to filesystem fingerprint
       * computation.
       */
      agentAssertedFingerprint?: string;
      source: 'bridge-report-state';
    }
  | {
      kind: 'software_engineer_task_completed';
      sessionId: string;
      contributionId: string;
      taskSubagentTypes: string[];
      observedAt: { sessionId: string; turnIndex: number };
      source: 'post-turn-sweep';
    };

/**
 * Result envelope returned from `observeContribution`. The bridge layer
 * (Stage 3.E) maps this to the Stage 1 `Decision` envelope shape per
 * § "Hidden gotchas → G11" of the Stage 3 plan.
 */
export interface ObservationResult {
  decision: 'created' | 'updated' | 'noop' | 'deferred' | 'rejected';
  contributionId?: string;
  reason: string;
  promoted: boolean;
  fingerprintMismatch: boolean;
}

export interface ObserveContributionOptions {
  enforceSoftwareEngineerEvidence?: boolean;
}

// ─── Reducer types ───────────────────────────────────────────────────

/**
 * Subset of `ConnectorContribution` the reducer reads/writes. The status
 * field is REQUIRED so the reducer can guard transitions; readiness
 * timestamps are optional (absence == "no evidence yet").
 */
export interface ReducerState {
  status: ContributionStatus;
  lastBuildDetectedAt?: string;
  lastTestPassedAt?: string;
  lastRegisteredAt?: string;
  lastReadyRequestedAt?: string;
  lastBuildFingerprint?: string;
  lastTransitionError?: string;
  turnIndexWindow?: ContributionTurnIndexWindow;
  lastSoftwareEngineerTaskCompletedAt?: string;
  lastSoftwareEngineerEvidenceInvalidatedAt?: string;
  lastSoftwareEngineerEvidenceInvalidatedReason?: SoftwareEngineerEvidenceInvalidatedReason;
}

/** Subset of readiness fields the reducer writes back to the store. */
export interface PartialReadinessFields {
  lastBuildDetectedAt?: string;
  lastTestPassedAt?: string;
  lastRegisteredAt?: string;
  lastReadyRequestedAt?: string;
  lastBuildFingerprint?: string;
  turnIndexWindow?: ContributionTurnIndexWindow;
  lastSoftwareEngineerTaskCompletedAt?: string;
}

/**
 * Pure-reducer input — exactly four fields per Decision 7 (synchronous,
 * dependency-injected `now` + observed fingerprint, no IO, no clock).
 */
export interface ReducerInput {
  observation: Observation;
  /**
   * `undefined` when no record exists for this canonical path or
   * fallback-session. Otherwise the snapshot read from the store BEFORE
   * the reducer runs.
   */
  state: ReducerState | undefined;
  /**
   * Disk-derived fingerprint, `undefined` when filesystem unavailable
   * OR `package.json` missing (cloud/mobile, ENOENT, EACCES).
   */
  observedFingerprint?: string;
  /** ISO timestamp; the entrypoint computes `new Date().toISOString()` once. */
  now: string;
  /** Stage 3 (SE evidence gate): when true, ready promotions require SE evidence. */
  enforceSoftwareEngineerEvidence?: boolean;
}

export type DeferralReason =
  | 'missing_evidence'
  | 'fingerprint_unavailable'
  | 'missing_se_evidence';

const MISSING_SE_EVIDENCE_NEXT_ACTION = 'run_software_engineer_workflow' as const;

type MissingSeEvidenceTransitionErrorPayload = {
  reason: 'missing_se_evidence';
  nextAction: typeof MISSING_SE_EVIDENCE_NEXT_ACTION;
  chatSafeGuidance: string;
};

export function buildMissingSeEvidenceTransitionError(args: {
  chatSafeGuidance: string;
}): string {
  return JSON.stringify({
    reason: 'missing_se_evidence',
    nextAction: MISSING_SE_EVIDENCE_NEXT_ACTION,
    chatSafeGuidance: args.chatSafeGuidance,
  } satisfies MissingSeEvidenceTransitionErrorPayload);
}

export function tryParseMissingSeEvidenceTransitionError(
  raw: string | undefined | null,
): MissingSeEvidenceTransitionErrorPayload | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MissingSeEvidenceTransitionErrorPayload>;
    if (
      parsed.reason === 'missing_se_evidence'
      && parsed.nextAction === MISSING_SE_EVIDENCE_NEXT_ACTION
      && typeof parsed.chatSafeGuidance === 'string'
      && parsed.chatSafeGuidance.length > 0
    ) {
      return parsed as MissingSeEvidenceTransitionErrorPayload;
    }
  } catch {
    // ignore parse failures
  }
  return null;
}

export function isMissingSeEvidenceTransitionError(
  raw: string | undefined | null,
): boolean {
  return tryParseMissingSeEvidenceTransitionError(raw) !== null;
}

/**
 * Pure-reducer output — exactly four shapes. The entrypoint pattern-matches
 * to apply field writes / create the record / surface the result envelope.
 */
export type ReducerOutput =
  | {
      kind: 'create_record';
      status: 'draft' | 'testing' | 'ready_to_submit';
      fields: PartialReadinessFields;
    }
  | {
      kind: 'apply_writes';
      fields: PartialReadinessFields;
      /**
       * When set, the entrypoint MUST call
       * `clearStaleReadinessOnFingerprintChange(id, newFingerprint)`
       * BEFORE applying `fields`. Maps to G1 of the plan: surfaces the
       * "test pass evidence vanished because the build content changed"
       * event via a structured warn log inside the store helper.
       */
      staleFingerprintInvalidation?: { newFingerprint: string };
      clearSoftwareEngineerTaskCompletedAt?: true;
      setSoftwareEngineerEvidenceInvalidation?: {
        at: string;
        reason: SoftwareEngineerEvidenceInvalidatedReason;
      };
      clearSoftwareEngineerEvidenceInvalidation?: true;
      clearMissingSeEvidenceTransitionError?: true;
      promote?: 'ready_to_submit';
      deferralReason?: DeferralReason;
    }
  | { kind: 'noop'; reason: string }
  | { kind: 'reject'; reason: 'invalid_state' | 'missing_path'; details?: string };

// ─── Per-canonical-path mutex (Decision 1 + Decision 6) ──────────────

const mutexes = new Map<string, Promise<void>>();

/**
 * Per-canonical-path serialiser. Concurrent observations on the SAME
 * canonical path serialise FIFO; observations on DIFFERENT canonical
 * paths run in parallel.
 *
 * The "only delete if still ours" guard handles the rare case where a
 * later caller installed a new mutex entry between this caller's `await`
 * and the `finally` block — without the guard, this caller would clobber
 * the later caller's entry on cleanup.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md (Stage 3.D, Decision 6)
 */
async function withMutex<T>(
  canonicalPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = mutexes.get(canonicalPath);
  if (existing) await existing;
  let resolve: () => void = () => undefined;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  mutexes.set(canonicalPath, next);
  try {
    return await fn();
  } finally {
    resolve();
    if (mutexes.get(canonicalPath) === next) {
      mutexes.delete(canonicalPath);
    }
  }
}

/** Test-only: expose `withMutex` so the 4 mutex unit tests can exercise it. */
export const _withMutexForTest = withMutex;

/**
 * Public per-canonical-path serialiser. Same FIFO behaviour as the
 * internal `withMutex` (used by `observeContribution`), exposed so
 * non-observation call sites can serialise idempotent flag-writes
 * against the same canonical path the reducer uses.
 *
 * Self-block follow-on (260427) — sub-stage C uses this in
 * `mcpBuildAutoDetectHook::runPromotionSweep` to write
 * `stuckRegistrationNudgeFiredAt` under the same lock the observation
 * pipeline acquires, so the flag-write doesn't race a concurrent
 * `observeContribution` for the same path.
 */
export const withCanonicalPathMutex = withMutex;

/** Test-only: clear the mutex map between cases. */
export function _resetMutexesForTest(): void {
  mutexes.clear();
}

// ─── Build fingerprint helper (Decision 3) ───────────────────────────

/**
 * SHA-256 hex hash of `${stat.mtimeMs}|${stat.size}` of
 * `<canonicalPath>/package.json`. Returns `undefined` on any error
 * (ENOENT, EACCES, EPERM, …) — the reducer treats this as "no observable
 * filesystem evidence" and falls back per Decision 4 (cloud/mobile path).
 *
 * `package.json` is the right anchor:
 *   - Always present in a built MCP connector (per the SKILL.md template).
 *   - Smallest "real" file in the connector (cheap stat).
 *   - mtime updates whenever the build content changes (npm install,
 *     dep bump, name change, version bump).
 *
 * **Snapshot, not strictly monotonic** (G3): if `npm install` runs mid-
 * observation, three concurrent observations could compute three
 * different fingerprints. The mutex serialises field writes so the
 * final state is consistent (last write wins).
 *
 * Lives in `src/core/services/` rather than `src/core/utils/` because
 * it's specific to the observation pipeline. Mirrors the Stage 2.B
 * `canonicalConnectorPath.ts` precedent: `src/core/` may import
 * `node:fs` / `node:path` / `node:crypto` (the boundary forbids
 * `electron` and `electron-store`, not Node built-ins).
 */
export function computeBuildFingerprint(
  localServerPath: string,
): string | undefined {
  try {
    const canonical = canonicalizeConnectorPath(localServerPath);
    if (!canonical) return undefined;
    const pkgPath = nodePath.join(canonical, 'package.json');
    const stat = nodeFs.statSync(pkgPath);
    return nodeCrypto
      .createHash('sha256')
      .update(`${stat.mtimeMs}|${stat.size}`)
      .digest('hex');
  } catch {
    // ENOENT, EACCES, EPERM, ELOOP — caller treats this as "no fs evidence".
    return undefined;
  }
}

// ─── Predicate helpers (pure) ────────────────────────────────────────

/**
 * Decision 4: when the observation kind is NOT `ready_requested`,
 * fingerprint matching is irrelevant (only readiness assertions are
 * gated by build identity). Returns the appropriate verdict.
 */
function fingerprintMatches(
  observation: Observation,
  state: ReducerState | undefined,
  observedFingerprint: string | undefined,
): { matches: boolean; reason?: DeferralReason } {
  if (observation.kind !== 'ready_requested') {
    return { matches: true };
  }
  const stateFingerprint = state?.lastBuildFingerprint;
  const agentAsserted = observation.agentAssertedFingerprint;
  const effective = observedFingerprint ?? agentAsserted;

  // Fail-open: no prior fingerprint, no observed/asserted fingerprint —
  // the very first observation against a fresh connector legitimately
  // lacks a stored value and the cloud/mobile surface may genuinely
  // lack filesystem access without a manifest yet.
  if (stateFingerprint === undefined && effective === undefined) {
    return { matches: true };
  }
  // Fail-closed: state has a fingerprint but neither observed nor
  // asserted is supplied. Cloud/mobile parity protection (Decision 4).
  if (stateFingerprint !== undefined && effective === undefined) {
    return { matches: false, reason: 'fingerprint_unavailable' };
  }
  // Both defined and equal → predicate proceeds.
  if (stateFingerprint === effective) {
    return { matches: true };
  }
  // Both defined and different → invalidation will fire; predicate fails
  // for THIS observation (the agent tested an old build).
  return { matches: false, reason: 'missing_evidence' };
}

/**
 * Stage 3 promotion predicate:
 *   `lastReadyRequestedAt` set
 *   AND (`lastTestPassedAt` set OR `lastRegisteredAt` set)
 *   AND `fingerprintMatches(observed, state.lastBuildFingerprint)`.
 *
 * Used inside the reducer for `ready_requested` observations against an
 * existing record. The `now` argument represents the candidate
 * `lastReadyRequestedAt`; the predicate evaluates "would the record
 * satisfy the gate AFTER stamping the readiness fields the observation
 * supplies?".
 */
function predicateSatisfied(
  state: ReducerState,
  fingerprintOk: boolean,
  opts: { enforceSoftwareEngineerEvidence: boolean },
): { satisfied: true } | { satisfied: false; reason: DeferralReason } {
  if (!fingerprintOk) {
    return { satisfied: false, reason: 'missing_evidence' };
  }
  const evidenceTier = state.lastTestPassedAt !== undefined || state.lastRegisteredAt !== undefined;
  if (!evidenceTier) {
    return { satisfied: false, reason: 'missing_evidence' };
  }
  if (
    opts.enforceSoftwareEngineerEvidence
    && state.lastSoftwareEngineerTaskCompletedAt === undefined
  ) {
    return { satisfied: false, reason: 'missing_se_evidence' };
  }
  return { satisfied: true };
}

function withFingerprintCascade(
  output: Extract<ReducerOutput, { kind: 'apply_writes' }>,
  args: {
    newFingerprint: string;
    now: string;
  },
): Extract<ReducerOutput, { kind: 'apply_writes' }> {
  return {
    ...output,
    staleFingerprintInvalidation: {
      newFingerprint: args.newFingerprint,
    },
    clearSoftwareEngineerTaskCompletedAt: true,
    setSoftwareEngineerEvidenceInvalidation: {
      at: args.now,
      reason: 'fingerprint_mismatch',
    },
  };
}

// ─── Pure reducer ────────────────────────────────────────────────────

/**
 * Pure synchronous reducer. NO `Date.now`, NO `Math.random`, NO IO.
 * Caller injects `now: string` and `observedFingerprint`.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md (Stage 3.D, Decision 7)
 */
export function reduceObservation(input: ReducerInput): ReducerOutput {
  const {
    observation,
    state,
    observedFingerprint,
    now,
    enforceSoftwareEngineerEvidence = false,
  } = input;

  switch (observation.kind) {
    // ── build_detected ─────────────────────────────────────────────
    case 'build_detected': {
      // No record → create a `draft` (matrix #22 realignment per the
      // SKILL.md contract — build-success on its own does NOT promote).
      if (!state) {
        const fields: PartialReadinessFields = { lastBuildDetectedAt: now };
        if (observedFingerprint !== undefined) {
          fields.lastBuildFingerprint = observedFingerprint;
        }
        return { kind: 'create_record', status: 'draft', fields };
      }
      // Record exists → update timestamps. No promotion possible from
      // a build-detected observation alone.
      const fields: PartialReadinessFields = { lastBuildDetectedAt: now };
      if (observedFingerprint !== undefined) {
        fields.lastBuildFingerprint = observedFingerprint;
      }
      const fingerprintChanged =
        state.lastBuildFingerprint !== undefined &&
        observedFingerprint !== undefined &&
        state.lastBuildFingerprint !== observedFingerprint;
      const out: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
        kind: 'apply_writes',
        fields,
      };
      if (fingerprintChanged) {
        return withFingerprintCascade(out, {
          newFingerprint: observedFingerprint as string,
          now,
        });
      }
      return out;
    }

    // ── test_passed ────────────────────────────────────────────────
    case 'test_passed': {
      // No record → noop. Test-pass alone NEVER auto-creates (matrix
      // #22 protection). The agent must build (or the bridge must
      // create) before test-pass can land.
      if (!state) {
        return { kind: 'noop', reason: 'no_record_to_update' };
      }
      const fields: PartialReadinessFields = { lastTestPassedAt: now };
      if (observedFingerprint !== undefined) {
        fields.lastBuildFingerprint = observedFingerprint;
      }
      const fingerprintChanged =
        state.lastBuildFingerprint !== undefined &&
        observedFingerprint !== undefined &&
        state.lastBuildFingerprint !== observedFingerprint;
      const out: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
        kind: 'apply_writes',
        fields,
      };
      if (fingerprintChanged) {
        return withFingerprintCascade(out, {
          newFingerprint: observedFingerprint as string,
          now,
        });
      }
      return out;
    }

    // ── server_registered ──────────────────────────────────────────
    case 'server_registered': {
      if (!state) {
        // Decision 9 split: post-turn-sweep creates at ready_to_submit
        // (registration alone is sufficient evidence post-turn);
        // startup-sweep does NOT create (boot must not synthesise
        // intent we don't have).
        if (observation.source === 'post-turn-sweep') {
          const fields: PartialReadinessFields = { lastRegisteredAt: now };
          if (observedFingerprint !== undefined) {
            fields.lastBuildFingerprint = observedFingerprint;
          }
          return { kind: 'create_record', status: 'ready_to_submit', fields };
        }
        return { kind: 'noop', reason: 'no_record_to_update' };
      }
      const fields: PartialReadinessFields = { lastRegisteredAt: now };
      if (observedFingerprint !== undefined) {
        fields.lastBuildFingerprint = observedFingerprint;
      }
      const fingerprintChanged =
        state.lastBuildFingerprint !== undefined &&
        observedFingerprint !== undefined &&
        state.lastBuildFingerprint !== observedFingerprint;
      const out: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
        kind: 'apply_writes',
        fields,
      };
      if (fingerprintChanged) {
        return withFingerprintCascade(out, {
          newFingerprint: observedFingerprint as string,
          now,
        });
      }
      return out;
    }

    // ── ready_requested ────────────────────────────────────────────
    case 'ready_requested': {
      if (!state) {
        // No record yet — caller (the bridge) is responsible for
        // creating a draft FIRST and re-observing. This branch is
        // structurally a noop because the entrypoint never reaches it
        // unless the bridge skipped the create step.
        return { kind: 'noop', reason: 'no_record_to_update' };
      }
      // Reject re-promotion after `submitted` / terminal states. The
      // store would also reject via VALID_STATE_TRANSITIONS, but
      // surfacing the rejection here gives the caller a typed
      // `decision: 'rejected'` instead of an opaque store-level error.
      if (
        state.status !== 'testing' &&
        state.status !== 'draft' &&
        state.status !== 'ready_to_submit'
      ) {
        return {
          kind: 'reject',
          reason: 'invalid_state',
          details: `cannot ready_request from ${state.status}`,
        };
      }

      const fp = fingerprintMatches(observation, state, observedFingerprint);
      const stateFingerprint = state.lastBuildFingerprint;
      const effectiveFingerprint =
        observedFingerprint ?? observation.agentAssertedFingerprint;
      const fingerprintChanged =
        stateFingerprint !== undefined &&
        effectiveFingerprint !== undefined &&
        stateFingerprint !== effectiveFingerprint;

      // The fingerprint mismatch invalidates state's
      // lastTestPassedAt/lastReadyRequestedAt — the entrypoint applies
      // this via `clearStaleReadinessOnFingerprintChange` BEFORE the
      // field writes. We model it here so the reducer output carries
      // enough information for the entrypoint to act.
      const stateAfterPossibleClear: ReducerState = fingerprintChanged
        ? {
            ...state,
            lastTestPassedAt: undefined,
            lastReadyRequestedAt: undefined,
            lastBuildFingerprint: effectiveFingerprint as string,
          }
        : state;

      // Stamp lastReadyRequestedAt + (best-effort) lastBuildFingerprint
      // on the field-write payload. The agent's new readiness assertion
      // is recorded regardless of predicate outcome — the predicate
      // gates ONLY the status promotion.
      const fields: PartialReadinessFields = { lastReadyRequestedAt: now };
      if (effectiveFingerprint !== undefined) {
        fields.lastBuildFingerprint = effectiveFingerprint;
      }

      // Effective state for predicate evaluation: incorporate the
      // about-to-stamp lastReadyRequestedAt (for the "ready was set"
      // axis) along with any fingerprint clear from above.
      const predicateState: ReducerState = {
        ...stateAfterPossibleClear,
        lastReadyRequestedAt: now,
      };

      // When fingerprint check failed for cloud/mobile (state has fingerprint
      // but no observed or asserted), fail closed.
      if (!fp.matches && fp.reason === 'fingerprint_unavailable') {
        const out: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
          kind: 'apply_writes',
          fields,
          deferralReason: 'fingerprint_unavailable',
        };
        if (fingerprintChanged) {
          return withFingerprintCascade(out, {
            newFingerprint: effectiveFingerprint as string,
            now,
          });
        }
        return out;
      }

      const verdict = predicateSatisfied(predicateState, fp.matches, {
        enforceSoftwareEngineerEvidence,
      });
      if (!verdict.satisfied) {
        const out: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
          kind: 'apply_writes',
          fields,
          deferralReason: verdict.reason,
        };
        if (fingerprintChanged) {
          return withFingerprintCascade(out, {
            newFingerprint: effectiveFingerprint as string,
            now,
          });
        }
        return out;
      }

      // Predicate satisfied → promote. The entrypoint applies the
      // status transition via `updateContribution`, which clears
      // `lastTransitionError` automatically (Decision 8).
      const promoteOut: Extract<ReducerOutput, { kind: 'apply_writes' }> = {
        kind: 'apply_writes',
        fields,
        promote: 'ready_to_submit',
      };
      if (fingerprintChanged) {
        return withFingerprintCascade(promoteOut, {
          newFingerprint: effectiveFingerprint as string,
          now,
        });
      }
      return promoteOut;
    }

    // ── software_engineer_task_completed ─────────────────────────
    case 'software_engineer_task_completed': {
      if (!state) {
        return { kind: 'noop', reason: 'no_record_to_update' };
      }
      const shouldClearMissingSeEvidenceTransitionError =
        isMissingSeEvidenceTransitionError(state.lastTransitionError);
      return {
        kind: 'apply_writes',
        fields: {
          lastSoftwareEngineerTaskCompletedAt: now,
        },
        clearSoftwareEngineerEvidenceInvalidation: true,
        ...(shouldClearMissingSeEvidenceTransitionError
          ? { clearMissingSeEvidenceTransitionError: true }
          : {}),
      };
    }
  }
}

function deriveTurnOrderForIndex(
  eventsByTurn: Record<string, AgentEvent[]>,
): string[] {
  return Object.entries(eventsByTurn)
    .map(([turnId, events], insertionOrder) => {
      const timestamps = events
        .map((event) => event.timestamp)
        .filter((timestamp): timestamp is number => typeof timestamp === 'number');
      const firstTimestamp = timestamps.length > 0
        ? Math.min(...timestamps)
        : Number.POSITIVE_INFINITY;
      return { turnId, insertionOrder, firstTimestamp };
    })
    .sort((a, b) => {
      if (a.firstTimestamp === b.firstTimestamp) {
        return a.insertionOrder - b.insertionOrder;
      }
      return a.firstTimestamp - b.firstTimestamp;
    })
    .map((entry) => entry.turnId);
}

function deriveLatestSessionTurnIndexFromEvents(
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
): number | undefined {
  if (!eventsByTurn) return undefined;
  const turnOrder = deriveTurnOrderForIndex(eventsByTurn);
  if (turnOrder.length === 0) return undefined;
  return turnOrder.length - 1;
}

async function resolveSessionTurnIndex(sessionId: string): Promise<number> {
  const activeTurnId = agentTurnRegistry.getActiveTurnForSession(sessionId);
  if (activeTurnId) {
    const activeShape = agentTurnRegistry.getContextAccumulator(activeTurnId);
    const activeIndex = deriveLatestSessionTurnIndexFromEvents(activeShape?.eventsByTurn);
    if (typeof activeIndex === 'number') {
      return activeIndex;
    }
  }

  try {
    const persistedSession = await getIncrementalSessionStore().getSession(sessionId);
    const persistedIndex = deriveLatestSessionTurnIndexFromEvents(persistedSession?.eventsByTurn);
    if (typeof persistedIndex === 'number') {
      return persistedIndex;
    }
  } catch (error) {
    log.warn(
      { sessionId, err: error instanceof Error ? error.message : String(error) },
      'Failed to resolve session turn index from persisted session',
    );
  }

  return 0;
}

function windowsEqual(
  a: ContributionTurnIndexWindow | undefined,
  b: ContributionTurnIndexWindow | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.startTurn === b.startTurn && a.endTurn === b.endTurn;
}

function applyPathLockInvariantForContribution(args: {
  contributionId: string;
  sessionId: string;
  turnIndex: number;
}): void {
  const contributions = listContributions();
  if (contributions.length === 0) return;

  const next = applySingleActiveBuildInvariant(contributions, {
    sessionId: args.sessionId,
    newPathLockTurn: args.turnIndex,
    newContributionId: args.contributionId,
  });

  for (let index = 0; index < contributions.length; index += 1) {
    const previous = contributions[index];
    const candidate = next[index];
    if (!candidate || previous.id !== candidate.id) continue;
    if (!windowsEqual(previous.turnIndexWindow, candidate.turnIndexWindow)) {
      if (candidate.turnIndexWindow) {
        setTurnIndexWindow(candidate.id, candidate.turnIndexWindow);
      }
    }
  }
}

function shouldApplyPathLockInvariant(observation: Observation): boolean {
  return observation.kind !== 'software_engineer_task_completed';
}

function isPathBasedObservation(
  observation: Observation,
): observation is Exclude<Observation, { kind: 'software_engineer_task_completed' }> {
  return observation.kind !== 'software_engineer_task_completed';
}

// ─── Entrypoint ──────────────────────────────────────────────────────

/**
 * Single ingress for every readiness observation. Routes through the
 * pure reducer + per-canonical-path mutex + Stage 3.C store helpers.
 *
 * Returns an `ObservationResult` envelope the bridge layer maps to the
 * Stage 1 `Decision` envelope (§ "Hidden gotchas → G11" of the Stage 3
 * plan).
 *
 * Per AGENTS.md "Silent failure is a bug": every catch in this
 * function emits a structured `warn` log with the canonical path +
 * observation kind + error message. No `catch { return }` patterns.
 */
export async function observeContribution(
  obs: Observation,
  options?: ObserveContributionOptions,
): Promise<ObservationResult> {
  let mutexKey = '';
  let canonicalPathForLogs: string | undefined;
  let softwareObservationRecord: ConnectorContribution | undefined;

  if (isPathBasedObservation(obs)) {
    if (!obs.localServerPath || !obs.localServerPath.trim()) {
      log.warn(
        { kind: obs.kind, sessionId: obs.sessionId, source: obs.source },
        'Observation rejected — missing localServerPath',
      );
      return {
        decision: 'rejected',
        reason: 'missing_path',
        promoted: false,
        fingerprintMismatch: false,
      };
    }

    const canonicalPath = canonicalizeConnectorPath(obs.localServerPath);
    if (!canonicalPath) {
      log.warn(
        {
          kind: obs.kind,
          sessionId: obs.sessionId,
          source: obs.source,
          rawPath: obs.localServerPath,
        },
        'Observation rejected — canonicalisation produced empty path',
      );
      return {
        decision: 'rejected',
        reason: 'missing_path',
        promoted: false,
        fingerprintMismatch: false,
      };
    }

    mutexKey = canonicalPath;
    canonicalPathForLogs = canonicalPath;
  } else {
    softwareObservationRecord = getContributionById(obs.contributionId);
    if (!softwareObservationRecord) {
      return {
        decision: 'noop',
        contributionId: obs.contributionId,
        reason: 'no_record_to_update',
        promoted: false,
        fingerprintMismatch: false,
      };
    }
    mutexKey = softwareObservationRecord.canonicalConnectorPath
      ?? `contribution-id:${softwareObservationRecord.id}`;
    canonicalPathForLogs = softwareObservationRecord.canonicalConnectorPath;
  }

  return withMutex(mutexKey, async () => {
    const now = new Date().toISOString();
    const pathLockTurnIndex = shouldApplyPathLockInvariant(obs)
      ? await resolveSessionTurnIndex(obs.sessionId)
      : undefined;

    const observedFingerprint = isPathBasedObservation(obs)
      ? computeBuildFingerprint(obs.localServerPath)
      : undefined;

    let record = softwareObservationRecord;
    if (isPathBasedObservation(obs)) {
      const canonicalPath = mutexKey;
      // Path-first / session-fallback (Stage 2.D invariant).
      record = getContributionByPath(canonicalPath);
      if (!record) {
        record = getActiveContributionBySession(obs.sessionId);
      }
    }

    // Stage 2.D cross-session linking: when the path-first lookup
    // matched a record from a different session, append the current
    // session.
    if (record && !record.linkedSessionIds.includes(obs.sessionId)) {
      addLinkedSession(record.id, obs.sessionId);
      // Re-read so downstream writes see the linked record.
      const refreshed = getContributionById(record.id);
      if (refreshed) record = refreshed;
    }

    const state: ReducerState | undefined = record
      ? {
          status: record.status,
          lastBuildDetectedAt: record.lastBuildDetectedAt,
          lastTestPassedAt: record.lastTestPassedAt,
          lastRegisteredAt: record.lastRegisteredAt,
          lastReadyRequestedAt: record.lastReadyRequestedAt,
          lastBuildFingerprint: record.lastBuildFingerprint,
          lastTransitionError: record.lastTransitionError,
          turnIndexWindow: record.turnIndexWindow,
          lastSoftwareEngineerTaskCompletedAt: record.lastSoftwareEngineerTaskCompletedAt,
          lastSoftwareEngineerEvidenceInvalidatedAt: record.lastSoftwareEngineerEvidenceInvalidatedAt,
          lastSoftwareEngineerEvidenceInvalidatedReason: record.lastSoftwareEngineerEvidenceInvalidatedReason,
        }
      : undefined;

    const output = reduceObservation({
      observation: obs,
      state,
      observedFingerprint,
      now,
      enforceSoftwareEngineerEvidence: options?.enforceSoftwareEngineerEvidence ?? false,
    });

    const result = applyReducerOutput(obs, record, output, observedFingerprint);

    if (
      shouldApplyPathLockInvariant(obs)
      && result.contributionId
      && typeof pathLockTurnIndex === 'number'
    ) {
      applyPathLockInvariantForContribution({
        contributionId: result.contributionId,
        sessionId: obs.sessionId,
        turnIndex: pathLockTurnIndex,
      });
    }

    return result;
  }).catch((err) => {
    log.warn(
      {
        err,
        kind: obs.kind,
        sessionId: obs.sessionId,
        source: obs.source,
        canonicalPath: canonicalPathForLogs,
        mutexKey,
      },
      'Observation entrypoint threw — returning rejected envelope',
    );
    return {
      decision: 'rejected' as const,
      reason: 'internal_error',
      promoted: false,
      fingerprintMismatch: false,
    };
  });
}

/**
 * Dispatch the reducer's `ReducerOutput` to the appropriate Stage 3.C
 * store helpers. Returns the `ObservationResult` envelope.
 *
 * Kept as a separate function (rather than inline) for readability —
 * the four-output switch is the densest part of the entrypoint and
 * benefits from being its own scope.
 */
function applyReducerOutput(
  obs: Observation,
  record: ConnectorContribution | undefined,
  output: ReducerOutput,
  observedFingerprint: string | undefined,
): ObservationResult {
  switch (output.kind) {
    case 'create_record': {
      // Connector name lives only on `build_detected` / `server_registered` /
      // `ready_requested`. `test_passed` doesn't carry one (and the reducer
      // never emits `create_record` for `test_passed` — matrix #22).
      const connectorName =
        obs.kind === 'build_detected'
        || obs.kind === 'server_registered'
        || obs.kind === 'ready_requested'
          ? obs.connectorName
          : 'unknown-connector';
      const fingerprintForCreate =
        output.fields.lastBuildFingerprint ?? observedFingerprint;
      const created = createContribution({
        sessionId: obs.sessionId,
        connectorName,
        status: output.status,
        attributionMode: 'anonymous',
        ...(obs.kind !== 'software_engineer_task_completed'
          ? { localServerPath: obs.localServerPath }
          : {}),
        ...(fingerprintForCreate !== undefined && { lastBuildFingerprint: fingerprintForCreate }),
      });
      // Stamp the readiness fields the reducer asked for. `lastBuildFingerprint`
      // is already on the record from `createContribution`; the others (build/test/
      // registered/ready timestamps) need explicit setters.
      applyReadinessFieldWrites(created.id, output.fields, {
        skipFingerprint: true,
      });
      log.info(
        {
          kind: obs.kind,
          sessionId: obs.sessionId,
          source: obs.source,
          contributionId: created.id,
          connectorName,
          status: output.status,
        },
        'Observation created contribution',
      );
      return {
        decision: 'created',
        contributionId: created.id,
        reason: `created_${output.status}`,
        promoted: output.status === 'ready_to_submit',
        fingerprintMismatch: false,
      };
    }

    case 'apply_writes': {
      if (!record) {
        // Defensive — reducer should never emit apply_writes without a
        // record. Surface as a noop rather than crashing.
        log.warn(
          { kind: obs.kind, sessionId: obs.sessionId, source: obs.source },
          'Reducer emitted apply_writes with no record — degrading to noop',
        );
        return {
          decision: 'noop',
          reason: 'no_record_to_update',
          promoted: false,
          fingerprintMismatch: false,
        };
      }
      let fingerprintMismatch = false;
      if (output.staleFingerprintInvalidation) {
        fingerprintMismatch = true;
        clearStaleReadinessOnFingerprintChange(
          record.id,
          output.staleFingerprintInvalidation.newFingerprint,
        );
      }
      if (output.clearSoftwareEngineerTaskCompletedAt) {
        clearLastSoftwareEngineerTaskCompletedAt(record.id);
      }
      if (output.setSoftwareEngineerEvidenceInvalidation) {
        setSoftwareEngineerEvidenceInvalidation(record.id, output.setSoftwareEngineerEvidenceInvalidation);
      }
      if (output.clearSoftwareEngineerEvidenceInvalidation) {
        clearSoftwareEngineerEvidenceInvalidation(record.id);
      }
      if (output.clearMissingSeEvidenceTransitionError) {
        updateContribution(record.id, { lastTransitionError: undefined });
      }
      applyReadinessFieldWrites(record.id, output.fields);

      let promoted = false;
      if (output.promote === 'ready_to_submit') {
        const promoteResult = updateContribution(record.id, {
          status: 'ready_to_submit',
        });
        if (promoteResult === null) {
          // Store rejected the transition. Fall through to noop /
          // deferred — the lastTransitionError is already set by the
          // store.
          log.warn(
            {
              kind: obs.kind,
              sessionId: obs.sessionId,
              source: obs.source,
              contributionId: record.id,
              from: record.status,
            },
            'Promotion attempted but store rejected the transition',
          );
        } else if (promoteResult !== undefined) {
          promoted = true;
        }
      }

      const decision = output.deferralReason
        ? 'deferred'
        : promoted || obs.kind === 'ready_requested'
          ? 'updated'
          : 'updated';

      log.info(
        {
          kind: obs.kind,
          sessionId: obs.sessionId,
          source: obs.source,
          contributionId: record.id,
          decision,
          deferralReason: output.deferralReason,
          promoted,
          fingerprintMismatch,
        },
        'Observation applied writes',
      );

      return {
        decision: output.deferralReason ? 'deferred' : 'updated',
        contributionId: record.id,
        reason: output.deferralReason ?? (promoted ? 'promoted' : 'fields_updated'),
        promoted,
        fingerprintMismatch,
      };
    }

    case 'noop': {
      log.info(
        {
          kind: obs.kind,
          sessionId: obs.sessionId,
          source: obs.source,
          contributionId: record?.id,
          reason: output.reason,
        },
        'Observation produced noop',
      );
      return {
        decision: 'noop',
        contributionId: record?.id,
        reason: output.reason,
        promoted: false,
        fingerprintMismatch: false,
      };
    }

    case 'reject': {
      log.warn(
        {
          kind: obs.kind,
          sessionId: obs.sessionId,
          source: obs.source,
          contributionId: record?.id,
          reason: output.reason,
          details: output.details,
        },
        'Observation rejected',
      );
      return {
        decision: 'rejected',
        contributionId: record?.id,
        reason: output.details ?? output.reason,
        promoted: false,
        fingerprintMismatch: false,
      };
    }
  }
}

/**
 * Apply each readiness field setter for the fields the reducer chose to
 * write. Internal helper used by both `create_record` and `apply_writes`
 * branches; `skipFingerprint: true` is set on the create branch where
 * `createContribution` already stamped the fingerprint atomically.
 */
function applyReadinessFieldWrites(
  contributionId: string,
  fields: PartialReadinessFields,
  options?: { skipFingerprint?: boolean },
): void {
  if (fields.lastBuildDetectedAt !== undefined) {
    setLastBuildDetectedAt(contributionId, fields.lastBuildDetectedAt);
  }
  if (fields.lastTestPassedAt !== undefined) {
    setLastTestPassedAt(contributionId, fields.lastTestPassedAt);
  }
  if (fields.lastRegisteredAt !== undefined) {
    setLastRegisteredAt(contributionId, fields.lastRegisteredAt);
  }
  if (fields.lastReadyRequestedAt !== undefined) {
    setLastReadyRequestedAt(contributionId, fields.lastReadyRequestedAt);
  }
  if (
    !options?.skipFingerprint &&
    fields.lastBuildFingerprint !== undefined
  ) {
    setLastBuildFingerprint(contributionId, fields.lastBuildFingerprint);
  }
  if (fields.turnIndexWindow !== undefined) {
    setTurnIndexWindow(contributionId, fields.turnIndexWindow);
  }
  if (fields.lastSoftwareEngineerTaskCompletedAt !== undefined) {
    setLastSoftwareEngineerTaskCompletedAt(
      contributionId,
      fields.lastSoftwareEngineerTaskCompletedAt,
    );
  }
}
