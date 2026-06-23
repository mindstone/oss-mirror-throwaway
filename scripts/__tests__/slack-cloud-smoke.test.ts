import { describe, expect, it, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { setStoreFactory, type StoreFactoryOptions } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type { Logger } from '@core/logger';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import { SlackThreadAdapter, type SlackWorkspaceStoreLike } from '@core/services/externalConversation/adapters/slackThreadAdapter';

import {
  createDeterministicSlackPayload,
  createSignedSlackPayload,
  createSlackSignature,
  parseCliArgs,
  redactSmokeOutput,
  runCli,
  runSelfTest,
} from '../slack-cloud-smoke';

describe('slack-cloud-smoke', () => {
  beforeEach(() => {
    setStoreFactory(<T extends Record<string, unknown>>(opts: StoreFactoryOptions<T>) => new TestMemoryStore(opts) as unknown as KeyValueStore<T>);
  });

  it('redacts Slack secrets and signatures from structured failures', () => {
    const signingSecret = 'stage8-signing-secret-must-not-print-123456';
    const signature = createSlackSignature({
      rawBody: '{"ok":true}',
      signingSecret,
      timestamp: '1779854400',
    });
    const redacted = redactSmokeOutput({
      signing_secret: signingSecret,
      signature,
      botToken: 'xoxb-stage8-token-must-not-print',
    });

    expect(redacted).not.toContain(signingSecret);
    expect(redacted).not.toContain(signature);
    expect(redacted).not.toMatch(/v0=[a-f0-9]{16,}/i);
    expect(redacted).not.toMatch(/xoxb-[A-Za-z0-9-]+/);
  });

  it('creates a signed payload that validates against SlackThreadAdapter.verifyInbound', async () => {
    const signingSecret = 'stage8-verify-secret';
    const payload = createDeterministicSlackPayload('verify-inbound');
    const signed = createSignedSlackPayload({ payload, signingSecret });
    const workspaceStore: SlackWorkspaceStoreLike = {
      get: () => ({
        teamId: payload.team_id,
        teamName: 'Smoke Test Workspace',
        botUserId: 'U_SMOKE_BOT',
        botToken: 'xoxb-redacted-test-token',
        installedAt: Date.now(),
        status: 'connected',
      }),
      set: () => undefined,
      updateStatus: () => undefined,
      updateLastSeen: () => undefined,
      clear: () => undefined,
    };
    const logger: Logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const adapter = new SlackThreadAdapter({
      signingSecret,
      workspaceStore,
      log: logger,
    });

    const verified = await adapter.verifyInbound(Buffer.from(signed.rawBody), {
      get(name: string) {
        return signed.headers[name] ?? null;
      },
    });

    expect(verified).toMatchObject({
      kind: 'slack-thread',
      identity: {
        teamId: payload.team_id,
        channelId: payload.event.channel,
        threadTs: payload.event.thread_ts,
      },
    });
  });

  it('self-test posts signed payload and observes slack_webhook_received without leaking secrets', async () => {
    const result = await runSelfTest();

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      logNeedle: 'slack_webhook_received',
    });
    expect(JSON.stringify(result)).not.toMatch(/v0=[a-f0-9]{16,}/i);
    expect(JSON.stringify(result)).not.toContain('slack-smoke-self-test-secret-never-print');
  });

  it('does not echo unexpected high-entropy CLI arguments in parser or stderr failures', async () => {
    const secret = crypto.randomBytes(16).toString('hex');

    let parserMessage = '';
    try {
      parseCliArgs([secret]);
    } catch (err) {
      parserMessage = err instanceof Error ? err.message : String(err);
    }

    expect(parserMessage).not.toEqual('');
    expect(parserMessage).not.toContain(secret);

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exitCode = await runCli([secret]);
      const stderr = stderrSpy.mock.calls.map((call) => call.join(' ')).join('\n');

      expect(exitCode).toBe(1);
      expect(stderr).not.toContain(secret);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
