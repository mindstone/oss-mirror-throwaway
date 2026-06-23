import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'processStartTime' });

const SUBPROCESS_TIMEOUT_MS = 2_000;
const EXEC_MAX_BUFFER_BYTES = 64 * 1024;
// Linux `/proc/<pid>/stat` field 22 (starttime) is token index 19 after `comm`.
const LINUX_STARTTIME_INDEX_AFTER_COMM = 19;

interface CommandOutput {
  stdout: string;
  stderr: string;
}

interface LinuxClockInfo {
  bootEpochMs: number;
  clkTck: number;
}

const linuxClockInfoPromise: Promise<LinuxClockInfo | null> =
  process.platform === 'linux'
    ? initializeLinuxClockInfo()
    : Promise.resolve(null);

/**
 * Read a PID's OS-reported process start-time (epoch milliseconds), or `null`
 * when we cannot reliably determine it.
 *
 * This value is used for process-identity checks (PID reuse defense), not as a
 * cross-machine absolute-time signal.
 */
export async function getProcessStartTimeMs(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    if (process.platform === 'darwin') {
      return await getDarwinProcessStartTimeMs(pid);
    }
    if (process.platform === 'linux') {
      return await getLinuxProcessStartTimeMs(pid);
    }
    if (process.platform === 'win32') {
      return await getWindowsProcessStartTimeMs(pid);
    }
  } catch (error) {
    log.debug(
      {
        pid,
        platform: process.platform,
        err: getErrorMessage(error),
      },
      'Unexpected failure while reading process start time',
    );
    return null;
  }

  return null;
}

async function getDarwinProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await runCommand('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const lstart = stdout.trim();
    if (!lstart) {
      return null;
    }
    const parsedMs = Date.parse(lstart);
    if (!Number.isFinite(parsedMs)) {
      log.debug({ pid, lstart }, 'Failed to parse macOS process start-time');
      return null;
    }
    return parsedMs;
  } catch (error) {
    log.debug({ pid, err: getErrorMessage(error) }, 'Failed to read macOS process start-time');
    return null;
  }
}

async function getLinuxProcessStartTimeMs(pid: number): Promise<number | null> {
  const linuxClockInfo = await linuxClockInfoPromise;
  if (!linuxClockInfo) {
    return null;
  }

  try {
    const { stdout } = await runCommand('cat', [`/proc/${pid}/stat`]);
    const startTicks = parseLinuxStartTicks(stdout);
    if (startTicks === null) {
      log.debug({ pid }, 'Failed to parse Linux /proc stat start-time');
      return null;
    }

    const startTimeMs = linuxClockInfo.bootEpochMs + ((startTicks * 1000) / linuxClockInfo.clkTck);
    if (!Number.isFinite(startTimeMs)) {
      log.debug({ pid, startTicks, clkTck: linuxClockInfo.clkTck }, 'Computed Linux process start-time is invalid');
      return null;
    }

    return Math.round(startTimeMs);
  } catch (error) {
    log.debug({ pid, err: getErrorMessage(error) }, 'Failed to read Linux process start-time');
    return null;
  }
}

async function getWindowsProcessStartTimeMs(pid: number): Promise<number | null> {
  const wmicStartTimeMs = await tryReadWindowsStartTimeViaWmic(pid);
  if (typeof wmicStartTimeMs === 'number') {
    return wmicStartTimeMs;
  }
  if (wmicStartTimeMs === 'timed-out') {
    return null;
  }

  return await tryReadWindowsStartTimeViaPowerShell(pid);
}

async function tryReadWindowsStartTimeViaWmic(pid: number): Promise<number | 'timed-out' | null> {
  try {
    const { stdout } = await runCommand('wmic', [
      'process',
      'where',
      `ProcessId=${pid}`,
      'get',
      'CreationDate',
      '/value',
    ]);
    const parsed = parseWindowsWmicCreationDate(stdout);
    if (parsed === null) {
      log.debug({ pid, stdout }, 'Failed to parse WMIC process CreationDate');
      return null;
    }
    return parsed;
  } catch (error) {
    if (isTimeoutError(error)) {
      log.debug({ pid }, 'WMIC start-time read timed out');
      return 'timed-out';
    }
    log.debug({ pid, err: getErrorMessage(error) }, 'WMIC start-time read failed');
    return null;
  }
}

