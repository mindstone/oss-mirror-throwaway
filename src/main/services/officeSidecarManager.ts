import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fork, type ChildProcess, type ForkOptions, execFile as execFileDefault } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import type { ErrorReporter } from '@core/errorReporter';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig, type PlatformConfig } from '@core/platform';
import {
  sanitizeOfficeSidecarError,
  type OfficeSidecarErrorCode,
} from '@shared/sidecar/errorMessages';
import { redactPathsAndTokens } from './officeSidecarLogRedaction';
import { ReadySignalSchema, type ReadySignal, type WefInstallResult } from '@shared/sidecar/readySignal';
import {
  resolveLastFailureFilePath,
  resolveStateFilePath,
  writeLastFailureFile,
  writeStateFile,
  type SidecarState as PersistedSidecarState,
} from '@shared/sidecar/stateFile';
import type { InstallMetadata, ManagedMcpInstallService } from './managedMcpInstallService';
import { getManagedMcpInstallService } from './managedMcpInstallServiceInstance';
import {
  OFFICE_MCP_PACKAGE_SPECS_TO_TRY,
} from '@shared/sidecar/officePackage';
import { fireAndForget } from '@shared/utils/fireAndForget';

export const OFFICE_SIDECAR_KILL_SWITCH_ENV = 'MCP_OFFICE_SIDECAR_DISABLE';

const START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
const IDENTIFY_TIMEOUT_MS = 2_000;
const LOCK_RETRY_DELAY_MS = 500;
const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_AFTER_MS = 60_000;
const ADOPTED_POLL_INTERVAL_MS = 20_000;
const ADOPTED_FAILURE_THRESHOLD = 3;
const ADOPTED_RESTART_DELAY_MS = 1_000;
const STABILITY_RESET_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 200;
const RESTART_BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 32_000] as const;
const WEF_FAILURE_STDERR_REGEX = /(manifest install|wef).*(failed|error)/i;
const SECURITY_FIND_TIMEOUT_MS = 5_000;
const SECURITY_DELETE_TIMEOUT_MS = 5_000;
const SECURITY_ADD_TRUSTED_CERT_TIMEOUT_MS = 15_000;

export type OfficeSidecarSkipReason = 'kill-switch' | 'surface-not-desktop';

export type { OfficeSidecarErrorCode } from '@shared/sidecar/errorMessages';

export interface SanitizedOfficeSidecarError {
  code: OfficeSidecarErrorCode;
  message: string;
  at: number;
}

export interface OfficeSidecarRuntimeState {
  pid: number;
  port: number;
  adopted: boolean;
  startedAt: number;
  lastHealthAt?: number;
  wefInstallResults?: readonly WefInstallResult[];
}

type SidecarRequestResult = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
};

