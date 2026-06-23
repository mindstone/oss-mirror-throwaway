import { execFile as nodeExecFile, spawnSync, type ChildProcess, type ExecFileException, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { valid as validSemver } from 'semver';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { setupNodeEnvironment } from '@core/utils/systemUtils';
import { getPlatformConfig, type PlatformConfig } from '@core/platform';
import { emitHubSpotTelemetry } from './hubspotTelemetry';
import {
  MANAGED_INSTALL_SEEDS_SUBDIR,
  OFFICE_MCP_PACKAGE_SPEC,
  OFFICE_MCP_SEED_TARBALL_FILENAME,
} from '@shared/sidecar/officePackage';

const MANAGED_INSTALLS_PATH_SEGMENTS = ['mcp', 'managed-installs'] as const;
const METADATA_FILENAME = '.install-meta.json';
const REINSTALL_HISTORY_FILENAME = '.managed-install-history.json';
/**
 * Sentinel file written alongside `.install-meta.json` when an install came
 * from a caller-supplied local tarball (Stage 1 seam). Lets
 * `managedMcpAutoUpgrade.scanForDevPrePublishSentinels` log a startup banner
 * so the engineer notices a stale dev build before it ships fixes against a
 * phantom repro. See docs/project/MCP_DEV_LOCAL_OVERRIDE.md.
 */
export const DEV_PRE_PUBLISH_SENTINEL_FILENAME = '.dev-pre-publish-build.json';

export interface DevPrePublishSentinel {
  source: 'pre-publish-test';
  installedAt: string;
  tarballPath: string;
  metaVersion: 1;
}
const DEFAULT_TIMEOUT_MS = 120_000;
const STALE_TEMP_DIR_MAX_AGE_MS = 10 * 60 * 1_000;
const TARGET_EXISTS_ERROR_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM']);
// Windows MAX_PATH is 260 chars. npm's node_modules nesting adds 100+ chars on
// top of installRoot, so we budget conservatively: fail fast if the install
// root itself is already past this limit, before wasting a network round-trip.
const WINDOWS_INSTALL_ROOT_MAX_LEN = 140;
// Quarantine-loop detection: if the same spec triggers N reinstall attempts
// within the window, stop trying and revert to npx to avoid AV quarantine
// ping-pong that burns bandwidth every startup.
const REINSTALL_QUARANTINE_THRESHOLD = 3;
const REINSTALL_QUARANTINE_WINDOW_MS = 60 * 60 * 1_000;
const SEEDS_MANIFEST_FILENAME = 'seeds-manifest.json';

const SCOPED_PACKAGE_NAME_PATTERN = /^@[^/\s]+\/[^@/\s]+$/;
const UNSCOPED_PACKAGE_NAME_PATTERN = /^(?!@)[^/\s@]+$/;

export type PackageSpec = string;

export interface InstallMetadata {
  /** Full spec including version: "@scope/pkg@1.2.3" */
  packageSpec: PackageSpec;
  /** Package name without version: "@scope/pkg" */
  packageName: string;
  /** Installed version: "1.2.3" */
  version: string;
  /** Absolute path to the entry point to execute (via node) */
  entryPath: string;
  /** Absolute path to the install root (contains node_modules/) */
  installRoot: string;
  /** ISO8601 timestamp of install completion */
  installedAt: string;
  /** Platform at install time */
  platform: NodeJS.Platform;
  /** Node version at install time */
  nodeVersion: string;
  /** Format version for future migrations */
  metaVersion: 1;
}

export interface InstallOptions {
  /** Package name + version, e.g. "@scope/pkg@1.2.3". Version MUST be pinned. */
  packageSpec: PackageSpec;
  /** If true, re-install even if already installed. Default false (idempotent). */
  force?: boolean;
  /** Abort installation signal. */
  signal?: AbortSignal;
  /** Optional timeout in ms (default: 120_000 — 2 minutes) */
  timeoutMs?: number;
  /**
   * Optional caller-supplied tarball source. When provided, the install pulls
   * from `file:${localTarball}` instead of fetching from the npm registry.
   *
   * Public API seam for pre-publish local testing — see
   * `scripts/dev-mcp-managed-install.ts` and
   * `docs/project/MCP_DEV_LOCAL_OVERRIDE.md`. NOT for production use: bypasses
   * the bundled seed-tarball's checksum verification because the tarball is
   * caller-trusted (built locally from the engineer's working tree).
   *
   * The path must be absolute and the file must exist; otherwise
   * {@link ManagedMcpInstallError} is thrown before any npm process spawns.
   * After install, the installed package manifest's `version` must equal the
   * version parsed from `packageSpec`; mismatch throws to prevent silent
   * drift between what the caller asked for and what actually got installed.
   */
  source?: { localTarball: string };
}

export interface ManagedMcpInstallService {
  /**
   * Ensure a package is installed. Returns metadata for the installed entry.
   * Idempotent: if already installed at the requested version, returns existing metadata.
   * Install is atomic (temp-dir + rename). On failure, install root is left untouched.
   */
  install(options: InstallOptions): Promise<InstallMetadata>;

  /** Return metadata for a previously installed package, or null if not installed. */
  getMetadata(packageSpec: PackageSpec): Promise<InstallMetadata | null>;

  /** Return true if the package is installed (check .install-meta.json existence). */
  isInstalled(packageSpec: PackageSpec): Promise<boolean>;

  /** Remove a specific installed version. */
  uninstall(packageSpec: PackageSpec): Promise<void>;

  /** Return absolute path to the install root directory for a spec. Does not check existence. */
  getInstallRoot(packageSpec: PackageSpec): string;

  /** Clean up stale temp dirs (from crashed installs). Call on startup. */
  cleanupStaleTempDirs(): Promise<{ removed: string[]; errors: Array<{ path: string; error: string }> }>;

  /**
   * Record that we are about to attempt a reinstall of an invalid managed
   * install. Returns the updated history entry. When `reinstallCount` reaches
   * {@link REINSTALL_QUARANTINE_THRESHOLD} within
   * {@link REINSTALL_QUARANTINE_WINDOW_MS}, `quarantined` is true and the
   * caller should stop trying and revert to an npx fallback.
   */
  recordReinstallAttempt(packageSpec: PackageSpec): Promise<ReinstallHistoryEntry>;

  /** Read the persisted reinstall-loop history for a spec, or null if none. */
  getReinstallHistory(packageSpec: PackageSpec): Promise<ReinstallHistoryEntry | null>;

  /**
   * Reset the reinstall history for a spec. Call after a successful install
   * confirms the earlier breakage was transient.
   */
  clearReinstallHistory(packageSpec: PackageSpec): Promise<void>;
}

export class ManagedMcpInstallError extends Error {
  constructor(message: string, public readonly packageSpec: PackageSpec, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ManagedMcpInstallError';
  }
}

export class UnpinnedPackageSpecError extends ManagedMcpInstallError {
  constructor(message: string, packageSpec: PackageSpec, cause?: unknown) {
    super(message, packageSpec, cause);
    this.name = 'UnpinnedPackageSpecError';
  }
}

export class InstallTimeoutError extends ManagedMcpInstallError {
  constructor(message: string, packageSpec: PackageSpec, cause?: unknown) {
    super(message, packageSpec, cause);
    this.name = 'InstallTimeoutError';
  }
}

export class InstallEntryPointNotFound extends ManagedMcpInstallError {
  constructor(message: string, packageSpec: PackageSpec, cause?: unknown) {
    super(message, packageSpec, cause);
    this.name = 'InstallEntryPointNotFound';
  }
}

/**
 * Thrown when the target install root exceeds the platform path-length budget.
 * On Windows (MAX_PATH = 260), deep nesting under `AppData\Roaming\...` plus
 * npm's own `node_modules` nesting can easily overshoot and produce cryptic
 * EINVAL / ENOENT failures deep inside npm. We pre-flight the budget and
 * surface a dedicated error so auto-upgrade can revert to npx instead of
 * retrying a doomed install on every startup.
 */
export class InstallPathTooLongError extends ManagedMcpInstallError {
  constructor(message: string, packageSpec: PackageSpec, cause?: unknown) {
    super(message, packageSpec, cause);
    this.name = 'InstallPathTooLongError';
  }
}

/**
 * Persistent record of reinstall attempts for a single package spec. Auto-upgrade
 * uses this to detect ping-pong loops (AV quarantine, anti-malware hooks) where
 * a package is repeatedly installed, invalidated on disk, then reinstalled.
 */
export interface ReinstallHistoryEntry {
  /** ISO timestamp of the first reinstall attempt in the current window. */
  firstReinstallAt: string;
  /** ISO timestamp of the most recent reinstall attempt. */
  lastReinstallAt: string;
  /** Number of reinstall attempts recorded in the current window. */
  reinstallCount: number;
  /** True once the count has reached the quarantine threshold. */
  quarantined: boolean;
}

interface ReinstallHistoryState {
  version: 1;
  specs: Record<PackageSpec, ReinstallHistoryEntry>;
}

interface InstalledPackageManifest {
  name?: string;
  main?: string;
  bin?: string | Record<string, string>;
}

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileInvoker = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback
) => ChildProcess | undefined;

