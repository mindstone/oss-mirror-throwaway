import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { parseOwnerTagFromCmdline } from '@core/services/superMcpOwnerTag';
import { getOwnerRegistry } from '@core/services/superMcpOwnerRegistrySingleton';
import { getProcessStartTimeMs } from '@core/utils/processStartTime';

const log = createScopedLogger({ service: 'superMcpOwnershipClassifier' });

const START_TIME_TOLERANCE_MS = 2_000;
const CMDLINE_TIMEOUT_MS = 2_000;
const CMDLINE_MAX_BUFFER_BYTES = 64 * 1024;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type Decision = 'protected' | 'killable' | 'unknown';

export type ClassifierReason =
  | 'pid-dead'
  | 'cmdline-unreadable'
  | 'not-super-mcp-cmdline'
  | 'identity-changed-during-classification'
  | 'owner-alive-via-cmdline-tag'
  | 'owner-alive-heartbeat-stale'
  | 'owner-dead-via-cmdline-tag'
  | 'owner-alive-via-registry-lookup'
  | 'owner-dead-via-registry-lookup'
  | 'owner-liveness-unknown'
  | 'untagged-grace-expired'
  | 'untagged-no-mtime-evidence'
  | 'unhandled-branch';

export interface ClassifierResult {
  decision: Decision;
  reason: ClassifierReason;
  identity: { pid: number; observedStartTimeMs: number | null };
  ownerSnapshot: { ownerKind?: string; ownerPid?: number } | null;
}

export interface ClassifierContext {
  /** Path to the PID file that referenced this pid (only at per-port + Phase-1 PID-file-scan call sites). */
  pidFilePath?: string;
  /** Override grace window (defaults to env REBEL_ORPHAN_GRACE_MS or 24*60*60*1000). */
  gracePeriodMs?: number;
}

/** Tri-state owner liveness check. */
export type OwnerLiveness = 'alive' | 'dead-or-reused' | 'unknown';