type SpawnChild = (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;
type RequestSidecar = (port: number, pathname: string, token?: string, timeoutMs?: number) => Promise<SidecarRequestResult>;
type SignalProcess = (pid: number, signal?: NodeJS.Signals | 0) => void;
type IsPidAlive = (pid: number) => boolean;
type ResolveSidecarAsset = () => string | null | Promise<string | null>;
type OfficeManagedInstallLookup = Pick<ManagedMcpInstallService, 'getMetadata'>;
type ExecFileCommand = typeof execFileDefault;

export interface OfficeSidecarTimingOptions {
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  identifyTimeoutMs?: number;
  lockRetryDelayMs?: number;
  lockMaxAttempts?: number;
  lockStaleAfterMs?: number;
  adoptedPollIntervalMs?: number;
  adoptedFailureThreshold?: number;
  adoptedRestartDelayMs?: number;
  stabilityResetMs?: number;
  stopTimeoutMs?: number;
  stopPollIntervalMs?: number;
  restartBackoffsMs?: readonly number[];
}

export interface OfficeSidecarManagerOptions {
  platformConfig: PlatformConfig;
  errorReporter: ErrorReporter;
  logger?: Logger;
  readKillSwitch?: () => string | undefined;
  spawnChild?: SpawnChild;
  requestSidecar?: RequestSidecar;
  signalProcess?: SignalProcess;
  isPidAlive?: IsPidAlive;
  execFile?: ExecFileCommand;
  resolveSidecarScript?: ResolveSidecarAsset;
  resolveAddinDir?: ResolveSidecarAsset;
  managedMcpInstallService?: OfficeManagedInstallLookup;
  timings?: OfficeSidecarTimingOptions;
}

export interface OfficeSidecarManager {
  start(): Promise<OfficeSidecarRuntimeState | null>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getState(): OfficeSidecarRuntimeState | null;
  getSkipReason(): OfficeSidecarSkipReason | null;
  getLastError(): SanitizedOfficeSidecarError | null;
  retryStart(): Promise<OfficeSidecarRuntimeState | null>;
}

type ParsedStateFile = {
  state: PersistedSidecarState;
  stat: fs.Stats;
};

class OfficeSidecarManagerError extends Error {
  constructor(
    message: string,
    readonly code: OfficeSidecarErrorCode,
  ) {
    super(message);
    this.name = 'OfficeSidecarManagerError';
  }
}

let _officeSidecarManagerForShutdown: OfficeSidecarManager | null = null;

function resolveStateDir(platformConfig: PlatformConfig): string {
  return path.join(platformConfig.userDataPath, 'mcp', 'rebeloffice');
}

function resolveStateFile(platformConfig: PlatformConfig): string {
  return resolveStateFilePath(resolveStateDir(platformConfig));
}

function resolveLockFile(platformConfig: PlatformConfig): string {
  return path.join(resolveStateDir(platformConfig), 'sidecar.lock');
}

function isKillSwitchEnabled(raw: string | undefined): boolean {
  if (typeof raw !== 'string') {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function classifyErrorCode(error: unknown): OfficeSidecarErrorCode {
  if (error instanceof OfficeSidecarManagerError) {
    return error.code;
  }

  const err = error as NodeJS.ErrnoException | Error | undefined;
  const raw = `${err?.name ?? ''} ${err?.message ?? ''} ${(err as { code?: string } | undefined)?.code ?? ''}`;

  if (/\bEADDRINUSE\b|port .*in use/i.test(raw)) {
    return 'port-in-use';
  }

  if (/certificate|cert\b|office-addin-dev-certs|trusted access/i.test(raw)) {
    return 'cert-failed';
  }

  if (/manifest install|wef/i.test(raw)) {
    return 'wef-install-failed';
  }

  if (/timed out|timeout/i.test(raw)) {
    return 'spawn-timeout';
  }

  if (/child|exited|crash|signal/i.test(raw)) {
    return 'child-crashed';
  }

  return 'unknown';
}

function toSanitizedError(error: unknown, preferredCode?: OfficeSidecarErrorCode): SanitizedOfficeSidecarError {
  const code = preferredCode ?? classifyErrorCode(error);
  return {
    code,
    message: sanitizeOfficeSidecarError(code),
    at: Date.now(),
  };
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals | 0 = 0): void {
  process.kill(pid, signal);
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    defaultSignalProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultRequestSidecar(
  port: number,
  pathname: string,
  token?: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<SidecarRequestResult> {
  return await new Promise<SidecarRequestResult>((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        rejectUnauthorized: false,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new OfficeSidecarManagerError(`Request timed out for ${pathname}`, 'spawn-timeout'));
    });
    request.once('error', reject);
    request.end();
  });
}

interface ResolvedOfficeInstall {
  readonly metadata: InstallMetadata;
  readonly pathSegments: readonly string[];
}

/**
 * Resolve the Office managed install by trying each scope spec in order
 * (FOX-3319 migration tolerance: see OFFICE_MCP_PACKAGE_SPECS_TO_TRY).
 *
 * Returns both the metadata and the `pathSegments` derived from
 * `metadata.packageName` so callers route to the correct on-disk layout
 * for whichever scope is actually installed. Deriving from packageName
 * keeps the install metadata as the single source of truth for disk
 * layout and avoids a name-vs-pathSegments drift class.
 */
async function getOfficeManagedInstallMetadata(
  installService: OfficeManagedInstallLookup | null,
): Promise<ResolvedOfficeInstall> {
  if (!installService) {
    throw new OfficeSidecarManagerError(
      'Office managed install service is not configured.',
      'spawn-timeout',
    );
  }

  for (const spec of OFFICE_MCP_PACKAGE_SPECS_TO_TRY) {
    const metadata = await installService.getMetadata(spec);
    if (metadata) {
      return {
        metadata,
        pathSegments: ['node_modules', ...metadata.packageName.split('/')],
      };
    }
  }

  throw new OfficeSidecarManagerError(
    `Office managed install not found. Tried: ${OFFICE_MCP_PACKAGE_SPECS_TO_TRY.join(', ')}. ` +
      'Ensure the managed install has completed.',
    'script-not-found',
  );
}

async function defaultResolveSidecarScript(
  installService: OfficeManagedInstallLookup | null,
): Promise<string> {
  const { metadata, pathSegments } = await getOfficeManagedInstallMetadata(installService);
  return path.join(metadata.installRoot, ...pathSegments, 'dist', 'sidecar', 'cli.js');
}

async function defaultResolveAddinDir(
  installService: OfficeManagedInstallLookup | null,
): Promise<string> {
  const { metadata, pathSegments } = await getOfficeManagedInstallMetadata(installService);
  return path.join(metadata.installRoot, ...pathSegments, 'dist', 'addin');
}

interface OfficeAddinDevCertApi {
  verifyCertificates: () => boolean;
  generateCertificates: (
    caCertificatePath: string,
    localhostCertificatePath: string,
    localhostKeyPath: string,
    daysUntilCertificateExpires: number,
    domain: string | readonly string[],
  ) => Promise<void> | void;
  deleteCertificateFiles: (certificateDirectory: string) => void;
}

interface OfficeAddinDevCertDefaults {
  certificateDirectory: string;
  caCertificatePath: string;
  localhostCertificatePath: string;
  localhostKeyPath: string;
  certificateName: string;
  daysUntilCertificateExpires: number;
  domain: string | readonly string[];
}

function unwrapImportedModuleRecord(moduleValue: unknown, moduleLabel: string): Record<string, unknown> {
  if (!moduleValue || typeof moduleValue !== 'object') {
    throw new OfficeSidecarManagerError(
      `Invalid ${moduleLabel} module export shape.`,
      'cert-failed',
    );
  }

  const moduleRecord = moduleValue as Record<string, unknown>;
  const defaultExport = moduleRecord.default;
  if (defaultExport && typeof defaultExport === 'object') {
    return defaultExport as Record<string, unknown>;
  }

  return moduleRecord;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  moduleLabel: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string') {
    throw new OfficeSidecarManagerError(
      `Missing or invalid ${moduleLabel}.${key}.`,
      'cert-failed',
    );
  }
  return candidate;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
  moduleLabel: string,
): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new OfficeSidecarManagerError(
      `Missing or invalid ${moduleLabel}.${key}.`,
      'cert-failed',
    );
  }
  return candidate;
}

function readRequiredFunction<T extends (...args: never[]) => unknown>(
  value: Record<string, unknown>,
  key: string,
  moduleLabel: string,
): T {
  const candidate = value[key];
  if (typeof candidate !== 'function') {
    throw new OfficeSidecarManagerError(
      `Missing or invalid ${moduleLabel}.${key}.`,
      'cert-failed',
    );
  }
  return candidate as T;
}

function readRequiredDomain(
  value: Record<string, unknown>,
  key: string,
  moduleLabel: string,
): string | readonly string[] {
  const candidate = value[key];
  if (typeof candidate === 'string') {
    return candidate;
  }
  if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) {
    return candidate;
  }

  throw new OfficeSidecarManagerError(
    `Missing or invalid ${moduleLabel}.${key}.`,
    'cert-failed',
  );
}

function parseOfficeAddinDevCertApi(moduleValue: unknown): OfficeAddinDevCertApi {
  const moduleRecord = unwrapImportedModuleRecord(moduleValue, 'office-addin-dev-certs');
  return {
    verifyCertificates: readRequiredFunction<OfficeAddinDevCertApi['verifyCertificates']>(
      moduleRecord,
      'verifyCertificates',
      'office-addin-dev-certs',
    ),
    generateCertificates: readRequiredFunction<OfficeAddinDevCertApi['generateCertificates']>(
      moduleRecord,
      'generateCertificates',
      'office-addin-dev-certs',
    ),
    deleteCertificateFiles: readRequiredFunction<OfficeAddinDevCertApi['deleteCertificateFiles']>(
      moduleRecord,
      'deleteCertificateFiles',
      'office-addin-dev-certs',
    ),
  };
}

