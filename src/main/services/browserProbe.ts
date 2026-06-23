import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BROWSER_DEFS, type BrowserId } from '@core/appBridge/installer/browserDetect';
import { createScopedLogger } from '@core/logger';

const PROBE_TIMEOUT_MS = 2_000;
const execFile = promisify(nodeExecFile);
const log = createScopedLogger({ service: 'browserProbe' });

type ExecFileLike = typeof execFile;

interface BrowserProbeDeps {
  execFile?: ExecFileLike;
  logger?: Pick<ReturnType<typeof createScopedLogger>, 'warn'>;
  platform?: NodeJS.Platform;
}

function getBinaryName(browserId: BrowserId, platform: NodeJS.Platform): string | null {
  const browser = BROWSER_DEFS.find((entry) => entry.id === browserId);
  if (!browser) {
    return null;
  }

  const platformDef =
    platform === 'darwin' || platform === 'win32' || platform === 'linux'
      ? browser.platforms[platform]
      : undefined;

  return platformDef?.binaryName ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function outputContainsPosixBinary(
  stdout: string,
  binaryName: string,
  platform: Extract<NodeJS.Platform, 'darwin' | 'linux'>,
): boolean {
  const regex = new RegExp(
    String.raw`(?:^|\/)${escapeRegExp(binaryName)}(?:[\s"']|$)`,
    platform === 'darwin' ? 'i' : '',
  );

  return stdout
    .split(/\r?\n/)
    .some((line) => regex.test(line.trim()));
}

function extractWindowsImageName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const quotedMatch = trimmed.match(/^"([^"]+)"/);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  const firstField = trimmed.split(',', 1)[0]?.trim();
  return firstField ? firstField.replace(/^"|"$/g, '') : null;
}

function outputContainsWindowsImage(stdout: string, binaryName: string): boolean {
  const expected = binaryName.toLowerCase();
  return stdout
    .split(/\r?\n/)
    .some((line) => extractWindowsImageName(line)?.toLowerCase() === expected);
}

function outputContainsBinary(
  stdout: string,
  binaryName: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') {
    return outputContainsWindowsImage(stdout, binaryName);
  }

  if (platform === 'darwin' || platform === 'linux') {
    return outputContainsPosixBinary(stdout, binaryName, platform);
  }

  return false;
}

export async function isBrowserRunning(
  browserId: BrowserId,
  deps: BrowserProbeDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const logger = deps.logger ?? log;
  const binaryName = getBinaryName(browserId, platform);

  if (!binaryName) {
    return false;
  }

  const exec = deps.execFile ?? execFile;
  const command =
    platform === 'win32'
      ? { file: 'tasklist', args: ['/FO', 'CSV', '/NH'] }
      : { file: 'ps', args: ['-axo', 'command'] };

  try {
    const { stdout } = await exec(command.file, command.args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return outputContainsBinary(String(stdout), binaryName, platform);
  } catch (error) {
    logger.warn(
      {
        browserId,
        platform,
        binaryName,
        command: `${command.file} ${command.args.join(' ')}`,
        error: error instanceof Error ? error.message : String(error),
      },
      'Browser running probe failed',
    );
    return false;
  }
}
