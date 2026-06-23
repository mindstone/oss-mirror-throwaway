const PARALLEL_SUBAGENTS_PREFIX = 'parallel:subagents:';

export const PARALLEL_SUBAGENTS_START_PREFIX = `${PARALLEL_SUBAGENTS_PREFIX}start:`;
export const PARALLEL_SUBAGENTS_PROGRESS_PREFIX = `${PARALLEL_SUBAGENTS_PREFIX}progress:`;
export const PARALLEL_SUBAGENTS_COMPLETE_PREFIX = `${PARALLEL_SUBAGENTS_PREFIX}complete:`;
export const TASK_RECOVERY_ORPHANS_MARKED_PREFIX = 'task:recovery:orphans-marked:';

export type ParallelSubagentsStartPayload = {
  requested: number;
  cap: number;
};

export type ParallelSubagentsProgressPayload = {
  running: number;
  succeeded: number;
  failed: number;
  pending: number;
};

export type ParallelSubagentsCompletePayload = {
  requested: number;
  succeeded: number;
  failed: number;
  aborted: number;
  skipped: number;
  durationMs: number;
};

export type TaskRecoveryOrphansMarkedPayload = {
  count: number;
};

type InvalidStatusPayload = {
  kind: 'invalid';
  prefix: string;
  raw: string;
};

export type ParsedParallelSubagentsStatus =
  | { kind: 'start'; payload: ParallelSubagentsStartPayload }
  | { kind: 'progress'; payload: ParallelSubagentsProgressPayload }
  | { kind: 'complete'; payload: ParallelSubagentsCompletePayload }
  | InvalidStatusPayload;

export type ParsedTaskRecoveryStatus =
  | { kind: 'orphans_marked'; payload: TaskRecoveryOrphansMarkedPayload }
  | InvalidStatusPayload;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const normalizeNonNegativeInteger = (value: number): number =>
  Math.max(Math.floor(value), 0);

const warnInvalid = (prefix: string, reason: string, preview: string): void => {
  console.warn('[parallel-subagents-parser] invalid payload', { prefix, reason, preview });
};

type MachineStatusParseResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; invalid: InvalidStatusPayload };

const parseMachineStatusPayload = (
  message: string,
  prefix: string,
): MachineStatusParseResult | null => {
  if (!message.startsWith(prefix)) {
    return null;
  }

  const rawPayload = message.slice(prefix.length);
  try {
    const parsed = JSON.parse(rawPayload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnInvalid(prefix, 'non-object payload', rawPayload.slice(0, 100));
      return { ok: false, invalid: { kind: 'invalid', prefix, raw: message } };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    warnInvalid(prefix, 'malformed JSON', rawPayload.slice(0, 100));
    return { ok: false, invalid: { kind: 'invalid', prefix, raw: message } };
  }
};

const parseParallelSubagentsStart = (message: string): ParsedParallelSubagentsStatus | null => {
  const parsed = parseMachineStatusPayload(message, PARALLEL_SUBAGENTS_START_PREFIX);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return parsed.invalid;
  }

  const requested = parsed.data.requested;
  const cap = parsed.data.cap;
  if (!isFiniteNumber(requested) || !isFiniteNumber(cap)) {
    warnInvalid(PARALLEL_SUBAGENTS_START_PREFIX, 'missing or non-numeric requested/cap', JSON.stringify(parsed.data).slice(0, 100));
    return {
      kind: 'invalid',
      prefix: PARALLEL_SUBAGENTS_START_PREFIX,
      raw: message,
    };
  }

  return {
    kind: 'start',
    payload: {
      requested: normalizeNonNegativeInteger(requested),
      cap: normalizeNonNegativeInteger(cap),
    },
  };
};

const parseParallelSubagentsProgress = (message: string): ParsedParallelSubagentsStatus | null => {
  const parsed = parseMachineStatusPayload(message, PARALLEL_SUBAGENTS_PROGRESS_PREFIX);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return parsed.invalid;
  }

  const running = parsed.data.running;
  const succeeded = parsed.data.succeeded;
  const failed = parsed.data.failed;
  const pending = parsed.data.pending;
  if (!isFiniteNumber(running) || !isFiniteNumber(succeeded) || !isFiniteNumber(failed) || !isFiniteNumber(pending)) {
    warnInvalid(PARALLEL_SUBAGENTS_PROGRESS_PREFIX, 'missing or non-numeric running/succeeded/failed/pending', JSON.stringify(parsed.data).slice(0, 100));
    return {
      kind: 'invalid',
      prefix: PARALLEL_SUBAGENTS_PROGRESS_PREFIX,
      raw: message,
    };
  }

  return {
    kind: 'progress',
    payload: {
      running: normalizeNonNegativeInteger(running),
      succeeded: normalizeNonNegativeInteger(succeeded),
      failed: normalizeNonNegativeInteger(failed),
      pending: normalizeNonNegativeInteger(pending),
    },
  };
};