function parseOfficeAddinDevCertDefaults(moduleValue: unknown): OfficeAddinDevCertDefaults {
  const moduleRecord = unwrapImportedModuleRecord(moduleValue, 'office-addin-dev-certs defaults');
  return {
    certificateDirectory: readRequiredString(
      moduleRecord,
      'certificateDirectory',
      'office-addin-dev-certs defaults',
    ),
    caCertificatePath: readRequiredString(
      moduleRecord,
      'caCertificatePath',
      'office-addin-dev-certs defaults',
    ),
    localhostCertificatePath: readRequiredString(
      moduleRecord,
      'localhostCertificatePath',
      'office-addin-dev-certs defaults',
    ),
    localhostKeyPath: readRequiredString(
      moduleRecord,
      'localhostKeyPath',
      'office-addin-dev-certs defaults',
    ),
    certificateName: readRequiredString(
      moduleRecord,
      'certificateName',
      'office-addin-dev-certs defaults',
    ),
    daysUntilCertificateExpires: readRequiredNumber(
      moduleRecord,
      'daysUntilCertificateExpires',
      'office-addin-dev-certs defaults',
    ),
    domain: readRequiredDomain(
      moduleRecord,
      'domain',
      'office-addin-dev-certs defaults',
    ),
  };
}

function toAbsolutePathFromHome(candidatePath: string, homePath: string): string {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }

  if (candidatePath.startsWith('~/')) {
    return path.join(homePath, candidatePath.slice(2));
  }

  return path.join(homePath, candidatePath);
}

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

async function execFileWithTimeout(
  execFile: ExecFileCommand,
  filePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecFileResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    return await new Promise<ExecFileResult>((resolve, reject) => {
      execFile(
        filePath,
        [...args],
        {
          encoding: 'utf8',
          signal: abortController.signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }

          resolve({
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          });
        },
      );
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new OfficeSidecarManagerError(
        `Timed out running ${filePath}.`,
        'cert-failed',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractSha1HashesFromSecurityFindOutput(output: string): string[] {
  const hashes = new Set<string>();
  for (const match of output.matchAll(/SHA-1 hash:\s*([A-Fa-f0-9]{40})/g)) {
    const hash = match[1];
    if (hash) {
      hashes.add(hash.toUpperCase());
    }
  }
  return [...hashes];
}

async function runOfficeCertPreflight(options: {
  platformConfig: PlatformConfig;
  errorReporter: ErrorReporter;
  log: Logger;
  execFile: ExecFileCommand;
  managedInstallService: OfficeManagedInstallLookup | null;
}): Promise<void> {
  if (options.platformConfig.platform !== 'darwin') {
    return;
  }

  if (!options.managedInstallService) {
    return;
  }

  const addBreadcrumb = (
    level: 'info' | 'warning',
    message: string,
    data: Record<string, unknown> = {},
  ): void => {
    options.errorReporter.addBreadcrumb({
      category: 'office-sidecar',
      level,
      message,
      data,
    });
  };

  addBreadcrumb('info', 'office-sidecar.cert-preflight.start');
  options.log.info(
    {
      event: 'office-sidecar.cert-preflight.start',
    },
    'Running Office sidecar cert pre-flight',
  );

  try {
    const { metadata } = await getOfficeManagedInstallMetadata(options.managedInstallService);
    const devCertsRoot = path.join(metadata.installRoot, 'node_modules', 'office-addin-dev-certs');

    // Pinned to lib/main.js to match upstream package.json "main" field.
    // The contract test in officeSidecarManager.test.ts asserts this.
    // Update both if the upstream package layout changes.
    const [devCertsModule, defaultsModule] = await Promise.all([
      import(pathToFileURL(path.join(devCertsRoot, 'lib', 'main.js')).href),
      import(pathToFileURL(path.join(devCertsRoot, 'lib', 'defaults.js')).href),
    ]);

    const devCerts = parseOfficeAddinDevCertApi(devCertsModule);
    const defaults = parseOfficeAddinDevCertDefaults(defaultsModule);
    const certificateDirectory = toAbsolutePathFromHome(defaults.certificateDirectory, options.platformConfig.homePath);
    const caCertificatePath = toAbsolutePathFromHome(defaults.caCertificatePath, options.platformConfig.homePath);
    const localhostCertificatePath = toAbsolutePathFromHome(
      defaults.localhostCertificatePath,
      options.platformConfig.homePath,
    );
    const localhostKeyPath = toAbsolutePathFromHome(defaults.localhostKeyPath, options.platformConfig.homePath);
    const loginKeychainPath = path.join(
      options.platformConfig.homePath,
      'Library',
      'Keychains',
      'login.keychain-db',
    );

    if (devCerts.verifyCertificates()) {
      addBreadcrumb('info', 'office-sidecar.cert-preflight.fast-path');
      options.log.info(
        {
          event: 'office-sidecar.cert-preflight.fast-path',
        },
        'Office sidecar cert pre-flight fast path',
      );
      addBreadcrumb('info', 'office-sidecar.cert-preflight.success');
      options.log.info(
        {
          event: 'office-sidecar.cert-preflight.success',
        },
        'Office sidecar cert pre-flight succeeded',
      );
      return;
    }

    addBreadcrumb('info', 'office-sidecar.cert-preflight.regenerate');
    options.log.info(
      {
        event: 'office-sidecar.cert-preflight.regenerate',
      },
      'Office sidecar cert pre-flight regenerating certificates',
    );

    devCerts.deleteCertificateFiles(certificateDirectory);

    let keychainHashes: string[] = [];
    try {
      const findResult = await execFileWithTimeout(
        options.execFile,
        'security',
        [
          'find-certificate',
          '-a',
          '-c',
          defaults.certificateName,
          '-Z',
          loginKeychainPath,
        ],
        SECURITY_FIND_TIMEOUT_MS,
      );
      keychainHashes = extractSha1HashesFromSecurityFindOutput(findResult.stdout);
    } catch (error) {
      const message = redactPathsAndTokens(error instanceof Error ? error.message : String(error));
      addBreadcrumb('warning', 'office-sidecar.cert-preflight.keychain-delete-failed', { operation: 'find' });
      options.log.warn(
        {
          event: 'office-sidecar.cert-preflight.keychain-delete-failed',
          operation: 'find',
          message,
        },
        'Office sidecar cert pre-flight keychain cleanup failed',
      );
    }

    for (const hash of keychainHashes) {
      try {
        await execFileWithTimeout(
          options.execFile,
          'security',
          [
            'delete-certificate',
            '-Z',
            hash,
            '-t',
            loginKeychainPath,
          ],
          SECURITY_DELETE_TIMEOUT_MS,
        );
      } catch (error) {
        const message = redactPathsAndTokens(error instanceof Error ? error.message : String(error));
        addBreadcrumb('warning', 'office-sidecar.cert-preflight.keychain-delete-failed', {
          operation: 'delete',
          hash,
        });
        options.log.warn(
          {
            event: 'office-sidecar.cert-preflight.keychain-delete-failed',
            operation: 'delete',
            hash,
            message,
          },
          'Office sidecar cert pre-flight keychain cleanup failed',
        );
      }
    }

    await devCerts.generateCertificates(
      caCertificatePath,
      localhostCertificatePath,
      localhostKeyPath,
      defaults.daysUntilCertificateExpires,
      defaults.domain,
    );

    await execFileWithTimeout(
      options.execFile,
      'security',
      [
        'add-trusted-cert',
        '-r',
        'trustRoot',
        '-k',
        loginKeychainPath,
        caCertificatePath,
      ],
      SECURITY_ADD_TRUSTED_CERT_TIMEOUT_MS,
    );

    addBreadcrumb('info', 'office-sidecar.cert-preflight.success');
    options.log.info(
      {
        event: 'office-sidecar.cert-preflight.success',
      },
      'Office sidecar cert pre-flight succeeded',
    );
  } catch (error) {
    const message = redactPathsAndTokens(error instanceof Error ? error.message : String(error));
    addBreadcrumb('warning', 'office-sidecar.cert-preflight.failed');
    options.log.warn(
      {
        event: 'office-sidecar.cert-preflight.failed',
        message,
      },
      'Office sidecar cert pre-flight failed',
    );
    throw new OfficeSidecarManagerError(
      `Office sidecar cert pre-flight failed: ${message}`,
      'cert-failed',
    );
  }
}

function readLockPid(lockFilePath: string): number | null {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // Best effort.
  }
}

function splitLines(chunk: string, remainder: string): { lines: string[]; remainder: string } {
  const combined = `${remainder}${chunk}`;
  const parts = combined.split(/\r?\n/);
  const nextRemainder = parts.pop() ?? '';
  return {
    lines: parts,
    remainder: nextRemainder,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessExit(
  pid: number,
  isPidAlive: IsPidAlive,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await wait(pollIntervalMs);
  }
  return !isPidAlive(pid);
}

async function loadPersistedState(
  stateFilePath: string,
  requireSecureOwnership: boolean,
): Promise<ParsedStateFile | null> {
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(stateFilePath, 'utf8'),
      fsp.stat(stateFilePath),
    ]);

    const parsed = JSON.parse(raw) as PersistedSidecarState;
    if (
      typeof parsed.port !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number'
    ) {
      return null;
    }

    if (requireSecureOwnership && typeof process.getuid === 'function') {
      if (stat.uid !== process.getuid()) {
        return null;
      }
      if ((stat.mode & 0o077) !== 0) {
        return null;
      }
    }

    return {
      state: parsed,
      stat,
    };
  } catch {
    return null;
  }
}