export async function classifyByPid(
  pid: number,
  ctx: ClassifierContext = {},
): Promise<ClassifierResult> {
  let observedStartTimeMs: number | null = null;
  let ownerSnapshot: ClassifierResult['ownerSnapshot'] = null;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) {
      return buildResult('killable', 'pid-dead', pid, observedStartTimeMs, ownerSnapshot);
    }
  }

  const observedStartTimeBeforeCmdlineMs = await getProcessStartTimeMs(pid);
  const cmdline = await readProcessCmdline(pid);
  if (cmdline !== null && !looksLikeSuperMcpCmdline(cmdline)) {
    return buildResult('unknown', 'not-super-mcp-cmdline', pid, observedStartTimeMs, ownerSnapshot);
  }
  if (cmdline === null) {
    return buildResult('unknown', 'cmdline-unreadable', pid, observedStartTimeMs, ownerSnapshot);
  }

  const observedStartTimeAfterCmdlineMs = await getProcessStartTimeMs(pid);
  observedStartTimeMs = observedStartTimeAfterCmdlineMs;
  // Identity-input consistency guard: cmdline + start-time must describe the SAME
  // process. If either read is null OR they differ beyond tolerance, the cmdline-tag
  // branch (step 5) cannot trust the cmdline -> tag -> kill path. Fail closed to
  // 'unknown' rather than risk killing an unrelated process whose PID was reused
  // between the two reads. Closes Caveat 7 (DA round-1 follow-up): the original guard
  // was gated on `before !== null`, leaving a hole where a transiently-null first
  // read followed by a successful second read could pair stale cmdline with fresh
  // PID-reuse start-time. Any null on either side now also fails closed.
  if (
    observedStartTimeBeforeCmdlineMs === null
    || observedStartTimeAfterCmdlineMs === null
    || Math.abs(observedStartTimeAfterCmdlineMs - observedStartTimeBeforeCmdlineMs) >= START_TIME_TOLERANCE_MS
  ) {
    log.warn(
      {
        pid,
        observedStartTimeBeforeCmdlineMs,
        observedStartTimeAfterCmdlineMs,
        deltaMs: observedStartTimeBeforeCmdlineMs === null || observedStartTimeAfterCmdlineMs === null
          ? null
          : observedStartTimeAfterCmdlineMs - observedStartTimeBeforeCmdlineMs,
      },
      'Super-MCP classifier could not establish stable process identity (start-time read returned null or changed during cmdline read); aborting',
    );
    return buildResult(
      'unknown',
      'identity-changed-during-classification',
      pid,
      observedStartTimeMs,
      ownerSnapshot,
    );
  }

  let hadIdentityButLivenessUnknown = false;
  const tag = parseOwnerTagFromCmdline(cmdline);
  if (tag) {
    ownerSnapshot = { ownerPid: tag.ownerPid };
    const ownerLive = await isOwnerAlive(tag.ownerPid, tag.ownerStartTimeMs);
    if (ownerLive === 'alive') {
      return buildResult(
        'protected',
        'owner-alive-via-cmdline-tag',
        pid,
        observedStartTimeMs,
        ownerSnapshot,
      );
    }
    if (ownerLive === 'dead-or-reused') {
      return buildResult(
        'killable',
        'owner-dead-via-cmdline-tag',
        pid,
        observedStartTimeMs,
        ownerSnapshot,
      );
    }
    hadIdentityButLivenessUnknown = true;
  }

  const ownerRegistry = getOwnerRegistry();
  const record = await ownerRegistry.findOwnerByChildPid(pid, observedStartTimeMs);
  if (record) {
    ownerSnapshot = {
      ownerKind: record.ownerKind,
      ownerPid: record.ownerPid,
    };
    const ownerLive = await isOwnerAlive(record.ownerPid, record.ownerStartTimeMs);
    if (ownerLive === 'alive') {
      const freshnessWindowMs = ownerRegistry.freshnessWindowMs;
      const heartbeatAgeMs = Date.now() - record.lastHeartbeatAt;
      if (heartbeatAgeMs > freshnessWindowMs) {
        log.warn(
          {
            ownerId: record.ownerId,
            ownerKind: record.ownerKind,
            ownerPid: record.ownerPid,
            childPid: pid,
            childPort: record.childPort,
            lastHeartbeatAt: record.lastHeartbeatAt,
            heartbeatAgeMs,
            freshnessWindowMs,
            decision: 'unknown',
            reason: 'owner-alive-heartbeat-stale',
          },
          'Super-MCP owner registry heartbeat is stale; demoting protected to unknown',
        );
        return buildResult(
          'unknown',
          'owner-alive-heartbeat-stale',
          pid,
          observedStartTimeMs,
          ownerSnapshot,
        );
      }

      return buildResult(
        'protected',
        'owner-alive-via-registry-lookup',
        pid,
        observedStartTimeMs,
        ownerSnapshot,
      );
    }
    if (ownerLive === 'dead-or-reused') {
      return buildResult(
        'killable',
        'owner-dead-via-registry-lookup',
        pid,
        observedStartTimeMs,
        ownerSnapshot,
      );
    }
    hadIdentityButLivenessUnknown = true;
  }

  if (hadIdentityButLivenessUnknown) {
    return buildResult(
      'unknown',
      'owner-liveness-unknown',
      pid,
      observedStartTimeMs,
      ownerSnapshot,
    );
  }

  if (ctx.pidFilePath) {
    try {
      const pidFileStats = await fs.stat(ctx.pidFilePath);
      if (Number.isFinite(pidFileStats.mtimeMs)) {
        const gracePeriodMs = resolveGracePeriodMs(ctx.gracePeriodMs);
        const ageMs = Date.now() - pidFileStats.mtimeMs;
        if (ageMs > gracePeriodMs) {
          return buildResult(
            'unknown',
            'untagged-grace-expired',
            pid,
            observedStartTimeMs,
            ownerSnapshot,
          );
        }
        return buildResult(
          'unknown',
          'untagged-no-mtime-evidence',
          pid,
          observedStartTimeMs,
          ownerSnapshot,
        );
      }
    } catch {
      return buildResult(
        'unknown',
        'untagged-no-mtime-evidence',
        pid,
        observedStartTimeMs,
        ownerSnapshot,
      );
    }
  } else {
    return buildResult(
      'unknown',
      'untagged-no-mtime-evidence',
      pid,
      observedStartTimeMs,
      ownerSnapshot,
    );
  }

  log.warn({ pid, ctx }, 'super-mcp ownership classifier reached unhandled branch');
  return buildResult('unknown', 'unhandled-branch', pid, observedStartTimeMs, ownerSnapshot);
}

