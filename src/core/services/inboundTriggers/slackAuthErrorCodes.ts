/**
 * Shared Slack auth-error classification.
 *
 * Keep this surface-agnostic so desktop polling and cloud webhook delivery map
 * expired/revoked Slack credentials to the same reconnect state.
 */

export const SLACK_AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'token_expired',
  'token_revoked',
  'tokens_revoked',
  'account_inactive',
] as const);

export type SlackAuthErrorCode = typeof SLACK_AUTH_ERROR_CODES extends Set<infer T> ? T : never;

export function isSlackAuthErrorCode(value: string | undefined | null): value is SlackAuthErrorCode {
  return Boolean(value && SLACK_AUTH_ERROR_CODES.has(value as SlackAuthErrorCode));
}
