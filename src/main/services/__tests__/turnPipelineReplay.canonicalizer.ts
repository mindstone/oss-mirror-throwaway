/**
 * Turn Pipeline Replay — Canonicalizer (R1 Stage 1B)
 *
 * Reads `RecordedSideEffects` from the harness and produces a canonical,
 * comparable JSON shape. Strips non-deterministic fields (timestamps,
 * generated IDs, error stack traces) and sorts each per-surface array by
 * the monotonic capture-sequence index.
 *
 * Per Round 3:
 *   - `expected.sentry` is a unified array sorted by sequence index, each
 *     entry typed as `{ method: 'captureException' | 'captureMessage' |
 *     'reportMcpError'; message: string; context: object; sequence: number }`.
 *   - All other surfaces follow the same pattern: per-surface array sorted
 *     by capture-sequence, with normalized values.
 *
 * Round-2 retry-depth robustness: when recursive `executeAgentTurn` produces
 * nested side-effect groups (depth ≥ 1), the canonicalizer flattens them
 * with explicit `depth` markers. The plan's row 35 covers depth-3 retries.
 *
 * For Stage 1B, depth-handling is a structural seam — the canonicalizer
 * accepts an optional `depth` annotation per call (defaults to 0). The
 * harness's recorder doesn't yet emit depth annotations; Stage 1C will add
 * the mechanism (each retry attempt installs its own sub-recorder under
 * the master harness, similar to a stack).
 *
 * See:
 *   - `docs/plans/260427_refactor_agent_turn_executor_pipeline.md` (Stage 1)
 *   - F12 phase-boundary observability contract
 */

import type { RecordedCall, RecordedSideEffects, SideEffectSurface } from './turnPipelineReplay.harness';

/**
 * Per-call canonical entry. Order is stable (sorted by capture-sequence).
 * The `sequence` field is preserved for debugging but should NOT be
 * asserted across runs (corpus rows compare per-surface arrays as
 * subset/contains, not as exact prefixes).
 */
export interface CanonicalCall {
  readonly sequence: number;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
  /** Optional retry-depth annotation. 0 = primary attempt. */
  readonly depth?: number;
}

/**
 * Canonical Sentry entry — Round 3 unified shape across the 3 surfaces
 * (captureException / captureMessage / reportMcpError).
 *
 * Stack traces are stripped — only `message` is retained. Context objects
 * are deep-cloned by the harness; the canonicalizer normalizes them by
 * sorting object keys.
 */