export async function isOwnerAlive(
  ownerPid: number,
  expectedStartTimeMs: number | null,
): Promise<OwnerLiveness> {
  if (expectedStartTimeMs === null) {
    return 'unknown';
  }

  const currentStartTimeMs = await getProcessStartTimeMs(ownerPid);
  if (currentStartTimeMs === null) {
    try {
      process.kill(ownerPid, 0);
      return 'unknown';
    } catch (error) {
      if (isErrnoCode(error, 'ESRCH')) {
        return 'dead-or-reused';
      }
      return 'unknown';
    }
  }

  if (Math.abs(currentStartTimeMs - expectedStartTimeMs) < START_TIME_TOLERANCE_MS) {
    return 'alive';
  }
  return 'dead-or-reused';
}

export async function killProcessTreeIfStillIdentity(
  pid: number,
  observedStartTimeMs: number | null,
  doKill: (pid: number) => Promise<void>,
): Promise<{ killed: boolean; reason: 'no-longer-matches' | 'killed' | 'pid-gone' | 'identity-unverifiable' }> {
  if (observedStartTimeMs === null) {
    log.warn({ pid }, 'killProcessTreeIfStillIdentity: cannot reverify identity; abort');
    return { killed: false, reason: 'identity-unverifiable' };
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) {
      return { killed: false, reason: 'pid-gone' };
    }
  }

  const current = await getProcessStartTimeMs(pid);
  if (current === null) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isErrnoCode(error, 'ESRCH')) {
        return { killed: false, reason: 'pid-gone' };
      }
    }

    log.warn({ pid }, 'killProcessTreeIfStillIdentity: current start-time unreadable; abort');
    return { killed: false, reason: 'identity-unverifiable' };
  }

  if (Math.abs(current - observedStartTimeMs) < START_TIME_TOLERANCE_MS) {
    await doKill(pid);
    return { killed: true, reason: 'killed' };
  }

  log.warn(
    { pid, observedStartTimeMs, current, delta: current - observedStartTimeMs },
    'killProcessTreeIfStillIdentity: identity mismatch (PID reuse); abort kill',
  );
  return { killed: false, reason: 'no-longer-matches' };
}

export async function readProcessCmdline(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (process.platform === 'win32') {
    const wmicCmdline = await readProcessCmdlineViaWmic(pid);
    if (wmicCmdline !== null) {
      return wmicCmdline;
    }
    return readProcessCmdlineViaPowerShell(pid);
  }

  try {
    const stdout = await runExecFile('ps', ['-o', 'command=', '-p', String(pid)]);
    const cmdline = stdout.trim();
    return cmdline.length > 0 ? cmdline : null;
  } catch {
    return null;
  }
}

function looksLikeSuperMcpCmdline(cmdline: string): boolean {
  return cmdline.toLowerCase().includes('super-mcp');
}

function buildResult(
  decision: Decision,
  reason: ClassifierReason,
  pid: number,
  observedStartTimeMs: number | null,
  ownerSnapshot: ClassifierResult['ownerSnapshot'],
): ClassifierResult {
  return {
    decision,
    reason,
    identity: {
      pid,
      observedStartTimeMs,
    },
    ownerSnapshot,
  };
}

async function readProcessCmdlineViaWmic(pid: number): Promise<string | null> {
  try {
    const stdout = await runExecFile('wmic', [
      'process',
      'where',
      `"ProcessId=${pid}"`,
      'get',
      'CommandLine',
      '/value',
    ]);
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('CommandLine='));
    if (!line) {
      return null;
    }
    const cmdline = line.slice('CommandLine='.length).trim();
    return cmdline.length > 0 ? cmdline : null;
  } catch {
    return null;
  }
}

async function readProcessCmdlineViaPowerShell(pid: number): Promise<string | null> {
  try {
    const stdout = await runExecFile('powershell', [
      '-NoProfile',
      '-Command',
      `Get-WmiObject Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
    ]);
    const cmdline = stdout.trim();
    return cmdline.length > 0 ? cmdline : null;
  } catch {
    return null;
  }
}

async function runExecFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: CMDLINE_TIMEOUT_MS,
        maxBuffer: CMDLINE_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          LC_ALL: 'C',
          LANG: 'C',
          LC_TIME: 'C',
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(toUtf8(stdout));
      },
    );
  });
}

function resolveGracePeriodMs(contextGracePeriodMs?: number): number {
  if (Number.isFinite(contextGracePeriodMs) && (contextGracePeriodMs as number) > 0) {
    return contextGracePeriodMs as number;
  }

  const envGracePeriodRaw = process.env.REBEL_ORPHAN_GRACE_MS;
  if (typeof envGracePeriodRaw === 'string' && envGracePeriodRaw.trim().length > 0) {
    const parsed = Number.parseInt(envGracePeriodRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_ORPHAN_GRACE_MS;
}

function toUtf8(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}
