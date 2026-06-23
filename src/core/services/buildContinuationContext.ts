/**
 * Build Continuation Context
 *
 * Single canonical context-assembly function for non-initial agent turns.
 * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
 *
 * Header is included iff ALL of:
 *   - input.modeInput.mode !== 'recovery'
 *   - input.resetConversation === false
 *   - settings.enablePriorTurnsHeader === true (or REBEL_PRIOR_TURNS_HEADER env override)
 *   - reader.hasPriorTurns === true (after compaction filter)
 *
 * History is included iff ALL of:
 *   - input.resetConversation === false
 *   - the chosen mode produces history (proactive-main reads from disk;
 *     continuation-accumulator reads from the in-memory accumulator;
 *     recovery suppresses both header and history)
 *
 * Both proactive injection sites in the agent turn pipeline route through
 * this function so the resulting prefix has at most ONE `<prior_turns>`
 * block AND at most ONE `<conversation_history>` block. The CI guard in
 * `__tests__/buildContinuationContext-ci-guard.test.ts` blocks new direct
 * `loadConversationHistory` imports outside the canonical wrapper +
 * recovery paths.
 *
 * Telemetry: every branch (proactive include, feature-disabled, no-prior-turns,
 * reset, recovery) emits exactly ONE `priorTurnsHeader` log via
 * {@link formatPriorTurnsHeaderEvent} with a `source` discriminator so a
 * dropped event is distinguishable from a feature-off run. The continuation
 * passthrough path in `agentTurnExecute.ts` uses the same formatter when it
 * skips this function entirely.
 */

import type { AgentTurnMessage } from '@shared/types';
import type { TurnSessionLogger } from '@core/logger';
import { buildPriorTurnsHeader, type BuildPriorTurnsHeaderResult } from './buildPriorTurnsHeader';
import { loadConversationHistory } from './conversationHistoryService';
import { readPriorTurns, type TranscriptTurnSummary } from './priorTurnsReader';
import { getSettings } from './settingsStore';

/**
 * Minimal logger surface used by this builder. Both `TurnSessionLogger`
 * (turn-scoped) and `Logger` (service-scoped — e.g. `createScopedLogger`)
 * structurally satisfy this, so call sites can pass whichever logger they
 * have in hand without a cast.
 */
export interface ContinuationContextLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Discriminated union for continuation modes. Encoding the mode this way
 * eliminates the iteration-2 reviewer concern that a boolean flag obscures
 * which mode owns the accumulator-derived history.
 */
export type ContinuationContextMode =
  | { mode: 'proactive-main' }
  | { mode: 'continuation-accumulator'; accumulator: AccumulatorState }
  | { mode: 'recovery'; skipHeader: true };

/**
 * Subset of `ConversationStateShape` consumed by the
 * `continuation-accumulator` mode. The full shape lives in
 * `@shared/utils/conversationState.ts`; we narrow to the fields we read so
 * the contract here is explicit.
 */
export interface AccumulatorState {
  messages: AgentTurnMessage[];
}

export interface ContinuationContextInput {
  sessionId: string;
  /**
   * The in-flight turn id used to filter the current turn out of the
   * rendered header (race-avoidance — in-flight turn's transcript is partly
   * written when the header builds).
   *
   * Pass `undefined` when no in-flight turn id exists at the call site, e.g.
   * the AskUserQuestion-continuation path which runs during the
   * just-completed turn BEFORE the next turn's id is issued. Filtering on
   * the prior turn's id would otherwise drop the most relevant summary and
   * defeat the feature for the very scenario it was designed to fix.
   */
  currentTurnId: string | undefined;
  scope: 'main';
  resetConversation: boolean;
  modeInput: ContinuationContextMode;
  turnLogger: ContinuationContextLogger;
}

export interface ContinuationContextMeta {
  headerIncluded: boolean;
  headerBytes: number;
  historyIncluded: boolean;
  historyBytes: number;
  /** True when the prior-turns header collapse strategy fired. */
  truncated: boolean;
}

