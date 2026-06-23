export const HOST_TOOL_REASON_VALUES = [
  'ok',
  'cooldown-active',
  'pair-session-not-found',
  'reset-partial-failure',
  'invalid-browser-id',
  'unknown-browser-id',
  'browser-not-installed',
  'browser-running',
  'browser-not-running',
  'extract-failed',
  'reveal-failed',
  'launch-failed',
  'unsupported-browser',
  'no-default-browser',
  'open-failed',
  'approval-not-found',
  'approval-already-resolved',
  'fingerprint-mismatch',
  'session-mismatch',
  'session-unbound',
  'permission-denied',
  'bridge-unreachable',
  'timeout',
  'internal-error',
] as const;

export type HostToolReason = (typeof HOST_TOOL_REASON_VALUES)[number];

export const HOST_TOOL_REASON_MANAGER_ONLY_VALUES = [
  'reset-partial-failure',
  'browser-not-installed',
  'browser-running',
] as const satisfies readonly HostToolReason[];

export interface HostToolResult<T = unknown> {
  ok: boolean;
  reason: HostToolReason;
  userMessage?: string;
  instructions?: string;
  retryable: boolean;
  data?: T;
}
