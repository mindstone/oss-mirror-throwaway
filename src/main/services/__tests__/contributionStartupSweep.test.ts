import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

 
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ homePath: '/Users/testuser' })),
}));

 
vi.mock('@core/utils/portablePath', () => ({
  toPortablePath: vi.fn((value: string) => value.replace(/\\/g, '/')),
}));

 
vi.mock('@core/services/contributionStore', () => ({
  getStuckTestingContributions: vi.fn(() => [] as unknown[]),
  listContributions: vi.fn(() => [] as unknown[]),
}));

 
vi.mock('@core/services/contributionObservationService', () => ({
  observeContribution: vi.fn(async () => ({
    decision: 'updated',
    reason: 'mocked',
    promoted: false,
    fingerprintMismatch: false,
  })),
}));

 
vi.mock('@core/services/mcpConfigManager', () => ({
  getMcpServerNames: vi.fn(async () => [] as string[]),
  readMcpServerDetails: vi.fn(async () => ({ args: undefined })),
}));

 
vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/Users/testuser/.config/mcp.json'),
}));

 
vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

 
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
    },
    existsSync: vi.fn(() => false),
  };
});

import fs from 'node:fs';
import { getStuckTestingContributions } from '@core/services/contributionStore';
import { observeContribution } from '@core/services/contributionObservationService';
import {
  getMcpServerNames,
  readMcpServerDetails,
} from '@core/services/mcpConfigManager';
import {
  runContributionStartupSweep,
  STUCK_AGE_THRESHOLD_MS,
  isAbsoluteCrossPlatformForTests,
} from '../contributionStartupSweep';
import type { ConnectorContribution } from '@core/services/contributionTypes';

// ─── Helpers ────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const OLD_ENOUGH_MS = NOW - (STUCK_AGE_THRESHOLD_MS + 1_000);
const TOO_YOUNG_MS = NOW - 1_000;
const SERVER_PATH = '/Users/testuser/mcp-servers/apple-reminders';

/**
 * Contribution timestamps are stored as ISO strings in production (see
 * `ConnectorContribution.createdAt/updatedAt` in contributionTypes.ts).
 * Tests must use ISO strings so they exercise the real parsing path —
 * earlier tests used numeric timestamps and silently masked the CRITICAL
 * bug where `now - isoString` yielded NaN (GPT-5.5 + Codex CRITICAL).
 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Build a minimal `McpServerConfigDetails` stub for tests. The sweep only
 * touches `args`; all other fields default to null. Declared as the full
 * return type (`Awaited<ReturnType<typeof readMcpServerDetails>>`) so tests
 * don't need ad-hoc casts at every call site.
 */
function makeMcpDetails(
  overrides?: Partial<Awaited<ReturnType<typeof readMcpServerDetails>>>,
): Awaited<ReturnType<typeof readMcpServerDetails>> {
  return {
    name: 'test-server',
    type: null,
    transport: 'stdio',
    command: null,
    args: null,
    url: null,
    cwd: null,
    env: null,
    headers: null,
    description: null,
    ...overrides,
  };
}

