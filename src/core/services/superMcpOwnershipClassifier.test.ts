import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import { SUPER_MCP_SPAWN_ARGV_FLAGS } from '@core/rebelCore/superMcpContract';

 

const logWarn = vi.fn();

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => logWarn(...args),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

const mockGetProcessStartTimeMs = vi.fn();
vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: (...args: unknown[]) => mockGetProcessStartTimeMs(...args),
}));

const mockParseOwnerTagFromCmdline = vi.fn();
vi.mock('@core/services/superMcpOwnerTag', () => ({
  parseOwnerTagFromCmdline: (...args: unknown[]) => mockParseOwnerTagFromCmdline(...args),
}));

const mockFindOwnerByChildPid = vi.fn();
let mockFreshnessWindowMs = 30_000;
vi.mock('@core/services/superMcpOwnerRegistrySingleton', () => ({
  getOwnerRegistry: () => ({
    findOwnerByChildPid: (...args: unknown[]) => mockFindOwnerByChildPid(...args),
    freshnessWindowMs: mockFreshnessWindowMs,
  }),
}));

type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockStat = vi.fn();
vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => mockStat(...args),
  },
  stat: (...args: unknown[]) => mockStat(...args),
}));

import {
  classifyByPid,
  isOwnerAlive,
  killProcessTreeIfStillIdentity,
  type ClassifierResult,
  type OwnerLiveness,
} from './superMcpOwnershipClassifier';

