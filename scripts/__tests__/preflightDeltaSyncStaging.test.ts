import { describe, expect, it } from 'vitest';
import {
  buildDeltaPreflightBody,
  runDeltaSyncPreflight,
  type PreflightConfig,
} from '../preflight-delta-sync-staging';

const config: PreflightConfig = {
  cloudUrl: 'https://staging.example.test',
  token: 'test-token',
  sessionId: 'oversized-session',
};

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

describe('preflight-delta-sync-staging', () => {
  it('builds a metadata-only delta payload below the 5MB gate', () => {
    const built = buildDeltaPreflightBody('session-1', 123);

    expect(built.body).toMatchObject({ baseSeq: 123, events: [] });
    expect(built.payloadBytes).toBeLessThan(5 * 1024 * 1024);
  });

  it('passes when capability, lean preflight, cursor seeding, and delta POST all pass', async () => {
    const calls: string[] = [];
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/health')) {
        return response({ ok: true }, {
          headers: { 'X-Rebel-Capabilities': 'session-event-delta-push,session-metadata-patch' },
        });
      }
      if (url.includes('/events?sinceSeq=0&limit=1')) {
        return response({ events: [], serverSeq: 77, hasMore: false });
      }
      return response({ appliedCount: 0, appliedSeq: [], serverSeq: 77, cloudUpdatedAt: 1 });
    };

    const report = await runDeltaSyncPreflight(config, fetchFn);

    expect(report.ok).toBe(true);
    expect(report.cursor).toBe(77);
    expect(calls).toEqual([
      'https://staging.example.test/api/health',
      'https://staging.example.test/api/sessions/oversized-session/events?sinceSeq=0&limit=1',
      'https://staging.example.test/api/sessions/oversized-session/events',
    ]);
  });

  it('fails red when the staging cloud does not advertise delta push', async () => {
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/health')) return response({ ok: true });
      if (url.includes('/events?sinceSeq=0&limit=1')) return response({ serverSeq: 12 });
      return response({ appliedCount: 0, serverSeq: 12 });
    };

    const report = await runDeltaSyncPreflight(config, fetchFn);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'capability advertisement')).toMatchObject({
      ok: false,
    });
  });
});
