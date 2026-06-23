/**
 * Turn Pipeline cleanup registry type contracts.
 *
 * Kept cycle-free so `agentTurnCleanup.ts` can use the exhaustive cleanup
 * record types without importing the broader `types.ts` module, which also
 * references recovery contracts.
 */

export type TurnCleanupKey =
  | 'councilTurnIds'
  | 'councilTurnMeta'
  | 'adHocTurnIds'
  | 'adHocTurnMeta'
  | 'proxyRoutes'
  | 'watchdogDisposer'
  | 'turnCheckpointing'
  | 'sleepBlocker'
  | 'registryDeletion'
  | 'sessionEventFinalization'
  | 'costLedgerFlush'
  | 'turnCompletedEvent'
  | 'errorReporterScope';

export type CleanupFn = (turnId: string) => void;

export type AttemptCleanupFnsRecord = Record<TurnCleanupKey, CleanupFn | null>;

export type TerminalCleanupFnsRecord = Record<TurnCleanupKey, CleanupFn | null>;