export interface ContinuationContextOutput {
  /** Ready-to-prepend block; empty string when both header and history are suppressed. */
  prefix: string;
  meta: ContinuationContextMeta;
}

/**
 * Discriminator for the unified telemetry event emitted by every header-decision
 * site. Dashboards group on `source` and read the same `priorTurnsHeader.*`
 * keys regardless of which branch fired, so silent feature-disabled / reset
 * paths cannot be confused with "missing telemetry".
 */
export type PriorTurnsHeaderTelemetrySource =
  | 'proactive'
  | 'continuation-passthrough'
  | 'feature-disabled'
  | 'no-prior-turns'
  | 'reset'
  | 'recovery';

export interface PriorTurnsHeaderTelemetryEvent {
  priorTurnsHeader: {
    included: boolean;
    bytes: number;
    turnCount: number;
    historyIncluded: boolean;
    historyBytes: number;
    truncated: boolean;
  };
  source: PriorTurnsHeaderTelemetrySource;
}

/**
 * Single canonical formatter used by both the proactive injection site (this
 * file) and the continuation-passthrough site (`agentTurnExecute.ts`). Keeps
 * the on-the-wire log shape identical so log-aggregation queries don't need
 * branch-specific selectors.
 */
export function formatPriorTurnsHeaderEvent(
  meta: ContinuationContextMeta,
  source: PriorTurnsHeaderTelemetrySource,
  turnCount = 0,
): PriorTurnsHeaderTelemetryEvent {
  return {
    priorTurnsHeader: {
      included: meta.headerIncluded,
      bytes: meta.headerBytes,
      turnCount,
      historyIncluded: meta.historyIncluded,
      historyBytes: meta.historyBytes,
      truncated: meta.truncated,
    },
    source,
  };
}

/**
 * Internal dependencies — broken out for unit testing without spinning up
 * the real settings store / disk reader / accumulator surfaces.
 */
export interface BuildContinuationContextDeps {
  readPriorTurns: (sessionId: string) => Promise<TranscriptTurnSummary[]>;
  buildPriorTurnsHeader: typeof buildPriorTurnsHeader;
  loadConversationHistory: typeof loadConversationHistory;
  getSettings: typeof getSettings;
  readEnvFlag: () => boolean;
}

const defaultDeps: BuildContinuationContextDeps = {
  readPriorTurns,
  buildPriorTurnsHeader,
  loadConversationHistory,
  getSettings,
  readEnvFlag: () => process.env.REBEL_PRIOR_TURNS_HEADER === '1',
};

const EMPTY_META: ContinuationContextMeta = {
  headerIncluded: false,
  headerBytes: 0,
  historyIncluded: false,
  historyBytes: 0,
  truncated: false,
};

/** Truncate accumulator-derived history to match `loadConversationHistory`'s 100k char budget. */
const ACCUMULATOR_HISTORY_MAX_CHARS = 100_000;