export interface CanonicalSentryEntry {
  readonly sequence: number;
  readonly method: 'captureException' | 'captureMessage' | 'reportMcpError';
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * Final canonical shape. Each per-surface array contains entries sorted by
 * capture-sequence with normalized values; `timeline` is the master
 * monotonic ordering. Corpus rows assert against this shape via
 * `expect(actual).toMatchObject(fixture.expected)`.
 */
export interface CanonicalizedTrace {
  readonly events: ReadonlyArray<CanonicalCall>;
  readonly registry: ReadonlyArray<CanonicalCall>;
  readonly sentry: ReadonlyArray<CanonicalSentryEntry>;
  readonly log: ReadonlyArray<CanonicalCall>;
  readonly cost: ReadonlyArray<CanonicalCall>;
  readonly proxy: ReadonlyArray<CanonicalCall>;
  readonly tracking: ReadonlyArray<CanonicalCall>;
  readonly cooldown: ReadonlyArray<CanonicalCall>;
  readonly checkpoint: ReadonlyArray<CanonicalCall>;
  readonly sleepBlocker: ReadonlyArray<CanonicalCall>;
  readonly fileChange: ReadonlyArray<CanonicalCall>;
  readonly dynamicImport: ReadonlyArray<CanonicalCall>;
  /** Round-2 F6 expansion (Stage-1B-review add): setupNodeEnvironment PATH writes + applyAuthPlanToEnv. */
  readonly envMutation: ReadonlyArray<CanonicalCall>;
  /** Round-2 F6 expansion (Stage-1B-review add): dispatchErrorRecovery auto-mark-incompatible-profile path. */
  readonly settingsMutation: ReadonlyArray<CanonicalCall>;
  /** Stage 1C Phase 3: queryWithRuntime invocation + queryEnded — normalized query options + router context. */
  readonly query: ReadonlyArray<CanonicalCall>;
  /**
   * R2 Stage 2 / S2-G: persistence-write instrumentation surface (additive, opt-in).
   *
   * **Intentionally optional** so the canonicalized trace stays byte-equivalent for
   * existing fixture rows that pre-date this surface (the corpus uses strict
   * `toEqual(fixture.expected)` comparison). When no `recordPersistence(...)`
   * calls are made, the field is omitted entirely from the returned trace.
   * When persistence is actually recorded, the field is present with the full
   * per-call array — Stage 3a tests can therefore assert against it.
   */
  readonly persistence?: ReadonlyArray<CanonicalCall>;
  readonly timeline: ReadonlyArray<{
    readonly sequence: number;
    readonly surface: SideEffectSurface;
    readonly method: string;
  }>;
}

/**
 * Optional normalization controls. Stage 1B exposes a minimal surface
 * (per-row turnId / sessionId substitution + custom arg normalizer). Stage
 * 1C will extend with retry-depth annotation hooks.
 */
export interface NormalizationOptions {
  /**
   * Replace specific turnId values with a stable sentinel. Useful for
   * corpus rows that drive a turn through a UUID-generated turnId.
   *
   * Example: `{ '<actual-uuid>': '<TURN_ID>' }`.
   */
  readonly turnIdSubstitutions?: Readonly<Record<string, string>>;
  /**
   * Replace specific sessionId values with a stable sentinel.
   */
  readonly sessionIdSubstitutions?: Readonly<Record<string, string>>;
  /**
   * Custom per-arg normalizer applied AFTER the built-in normalization.
   * Returns the normalized value (or the input unchanged).
   */
  readonly normalizeArg?: (value: unknown, surface: SideEffectSurface, method: string) => unknown;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Canonicalize the harness's recorded side effects.
 *
 * @param records      Recorded side effects from the harness.
 * @param normalizers  Optional substitution / normalization controls.
 * @returns A canonicalized trace suitable for `toMatchObject` assertions.
 */
export function canonicalize(
  records: RecordedSideEffects,
  normalizers: NormalizationOptions = {},
): CanonicalizedTrace {
  // 1. Build the master timeline (already in capture-sequence order).
  const allCalls = [...records.timeline].sort((a, b) => a.sequence - b.sequence);

  // 2. Normalize each call's args.
  const normalized = allCalls.map(call => normalizeCall(call, normalizers));

  // 3. Partition into per-surface arrays. Each surface stays in
  //    capture-sequence order because we iterate `normalized` in order.
  const events: CanonicalCall[] = [];
  const registry: CanonicalCall[] = [];
  const sentryEntries: CanonicalSentryEntry[] = [];
  const log: CanonicalCall[] = [];
  const cost: CanonicalCall[] = [];
  const proxy: CanonicalCall[] = [];
  const tracking: CanonicalCall[] = [];
  const cooldown: CanonicalCall[] = [];
  const checkpoint: CanonicalCall[] = [];
  const sleepBlocker: CanonicalCall[] = [];
  const fileChange: CanonicalCall[] = [];
  const dynamicImport: CanonicalCall[] = [];
  const envMutation: CanonicalCall[] = [];
  const settingsMutation: CanonicalCall[] = [];
  const query: CanonicalCall[] = [];
  const persistence: CanonicalCall[] = [];

  for (const call of normalized) {
    const entry: CanonicalCall = {
      sequence: call.sequence,
      method: call.method,
      args: call.args,
    };

    switch (call.surface) {
      case 'event':
        events.push(entry);
        break;
      case 'registry':
        registry.push(entry);
        break;
      case 'sentry':
        sentryEntries.push(toSentryEntry(call));
        break;
      case 'log':
        log.push(entry);
        break;
      case 'cost':
        cost.push(entry);
        break;
      case 'proxy':
        proxy.push(entry);
        break;
      case 'tracking':
        tracking.push(entry);
        break;
      case 'cooldown':
        cooldown.push(entry);
        break;
      case 'checkpoint':
        checkpoint.push(entry);
        break;
      case 'sleepBlocker':
        sleepBlocker.push(entry);
        break;
      case 'fileChange':
        fileChange.push(entry);
        break;
      case 'dynamicImport':
        dynamicImport.push(entry);
        break;
      case 'envMutation':
        envMutation.push(entry);
        break;
      case 'settingsMutation':
        settingsMutation.push(entry);
        break;
      case 'query':
        query.push(entry);
        break;
      case 'persistence':
        // R2 Stage 2 / S2-G: persistence is an instrumentation-only surface
        // for opt-in assertion via `countPersistenceWrites()`. It still gets
        // a canonical projection so canonicalize() is exhaustive over the
        // SideEffectSurface union and the call appears in `timeline`.
        persistence.push(entry);
        break;
      default:
        // Defensive: an unrecognised surface should never happen, but if it
        // does, fail loud rather than silently dropping the call. Per the
        // "silent failure is a bug" guideline.
        throw new Error(`canonicalize: unknown side-effect surface: ${String((call as RecordedCall).surface)}`);
    }
  }

  return {
    events,
    registry,
    sentry: sentryEntries,
    log,
    cost,
    proxy,
    tracking,
    cooldown,
    checkpoint,
    sleepBlocker,
    fileChange,
    dynamicImport,
    envMutation,
    settingsMutation,
    query,
    // R2 Stage 2 / S2-G: include `persistence` only when present, to preserve
    // byte-equivalence of existing fixture rows that pre-date this surface.
    ...(persistence.length > 0 ? { persistence } : {}),
    timeline: normalized.map(c => ({
      sequence: c.sequence,
      surface: c.surface,
      method: c.method,
    })),
  };
}

/**
 * Apply substitutions + the user normalizer to a single recorded call.
 * Returns a new call object (does not mutate input).
 */
function normalizeCall(call: RecordedCall, normalizers: NormalizationOptions): RecordedCall {
  const normalizedArgs = call.args.map(arg => {
    let value = applyStringSubstitutions(arg, normalizers);
    if (normalizers.normalizeArg) {
      value = normalizers.normalizeArg(value, call.surface, call.method);
    }
    return stripNonDeterministic(value);
  });
  return {
    sequence: call.sequence,
    timestamp: 0, // Strip timestamps — non-deterministic.
    surface: call.surface,
    method: call.method,
    args: normalizedArgs,
  };
}

/**
 * Walk an arbitrary value and apply turnId / sessionId substitutions to
 * matching strings. Object/array values are walked recursively.
 */
function applyStringSubstitutions(value: unknown, normalizers: NormalizationOptions): unknown {
  const turnSubs = normalizers.turnIdSubstitutions;
  const sessionSubs = normalizers.sessionIdSubstitutions;
  if (!turnSubs && !sessionSubs) return value;
  return walkAndReplace(value, raw => {
    if (typeof raw !== 'string') return raw;
    if (turnSubs && raw in turnSubs) return turnSubs[raw];
    if (sessionSubs && raw in sessionSubs) return sessionSubs[raw];
    return raw;
  });
}

function walkAndReplace(value: unknown, replace: (raw: unknown) => unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(v => walkAndReplace(v, replace));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkAndReplace(v, replace);
    }
    return out;
  }
  return value;
}