function makeTestingContribution(overrides?: Partial<ConnectorContribution>): ConnectorContribution {
  return {
    id: `contrib-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: `session-${Math.random().toString(36).slice(2, 6)}`,
    connectorName: 'apple-reminders',
    status: 'testing',
    attributionMode: 'anonymous',
    localServerPath: SERVER_PATH,
    createdAt: iso(OLD_ENOUGH_MS),
    updatedAt: iso(OLD_ENOUGH_MS),
    acknowledgedEvents: [],
    ...overrides,
  } as ConnectorContribution;
}

// ─── Tests ──────────────────────────────────────────────────────────

/**
 * Stage 3.E (260426): the boot sweep no longer auto-promotes. It emits
 * `build_detected + server_registered` observations per stuck record;
 * the reducer never promotes from boot-time observations alone (no agent
 * intent — the Apple-Reminders re-entry path is intentionally sacrificed
 * per Stage 3 plan § 3.E Decision 3).
 *
 * Tests that previously asserted `result.promoted === 1` now assert
 * `observeContribution` was called with the expected observation shapes.
 */
describe('runContributionStartupSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('HOME', '/Users/testuser');
    vi.stubEnv('USERPROFILE', 'C:\\Users\\testuser');
    vi.mocked(getStuckTestingContributions).mockReturnValue([] as unknown as ConnectorContribution[]);
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(getMcpServerNames).mockResolvedValue([]);
    vi.mocked(readMcpServerDetails).mockResolvedValue(makeMcpDetails());
    vi.mocked(observeContribution).mockResolvedValue({
      decision: 'updated',
      reason: 'mocked',
      promoted: false,
      fingerprintMismatch: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns early with no inspected when no contributions are stuck', async () => {
    vi.mocked(getStuckTestingContributions).mockReturnValue([]);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.inspected).toBe(0);
    expect(result.promoted).toBe(0);
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips contributions younger than the stuck-age threshold (ISO timestamps)', async () => {
    const young = makeTestingContribution({
      id: 'young-1',
      createdAt: iso(TOO_YOUNG_MS),
      updatedAt: iso(TOO_YOUNG_MS),
    });
    // getStuckTestingContributions filters by age in the store, but the
    // sweep also re-validates inside the loop as defence-in-depth. We
    // pass the unfiltered record here to exercise the inner guard.
    vi.mocked(getStuckTestingContributions).mockReturnValue([young]);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.inspected).toBe(1);
    expect(result.skippedYoung).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('young-1');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('regression: young contributions with ISO timestamps are NOT auto-observed (CRITICAL bug guard)', async () => {
    const young = makeTestingContribution({
      id: 'young-iso',
      createdAt: iso(TOO_YOUNG_MS),
      updatedAt: iso(TOO_YOUNG_MS),
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([young]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${SERVER_PATH}/dist/index.js`],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedYoung).toBe(1);
    expect(result.promoted).toBe(0);
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('treats unparseable timestamp as young and skips safely', async () => {
    const broken = makeTestingContribution({
      id: 'broken-ts',
      createdAt: 'not-an-iso' as unknown as string,
      updatedAt: 'also-bad' as unknown as string,
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([broken]);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedYoung).toBe(1);
    expect(result.promoted).toBe(0);
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips stuck contributions when no MCP config is resolved', async () => {
    vi.mocked(getStuckTestingContributions).mockReturnValue([makeTestingContribution()]);

    const result = await runContributionStartupSweep({
      now: NOW,
      configPathOverride: null,
    });

    expect(result.skippedNoConfig).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.remainingIds.length).toBe(1);
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips stuck contributions with no localServerPath', async () => {
    vi.mocked(getStuckTestingContributions).mockReturnValue([
      makeTestingContribution({ id: 'nopath', localServerPath: undefined }),
    ]);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNoPath).toBe(1);
    expect(result.remainingIds).toContain('nopath');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips non-canonical stuck contributions before observation', async () => {
    const nonCanonical = makeTestingContribution({
      id: 'non-canonical',
      localServerPath: '/Users/testuser/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp',
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([nonCanonical]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['fibonacci']);
    vi.mocked(readMcpServerDetails).mockResolvedValue(makeMcpDetails({
      args: ['/Users/testuser/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp/server.js'],
    }));

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('non-canonical');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips relative-path stuck contributions (unknown classification) before observation', async () => {
    const relative = makeTestingContribution({
      id: 'relative-path',
      localServerPath: './scripts/fibonacci-mcp',
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([relative]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['fibonacci']);
    vi.mocked(readMcpServerDetails).mockResolvedValue(makeMcpDetails({
      args: ['./scripts/fibonacci-mcp/server.js'],
    }));

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('relative-path');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips empty-path stuck contributions', async () => {
    const emptyPath = makeTestingContribution({
      id: 'empty-path',
      localServerPath: '',
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([emptyPath]);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNoPath).toBe(1);
    expect(result.remainingIds).toContain('empty-path');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips stuck contributions whose local path no longer exists on disk', async () => {
    vi.mocked(getStuckTestingContributions).mockReturnValue([
      makeTestingContribution({ id: 'ondisk-missing' }),
    ]);
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNotOnDisk).toBe(1);
    expect(result.remainingIds).toContain('ondisk-missing');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('skips stuck contributions that are on disk but not registered in MCP config', async () => {
    vi.mocked(getStuckTestingContributions).mockReturnValue([
      makeTestingContribution({ id: 'not-registered' }),
    ]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['other-server']);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNotRegistered).toBe(1);
    expect(result.remainingIds).toContain('not-registered');
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('emits build_detected + server_registered observations on a healthy stuck record', async () => {
    const stuck = makeTestingContribution({ id: 'contrib-matched-name' });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${SERVER_PATH}/dist/index.js`],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    // Stage 3.E: boot sweep emits TWO observations per record; never
    // auto-promotes. The record stays in `remainingIds` because
    // `lastReadyRequestedAt` was lost on restart.
    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('contrib-matched-name');
    expect(observeContribution).toHaveBeenCalledTimes(2);
    expect(observeContribution).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'build_detected',
        sessionId: stuck.sessionId,
        source: 'startup-sweep',
      }),
    );
    expect(observeContribution).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'server_registered',
        sessionId: stuck.sessionId,
        source: 'startup-sweep',
      }),
    );
  });

  it('emits observations for path-prefix-matched record with renamed connectorName', async () => {
    const stuck = makeTestingContribution({
      id: 'contrib-path-match',
      connectorName: 'renamed-name',
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders-new']);
    vi.mocked(readMcpServerDetails).mockImplementation(async (_cfg, name) => {
      if (name === 'apple-reminders-new') {
        return makeMcpDetails({ args: [`${SERVER_PATH}/dist/index.js`] });
      }
      return makeMcpDetails();
    });

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('contrib-path-match');
    expect(observeContribution).toHaveBeenCalledTimes(2);
  });

  it('is idempotent across repeated invocations', async () => {
    const stuck = makeTestingContribution({ id: 'idempotent' });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${SERVER_PATH}/dist/index.js`],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const first = await runContributionStartupSweep({ now: NOW });
    const second = await runContributionStartupSweep({ now: NOW });

    // Stage 3.E: neither sweep promotes; both emit observations
    // idempotently. The reducer's per-canonical-path mutex serialises
    // concurrent observations.
    expect(first.promoted).toBe(0);
    expect(second.promoted).toBe(0);
    expect(observeContribution).toHaveBeenCalledTimes(4);
  });

  it('surfaces remaining IDs in the result (no auto-promotion at boot)', async () => {
    const healthy = makeTestingContribution({ id: 'healthy-1' });
    const remaining = makeTestingContribution({
      id: 'remaining-1',
      localServerPath: undefined,
    });
    vi.mocked(getStuckTestingContributions).mockReturnValue([healthy, remaining]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${SERVER_PATH}/dist/index.js`],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.promotedIds).toEqual([]);
    // Both records end up in remainingIds — `healthy-1` because the
    // sweep no longer auto-promotes; `remaining-1` because of no path.
    expect(result.remainingIds).toEqual(expect.arrayContaining(['healthy-1', 'remaining-1']));
    expect(result.inspected).toBe(2);
  });

  it('continues the sweep when a per-contribution config scan throws', async () => {
    const stuck1 = makeTestingContribution({ id: 'throws' });
    const stuck2 = makeTestingContribution({ id: 'ok' });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck1, stuck2]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    let firstCall = true;
    vi.mocked(getMcpServerNames).mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error('boom');
      }
      return ['apple-reminders'];
    });
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${SERVER_PATH}/dist/index.js`],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNotRegistered).toBe(1);
    expect(result.remainingIds).toContain('throws');
    expect(result.remainingIds).toContain('ok');
    // Only the second record makes it past registration to observation.
    expect(observeContribution).toHaveBeenCalledTimes(2);
  });

  it('regression: same connectorName at a DIFFERENT path does NOT count as registration', async () => {
    // GPT-5.5 HIGH H2: name-only matching when a path IS known would let
    // a stale same-name contribution be promoted against a different
    // connector's registration. The sweep must verify the MCP config
    // entry's resolved args actually point to THIS contribution's path.
    const stuck = makeTestingContribution({ id: 'stale-same-name' });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: ['/Users/testuser/elsewhere/different-build/dist/index.js'],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.skippedNotRegistered).toBe(1);
    expect(result.promoted).toBe(0);
    expect(observeContribution).not.toHaveBeenCalled();
  });

  it('cross-platform absoluteness: accepts POSIX + both Windows path forms (GPT-5.5 HIGH H3)', () => {
    // POSIX absolute
    expect(isAbsoluteCrossPlatformForTests('/Users/x')).toBe(true);
    expect(isAbsoluteCrossPlatformForTests('C:/Users/x')).toBe(true);
    expect(isAbsoluteCrossPlatformForTests('C:\\Users\\x')).toBe(true);
    expect(isAbsoluteCrossPlatformForTests('foo/bar')).toBe(false);
    expect(isAbsoluteCrossPlatformForTests('./foo')).toBe(false);
  });

  it('iterates ALL args (not just the first) to find a path match', async () => {
    const stuck = makeTestingContribution({ id: 'multi-arg-match' });
    vi.mocked(getStuckTestingContributions).mockReturnValue([stuck]);
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(getMcpServerNames).mockResolvedValue(['apple-reminders']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [
        '--config',
        '/Users/testuser/configs/settings.json',
        `${SERVER_PATH}/dist/index.js`,
      ],
    } as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const result = await runContributionStartupSweep({ now: NOW });

    expect(result.promoted).toBe(0);
    expect(result.remainingIds).toContain('multi-arg-match');
    expect(observeContribution).toHaveBeenCalledTimes(2);
  });
});
