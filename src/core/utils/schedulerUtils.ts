export const MAX_TIMEOUT_MS = 2147483647;

export const DEFERRAL_DEFAULTS = {
  MAX_DEFERRAL_MS: 5 * 60 * 1000,
  POLL_INTERVAL_MS: 2000,
  GRACE_MS: 5000,
} as const;

export interface DeferralDeps {
  hasInteractiveTurn: () => boolean;
  isShuttingDown: () => boolean;
  logger: {
    info: (data: Record<string, unknown>, msg: string) => void;
    warn: (data: Record<string, unknown>, msg: string) => void;
  };
  entityId: string;
  entityType: string;
}

export interface DeferralResult {
  deferred: boolean;
  deferredMs: number;
  timedOut: boolean;
  shuttingDown: boolean;
}

export async function waitForInteractiveIdle(deps: DeferralDeps): Promise<DeferralResult> {
  const { hasInteractiveTurn, isShuttingDown, logger, entityId, entityType } = deps;
  const start = Date.now();
  const deadline = start + DEFERRAL_DEFAULTS.MAX_DEFERRAL_MS;

  const entityTypeStr = entityType === 'role' ? 'role check-in' : entityType;
  logger.info({ [`${entityType}Id`]: entityId }, `Deferring ${entityTypeStr}: interactive turn in progress`);

  // Outer loop: wait for interactive turn to clear, then grace period
  while (hasInteractiveTurn() && Date.now() < deadline && !isShuttingDown()) {
    await new Promise((resolve) => setTimeout(resolve, DEFERRAL_DEFAULTS.POLL_INTERVAL_MS));
  }

  if (isShuttingDown()) {
    return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
  }

  if (Date.now() >= deadline) {
    const deferredMs = Date.now() - start;
    logger.warn({ [`${entityType}Id`]: entityId, deferredMs }, `${capitalize(entityTypeStr)} deferral timed out, proceeding anyway`);
    return { deferred: true, deferredMs, timedOut: true, shuttingDown: false };
  }

  // Grace period: wait a few seconds in case user starts a new turn
  await new Promise((resolve) => setTimeout(resolve, DEFERRAL_DEFAULTS.GRACE_MS));

  // Re-check after grace: if new interactive turn started and deadline not exceeded, keep waiting
  while (hasInteractiveTurn() && Date.now() < deadline && !isShuttingDown()) {
    await new Promise((resolve) => setTimeout(resolve, DEFERRAL_DEFAULTS.POLL_INTERVAL_MS));

    if (isShuttingDown()) {
      return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
    }

    if (!hasInteractiveTurn()) {
      // Another grace period before proceeding
      await new Promise((resolve) => setTimeout(resolve, DEFERRAL_DEFAULTS.GRACE_MS));
    }
  }

  if (isShuttingDown()) {
    return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
  }

  const deferredMs = Date.now() - start;
  const timedOut = Date.now() >= deadline;

  if (timedOut) {
    logger.warn({ [`${entityType}Id`]: entityId, deferredMs }, `${capitalize(entityTypeStr)} deferral timed out, proceeding anyway`);
  } else {
    logger.info({ [`${entityType}Id`]: entityId, deferredMs }, `Interactive turn cleared, resuming ${entityTypeStr}`);
  }

  return { deferred: true, deferredMs, timedOut, shuttingDown: false };
}

function capitalize(str: string): string {
  if (!str) return str;
  if (str === 'role check-in') return 'Role check-in';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function scheduleWithMaxTimeout(
  callback: () => void,
  delayMs: number,
  onReEvaluate?: () => void,
): NodeJS.Timeout {
  if (delayMs <= 0) {
    // We simulate immediate execution by returning a timeout of 0
    return setTimeout(callback, 0);
  }

  if (delayMs > MAX_TIMEOUT_MS) {
    return setTimeout(() => {
      if (onReEvaluate) {
        onReEvaluate();
      }
    }, MAX_TIMEOUT_MS);
  }

  return setTimeout(callback, delayMs);
}
