import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@core/logger';
import type { SlackPollGate } from '@shared/utils/slackPollGate';

const mockGetSlackWorkspaceDetails = vi.fn();

vi.mock('../../slackAuthService', () => ({
  getSlackWorkspaces: vi.fn(),
  getSlackWorkspaceDetails: (...args: unknown[]) => mockGetSlackWorkspaceDetails(...args),
  refreshSlackTokens: vi.fn(),
}));

vi.mock('../publicBroadcastSafetyHook', () => ({
  createPublicBroadcastSafetyHook: vi.fn(),
}));

let SlackMentionAdapter: typeof import('../slackMentionAdapter').SlackMentionAdapter;
let ElectronSlackPollGate: typeof import('../electronSlackPollGate').ElectronSlackPollGate;

beforeAll(async () => {
  const [adapterMod, gateMod] = await Promise.all([
    import('../slackMentionAdapter'),
    import('../electronSlackPollGate'),
  ]);
  SlackMentionAdapter = adapterMod.SlackMentionAdapter;
  ElectronSlackPollGate = gateMod.ElectronSlackPollGate;
});

function makeDetails() {
  return {
    botToken: 'xoxb-bot-token',
    userToken: 'xoxp-user-token',
    botUserId: 'UBOT123',
    authedUserId: 'UAUTHED1',
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as Response;
}

function loggerWithInfo(info: ReturnType<typeof vi.fn>): Logger {
  return {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('SlackMentionAdapter cloud poll gate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null and never calls Slack search.messages when paused', async () => {
    const gate: SlackPollGate = {
      shouldPause: vi.fn(() => ({ paused: true, reason: 'cloud-canonical' })),
    };
    const adapter = new SlackMentionAdapter({ slackPollGate: gate, log: loggerWithInfo(vi.fn()) });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(adapter.poll('T1', null, new Set())).resolves.toBeNull();

    expect(gate.shouldPause).toHaveBeenCalledWith('T1');
    expect(mockGetSlackWorkspaceDetails).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs only on pause/resume transitions', async () => {
    const info = vi.fn();
    const gateResults = [
      { paused: true, reason: 'cloud-canonical' },
      { paused: true, reason: 'cloud-canonical' },
      { paused: false, reason: null },
      { paused: false, reason: null },
    ];
    const gate: SlackPollGate = {
      shouldPause: vi.fn(() => gateResults.shift() ?? { paused: false, reason: null }),
    };
    mockGetSlackWorkspaceDetails.mockResolvedValue(null);
    const adapter = new SlackMentionAdapter({ slackPollGate: gate, log: loggerWithInfo(info) });

    await adapter.poll('T1', null, new Set());
    await adapter.poll('T1', null, new Set());
    await adapter.poll('T1', null, new Set());
    await adapter.poll('T1', null, new Set());

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(1, { teamId: 'T1', reason: 'cloud-canonical' }, 'slack_poll_paused_cloud_canonical');
    expect(info).toHaveBeenNthCalledWith(2, { teamId: 'T1' }, 'slack_poll_resumed_cloud_unreachable_or_disabled');
  });

  it('advances lastSeenTs once when transitioning into a paused cloud-canonical window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00Z'));
    const marked: Array<{ sourceId: string; timestamp: string }> = [];
    const gateResults = [
      { paused: true, reason: 'cloud-canonical' },
      { paused: true, reason: 'cloud-canonical' },
      { paused: false, reason: null },
      { paused: true, reason: 'cloud-canonical' },
    ];
    const gate: SlackPollGate = {
      shouldPause: vi.fn(() => gateResults.shift() ?? { paused: false, reason: null }),
    };
    mockGetSlackWorkspaceDetails.mockResolvedValue(null);
    const adapter = new SlackMentionAdapter({
      slackPollGate: gate,
      log: loggerWithInfo(vi.fn()),
      markPolledNow: (sourceId, timestamp) => marked.push({ sourceId, timestamp }),
    });

    await adapter.poll('T1', '100.000', new Set());
    await adapter.poll('T1', '100.000', new Set());
    vi.setSystemTime(new Date('2026-05-03T12:01:00Z'));
    await adapter.poll('T1', '100.000', new Set());
    await adapter.poll('T1', '100.000', new Set());

    expect(marked).toEqual([
      { sourceId: 'T1', timestamp: String(new Date('2026-05-03T12:00:00Z').getTime()) },
      { sourceId: 'T1', timestamp: String(new Date('2026-05-03T12:01:00Z').getTime()) },
    ]);
    vi.useRealTimers();
  });

  it('real ElectronSlackPollGate pauses when settings mirror a connected cloud workspace and cloud is reachable', () => {
    const gate = new ElectronSlackPollGate(
      () => ({
        experimental: {
          slackCloudWebhookEnabled: true,
          cloudSlackWorkspace: {
            teamId: 'T1',
            teamName: 'Acme',
            status: 'connected',
            occurredAt: Date.now(),
          },
        },
      } as never),
      () => true,
    );

    expect(gate.shouldPause('T1')).toEqual({ paused: true, reason: 'cloud-canonical' });
  });

  it('real ElectronSlackPollGate resumes while cloud workspace is disconnecting', () => {
    const gate = new ElectronSlackPollGate(
      () => ({
        experimental: {
          slackCloudWebhookEnabled: true,
          cloudSlackWorkspace: {
            teamId: 'T1',
            teamName: 'Acme',
            status: 'disconnecting',
          },
        },
      } as never),
      () => true,
    );

    expect(gate.shouldPause('T1')).toEqual({ paused: false, reason: null });
  });

  it('passes through when the gate is unpaused for a workspace mismatch', async () => {
    const gate: SlackPollGate = {
      shouldPause: vi.fn(() => ({ paused: false, reason: null })),
    };
    mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: true, messages: { matches: [] } }),
    );
    const adapter = new SlackMentionAdapter({ slackPollGate: gate, log: loggerWithInfo(vi.fn()) });

    await expect(adapter.poll('T2', null, new Set())).resolves.toBeNull();

    expect(gate.shouldPause).toHaveBeenCalledWith('T2');
    expect(fetchSpy).toHaveBeenCalledWith('https://slack.com/api/search.messages', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('does not abort an in-flight poll when the next gate check would pause', async () => {
    let paused = false;
    const gate: SlackPollGate = {
      shouldPause: vi.fn(() => ({ paused, reason: paused ? 'cloud-canonical' : null })),
    };
    mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      paused = true;
      return Promise.resolve(jsonResponse({ ok: true, messages: { matches: [] } }));
    });
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const adapter = new SlackMentionAdapter({ slackPollGate: gate, log: loggerWithInfo(vi.fn()) });

    const pollPromise = adapter.poll('T1', null, new Set());

    await expect(pollPromise).resolves.toBeNull();
    expect(abortSpy).not.toHaveBeenCalled();
  });
});