const isValidPackageName = (name: string): boolean =>
  SCOPED_PACKAGE_NAME_PATTERN.test(name) || UNSCOPED_PACKAGE_NAME_PATTERN.test(name);

/**
 * Returns the absolute root directory where managed MCP installs live for a
 * given userData path. Exported so other services (migration gate, spawn-time
 * integrity check, cloud payload rewriters) can recognise managed entries by
 * path containment without duplicating the segment layout.
 */
export const resolveManagedInstallsRoot = (userDataPath: string): string =>
  path.join(path.resolve(userDataPath), ...MANAGED_INSTALLS_PATH_SEGMENTS);

const managedInstallsRootFor = (userDataPath: string): string =>
  resolveManagedInstallsRoot(userDataPath);

const isInsideDirectory = (candidatePath: string, directoryPath: string): boolean => {
  const normalizedDir = path.resolve(directoryPath);
  const normalizedCandidate = path.resolve(candidatePath);
  if (normalizedCandidate === normalizedDir) {
    return false;
  }
  const relative = path.relative(normalizedDir, normalizedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

/**
 * Returns true when the given MCP server entry represents a managed install
 * (command === "node" + the first args entry is inside the managed installs
 * root). This is the canonical gate used to prevent legacy npx migrations,
 * contribution swaps, and cloud payload writers from reverting managed
 * entries or shipping absolute local paths to the cloud.
 *
 * Path-based rather than a metadata-marker check so we cannot be tricked by
 * schema drift, UI-side edits, or manual config tampering.
 */
export const isManagedInstallEntry = (
  entry: unknown,
  managedInstallsRoot: string,
): boolean => {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (record.command !== 'node') {
    return false;
  }
  const args = record.args;
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }
  const entryPath = args[0];
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return false;
  }
  return isInsideDirectory(entryPath, managedInstallsRoot);
};

const metadataPathFor = (installRoot: string): string =>
  path.join(installRoot, METADATA_FILENAME);

const randomHex = (): string => randomBytes(6).toString('hex');

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureAbsolutePath = (candidatePath: string, packageDir: string): string => {
  const resolvedPath = path.resolve(packageDir, candidatePath);
  const relativeToPackage = path.relative(packageDir, resolvedPath);

  if (
    relativeToPackage === '' ||
    (!relativeToPackage.startsWith('..') && !path.isAbsolute(relativeToPackage))
  ) {
    return resolvedPath;
  }

  throw new Error(`Entry point resolves outside package directory: ${candidatePath}`);
};

const getPackageBasename = (packageName: string): string => {
  const segments = packageName.split('/');
  return segments[segments.length - 1] ?? packageName;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const getErrorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
};

const getExecStderr = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === 'string' ? stderr : undefined;
  }

  return undefined;
};

const isTimeoutError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCode(error);
  return code === 'ETIMEDOUT' || error.name === 'TimeoutError';
};

const isTargetExistsError = (error: unknown): boolean => {
  const code = getErrorCode(error);
  return code !== undefined && TARGET_EXISTS_ERROR_CODES.has(code);
};

const createAbortError = (): Error => {
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  return abortError;
};

const isInstallMetadata = (
  value: unknown,
  expectedPackageSpec: PackageSpec,
  expectedInstallRoot: string
): value is InstallMetadata => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const metadata = value as Partial<InstallMetadata>;
  return (
    metadata.packageSpec === expectedPackageSpec &&
    typeof metadata.packageName === 'string' &&
    isValidPackageName(metadata.packageName) &&
    typeof metadata.version === 'string' &&
    validSemver(metadata.version) === metadata.version &&
    typeof metadata.entryPath === 'string' &&
    path.isAbsolute(metadata.entryPath) &&
    typeof metadata.installRoot === 'string' &&
    metadata.installRoot === expectedInstallRoot &&
    typeof metadata.installedAt === 'string' &&
    typeof metadata.platform === 'string' &&
    typeof metadata.nodeVersion === 'string' &&
    metadata.metaVersion === 1
  );
};