export async function buildContinuationContext(
  input: ContinuationContextInput,
  deps: BuildContinuationContextDeps = defaultDeps,
): Promise<ContinuationContextOutput> {
  if (input.resetConversation) {
    input.turnLogger.info(
      {
        sessionId: input.sessionId,
        mode: input.modeInput.mode,
        ...formatPriorTurnsHeaderEvent(EMPTY_META, 'reset'),
      },
      'buildContinuationContext: resetConversation=true — suppressing header + history',
    );
    return { prefix: '', meta: EMPTY_META };
  }

  if (input.modeInput.mode === 'recovery') {
    input.turnLogger.info(
      {
        sessionId: input.sessionId,
        ...formatPriorTurnsHeaderEvent(EMPTY_META, 'recovery'),
      },
      'buildContinuationContext: recovery mode — suppressing header + history',
    );
    return { prefix: '', meta: EMPTY_META };
  }

  const headerResult = await maybeBuildHeader(input, deps);

  let historyText = '';
  if (input.modeInput.mode === 'proactive-main') {
    historyText = await deps.loadConversationHistory(
      input.sessionId,
      // ContinuationContextLogger is structurally narrower than TurnSessionLogger;
      // loadConversationHistory only invokes debug/info/warn, which both satisfy.
      input.turnLogger as unknown as TurnSessionLogger,
      'proactive injection',
      false,
    );
  } else {
    historyText = renderAccumulatorHistory(input.modeInput.accumulator);
  }

  const meta: ContinuationContextMeta = {
    headerIncluded: headerResult.text.length > 0,
    headerBytes: headerResult.bytes,
    historyIncluded: historyText.length > 0,
    historyBytes: historyText.length,
    truncated: headerResult.truncated,
  };

  const source: PriorTurnsHeaderTelemetrySource = meta.headerIncluded
    ? 'proactive'
    : headerResult.disabledReason === 'feature-disabled'
      ? 'feature-disabled'
      : 'no-prior-turns';
  input.turnLogger.info(
    {
      sessionId: input.sessionId,
      ...formatPriorTurnsHeaderEvent(meta, source, headerResult.turnCount),
    },
    meta.headerIncluded
      ? 'buildContinuationContext: prior-turns header injected'
      : 'buildContinuationContext: prior-turns header omitted',
  );

  return {
    prefix: headerResult.text + historyText,
    meta,
  };
}

type DisabledReason = 'feature-disabled' | 'no-prior-turns';

interface MaybeHeaderResult extends BuildPriorTurnsHeaderResult {
  /**
   * Set when `text` is empty so the caller can distinguish "feature off" from
   * "feature on but no prior turns" for telemetry routing. `undefined` when
   * the header was actually rendered.
   */
  disabledReason?: DisabledReason;
}

async function maybeBuildHeader(
  input: ContinuationContextInput,
  deps: BuildContinuationContextDeps,
): Promise<MaybeHeaderResult> {
  const empty = (reason: DisabledReason): MaybeHeaderResult => ({
    text: '',
    bytes: 0,
    truncated: false,
    turnCount: 0,
    disabledReason: reason,
  });

  const settings = deps.getSettings();
  const settingEnabled = settings.enablePriorTurnsHeader === true;
  const envEnabled = deps.readEnvFlag();
  if (!settingEnabled && !envEnabled) {
    return empty('feature-disabled');
  }

  let summaries: TranscriptTurnSummary[];
  try {
    summaries = await deps.readPriorTurns(input.sessionId);
  } catch (err) {
    input.turnLogger.warn(
      { err, sessionId: input.sessionId },
      'buildContinuationContext: readPriorTurns failed — header omitted',
    );
    return empty('no-prior-turns');
  }

  if (summaries.length === 0) {
    return empty('no-prior-turns');
  }

  return deps.buildPriorTurnsHeader({
    summaries,
    currentTurnId: input.currentTurnId,
  });
}

function renderAccumulatorHistory(accumulator: AccumulatorState): string {
  const accumulatedMessages = accumulator.messages.filter(
    (m) => (m.role === 'assistant' || m.role === 'result') && m.text?.trim(),
  );
  if (accumulatedMessages.length === 0) return '';
  const formatted = accumulatedMessages
    .map((m) => `[${m.role}]: ${m.text}`)
    .join('\n\n');
  const body =
    formatted.length > ACCUMULATOR_HISTORY_MAX_CHARS
      ? '...(truncated)...\n\n' + formatted.slice(-ACCUMULATOR_HISTORY_MAX_CHARS)
      : formatted;
  return (
    '<conversation_history>\n' +
    'The following is the conversation from the previous turn in this session. Continue from where we left off.\n\n' +
    `${body}\n` +
    '</conversation_history>\n\n'
  );
}