async function acquireLock(
  lockFilePath: string,
  isPidAlive: IsPidAlive,
  timings: {
    lockRetryDelayMs: number;
    lockMaxAttempts: number;
    lockStaleAfterMs: number;
  },
): Promise<() => Promise<void>> {
  await fsp.mkdir(path.dirname(lockFilePath), { recursive: true });

  for (let attempt = 0; attempt < timings.lockMaxAttempts; attempt += 1) {
    try {
      const fileHandle = await fsp.open(lockFilePath, 'wx');
      try {
        await fileHandle.writeFile(String(process.pid), 'utf8');
      } finally {
        await fileHandle.close();
      }

      return async () => {
        await safeUnlink(lockFilePath);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      const [holderPid, stat] = await Promise.all([
        Promise.resolve(readLockPid(lockFilePath)),
        fsp.stat(lockFilePath).catch(() => null),
      ]);

      const staleByAge = stat ? Date.now() - stat.mtimeMs > timings.lockStaleAfterMs : false;
      const staleByPid = holderPid !== null ? !isPidAlive(holderPid) : false;
      if (staleByAge || staleByPid) {
        await safeUnlink(lockFilePath);
        continue;
      }

      if (attempt === timings.lockMaxAttempts - 1) {
        throw new OfficeSidecarManagerError('Timed out waiting to acquire sidecar lock.', 'unknown');
      }

      await wait(timings.lockRetryDelayMs);
    }
  }

  throw new OfficeSidecarManagerError('Timed out waiting to acquire sidecar lock.', 'unknown');
}

function buildChildEnv(
  platformConfig: PlatformConfig,
  stateDir: string,
  addinDir: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    MCP_OFFICE_SIDECAR_STATE_DIR: stateDir,
  };

  const copy = (key: string, fallback?: string): void => {
    const value = process.env[key] ?? fallback;
    if (value) {
      env[key] = value;
    }
  };

  copy('PATH');
  copy('NODE_PATH');
  copy('LANG');

  if (platformConfig.platform === 'win32') {
    copy('USERPROFILE', platformConfig.homePath);
    copy('APPDATA');
    copy('LOCALAPPDATA');
    copy('SystemRoot');
  } else {
    copy('HOME', platformConfig.homePath);
  }

  if (addinDir) {
    env.MCP_OFFICE_ADDIN_DIR = addinDir;
  }

  return env;
}