const readMetadataFromInstallRoot = async (
  installRoot: string,
  packageSpec: PackageSpec
): Promise<InstallMetadata | null> => {
  try {
    const raw = await fs.readFile(metadataPathFor(installRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isInstallMetadata(parsed, packageSpec, installRoot) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Validate that an installed package is actually usable — metadata alone is not enough.
 * Returns the metadata only if all of the following are true:
 *   - metadata.entryPath exists and is a regular file
 *   - entryPath is inside installRoot (defense against tampering / path traversal)
 *   - the installed package.json exists and its name matches metadata.packageName
 *
 * This guards against phantom-install situations: metadata was written but the
 * entry file was subsequently deleted, quarantined by antivirus, or truncated.
 * See septuple-review blocker #1 for the rationale.
 */
const validateInstalledState = async (
  metadata: InstallMetadata
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const resolvedEntry = path.resolve(metadata.entryPath);
  const resolvedRoot = path.resolve(metadata.installRoot);
  const relativeToRoot = path.relative(resolvedRoot, resolvedEntry);
  if (
    relativeToRoot === '' ||
    relativeToRoot.startsWith('..') ||
    path.isAbsolute(relativeToRoot)
  ) {
    return { ok: false, reason: 'entry-path-outside-install-root' };
  }

  try {
    const stats = await fs.stat(resolvedEntry);
    if (!stats.isFile()) {
      return { ok: false, reason: 'entry-path-not-a-file' };
    }
  } catch (error) {
    const code = getErrorCode(error);
    return { ok: false, reason: code === 'ENOENT' ? 'entry-path-missing' : `entry-path-stat-${code ?? 'unknown'}` };
  }

  const packageJsonPath = path.join(
    resolvedRoot,
    'node_modules',
    ...metadata.packageName.split('/'),
    'package.json'
  );
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const manifest = JSON.parse(raw) as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name !== metadata.packageName) {
      return { ok: false, reason: `manifest-name-mismatch:${manifest.name}` };
    }
  } catch (error) {
    const code = getErrorCode(error);
    return { ok: false, reason: code === 'ENOENT' ? 'manifest-missing' : `manifest-read-${code ?? 'unknown'}` };
  }

  return { ok: true };
};

const removeDirectoryIfExists = async (targetPath: string): Promise<void> => {
  await fs.rm(targetPath, { recursive: true, force: true });
};

const createTempDir = async (managedInstallsRoot: string): Promise<string> => {
  await fs.mkdir(managedInstallsRoot, { recursive: true });
  const tempDir = path.join(managedInstallsRoot, `.tmp-${process.pid}-${randomHex()}`);
  await fs.mkdir(tempDir, { recursive: false });
  return tempDir;
};

const createContainerPackageName = (packageName: string): string => {
  const sanitized = packageName
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .toLowerCase();

  return `${sanitized || 'managed-mcp'}-container`;
};

const writeContainerPackageJson = async (tempDir: string, packageName: string): Promise<void> => {
  const containerPackageJson = {
    name: createContainerPackageName(packageName),
    version: '1.0.0',
    private: true,
  };

  await fs.writeFile(
    path.join(tempDir, 'package.json'),
    JSON.stringify(containerPackageJson, null, 2),
    'utf8'
  );
};

const resolveEntryRelativePath = (packageName: string, manifest: InstalledPackageManifest): string[] => {
  const candidates: string[] = [];
  const packageBasename = getPackageBasename(packageName);
  const binField = manifest.bin;
  const hasBin = typeof binField === 'string' || (typeof binField === 'object' && binField !== null);

  if (typeof binField === 'string' && binField.trim()) {
    candidates.push(binField);
  } else if (typeof binField === 'object' && binField !== null) {
    const matchingValue = typeof binField[packageBasename] === 'string' ? binField[packageBasename] : undefined;
    const firstValue = Object.values(binField).find((value): value is string => typeof value === 'string' && value.length > 0);

    if (matchingValue) {
      candidates.push(matchingValue);
    } else if (firstValue) {
      candidates.push(firstValue);
    }
  }

  if (typeof manifest.main === 'string' && manifest.main.trim()) {
    candidates.push(manifest.main);
  } else if (!hasBin) {
    candidates.push('index.js');
  }

  return candidates;
};

const resolveInstalledEntryPath = async (
  installRoot: string,
  packageSpec: PackageSpec,
  packageName: string
): Promise<string> => {
  const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
  const packageJsonPath = path.join(packageDir, 'package.json');

  let manifest: InstalledPackageManifest;
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    manifest = JSON.parse(raw) as InstalledPackageManifest;
  } catch (error) {
    throw new InstallEntryPointNotFound(
      `Installed package.json not found for ${packageSpec}`,
      packageSpec,
      error
    );
  }

  const candidatePaths = resolveEntryRelativePath(packageName, manifest);

  for (const candidatePath of candidatePaths) {
    const absolutePath = ensureAbsolutePath(candidatePath, packageDir);

    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isFile()) {
        return absolutePath;
      }
    } catch {
      // Try next candidate.
    }
  }

  throw new InstallEntryPointNotFound(
    `Unable to resolve an entry point for ${packageSpec}`,
    packageSpec
  );
};

const writeMetadataFile = async (tempDir: string, metadata: InstallMetadata): Promise<void> => {
  await fs.writeFile(
    metadataPathFor(tempDir),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );
};

const writeDevPrePublishSentinel = async (
  tempDir: string,
  sentinel: DevPrePublishSentinel,
): Promise<void> => {
  await fs.writeFile(
    path.join(tempDir, DEV_PRE_PUBLISH_SENTINEL_FILENAME),
    JSON.stringify(sentinel, null, 2),
    'utf8',
  );
};

const replaceInstallRootAtomically = async (
  tempDir: string,
  installRoot: string,
  renameImpl: typeof fs.rename,
  logger: ReturnType<typeof createScopedLogger>
): Promise<void> => {
  const backupDir = path.join(
    path.dirname(installRoot),
    `.${path.basename(installRoot)}.bak-${process.pid}-${randomHex()}`
  );

  let movedExistingInstall = false;

  if (await pathExists(installRoot)) {
    await renameImpl(installRoot, backupDir);
    movedExistingInstall = true;
  }

  try {
    await renameImpl(tempDir, installRoot);
  } catch (error) {
    if (movedExistingInstall && await pathExists(backupDir)) {
      await renameImpl(backupDir, installRoot);
    }

    throw error;
  }

  // Promotion succeeded: the new install is already live. Best-effort cleanup of
  // the backup directory — if removal fails (AV lock, permission), the user is
  // not impacted. Log for observability and swallow rather than throw.
  if (movedExistingInstall) {
    try {
      await removeDirectoryIfExists(backupDir);
    } catch (cleanupError) {
      logger.warn(
        { installRoot, backupDir, err: cleanupError },
        'Managed MCP install promotion succeeded but backup cleanup failed; install is live'
      );
    }
  }
};