/**
 * Strip non-deterministic fields:
 *   - `timestamp` numeric fields (`Date.now()` clock values).
 *   - Error `stack` properties (line numbers vary across runs).
 *   - High-resolution duration fields (`durationMs`) that are scope-stable
 *     in concept but vary in value.
 *
 * Conservative: only obvious markers are stripped. Phase-specific
 * normalization (e.g., redacting cwd-prefixed paths) is the corpus row's
 * `normalizeArg` callback's responsibility.
 */
function stripNonDeterministic(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripNonDeterministic);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'timestamp' && typeof v === 'number') {
      out[k] = '<TIMESTAMP>';
      continue;
    }
    if (k === 'durationMs' && typeof v === 'number') {
      out[k] = '<DURATION_MS>';
      continue;
    }
    if (k === 'stack' && typeof v === 'string') {
      out[k] = '<STACK>';
      continue;
    }
    // Sub-millisecond timing fields used in pre-turn resolution / phase
    // breadcrumbs. These vary per-run by 0-2 ms which would cause spurious
    // byte-equivalence failures (Stage 1C Phase 2 reviewer must-fix /
    // discovered post-fix flake).
    if (
      typeof v === 'number' &&
      (k === 'mcpResolveMs' ||
        k === 'preTurnResolveMs' ||
        k === 'systemPromptMs' ||
        k === 'phaseDurationMs' ||
        k === 'elapsedMs' ||
        k === 'recoveryMs' ||
        k === 'cleanupMs')
    ) {
      out[k] = '<TIMING_MS>';
      continue;
    }
    out[k] = stripNonDeterministic(v);
  }
  // Sort object keys for stable comparison.
  return sortObjectKeys(out);
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return sorted;
}

/**
 * Convert a Sentry surface call into the unified canonical entry. Method is
 * narrowed to the three known shapes; message is extracted from the args
 * array per call shape:
 *   - `captureException(err, ctx?)` → `message = err.message`.
 *   - `captureMessage(msg, ctx?)` → `message = msg`.
 *   - `reportMcpError(err, ctx?)` → `message = err.message`.
 */
function toSentryEntry(call: RecordedCall): CanonicalSentryEntry {
  const method = call.method as CanonicalSentryEntry['method'];
  const [first, second] = call.args;
  let message: string;
  if (method === 'captureMessage') {
    message = typeof first === 'string' ? first : '';
  } else {
    // captureException / reportMcpError — first arg is the error.
    if (first && typeof first === 'object') {
      const errLike = first as { message?: unknown; __error?: boolean };
      if (errLike.__error && typeof errLike.message === 'string') {
        message = errLike.message;
      } else if (typeof errLike.message === 'string') {
        message = errLike.message;
      } else {
        message = String(first);
      }
    } else if (typeof first === 'string') {
      message = first;
    } else {
      message = String(first ?? '');
    }
  }
  const context = (second && typeof second === 'object' && !Array.isArray(second))
    ? (second as Record<string, unknown>)
    : {};
  return {
    sequence: call.sequence,
    method,
    message,
    context: sortObjectKeys(stripNonDeterministic(context) as Record<string, unknown>),
  };
}