function createErrno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createChild(): ChildProcess {
  return {
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

function mockCmdlineSuccess(cmdline: string): void {
  mockExecFile.mockImplementationOnce(
    (
      _command: string,
      _args: readonly string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => {
      callback(null, cmdline, '');
      return createChild();
    },
  );
}

function mockCmdlineFailure(code = 'EACCES'): void {
  mockExecFile.mockImplementationOnce(
    (
      _command: string,
      _args: readonly string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => {
      callback(createErrno(code), '', '');
      return createChild();
    },
  );
}

describe('superMcpOwnershipClassifier', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    processKillSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((..._args: [number, NodeJS.Signals | number | undefined]) => true) as typeof process.kill,
      );

    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: ExecFileCallback,
      ) => {
        callback(null, 'node super-mcp --transport http', '');
        return createChild();
      },
    );

    mockGetProcessStartTimeMs.mockResolvedValue(1_730_000_000_000);
    mockParseOwnerTagFromCmdline.mockReturnValue(null);
    mockFindOwnerByChildPid.mockResolvedValue(null);
    mockFreshnessWindowMs = 30_000;
    mockStat.mockRejectedValue(createErrno('ENOENT'));
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('classifyByPid() branch coverage', () => {
    it('step 1: returns killable pid-dead when process.kill(pid, 0) sees ESRCH', async () => {
      processKillSpy.mockImplementation(
        ((..._args: [number, NodeJS.Signals | number | undefined]) => {
          throw createErrno('ESRCH');
        }) as typeof process.kill,
      );

      const result = await classifyByPid(101);

      expect(result).toEqual({
        decision: 'killable',
        reason: 'pid-dead',
        identity: { pid: 101, observedStartTimeMs: null },
        ownerSnapshot: null,
      });
    });

    it('step 3: returns unknown cmdline-unreadable when command line cannot be read', async () => {
      mockCmdlineFailure();

      const result = await classifyByPid(102);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('cmdline-unreadable');
    });

    it('step 3: returns unknown not-super-mcp-cmdline for non-super-mcp cmdline', async () => {
      mockCmdlineSuccess('node unrelated-service --port 4100');

      const result = await classifyByPid(103);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('not-super-mcp-cmdline');
    });

    it('returns unknown identity-changed-during-classification when child start-time changes between pre and post cmdline reads', async () => {
      const childPid = 103_1;
      mockGetProcessStartTimeMs
        .mockResolvedValueOnce(1_000)
        .mockResolvedValueOnce(5_000);

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('identity-changed-during-classification');
      expect(result.decision).not.toBe('killable');
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: childPid,
          observedStartTimeBeforeCmdlineMs: 1_000,
          observedStartTimeAfterCmdlineMs: 5_000,
          deltaMs: 4_000,
        }),
        'Super-MCP classifier could not establish stable process identity (start-time read returned null or changed during cmdline read); aborting',
      );
    });

    it('returns unknown identity-changed-during-classification when post-cmdline start-time is null after an initial non-null start-time read', async () => {
      const childPid = 103_2;
      mockGetProcessStartTimeMs
        .mockResolvedValueOnce(1_000)
        .mockResolvedValueOnce(null);

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('identity-changed-during-classification');
      expect(result.decision).not.toBe('killable');
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: childPid,
          observedStartTimeBeforeCmdlineMs: 1_000,
          observedStartTimeAfterCmdlineMs: null,
          deltaMs: null,
        }),
        'Super-MCP classifier could not establish stable process identity (start-time read returned null or changed during cmdline read); aborting',
      );
    });

    it('continues classification when pre and post cmdline start-time reads stay within tolerance', async () => {
      const childPid = 103_3;
      mockGetProcessStartTimeMs
        .mockResolvedValueOnce(1_000)
        .mockResolvedValueOnce(1_500);

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-no-mtime-evidence');
      expect(result.reason).not.toBe('identity-changed-during-classification');
      expect(mockFindOwnerByChildPid).toHaveBeenCalledWith(childPid, 1_500);
    });

    it('returns unknown identity-changed-during-classification when both start-time reads are null (process identity not establishable)', async () => {
      const childPid = 103_4;
      mockGetProcessStartTimeMs
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await classifyByPid(childPid, {
        pidFilePath: '/tmp/super-mcp-1034.pid',
      });

      // Per Caveat 7 follow-up: both-null on either start-time read fails closed.
      // The earlier 'untagged-grace-expired' fall-through is no longer reachable
      // when identity inputs cannot be made consistent.
      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('identity-changed-during-classification');
      // Registry lookup never reached when identity cannot be established.
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
    });

    it('returns unknown identity-changed-during-classification when initial start-time read is null but post-cmdline read succeeds (Caveat 7 — PID-reuse race detection)', async () => {
      // Simulates the Caveat 7 footgun: pre-cmdline start-time read returns null
      // (transient permissions error or race with process exit), then PID is
      // reused for an unrelated live process B before the post-cmdline read,
      // which returns B's start-time. Without strict null-rejection on either side
      // of the consistency guard, the cmdline-tag branch could parse process A's
      // owner-tag and SIGKILL the unrelated process B. With the fix, the classifier
      // fails closed.
      const childPid = 103_5;
      mockGetProcessStartTimeMs
        .mockResolvedValueOnce(null) // first read: process A briefly unreadable
        .mockResolvedValueOnce(7_000); // second read: process B's start-time after PID reuse
      mockParseOwnerTagFromCmdline.mockReturnValue({
        ownerId: '11111111-1111-4111-8111-111111111111',
        ownerPid: 8_888,
        ownerStartTimeMs: 1_000,
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('identity-changed-during-classification');
      // CRITICAL: cmdline-tag parsing (which would have produced 'killable' for an
      // unrelated process whose PID was reused) must not be reached when identity
      // inputs cannot be made consistent. Verified via the parser mock + registry
      // mock both being uncalled.
      expect(mockParseOwnerTagFromCmdline).not.toHaveBeenCalled();
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
    });

    it('step 5: returns protected via cmdline owner tag when owner is alive', async () => {
      const childPid = 104;
      const ownerPid = 204;
      const ownerStart = 5_000;

      mockParseOwnerTagFromCmdline.mockReturnValue({
        ownerId: '11111111-1111-4111-8111-111111111111',
        ownerPid,
        ownerStartTimeMs: ownerStart,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return ownerStart + 500;
        return null;
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('protected');
      expect(result.reason).toBe('owner-alive-via-cmdline-tag');
      expect(result.ownerSnapshot).toEqual({ ownerPid });
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
    });

    it('step 5: returns killable via cmdline owner tag when owner PID is reused', async () => {
      const childPid = 105;
      const ownerPid = 205;
      const ownerStart = 5_000;

      mockParseOwnerTagFromCmdline.mockReturnValue({
        ownerId: '11111111-1111-4111-8111-111111111111',
        ownerPid,
        ownerStartTimeMs: ownerStart,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return ownerStart + 5_000;
        return null;
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('killable');
      expect(result.reason).toBe('owner-dead-via-cmdline-tag');
      expect(result.ownerSnapshot).toEqual({ ownerPid });
    });

    it('guards 260429 orphan-collateral: manager cleanup gate never kills protected or unknown owner-tag decisions', async () => {
      const childPid = 105_1;
      const ownerPid = 205_1;
      const ownerStart = 5_000;
      const childStart = 10_000;
      const ownerId = '11111111-1111-4111-8111-111111111111';
      const ownerTaggedCmdline = [
        'node',
        '/opt/super-mcp/dist/cli.js',
        SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_ID,
        ownerId,
        SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_PID,
        String(ownerPid),
        SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_START,
        String(ownerStart),
      ].join(' ');

      const { parseOwnerTagFromCmdline } = await vi.importActual<typeof import('@core/services/superMcpOwnerTag')>(
        '@core/services/superMcpOwnerTag',
      );
      expect(parseOwnerTagFromCmdline(ownerTaggedCmdline)).toEqual({
        ownerId,
        ownerPid,
        ownerStartTimeMs: ownerStart,
      });

      const managerCleanupGate = async (result: ClassifierResult) => {
        const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();
        // Mirrors superMcpHttpManager's cleanup call-sites: both protected and
        // unknown decisions continue without calling killProcessTreeIfStillIdentity.
        if (result.decision !== 'killable') {
          return doKill;
        }
        if (result.reason === 'pid-dead') {
          return doKill;
        }
        await killProcessTreeIfStillIdentity(
          childPid,
          result.identity.observedStartTimeMs,
          doKill,
        );
        return doKill;
      };

      const classifyAndMaybeKill = async (ownerCurrentStartTimeMs: number | null) => {
        mockCmdlineSuccess(ownerTaggedCmdline);
        mockParseOwnerTagFromCmdline.mockReturnValueOnce({
          ownerId,
          ownerPid,
          ownerStartTimeMs: ownerStart,
        });
        mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
          if (pid === childPid) return childStart;
          if (pid === ownerPid) return ownerCurrentStartTimeMs;
          return null;
        });

        const result = await classifyByPid(childPid);
        const doKill = await managerCleanupGate(result);
        return { result, doKill };
      };

      const protectedCase = await classifyAndMaybeKill(ownerStart);
      expect(protectedCase.result.decision).toBe('protected');
      expect(protectedCase.result.reason).toBe('owner-alive-via-cmdline-tag');
      expect(protectedCase.doKill).not.toHaveBeenCalled();

      const unknownCase = await classifyAndMaybeKill(null);
      expect(unknownCase.result.decision).toBe('unknown');
      expect(unknownCase.result.reason).toBe('owner-liveness-unknown');
      expect(unknownCase.doKill).not.toHaveBeenCalled();

      const killableCase = await classifyAndMaybeKill(ownerStart + 5_000);
      expect(killableCase.result.decision).toBe('killable');
      expect(killableCase.result.reason).toBe('owner-dead-via-cmdline-tag');
      expect(killableCase.doKill).toHaveBeenCalledWith(childPid);
    });

    it('step 6: returns protected via registry lookup when owner is alive', async () => {
      const childPid = 106;
      const ownerPid = 206;
      const ownerStart = 7_000;

      mockFindOwnerByChildPid.mockResolvedValue({
        ownerId: 'owner-a',
        ownerKind: 'desktop',
        ownerPid,
        ownerStartTimeMs: ownerStart,
        childPid,
        childStartTimeMs: 10_000,
        childPort: 3100,
        spawnedAt: 1,
        lastHeartbeatAt: Date.now(),
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return ownerStart + 100;
        return null;
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('protected');
      expect(result.reason).toBe('owner-alive-via-registry-lookup');
      expect(result.ownerSnapshot).toEqual({ ownerKind: 'desktop', ownerPid });
    });

    it('step 6: returns unknown owner-alive-heartbeat-stale when owner is alive but registry heartbeat is stale', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(100_000));

      const childPid = 106_1;
      const ownerPid = 206_1;
      const ownerStart = 7_000;
      mockFreshnessWindowMs = 30_000;

      mockFindOwnerByChildPid.mockResolvedValue({
        ownerId: 'owner-stale',
        ownerKind: 'desktop',
        ownerPid,
        ownerStartTimeMs: ownerStart,
        childPid,
        childStartTimeMs: 10_000,
        childPort: 3101,
        spawnedAt: 1,
        lastHeartbeatAt: 69_999,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return ownerStart + 100;
        return null;
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('owner-alive-heartbeat-stale');
      expect(result.decision).not.toBe('killable');
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-stale',
          ownerKind: 'desktop',
          ownerPid,
          childPid,
          childPort: 3101,
          lastHeartbeatAt: 69_999,
          heartbeatAgeMs: 30_001,
          freshnessWindowMs: 30_000,
          decision: 'unknown',
          reason: 'owner-alive-heartbeat-stale',
        }),
        'Super-MCP owner registry heartbeat is stale; demoting protected to unknown',
      );
    });

    it('step 6: heartbeat boundary at freshnessWindowMs is not stale; 1ms beyond is stale', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));

      const childPid = 106_2;
      const ownerPid = 206_2;
      const ownerStart = 7_500;
      mockFreshnessWindowMs = 30_000;

      mockFindOwnerByChildPid
        .mockResolvedValueOnce({
          ownerId: 'owner-fresh-boundary',
          ownerKind: 'desktop',
          ownerPid,
          ownerStartTimeMs: ownerStart,
          childPid,
          childStartTimeMs: 12_000,
          childPort: 3102,
          spawnedAt: 1,
          lastHeartbeatAt: 970_000,
        })
        .mockResolvedValueOnce({
          ownerId: 'owner-stale-boundary',
          ownerKind: 'desktop',
          ownerPid,
          ownerStartTimeMs: ownerStart,
          childPid,
          childStartTimeMs: 12_000,
          childPort: 3102,
          spawnedAt: 1,
          lastHeartbeatAt: 969_999,
        });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 12_000;
        if (pid === ownerPid) return ownerStart + 250;
        return null;
      });

      const freshResult = await classifyByPid(childPid);
      const staleResult = await classifyByPid(childPid);

      expect(freshResult.decision).toBe('protected');
      expect(freshResult.reason).toBe('owner-alive-via-registry-lookup');
      expect(staleResult.decision).toBe('unknown');
      expect(staleResult.reason).toBe('owner-alive-heartbeat-stale');
    });

    it('step 6: returns killable via registry lookup when owner PID is reused', async () => {
      const childPid = 107;
      const ownerPid = 207;
      const ownerStart = 7_000;

      mockFindOwnerByChildPid.mockResolvedValue({
        ownerId: 'owner-b',
        ownerKind: 'eval-orchestrator',
        ownerPid,
        ownerStartTimeMs: ownerStart,
        childPid,
        childStartTimeMs: 10_000,
        childPort: 3100,
        spawnedAt: 1,
        lastHeartbeatAt: 1,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return ownerStart + 5_000;
        return null;
      });

      const result = await classifyByPid(childPid);

      expect(result.decision).toBe('killable');
      expect(result.reason).toBe('owner-dead-via-registry-lookup');
      expect(result.ownerSnapshot).toEqual({ ownerKind: 'eval-orchestrator', ownerPid });
    });

    it('step 6: when registry lookup rejects reused PID identity, classifier falls back to unknown and no kill runs', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const childPid = 107_1;
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 5_000;
        return null;
      });
      mockFindOwnerByChildPid.mockResolvedValue(null);
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(childPid, {
        pidFilePath: '/tmp/super-mcp-1071.pid',
      });

      const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();
      if (result.decision === 'killable') {
        await killProcessTreeIfStillIdentity(
          childPid,
          result.identity.observedStartTimeMs,
          doKill,
        );
      }

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-grace-expired');
      expect(result.decision).not.toBe('killable');
      expect(mockFindOwnerByChildPid).toHaveBeenCalledWith(childPid, 5_000);
      expect(doKill).not.toHaveBeenCalled();
    });

    it('step 6: when observed child start-time cannot be read, classifier fails closed at the identity-consistency guard (Caveat 7) before reaching registry lookup', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const childPid = 107_2;
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return null;
        return null;
      });
      mockFindOwnerByChildPid.mockResolvedValue(null);
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(childPid, {
        pidFilePath: '/tmp/super-mcp-1072.pid',
      });

      // Per Caveat 7 follow-up: null observed start-time on either side of the
      // cmdline read means identity cannot be established. The classifier aborts
      // BEFORE reaching the registry lookup. This is strictly safer than the prior
      // behavior of passing null through to step 6.
      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('identity-changed-during-classification');
      expect(mockFindOwnerByChildPid).not.toHaveBeenCalled();
    });

    it('returns unknown owner-liveness-unknown for tagged child when owner liveness is unknown even with stale pid file', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const childPid = 111;
      const ownerPid = 211;
      const ownerStart = 6_000;

      mockParseOwnerTagFromCmdline.mockReturnValue({
        ownerId: '11111111-1111-4111-8111-111111111111',
        ownerPid,
        ownerStartTimeMs: ownerStart,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return null;
        return null;
      });
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(childPid, {
        pidFilePath: '/tmp/super-mcp-111.pid',
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('owner-liveness-unknown');
      expect(result.ownerSnapshot).toEqual({ ownerPid });
      expect(result.decision).not.toBe('killable');
    });

    it('returns unknown owner-liveness-unknown for registry identity when owner liveness is unknown even with stale pid file', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const childPid = 112;
      const ownerPid = 212;
      const ownerStart = 8_000;

      mockFindOwnerByChildPid.mockResolvedValue({
        ownerId: 'owner-c',
        ownerKind: 'eval-worker',
        ownerPid,
        ownerStartTimeMs: ownerStart,
        childPid,
        childStartTimeMs: 10_000,
        childPort: 3100,
        spawnedAt: 1,
        lastHeartbeatAt: 1,
      });
      mockGetProcessStartTimeMs.mockImplementation(async (pid: number) => {
        if (pid === childPid) return 10_000;
        if (pid === ownerPid) return null;
        return null;
      });
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(childPid, {
        pidFilePath: '/tmp/super-mcp-112.pid',
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('owner-liveness-unknown');
      expect(result.ownerSnapshot).toEqual({ ownerKind: 'eval-worker', ownerPid });
      expect(result.decision).not.toBe('killable');
    });

    it('step 8 returns unknown untagged-grace-expired when no tag and no registry record exist', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(113, {
        pidFilePath: '/tmp/super-mcp-113.pid',
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-grace-expired');
    });

    it('step 8: returns unknown untagged-grace-expired when pid file mtime exceeds grace window', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mockStat.mockResolvedValue({
        mtimeMs: now - 60_000,
      } as Stats);

      const result = await classifyByPid(108, {
        pidFilePath: '/tmp/super-mcp-108.pid',
        gracePeriodMs: 30_000,
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-grace-expired');
    });

    it('untagged live process with stale PID file is NOT killed automatically — only sweep --include-unknown can act on it', async () => {
      const now = 1_730_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mockCmdlineSuccess('node /path/to/super-mcp --transport http');
      mockParseOwnerTagFromCmdline.mockReturnValue(null);
      mockFindOwnerByChildPid.mockResolvedValue(null);
      mockStat.mockResolvedValue({
        mtimeMs: now - (25 * 60 * 60 * 1000),
      } as Stats);

      const result = await classifyByPid(114, {
        pidFilePath: '/tmp/super-mcp-114.pid',
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-grace-expired');
      expect(mockParseOwnerTagFromCmdline).toHaveBeenCalledWith(
        'node /path/to/super-mcp --transport http',
      );
      expect(mockFindOwnerByChildPid).toHaveBeenCalledWith(
        114,
        1_730_000_000_000,
      );
    });

    it('step 8: returns unknown untagged-no-mtime-evidence when no pidFilePath is available', async () => {
      const result = await classifyByPid(109);

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('untagged-no-mtime-evidence');
    });

    it('step 9: returns unknown unhandled-branch for invalid pid-file metadata', async () => {
      mockStat.mockResolvedValue({
        mtimeMs: Number.NaN,
      } as Stats);

      const result = await classifyByPid(110, {
        pidFilePath: '/tmp/super-mcp-110.pid',
      });

      expect(result.decision).toBe('unknown');
      expect(result.reason).toBe('unhandled-branch');
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 110 }),
        'super-mcp ownership classifier reached unhandled branch',
      );
    });
  });

  describe('isOwnerAlive()', () => {
    it('returns unknown when expectedStartTimeMs is null', async () => {
      const result = await isOwnerAlive(201, null);
      expect(result).toBe<OwnerLiveness>('unknown');
    });

    it('returns dead-or-reused when current start-time is null and owner pid is gone', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(null);
      processKillSpy.mockImplementation(
        ((..._args: [number, NodeJS.Signals | number | undefined]) => {
          throw createErrno('ESRCH');
        }) as typeof process.kill,
      );

      const result = await isOwnerAlive(202, 10_000);

      expect(result).toBe<OwnerLiveness>('dead-or-reused');
    });

    it('returns unknown when current start-time is null but owner pid still exists', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(null);
      processKillSpy.mockImplementation(
        ((..._args: [number, NodeJS.Signals | number | undefined]) => true) as typeof process.kill,
      );

      const result = await isOwnerAlive(203, 10_000);

      expect(result).toBe<OwnerLiveness>('unknown');
    });

    it('returns alive when start-time matches within tolerance', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(10_500);

      const result = await isOwnerAlive(204, 10_000);

      expect(result).toBe<OwnerLiveness>('alive');
    });

    it('returns dead-or-reused when start-time mismatches', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(20_500);

      const result = await isOwnerAlive(205, 10_000);

      expect(result).toBe<OwnerLiveness>('dead-or-reused');
    });
  });

  describe('killProcessTreeIfStillIdentity()', () => {
    it('returns identity-unverifiable when observed start-time is null', async () => {
      const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();

      const result = await killProcessTreeIfStillIdentity(301, null, doKill);

      expect(result).toEqual({ killed: false, reason: 'identity-unverifiable' });
      expect(doKill).not.toHaveBeenCalled();
    });

    it('returns pid-gone when process no longer exists before recheck', async () => {
      processKillSpy.mockImplementation(
        ((..._args: [number, NodeJS.Signals | number | undefined]) => {
          throw createErrno('ESRCH');
        }) as typeof process.kill,
      );
      const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();

      const result = await killProcessTreeIfStillIdentity(302, 10_000, doKill);

      expect(result).toEqual({ killed: false, reason: 'pid-gone' });
      expect(doKill).not.toHaveBeenCalled();
    });

    it('kills process when current start-time matches observed identity', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(10_500);
      const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();

      const result = await killProcessTreeIfStillIdentity(303, 10_000, doKill);

      expect(result).toEqual({ killed: true, reason: 'killed' });
      expect(doKill).toHaveBeenCalledWith(303);
    });

    it('aborts kill when identity no longer matches (PID reuse)', async () => {
      mockGetProcessStartTimeMs.mockResolvedValue(20_500);
      const doKill = vi.fn<() => Promise<void>>().mockResolvedValue();

      const result = await killProcessTreeIfStillIdentity(304, 10_000, doKill);

      expect(result).toEqual({ killed: false, reason: 'no-longer-matches' });
      expect(doKill).not.toHaveBeenCalled();
    });
  });
});