const execFileAsync = async (
  execFileImpl: ExecFileInvoker,
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ExecFileResult> => {
  return await new Promise<ExecFileResult>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let childProcess: ChildProcess | undefined;

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    const settleResolve = (result: ExecFileResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const callback: ExecFileCallback = (error, stdout, stderr) => {
      if (error) {
        settleReject(error);
        return;
      }

      settleResolve({ stdout, stderr });
    };

    try {
      childProcess = execFileImpl(file, args, options, callback);
    } catch (error) {
      settleReject(error);
      return;
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        childProcess?.kill();
        const timeoutError = new Error(`Command timed out after ${timeoutMs}ms`);
        timeoutError.name = 'TimeoutError';
        Object.assign(timeoutError, { code: 'ETIMEDOUT' });
        settleReject(timeoutError);
      }, timeoutMs);
    }

    if (signal) {
      abortHandler = () => {
        childProcess?.kill();
        settleReject(createAbortError());
      };

      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
};

/**
 * Execution spec for `npm install`.
 *
 * On Windows, spawning `npm.cmd` via `execFile` fails with EINVAL on Node
 * ≥20.12 due to the CVE-2024-27980 mitigation (shebang-wrapped `.cmd` files
 * require `shell: true`). Rather than use a shell (which introduces quoting
 * hazards), we resolve the bundled `npm-cli.js` and spawn it directly with
 * the bundled `node` binary — identical on all platforms, no shell, and
 * independent of the user's PATH / system npm version. Mirrors the pattern
 * used by `scripts/benchmark-mcp-spawn.ts`.
 *
 * `executable` + `prefixArgs` is the canonical form: the real command line is
 *   [executable, ...prefixArgs, 'install', <spec>, ...]
 */
export interface NpmRunner {
  executable: string;
  prefixArgs: string[];
  /** Human-readable identifier for logs — e.g. "node + bundled npm-cli.js" */
  description: string;
}

const resolveBundledNpmRunner = (): NpmRunner | null => {
  try {
    const isPackaged = getPlatformConfig().isPackaged;
    const resourcesRoot = isPackaged
      ? process.resourcesPath
      : path.join(process.cwd(), 'resources');
    const bundleDir = path.join(resourcesRoot, 'node-bundle');
    const bundledNodePath = process.platform === 'win32'
      ? path.join(bundleDir, 'node.exe')
      : path.join(bundleDir, 'bin', 'node');
    const bundledNpmCliPath = process.platform === 'win32'
      ? path.join(bundleDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(bundleDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

    if (statSync(bundledNodePath, { throwIfNoEntry: false })?.isFile()
      && statSync(bundledNpmCliPath, { throwIfNoEntry: false })?.isFile()) {
      return {
        executable: bundledNodePath,
        prefixArgs: [bundledNpmCliPath],
        description: 'bundled node + bundled npm-cli.js',
      };
    }
  } catch {
    // Any resolution failure falls through to the system-npm path.
  }
  return null;
};

const resolveSystemNpmRunner = async (
  logger: ReturnType<typeof createScopedLogger>,
): Promise<NpmRunner> => {
  // Augment PATH to include any discovered system Node install. Non-fatal if
  // it fails; we'll fall back to the bare binary name and let execFile resolve.
  try {
    await setupNodeEnvironment();
  } catch (error) {
    logger.warn(
      { err: error },
      'Failed to set up Node environment before resolving npm path (proceeding with PATH as-is)',
    );
  }

  const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const locatorBinary = process.platform === 'win32' ? 'where' : 'which';
  const locatorResult = spawnSync(locatorBinary, [npmBinary], {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });

  let resolvedPath = npmBinary;
  if (locatorResult.status === 0) {
    const firstMatch = locatorResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstMatch) {
      resolvedPath = firstMatch;
    }
  }

  // On Windows, system-resolved npm is almost always `.cmd`, which cannot be
  // run via execFile on Node ≥20.12 without `shell: true`. If the bundled
  // fallback wasn't available, try resolving `npm-cli.js` next to the .cmd
  // and run it via the current Node runtime. If that also fails, we still
  // return the .cmd path — but callers will surface EINVAL as an install
  // failure, which auto-upgrade treats as "leave npx intact". That keeps
  // silent-success from becoming a reality even in the worst case.
  if (process.platform === 'win32' && resolvedPath.toLowerCase().endsWith('.cmd')) {
    const candidateNpmCliPath = path.join(
      path.dirname(resolvedPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    if (statSync(candidateNpmCliPath, { throwIfNoEntry: false })?.isFile()) {
      return {
        executable: process.execPath,
        prefixArgs: [candidateNpmCliPath],
        description: 'current-process node + system npm-cli.js (Windows .cmd workaround)',
      };
    }
    logger.warn(
      { npmCmdPath: resolvedPath, candidateNpmCliPath },
      'Windows npm.cmd resolved but npm-cli.js not found next to it; execFile(.cmd) will likely fail on Node ≥20.12',
    );
  }

  return {
    executable: resolvedPath,
    prefixArgs: [],
    description: `system npm (${resolvedPath})`,
  };
};

export const resolveDefaultNpmRunner = async (
  logger: ReturnType<typeof createScopedLogger>,
): Promise<NpmRunner> => {
  return resolveBundledNpmRunner() ?? (await resolveSystemNpmRunner(logger));
};

/**
 * Parse an explicit `npmPath` option into an NpmRunner. Supports:
 *  - a bare "npm" / "npm.cmd" binary name (tests + dev)
 *  - an absolute path to `npm-cli.js` (direct script invocation)
 *  - an absolute path to `npm` / `npm.cmd`
 */
const buildExplicitNpmRunner = (
  npmPath: string,
  logger: ReturnType<typeof createScopedLogger>,
): NpmRunner => {
  if (npmPath.toLowerCase().endsWith('.js')) {
    return {
      executable: process.execPath,
      prefixArgs: [npmPath],
      description: `current-process node + ${npmPath}`,
    };
  }

  if (process.platform === 'win32' && npmPath.toLowerCase().endsWith('.cmd')) {
    logger.warn(
      { npmPath },
      'Explicit npmPath is a .cmd on Windows; execFile may throw EINVAL on Node ≥20.12 (CVE-2024-27980 mitigation). Prefer passing a path to npm-cli.js or the bundled node binary.',
    );
  }

  return {
    executable: npmPath,
    prefixArgs: [],
    description: `explicit npmPath (${npmPath})`,
  };
};

/**
 * Parse a package spec and require an exact semver version.
 *
 * Examples:
 * - "@scope/name@1.2.3" → { name: "@scope/name", version: "1.2.3" }
 * - "plain-name@1.2.3" → { name: "plain-name", version: "1.2.3" }
 */
export function parsePackageSpec(spec: string): { name: string; version: string } {
  const trimmedSpec = spec.trim();
  const lastAtIndex = trimmedSpec.lastIndexOf('@');

  if (lastAtIndex <= 0) {
    throw new UnpinnedPackageSpecError(
      `Package spec must include a pinned semver version: ${spec}`,
      spec
    );
  }

  const name = trimmedSpec.slice(0, lastAtIndex);
  const version = trimmedSpec.slice(lastAtIndex + 1);

  if (!isValidPackageName(name) || validSemver(version) !== version) {
    throw new UnpinnedPackageSpecError(
      `Package spec must include a valid pinned semver version: ${spec}`,
      spec
    );
  }

  return { name, version };
}

// ---------- Reinstall-history persistence ----------

const createEmptyReinstallHistory = (): ReinstallHistoryState => ({
  version: 1,
  specs: {},
});

const reinstallHistoryPathFor = (managedInstallsRoot: string): string =>
  path.join(managedInstallsRoot, REINSTALL_HISTORY_FILENAME);

const loadReinstallHistory = async (
  managedInstallsRoot: string,
  logger: ReturnType<typeof createScopedLogger>,
): Promise<ReinstallHistoryState> => {
  try {
    const raw = await fs.readFile(reinstallHistoryPathFor(managedInstallsRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { version?: unknown }).version === 1 &&
      'specs' in parsed &&
      typeof (parsed as { specs: unknown }).specs === 'object'
    ) {
      return parsed as ReinstallHistoryState;
    }
    logger.warn(
      { managedInstallsRoot },
      'Reinstall-history file has invalid schema; starting fresh',
    );
    return createEmptyReinstallHistory();
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return createEmptyReinstallHistory();
    }
    logger.warn(
      { err: error, managedInstallsRoot },
      'Failed to load reinstall history; starting fresh',
    );
    return createEmptyReinstallHistory();
  }
};

const persistReinstallHistory = async (
  managedInstallsRoot: string,
  state: ReinstallHistoryState,
  logger: ReturnType<typeof createScopedLogger>,
): Promise<void> => {
  try {
    await fs.mkdir(managedInstallsRoot, { recursive: true });
    await fs.writeFile(
      reinstallHistoryPathFor(managedInstallsRoot),
      JSON.stringify(state, null, 2),
      'utf8',
    );
  } catch (error) {
    logger.warn(
      { err: error, managedInstallsRoot },
      'Failed to persist reinstall history; quarantine state may be lost on restart',
    );
  }
};

/**
 * Create the service. In production, pass `userDataPath` from `@core/platform`.
 * Tests can pass a tmpdir.
 */
/**
 * Map of package specs that have prebuilt seed tarballs shipped with the app.
 * The value is the seed filename (relative to the seeds directory) — the
 * default lookup joins this with the resolved seeds directory to produce an
 * absolute path. Kept as a constant so a single misnamed file is caught at
 * lookup time (path-not-exists), not at install time (npm cryptic error).
 *
 * To add a new seeded package:
 *   1. Add the spec → filename mapping here.
 *   2. Add it to `SEED_TARGETS` in `scripts/build-managed-install-seeds.mjs`.
 *   3. Verify both refer to the same constants in `src/shared/sidecar/`.
 */
const SEEDED_PACKAGE_FILENAMES: Readonly<Record<PackageSpec, string>> = {
  [OFFICE_MCP_PACKAGE_SPEC]: OFFICE_MCP_SEED_TARBALL_FILENAME,
};

interface ManagedInstallSeedManifestEntry {
  filename: string;
  packageSpec: PackageSpec;
  sha256: string;
  sizeBytes: number;
}

const seedLookupLogger = createScopedLogger({
  service: 'managed-mcp-install',
  component: 'seed-lookup',
});

const getPlatformConfigForSeedLookup = (
  logger: ReturnType<typeof createScopedLogger>,
): PlatformConfig | null => {
  try {
    return getPlatformConfig();
  } catch (error) {
    logger.warn(
      { event: 'managed_install_seed_platform_unavailable', err: error },
      'Platform config unavailable while resolving managed-install seed directory',
    );
    return null;
  }
};

const isMindstoneRepoRoot = (candidate: string): boolean => {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(candidate, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return packageJson.name === 'mindstone-rebel';
  } catch {
    return false;
  }
};

export const findRepoRootFrom = (start: string | undefined): string | null => {
  if (!start) {
    return null;
  }
  let current = path.resolve(start);
  while (true) {
    if (isMindstoneRepoRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

/**
 * Resolve the directory where managed-install seed tarballs live.
 * Packaged: `<process.resourcesPath>/managed-install-seeds`.
 * Dev: `<repoRoot>/dist/managed-install-seeds`.
 */
const resolveSeedDir = (
  logger: ReturnType<typeof createScopedLogger> = seedLookupLogger,
): string | null => {
  const platform = getPlatformConfigForSeedLookup(logger);
  if (platform?.isPackaged && typeof process.resourcesPath === 'string') {
    return path.join(process.resourcesPath, MANAGED_INSTALL_SEEDS_SUBDIR);
  }

  // Do not use process.cwd(): launchers/tests can change it. In development,
  // app.getAppPath() (surfaced as PlatformConfig.appPath) normally points at
  // the repo root; __dirname is a stable fallback for direct Vitest/source runs.
  const repoRoot =
    findRepoRootFrom(platform?.appPath) ??
    findRepoRootFrom(__dirname);

  if (!repoRoot) {
    logger.warn(
      {
        event: 'managed_install_seed_dir_unresolved',
        appPath: platform?.appPath,
        moduleDir: __dirname,
      },
      'Unable to resolve managed-install seed directory; falling back to registry installs',
    );
    return null;
  }

  return path.join(repoRoot, 'dist', MANAGED_INSTALL_SEEDS_SUBDIR);
};

/**
 * Default seed lookup. Exported for tests so they can verify the
 * `process.resourcesPath` / dev fallback resolution end-to-end.
 */
export const defaultSeedTarballLookup = (
  packageSpec: PackageSpec,
): string | null => {
  const filename = SEEDED_PACKAGE_FILENAMES[packageSpec];
  if (!filename) {
    return null;
  }
  const seedDir = resolveSeedDir();
  if (!seedDir) {
    return null;
  }
  const absPath = path.join(seedDir, filename);
  if (!statSync(absPath, { throwIfNoEntry: false })?.isFile()) {
    return null;
  }
  return absPath;
};

const isSeedManifestEntry = (value: unknown): value is ManagedInstallSeedManifestEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ManagedInstallSeedManifestEntry>;
  return (
    typeof candidate.filename === 'string' &&
    typeof candidate.packageSpec === 'string' &&
    typeof candidate.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(candidate.sha256) &&
    typeof candidate.sizeBytes === 'number' &&
    Number.isFinite(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  );
};

const parseSeedManifestEntries = (raw: string): ManagedInstallSeedManifestEntry[] | null => {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const seeds = (parsed as { seeds?: unknown }).seeds;
  if (!Array.isArray(seeds) || !seeds.every(isSeedManifestEntry)) {
    return null;
  }
  return seeds;
};

const sha256File = async (filePath: string): Promise<string> => {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
};

const verifySeedTarballForInstall = async (
  packageSpec: PackageSpec,
  seedPath: string,
  logger: ReturnType<typeof createScopedLogger>,
): Promise<boolean> => {
  const manifestPath = path.join(path.dirname(seedPath), SEEDS_MANIFEST_FILENAME);
  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      // Migration path: older app builds shipped seed tarballs without a
      // manifest. Treat those seeds as unverifiable and fall back to the
      // public registry rather than tightening this into a hard install fail.
      logger.warn(
        {
          event: 'managed_install_seeds_manifest_missing',
          packageSpec,
          seedPath,
          manifestPath,
        },
        'Managed-install seed manifest missing; falling back to registry install',
      );
      return false;
    }
    logger.warn(
      {
        event: 'managed_install_seeds_manifest_read_failed',
        err: error,
        packageSpec,
        seedPath,
        manifestPath,
      },
      'Unable to read managed-install seed manifest; falling back to registry install',
    );
    return false;
  }

  let manifestEntries: ManagedInstallSeedManifestEntry[] | null;
  try {
    manifestEntries = parseSeedManifestEntries(rawManifest);
  } catch (error) {
    logger.warn(
      {
        event: 'managed_install_seeds_manifest_invalid_json',
        err: error,
        packageSpec,
        seedPath,
        manifestPath,
      },
      'Managed-install seed manifest is not valid JSON; falling back to registry install',
    );
    return false;
  }

  if (!manifestEntries) {
    logger.warn(
      {
        event: 'managed_install_seeds_manifest_invalid_schema',
        packageSpec,
        seedPath,
        manifestPath,
      },
      'Managed-install seed manifest has invalid schema; falling back to registry install',
    );
    return false;
  }

  const seedFilename = path.basename(seedPath);
  const manifestEntry = manifestEntries.find(
    (entry) => entry.packageSpec === packageSpec && entry.filename === seedFilename,
  );
  if (!manifestEntry) {
    logger.warn(
      {
        event: 'managed_install_seed_manifest_entry_missing',
        packageSpec,
        seedFilename,
        manifestPath,
      },
      'Managed-install seed missing from manifest; falling back to registry install',
    );
    return false;
  }

  let actualSha: string;
  try {
    actualSha = await sha256File(seedPath);
  } catch (error) {
    logger.warn(
      {
        event: 'managed_install_seed_hash_failed',
        err: error,
        packageSpec,
        seedPath,
      },
      'Unable to hash managed-install seed tarball; falling back to registry install',
    );
    return false;
  }

  if (actualSha !== manifestEntry.sha256) {
    logger.error(
      {
        event: 'managed_install_seed_integrity_mismatch',
        packageSpec,
        expectedSha: manifestEntry.sha256,
        actualSha,
      },
      'Managed-install seed tarball failed integrity verification; falling back to registry install',
    );
    getErrorReporter().addBreadcrumb({
      category: 'managed-mcp-install',
      message: 'Managed-install seed integrity mismatch; falling back to registry install',
      level: 'error',
      data: {
        packageSpec,
        expectedSha: manifestEntry.sha256,
        actualSha,
      },
    });
    return false;
  }

  return true;
};

/**
 * Resolves a local seed tarball for a package spec, or null if not seeded.
 *
 * Seeds let `install()` skip the npm registry round-trip on first launch by
 * pointing npm at `file:<tarball>` instead of `<spec>`. The resulting install
 * layout is identical (npm resolves the manifest's `name` for `node_modules/`
 * placement, not the install argument), so all downstream consumers
 * (`getMetadata`, `entryPath`, sidecar fork) work unchanged.
 *
 * Default implementation reads from:
 *   - packaged: `process.resourcesPath/managed-install-seeds/`
 *   - dev: `<repoRoot>/dist/managed-install-seeds/`
 *
 * Tests inject a stub that returns absolute paths to fixture tarballs.
 */
export type SeedTarballLookup = (packageSpec: PackageSpec) => string | null;

export function createManagedMcpInstallService(options: {
  /** Root directory where installs go: `<root>/mcp/managed-installs/<pkg>@<version>/` */
  userDataPath: string;
  /** Optional npm binary path (default: resolve from PATH / setupNodeEnvironment) */
  npmPath?: string;
  /** Optional logger. Default: createScopedLogger({ service: 'managed-mcp-install' }) */
  logger?: ReturnType<typeof createScopedLogger>;
  /** Optional dependency injection for testing (default: child_process.execFile) */
  execFile?: typeof nodeExecFile;
  /** Optional dependency injection for testing (default: fs.rename) */
  rename?: typeof fs.rename;
  /**
   * Optional seed-tarball lookup. When the lookup returns a path, the install
   * uses `npm install file:<path>` instead of `npm install <spec>` — instant,
   * offline-capable, identical resulting layout. Default lookup reads from
   * the packaged resources / dev `dist/` folder. Pass a stub in tests.
   */
  seedTarballLookup?: SeedTarballLookup;
}): ManagedMcpInstallService {
  const logger = options.logger ?? createScopedLogger({ service: 'managed-mcp-install' });
  const managedInstallsRoot = managedInstallsRootFor(path.resolve(options.userDataPath));
  const execFileImpl = (options.execFile ?? nodeExecFile) as unknown as ExecFileInvoker;
  const renameImpl = options.rename ?? fs.rename;
  const seedLookup = options.seedTarballLookup ?? defaultSeedTarballLookup;

  // Per-spec in-process install dedupe. If two callers request install of the same
  // spec concurrently, they share the same promise instead of racing through temp
  // dirs, duplicating npm traffic, and relying on the filesystem race handling below.
  const inflightInstalls = new Map<PackageSpec, Promise<InstallMetadata>>();

  const getInstallRoot = (packageSpec: PackageSpec): string => {
    parsePackageSpec(packageSpec);
    return path.join(managedInstallsRoot, packageSpec);
  };

  const getMetadata = async (packageSpec: PackageSpec): Promise<InstallMetadata | null> => {
    const installRoot = getInstallRoot(packageSpec);
    const metadata = await readMetadataFromInstallRoot(installRoot, packageSpec);
    if (!metadata) {
      return null;
    }
    const validation = await validateInstalledState(metadata);
    if (!validation.ok) {
      logger.warn(
        { packageSpec, installRoot, reason: validation.reason },
        'Managed MCP install metadata present but install state invalid; returning null',
      );
      return null;
    }
    return metadata;
  };

  const performInstall = async (
    packageSpec: PackageSpec,
    force: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    source: InstallOptions['source'] | undefined,
  ): Promise<InstallMetadata> => {
    const { name: packageName, version } = parsePackageSpec(packageSpec);
    const installRoot = getInstallRoot(packageSpec);

    // Windows MAX_PATH pre-flight: fail fast with a dedicated error so auto-
    // upgrade can revert to npx instead of silently burning an install round-
    // trip. POSIX has no equivalent limit, so skip there.
    if (
      process.platform === 'win32' &&
      installRoot.length > WINDOWS_INSTALL_ROOT_MAX_LEN
    ) {
      throw new InstallPathTooLongError(
        `Managed install root exceeds Windows MAX_PATH budget (${installRoot.length} > ${WINDOWS_INSTALL_ROOT_MAX_LEN} chars): ${installRoot}`,
        packageSpec,
      );
    }

    const existingMetadata = await getMetadata(packageSpec);

    // Caller-supplied local tarballs ALWAYS produce a fresh install. The
    // iteration loop is "rebuild + reinstall + relaunch"; reusing an existing
    // slot because the version string is unchanged would silently run the
    // previous build's bytes and defeat the whole point of the workflow.
    const treatAsForce = force || Boolean(source?.localTarball);

    if (existingMetadata && !treatAsForce) {
      logger.debug({ packageSpec, installRoot }, 'Managed MCP install already present; reusing metadata');
      return existingMetadata;
    }

    let tempDir: string | null = null;
    const startedAt = Date.now();
    const npmRunner = options.npmPath
      ? buildExplicitNpmRunner(options.npmPath, logger)
      : await resolveDefaultNpmRunner(logger);

    // Install argument resolution (priority order):
    //   1. Caller-supplied local tarball (`source.localTarball`) — pre-publish
    //      test path. Bypasses both registry fetch and seed-manifest checksum
    //      verification because the tarball is caller-trusted (built locally).
    //   2. Bundled seed tarball — first-launch offline fast path for shipped
    //      packages. Checksum-verified against `seeds-manifest.json`.
    //   3. Registry fetch — normal `npm install <spec>` path.
    // npm resolves the package identity from the tarball's manifest in both
    // tarball paths, so the resulting `node_modules/` layout is identical
    // regardless of which path produced the install argument.
    let installArg: string;
    let installArgSource: 'local-tarball' | 'seed' | 'registry';
    if (source?.localTarball) {
      const callerTarballPath = source.localTarball;
      if (!path.isAbsolute(callerTarballPath)) {
        throw new ManagedMcpInstallError(
          `source.localTarball must be an absolute path: ${callerTarballPath}`,
          packageSpec,
        );
      }
      try {
        const tarballStats = await fs.stat(callerTarballPath);
        if (!tarballStats.isFile()) {
          throw new ManagedMcpInstallError(
            `source.localTarball is not a regular file: ${callerTarballPath}`,
            packageSpec,
          );
        }
      } catch (error) {
        if (error instanceof ManagedMcpInstallError) {
          throw error;
        }
        throw new ManagedMcpInstallError(
          `source.localTarball does not exist or is unreadable: ${callerTarballPath}`,
          packageSpec,
          error,
        );
      }
      installArg = `file:${callerTarballPath}`;
      installArgSource = 'local-tarball';
      logger.info(
        { packageSpec, localTarballPath: callerTarballPath },
        'Installing managed MCP from caller-supplied local tarball (pre-publish test path)',
      );
    } else {
      const seedPath = seedLookup(packageSpec);
      const verifiedSeedPath =
        seedPath && (await verifySeedTarballForInstall(packageSpec, seedPath, logger))
          ? seedPath
          : null;
      if (verifiedSeedPath) {
        installArg = `file:${verifiedSeedPath}`;
        installArgSource = 'seed';
        logger.info(
          { packageSpec, seedPath: verifiedSeedPath },
          'Installing managed MCP from seed tarball (offline fast path)',
        );
      } else {
        installArg = packageSpec;
        installArgSource = 'registry';
      }
    }

    logger.info(
      { packageSpec, installRoot, npmRunner: npmRunner.description, force, installArgSource },
      'Starting managed MCP install',
    );

    try {
      tempDir = await createTempDir(managedInstallsRoot);
      await writeContainerPackageJson(tempDir, packageName);

      await execFileAsync(
        execFileImpl,
        npmRunner.executable,
        [...npmRunner.prefixArgs, 'install', installArg, '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            npm_config_userconfig: '',
            npm_config_globalconfig: '',
          },
          timeout: timeoutMs,
          signal,
          windowsHide: true,
        },
        timeoutMs,
        signal
      );

      const tempEntryPath = await resolveInstalledEntryPath(tempDir, packageSpec, packageName);
      const relativeEntryPath = path.relative(tempDir, tempEntryPath);

      // Local-tarball drift guard: when the caller supplied a tarball, verify
      // the installed package version matches the spec's version. Otherwise an
      // engineer who packed an older build into 0.2.0's slot would get a
      // green test that's actually running stale code — exactly the silent-
      // failure pattern AGENTS.md warns against.
      if (installArgSource === 'local-tarball') {
        const installedManifestPath = path.join(
          tempDir,
          'node_modules',
          ...packageName.split('/'),
          'package.json',
        );
        let installedVersion: string | undefined;
        try {
          const raw = await fs.readFile(installedManifestPath, 'utf8');
          installedVersion = (JSON.parse(raw) as { version?: string }).version;
        } catch (error) {
          throw new ManagedMcpInstallError(
            `Installed package.json missing or unreadable after local-tarball install of ${packageSpec}`,
            packageSpec,
            error,
          );
        }
        if (installedVersion !== version) {
          throw new ManagedMcpInstallError(
            `Local tarball version mismatch: spec asked for ${version} but tarball produced ${installedVersion ?? '<missing>'}. Re-pack the source tree at the matching version, or change the packageSpec.`,
            packageSpec,
          );
        }
      }

      const metadata: InstallMetadata = {
        packageSpec,
        packageName,
        version,
        entryPath: path.join(installRoot, relativeEntryPath),
        installRoot,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
        metaVersion: 1,
      };

      await writeMetadataFile(tempDir, metadata);

      // Sentinel write: local-tarball installs leave a marker file alongside
      // .install-meta.json so startup banner code can spot stale dev builds
      // before the engineer accidentally ships fixes against a phantom repro.
      // Written into the temp dir BEFORE atomic rename so it lands or is
      // discarded atomically with the rest of the install.
      if (installArgSource === 'local-tarball' && source?.localTarball) {
        await writeDevPrePublishSentinel(tempDir, {
          source: 'pre-publish-test',
          installedAt: metadata.installedAt,
          tarballPath: source.localTarball,
          metaVersion: 1,
        });
      }

      await fs.mkdir(path.dirname(installRoot), { recursive: true });

      // readAndValidateExisting: race-winners must be backed by a validated install,
      // not just metadata presence. If the winner's state is invalid, we take the
      // promotion ourselves rather than hand back a phantom install.
      const readAndValidateExisting = async (): Promise<InstallMetadata | null> => {
        const raw = await readMetadataFromInstallRoot(installRoot, packageSpec);
        if (!raw) {
          return null;
        }
        const validation = await validateInstalledState(raw);
        if (!validation.ok) {
          logger.warn(
            { packageSpec, installRoot, reason: validation.reason },
            'Managed MCP install race winner state invalid; falling through to self-promotion'
          );
          return null;
        }
        return raw;
      };

      if (await pathExists(installRoot)) {
        const currentMetadata = await readAndValidateExisting();
        const tempDirPath = tempDir;

        if (!tempDirPath) {
          throw new Error(`Temp install directory missing for ${packageSpec}`);
        }

        if (currentMetadata && !force) {
          await removeDirectoryIfExists(tempDirPath);
          tempDir = null;
          logger.info(
            { packageSpec, installRoot, durationMs: Date.now() - startedAt },
            'Managed MCP install raced with an existing install; reused target metadata'
          );
          return currentMetadata;
        }

        await replaceInstallRootAtomically(tempDirPath, installRoot, renameImpl, logger);
        tempDir = null;
      } else {
        try {
          const tempDirPath = tempDir;

          if (!tempDirPath) {
            throw new Error(`Temp install directory missing for ${packageSpec}`);
          }

          await renameImpl(tempDirPath, installRoot);
          tempDir = null;
        } catch (error) {
          if (!isTargetExistsError(error)) {
            throw error;
          }

          const currentMetadata = await readAndValidateExisting();
          const tempDirPath = tempDir;

          if (!tempDirPath) {
            throw new Error(`Temp install directory missing for ${packageSpec}`);
          }

          if (currentMetadata) {
            await removeDirectoryIfExists(tempDirPath);
            tempDir = null;
            logger.info(
              { packageSpec, installRoot, durationMs: Date.now() - startedAt },
              'Managed MCP install lost a concurrent rename race; reused target metadata'
            );
            return currentMetadata;
          }

          await replaceInstallRootAtomically(tempDirPath, installRoot, renameImpl, logger);
          tempDir = null;
        }
      }

      logger.info(
        {
          packageSpec,
          installRoot,
          entryPath: metadata.entryPath,
          durationMs: Date.now() - startedAt,
        },
        'Managed MCP install completed successfully'
      );

      return metadata;
    } catch (error) {
      if (tempDir) {
        await removeDirectoryIfExists(tempDir);
      }

      logger.error(
        {
          packageSpec,
          installRoot,
          durationMs: Date.now() - startedAt,
          stderr: getExecStderr(error),
          err: error,
        },
        'Managed MCP install failed'
      );

      if (error instanceof ManagedMcpInstallError) {
        throw error;
      }

      if (isTimeoutError(error)) {
        throw new InstallTimeoutError(
          `Timed out installing ${packageSpec} after ${timeoutMs}ms`,
          packageSpec,
          error
        );
      }

      throw new ManagedMcpInstallError(
        `Failed to install ${packageSpec}: ${toErrorMessage(error)}`,
        packageSpec,
        error
      );
    }
  };

  const install = async ({ packageSpec, force = false, signal, timeoutMs = DEFAULT_TIMEOUT_MS, source }: InstallOptions): Promise<InstallMetadata> => {
    // In-process dedupe: if two callers request the same spec concurrently, the
    // second waits on the first's promise instead of racing through temp dirs.
    // Forced installs and caller-supplied tarball installs get their own dedupe
    // key so they don't piggyback on a non-force / non-tarball in-flight run
    // (the caller explicitly asked for a fresh install from a specific source).
    const dedupeKey = force || source?.localTarball
      ? `${packageSpec}::force::${randomHex()}`
      : packageSpec;
    const inflight = inflightInstalls.get(dedupeKey);
    if (inflight) {
      return inflight;
    }

    const promise = performInstall(packageSpec, force, signal, timeoutMs, source).finally(() => {
      inflightInstalls.delete(dedupeKey);
    });
    inflightInstalls.set(dedupeKey, promise);
    return promise;
  };

  const isInstalled = async (packageSpec: PackageSpec): Promise<boolean> => {
    // isInstalled means the install is usable, not merely that metadata exists on
    // disk. Use getMetadata (which validates) to avoid phantom-install false
    // positives when antivirus quarantines the entry file or the install dir is
    // truncated by a cleanup tool.
    const metadata = await getMetadata(packageSpec);
    return metadata !== null;
  };

  const uninstall = async (packageSpec: PackageSpec): Promise<void> => {
    const installRoot = getInstallRoot(packageSpec);
    await removeDirectoryIfExists(installRoot);
  };

  const cleanupStaleTempDirs = async (): Promise<{ removed: string[]; errors: Array<{ path: string; error: string }> }> => {
    const removed: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    // Also sweep leftover backup directories (`.<spec>.bak-<pid>-<hex>`) from
    // crashed atomic-replace operations. Without this, a crash between the
    // rename-to-backup and rename-temp-into-target steps leaks the previous
    // install forever.
    const isStaleCandidate = (name: string): boolean =>
      name.startsWith('.tmp-') || (name.startsWith('.') && name.includes('.bak-'));

    try {
      const entries = await fs.readdir(managedInstallsRoot, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory() || !isStaleCandidate(entry.name)) {
          continue;
        }

        const candidatePath = path.join(managedInstallsRoot, entry.name);
        try {
          const stats = await fs.stat(candidatePath);
          if (now - stats.mtimeMs <= STALE_TEMP_DIR_MAX_AGE_MS) {
            continue;
          }

          await removeDirectoryIfExists(candidatePath);
          removed.push(candidatePath);
        } catch (error) {
          errors.push({ path: candidatePath, error: toErrorMessage(error) });
        }
      }
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        errors.push({ path: managedInstallsRoot, error: toErrorMessage(error) });
      }
    }

    if (removed.length > 0 || errors.length > 0) {
      logger.info({ removed, errors }, 'Managed MCP temp/backup directory cleanup completed');
    }

    return { removed, errors };
  };

  const recordReinstallAttempt = async (
    packageSpec: PackageSpec,
  ): Promise<ReinstallHistoryEntry> => {
    parsePackageSpec(packageSpec);
    const state = await loadReinstallHistory(managedInstallsRoot, logger);
    const existing = state.specs[packageSpec];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    let entry: ReinstallHistoryEntry;
    if (existing) {
      const firstAtMs = Date.parse(existing.firstReinstallAt);
      const withinWindow =
        Number.isFinite(firstAtMs) &&
        now - firstAtMs <= REINSTALL_QUARANTINE_WINDOW_MS;

      if (withinWindow) {
        const nextCount = existing.reinstallCount + 1;
        entry = {
          firstReinstallAt: existing.firstReinstallAt,
          lastReinstallAt: nowIso,
          reinstallCount: nextCount,
          quarantined: nextCount >= REINSTALL_QUARANTINE_THRESHOLD,
        };
      } else {
        entry = {
          firstReinstallAt: nowIso,
          lastReinstallAt: nowIso,
          reinstallCount: 1,
          quarantined: false,
        };
      }
    } else {
      entry = {
        firstReinstallAt: nowIso,
        lastReinstallAt: nowIso,
        reinstallCount: 1,
        quarantined: false,
      };
    }

    const nextState: ReinstallHistoryState = {
      version: 1,
      specs: { ...state.specs, [packageSpec]: entry },
    };
    await persistReinstallHistory(managedInstallsRoot, nextState, logger);

    if (entry.quarantined) {
      logger.warn(
        { packageSpec, reinstallCount: entry.reinstallCount, firstReinstallAt: entry.firstReinstallAt },
        'Managed MCP install quarantined after repeated reinstall attempts',
      );
      if (packageSpec.includes('@mindstone/mcp-server-hubspot@')) {
        emitHubSpotTelemetry({
          event: 'hubspot.quarantine.quarantined',
          quarantinedCount: entry.reinstallCount,
        }).catch((err) => {
          logger.error({ err }, 'hubspot.telemetry_emit_failed');
        });
      }
    }

    return entry;
  };

  const getReinstallHistory = async (
    packageSpec: PackageSpec,
  ): Promise<ReinstallHistoryEntry | null> => {
    parsePackageSpec(packageSpec);
    const state = await loadReinstallHistory(managedInstallsRoot, logger);
    return state.specs[packageSpec] ?? null;
  };

  const clearReinstallHistory = async (packageSpec: PackageSpec): Promise<void> => {
    parsePackageSpec(packageSpec);
    const state = await loadReinstallHistory(managedInstallsRoot, logger);
    if (!(packageSpec in state.specs)) {
      return;
    }
    const nextSpecs = { ...state.specs };
    delete nextSpecs[packageSpec];
    await persistReinstallHistory(
      managedInstallsRoot,
      { version: 1, specs: nextSpecs },
      logger,
    );
    if (packageSpec.includes('@mindstone/mcp-server-hubspot@')) {
      emitHubSpotTelemetry({ event: 'hubspot.quarantine.recovered' }).catch((err) => {
        logger.error({ err }, 'hubspot.telemetry_emit_failed');
      });
    }
  };

  return {
    install,
    getMetadata,
    isInstalled,
    uninstall,
    getInstallRoot,
    cleanupStaleTempDirs,
    recordReinstallAttempt,
    getReinstallHistory,
    clearReinstallHistory,
  };
}