async function tryReadWindowsStartTimeViaPowerShell(pid: number): Promise<number | null> {
  try {
    const { stdout } = await runCommand('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)`,
    ]);
    const text = stdout.trim();
    if (!text) {
      return null;
    }
    const parsedMs = Date.parse(text);
    if (!Number.isFinite(parsedMs)) {
      log.debug({ pid, text }, 'Failed to parse PowerShell process StartTime');
      return null;
    }
    return parsedMs;
  } catch (error) {
    log.debug({ pid, err: getErrorMessage(error) }, 'PowerShell start-time read failed');
    return null;
  }
}

async function initializeLinuxClockInfo(): Promise<LinuxClockInfo | null> {
  const clkTck = await getLinuxClockTicksPerSecond();
  if (clkTck === null) {
    return null;
  }

  try {
    const { stdout } = await runCommand('cat', ['/proc/uptime']);
    const uptimeSeconds = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
      log.debug({ stdout }, 'Failed to parse /proc/uptime');
      return null;
    }

    const bootEpochMs = Date.now() - (uptimeSeconds * 1000);
    if (!Number.isFinite(bootEpochMs)) {
      log.debug({ uptimeSeconds }, 'Computed Linux boot epoch is invalid');
      return null;
    }

    return { bootEpochMs, clkTck };
  } catch (error) {
    log.debug({ err: getErrorMessage(error) }, 'Failed to initialize Linux clock cache');
    return null;
  }
}

async function getLinuxClockTicksPerSecond(): Promise<number | null> {
  try {
    const { stdout } = await runCommand('getconf', ['CLK_TCK']);
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    log.debug({ stdout }, 'Invalid CLK_TCK output');
    return null;
  } catch (error) {
    log.debug({ err: getErrorMessage(error) }, 'Failed to read CLK_TCK');
    return null;
  }
}

function parseLinuxStartTicks(statText: string): number | null {
  const trimmed = statText.trim();
  const lastParenIndex = trimmed.lastIndexOf(')');
  if (lastParenIndex === -1) {
    return null;
  }

  const afterComm = trimmed.slice(lastParenIndex + 1).trim();
  if (!afterComm) {
    return null;
  }

  const fieldsAfterComm = afterComm.split(/\s+/);
  if (fieldsAfterComm.length <= LINUX_STARTTIME_INDEX_AFTER_COMM) {
    return null;
  }

  const startTicks = Number.parseInt(fieldsAfterComm[LINUX_STARTTIME_INDEX_AFTER_COMM], 10);
  if (!Number.isInteger(startTicks) || startTicks < 0) {
    return null;
  }

  return startTicks;
}

function parseWindowsWmicCreationDate(stdout: string): number | null {
  const match = stdout.match(
    /CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})?/,
  );
  if (!match) {
    return null;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    microsecondText,
    offsetText,
  ] = match;

  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  const milliseconds = Math.floor(Number.parseInt(microsecondText, 10) / 1000);
  const offsetMinutes = offsetText ? Number.parseInt(offsetText, 10) : 0;

  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || !Number.isInteger(second)
    || !Number.isInteger(milliseconds)
    || !Number.isInteger(offsetMinutes)
  ) {
    return null;
  }

  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) {
    return null;
  }

  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second, milliseconds)
    - (offsetMinutes * 60_000);

  return Number.isFinite(utcMs) ? utcMs : null;
}

function runCommand(command: string, args: string[]): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const childRef: { current?: ChildProcess } = {};

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        childRef.current?.kill();
      } catch {
        // Best-effort kill on timeout.
      }
      const timeoutError = new Error(`Command timed out after ${SUBPROCESS_TIMEOUT_MS}ms`) as NodeJS.ErrnoException;
      timeoutError.code = 'ETIMEDOUT';
      reject(timeoutError);
    }, SUBPROCESS_TIMEOUT_MS);

    childRef.current = execFile(
      command,
      args,
      {
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', LC_TIME: 'C' },
      },
      (error, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: toUtf8(stdout),
          stderr: toUtf8(stderr),
        });
      },
    );
  });
}

function toUtf8(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ETIMEDOUT';
}