const parseParallelSubagentsComplete = (message: string): ParsedParallelSubagentsStatus | null => {
  const parsed = parseMachineStatusPayload(message, PARALLEL_SUBAGENTS_COMPLETE_PREFIX);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return parsed.invalid;
  }

  const succeeded = parsed.data.succeeded;
  const failed = parsed.data.failed;
  const aborted = parsed.data.aborted;
  const skipped = parsed.data.skipped;
  const requested = parsed.data.requested;
  const durationMs = parsed.data.durationMs;
  if (!isFiniteNumber(succeeded) || !isFiniteNumber(failed) || !isFiniteNumber(durationMs)) {
    warnInvalid(PARALLEL_SUBAGENTS_COMPLETE_PREFIX, 'missing or non-numeric succeeded/failed/durationMs', JSON.stringify(parsed.data).slice(0, 100));
    return {
      kind: 'invalid',
      prefix: PARALLEL_SUBAGENTS_COMPLETE_PREFIX,
      raw: message,
    };
  }

  const normalizedSucceeded = normalizeNonNegativeInteger(succeeded);
  const normalizedFailed = normalizeNonNegativeInteger(failed);
  const normalizedAborted = isFiniteNumber(aborted) ? normalizeNonNegativeInteger(aborted) : 0;
  const normalizedSkipped = isFiniteNumber(skipped) ? normalizeNonNegativeInteger(skipped) : 0;
  const minimumRequested = normalizedSucceeded + normalizedFailed + normalizedAborted + normalizedSkipped;
  const normalizedRequested = isFiniteNumber(requested)
    ? Math.max(normalizeNonNegativeInteger(requested), minimumRequested)
    : minimumRequested;

  return {
    kind: 'complete',
    payload: {
      requested: normalizedRequested,
      succeeded: normalizedSucceeded,
      failed: normalizedFailed,
      aborted: normalizedAborted,
      skipped: normalizedSkipped,
      durationMs: normalizeNonNegativeInteger(durationMs),
    },
  };
};

export const isParallelSubagentsStatusMessage = (message: string): boolean =>
  message.startsWith(PARALLEL_SUBAGENTS_PREFIX);

export const parseParallelSubagentsStatus = (message: string): ParsedParallelSubagentsStatus | null =>
  parseParallelSubagentsStart(message)
  ?? parseParallelSubagentsProgress(message)
  ?? parseParallelSubagentsComplete(message);

export const formatParallelSubagentsBanner = (parsed: ParsedParallelSubagentsStatus | null): string | null => {
  if (!parsed || parsed.kind === 'invalid' || parsed.kind === 'progress') {
    return null;
  }

  if (parsed.kind === 'start') {
    return parsed.payload.requested > parsed.payload.cap
      ? `Running ${parsed.payload.requested} parallel tasks (cap ${parsed.payload.cap})…`
      : `Running ${parsed.payload.requested} parallel research tasks…`;
  }

  const completed = parsed.payload.succeeded + parsed.payload.failed;
  const details: string[] = [];
  if (parsed.payload.failed > 0) {
    details.push(`${parsed.payload.failed} failed`);
  }
  if (parsed.payload.aborted > 0) {
    details.push(`${parsed.payload.aborted} aborted`);
  }
  if (parsed.payload.skipped > 0) {
    details.push(`${parsed.payload.skipped} skipped`);
  }
  const detailSuffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Finished ${completed} of ${parsed.payload.requested} parallel tasks${detailSuffix}.`;
};

export const isTaskRecoveryStatusMessage = (message: string): boolean =>
  message.startsWith(TASK_RECOVERY_ORPHANS_MARKED_PREFIX);

export const parseTaskRecoveryStatus = (message: string): ParsedTaskRecoveryStatus | null => {
  const parsed = parseMachineStatusPayload(message, TASK_RECOVERY_ORPHANS_MARKED_PREFIX);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return parsed.invalid;
  }

  const count = parsed.data.count;
  if (!isFiniteNumber(count)) {
    warnInvalid(TASK_RECOVERY_ORPHANS_MARKED_PREFIX, 'missing or non-numeric count', JSON.stringify(parsed.data).slice(0, 100));
    return {
      kind: 'invalid',
      prefix: TASK_RECOVERY_ORPHANS_MARKED_PREFIX,
      raw: message,
    };
  }

  return {
    kind: 'orphans_marked',
    payload: {
      count: normalizeNonNegativeInteger(count),
    },
  };
};

export const formatTaskRecoveryBanner = (parsed: ParsedTaskRecoveryStatus | null): string | null => {
  if (!parsed || parsed.kind === 'invalid') {
    return null;
  }

  if (parsed.payload.count <= 0) {
    return null;
  }

  return `Recovered ${parsed.payload.count} interrupted ${parsed.payload.count === 1 ? 'task' : 'tasks'}.`;
};
