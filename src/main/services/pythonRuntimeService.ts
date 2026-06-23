/**
 * Python Runtime Detection Service
 *
 * Detects Python and uvx availability for Python-based MCPs.
 * This is NOT a health check - it's a runtime probe called from the UI.
 *
 * Key design decisions:
 * - uvxAvailable is the PRIMARY readiness indicator (Python alone is insufficient)
 * - Uses shell-path to get full PATH from user's shell (fixes GUI app PATH issues)
 * - Checks common paths that may not be in PATH (homebrew, .local/bin, etc.)
 * - Tiered caching: 30s for positive results (Python/uvx found), 10min for negative
 *   results (nothing found). Negative results rarely change mid-session, and re-running
 *   subprocess detection costs ~2s on Windows.
 * - 5-second timeout on all subprocess calls
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellPath } from 'shell-path';
import { runProbe } from './processProbe';
import { createScopedLogger } from '@core/logger';

const logger = createScopedLogger({ service: 'pythonRuntime' });

/** Result of Python runtime detection */
export interface PythonRuntimeStatus {
  /** Primary indicator - uvx is what Python MCPs actually need */
  uvxAvailable: boolean;
  uvxVersion: string | null;
  uvxPath: string | null;

  /** Secondary info - helpful for debugging but not primary indicator */
  pythonAvailable: boolean;
  pythonVersion: string | null;
  pythonPath: string | null;

  /** Windows-specific: true if Store aliases exist but are being blocked */
  windowsAliasesBlocked?: boolean;

  /** Timestamp for cache invalidation */
  checkedAt: number;
}

/** Cache duration for positive results (Python or uvx found) — 30 seconds */
const POSITIVE_CACHE_DURATION_MS = 30_000;

/** Cache duration for negative results (neither Python nor uvx found) — 10 minutes.
 *  Negative results rarely change mid-session and re-detection costs ~2s on Windows. */
const NEGATIVE_CACHE_DURATION_MS = 600_000;

/** Timeout for subprocess calls in milliseconds */
const SUBPROCESS_TIMEOUT_MS = 5_000;

/** Cached result */
let cachedStatus: PythonRuntimeStatus | null = null;

/**
 * Check if a path is in the WindowsApps directory (Microsoft Store alias location).
 * These are stub executables that open the Microsoft Store instead of running Python.
 */
function isWindowsAppsPath(p: string): boolean {
  const normalized = p.toLowerCase().replace(/\//g, '\\');
  return normalized.includes('microsoft\\windowsapps');
}

/**
 * Parse output from `py -0p` (Python Launcher).
 * Output format: " -V:3.12 *        C:\Path\To\python.exe"
 * Returns array of {version, path} for Python 3.x entries only.
 */
function parsePyLauncherOutput(output: string): { version: string; path: string }[] {
  const results: { version: string; path: string }[] = [];
  const lines = output.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    // Match pattern: -V:MAJOR.MINOR[-ARCH] [*] PATH
    // The (?:-\d+)? handles architecture markers like -32, -64, -arm64 (though arm64 isn't purely numeric)
    // Examples:
    //   " -V:3.12 *        C:\Python312\python.exe"       (default)
    //   " -V:3.11          C:\Python311\python.exe"       (non-default)
    //   " -V:3.10-32       C:\Python310-32\python.exe"    (32-bit)
    //   " -V:3.12-64       C:\Python312\python.exe"       (64-bit explicit)
    const match = line.match(/-V:(\d+\.\d+)(?:-\w+)?\s+\*?\s*(.+)/);
    if (match) {
      const version = match[1];
      const pythonPath = match[2].trim();

      // Only include Python 3.x
      const major = parseInt(version.split('.')[0], 10);
      if (major >= 3 && pythonPath) {
        results.push({ version, path: pythonPath });
      }
    }
  }

  return results;
}

/**
 * Resolve a command to a non-WindowsApps path using where.exe.
 * Returns the first safe path found, or null if all paths are WindowsApps aliases.
 * @param cmd - Command to resolve (e.g., 'python3', 'python')
 * @param fullPath - Full PATH string to use for resolution (includes shell-derived paths)
 */
