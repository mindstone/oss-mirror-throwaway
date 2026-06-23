import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudRollingTranscript } from '../services/cloudRollingTranscript';
import {
  createHmacV2Signature,
  handleMeetingTranscriptSegmentReceive,
  resetHmacV2NonceCacheForTesting,
} from '../utils/hmacV2';

describe('meeting transcript segment route', () => {
  const hmacSecret = 'meeting-transcript-secret';
  let rollingTranscript: CloudRollingTranscript;
  let server: http.Server;
  let baseUrl: string;
  let receiveEnabled = true;
  let nowMs = Date.now();

  beforeEach(async () => {
    resetHmacV2NonceCacheForTesting();
    rollingTranscript = new CloudRollingTranscript();
    receiveEnabled = true;
    nowMs = Date.now();

    server = http.createServer((req, res) => {
      if (req.url === '/api/meeting/transcript-segment') {
        void handleMeetingTranscriptSegmentReceive(req, res, {
          rollingTranscript,
          receiveEnabled,
          hmacSecret,
          nowMs: () => nowMs,
        }).catch((error) => {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    resetHmacV2NonceCacheForTesting();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createSignedHeaders(args: {
    rawBody: string;
    nonce: string;
    timestampSeconds?: number;
    signingSecret?: string;
  }): Record<string, string> {
    const timestampSeconds = args.timestampSeconds ?? Math.floor(nowMs / 1000);
    const signature = createHmacV2Signature({
      secret: args.signingSecret ?? hmacSecret,
      timestamp: String(timestampSeconds),
      nonce: args.nonce,
      rawBody: args.rawBody,
    });
    return {
      'Content-Type': 'application/json',
      'X-Mindstone-Timestamp': String(timestampSeconds),
      'X-Mindstone-Nonce': args.nonce,
      'X-Mindstone-Signature': signature,
    };
  }

  it('accepts a valid POST payload and appends transcript segments to the rolling store', async () => {
    const payload = {
      recallBotId: 'bot-123',
      meetingTitle: 'Customer call',
      segments: [{
        segmentId: 'seg-1',
        text: 'Welcome everyone',
        speaker: 'Taylor',
        timestamp: nowMs,
        isFinal: true,
        source: 'recall-bot',
      }],
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
      method: 'POST',
      headers: createSignedHeaders({ rawBody, nonce: 'nonce-route-valid' }),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });

    const meetings = rollingTranscript.getActiveMeetings();
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({
      recallBotId: 'bot-123',
      meetingTitle: 'Customer call',
    });
    expect(meetings[0].segments).toHaveLength(1);
    expect(meetings[0].segments[0]?.segmentId).toBe('seg-1');
  });

  it('returns 401 on invalid HMAC while receive is enabled and does not store any segments', async () => {
    const payload = {
      recallBotId: 'bot-invalid-hmac',
      segments: [{
        segmentId: 'seg-invalid',
        text: 'Rejected',
        speaker: 'Casey',
        timestamp: nowMs,
        isFinal: true,
        source: 'recall-bot',
      }],
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
      method: 'POST',
      headers: createSignedHeaders({
        rawBody,
        nonce: 'nonce-invalid-hmac',
        signingSecret: 'wrong-secret',
      }),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    expect(rollingTranscript.getActiveMeetings()).toHaveLength(0);
  });

  it('returns 400 for Zod-invalid payloads even when HMAC is valid and stores nothing', async () => {
    const payload = {
      recallBotId: 'bot-bad-payload',
      meetingTitle: 'Bad payload',
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
      method: 'POST',
      headers: createSignedHeaders({ rawBody, nonce: 'nonce-zod-invalid' }),
      body: rawBody,
    });

    expect(response.status).toBe(400);
    expect(rollingTranscript.getActiveMeetings()).toHaveLength(0);
  });

  it('sets sticky auth_error after an invalid-signature spike', async () => {
    const payload = {
      recallBotId: 'bot-auth-spike',
      meetingTitle: 'Auth spike',
      segments: [{
        segmentId: 'seg-auth-spike',
        text: 'Nope',
        speaker: 'Taylor',
        timestamp: nowMs,
        isFinal: true,
        source: 'recall-bot',
      }],
    };
    const rawBody = JSON.stringify(payload);

    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
        method: 'POST',
        headers: createSignedHeaders({
          rawBody,
          nonce: `nonce-auth-spike-${index}`,
          signingSecret: 'wrong-secret',
        }),
        body: rawBody,
      });
      expect(response.status).toBe(401);
    }

    expect(rollingTranscript.hasStickyAuthError()).toBe(true);
    expect(rollingTranscript.getActiveMeetings()).toHaveLength(0);
  });

  it('returns 503 (not 401) when receive is disabled, even with invalid HMAC and missing nonce', async () => {
    receiveEnabled = false;
    const payload = {
      recallBotId: 'bot-disabled',
      segments: [{
        segmentId: 'seg-disabled',
        text: 'Disabled',
        speaker: 'Casey',
        timestamp: nowMs,
        isFinal: true,
        source: 'recall-bot',
      }],
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mindstone-Timestamp': String(Math.floor(nowMs / 1000)),
        'X-Mindstone-Signature': 'deadbeef',
      },
      body: rawBody,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'feature_disabled',
    });
    expect(rollingTranscript.hasStickyAuthError()).toBe(false);
    expect(rollingTranscript.getActiveMeetings()).toHaveLength(0);
  });

  it('rejects non-POST methods', async () => {
    const response = await fetch(`${baseUrl}/api/meeting/transcript-segment`, {
      method: 'GET',
    });
    expect(response.status).toBe(405);
  });
});
