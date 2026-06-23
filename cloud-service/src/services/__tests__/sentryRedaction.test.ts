import { describe, expect, it } from 'vitest';
import { redactSentryEvent } from '../sentryRedaction';

describe('cloud sentry redaction', () => {
  it('scrubs Slack secrets across Sentry event request, breadcrumbs, contexts, user, and frame vars', () => {
    const signingSecret = 'slack-signing-secret-value';
    const oauthCode = 'fake-test-oauth-code-value-1234567890';
    const botToken = 'xoxb-FAKE-TEST-BOT-TOKEN-1234567890';
    const signature = 'v0=abcdef1234567890abcdef1234567890';

    const redacted = redactSentryEvent({
      message: `callback URL https://example.test/callback?code=${oauthCode}`,
      extra: { signing_secret: signingSecret },
      request: {
        data: `{"bot_token":"${botToken}","oauth_code":"${oauthCode}"}`,
        headers: { 'x-slack-signature': signature, authorization: `Bearer ${botToken}` },
        cookies: { slack: botToken },
      },
      breadcrumbs: [{ message: `signature ${signature}`, data: { client_secret: signingSecret } }],
      contexts: { slack: { signing_secret: signingSecret, token: botToken } },
      user: { id: 'u1', email: 'person@example.com' },
      exception: {
        values: [{
          value: `failed with ${botToken}`,
          stacktrace: { frames: [{ vars: { bot_token: botToken, oauth_code: oauthCode } }] },
        }],
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(signingSecret);
    expect(serialized).not.toContain(oauthCode);
    expect(serialized).not.toContain(botToken);
    expect(serialized).not.toContain(signature);
    expect(serialized).toContain('***REDACTED***');

    // User identity fields (id, email) are preserved for reporter identification
    const user = (redacted as Record<string, unknown>).user as Record<string, unknown>;
    expect(user.id).toBe('u1');
    expect(user.email).toBe('person@example.com');
  });
});
