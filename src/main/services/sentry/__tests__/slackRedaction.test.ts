import { describe, it, expect } from 'vitest';
import { redactObjectDeep, redactSensitiveString } from '@shared/utils/sentryRedaction';

describe('Slack Sentry redaction', () => {
  const rawSigningSecret = 'FAKE-TEST-SIGNING-SECRET-1234567890';
  const rawOauthCode = 'fake-test-oauth-code-value-1234567890';
  const rawBotToken = 'xoxb-FAKE-TEST-BOT-TOKEN-1234567890';
  const rawSignature = 'v0=abcdef1234567890abcdef1234567890';
  const rawPayload = JSON.stringify({
    token: rawBotToken,
    team_id: 'T1',
    event: { type: 'message', text: 'hello' },
  });

  it('redacts signing_secret values in breadcrumb data', () => {
    const redacted = redactObjectDeep({
      breadcrumb: {
        signing_secret: rawSigningSecret,
        slack_signing_secret: rawSigningSecret,
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(rawSigningSecret);
    expect(serialized).toContain('***REDACTED***');
  });

  it('redacts oauth_code values in error capture extras', () => {
    const redacted = redactObjectDeep({
      extra: {
        oauth_code: rawOauthCode,
        url: `https://example.test/callback?oauth_code=${rawOauthCode}`,
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(rawOauthCode);
    expect(serialized).toContain('oauth_code=***REDACTED***');
  });

  it('redacts raw Slack bot tokens from string fields', () => {
    const redacted = redactSensitiveString(`failed with token ${rawBotToken}`);

    expect(redacted).not.toContain(rawBotToken);
    expect(redacted).toContain('***REDACTED***');
  });

  it('redacts raw Slack signature header values', () => {
    const redacted = redactSensitiveString(`x-slack-signature: ${rawSignature}`);

    expect(redacted).not.toContain(rawSignature);
    expect(redacted).toContain('v0=***REDACTED***');
  });

  it('does not leave full Slack payload bodies or token shapes in breadcrumb-like data', () => {
    const redacted = redactObjectDeep({
      message: 'slack_webhook_received',
      data: {
        signature: rawSignature,
        rawPayload,
        bot_token: rawBotToken,
        client_secret: 'client-secret-value',
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(rawPayload);
    expect(serialized).not.toContain(rawBotToken);
    expect(serialized).not.toContain(rawSignature);
    expect(serialized).not.toMatch(/xox[baprs]-[a-zA-Z0-9-]+/);
    expect(serialized).not.toMatch(/v0=[a-f0-9]{16,}/i);
  });
});