async function resolveWindowsCommand(
  cmd: string,
  fullPath: string
): Promise<{
  safePath: string | null;
  aliasesFound: boolean;
}> {
  try {
    const whereExe = 'C:\\Windows\\System32\\where.exe';
    const result = await runProbe(whereExe, [cmd], {
      env: { PATH: fullPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      return { safePath: null, aliasesFound: false };
    }

    const paths = result.stdout.split(/\r?\n/).filter(Boolean);
    let aliasesFound = false;

    // Find first non-WindowsApps path
    for (const p of paths) {
      if (isWindowsAppsPath(p)) {
        aliasesFound = true;
        logger.debug({ path: p }, 'Filtered out WindowsApps path');
      } else {
        return { safePath: p.trim(), aliasesFound };
      }
    }

    return { safePath: null, aliasesFound };
  } catch (err) {
    logger.debug({ cmd, error: err }, 'Failed to resolve Windows command');
    return { safePath: null, aliasesFound: false };
  }
}

/**
 * Get common paths to check for executables that may not be in PATH.
 * GUI apps often miss user-installed tools in these locations.
 */
function getExtraPaths(): string[] {
  const homeDir = os.homedir();
  const platform = process.platform;

  const paths: string[] = [];

  if (platform === 'win32') {
    // Windows paths
    paths.push(path.join(homeDir, '.local', 'bin'));
    const appData = process.env.APPDATA;
    if (appData) {
      paths.push(path.join(appData, 'Python', 'Scripts'));
    }
    // Also check LocalAppData for user-installed Python
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      paths.push(path.join(localAppData, 'Programs', 'Python'));
    }
  } else if (platform === 'darwin') {
    // macOS paths
    paths.push('/opt/homebrew/bin'); // Apple Silicon homebrew
    paths.push('/usr/local/bin'); // Intel homebrew
    paths.push(path.join(homeDir, '.local', 'bin')); // uv default
    paths.push(path.join(homeDir, '.cargo', 'bin')); // older uv installs
  } else {
    // Linux paths
    paths.push(path.join(homeDir, '.local', 'bin'));
    paths.push('/usr/local/bin');
    paths.push(path.join(homeDir, '.cargo', 'bin'));
  }

  return paths;
}

/**
 * Try to find an executable, first via PATH then in common locations.
 * Returns the full path if found, null otherwise.
 */
async function _findExecutable(
  name: string,
  fullPath: string
): Promise<string | null> {
  // First try using the shell PATH
  try {
    const result = await runProbe(name, ['--version'], {
      env: { PATH: fullPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      // The command worked, but we need to find its actual path
      // On Unix, use 'which'; on Windows, use 'where'
      const findCmd = process.platform === 'win32' ? 'where' : 'which';
      try {
        const pathResult = await runProbe(findCmd, [name], {
          env: { PATH: fullPath },
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
          // 'where' on Windows may return multiple lines, take first
          return pathResult.stdout.trim().split('\n')[0].trim();
        }
      } catch {
        // Couldn't find path, but command works - return name as-is
        return name;
      }
      return name;
    }
  } catch {
    // Command not found in PATH
  }

  // Check extra paths directly
  const extraPaths = getExtraPaths();
  const isWindows = process.platform === 'win32';
  const extensions = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of extraPaths) {
    for (const ext of extensions) {
      const fullExePath = path.join(dir, name + ext);
      try {
        const result = await runProbe(fullExePath, ['--version'], {
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (result.exitCode === 0) {
          return fullExePath;
        }
      } catch {
        // File doesn't exist or isn't executable
      }
    }
  }

  return null;
}

/**
 * Parse version string from command output.
 * Handles formats like "Python 3.11.5", "uvx 0.9.0", etc.
 */
function parseVersion(output: string): string | null {
  if (!output) return null;

  // Try to extract version number (handles "Python 3.11.5", "uvx 0.9.0", etc.)
  const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z0-9.-]*)?)/i);
  return match ? match[1] : null;
}

/**
 * Check if a version string represents Python 3.x
 */
function isPython3(version: string | null): boolean {
  if (!version) return false;
  const major = parseInt(version.split('.')[0], 10);
  return major >= 3;
}

/**
 * Detect Python installation on Windows.
 * Uses py.exe -0p as primary method (never triggers Store), then where.exe with filtering.
 * NEVER executes python3 or python directly on Windows (this triggers Store).
 */
async function detectPythonWindows(
  fullPath: string
): Promise<{
  available: boolean;
  version: string | null;
  path: string | null;
  windowsAliasesBlocked: boolean;
}> {
  let aliasesBlocked = false;

  // Step 1: Try py.exe -0p (Python Launcher) - this is the safest method
  // py.exe never triggers Store and lists all installed Pythons with their paths
  logger.debug('Windows: Trying py.exe -0p for Python detection');
  try {
    const pyResult = await runProbe('py', ['-0p'], {
      env: { PATH: fullPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    if (pyResult.exitCode === 0 && pyResult.stdout) {
      const pythons = parsePyLauncherOutput(pyResult.stdout);
      logger.debug({ pythonCount: pythons.length }, 'py -0p found Python installations');

      // Filter out WindowsApps paths
      for (const py of pythons) {
        if (isWindowsAppsPath(py.path)) {
          aliasesBlocked = true;
          logger.debug({ path: py.path }, 'Filtered WindowsApps path from py -0p');
          continue;
        }

        // Verify this Python works by getting full version
        try {
          const versionResult = await runProbe(py.path, ['--version'], {
            timeout: SUBPROCESS_TIMEOUT_MS,
          });
          if (versionResult.exitCode === 0) {
            const fullVersion = parseVersion(versionResult.stdout || versionResult.stderr);
            logger.debug({ path: py.path, version: fullVersion }, 'Found Python via py -0p');
            return {
              available: true,
              version: fullVersion,
              path: py.path,
              windowsAliasesBlocked: aliasesBlocked,
            };
          }
        } catch {
          // Path doesn't work, try next
        }
      }
    }
  } catch (err) {
    logger.debug({ error: err }, 'py.exe not available');
  }

  // Step 2: Try where.exe to find python3/python and filter WindowsApps paths
  // We use where.exe to find paths WITHOUT executing the commands directly
  logger.debug('Windows: Trying where.exe for Python detection');

  for (const cmd of ['python3', 'python']) {
    const { safePath, aliasesFound } = await resolveWindowsCommand(cmd, fullPath);
    if (aliasesFound) {
      aliasesBlocked = true;
    }

    if (safePath) {
      // Verify this Python is 3.x by executing the resolved path (not the command)
      try {
        const result = await runProbe(safePath, ['--version'], {
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (result.exitCode === 0) {
          const output = result.stdout || result.stderr;
          const version = parseVersion(output);
          if (isPython3(version)) {
            logger.debug({ cmd, path: safePath, version }, 'Found Python via where.exe');
            return {
              available: true,
              version,
              path: safePath,
              windowsAliasesBlocked: aliasesBlocked,
            };
          }
        }
      } catch {
        // Path doesn't work
      }
    }
  }

  // Step 3: Check extra paths directly (e.g., Program Files)
  const extraPaths = getExtraPaths();
  const pythonNames = ['python3', 'python'];
  const extensions = ['.exe', ''];

  for (const dir of extraPaths) {
    for (const name of pythonNames) {
      for (const ext of extensions) {
        const fullExePath = path.join(dir, name + ext);

        // Skip WindowsApps paths
        if (isWindowsAppsPath(fullExePath)) {
          continue;
        }

        try {
          const result = await runProbe(fullExePath, ['--version'], {
            timeout: SUBPROCESS_TIMEOUT_MS,
          });
          if (result.exitCode === 0) {
            const output = result.stdout || result.stderr;
            const version = parseVersion(output);
            if (isPython3(version)) {
              logger.debug({ path: fullExePath, version }, 'Found Python in extra path');
              return {
                available: true,
                version,
                path: fullExePath,
                windowsAliasesBlocked: aliasesBlocked,
              };
            }
          }
        } catch {
          // Not found or not executable
        }
      }
    }
  }

  logger.debug(
    { aliasesBlocked },
    aliasesBlocked
      ? 'No Python 3.x found on Windows (WindowsApps aliases present but blocked)'
      : 'No Python 3.x found on Windows'
  );
  return {
    available: false,
    version: null,
    path: null,
    windowsAliasesBlocked: aliasesBlocked,
  };
}

/** Absolute paths of Apple's xcode-select tool-shims on macOS.
 *  Executing these triggers the OS "Install Command Line Developer Tools"
 *  dialog when CLT is missing, so we filter them out before any execFile call.
 *
 * Keep this table easy to extend: the safety hook and static chokepoint guard
 * both use it as the canonical set of binary names that must be resolved
 * without executing the candidate binary.
 */
export const MACOS_CLT_SHIM_PATHS_BY_BINARY = {
  python: ['/usr/bin/python'],
  python3: ['/usr/bin/python3'],
  pip: ['/usr/bin/pip'],
  pip3: ['/usr/bin/pip3'],
  git: ['/usr/bin/git'],
  clang: ['/usr/bin/clang'],
  'clang++': ['/usr/bin/clang++'],
  make: ['/usr/bin/make'],
  swift: ['/usr/bin/swift'],
  swiftc: ['/usr/bin/swiftc'],
  lldb: ['/usr/bin/lldb'],
  gcc: ['/usr/bin/gcc'],
  'g++': ['/usr/bin/g++'],
  ld: ['/usr/bin/ld'],
  strip: ['/usr/bin/strip'],
  nm: ['/usr/bin/nm'],
  otool: ['/usr/bin/otool'],
} as const satisfies Record<string, readonly string[]>;

export const MACOS_CLT_SHIM_BINARY_NAMES = Object.keys(
  MACOS_CLT_SHIM_PATHS_BY_BINARY,
) as Array<keyof typeof MACOS_CLT_SHIM_PATHS_BY_BINARY>;

const MACOS_CLT_SHIM_PATHS: Set<string> = new Set(
  Object.values(MACOS_CLT_SHIM_PATHS_BY_BINARY).flat(),
);
const MACOS_PYTHON_SHIM_PATHS: Set<string> = new Set([
  ...MACOS_CLT_SHIM_PATHS_BY_BINARY.python,
  ...MACOS_CLT_SHIM_PATHS_BY_BINARY.python3,
]);

const MACOS_CLT_STATE_CACHE_MS = 10 * 60 * 1000;
const MACOS_CLT_SHIM_RESOLUTION_CACHE_MS = 30 * 1000;

let cachedMacosCltMissing: { value: boolean; checkedAt: number } | null = null;
let cachedMacosCltShimResolutions = new Map<
  string,
  { value: MacosShimResolution; checkedAt: number }
>();

/**
 * Detect whether macOS Command Line Developer Tools are installed.
 * `xcode-select -p` queries state and does NOT trigger the install dialog —
 * only `xcode-select --install` does. We invoke the absolute system path to
 * avoid PATH shadowing.
 */
async function isMacosCltMissing(): Promise<boolean> {
  const now = Date.now();
  if (cachedMacosCltMissing) {
    const ttl = cachedMacosCltMissing.value
      ? MACOS_CLT_SHIM_RESOLUTION_CACHE_MS
      : MACOS_CLT_STATE_CACHE_MS;
    if (now - cachedMacosCltMissing.checkedAt < ttl) {
      return cachedMacosCltMissing.value;
    }
  }

  try {
    const result = await runProbe('/usr/bin/xcode-select', ['-p'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      cachedMacosCltMissing = { value: true, checkedAt: now };
      return true;
    }
    const cltPath = result.stdout.trim();
    if (!cltPath) {
      cachedMacosCltMissing = { value: true, checkedAt: now };
      return true;
    }
    if (!fs.existsSync(cltPath)) {
      cachedMacosCltMissing = { value: true, checkedAt: now };
      return true;
    }
    cachedMacosCltMissing = { value: false, checkedAt: now };
    return false;
  } catch (err) {
    logger.warn(
      { error: err },
      'xcode-select probe failed unexpectedly; treating CLT as missing'
    );
    cachedMacosCltMissing = { value: true, checkedAt: now };
    return true;
  }
}

/** Returns true if `p` (or its realpath) is one of the macOS xcode-select shims. */
function isMacosCltShim(p: string): boolean {
  if (MACOS_CLT_SHIM_PATHS.has(p)) {
    return true;
  }
  try {
    const real = fs.realpathSync.native(p);
    return MACOS_CLT_SHIM_PATHS.has(real);
  } catch {
    return false;
  }
}

/** Returns true if `p` (or its realpath) is one of the macOS xcode-select python shims. */
function isMacosPythonShim(p: string): boolean {
  if (MACOS_PYTHON_SHIM_PATHS.has(p)) {
    return true;
  }
  try {
    const real = fs.realpathSync.native(p);
    return MACOS_PYTHON_SHIM_PATHS.has(real);
  } catch {
    return false;
  }
}

/**
 * Resolve all path candidates for `cmd` on macOS via `/usr/bin/which -a`.
 * Uses the absolute path to `which` to avoid PATH shadowing and never
 * exec's the resolved binary itself (which is what would trigger the shim).
 */
async function resolveMacosCommandPaths(
  cmd: string,
  fullPath: string
): Promise<string[]> {
  try {
    const result = await runProbe('/usr/bin/which', ['-a', cmd], {
      env: { PATH: fullPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    logger.warn({ cmd, error: err }, 'which lookup failed unexpectedly');
    return [];
  }
}

/** Probe a Python at an absolute path; returns Python 3.x details or unavailable. */
async function probePythonCandidate(
  execPath: string
): Promise<{ available: boolean; version: string | null; path: string | null }> {
  try {
    const result = await runProbe(execPath, ['--version'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      const output = result.stdout || result.stderr;
      const version = parseVersion(output);
      if (isPython3(version)) {
        return { available: true, version, path: execPath };
      }
    }
  } catch {
    // Not found / not executable / timed out — treat as unavailable
  }
  return { available: false, version: null, path: null };
}

/**
 * Outcome of resolving a command's FIRST PATH hit on macOS and testing it
 * against the xcode-select CLT shims.
 *
 * - `shim_blocked`: first hit is a `/usr/bin` CLT shim AND CLT is missing —
 *   exec'ing it would pop the OS "install developer tools" dialog. Caller must
 *   NOT spawn the command.
 * - `safe`: first hit is a real (non-shim) executable — safe to run.
 * - `not_found`: command does not resolve under the given PATH.
 * - `not_applicable`: not running on macOS (no shim hazard exists).
 */
export type MacosShimResolution =
  | 'shim_blocked'
  | 'safe'
  | 'not_found'
  | 'not_applicable';

/**
 * Determine whether running `cmd` on macOS would exec an xcode-select CLT
 * shim that triggers the Command Line Developer Tools install dialog.
 *
 * Crucially this resolves the FIRST PATH hit (mirroring shell lookup semantics)
 * using `/usr/bin/which` and NEVER exec's the resolved binary — exec'ing the
 * shim is precisely what pops the dialog. The caller MUST pass the PATH that the
 * command will actually be spawned with (e.g. `process.env.PATH` for the agent
 * Bash tool), not a shell-derived PATH, because PATH ORDER decides which binary
 * the shell hits first.
 *
 * @param cmd - The command name to resolve (e.g. `git`, `python3`, `clang++`).
 * @param pathEnv - The PATH the command will be spawned under.
 */
export async function macosCommandResolvesToCltShim(
  cmd: string,
  pathEnv: string
): Promise<MacosShimResolution> {
  if (process.platform !== 'darwin') {
    return 'not_applicable';
  }

  const cacheKey = `${cmd}\0${pathEnv}`;
  const now = Date.now();
  const cached = cachedMacosCltShimResolutions.get(cacheKey);
  if (cached && now - cached.checkedAt < MACOS_CLT_SHIM_RESOLUTION_CACHE_MS) {
    return cached.value;
  }

  const cacheAndReturn = (value: MacosShimResolution): MacosShimResolution => {
    cachedMacosCltShimResolutions.set(cacheKey, { value, checkedAt: now });
    return value;
  };

  // Short-circuit when the caller already handed us an absolute path (e.g. the
  // command was written as `/usr/bin/python3 x.py`). `which <abspath>` is
  // awkward/inconsistent, so test the path directly: if it's the shim, the
  // CLT-missing check decides; otherwise it's a real binary → safe.
  if (path.isAbsolute(cmd)) {
    if (isMacosCltShim(cmd)) {
      if (await isMacosCltMissing()) {
        logger.info(
          { cmd },
          'macOS absolute command is an xcode-select CLT shim and CLT is missing — blocking to avoid install dialog'
        );
        return cacheAndReturn('shim_blocked');
      }
      return cacheAndReturn('safe');
    }
    return cacheAndReturn('safe');
  }

  const resolved = await resolveMacosCommandPaths(cmd, pathEnv);
  const firstHit = resolved[0];
  if (!firstHit) {
    return cacheAndReturn('not_found');
  }

  // Defensively realpath the first hit so a symlink pointing at the shim is
  // still caught. isMacosCltShim already does its own realpath fallback, but
  // resolving here keeps the decision explicit and centralised.
  let candidate = firstHit;
  try {
    candidate = fs.realpathSync.native(firstHit);
  } catch {
    // realpath can fail if the path doesn't exist on disk; fall back to the raw
    // first hit and let isMacosCltShim's own realpath attempt handle it.
    candidate = firstHit;
  }

  if (isMacosCltShim(candidate) || isMacosCltShim(firstHit)) {
    if (await isMacosCltMissing()) {
      logger.info(
        { cmd, firstHit },
        'macOS command resolves to xcode-select CLT shim and CLT is missing — blocking to avoid install dialog'
      );
      return cacheAndReturn('shim_blocked');
    }
    // Shim path but CLT is installed: allow the developer tool to run.
    return cacheAndReturn('safe');
  }

  return cacheAndReturn('safe');
}

/**
 * Compatibility wrapper for the original python-only caller/tests. New tool
 * execution guards should call `macosCommandResolvesToCltShim`.
 */
export async function macosCommandResolvesToPythonShim(
  cmd: string,
  pathEnv: string
): Promise<MacosShimResolution> {
  return macosCommandResolvesToCltShim(cmd, pathEnv);
}

/**
 * Detect Python on macOS without triggering the xcode-select install dialog.
 *
 * The hazard: `/usr/bin/python3` and `/usr/bin/python` are tool-shims managed
 * by xcode-select; exec'ing them when CLT isn't installed pops a system modal
 * asking the user to install Command Line Developer Tools. We resolve all
 * candidate paths via `which` first, filter out shim paths when CLT is
 * missing, and only then probe non-shim paths.
 */
async function detectPythonDarwin(
  fullPath: string
): Promise<{ available: boolean; version: string | null; path: string | null }> {
  const cltMissing = await isMacosCltMissing();
  if (cltMissing) {
    logger.debug(
      'macOS Command Line Developer Tools not detected; will skip /usr/bin python shims'
    );
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (p: string): void => {
    if (!p) return;
    if (cltMissing && isMacosPythonShim(p)) {
      logger.debug({ path: p }, 'Filtered macOS xcode-select python shim');
      return;
    }
    if (seen.has(p)) return;
    seen.add(p);
    candidates.push(p);
  };

  for (const cmd of ['python3', 'python']) {
    const resolved = await resolveMacosCommandPaths(cmd, fullPath);
    for (const p of resolved) {
      addCandidate(p);
    }
  }

  const extraPaths = getExtraPaths();
  for (const dir of extraPaths) {
    for (const name of ['python3', 'python']) {
      addCandidate(path.join(dir, name));
    }
  }

  for (const candidate of candidates) {
    const result = await probePythonCandidate(candidate);
    if (result.available) {
      logger.debug({ path: result.path, version: result.version }, 'Found Python');
      return result;
    }
  }

  logger.debug({ cltMissing }, 'No Python 3.x found on macOS');
  return { available: false, version: null, path: null };
}

/**
 * Detect Python on Linux. Uses standard python3/python commands.
 * Linux has no equivalent to macOS's xcode-select shim, so this path
 * remains the original execute-then-resolve flow.
 */
async function detectPythonLinux(
  fullPath: string
): Promise<{ available: boolean; version: string | null; path: string | null }> {
  const candidates = [
    { cmd: 'python3', args: ['--version'] },
    { cmd: 'python', args: ['--version'] },
  ];

  for (const { cmd, args } of candidates) {
    try {
      // Try command in PATH
      const result = await runProbe(cmd, args, {
        env: { PATH: fullPath },
        timeout: SUBPROCESS_TIMEOUT_MS,
      });

      if (result.exitCode === 0) {
        const output = result.stdout || result.stderr;
        const version = parseVersion(output);

        // For 'python' command, verify it's Python 3
        if (cmd === 'python' && !isPython3(version)) {
          logger.debug({ cmd, version }, 'Skipping Python 2.x');
          continue;
        }

        // Find the actual path
        let execPath: string | null = cmd;
        try {
          const pathResult = await runProbe('which', [cmd], {
            env: { PATH: fullPath },
            timeout: SUBPROCESS_TIMEOUT_MS,
          });
          if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
            execPath = pathResult.stdout.trim().split('\n')[0].trim();
          }
        } catch {
          // Use command name as fallback
        }

        logger.debug({ cmd, version, path: execPath }, 'Found Python');
        return { available: true, version, path: execPath };
      }
    } catch (err) {
      logger.debug({ cmd, error: err }, 'Python detection failed for candidate');
    }
  }

  // Check extra paths
  const extraPaths = getExtraPaths();

  for (const dir of extraPaths) {
    for (const name of ['python3', 'python']) {
      const fullExePath = path.join(dir, name);
      try {
        const result = await runProbe(fullExePath, ['--version'], {
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (result.exitCode === 0) {
          const output = result.stdout || result.stderr;
          const version = parseVersion(output);
          if (isPython3(version)) {
            logger.debug({ path: fullExePath, version }, 'Found Python in extra path');
            return { available: true, version, path: fullExePath };
          }
        }
      } catch {
        // Not found or not executable
      }
    }
  }

  logger.debug('No Python 3.x found');
  return { available: false, version: null, path: null };
}

/**
 * Detect Python installation on Unix (macOS/Linux). Dispatches to the
 * platform-specific implementation — macOS needs special handling to avoid
 * the xcode-select install dialog.
 */
async function detectPythonUnix(
  fullPath: string
): Promise<{ available: boolean; version: string | null; path: string | null }> {
  if (process.platform === 'darwin') {
    return detectPythonDarwin(fullPath);
  }
  return detectPythonLinux(fullPath);
}

/**
 * Detect Python installation.
 * Platform-specific: Windows uses safe detection to avoid triggering Microsoft Store.
 */
async function detectPython(
  fullPath: string
): Promise<{
  available: boolean;
  version: string | null;
  path: string | null;
  windowsAliasesBlocked?: boolean;
}> {
  if (process.platform === 'win32') {
    return detectPythonWindows(fullPath);
  }
  return detectPythonUnix(fullPath);
}

/**
 * Detect uvx installation.
 * uvx is the tool that runs Python packages directly, required for Python MCPs.
 */
async function detectUvx(
  fullPath: string
): Promise<{ available: boolean; version: string | null; path: string | null }> {
  // Try uvx in PATH first
  try {
    const result = await runProbe('uvx', ['--version'], {
      env: { PATH: fullPath },
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    if (result.exitCode === 0) {
      const output = result.stdout || result.stderr;
      const version = parseVersion(output);

      // Find actual path
      let execPath: string | null = 'uvx';
      const findCmd = process.platform === 'win32' ? 'where' : 'which';
      try {
        const pathResult = await runProbe(findCmd, ['uvx'], {
          env: { PATH: fullPath },
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
          execPath = pathResult.stdout.trim().split('\n')[0].trim();
        }
      } catch {
        // Use command name as fallback
      }

      logger.debug({ version, path: execPath }, 'Found uvx');
      return { available: true, version, path: execPath };
    }
  } catch {
    // Not in PATH
  }

  // Check extra paths
  const extraPaths = getExtraPaths();
  const isWindows = process.platform === 'win32';
  const extensions = isWindows ? ['.exe', '.cmd', ''] : [''];

  for (const dir of extraPaths) {
    for (const ext of extensions) {
      const fullExePath = path.join(dir, 'uvx' + ext);
      try {
        const result = await runProbe(fullExePath, ['--version'], {
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        if (result.exitCode === 0) {
          const output = result.stdout || result.stderr;
          const version = parseVersion(output);
          logger.debug({ path: fullExePath, version }, 'Found uvx in extra path');
          return { available: true, version, path: fullExePath };
        }
      } catch {
        // Not found or not executable
      }
    }
  }

  logger.debug('uvx not found');
  return { available: false, version: null, path: null };
}

/**
 * Check Python runtime status.
 * Results are cached with tiered TTLs: 30s for positive results (Python/uvx found),
 * 10min for negative results (nothing found) to avoid expensive subprocess re-checks.
 *
 * @param forceRefresh - Skip cache and perform fresh detection
 * @returns Python and uvx availability status
 */
export async function checkPythonRuntime(
  forceRefresh = false
): Promise<PythonRuntimeStatus> {
  const now = Date.now();

  if (forceRefresh) {
    cachedMacosCltMissing = null;
  }

  // Return cached result if still valid.
  // Use longer TTL for negative results since they rarely change mid-session.
  if (!forceRefresh && cachedStatus) {
    const cacheDuration = (cachedStatus.pythonAvailable || cachedStatus.uvxAvailable)
      ? POSITIVE_CACHE_DURATION_MS
      : NEGATIVE_CACHE_DURATION_MS;
    if (now - cachedStatus.checkedAt < cacheDuration) {
      if (!(cachedStatus.pythonAvailable || cachedStatus.uvxAvailable)) {
        logger.debug('Returning cached negative Python runtime status (10min TTL)');
      } else {
        logger.debug('Returning cached Python runtime status');
      }
      return cachedStatus;
    }
  }

  logger.info('Checking Python runtime status');

  // Get shell PATH for GUI apps (fixes missing ~/.local/bin etc.)
  let fullPath: string;
  try {
    // shell-path returns the user's shell PATH, which includes user-installed tools
    // This is critical for GUI apps which may not inherit the full shell environment
    fullPath = await shellPath();
    logger.debug({ pathLength: fullPath.length }, 'Got shell PATH');
  } catch (err) {
    logger.warn({ error: err }, 'Failed to get shell PATH, using process.env.PATH');
    fullPath = process.env.PATH || '';
  }

  // Also append our extra paths to ensure we check them
  const extraPaths = getExtraPaths();
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  fullPath = [fullPath, ...extraPaths].filter(Boolean).join(pathSeparator);

  // Run both detections in parallel
  const [pythonResult, uvxResult] = await Promise.all([
    detectPython(fullPath),
    detectUvx(fullPath),
  ]);

  const status: PythonRuntimeStatus = {
    uvxAvailable: uvxResult.available,
    uvxVersion: uvxResult.version,
    uvxPath: uvxResult.path,
    pythonAvailable: pythonResult.available,
    pythonVersion: pythonResult.version,
    pythonPath: pythonResult.path,
    // Only set windowsAliasesBlocked on Windows when aliases were found
    ...(pythonResult.windowsAliasesBlocked !== undefined && {
      windowsAliasesBlocked: pythonResult.windowsAliasesBlocked,
    }),
    checkedAt: now,
  };

  // Cache result
  cachedStatus = status;

  logger.info(
    {
      uvxAvailable: status.uvxAvailable,
      uvxVersion: status.uvxVersion,
      pythonAvailable: status.pythonAvailable,
      pythonVersion: status.pythonVersion,
      windowsAliasesBlocked: status.windowsAliasesBlocked,
    },
    'Python runtime check complete'
  );

  return status;
}

/**
 * Clear the cached Python runtime status.
 * Useful when user has installed Python/uvx and wants to recheck.
 */
export function clearPythonRuntimeCache(): void {
  cachedStatus = null;
  cachedMacosCltMissing = null;
  cachedMacosCltShimResolutions = new Map();
  logger.debug('Python runtime cache cleared');
}
