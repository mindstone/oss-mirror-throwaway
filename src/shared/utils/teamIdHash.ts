import crypto from 'node:crypto';
import { redactSensitiveString } from './sentryRedaction';

const USER_ACTIONABLE_SLACK_ERROR_CODES: ReadonlySet<string> = new Set([
  'account_inactive',
  'channel_not_found',
  'tokens_revoked',
  'token_revoked',
]);

export function hashTeamId(teamId: string): string {
  return crypto.createHash('sha256').update(teamId).digest('hex').slice(0, 12);
}

export function redactSlackError(err: unknown): { message: string; code?: string } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;

  return {
    message: redactSensitiveString(rawMessage),
    ...(code ? { code } : {}),
  };
}

export function isUserActionable(errorCode: string): boolean {
  return USER_ACTIONABLE_SLACK_ERROR_CODES.has(errorCode);
}
