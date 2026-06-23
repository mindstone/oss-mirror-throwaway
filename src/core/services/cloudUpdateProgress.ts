export type UpdatePhase =
  | 'deploying'
  | 'restarting'
  | 'starting'
  | 'health_check'
  | 'verifying'
  | 'stalled'
  | 'backstop';

export interface UpdateProgressDetail {
  phase: UpdatePhase;
  elapsedSeconds: number;
  machineState?: string;
  lastHealthStatus?: number;
  isTerminalError?: boolean;
}

export interface ClassifyInput {
  machineState?: string;
  machineStateAvailable: boolean;
  healthStatus: number;
  healthBody?: { status?: string; buildCommit?: string };
  expectedTag?: string;
  elapsedMs: number;
  lastPhaseChangeMs: number;
}

export const STALL_THRESHOLD_MS = 90_000;
export const BACKSTOP_THRESHOLD_MS = 900_000;
export const TERMINAL_MACHINE_STATE_GRACE_MS = 15_000;

function normalizeVersion(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') {
    return null;
  }
  return normalized;
}

function extractCommitFromTag(tag: string): string | null {
  const normalized = normalizeVersion(tag);
  if (!normalized) {
    return null;
  }

  const match = /^(?:prod|dev)-(.+)$/i.exec(normalized);
  return match?.[1] ?? null;
}

function isCloudVersionCurrent(
  runningVersion: string | null | undefined,
  latestTag: string,
): boolean {
  const normalizedRunning = normalizeVersion(runningVersion);
  const normalizedTag = normalizeVersion(latestTag);
  if (!normalizedRunning || !normalizedTag) {
    return false;
  }

  const latestCommit = extractCommitFromTag(normalizedTag);
  if (!latestCommit) {
    return false;
  }

  if (normalizedRunning === normalizedTag || normalizedRunning === latestCommit) {
    return true;
  }

  if (normalizedRunning.startsWith(latestCommit) || latestCommit.startsWith(normalizedRunning)) {
    return true;
  }

  const runningCommit = extractCommitFromTag(normalizedRunning);
  if (!runningCommit) {
    return false;
  }

  return (
    runningCommit === latestCommit ||
    runningCommit.startsWith(latestCommit) ||
    latestCommit.startsWith(runningCommit)
  );
}

function detail(input: ClassifyInput, phase: UpdatePhase, isTerminalError?: boolean): UpdateProgressDetail {
  return {
    phase,
    elapsedSeconds: Math.max(0, Math.floor(input.elapsedMs / 1000)),
    machineState: input.machineStateAvailable ? input.machineState : undefined,
    lastHealthStatus: input.healthStatus,
    ...(isTerminalError ? { isTerminalError: true } : {}),
  };
}

function isTerminalMachineState(machineState: string | undefined): boolean {
  return machineState === 'stopped' || machineState === 'destroyed';
}

export function classifyUpdatePhase(input: ClassifyInput): UpdateProgressDetail | null {
  if (input.elapsedMs >= BACKSTOP_THRESHOLD_MS) {
    return detail(input, 'backstop');
  }

  if (input.lastPhaseChangeMs >= STALL_THRESHOLD_MS) {
    return detail(input, 'stalled');
  }

  if (
    input.machineStateAvailable &&
    isTerminalMachineState(input.machineState) &&
    input.elapsedMs > TERMINAL_MACHINE_STATE_GRACE_MS
  ) {
    return detail(input, 'stalled', true);
  }

  if (input.machineStateAvailable) {
    if (input.machineState === 'stopping') {
      return detail(input, 'restarting');
    }

    if (
      input.machineState === 'starting' ||
      input.machineState === 'created' ||
      input.machineState === 'replacing'
    ) {
      return detail(input, 'starting');
    }

    if (input.machineState === 'started' && input.healthStatus === 0) {
      return detail(input, 'health_check');
    }
  }

  if (input.healthStatus === 0) {
    return detail(input, 'deploying');
  }

  if (input.healthStatus >= 500) {
    return detail(input, 'starting');
  }

  if (input.healthStatus === 200) {
    const buildCommit = input.healthBody?.buildCommit;
    const expectedTag = input.expectedTag;

    if (buildCommit && expectedTag) {
      const expectedCommit = extractCommitFromTag(expectedTag);
      if (expectedCommit && isCloudVersionCurrent(buildCommit, expectedTag)) {
        return null;
      }

      return detail(input, 'verifying');
    }
  }

  return detail(input, 'deploying');
}