export function createOfficeSidecarManager(options: OfficeSidecarManagerOptions): OfficeSidecarManager {
  const { platformConfig, errorReporter } = options;
  const log = options.logger ?? createScopedLogger({ service: 'office-sidecar-manager' });
  const readKillSwitch = options.readKillSwitch ?? (() => process.env[OFFICE_SIDECAR_KILL_SWITCH_ENV]);
  const spawnChild = options.spawnChild ?? ((modulePath, args, forkOptions) => fork(modulePath, [...args], forkOptions));
  const execFile = options.execFile ?? execFileDefault;
  const requestSidecar = options.requestSidecar ?? defaultRequestSidecar;
  const signalProcess = options.signalProcess ?? defaultSignalProcess;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const resolveManagedMcpInstallService = (): OfficeManagedInstallLookup | null =>
    options.managedMcpInstallService ?? getManagedMcpInstallService();
  const requiresManagedInstallService = !options.resolveSidecarScript || !options.resolveAddinDir;
  const resolveScript = options.resolveSidecarScript ?? (() => defaultResolveSidecarScript(resolveManagedMcpInstallService()));
  const resolveAddinDir = options.resolveAddinDir ?? (() => defaultResolveAddinDir(resolveManagedMcpInstallService()));
  const timings = {
    startTimeoutMs: options.timings?.startTimeoutMs ?? START_TIMEOUT_MS,
    healthTimeoutMs: options.timings?.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    identifyTimeoutMs: options.timings?.identifyTimeoutMs ?? IDENTIFY_TIMEOUT_MS,
    lockRetryDelayMs: options.timings?.lockRetryDelayMs ?? LOCK_RETRY_DELAY_MS,
    lockMaxAttempts: options.timings?.lockMaxAttempts ?? LOCK_MAX_ATTEMPTS,
    lockStaleAfterMs: options.timings?.lockStaleAfterMs ?? LOCK_STALE_AFTER_MS,
    adoptedPollIntervalMs: options.timings?.adoptedPollIntervalMs ?? ADOPTED_POLL_INTERVAL_MS,
    adoptedFailureThreshold: options.timings?.adoptedFailureThreshold ?? ADOPTED_FAILURE_THRESHOLD,
    adoptedRestartDelayMs: options.timings?.adoptedRestartDelayMs ?? ADOPTED_RESTART_DELAY_MS,
    stabilityResetMs: options.timings?.stabilityResetMs ?? STABILITY_RESET_MS,
    stopTimeoutMs: options.timings?.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    stopPollIntervalMs: options.timings?.stopPollIntervalMs ?? STOP_POLL_INTERVAL_MS,
    restartBackoffsMs: options.timings?.restartBackoffsMs ?? RESTART_BACKOFFS_MS,
  };

  const stateDir = resolveStateDir(platformConfig);
  const stateFilePath = resolveStateFile(platformConfig);
  const lastFailureFilePath = resolveLastFailureFilePath(stateDir);
  const lockFilePath = resolveLockFile(platformConfig);

  let runtimeState: OfficeSidecarRuntimeState | null = null;
  let lastError: SanitizedOfficeSidecarError | null = null;
  let skipReason: OfficeSidecarSkipReason | null = null;
  let startInFlight: Promise<OfficeSidecarRuntimeState | null> | null = null;
  let stopInFlight: Promise<void> | null = null;
  let currentChild: ChildProcess | null = null;
  let restartAttempts = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let stabilityResetTimer: NodeJS.Timeout | null = null;
  let adoptedHealthPoll: NodeJS.Timeout | null = null;
  let adoptedFailureCount = 0;
  let stopRequested = false;
  let releasedAdoptedSidecar = false;

  const clearRestartTimer = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const clearStabilityResetTimer = (): void => {
    if (stabilityResetTimer) {
      clearTimeout(stabilityResetTimer);
      stabilityResetTimer = null;
    }
  };

  const clearAdoptedHealthPoll = (): void => {
    if (adoptedHealthPoll) {
      clearInterval(adoptedHealthPoll);
      adoptedHealthPoll = null;
    }
    adoptedFailureCount = 0;
  };

  const writePersistedErrorCode = async (code: OfficeSidecarErrorCode | null): Promise<void> => {
    try {
      const persisted = await loadPersistedState(stateFilePath, false);
      if (!persisted) {
        if (code === null) {
          return;
        }
        log.info(
          {
            event: 'office-sidecar.persisted-error-code-skipped',
            errorCode: code,
          },
          'Skipped Office sidecar state error-code update because no state file is available',
        );
        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar.persisted-error-code-skipped',
          data: {
            errorCode: code,
          },
        });
        return;
      }

      await writeStateFile(
        {
          ...persisted.state,
          lastEagerStartErrorCode: code ?? undefined,
        },
        stateDir,
      );
    } catch (error) {
      log.warn(
        {
          event: 'office-sidecar.persisted-error-code-write-failed',
          errorCode: code,
          message: error instanceof Error ? redactPathsAndTokens(error.message) : String(error),
        },
        'Failed to persist Office sidecar state error code',
      );
      errorReporter.addBreadcrumb({
        category: 'office-sidecar',
        level: 'warning',
        message: 'office-sidecar.persisted-error-code-write-failed',
        data: {
          errorCode: code,
        },
      });
    }
  };

  const writeLastFailureBreadcrumb = async (code: OfficeSidecarErrorCode): Promise<void> => {
    try {
      await writeLastFailureFile(stateDir, {
        code,
        at: Date.now(),
      });
    } catch (error) {
      log.warn(
        {
          event: 'office-sidecar.last-failure-write-failed',
          errorCode: code,
          message: error instanceof Error ? redactPathsAndTokens(error.message) : String(error),
        },
        'Failed to persist Office sidecar last-failure breadcrumb',
      );
      errorReporter.addBreadcrumb({
        category: 'office-sidecar',
        level: 'warning',
        message: 'office-sidecar.last-failure-write-failed',
        data: {
          errorCode: code,
        },
      });
    }
  };

  const clearLastFailureBreadcrumb = async (): Promise<void> => {
    await safeUnlink(lastFailureFilePath);
  };

  const clearLastError = async (): Promise<void> => {
    lastError = null;
    await Promise.all([
      writePersistedErrorCode(null),
      clearLastFailureBreadcrumb(),
    ]);
  };

  const setLastError = async (error: unknown, preferredCode?: OfficeSidecarErrorCode): Promise<SanitizedOfficeSidecarError> => {
    const sanitized = toSanitizedError(error, preferredCode);
    lastError = sanitized;
    await Promise.all([
      writePersistedErrorCode(sanitized.code),
      writeLastFailureBreadcrumb(sanitized.code),
    ]);
    return sanitized;
  };

  const startStabilityResetTimer = (): void => {
    clearStabilityResetTimer();
    stabilityResetTimer = setTimeout(() => {
      restartAttempts = 0;
      stabilityResetTimer = null;
    }, timings.stabilityResetMs);
  };

  const scheduleRestart = (delayMs: number, restart: () => Promise<void>): void => {
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopRequested) {
        return;
      }
      fireAndForget(restart(), 'officeSidecarManager.line1106');
    }, delayMs);
  };

  const handleUnexpectedChildExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    const crashedPid = currentChild?.pid ?? runtimeState?.pid;
    currentChild = null;
    runtimeState = null;
    clearStabilityResetTimer();

    if (stopRequested) {
      return;
    }

    const error = toSanitizedError(new OfficeSidecarManagerError('Office sidecar child exited unexpectedly.', 'child-crashed'));
    lastError = error;
    fireAndForget(Promise.all([
      writePersistedErrorCode(error.code),
      writeLastFailureBreadcrumb(error.code),
    ]), 'officeSidecarManager.line1122');

    log.warn(
      {
        event: 'office-sidecar.child-exit',
        exitCode,
        signal,
        pid: crashedPid,
      },
      'Office sidecar child exited unexpectedly',
    );

    if (restartAttempts >= timings.restartBackoffsMs.length) {
      errorReporter.addBreadcrumb({
        category: 'office-sidecar',
        level: 'warning',
        message: 'office-sidecar.restart-gave-up',
        data: {
          errorCode: error.code,
        },
      });
      log.warn(
        {
          event: 'office-sidecar.restart-gave-up',
          errorCode: error.code,
        },
        'Office sidecar restart ceiling reached',
      );
      return;
    }

    const backoffMs = timings.restartBackoffsMs[restartAttempts];
    if (backoffMs === undefined) {
      return;
    }
    restartAttempts += 1;
    scheduleRestart(backoffMs, async () => {
      await start().catch((restartError) => {
        const code = classifyErrorCode(restartError);
        log.warn(
          {
            event: 'office-sidecar.restart-failed',
            attempt: restartAttempts,
            errorCode: code,
          },
          'Office sidecar restart attempt failed',
        );
      });
    });

    log.info(
      {
        event: 'office-sidecar.restart-attempt',
        attempt: restartAttempts,
        backoffMs,
        exitCode,
        signal,
      },
      'Scheduling Office sidecar restart',
    );
  };

  const maybeSetWefFailureFromStderr = async (line: string): Promise<void> => {
    if (!runtimeState || lastError?.code === 'wef-install-failed') {
      return;
    }
    if (!WEF_FAILURE_STDERR_REGEX.test(line)) {
      return;
    }
    lastError = {
      code: 'wef-install-failed',
      message: sanitizeOfficeSidecarError('wef-install-failed'),
      at: Date.now(),
    };
    await writePersistedErrorCode('wef-install-failed');
  };

  const handleAdoptedLivenessLoss = (message: string): void => {
    clearAdoptedHealthPoll();
    releasedAdoptedSidecar = true;
    runtimeState = null;
    errorReporter.addBreadcrumb({
      category: 'office-sidecar',
      level: 'warning',
      message: 'office-sidecar.adopted-lost',
      data: {},
    });
    log.warn(
      {
        event: 'office-sidecar.adopted-lost',
      },
      message,
    );
    scheduleRestart(timings.adoptedRestartDelayMs, async () => {
      await start().catch((error) => {
        log.warn(
          {
            event: 'office-sidecar.adopted-restart-failed',
            errorCode: classifyErrorCode(error),
          },
          'Failed to restart adopted Office sidecar after liveness loss',
        );
      });
    });
  };

  const startAdoptedHealthPoll = (): void => {
    clearAdoptedHealthPoll();
    adoptedHealthPoll = setInterval(() => {
      if (!runtimeState || !runtimeState.adopted || stopRequested) {
        return;
      }

      void requestSidecar(runtimeState.port, '/health', undefined, timings.healthTimeoutMs)
        .then(async (response) => {
          if (!runtimeState || !runtimeState.adopted) {
            return;
          }

          if (response.statusCode === 200) {
            adoptedFailureCount = 0;
            runtimeState = {
              ...runtimeState,
              lastHealthAt: Date.now(),
            };
            return;
          }

          adoptedFailureCount += 1;
          if (adoptedFailureCount < timings.adoptedFailureThreshold) {
            return;
          }

          handleAdoptedLivenessLoss('Adopted Office sidecar became unhealthy');
        })
        .catch(() => {
          adoptedFailureCount += 1;
          if (adoptedFailureCount < timings.adoptedFailureThreshold) {
            return;
          }

          handleAdoptedLivenessLoss('Adopted Office sidecar stopped responding to health checks');
        });
    }, timings.adoptedPollIntervalMs);
  };

  const tryAdoptExisting = async (): Promise<OfficeSidecarRuntimeState | null> => {
    const persisted = await loadPersistedState(stateFilePath, platformConfig.platform !== 'win32');
    if (!persisted) {
      return null;
    }

    const { state } = persisted;
    if (state.pid === process.pid || !isPidAlive(state.pid)) {
      await safeUnlink(stateFilePath);
      return null;
    }

    try {
      const health = await requestSidecar(state.port, '/health', undefined, timings.healthTimeoutMs);
      if (health.statusCode !== 200) {
        await safeUnlink(stateFilePath);
        return null;
      }

      const identify = await requestSidecar(state.port, '/sidecar/identify', state.token, timings.identifyTimeoutMs);
      const identifiedPid = Number.parseInt(String(identify.headers['x-rebel-sidecar-pid'] ?? ''), 10);
      if (identify.statusCode !== 204 || !Number.isFinite(identifiedPid) || identifiedPid !== state.pid) {
        await safeUnlink(stateFilePath);
        return null;
      }

      runtimeState = {
        pid: state.pid,
        port: state.port,
        adopted: true,
        startedAt: Date.now(),
        lastHealthAt: Date.now(),
      };
      releasedAdoptedSidecar = false;
      currentChild = null;
      await clearLastError();
      startAdoptedHealthPoll();

      errorReporter.addBreadcrumb({
        category: 'office-sidecar',
        level: 'info',
        message: 'office-sidecar-adopted',
        data: {
          pid: state.pid,
          port: state.port,
        },
      });
      log.info(
        {
          event: 'office-sidecar.adopted',
          pid: state.pid,
          port: state.port,
        },
        'Adopted existing Office sidecar',
      );
      return runtimeState;
    } catch {
      await safeUnlink(stateFilePath);
      return null;
    }
  };

  const spawnAndWaitForReady = async (): Promise<OfficeSidecarRuntimeState> => {
    const cliPath = await resolveScript();
    if (!cliPath || !fs.existsSync(cliPath)) {
      throw new OfficeSidecarManagerError(
        `Office sidecar CLI script not found at ${cliPath ?? '<unresolved>'}.`,
        'script-not-found',
      );
    }

    const addinDir = await resolveAddinDir();
    const child = spawnChild(cliPath, [], {
      env: buildChildEnv(platformConfig, stateDir, addinDir),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    currentChild = child;
    clearRestartTimer();

    let stdoutRemainder = '';
    let stderrRemainder = '';
    let sawStderrOutput = false;
    let startupComplete = false;
    let settled = false;

    return await new Promise<OfficeSidecarRuntimeState>((resolve, reject) => {
      const settleReject = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupForReject();
        reject(error);
      };

      const settleResolve = async (readySignal: ReadySignal): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        startupComplete = true;
        cleanupForResolve();

        runtimeState = {
          pid: readySignal.pid,
          port: readySignal.port,
          adopted: false,
          startedAt: Date.now(),
          wefInstallResults: readySignal.wefInstallResults,
        };
        releasedAdoptedSidecar = false;
        startStabilityResetTimer();

        const hasWefFailure = readySignal.wefInstallResults?.some((result) => result.status === 'failed') ?? false;
        if (hasWefFailure) {
          await clearLastFailureBreadcrumb();
          lastError = {
            code: 'wef-install-failed',
            message: sanitizeOfficeSidecarError('wef-install-failed'),
            at: Date.now(),
          };
          await writePersistedErrorCode('wef-install-failed');
        } else {
          await clearLastError();
        }

        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar-start',
          data: {
            pid: readySignal.pid,
            port: readySignal.port,
          },
        });
        log.info(
          {
            event: 'office-sidecar.started',
            pid: readySignal.pid,
            port: readySignal.port,
          },
          'Office sidecar started',
        );
        resolve(runtimeState);
      };

      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort.
        }
        settleReject(new OfficeSidecarManagerError('Office sidecar startup timed out.', 'spawn-timeout'));
      }, timings.startTimeoutMs);

      function cleanupForReject(): void {
        clearTimeout(timeout);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      }

      function cleanupForResolve(): void {
        clearTimeout(timeout);
        child.removeListener('error', onError);
      }

      function onError(error: Error): void {
        currentChild = null;
        settleReject(error);
      }

      function onExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (!startupComplete) {
          currentChild = null;
          const errorCode: OfficeSidecarErrorCode = sawStderrOutput ? 'child-crashed' : 'spawn-timeout';
          settleReject(
            new OfficeSidecarManagerError(
              `Office sidecar exited before reporting ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
              errorCode,
            ),
          );
          return;
        }

        handleUnexpectedChildExit(code, signal);
      }

      child.once('error', onError);
      child.on('exit', onExit);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const { lines, remainder } = splitLines(chunk.toString(), stdoutRemainder);
        stdoutRemainder = remainder;

        for (const line of lines) {
          const redactedLine = redactPathsAndTokens(line);
          log.info(
            {
              event: 'office-sidecar.child-stdout',
              pid: child.pid,
              line: redactedLine,
            },
            'Office sidecar child stdout',
          );

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const ready = ReadySignalSchema.safeParse(parsed);
          if (ready.success) {
            fireAndForget(settleResolve(ready.data), 'officeSidecarManager.line1486');
          } else if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            // Parsed JSON looked like a structured signal but didn't conform
            // to the ready-signal schema. Surface this explicitly so schema
            // drift between cli.js and the manager doesn't fail silently
            // (see sidecar eager-start regression, 2026-04-20).
            log.warn(
              {
                event: 'office-sidecar.ready-schema-mismatch',
                pid: child.pid,
                rawLine: redactPathsAndTokens(line),
                issues: ready.error.issues,
              },
              'Office sidecar ready-signal schema mismatch',
            );
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const { lines, remainder } = splitLines(chunk.toString(), stderrRemainder);
        stderrRemainder = remainder;
        for (const line of lines) {
          sawStderrOutput = true;
          const redactedLine = redactPathsAndTokens(line);
          log.warn(
            {
              event: 'office-sidecar.child-stderr',
              pid: child.pid,
              line: redactedLine,
            },
            'Office sidecar child stderr',
          );
          fireAndForget(maybeSetWefFailureFromStderr(line), 'officeSidecarManager.line1519');
        }
      });
    });
  };

  async function start(): Promise<OfficeSidecarRuntimeState | null> {
    if (runtimeState) {
      return runtimeState;
    }

    if (startInFlight) {
      return await startInFlight;
    }

    clearRestartTimer();
    stopRequested = false;

    startInFlight = (async () => {
      const killSwitchValue = readKillSwitch();
      if (isKillSwitchEnabled(killSwitchValue)) {
        skipReason = 'kill-switch';
        runtimeState = null;
        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar-skipped',
          data: {
            reason: 'kill-switch',
            env: OFFICE_SIDECAR_KILL_SWITCH_ENV,
          },
        });
        log.info(
          {
            event: 'office-sidecar.skipped',
            reason: 'kill-switch',
          },
          'Office sidecar start skipped by kill switch',
        );
        return null;
      }

      if (!platformConfig.capabilities.officeSidecar) {
        skipReason = 'surface-not-desktop';
        runtimeState = null;
        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar-skipped',
          data: {
            reason: 'surface-not-desktop',
            surface: platformConfig.surface,
          },
        });
        log.info(
          {
            event: 'office-sidecar.skipped',
            reason: 'surface-not-desktop',
            surface: platformConfig.surface,
          },
          'Office sidecar start skipped on non-desktop surface',
        );
        return null;
      }

      skipReason = null;

      if (!resolveManagedMcpInstallService() && requiresManagedInstallService) {
        runtimeState = null;
        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar-skipped',
          data: {
            reason: 'managed-install-service-unavailable',
          },
        });
        log.debug(
          {
            event: 'office-sidecar.skipped',
            reason: 'managed-install-service-unavailable',
          },
          'Office sidecar start skipped because managed install service is not configured',
        );
        return null;
      }

      let releaseLock: (() => Promise<void>) | null = null;
      try {
        releaseLock = await acquireLock(lockFilePath, isPidAlive, timings);
        const adopted = await tryAdoptExisting();
        if (adopted) {
          return adopted;
        }

        await runOfficeCertPreflight({
          platformConfig,
          errorReporter,
          log,
          execFile,
          managedInstallService: resolveManagedMcpInstallService(),
        });

        return await spawnAndWaitForReady();
      } catch (error) {
        const sanitized = await setLastError(error);
        const message = redactPathsAndTokens(error instanceof Error ? error.message : String(error));
        log.warn(
          {
            event: 'office-sidecar.start-failed',
            errorCode: sanitized.code,
            message,
          },
          'Office sidecar failed to start',
        );
        // Skip Sentry capture for known install-incomplete states —
        // these are expected on machines where the managed install
        // is partial/corrupted and produce noise on every startup (REBEL-1H3).
        if (sanitized.code === 'script-not-found') {
          errorReporter.addBreadcrumb({
            category: 'office-sidecar',
            level: 'warning',
            message: 'office-sidecar.script-not-found-suppressed',
            data: { errorCode: sanitized.code },
          });
        } else {
          const sanitizedError = new Error(message);
          sanitizedError.name = error instanceof Error ? error.name : 'OfficeSidecarStartError';
          errorReporter.captureException(sanitizedError, {
            area: 'office-sidecar',
            phase: 'manager-start',
            errorCode: sanitized.code,
          });
        }
        throw error;
      } finally {
        await releaseLock?.();
      }
    })();

    try {
      return await startInFlight;
    } finally {
      startInFlight = null;
    }
  }

  const stop = async (): Promise<void> => {
    if (stopInFlight) {
      return await stopInFlight;
    }

    stopInFlight = (async () => {
      stopRequested = true;
      clearRestartTimer();
      clearStabilityResetTimer();
      clearAdoptedHealthPoll();

      if (startInFlight) {
        try {
          await startInFlight;
        } catch {
          // Ignore startup failures during shutdown.
        }
      }

      if (runtimeState?.adopted) {
        releasedAdoptedSidecar = true;
        runtimeState = null;
        currentChild = null;
        return;
      }

      const ownedPid = currentChild?.pid ?? runtimeState?.pid;
      runtimeState = null;
      const child = currentChild;
      currentChild = null;

      if (ownedPid) {
        try {
          signalProcess(ownedPid, 'SIGTERM');
        } catch {
          // Already gone.
        }

        const exited = await waitForProcessExit(ownedPid, isPidAlive, timings.stopTimeoutMs, timings.stopPollIntervalMs);
        if (!exited) {
          try {
            signalProcess(ownedPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }

        await safeUnlink(stateFilePath);
        if (child && child.exitCode === null && typeof child.kill === 'function') {
          try {
            child.kill('SIGKILL');
          } catch {
            // Best effort.
          }
        }
        errorReporter.addBreadcrumb({
          category: 'office-sidecar',
          level: 'info',
          message: 'office-sidecar-stop',
          data: {
            pid: ownedPid,
          },
        });
        log.info(
          {
            event: 'office-sidecar.stopped',
            pid: ownedPid,
          },
          'Office sidecar stopped',
        );
        return;
      }

      if (releasedAdoptedSidecar) {
        return;
      }

      const persisted = await loadPersistedState(stateFilePath, false);
      if (!persisted) {
        return;
      }

      if (!isPidAlive(persisted.state.pid)) {
        await safeUnlink(stateFilePath);
        return;
      }

      try {
        signalProcess(persisted.state.pid, 'SIGTERM');
      } catch {
        await safeUnlink(stateFilePath);
        return;
      }

      const exited = await waitForProcessExit(
        persisted.state.pid,
        isPidAlive,
        timings.stopTimeoutMs,
        timings.stopPollIntervalMs,
      );
      if (!exited) {
        try {
          signalProcess(persisted.state.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }

      await safeUnlink(stateFilePath);
    })();

    try {
      await stopInFlight;
    } catch (error) {
      log.warn(
        {
          event: 'office-sidecar.stop-failed',
          message: error instanceof Error ? redactPathsAndTokens(error.message) : String(error),
        },
        'Office sidecar stop failed',
      );
    } finally {
      stopInFlight = null;
      stopRequested = false;
    }
  };

  const retryStart = async (): Promise<OfficeSidecarRuntimeState | null> => {
    clearRestartTimer();
    clearStabilityResetTimer();
    clearAdoptedHealthPoll();
    await stop();
    lastError = null;
    await writePersistedErrorCode(null);
    return await start();
  };

  return {
    start,
    stop,
    isRunning: () => runtimeState !== null,
    getState: () => runtimeState,
    getSkipReason: () => skipReason,
    getLastError: () => lastError,
    retryStart,
  };
}

export function setOfficeSidecarManagerForShutdown(manager: OfficeSidecarManager | null): void {
  _officeSidecarManagerForShutdown = manager;
}

export function getOfficeSidecarManager(): OfficeSidecarManager | null {
  return _officeSidecarManagerForShutdown;
}

export async function startOfficeSidecar(): Promise<OfficeSidecarRuntimeState | null> {
  if (!_officeSidecarManagerForShutdown) {
    return null;
  }

  return await _officeSidecarManagerForShutdown.start();
}

export async function stopOfficeSidecar(): Promise<void> {
  if (_officeSidecarManagerForShutdown) {
    await _officeSidecarManagerForShutdown.stop();
    return;
  }

  const manager = createOfficeSidecarManager({
    platformConfig: getPlatformConfig(),
    errorReporter: getErrorReporter(),
  });
  await manager.stop();
}

export function isOfficeSidecarRunning(): boolean {
  if (_officeSidecarManagerForShutdown?.isRunning()) {
    return true;
  }

  try {
    const persisted = fs.readFileSync(resolveStateFile(getPlatformConfig()), 'utf8');
    const parsed = JSON.parse(persisted) as PersistedSidecarState;
    return typeof parsed.pid === 'number' && defaultIsPidAlive(parsed.pid);
  } catch {
    return false;
  }
}
