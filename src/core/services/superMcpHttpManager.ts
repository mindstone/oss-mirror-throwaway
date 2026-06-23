// See docs/project/SUPERMCP_OVERVIEW.md — Intent & Design Rationale for startup reliability
import { randomUUID } from 'node:crypto';
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { getProcessSpawner, type SpawnedProcess } from '@core/processSpawner';
import { getDataPath, isPackaged, getAppRoot } from '@core/utils/dataPaths';
import { logger } from "@core/logger";
import { getErrorReporter } from "@core/errorReporter";
import { getBroadcastService } from '@core/broadcastService';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { McpLifecycleTransition, McpTransitionReason } from '@core/services/diagnostics/manifest';
import {
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON,
  SUPER_MCP_RESTART_REASON,
  SUPER_MCP_REST_ENDPOINTS,
  SUPER_MCP_SPAWN_ARGV_FIXED_VALUES,
  SUPER_MCP_SPAWN_ARGV_FLAGS,
  SUPER_MCP_SPAWN_ENV_KEYS,
  type SuperMcpRestartReason,
} from '@core/rebelCore/superMcpContract';
import { getBuildChannel } from '@core/utils/buildChannel';
import { getSettings } from '@core/services/settingsStore';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getProcessStartTimeMs } from '@core/utils/processStartTime';
import { isHeadlessCli } from '@core/utils/headlessCli';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { categorizeSafeModeError } from '@shared/safeModeErrorClassifier';
import type { SafeModeErrorCategory } from '@shared/types/safeMode';
import { type OwnerKind } from './superMcpOwnerRegistry';
import { getOwnerRegistry } from './superMcpOwnerRegistrySingleton';
import { buildOwnerTagArgs } from './superMcpOwnerTag';
import { classifyByPid, killProcessTreeIfStillIdentity } from './superMcpOwnershipClassifier';
import { GENERATED_SUPER_MCP_ROUTER_VERSION } from './superMcpVersion.generated';

// ---------------------------------------------------------------------------
// Test isolation DI — desktop wires real implementations via setTestIsolation(),
// cloud uses the safe defaults (no test isolation).
// ---------------------------------------------------------------------------
interface SuperMcpTestIsolation {
  isE2eTestMode: () => boolean;
  getSuperMcpDir: () => string | null;
}

let testIsolation: SuperMcpTestIsolation = {
  isE2eTestMode: () => false,
  getSuperMcpDir: () => null,
};

export function setTestIsolation(ti: SuperMcpTestIsolation): void {
  testIsolation = ti;
}

/**
 * Get the Rebel app icon as a base64 data URL for OAuth callback pages.
 * Uses a small 64x64 PNG for efficiency.
 * Returns null if the icon cannot be loaded.
 */
const getAppIconDataUrl = async (): Promise<string | null> => {
  try {
    const iconPath = isPackaged()
      ? path.join(process.resourcesPath, "build", "mindstone.iconset", "icon_32x32@2x.png")
      : path.join(getAppRootPath(), "build", "mindstone.iconset", "icon_32x32@2x.png");
    
    const iconBuffer = await fs.readFile(iconPath);
    return `data:image/png;base64,${iconBuffer.toString("base64")}`;
  } catch (error) {
    logger.debug({ err: error }, "Failed to load app icon for OAuth callback (non-fatal)");
    return null;
  }
};

/**
 * Get the path to the bundled Node.js binary.
 * In packaged apps, uses the bundled node-bundle.
 * In dev mode, uses the system node.
 */
const getNodeBinaryPath = (): string => {
  const isWindows = process.platform === "win32";
  if (isPackaged()) {
    return isWindows
      ? path.join(process.resourcesPath, "node-bundle", "node.exe")
      : path.join(process.resourcesPath, "node-bundle", "bin", "node");
  }
  return "node";
};

/**
 * Get the app root path safely.
 * Uses @core/utils/dataPaths which handles env-var and PlatformConfig fallbacks.
 * Falls back to process.cwd() if getAppRoot() fails.
 */
function getAppRootPath(): string {
  // getAppRoot() reads from REBEL_APP_ROOT env or PlatformConfig.appPath
  // with a fallback to process.cwd()
  const candidates = [
    getAppRoot(),
    process.cwd(),
  ].filter(Boolean) as string[];
  
  const fs = require('fs');
  for (const candidate of candidates) {
    // Check if super-mcp submodule exists at this path
    const superMcpPath = path.join(candidate, 'super-mcp', 'dist', 'cli.js');
    try {
      fs.accessSync(superMcpPath);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  
  // Return first candidate as fallback (will fail later with helpful error)
  return candidates[0] || process.cwd();
}

/**
 * Get the path to the super-mcp CLI script.
 * In packaged apps, uses the bundled super-mcp/dist/cli.js.
 * In dev mode, uses the submodule at app root.
 */
const getSuperMcpCliPath = (): string => {
  if (isPackaged()) {
    return path.join(process.resourcesPath, "super-mcp", "dist", "cli.js");
  }
  return path.join(getAppRootPath(), "super-mcp", "dist", "cli.js");
};

/**
 * Get the NODE_PATH for super-mcp to find its dependencies.
 * In packaged apps, points to app.asar.unpacked/node_modules.
 * In dev mode, points to the project's node_modules.
 */
const getNodeModulesPath = (): string => {
  if (isPackaged()) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "node_modules");
  }
  return path.join(process.cwd(), "node_modules");
};

export type SuperMcpLaunchSpec = {
  command: string;
  argsPrefix: string[];
  cwd: string;
  nodeModulesPath: string;
  source: 'env' | 'bundled' | 'npx';
};

const getPinnedSuperMcpVersion = (): string => process.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_PINNED_VERSION] || GENERATED_SUPER_MCP_ROUTER_VERSION;

export class MissingBundledSuperMcpError extends Error {
  public readonly expectedCliPath: string;

  constructor(expectedCliPath: string) {
    super(
      `Packaged Rebel is missing its bundled Super-MCP runtime at ${expectedCliPath}. ` +
        'Packaged builds cannot fall back to the npm registry; rebuild the package with super-mcp/dist included.',
    );
    this.name = 'MissingBundledSuperMcpError';
    this.expectedCliPath = expectedCliPath;
  }
}

export function isMissingBundledSuperMcpError(error: unknown): error is MissingBundledSuperMcpError {
  return error instanceof MissingBundledSuperMcpError;
}

export interface SuperMcpLaunchResolutionInput {
  env: Partial<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  bundledCliPath: string;
  nodeBinaryPath: string;
  nodeModulesPath: string;
  cwd: string;
  bundledCliExists: (cliPath: string) => boolean;
  pinnedVersion: string;
}

export const resolveSuperMcpLaunchSpecForEnvironment = (
  input: SuperMcpLaunchResolutionInput,
): SuperMcpLaunchSpec => {
  const envBin = input.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_BIN];
  const pinnedVersion =
    input.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_PINNED_VERSION] || input.pinnedVersion;
  if (envBin) {
    const resolved = path.resolve(envBin);
    if (resolved.endsWith('.js')) {
      return {
        command: input.nodeBinaryPath,
        argsPrefix: [resolved],
        cwd: path.dirname(resolved),
        nodeModulesPath: input.nodeModulesPath,
        source: 'env',
      };
    }
    return {
      command: resolved,
      argsPrefix: [],
      cwd: path.dirname(resolved),
      nodeModulesPath: input.nodeModulesPath,
      source: 'env',
    };
  }

  if (input.bundledCliExists(input.bundledCliPath)) {
    return {
      command: input.nodeBinaryPath,
      argsPrefix: [input.bundledCliPath],
      cwd: path.dirname(input.bundledCliPath),
      nodeModulesPath: input.nodeModulesPath,
      source: 'bundled',
    };
  }

  if (input.isPackaged) {
    throw new MissingBundledSuperMcpError(input.bundledCliPath);
  }

  return {
    command: input.platform === 'win32' ? 'npx.cmd' : 'npx',
    argsPrefix: ['--yes', `super-mcp-router@${pinnedVersion}`],
    cwd: input.cwd,
    nodeModulesPath: input.nodeModulesPath,
    source: 'npx',
  };
};

const resolveSuperMcpLaunchSpec = (): SuperMcpLaunchSpec => {
  return resolveSuperMcpLaunchSpecForEnvironment({
    env: process.env,
    platform: process.platform,
    isPackaged: isPackaged(),
    bundledCliPath: getSuperMcpCliPath(),
    nodeBinaryPath: getNodeBinaryPath(),
    nodeModulesPath: getNodeModulesPath(),
    cwd: process.cwd(),
    bundledCliExists: existsSync,
    pinnedVersion: getPinnedSuperMcpVersion(),
  });
};

/**
 * Get the path to the PID file for tracking Super-MCP process.
 * Stored in userData/mcp/ alongside the config file.
 * 
 * The port is included in the filename to allow multiple Mindstone instances
 * (e.g., beta app + dev app) to coexist without orphan cleanup killing each other's
 * Super-MCP processes. Each instance tracks only its own process.
 */
const getPidFilePath = (port: number): string => {
  return path.join(getDataPath(), "mcp", `super-mcp-${port}.pid`);
};

export const inferOwnerKind = (): OwnerKind => {
  if (process.env.EVAL_WORKER_INDEX !== undefined) {
    return 'eval-worker';
  }
  if (process.env.REBEL_SWEEP_CLI === '1') {
    return 'sweep-cli';
  }
  if (process.env.REBEL_EVAL_ORCHESTRATOR === '1' || process.env.REBEL_HEADLESS === '1') {
    return 'eval-orchestrator';
  }
  if (
    process.env.REBEL_SURFACE === 'cloud'
    || process.env.FLY_APP_NAME !== undefined
    || process.env.FLY_MACHINE_ID !== undefined
  ) {
    return 'cloud';
  }
  if (isHeadlessCli()) {
    return 'cli';
  }
  if (process.versions.electron === undefined) {
    return 'cli';
  }
  return 'desktop';
};

/**
 * Write the current Super-MCP process PID to a file.
 * Used for cleanup on next startup if app crashes without graceful shutdown.
 */
const writePidFile = async (pid: number, port: number): Promise<void> => {
  const pidPath = getPidFilePath(port);
  try {
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, String(pid), "utf8");
    logger.debug({ pidPath, pid, port }, "Wrote Super-MCP PID file");
  } catch (error) {
    logger.warn({ err: error, pidPath }, "Failed to write PID file (non-fatal)");
  }
};

/**
 * Delete the PID file when Super-MCP is stopped gracefully.
 */
const deletePidFile = async (port: number): Promise<void> => {
  const pidPath = getPidFilePath(port);
  try {
    await fs.unlink(pidPath);
    logger.debug({ pidPath, port }, "Deleted Super-MCP PID file");
  } catch (error) {
    // ENOENT is fine - file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug({ err: error, pidPath }, "Failed to delete PID file (non-fatal)");
    }
  }
};

/**
 * Clean up any orphaned Super-MCP processes from previous runs.
 * Called on startup before spawning a new process.
 * 
 * Only cleans up processes for the specific port to allow multiple Mindstone
 * instances to coexist (e.g., beta app on port 3100, dev app on port 3200).
 */
const cleanupOrphanedProcess = async (port: number): Promise<void> => {
  const pidPath = getPidFilePath(port);
  
  try {
    const pidContent = await fs.readFile(pidPath, "utf8");
    const pid = parseInt(pidContent.trim(), 10);
    
    if (isNaN(pid) || pid <= 0) {
      logger.debug({ pidContent }, "Invalid PID in file, removing");
      await deletePidFile(port);
      return;
    }

    const result = await classifyByPid(pid, { pidFilePath: pidPath });
    logger.debug(
      { pid, port, result, source: 'per-port-pre-spawn' },
      'Super-MCP ownership classifier decision',
    );

    if (result.decision !== 'killable') {
      return;
    }

    if (result.reason === 'pid-dead') {
      await deletePidFile(port);
      return;
    }

    const kill = await killProcessTreeIfStillIdentity(
      pid,
      result.identity.observedStartTimeMs,
      killProcessTree,
    );
    if (!kill.killed) {
      logger.warn(
        { pid, port, kill, result, source: 'per-port-pre-spawn' },
        'classifier said killable but kill aborted',
      );
      return;
    }

    // Wait for process to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 500));
    await deletePidFile(port);
  } catch (error) {
    // ENOENT is fine - no PID file exists
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug({ err: error, pidPath }, "Error checking for orphaned process (non-fatal)");
    }
  }
};

/**
 * Kill a process tree.
 * 
 * On Windows: uses taskkill /t to kill the entire tree
 * On Unix/macOS: uses process group kill (SIGKILL to -pid) as primary method
 * 
 * With detached: true, the spawned process becomes a session leader with its own
 * process group (PGID = PID). Child processes inherit this PGID, so killing -pid
 * terminates the entire tree reliably.
 */
export async function killProcessTree(pid: number): Promise<void> {
  const spawner = getProcessSpawner();

  if (process.platform === "win32") {
    // taskkill /pid <pid> /t /f
    // /t = kill process tree (all child processes)
    // /f = force kill (don't wait for graceful shutdown)
    const { error, stdout, stderr } = await spawner.exec(`taskkill /pid ${pid} /t /f`);
    if (error) {
      const code = (error as { code?: number | string }).code;
      // Error code 128 means "no process found" which is fine (already dead)
      // Error code 1 can also mean process not found on some Windows versions
      if (code === 128 || code === 1 || code === '128' || code === '1') {
        logger.debug({ pid, code }, "Process already terminated");
        return;
      }
      logger.warn({ pid, error: error.message, stderr }, "taskkill failed");
      throw error;
    }
    logger.debug({ pid, stdout: stdout.trim() }, "Process tree killed via taskkill");
    return;
  }

  // On Unix/macOS, use process group kill as the PRIMARY method.
  // With detached: true, the child calls setsid() and becomes a session leader
  // with PGID = its own PID. Child processes inherit this PGID.
  // Sending SIGKILL to -pid kills all processes in that process group.

  // Step 1: Try process group kill (most reliable for detached processes)
  const killedGroup = spawner.kill(-pid, "SIGKILL");
  if (killedGroup) {
    logger.debug({ pid }, "Sent SIGKILL to process group");
  } else {
    logger.debug({ pid }, "Process group kill failed or process already exited; trying fallbacks");
  }

  // Step 2: Fallback - also try pkill and direct kill in case process group kill missed anything
  // This handles edge cases like processes that escaped the group.
  await spawner.exec(`pkill -KILL -P ${pid} 2>/dev/null`);
  spawner.kill(pid, "SIGKILL");
}

/**
 * Super-MCP HTTP Server Manager
 *
 * Manages the lifecycle of a Super-MCP router running in HTTP mode.
 * This enables concurrent tool usage across multiple agent sessions without
 * the stdio transport race conditions documented in:
 * https://github.com/anthropics/claude-agent-sdk-typescript/issues/41
 */

export interface SuperMcpHttpConfig {
  enabled: boolean;
  port: number;
  configPath: string;
  startupTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export interface SuperMcpHttpManagerState {
  process: SpawnedProcess | null;
  isRunning: boolean;
  port: number;
  url: string;
  startTime: number | null;
  lastHealthCheck: number | null;
}

const isPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();

    tester.once("error", (error: NodeJS.ErrnoException) => {
      tester.close();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        logger.debug(
          { port, errorCode: error.code },
          "Port unavailable (already in use or access denied)",
        );
        resolve(false);
        return;
      }
      reject(error);
    });

    tester.once("listening", () => {
      tester.close(() => {
        logger.debug({ port }, "Port available");
        resolve(true);
      });
    });

    // Listen on localhost only (127.0.0.1) to avoid triggering Windows Firewall prompts.
    // Binding to 0.0.0.0 would detect IPv6-only listeners but causes Windows to prompt
    // for network access permission on every app update. Since Super-MCP only binds to
    // 127.0.0.1 anyway, this is sufficient for our port collision detection needs.
    // See: docs/plans/finished/260115_windows_firewall_prompt_fix.md
    tester.listen(port, "127.0.0.1");
  });
};

/**
 * Wait for a port to become available after stopping a process.
 * Uses polling instead of fixed delays to handle variable process cleanup times.
 * 
 * @param port - The port to check
 * @param options.timeoutMs - Maximum time to wait (default: 5000ms)
 * @param options.pollMs - Interval between checks (default: 100ms)
 * @returns true if port became available, false if timeout
 */
export const waitForPortRelease = async (
  port: number,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> => {
  const { timeoutMs = 5000, pollMs = 100 } = options;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (await isPortAvailable(port)) {
      logger.debug(
        { port, elapsedMs: Date.now() - startTime },
        "Port released and available"
      );
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  
  logger.warn(
    { port, timeoutMs },
    "Port not released within timeout"
  );
  return false;
};

/**
 * Scan the port range for orphaned Super-MCP processes and kill them.
 *
 * Called automatically by findAvailablePort when all ports in the range are
 * exhausted. Uses OS tools (lsof on macOS/Linux, netstat on Windows) to
 * discover processes listening on the port range, verifies they are
 * super-mcp via command-line inspection, and kills the orphaned ones.
 *
 * This handles the case where the app crashed without cleaning up its
 * spawned Super-MCP process, and the PID file was lost or never written.
 */
const cleanupOrphanedProcessesInRange = async (
  baselinePort: number,
  range: number,
): Promise<number> => {
  let killed = 0;
  let protectedCount = 0;
  let killableCount = 0;
  let unknownCount = 0;
  const endPort = baselinePort + range - 1;

  // Phase 1: PID-file cleanup — scan all super-mcp-*.pid files for orphans in our range
  try {
    const mcpDir = path.join(getDataPath(), "mcp");
    const entries = await fs.readdir(mcpDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const match = entry.match(/^super-mcp-(\d+)\.pid$/);
      if (!match) continue;
      const port = parseInt(match[1], 10);
      if (port < baselinePort || port > endPort) continue;
      const pidFilePath = path.join(mcpDir, entry);
      try {
        const pidContent = await fs.readFile(pidFilePath, "utf8");
        const pid = parseInt(pidContent.trim(), 10);
        if (isNaN(pid) || pid <= 0) {
          await deletePidFile(port);
          continue;
        }

        const result = await classifyByPid(pid, { pidFilePath });
        logger.debug(
          { pid, port, result, source: 'pid-file-scan' },
          'Super-MCP ownership classifier decision',
        );

        if (result.decision === 'protected') {
          protectedCount += 1;
          continue;
        }
        if (result.decision === 'unknown') {
          unknownCount += 1;
          continue;
        }

        killableCount += 1;

        if (result.reason === 'pid-dead') {
          await deletePidFile(port);
          continue;
        }

        const kill = await killProcessTreeIfStillIdentity(
          pid,
          result.identity.observedStartTimeMs,
          killProcessTree,
        );
        if (!kill.killed) {
          logger.warn(
            { pid, port, kill, result, source: 'pid-file-scan' },
            'classifier said killable but kill aborted',
          );
          continue;
        }

        killed += 1;
        await deletePidFile(port);
      } catch {
        // Ignore per-file errors
      }
    }
  } catch (err) {
    logger.debug({ err }, "PID-file scan failed (non-fatal)");
  }

  // Phase 2: OS-level port scan — catch orphans that have no PID file
  try {
    const pidsOnRange = await discoverListeningPids(baselinePort, endPort);
    for (const pid of pidsOnRange) {
      const result = await classifyByPid(pid);
      logger.debug(
        { pid, result, source: 'port-scan' },
        'Super-MCP ownership classifier decision',
      );

      if (result.decision === 'protected') {
        protectedCount += 1;
        continue;
      }
      if (result.decision === 'unknown') {
        unknownCount += 1;
        continue;
      }

      killableCount += 1;
      if (result.reason === 'pid-dead') {
        continue;
      }

      const kill = await killProcessTreeIfStillIdentity(
        pid,
        result.identity.observedStartTimeMs,
        killProcessTree,
      );
      if (!kill.killed) {
        logger.warn(
          { pid, kill, result, source: 'port-scan' },
          'classifier said killable but kill aborted',
        );
        continue;
      }

      killed += 1;
    }
  } catch (err) {
    logger.debug({ err }, "Port-scan orphan detection failed (non-fatal)");
  }

  logger.info(
    {
      baselinePort,
      endPort,
      scannedPorts: range,
      protectedCount,
      killableCount,
      unknownCount,
      killedCount: killed,
    },
    'Super-MCP orphan cleanup classification summary',
  );

  return killed;
};

/**
 * Discover PIDs of processes listening on a TCP port range.
 * Uses lsof on macOS/Linux and netstat on Windows.
 */
export async function discoverListeningPids(startPort: number, endPort: number): Promise<number[]> {
  const spawner = getProcessSpawner();

  if (process.platform === "win32") {
    const { stdout } = await spawner.exec("netstat -ano -p TCP");
    if (!stdout) return [];
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      const m = line.match(/LISTENING\s+(\d+)\s*$/);
      if (!m) continue;
      const portMatch = line.match(/:(\d+)\s/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (port >= startPort && port <= endPort) pids.add(parseInt(m[1], 10));
    }
    return [...pids];
  }

  const { stdout } = await spawner.exec(`lsof -iTCP:${startPort}-${endPort} -sTCP:LISTEN -t 2>/dev/null`);
  if (!stdout) return [];
  const pids = stdout
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  return [...new Set(pids)];
}

const scanForAvailablePort = async (
  baseline: number,
  maxAttempts: number,
): Promise<{ port: number; conflicted: boolean } | null> => {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = baseline + offset;
    const available = await isPortAvailable(candidate);
    if (available) {
      const conflicted = candidate !== baseline;
      logger.info(
        {
          selectedPort: candidate,
          preferredPort: baseline,
          conflicted,
        },
        conflicted
          ? "Port conflict detected, using alternative port"
          : "Using preferred port",
      );
      return { port: candidate, conflicted };
    }
  }
  return null;
};

export const findAvailablePort = async (
  preferredPort: number,
  maxAttempts = 20,
): Promise<{ port: number; conflicted: boolean }> => {
  const baseline =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 3000;

  // First pass: normal scan
  const result = await scanForAvailablePort(baseline, maxAttempts);
  if (result) return result;

  // All ports occupied — attempt orphan cleanup and retry once
  logger.warn(
    { baseline, maxAttempts },
    "All ports in range occupied, scanning for orphaned Super-MCP processes",
  );
  const killed = await cleanupOrphanedProcessesInRange(baseline, maxAttempts);

  if (killed > 0) {
    // Wait briefly for OS to release the ports
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const retryResult = await scanForAvailablePort(baseline, maxAttempts);
    if (retryResult) return retryResult;
  }

  logger.error(
    { baseline, maxAttempts, orphansKilled: killed },
    "Unable to find available port after orphan cleanup",
  );
  throw new Error(
    `Unable to find available port starting at ${baseline}. Checked ${maxAttempts} candidates.`,
  );
};

/**
 * Create a clean environment for npm/npx spawning.
 *
 * Removes bundled git paths from PATH to prevent npm from scanning
 * the git-bundle directory structure. On Linux, npm fails with ENOENT
 * if it tries to lstat git-bundle/lib which doesn't exist in dugite-native
 * (dugite-native only includes bin/, libexec/, share/, ssl/, etc/).
 *
 * This fix is applied to all platforms defensively, but is specifically
 * required on Linux where npm's directory scanning behavior causes failures.
 */
const createNpmSafeEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };

  if (env.PATH && isPackaged() && process.resourcesPath) {
    const gitBundlePath = path.join(process.resourcesPath, "git-bundle");
    const originalPaths = env.PATH.split(path.delimiter);
    const filteredPaths = originalPaths.filter(
      (p) => !p.startsWith(gitBundlePath),
    );

    if (filteredPaths.length < originalPaths.length) {
      env.PATH = filteredPaths.join(path.delimiter);
      logger.debug(
        {
          removedPaths: originalPaths.filter((p) =>
            p.startsWith(gitBundlePath),
          ),
        },
        "Removed git-bundle from PATH for npm spawn",
      );
    }
  }

  // Scrub REBEL_WORKSPACE_PATH so callers must set it explicitly.
  // Without this, a stale value from the parent process leaks through.
  delete env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_WORKSPACE_PATH];
  // Don't forward parent heap flags to child MCP processes.
  delete env.NODE_OPTIONS;

  return env;
};

/**
 * Get the default Super-MCP HTTP port based on the build channel.
 * This prevents port conflicts when running multiple app versions simultaneously.
 *
 * Canonical location — moved here from systemHealthService.ts because
 * port selection is intrinsic to Super-MCP lifecycle management.
 */
export function getDefaultSuperMcpPort(): number {
  // Check environment variable override first
  const envPort = process.env[SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_HTTP_PORT];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Use centralized channel detection utility (returns 'dev' for unpackaged builds)
  const channel = getBuildChannel();
  if (channel === 'dev') {
    return 3200;
  }
  if (channel === 'beta') {
    return 3100;
  }

  // Production/stable (default)
  return 3000;
}

/**
 * Phase classification for a single Super-MCP startup attempt's failure.
 *
 * Used by `SuperMcpStartResult.attemptErrors` to give consumers (eval bootstrap,
 * lazy-recovery diagnostics) enough context to distinguish a port-finder
 * exhaustion ("nothing was free") from a configure() failure ("invalid router
 * config") from a spawn-or-health-check failure ("subprocess died" /
 * "health check timed out").
 */
export type SuperMcpStartupAttemptPhase = 'port-finder' | 'configure' | 'spawn-or-health-check' | 'unknown';

/**
 * Per-attempt failure record captured during `startWithRetries()` retries.
 *
 * Only the `error` message is captured (not the underlying `Error` object) so
 * the array stays serialisation-safe across any future cross-process boundary.
 * `lastErrorObj` on `SuperMcpStartResult` carries the most recent thrown value.
 */
export interface SuperMcpStartupAttemptError {
  attempt: number;
  phase: SuperMcpStartupAttemptPhase;
  error: string;
}

export interface SuperMcpStartupAttemptSummary {
  attempt: number;
  phase: SuperMcpStartupAttemptPhase;
  category: SafeModeErrorCategory;
}

/**
 * Result of a Super-MCP startup attempt with retries.
 */
export interface SuperMcpStartResult {
  success: boolean;
  port?: number;
  error?: string;
  attempts: number;
  /** Sentry event ID if failure was captured (for support reference) */
  sentryEventId?: string;
  /** MCP servers that were skipped due to validation errors (only on success) */
  skippedServers?: SkippedServer[];
  /**
   * Alias for `error`: the `.message` of the most recent attempt's thrown
   * value. Kept alongside `error` to give consumers a less ambiguous field
   * name when reading diagnostics; `error` remains for backward compatibility.
   */
  lastError?: string;
  /**
   * The actual thrown value from the most recent attempt (typically an
   * `Error` instance — `unknown`-typed because a thrower may throw any value).
   * Consumers must narrow before reading `.code` / `.stack` / etc.
   */
  lastErrorObj?: unknown;
  /** Privacy-safe category for the final startup failure. Present on failure. */
  failureCategory?: SafeModeErrorCategory;
  /**
   * Per-attempt failure trail across the retry loop. Empty / undefined on
   * success. Consumers (eval bootstrap, diagnostics) can read this to surface
   * "spawn failed all 4 attempts" vs "first 2 failed port-finder, last 2
   * failed health-check" without source-patching the manager.
   */
  attemptErrors?: ReadonlyArray<SuperMcpStartupAttemptError>;
  /** Privacy-safe per-attempt category trail. Empty / undefined on success. */
  attemptSummary?: ReadonlyArray<SuperMcpStartupAttemptSummary>;
}

/**
 * Represents an MCP server that was skipped during Super-MCP startup due to validation errors.
 * Matches the SkippedPackage type from super-mcp/src/types.ts
 */
/**
 * Typed error thrown by startWithRetries() when the circuit breaker is active.
 * Consumers should check `instanceof CircuitBreakerError` instead of string matching.
 */
export class CircuitBreakerError extends Error {
  public readonly remainingMs: number;
  public readonly lastError: string | null;

  constructor(message: string, remainingMs: number, lastError: string | null) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.remainingMs = remainingMs;
    this.lastError = lastError;
  }
}

export interface SkippedServer {
  id: string;
  reason: string;
}

/**
 * Typed event map for `SuperMcpHttpManager.subprocessEvents`.
 *
 * - `spawned` fires once per successful subprocess spawn with the child PID.
 * - `exited`  fires once when the child process exits, mirroring the
 *   `ChildProcess` `exit` event (`code` + `signal`) plus the PID for
 *   correlation by subscribers that need to unregister.
 *
 * Listeners are owned by the subscriber (e.g., `superMcpTelemetryAdapter`).
 * `SuperMcpHttpManager` must NOT call `removeAllListeners()` on this emitter
 * from its `dispose`-style paths — subscribers manage their own listeners.
 *
 * Stage 4a of `docs/plans/260423_secondary_process_cpu_observability.md`.
 */
export type SuperMcpSubprocessEvents = {
  spawned: [{ pid: number; at: number }];
  exited: [{ pid: number; at: number; code: number | null; signal: NodeJS.Signals | null }];
};

export interface SuperMcpRecoverySuccessEvent {
  port: number;
  attempts: number;
  context: 'background-recovery' | 'lazy-recovery';
}

/**
 * Stable attribution string for the cause of the most recent restart. Populated
 * at each restart call site (`debouncedRestart`, `scheduleRestartWhenIdle`,
 * `reconfigure`, `ensureRunningAfterResume`, circuit-breaker cooldown expiry in
 * `startWithRetries`). Cleared on a clean `stop()` (not a stop that is part of a
 * restart sequence).
 *
 * This type is intentionally narrow — each value maps to an actual in-manager
 * restart site. New restart sites should add a new value in
 * `superMcpContract.ts` rather than reuse an existing one (prevents silent
 * misattribution).
 *
 * - `'debounced-workspace-change'` — `debouncedRestart()` fired after the
 *   debounce quiet window elapsed (settings / workspace-config change).
 * - `'idle-restart'` — `scheduleRestartWhenIdle()` executed a restart (either
 *   immediately because no turns were active, or via the drain callback /
 *   30-minute ceiling timer after turns drained).
 * - `'reconfigure'` — `reconfigure()` was called (MCP config path change).
 * - `'post-resume'` — `ensureRunningAfterResume()` detected an unhealthy
 *   subprocess after the OS fired `powerMonitor.resume`.
 * - `'circuit-breaker-reset'` — `startWithRetries()` observed the 60s
 *   cooldown had expired and is retrying a previously failed startup.
 *
 * Intentionally NOT present (surfaced in Stage 2 planning but no code path
 * exists today): `'spawn-exit'` / `'spawn-error'`. The child-process exit /
 * error handlers in the manager merely mark state dead + emit lifecycle
 * events; they do NOT auto-restart. An external subscriber would attribute
 * that flavour of restart via one of the trigger sites above.
 */
export type { SuperMcpRestartReason } from '@core/rebelCore/superMcpContract';

/**
 * Lifecycle + identity snapshot exposed by `SuperMcpHttpManager.getSubprocessInfo()`.
 *
 * This is the core-safe (pure-data) surface the perf diagnostic reads on every
 * tick to (a) synthesise a `super-mcp` row in `processes[]` and (b) expose
 * circuit-breaker / restart-count state so `isRunning: false` is distinguishable
 * from "super-mcp died and is in cooldown".
 *
 * Subprocess CPU / RSS sampling is intentionally NOT on this interface —
 * that's deferred to a Stage 4a follow-up (see plan §Stage 4a). When the
 * sampler lands it will be exposed via a separate accessor; the diagnostic
 * carries a `subprocessCpu: null` placeholder today.
 */
export interface SuperMcpSubprocessInfo {
  /** OS PID of the running subprocess (null when not running). */
  pid: number | null;
  /** ms epoch of most recent successful spawn; null when never started. */
  startTime: number | null;
  /** ms since `startTime`; null when not running. */
  uptime: number | null;
  /** Whether the subprocess is currently considered running by the manager. */
  isRunning: boolean;
  /** Successful-spawn counter (cumulative for this manager instance). */
  startCount: number;
  /** Completed `restart()` counter (cumulative for this manager instance). */
  restartCount: number;
  /** ms epoch of most recent all-retries-exhausted failure; null when none. */
  lastStartupFailureAt: number | null;
  /** Human-readable last-startup error; null when never failed / after reset. */
  lastStartupError: string | null;
  /** Circuit breaker cooldown currently active. */
  circuitBreakerActive: boolean;
  /** ms remaining on the cooldown when active; null otherwise. */
  cooldownRemainingMs: number | null;
  /**
   * Stable attribution string for the cause of the most recent restart — see
   * {@link SuperMcpRestartReason}. `null` on first start and after a clean stop
   * that wasn't part of a restart sequence. Preserved across the stop→start of
   * a restart so the value documents the last restart cause until the NEXT
   * restart (or a clean stop) overwrites it.
   *
   * Stage 2 of `docs/plans/260424_observability_followups.md`.
   */
  lastRestartReason: SuperMcpRestartReason | null;
}

/**
 * Status of the most recent `SuperMcpHttpManager.fetchStats()` call.
 *
 * - `ok`         — 2xx response parsed successfully into `payload`.
 * - `error`      — non-2xx response (e.g. 500); `httpStatus` is populated.
 * - `timeout`    — the 2s bounded fetch aborted before a response.
 * - `unsupported`— 404 (older super-mcp builds without the /stats route).
 *
 * Stage 4b of `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * Note: this enum describes only outcomes of the in-process fetch. Consumer-
 * side emission types may extend it with additional codes (`'unavailable'`
 * when the manager isn't running, `'stale'` when a previously-good snapshot
 * is served after the manager stopped — see
 * `perfDiagnosticService.SuperMcpChildStatsEmission`).
 */
export type SuperMcpStatsStatus = 'ok' | 'error' | 'timeout' | 'unsupported';

const immediateSuperMcpLifecycleBrand: unique symbol = Symbol('ImmediateSuperMcpLifecycleAuth');

type ImmediateSuperMcpLifecycleAuth = {
  readonly [immediateSuperMcpLifecycleBrand]: true;
  readonly reason: 'app-shutdown' | 'headless-cleanup';
};

function createImmediateSuperMcpLifecycleAuth(
  reason: ImmediateSuperMcpLifecycleAuth['reason'],
): ImmediateSuperMcpLifecycleAuth {
  return { [immediateSuperMcpLifecycleBrand]: true, reason };
}

export interface SuperMcpConfigRestartRequest {
  configPath: string;
  context: string;
  afterRestart?: () => void;
  onRestartError?: (error: unknown) => void;
  /**
   * Fire-once, fire-now deferral signal for THIS request: invoked synchronously
   * when the scheduler decides not to run the restart immediately (fresh defer
   * behind active turns, or coalescing into an already-pending restart). Lets
   * callers resolve user-facing work promptly instead of awaiting a restart
   * that may be deferred up to RESTART_DEFERRAL_CEILING_MS (see
   * `reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral` in mcpService).
   * Never invoked on the idle path, and never re-invoked when the deferred
   * work eventually executes.
   */
  onRestartDeferred?: (info: { activeTurns: number }) => void;
}

export type ImmediateConfigReloadReason =
  | 'chat-package-materialization'
  | 'chat-oauth-connect-ready';

export interface ImmediateConfigReloadRequest extends SuperMcpConfigRestartRequest {
  reason: ImmediateConfigReloadReason;
}

type PendingRestartWork = {
  context: string;
  restartReason: SuperMcpRestartReason;
  execute: () => Promise<void>;
  afterRestartCallbacks: Array<() => void>;
  onRestartErrorCallbacks: Array<(error: unknown) => void>;
  resolveCallbacks: Array<() => void>;
  rejectCallbacks: Array<(error: unknown) => void>;
  /**
   * Deliberately a single callback, NOT a merged array like the completion
   * callbacks above: deferral is a fire-once, fire-now signal consumed at the
   * local request's own deferral site (fresh-defer or coalesce branch in
   * `scheduleRestartWhenIdleWork`). It is dropped by `mergePendingRestartWork`
   * so the merged pending work can never re-fire it.
   */
  onRestartDeferred?: (info: { activeTurns: number }) => void;
};

/**
 * Cache-backed snapshot of the most recent `/stats` fetch.
 *
 * Single canonical shape regardless of status — downstream (perf diagnostic)
 * emits this verbatim so every `Memory diagnostic` line includes
 * `superMcpChildStats` with an explicit `status` (per the plan's
 * fail-observable contract — never silently omitted).
 *
 * `payload` is typed `unknown` to avoid coupling this core-side manager to
 * super-mcp's `/stats` response shape. The perf diagnostic consumer treats
 * it as an opaque blob forwarded to logs.
 */
export interface SuperMcpStatsSnapshot {
  status: SuperMcpStatsStatus;
  /** ms epoch when this snapshot was recorded. */
  at: number;
  /** Raw /stats JSON when `status === 'ok'`. Absent otherwise. */
  payload?: unknown;
  /** HTTP status code when `status === 'error'`. */
  httpStatus?: number;
  /** Human-readable failure message for `status === 'timeout' | 'error'`. */
  lastErr?: string;
}

export class SuperMcpHttpManager {
  private config: SuperMcpHttpConfig | null = null;
  private state: SuperMcpHttpManagerState = {
    process: null,
    isRunning: false,
    port: 0,
    url: "",
    startTime: null,
    lastHealthCheck: null,
  };
  private activeOwnerId: string | null = null;
  private isRecovering = false;
  /**
   * MCP servers that were skipped during the last startup due to validation errors.
   * Populated via HTTP fetch from Super-MCP's /api/skipped-servers endpoint after startup.
   */
  private skippedServers: SkippedServer[] = [];
  /**
   * Promise that resolves when an in-progress startup completes.
   * Used to make start() idempotent - concurrent callers wait for the same startup
   * rather than racing to spawn multiple processes.
   */
  private startPromise: Promise<void> | null = null;
  /**
   * Promise that resolves when an in-progress restart (stop+start) completes.
   * Concurrent restart() calls wait for the current one instead of racing.
   */
  private restartPromise: Promise<void> | null = null;
  /**
   * Optional hook executed synchronously before each Super-MCP subprocess spawn.
   * Used by cloud bootstrap to update router config env values just-in-time.
   */
  private preRestartHook: (() => void | Promise<void>) | null = null;
  /**
   * Timer handle for the restart debounce window.
   * Rapid-fire restart requests within RESTART_DEBOUNCE_MS collapse into one.
   */
  private restartDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Debounce window (ms) for restart(). Multiple calls within this window
   * collapse into a single restart at the end of the quiet period.
   */
  private static readonly RESTART_DEBOUNCE_MS = 3000;

  // ---------------------------------------------------------------------------
  // Deferred restart — config-change callers use
  // requestRestartForConfigChangeDetached() (or the execution-awaiting
  // ...AndAwaitExecution opt-in) to avoid killing Super-MCP mid-turn.
  // ---------------------------------------------------------------------------

  /**
   * True when a restart has been scheduled but not yet executed (waiting for turns to drain).
   * Multiple scheduleRestartWhenIdle() calls while pending coalesce into one restart.
   */
  private pendingRestart = false;
  private pendingRestartWork: PendingRestartWork | null = null;
  /**
   * Safety ceiling timer — forces restart after RESTART_DEFERRAL_CEILING_MS even
   * if active turns haven't drained.
   */
  private deferralCeilingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Maximum deferral time (ms) before forcing a restart.
   * 30 minutes — aligned with the watchdog tool-in-flight auto-abort ceiling
   * (`watchdogTracker.AUTO_ABORT_MS`). Stage 4 of the LLM-judge plan may extend
   * a single turn past 30 min via the judge; if that becomes common, this
   * ceiling should grow to a higher sentinel or be made extension-aware.
   * See `docs/plans/260508_watchdog_llm_judge_extension.md`.
   */
  private static readonly RESTART_DEFERRAL_CEILING_MS = 30 * 60 * 1000;

  /**
   * Timestamp of last successful health check or tool call.
   * Used to short-circuit health checks when Super-MCP was recently confirmed healthy.
   * If lastHealthyAt is recent (<30s), we trust isRunning state instead of re-checking.
   */
  private lastHealthyAt: number | null = null;
  /**
   * Promise that resolves when an in-progress health check completes.
   * Prevents duplicate concurrent health checks - callers wait for the same check
   * rather than each triggering their own TCP connection.
   */
  private healthCheckPromise: Promise<boolean> | null = null;
  /**
   * Maximum age (ms) of lastHealthyAt before we re-check health.
   * If Super-MCP was healthy within this window, skip the TCP probe.
   */
  private static readonly HEALTH_TRUST_WINDOW_MS = 30000;

  // ---------------------------------------------------------------------------
  // Circuit breaker — prevents repeated doomed startup attempts (REBEL-S2)
  // When all retries fail, we set a 120s cooldown to avoid 30s-blocked agent
  // turns and the 15k Sentry event amplification pattern.
  // ---------------------------------------------------------------------------

  /**
   * Cooldown period (ms) after all startup retries are exhausted.
   * During this window, startWithRetries() throws immediately instead of
   * blocking for up to 30s on a doomed startup attempt.
   */
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 120_000;

  /**
   * Background recovery kicks in after an all-retries-exhausted startup failure.
   * It waits for the circuit-breaker window first, then retries every minute
   * up to five times without creating additional Sentry events per agent turn.
   */
  private static readonly BACKGROUND_RECOVERY_INTERVAL_MS = 60_000;
  private static readonly BACKGROUND_RECOVERY_MAX_ATTEMPTS = 5;

  /** Timestamp of the most recent all-retries-exhausted failure */
  private lastStartupFailureAt: number | null = null;

  /** Human-readable error from the last failed startup attempt */
  private lastStartupError: string | null = null;

  /**
   * Promise that resolves when an in-progress startWithRetries() completes.
   * Prevents concurrent callers from racing through port selection/retry loops.
   */
  private startWithRetriesPromise: Promise<SuperMcpStartResult> | null = null;
  private backgroundRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundRecoveryAttempts = 0;
  private backgroundRecoveryConfigPath: string | null = null;
  private readonly recoverySuccessListeners = new Set<(event: SuperMcpRecoverySuccessEvent) => void>();

  // ---------------------------------------------------------------------------
  // Stage 4a lifecycle observability — `docs/plans/260423_secondary_process_cpu_observability.md`
  // ---------------------------------------------------------------------------

  /** Successful-spawn counter, incremented in `doStart()` on spawn success. */
  private startCount = 0;

  /** Completed `restart()` counter, incremented after each successful stop+start. */
  private restartCount = 0;

  /**
   * Consecutive startup-failure counter. Increments on each spawn-error /
   * health-check-timeout / process-exit-during-startup. Resets to 0 on the
   * next successful connect transition. Mirrors the manifest field
   * `mcp_transition.data.consecutiveFailures`.
   */
  private consecutiveStartupFailures = 0;

  /**
   * Emit a single Super-MCP lifecycle transition into the diagnostic events
   * ledger. Stage 1a: singleton manager only — no `serverIdHash` yet. Per
   * Stage 1a A8, `reason` is OMITTED (not coerced) when null.
   */
  private emitMcpTransition(
    transition: McpLifecycleTransition,
    reason?: McpTransitionReason,
  ): void {
    const data: {
      transition: McpLifecycleTransition;
      reason?: McpTransitionReason;
      restartCount: number;
      consecutiveFailures: number;
    } = {
      transition,
      restartCount: this.restartCount,
      consecutiveFailures: this.consecutiveStartupFailures,
    };
    if (reason) data.reason = reason;
    appendDiagnosticEvent({ kind: 'mcp_transition', data });
  }

  /**
   * Stage 2 of `docs/plans/260424_observability_followups.md`. Attribution for
   * the most recent restart; set at each restart call site, cleared on clean
   * `stop()`. See {@link SuperMcpRestartReason}.
   */
  private lastRestartReason: SuperMcpRestartReason | null = null;

  /**
   * Stage 2 (260424): set to `true` while a restart sequence (doRestart /
   * reconfigure) is holding the subprocess stopped between stop() and start().
   * Read by `stop()` to decide whether to clear `lastRestartReason` — we only
   * clear on a truly clean stop, never mid-restart.
   *
   * Not the same as `restartPromise`: `restartPromise` is for caller-level
   * serialization (public restart() calls coalesce); `isStopForRestart` is a
   * lower-level guard that also covers `reconfigure()` (which bypasses
   * `doRestart` entirely).
   */
  private isStopForRestart = false;

  /**
   * Guards against double-emission of `subprocessEvents.exited` for a single
   * child-process lifetime. Node's `ChildProcess` can fire both `'error'` and
   * `'exit'` for one process (rare but documented for spawn-time failures).
   * Without this flag, adapters that subscribe to `exited` would
   * register-then-double-unregister a PID — or, worse, attempt to unregister
   * a PID that's already been reused by the OS. Set `false` after every
   * successful spawn in `doStart()`; set `true` the first time `exited` is
   * emitted (from either handler). Stage 4a M2 refinement.
   */
  private exitEmittedForCurrentProcess = false;

  /**
   * Typed event emitter for subprocess lifecycle. Fires `spawned` after a
   * successful spawn and `exited` when the child process exits. See
   * `SuperMcpSubprocessEvents` for the payload shape.
   *
   * Subscribers (e.g., `superMcpTelemetryAdapter`) own their listeners; this
   * manager never calls `removeAllListeners()` on this emitter.
   */
  // ── Stage 4b /stats polling cache — `docs/plans/260423_secondary_process_cpu_observability.md`
  //
  // `fetchStats()` is fire-and-forget from the perf diagnostic tick. The
  // most recent result lives in `lastStatsCache`; the perf diagnostic reads
  // it synchronously via `getLastStatsCache()`. `lastStatsFetchAt` tracks
  // when the fetch COMPLETED (success, failure, or abort) so consumers can
  // compute `stats_age_ms` independently of the embedded `at`.

  /** Most recent /stats snapshot, or null when fetchStats has never been invoked. */
  private lastStatsCache: SuperMcpStatsSnapshot | null = null;
  /** ms epoch when `fetchStats()` last completed. */
  private lastStatsFetchAt: number | null = null;
  /**
   * ms epoch when the most recent `fetchStats()` with `status: 'ok'`
   * completed. Stage 4b M5 refinement — lets operators tell a fresh
   * `'ok'` from a stale `'ok'` followed by silent failures. Invalidated
   * alongside `lastStatsCache` whenever the subprocess exits
   * (`invalidateStatsCache()`).
   */
  private lastGoodStatsAt: number | null = null;
  /**
   * Status of the most recent `fetchStats()` call; used to emit one log
   * entry per state transition (not per tick). Stage 4b M4 refinement —
   * transient 404/500/timeout/network-error failures must be observable
   * in logs (fail-observable contract).
   */
  private lastStatsStatus: SuperMcpStatsStatus | null = null;
  /**
   * Monotonic counter bumped on every `invalidateStatsCache()`. A running
   * `fetchStats()` captures this at start and refuses to write results
   * belonging to a stale subprocess lifetime — protects against an
   * in-flight fetch resolving AFTER the child exited and repopulating
   * the cache with dead-process data. Stage 4b iter-2 safety refinement.
   */
  private statsGeneration = 0;
  /** Bounded /stats timeout. Keep conservative — diagnostic must never block on us. */
  private static readonly STATS_FETCH_TIMEOUT_MS = 2_000;

  /**
   * Reset all `/stats`-related cache on subprocess exit so the next
   * diagnostic tick doesn't emit PIDs / connected flags from the DEAD
   * process. Called inline at each `subprocessEvents.emit('exited', ...)`
   * site. Stage 4b M1 refinement.
   *
   * Also resets `lastStatsStatus` — without that, a restart could cause
   * the first post-restart poll to be treated as a status change (and
   * spuriously log "recovered") even though the subprocess is different.
   *
   * Bumping `statsGeneration` is what makes the invalidation robust
   * against a concurrent in-flight `fetchStats()` awaiting the network.
   */
  private invalidateStatsCache(): void {
    this.lastStatsCache = null;
    this.lastStatsFetchAt = null;
    this.lastGoodStatsAt = null;
    this.lastStatsStatus = null;
    this.statsGeneration += 1;
  }

  public readonly subprocessEvents = new EventEmitter() as EventEmitter & {
    on<K extends keyof SuperMcpSubprocessEvents>(
      event: K,
      listener: (...args: SuperMcpSubprocessEvents[K]) => void,
    ): EventEmitter;
    off<K extends keyof SuperMcpSubprocessEvents>(
      event: K,
      listener: (...args: SuperMcpSubprocessEvents[K]) => void,
    ): EventEmitter;
    emit<K extends keyof SuperMcpSubprocessEvents>(
      event: K,
      ...args: SuperMcpSubprocessEvents[K]
    ): boolean;
  };

  /**
   * Initialize HTTP server manager with configuration
   */
  public configure(config: SuperMcpHttpConfig): void {
    this.config = config;
    this.state.port = config.port;
    this.state.url = `http://127.0.0.1:${config.port}/mcp`;

    logger.info(
      {
        port: config.port,
        configPath: config.configPath,
        startupTimeout: config.startupTimeoutMs,
        healthCheckInterval: config.healthCheckIntervalMs,
      },
      "Super-MCP HTTP manager configured",
    );
  }

  /**
   * Register a single pre-restart hook that runs immediately before each
   * subprocess spawn attempt.
   */
  public setPreRestartHook(fn: () => void | Promise<void>): void {
    this.preRestartHook = fn;
  }

  /**
   * Clear the circuit breaker, allowing the next startWithRetries() call to proceed.
   * Call this when the user explicitly requests a restart (Diagnostics UI, config change)
   * or when conditions have materially changed (resume from sleep, reconfigure).
   */
  public resetCircuitBreaker(): void {
    if (this.lastStartupFailureAt !== null) {
      logger.info(
        { lastFailureAt: this.lastStartupFailureAt, lastError: this.lastStartupError },
        "Circuit breaker reset — next startWithRetries() will attempt startup",
      );
    }
    this.lastStartupFailureAt = null;
    this.lastStartupError = null;
  }

  public onRecoverySuccess(listener: (event: SuperMcpRecoverySuccessEvent) => void): () => void {
    this.recoverySuccessListeners.add(listener);
    return () => {
      this.recoverySuccessListeners.delete(listener);
    };
  }

  private emitRecoverySuccess(event: SuperMcpRecoverySuccessEvent): void {
    for (const listener of this.recoverySuccessListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err, event }, 'Super-MCP recovery success listener failed');
      }
    }
  }

  private getCircuitBreakerRemainingMs(): number {
    if (this.lastStartupFailureAt === null) {
      return 0;
    }
    const elapsed = Date.now() - this.lastStartupFailureAt;
    return Math.max(SuperMcpHttpManager.CIRCUIT_BREAKER_COOLDOWN_MS - elapsed, 0);
  }

  private clearBackgroundRecovery(): void {
    if (this.backgroundRecoveryTimer) {
      clearTimeout(this.backgroundRecoveryTimer);
      this.backgroundRecoveryTimer = null;
    }
    this.backgroundRecoveryAttempts = 0;
    this.backgroundRecoveryConfigPath = null;
  }

  private scheduleBackgroundRecovery(configPath: string, context: string): void {
    if (this.state.isRunning) {
      this.clearBackgroundRecovery();
      return;
    }

    this.backgroundRecoveryConfigPath = configPath;

    if (this.backgroundRecoveryTimer) {
      return;
    }

    if (this.backgroundRecoveryAttempts >= SuperMcpHttpManager.BACKGROUND_RECOVERY_MAX_ATTEMPTS) {
      logger.warn(
        { attempts: this.backgroundRecoveryAttempts, context },
        'Super-MCP background recovery exhausted',
      );
      return;
    }

    const delayMs = Math.max(
      SuperMcpHttpManager.BACKGROUND_RECOVERY_INTERVAL_MS,
      this.getCircuitBreakerRemainingMs(),
    );

    this.backgroundRecoveryTimer = setTimeout(() => {
      this.backgroundRecoveryTimer = null;
      const recoveryConfigPath = this.backgroundRecoveryConfigPath;
      if (!recoveryConfigPath || this.state.isRunning) {
        this.clearBackgroundRecovery();
        return;
      }

      this.backgroundRecoveryAttempts += 1;
      const attempt = this.backgroundRecoveryAttempts;
      void this.startWithRetries(recoveryConfigPath, {
        logContext: 'background-recovery',
      }).then((result) => {
        if (result.success) {
          logger.info(
            { attempt, attempts: result.attempts, port: result.port },
            'Super-MCP background recovery succeeded',
          );
          this.clearBackgroundRecovery();
        } else {
          logger.warn(
            { attempt, attempts: result.attempts, error: result.error },
            'Super-MCP background recovery attempt failed',
          );
        }
      }).catch((err) => {
        logger.warn({ err, attempt }, 'Super-MCP background recovery deferred by circuit breaker');
        this.scheduleBackgroundRecovery(recoveryConfigPath, 'background-recovery');
      });
    }, delayMs);
    this.backgroundRecoveryTimer.unref?.();

    logger.info(
      {
        delayMs,
        nextAttempt: this.backgroundRecoveryAttempts + 1,
        maxAttempts: SuperMcpHttpManager.BACKGROUND_RECOVERY_MAX_ATTEMPTS,
        context,
      },
      'Super-MCP background recovery scheduled',
    );
  }

  /**
   * Get the path to the spawn diagnostics log file.
   * This file captures child process stdout/stderr via inherited file descriptors,
   * preserving `detached: true` + `unref()` semantics (no stream pipes).
   * Truncated on each spawn ('w' mode) so it stays bounded.
   *
   * @see docs/plans/260327_supermcp_startup_reliability.md (Stage 2)
   */
  private getSpawnLogPath(): string {
    return path.join(getDataPath(), 'logs', 'super-mcp-spawn.log');
  }

  /**
   * Read the last 4KB of the spawn log file for diagnostic context.
   * Returns empty string if the file doesn't exist or can't be read.
   */
  private async readSpawnLogTail(): Promise<string> {
    try {
      const logContent = await fs.readFile(this.getSpawnLogPath(), 'utf-8');
      return logContent.slice(-4096);
    } catch {
      return '';
    }
  }

  private async unregisterOwner(ownerId: string, reason: string): Promise<void> {
    if (this.activeOwnerId === ownerId) {
      this.activeOwnerId = null;
    }

    try {
      await getOwnerRegistry().unregister(ownerId);
    } catch (error) {
      logger.debug(
        { err: error, ownerId, reason },
        'Failed to unregister super-mcp owner record (non-fatal)',
      );
    }
  }

  private async unregisterActiveOwner(reason: string): Promise<void> {
    const ownerId = this.activeOwnerId;
    if (!ownerId) {
      return;
    }

    await this.unregisterOwner(ownerId, reason);
  }

  /**
   * Start Super-MCP with retry logic, port reselection, and circuit breaker.
   *
   * This is the **robust startup path** that all recovery callers should use.
   * It wraps the low-level `start()` with:
   * - Port reselection via `findAvailablePort()` on each attempt
   * - 4 attempts with delays [0, 5000, 10000, 20000] ms
   * - Circuit breaker: after all retries fail, blocks for 120s to prevent the
   *   15k-event Sentry amplification pattern (REBEL-S2)
   * - Serialization: concurrent callers coalesce into a single attempt
   * - Sentry capture: only for startup contexts (not manual restarts)
   *
   * **Do NOT use raw `start()` for recovery paths** — it lacks port reselection,
   * retry delays, and the circuit breaker. Raw `start()` is the low-level
   * primitive used internally by this method.
   *
   * @see docs/plans/260327_supermcp_startup_reliability.md (REBEL-SG / REBEL-S2)
   */
  public async startWithRetries(
    configPath: string,
    options?: {
      /** Logging context for diagnostics (e.g. 'startup', 'lazy-recovery') */
      logContext?: string;
      /** Bypass the circuit breaker (e.g. for user-initiated restarts, config changes) */
      force?: boolean;
      /** Test seam: production schedules background recovery after exhausted retries. */
      scheduleBackgroundRecovery?: boolean;
      /** Preferred HTTP port for this owner/process. Defaults to the build-channel port. */
      preferredPort?: number;
      /** Number of candidate ports to scan. Defaults to 25. */
      portRange?: number;
      /** Startup health-check timeout. Defaults to 30 seconds. */
      startupTimeoutMs?: number;
    },
  ): Promise<SuperMcpStartResult> {
    const context = options?.logContext ?? 'startup';
    const force = options?.force ?? false;
    const scheduleBackgroundRecovery = options?.scheduleBackgroundRecovery ?? true;
    let isCircuitBreakerRecoveryAttempt = false;

    // Circuit breaker: if startup recently failed and this isn't a forced attempt,
    // fail immediately instead of blocking for up to 30s on a doomed startup.
    if (!force && this.lastStartupFailureAt !== null) {
      const elapsed = Date.now() - this.lastStartupFailureAt;
      const remaining = SuperMcpHttpManager.CIRCUIT_BREAKER_COOLDOWN_MS - elapsed;
      if (remaining > 0) {
        const msg =
          `Super-MCP startup circuit breaker active — last failure ${Math.round(elapsed / 1000)}s ago, ` +
          `next retry in ${Math.round(remaining / 1000)}s. Last error: ${this.lastStartupError ?? 'unknown'}`;
        logger.warn({ context, remainingMs: remaining, lastError: this.lastStartupError }, msg);
        this.emitMcpTransition('error', SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.CIRCUIT_BREAKER_ACTIVE);
        throw new CircuitBreakerError(msg, remaining, this.lastStartupError);
      }
      // Cooldown expired — allow the attempt and clear stale state.
      // Stage 2 (260424): attribute the forthcoming startup attempt to the
      // circuit-breaker reset. `force: true` callers (reconfigure / post-resume)
      // deliberately bypass this branch — they retain their own attribution.
      isCircuitBreakerRecoveryAttempt = true;
      this.lastRestartReason = SUPER_MCP_RESTART_REASON.CIRCUIT_BREAKER_RESET;
      this.resetCircuitBreaker();
    }

    // Serialization: if a startWithRetries is already in progress, coalesce
    if (this.startWithRetriesPromise) {
      logger.debug({ context }, "startWithRetries already in progress, waiting for completion");
      return this.startWithRetriesPromise;
    }

    const shouldEmitRecoverySuccess =
      context === 'background-recovery' ||
      (context === 'lazy-recovery' && isCircuitBreakerRecoveryAttempt);

    this.startWithRetriesPromise = this.doStartWithRetries(
      configPath,
      context,
      scheduleBackgroundRecovery,
      shouldEmitRecoverySuccess,
      {
        preferredPort: options?.preferredPort,
        portRange: options?.portRange,
        startupTimeoutMs: options?.startupTimeoutMs,
      },
    );

    try {
      return await this.startWithRetriesPromise;
    } finally {
      this.startWithRetriesPromise = null;
    }
  }

  /**
   * Internal implementation of the retry loop for startWithRetries().
   */
  private async doStartWithRetries(
    configPath: string,
    context: string,
    scheduleBackgroundRecovery: boolean,
    shouldEmitRecoverySuccess: boolean,
    portOptions?: {
      preferredPort?: number;
      portRange?: number;
      startupTimeoutMs?: number;
    },
  ): Promise<SuperMcpStartResult> {
    const preferredPort = portOptions?.preferredPort ?? getDefaultSuperMcpPort();
    const portRange = portOptions?.portRange ?? 25;
    const startupTimeoutMs = portOptions?.startupTimeoutMs ?? 30000;
    const retryDelays = [0, 5000, 10000, 20000];
    let lastError = '';
    let lastErrorObj: unknown = null;
    let attemptCount = 0;
    const attemptErrors: SuperMcpStartupAttemptError[] = [];
    const attemptSummary: SuperMcpStartupAttemptSummary[] = [];
    let nonRetryableStartupError = false;

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      attemptCount = attempt + 1;

      if (retryDelays[attempt] > 0) {
        const prev = attemptErrors[attemptErrors.length - 1];
        logger.info(
          {
            attempt: attemptCount,
            delayMs: retryDelays[attempt],
            context,
            previousError: prev?.error,
            previousPhase: prev?.phase,
          },
          'Retrying Super-MCP startup after previous attempt failed',
        );
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }

      if (this.state.isRunning) {
        logger.info({ context }, 'Super-MCP already running, skipping startup');
        return { success: true, port: this.state.port, attempts: attemptCount };
      }

      let phase: SuperMcpStartupAttemptPhase = 'unknown';
      try {
        phase = 'port-finder';
        const { port: httpPort, conflicted } = await findAvailablePort(preferredPort, portRange);

        if (conflicted) {
          logger.warn(
            { preferredPort, selectedPort: httpPort, context },
            'Preferred Super-MCP port unavailable',
          );
        }

        phase = 'configure';
        this.configure({
          enabled: true,
          port: httpPort,
          configPath,
          startupTimeoutMs,
          // 200ms startup polling — reduces artificial delay detecting readiness
          healthCheckIntervalMs: 200,
        });

        phase = 'spawn-or-health-check';
        await this.start();
        logger.info({ port: httpPort, attempt: attemptCount, context }, 'Super-MCP started successfully');

        // Clear circuit breaker on success
        this.resetCircuitBreaker();
        this.clearBackgroundRecovery();

        const skippedServers = this.getSkippedServers();
        if (shouldEmitRecoverySuccess && (context === 'background-recovery' || context === 'lazy-recovery')) {
          this.emitRecoverySuccess({
            port: httpPort,
            attempts: attemptCount,
            context,
          });
        }

        return {
          success: true,
          port: httpPort,
          attempts: attemptCount,
          skippedServers: skippedServers.length > 0 ? skippedServers : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        lastErrorObj = error;
        const category = categorizeSafeModeError(error, phase);
        attemptErrors.push({ attempt: attemptCount, phase, error: lastError });
        attemptSummary.push({ attempt: attemptCount, phase, category });

        logger.warn(
          { err: error, attempt: attemptCount, maxAttempts: retryDelays.length, context, phase, category },
          'Super-MCP startup attempt failed',
        );

        if (isMissingBundledSuperMcpError(error)) {
          nonRetryableStartupError = true;
          logger.error(
            { err: error, attempt: attemptCount, context, phase },
            'Super-MCP bundled runtime missing in packaged build; skipping retry cycle',
          );
          break;
        }
      }
    }

    // All retries exhausted — engage circuit breaker
    this.lastStartupFailureAt = Date.now();
    this.lastStartupError = lastError;
    this.consecutiveStartupFailures += 1;
    const finalAttempt = attemptSummary[attemptSummary.length - 1];
    const failureCategory = finalAttempt?.category ?? categorizeSafeModeError(lastErrorObj ?? lastError, finalAttempt?.phase);

    logger.error(
      { context, attempts: attemptCount, lastError, failureCategory },
      'All Super-MCP startup attempts failed — circuit breaker engaged',
    );

    // A8: emit error with health-check-timeout reason — startup attempts
    // failed waitForServerReady() polling. Spawn-error is emitted at the
    // doStart() catch site below for the spawn-time failure mode.
    this.emitMcpTransition('error', SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.HEALTH_CHECK_TIMEOUT);

    // Capture to Sentry for observability — only for startup-related contexts
    // (not for manual restarts which are user-initiated)
    const isStartupContext = ['startup', 'preflight', 'app-ready'].includes(context);
    if (isStartupContext && lastErrorObj) {
      getErrorReporter().captureException(lastErrorObj, {
        tags: { area: 'startup', component: 'super-mcp', startup_context: context, failureCategory },
        extra: { attempts: attemptCount, lastError, failureCategory, attemptSummary },
      });
    }

    if (scheduleBackgroundRecovery && !nonRetryableStartupError) {
      this.scheduleBackgroundRecovery(configPath, context);
    }

    return {
      success: false,
      error: lastError,
      attempts: attemptCount,
      lastError,
      lastErrorObj,
      failureCategory,
      attemptErrors,
      attemptSummary,
    };
  }

  /**
   * Start the Super-MCP HTTP server process
   *
   * This method is idempotent - concurrent calls will wait for the same startup
   * rather than racing to spawn multiple processes. This prevents:
   * - Multiple processes being spawned simultaneously
   * - Process handle overwriting (this.state.process)
   * - Exit handlers attached to wrong processes
   * - cleanupOrphanedProcess killing a concurrent caller's newly spawned process
   *
   * @deprecated External callers must NOT call `start()` directly — go through
   * {@link startSuperMcpWithRetries} (or the instance `startWithRetries`), the
   * single retry-aware startup path. Raw `start()` skips the retry loop,
   * circuit breaker, port reselection, and background-recovery wiring; routing
   * every entry point through the wrapper is the invariant that closed the
   * 251209 cache-corruption partial-wiring postmortem. This method stays public
   * only because the wrapper and internal restart machinery call it; the
   * `check-supermcp-single-startup-path` validate:fast gate enforces that no
   * external `src/main`/`src/core` call site bypasses the wrapper.
   */
  public async start(): Promise<void> {
    if (!this.config) {
      throw new Error("Super-MCP HTTP manager not configured");
    }

    if (this.state.isRunning) {
      logger.debug("Super-MCP HTTP server already running");
      return;
    }

    // If a startup is already in progress, wait for it rather than starting another
    if (this.startPromise) {
      logger.debug("Super-MCP startup already in progress, waiting for completion");
      return this.startPromise;
    }

    // Create startup promise and store it so concurrent callers can wait
    this.startPromise = this.doStart();
    
    try {
      await this.startPromise;
    } finally {
      // Clear the promise once startup completes (success or failure)
      this.startPromise = null;
    }
  }

  /**
   * Internal startup implementation - called only by start() with concurrency guard
   */
  private async doStart(): Promise<void> {
    if (!this.config) {
      throw new Error("Super-MCP HTTP manager not configured");
    }

    const configuredPort = this.config.port;
    const configuredConfigPath = this.config.configPath;

    // Clean up any orphaned processes from previous crashed runs (for this port only)
    await cleanupOrphanedProcess(configuredPort);

    logger.info(
      { port: configuredPort, configPath: configuredConfigPath },
      "Starting Super-MCP HTTP server",
    );

    try {
      // Spawn Super-MCP router in HTTP mode
      // Uses bundled super-mcp submodule for faster startup and offline support
      const isWindows = process.platform === "win32";
      
      const launchSpec = resolveSuperMcpLaunchSpec();
      const nodeModulesPath = launchSpec.nodeModulesPath;

      const ownerRegistry = getOwnerRegistry();
      const ownerId = randomUUID();
      const ownerPid = process.pid;
      const ownerKind = inferOwnerKind();
      const ownerStartTimeMs = await getProcessStartTimeMs(ownerPid);
      const ownerTagArgs = ownerStartTimeMs !== null
        ? buildOwnerTagArgs({
            ownerId,
            ownerPid,
            ownerStartTimeMs,
          })
        : [];
      if (ownerStartTimeMs === null) {
        logger.debug(
          { ownerId, ownerPid },
          'owner-tag args omitted: getProcessStartTimeMs returned null',
        );
      }

      await ownerRegistry.register({
        ownerId,
        ownerKind,
        ownerPid,
        ownerStartTimeMs,
        childPid: null,
        childStartTimeMs: null,
        childPort: configuredPort,
        spawnedAt: Date.now(),
      });
      ownerRegistry.startHeartbeatTimer(ownerId);
      this.activeOwnerId = ownerId;

      const args = [
        ...launchSpec.argsPrefix,
        SUPER_MCP_SPAWN_ARGV_FLAGS.TRANSPORT,
        SUPER_MCP_SPAWN_ARGV_FIXED_VALUES.TRANSPORT_HTTP,
        SUPER_MCP_SPAWN_ARGV_FLAGS.PORT,
        String(configuredPort),
        SUPER_MCP_SPAWN_ARGV_FLAGS.CONFIG,
        configuredConfigPath,
        ...ownerTagArgs,
      ];

      if (this.preRestartHook) {
        await this.preRestartHook();
      }

      // Load Rebel branding for OAuth callback pages
      const iconDataUrl = await getAppIconDataUrl();

      logger.debug(
        { command: launchSpec.command, args, nodeModulesPath, source: launchSpec.source, hasIcon: !!iconDataUrl },
        "Spawning Super-MCP router process (bundled)",
      );

      // On Unix, use detached: true so the child gets its own process group,
      // allowing process.kill(-pid) to kill the entire tree
      // 
      // IMPORTANT: Set cwd to the super-mcp dist directory to prevent Node.js from
      // finding node_modules in parent directories (which happens when running from
      // the development `out/` directory). This ensures only NODE_PATH is used.
      //
      // ATTACHED MODE: Spawn Super-MCP as an attached child process (detached: false)
      // so it terminates automatically when the parent process exits. Enabled for:
      //   - E2E tests (REBEL_E2E_TEST_MODE=1): prevents orphans on Electron close
      //   - Headless evals (REBEL_HEADLESS=1): prevents orphans when eval workers
      //     are killed before cleanupEval() runs
      // See docs/plans/partway/260126_e2e_test_architecture_overhaul.md
      const isTestMode = process.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_E2E_TEST_MODE] === "1"
        || process.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_HEADLESS] === "1";
      const superMcpDir = launchSpec.cwd;

      // Capture child stdout/stderr to a log file via inherited file descriptors.
      // File-descriptor inheritance preserves `detached: true` + `unref()` semantics —
      // no stream pipes that could prevent clean process detachment.
      // The 'w' mode truncates the file on each spawn (bounded, no accumulation).
      // @see docs/plans/260327_supermcp_startup_reliability.md (Stage 2)
      const spawnLogPath = this.getSpawnLogPath();
      await fs.mkdir(path.dirname(spawnLogPath), { recursive: true });

      let logFd: number | undefined;
      try {
        logFd = openSync(spawnLogPath, 'w');
        const fd = logFd;
        const processSpawner = getProcessSpawner();
        const proc = processSpawner.spawn(launchSpec.command, args, {
          stdio: ['ignore', fd, fd],
          detached: !isWindows && !isTestMode, // Stay attached in test mode
          windowsHide: true,
          cwd: superMcpDir,
          env: {
            ...createNpmSafeEnv(),
            [SUPER_MCP_SPAWN_ENV_KEYS.NODE_ENV]: "production",
            [SUPER_MCP_SPAWN_ENV_KEYS.NODE_PATH]: nodeModulesPath,
            // Branding for OAuth callback pages shown when authenticating MCP servers
            [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_APP_NAME]: "Rebel",
            [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_PRIMARY_COLOR]: "#8b5cf6",
            [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_ICON_TEXT]: "R",
            ...(iconDataUrl && { [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_ICON_URL]: iconDataUrl }),
            // Literal key (not the contract constant): evals/__tests__/eval-workspace-path.test.ts
            // textually asserts `REBEL_WORKSPACE_PATH: getSettings().coreDirectory || ''` here.
            REBEL_WORKSPACE_PATH: getSettings().coreDirectory || '',
            // E2E test isolation: redirect Super-MCP data dir + HOME to prevent
            // writes to real ~/.super-mcp/ (logs, OAuth tokens, config).
            // Also override HOME/USERPROFILE so MCP SDK's StdioClientTransport
            // child processes don't inherit real HOME.
            // Note: REBEL_TEST_USER_DATA_DIR is always a resolved absolute path
            // by the time testIsolation.isE2eTestMode() returns true (ensureTestUserData.ts
            // resolves 'auto' to a real temp dir before setting the env var).
            ...(testIsolation.isE2eTestMode() && {
              [SUPER_MCP_SPAWN_ENV_KEYS.SUPER_MCP_DATA_DIR]: testIsolation.getSuperMcpDir() ?? undefined,
              [SUPER_MCP_SPAWN_ENV_KEYS.HOME]: process.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_TEST_USER_DATA_DIR],
              [SUPER_MCP_SPAWN_ENV_KEYS.USERPROFILE]: process.env[SUPER_MCP_SPAWN_ENV_KEYS.REBEL_TEST_USER_DATA_DIR],
            }),
          },
        });
        this.state.process = proc;
      } catch (e) {
        // FD leak protection: clean up the file descriptor if spawn fails
        if (logFd !== undefined) closeSync(logFd);
        throw e;
      }
      // Parent closes its copy of the FD — child inherited its own at fork time
      if (logFd !== undefined) closeSync(logFd);

      // On Unix with detached: true, call unref() so Electron doesn't wait for
      // the child process during shutdown. This prevents hung quits.
      // In test mode, we WANT Electron to wait for and terminate the child on exit.
      const proc = this.state.process;
      if (!proc) throw new Error('Super-MCP process failed to spawn');
      if (!isWindows && !isTestMode) {
        proc.unref();
      }

      if (typeof proc.pid === 'number') {
        const childPid = proc.pid;
        fireAndForget((async () => {
          const childStartTimeMs = await getProcessStartTimeMs(childPid);
          await ownerRegistry.attachChild(
            ownerId,
            childPid,
            configuredPort,
            childStartTimeMs,
          ).catch((err) => {
            logger.debug(
              { err, ownerId, childPid },
              'attachChild failed for super-mcp owner record',
            );
          });
        })(), 'superMcpHttpManager.attachChildOwnerRecord');
      }

      this.state.startTime = Date.now();
      this.skippedServers = []; // Reset for new startup

      // Stage 4a: increment successful-spawn counter and emit lifecycle event
      // BEFORE the ready-wait so telemetry subscribers can register the PID
      // even if the server fails its health check (and exits shortly after).
      this.startCount += 1;
      // Reset the one-shot exit-emission guard for this new child's lifetime.
      this.exitEmittedForCurrentProcess = false;
      if (proc.pid !== undefined) {
        this.subprocessEvents.emit('spawned', { pid: proc.pid, at: this.state.startTime });
      }

      // Handle process exit
      proc.on("exit", (code, signal) => {
        const exitedPid = proc.pid ?? null;
        const exitedAt = Date.now();
        logger.warn(
          {
            code,
            signal,
            uptime: this.state.startTime
              ? exitedAt - this.state.startTime
              : 0,
          },
          "Super-MCP HTTP server process exited",
        );
        this.state.isRunning = false;
        this.state.process = null;

        // Stage 4a: emit exit event so telemetry subscribers can unregister
        // the PID from the named-PID registry. Guard against double-emit:
        // Node may fire both `error` and `exit` for the same child lifetime;
        // the adapter must not re-unregister an already-unregistered PID.
        if (exitedPid !== null && !this.exitEmittedForCurrentProcess) {
          this.exitEmittedForCurrentProcess = true;
          this.subprocessEvents.emit('exited', {
            pid: exitedPid,
            at: exitedAt,
            code,
            signal,
          });
          // Stage 4b M1: invalidate the /stats cache now that the
          // subprocess is dead — stale PIDs / connected flags must not
          // surface on the next diagnostic tick.
          this.invalidateStatsCache();
        }

        fireAndForget(this.unregisterOwner(ownerId, 'child-exit'), 'superMcpHttpManager.unregisterOwner.childExit');
      });

      // Handle process errors
      proc.on("error", (error) => {
        logger.warn({ err: error, ownerId }, 'super-mcp child error');
        ownerRegistry.stopHeartbeatTimer(ownerId);
        if (this.activeOwnerId === ownerId) {
          this.activeOwnerId = null;
        }
        fireAndForget(ownerRegistry.unregister(ownerId), 'superMcpHttpManager.ownerRegistry.unregisterOnError');

        const pid = this.state.process?.pid ?? proc.pid ?? null;

        // Stage 4a M2: emit `exited` BEFORE clearing state so telemetry
        // subscribers can unregister this PID. Otherwise the named-PID
        // registry accumulates a stale entry when the child errors without
        // ever firing `exit` (e.g. ENOENT / EACCES at spawn time).
        // Double-emit guard: if `exit` has already fired for this child, skip.
        if (pid !== null && !this.exitEmittedForCurrentProcess) {
          this.exitEmittedForCurrentProcess = true;
          this.subprocessEvents.emit('exited', {
            pid,
            at: Date.now(),
            code: null,
            signal: null,
          });
          // Stage 4b M1: invalidate /stats cache on error-only exit path.
          this.invalidateStatsCache();
        }
        this.state.isRunning = false;
        this.state.process = null;

        // Read spawn log for diagnostic context, then capture to Sentry.
        // readSpawnLogTail() never rejects (catches internally), so .then() always fires.
        const nodeError = error as NodeJS.ErrnoException;
        fireAndForget(this.readSpawnLogTail().then((spawnLogTail) => {
          getErrorReporter().captureException(error, {
            tags: {
              area: 'super-mcp',
              component: 'superMcpHttpManager',
              error_code: String(nodeError.code ?? 'unknown'),
            },
            extra: {
              port: this.state.port,
              uptime: this.state.startTime ? Date.now() - this.state.startTime : null,
              errorCode: nodeError.code,
              errorErrno: nodeError.errno,
              errorSyscall: nodeError.syscall,
              pid,
              ...(spawnLogTail && { spawnLogTail }),
            },
          });
        }), 'superMcpHttpManager.captureSpawnError');
      });

      // Wait for server to be ready with health checks
      await this.waitForServerReady();

      this.state.isRunning = true;
      this.consecutiveStartupFailures = 0;

      // Write PID file for orphan cleanup on next startup if we crash
      if (this.state.process?.pid) {
        await writePidFile(this.state.process.pid, configuredPort);
      }

      // Fetch skipped-server data from HTTP endpoint (replaces old stderr parsing)
      await this.fetchSkippedServers();

      const startupDurationMs = Date.now() - this.state.startTime;
      logger.info(
        {
          port: configuredPort,
          url: this.state.url,
          startupTime: startupDurationMs,
        },
        "Super-MCP HTTP server started successfully",
      );

      // A8: emit connect transition. If a restart sequence brought us here,
      // the lastRestartReason is preserved as the connect's `reason` (e.g.
      // 'reconfigure', 'circuit-breaker-reset', 'idle-restart').
      this.emitMcpTransition('connect', this.lastRestartReason ?? undefined);

      // Record performance metric for diagnostic bundle
      import('./perfAccumulator').then(({ recordSpawn }) => {
        recordSpawn(startupDurationMs, 'super-mcp');
      }).catch(() => { /* ignore import errors */ });
    } catch (error) {
      logger.error({ err: error }, "Failed to start Super-MCP HTTP server");
      this.consecutiveStartupFailures += 1;
      // A8: emit error with spawn-error reason. The downstream
      // doStartWithRetries() may also emit `health-check-timeout` once all
      // retries are exhausted — these are distinct phases of the same
      // failure scenario and the bundle reader can dedupe by `ts`.
      this.emitMcpTransition('error', SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.SPAWN_ERROR);
      await this.stopNow();
      throw error;
    }
  }

  /**
   * Wait for Super-MCP HTTP server to be ready by polling health endpoint
   */
  private async waitForServerReady(): Promise<void> {
    if (!this.config) {
      throw new Error("Configuration not set");
    }

    const startTime = Date.now();
    const timeout = this.config.startupTimeoutMs;
    const interval = this.config.healthCheckIntervalMs;

    logger.debug(
      { timeout, interval, url: this.state.url },
      "Starting Super-MCP health check polling",
    );

    let attemptCount = 0;

    while (Date.now() - startTime < timeout) {
      attemptCount++;

      try {
        const isHealthy = await this.checkHealth();
        if (isHealthy) {
          logger.info(
            {
              attemptCount,
              elapsedMs: Date.now() - startTime,
            },
            "Super-MCP HTTP server health check passed",
          );
          return;
        }
      } catch (error) {
        // Expected during startup, log at debug level
        logger.debug(
          {
            err: error,
            attemptCount,
            elapsedMs: Date.now() - startTime,
          },
          "Super-MCP health check attempt failed (retrying)",
        );
      }

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, interval));

      // Check if process died
      if (!this.state.process || this.state.process.killed) {
        const spawnLogTail = await this.readSpawnLogTail();
        throw new Error(
          "Super-MCP process died during startup" +
          (spawnLogTail ? `\nChild process output (last 4KB):\n${spawnLogTail}` : '\nNo child process output captured.')
        );
      }
    }

    // Timeout — include spawn log tail for diagnostics
    const spawnLogTail = await this.readSpawnLogTail();
    throw new Error(
      `Super-MCP HTTP server failed to start within ${timeout}ms (${attemptCount} attempts)` +
      (spawnLogTail ? `\nChild process output (last 4KB):\n${spawnLogTail}` : '\nNo child process output captured.')
    );
  }

  /**
   * Check if Super-MCP HTTP server is healthy
   *
   * Uses TCP socket connection test instead of HTTP GET to avoid protocol issues.
   * Super-MCP listens on /mcp endpoint but may not respond to root HTTP requests.
   * A successful TCP connection indicates the server is ready.
   * 
   * Optimizations:
   * - Short-circuits if lastHealthyAt is within HEALTH_TRUST_WINDOW_MS (30s)
   * - Coalesces concurrent calls to prevent duplicate TCP connections
   */
  public async checkHealth(): Promise<boolean> {
    // Fast path: if Super-MCP was recently healthy, trust isRunning state
    // This avoids redundant TCP probes during normal operation
    if (this.state.isRunning && this.lastHealthyAt !== null) {
      const ageMs = Date.now() - this.lastHealthyAt;
      if (ageMs < SuperMcpHttpManager.HEALTH_TRUST_WINDOW_MS) {
        logger.trace(
          { ageMs, trustWindowMs: SuperMcpHttpManager.HEALTH_TRUST_WINDOW_MS },
          "Super-MCP health check short-circuited (recently healthy)"
        );
        return true;
      }
    }

    // Coalesce concurrent health checks - all callers wait for the same probe
    if (this.healthCheckPromise !== null) {
      logger.trace("Super-MCP health check already in progress, waiting for result");
      return this.healthCheckPromise;
    }

    // Create and store the health check promise
    this.healthCheckPromise = this.doHealthCheck();

    try {
      return await this.healthCheckPromise;
    } finally {
      // Clear the promise once check completes (success or failure)
      this.healthCheckPromise = null;
    }
  }

  /**
   * Internal health check implementation - performs the actual TCP probe.
   * Called only by checkHealth() with concurrency guard.
   */
  private doHealthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      // Flag to prevent multiple promise resolutions (critical for cleanup)
      let resolved = false;

      // Create socket for TCP connection test
      const socket = new net.Socket();

      /**
       * Cleanup function - ensures socket is destroyed and promise resolves once
       * Called from all event handlers to guarantee resource cleanup
       */
      const cleanup = (isHealthy: boolean, reason: string) => {
        if (resolved) {
          // Already resolved, skip to prevent multiple resolutions
          return;
        }

        resolved = true;

        // Destroy socket to free resources
        socket.destroy();

        // Update health check timestamps
        if (isHealthy) {
          this.state.lastHealthCheck = Date.now();
          this.lastHealthyAt = Date.now();
        }

        logger.trace(
          {
            isHealthy,
            reason,
            port: this.state.port,
          },
          "Super-MCP health check result",
        );

        resolve(isHealthy);
      };

      // Set timeout (must be done BEFORE connect)
      socket.setTimeout(2000);

      // Success: TCP connection established = server is listening
      socket.on("connect", () => {
        cleanup(true, "TCP connection successful");
      });

      // Error: Connection refused, network error, etc.
      socket.on("error", (error) => {
        logger.trace(
          {
            err: error,
            port: this.state.port,
          },
          "Super-MCP health check connection error",
        );
        cleanup(false, `Connection error: ${error.message}`);
      });

      // Timeout: Server didn't respond in time
      socket.on("timeout", () => {
        cleanup(false, "Connection timeout after 2000ms");
      });

      // Use 127.0.0.1 (not "localhost") to avoid DNS/IPv6 latency on Windows — matches server bind address
      socket.connect(this.state.port, "127.0.0.1");
    });
  }

  /**
   * Mark Super-MCP as healthy (called after successful tool calls).
   * This allows downstream code to signal health without triggering a full probe.
   */
  public markHealthy(): void {
    if (this.state.isRunning) {
      this.lastHealthyAt = Date.now();
      logger.trace("Super-MCP marked as healthy by external caller");
    }
  }

  /**
   * Stop the Super-MCP HTTP server gracefully
   * 
   * Uses process tree kill to ensure all child processes are terminated.
   * On Windows, uses taskkill /t. On Unix, uses process group kill.
   */
  public async stop(auth: ImmediateSuperMcpLifecycleAuth): Promise<void> {
    void auth;
    await this.stopNow();
  }

  private async stopNow(): Promise<void> {
    if (!this.state.process) {
      logger.debug("No Super-MCP HTTP server process to stop");
      await this.unregisterActiveOwner('manager-stop-no-process');
      // Stage 2 (260424): a truly clean stop (no process, not mid-restart)
      // still clears the attribution — documents "shut cleanly".
      if (!this.isStopForRestart) {
        this.lastRestartReason = null;
      }
      return;
    }

    const pid = this.state.process.pid;
    logger.info(
      {
        pid,
        uptime: this.state.startTime ? Date.now() - this.state.startTime : 0,
      },
      "Stopping Super-MCP HTTP server",
    );

    const portToRelease = this.state.port;
    
    try {
      if (pid) {
        // Use tree kill to terminate the entire process tree
        await killProcessTree(pid);
      } else {
        // Fallback: try SIGTERM if no PID (shouldn't happen)
        this.state.process.kill("SIGTERM");
      }

      // Wait for port to be released instead of fixed delay
      // This handles variable process cleanup times (especially on Windows)
      if (portToRelease > 0) {
        const released = await waitForPortRelease(portToRelease, { timeoutMs: 5000, pollMs: 100 });
        if (!released) {
          logger.warn(
            { port: portToRelease },
            "Port not released after 5s timeout, continuing anyway (findAvailablePort will select alternative)"
          );
        }
      }

      logger.info("Super-MCP HTTP server stopped");
    } catch (error) {
      logger.error({ err: error }, "Error stopping Super-MCP HTTP server");
      
      // Last resort: try SIGKILL directly on the process
      try {
        if (this.state.process && !this.state.process.killed) {
          this.state.process.kill("SIGKILL");
        }
      } catch {
        // Ignore - process might already be dead
      }
    } finally {
      this.state.process = null;
      this.state.isRunning = false;
      this.state.startTime = null;
      // Reset health tracking and diagnostic state - Super-MCP is no longer running
      this.lastHealthyAt = null;
      this.skippedServers = [];
      // Stage 2 (260424): clear last-restart attribution on a clean shutdown
      // (i.e. `stop()` called outside of a restart sequence). `doRestart()` /
      // `reconfigure()` set `isStopForRestart = true` around their stop() call
      // so the attribution survives the stop and documents the following
      // restart. Clean shutdowns (gracefulShutdown, test teardown, eval
      // cleanup) have `isStopForRestart === false` and correctly null it out.
      if (!this.isStopForRestart) {
        this.lastRestartReason = null;
        // A8: emit disconnect transition for clean shutdowns only. Stops
        // that are part of a restart sequence (isStopForRestart=true) are
        // covered by the subsequent connect emit with the restart reason.
        this.emitMcpTransition('disconnect');
      }
      // Clean up PID file on graceful shutdown
      if (portToRelease) {
        await deletePidFile(portToRelease);
      }
      await this.unregisterActiveOwner('manager-stop');
    }
  }

  /**
   * Restart Super-MCP with serialization.
   * If a restart is already in progress, waits for it to finish and then
   * performs another restart (in case the caller's config change was after
   * the in-progress restart started). Safe to call concurrently.
   */
  public async restart(auth: ImmediateSuperMcpLifecycleAuth): Promise<void> {
    void auth;
    await this.restartNow();
  }

  private async restartNow(): Promise<void> {
    if (!this.config) {
      throw new Error("Super-MCP HTTP manager not configured");
    }

    // If a restart is already in progress, wait for it then restart again
    // (the caller's change may have happened after the in-progress restart started)
    if (this.restartPromise) {
      logger.debug("Super-MCP restart already in progress, queuing behind it");
      try {
        await this.restartPromise;
      } catch {
        // Ignore errors from the previous restart — we'll try our own
      }
    }

    // Create a new restart promise and store it for concurrent callers
    this.restartPromise = this.doRestart();
    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }

  /**
   * Internal restart implementation — performs stop() then start().
   *
   * Callers (`debouncedRestart`, `scheduleRestartWhenIdle`,
   * `executePendingRestart`, ceiling-timer path) set `this.lastRestartReason`
   * BEFORE invoking `restart()` so that value is available for logs and for
   * the `stop()` guard. See Stage 2 of
   * `docs/plans/260424_observability_followups.md`.
   */
  private async doRestart(): Promise<void> {
    logger.info(
      { reason: this.lastRestartReason },
      "Restarting Super-MCP (serialized)",
    );
    // Stage 2 (260424): hold the reason across stop(). `stop()` only clears
    // `lastRestartReason` when `isStopForRestart` is false.
    this.isStopForRestart = true;
    try {
      await this.stopNow();
      // Note: a packaged-missing-bundle `MissingBundledSuperMcpError` (Stage 2 /
      // REBEL-61X) thrown by start() here is NOT routed to Safe Mode — it's
      // caught by runRestartWork()'s `.catch` (logged, waiters rejected). That's
      // acceptable because a missing bundle deterministically fails the *initial*
      // startup into Safe Mode first, so a restart can't be the first surface of it.
      await this.start();
    } finally {
      this.isStopForRestart = false;
    }
    // Stage 4a: count only successful end-to-end restarts. If `start()` throws
    // the increment is skipped and telemetry correctly reflects that the
    // restart did not complete.
    this.restartCount += 1;
    logger.info(
      {
        port: this.state.port,
        restartCount: this.restartCount,
        reason: this.lastRestartReason,
      },
      "Super-MCP restart complete",
    );
  }

  /**
   * Request a debounced restart.
   * Multiple calls within RESTART_DEBOUNCE_MS collapse into a single restart
   * executed after the debounce window expires. Returns a promise that resolves
   * when the eventual restart completes.
   */
  private debouncedRestart(work: PendingRestartWork): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Clear any pending debounce timer — reset the quiet window
      if (this.restartDebounceTimer) {
        clearTimeout(this.restartDebounceTimer);
      }

      this.restartDebounceTimer = setTimeout(() => {
        this.restartDebounceTimer = null;
        this.scheduleRestartWhenIdleWork(work, {
          noActiveTurnsMessage: 'Super-MCP debounced restart scheduled — no active turns, restarting immediately',
          deferredMessage: 'Super-MCP debounced restart deferred — active turns in progress',
          releasedMessage: 'Super-MCP debounced restart released — turns drained',
          failureMessage: 'Super-MCP debounced restart failed',
        }).then(resolve, reject);
      }, SuperMcpHttpManager.RESTART_DEBOUNCE_MS);
    });
  }

  /**
   * Request a drain-safe config restart, DETACHED from the caller's control
   * flow. This is the default form for config-mutation callers: it returns
   * void by construction, so a user-facing IPC handler cannot accidentally
   * couple its response latency to the deferred restart (which can wait up to
   * RESTART_DEFERRAL_CEILING_MS while agent turns drain — the 260610
   * "Disconnecting…"/connect-hang class).
   *
   * Failure handling: restart failures fire `request.onRestartError` (via the
   * restart-work machinery) and are additionally logged here when the
   * underlying promise rejects. A synchronous throw before the promise exists
   * is also routed to `request.onRestartError` — callers never see a throw.
   */
  public requestRestartForConfigChangeDetached(request: SuperMcpConfigRestartRequest): void {
    try {
      void this.requestRestartForConfigChangeAndAwaitExecution(request).catch((error) => {
        // onRestartError callbacks have already fired via runRestartWork; this
        // catch only prevents an unhandled rejection and keeps a log trail.
        logger.warn(
          { err: error, context: request.context },
          'Detached Super-MCP config restart failed (restart may be needed)',
        );
      });
    } catch (error) {
      // Future-proofing: the awaiting form is currently throw-free before the
      // promise exists, but the detached contract must hold for every failure
      // shape — observe, never propagate.
      logger.warn(
        { err: error, context: request.context },
        'Detached Super-MCP config restart failed synchronously (restart may be needed)',
      );
      try {
        request.onRestartError?.(error);
      } catch (callbackError) {
        logger.warn(
          { err: callbackError, context: request.context },
          'Super-MCP restart-error callback failed',
        );
      }
    }
  }

  /**
   * Execution-awaiting form of the config restart: the returned promise
   * resolves only when the (possibly deferred) restart actually EXECUTES —
   * potentially RESTART_DEFERRAL_CEILING_MS later while agent turns are
   * active. Explicit opt-in by name: never await this from a user-facing IPC
   * path unless the response genuinely depends on the restart having
   * completed. Default to requestRestartForConfigChangeDetached() instead.
   */
  public requestRestartForConfigChangeAndAwaitExecution(request: SuperMcpConfigRestartRequest): Promise<void> {
    const work = this.createConfigRestartWork(request);
    return this.scheduleRestartWhenIdleWork(work, {
      noActiveTurnsMessage: 'Super-MCP config restart scheduled — no active turns, restarting immediately',
      deferredMessage: 'Super-MCP config restart deferred — active turns in progress',
      releasedMessage: 'Super-MCP config restart released — turns drained',
      failureMessage: 'Super-MCP config restart failed',
    });
  }

  public requestImmediateConfigReloadForChatMaterialization(
    request: ImmediateConfigReloadRequest,
  ): Promise<void> {
    const work = this.createConfigRestartWork({
      ...request,
      context: `${request.reason}:${request.context}`,
    });
    logger.info(
      { context: work.context, reason: request.reason },
      'Super-MCP immediate config reload requested for chat materialization',
    );
    this.lastRestartReason = work.restartReason;
    return this.runRestartWorkAndWait(work, 'Super-MCP immediate config reload failed');
  }

  public requestDebouncedRestartWhenIdle(request: SuperMcpConfigRestartRequest): Promise<void> {
    const work: PendingRestartWork = {
      ...this.createConfigRestartWork(request),
      restartReason: SUPER_MCP_RESTART_REASON.DEBOUNCED_WORKSPACE_CHANGE,
      execute: () => this.restartNow(),
    };
    return this.debouncedRestart(work);
  }

  private createConfigRestartWork(request: SuperMcpConfigRestartRequest): PendingRestartWork {
    return {
      context: request.context,
      restartReason: SUPER_MCP_RESTART_REASON.IDLE_RESTART,
      execute: () => this.executeConfigChangeRestart(request.configPath, request.context),
      afterRestartCallbacks: request.afterRestart ? [request.afterRestart] : [],
      onRestartErrorCallbacks: request.onRestartError ? [request.onRestartError] : [],
      resolveCallbacks: [],
      rejectCallbacks: [],
      onRestartDeferred: request.onRestartDeferred,
    };
  }

  private async executeConfigChangeRestart(configPath: string, context: string): Promise<void> {
    if (!this.config) {
      throw new Error('Super-MCP HTTP manager not configured');
    }

    if (this.state.isRunning) {
      await this.reconfigureNow(configPath);
      return;
    }

    this.config.configPath = configPath;
    const result = await this.startWithRetries(configPath, {
      logContext: context,
      force: true,
    });
    if (!result.success) {
      throw new Error(result.error ?? `Failed to start Super-MCP for config change: attempts=${result.attempts}`);
    }
  }

  private mergePendingRestartWork(next: PendingRestartWork): void {
    if (!this.pendingRestartWork) {
      this.pendingRestartWork = next;
      return;
    }

    this.pendingRestartWork = {
      context: next.context,
      restartReason: next.restartReason,
      execute: next.execute,
      afterRestartCallbacks: [
        ...this.pendingRestartWork.afterRestartCallbacks,
        ...next.afterRestartCallbacks,
      ],
      onRestartErrorCallbacks: [
        ...this.pendingRestartWork.onRestartErrorCallbacks,
        ...next.onRestartErrorCallbacks,
      ],
      resolveCallbacks: [
        ...this.pendingRestartWork.resolveCallbacks,
        ...next.resolveCallbacks,
      ],
      rejectCallbacks: [
        ...this.pendingRestartWork.rejectCallbacks,
        ...next.rejectCallbacks,
      ],
      // onRestartDeferred deliberately omitted: deferral signals fire once,
      // immediately, at each request's own deferral site (the coalesce branch
      // fires the LOCAL request's signal via notifyRestartDeferred right after
      // this merge; notify reads the local work object, which merging never
      // mutates). Carrying a callback into the merged pending work could only
      // ever produce a spurious second fire.
    };
  }

  private runRestartWork(work: PendingRestartWork, failureMessage: string): void {
    void work.execute()
      .then(() => {
        for (const callback of work.afterRestartCallbacks) {
          try {
            callback();
          } catch (callbackError) {
            logger.warn({ err: callbackError, context: work.context }, 'Super-MCP post-restart callback failed');
          }
        }
        for (const resolve of work.resolveCallbacks) {
          resolve();
        }
      })
      .catch((err) => {
        logger.error({ err, context: work.context }, failureMessage);
        for (const callback of work.onRestartErrorCallbacks) {
          try {
            callback(err);
          } catch (callbackError) {
            logger.warn({ err: callbackError, context: work.context }, 'Super-MCP restart-error callback failed');
          }
        }
        for (const reject of work.rejectCallbacks) {
          reject(err);
        }
      });
  }

  private runRestartWorkAndWait(work: PendingRestartWork, failureMessage: string): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      work.resolveCallbacks.push(resolve);
      work.rejectCallbacks.push(reject);
    });
    this.runRestartWork(work, failureMessage);
    return completion;
  }

  /**
   * Stateless per-deferral notification: broadcast the renderer UX signal AND
   * invoke the LOCAL request's `onRestartDeferred` callback (if any), exactly
   * once, at the deferral site that received `work`. Called from BOTH deferral
   * branches of `scheduleRestartWhenIdleWork` (fresh-defer and coalesce) — no
   * deferral state is stored on pending work (see `mergePendingRestartWork`).
   */
  private notifyRestartDeferred(work: PendingRestartWork, activeTurns: number): void {
    try {
      // UX-only signal for Settings; restart scheduling must not depend on renderer delivery.
      getBroadcastService().sendToAllWindows('super-mcp:restart-deferred', {
        context: work.context,
        activeTurns,
        deferredAt: Date.now(),
      });
    } catch (err) {
      logger.debug({ err, activeTurns, context: work.context }, 'Super-MCP restart deferral broadcast failed');
    }
    if (work.onRestartDeferred) {
      try {
        work.onRestartDeferred({ activeTurns });
      } catch (err) {
        // Caller-supplied callback failure must not break restart scheduling.
        logger.warn({ err, activeTurns, context: work.context }, 'Super-MCP restart deferral callback failed');
      }
    }
  }

  /**
   * Schedule a restart that defers execution while agent turns are active.
   *
   * - If no turns are running: calls restart immediately (fire-and-forget).
   * - If turns are active: sets a pendingRestart flag and waits for the turn
   *   registry to drain before restarting.
   * - Multiple calls while a restart is pending coalesce into one restart.
   * - Safety ceiling: forces restart after the deferral ceiling even if turns haven't drained.
   * - TOCTOU safety: the drain callback re-verifies getActiveTurnCount() === 0
   *   before executing the restart.
   */
  public scheduleRestartWhenIdle(): void {
    this.scheduleRestartWhenIdleWork({
      context: 'idle-restart',
      restartReason: SUPER_MCP_RESTART_REASON.IDLE_RESTART,
      execute: () => this.restartNow(),
      afterRestartCallbacks: [],
      onRestartErrorCallbacks: [],
      resolveCallbacks: [],
      rejectCallbacks: [],
    }, {
      noActiveTurnsMessage: 'Super-MCP restart scheduled — no active turns, restarting immediately',
      deferredMessage: 'Super-MCP restart deferred — active turns in progress',
      releasedMessage: 'Super-MCP restart released — turns drained',
      failureMessage: 'Super-MCP scheduled restart failed',
    }).catch((err) => {
      logger.error({ err }, 'Super-MCP scheduled restart failed');
    });
  }

  private scheduleRestartWhenIdleWork(
    work: PendingRestartWork,
    messages: {
      noActiveTurnsMessage: string;
      deferredMessage: string;
      releasedMessage: string;
      failureMessage: string;
    },
  ): Promise<void> {
    const scheduledWork = work;
    const completion = new Promise<void>((resolve, reject) => {
      scheduledWork.resolveCallbacks.push(resolve);
      scheduledWork.rejectCallbacks.push(reject);
    });

    if (!this.config) {
      logger.warn('scheduleRestartWhenIdle called before configure() — ignoring');
      for (const callback of scheduledWork.onRestartErrorCallbacks) {
        callback(new Error('Super-MCP HTTP manager not configured'));
      }
      for (const resolve of scheduledWork.resolveCallbacks) {
        resolve();
      }
      return completion;
    }

    // Coalesce: if a deferred restart is already pending, skip
    if (this.pendingRestart) {
      const activeTurns = agentTurnRegistry.getActiveTurnCount();
      this.mergePendingRestartWork(work);
      logger.debug({ context: work.context }, 'Super-MCP restart already pending — coalescing');
      this.notifyRestartDeferred(work, activeTurns);
      return completion;
    }

    const activeTurns = agentTurnRegistry.getActiveTurnCount();

    if (activeTurns === 0) {
      // No active turns — restart immediately (fire-and-forget)
      logger.info({ context: work.context }, messages.noActiveTurnsMessage);
      // Stage 2 (260424): attribute this restart before kicking off doRestart().
      this.lastRestartReason = work.restartReason;
      this.runRestartWork(work, messages.failureMessage);
      return completion;
    }

    // Active turns present — defer restart until they drain
    this.pendingRestart = true;
    this.pendingRestartWork = work;
    logger.warn(
      { activeTurns, context: work.context },
      messages.deferredMessage,
    );
    this.notifyRestartDeferred(work, activeTurns);

    // Safety ceiling: force restart after 30 minutes
    this.deferralCeilingTimer = setTimeout(() => {
      if (!this.pendingRestart) return;
      this.pendingRestart = false;
      this.deferralCeilingTimer = null;
      logger.warn(
        { activeTurns: agentTurnRegistry.getActiveTurnCount(), context: this.pendingRestartWork?.context },
        'Super-MCP restart forced — deferral ceiling reached',
      );
      const pendingWork = this.pendingRestartWork;
      this.pendingRestartWork = null;
      if (pendingWork) {
        this.lastRestartReason = pendingWork.restartReason;
        this.runRestartWork(pendingWork, 'Super-MCP forced restart failed');
      }
    }, SuperMcpHttpManager.RESTART_DEFERRAL_CEILING_MS);

    // Register drain callback — fires when all active turns complete
    agentTurnRegistry.onDrained(() => {
      // TOCTOU: re-verify that turns are actually at 0
      // A new turn may have started between the drain event and this microtask
      if (agentTurnRegistry.getActiveTurnCount() > 0) {
        logger.debug(
          { activeTurns: agentTurnRegistry.getActiveTurnCount() },
          'Super-MCP drain callback: new turns started, re-registering',
        );
        // Re-register for the next drain
        // pendingRestart remains true, ceiling timer remains active
        agentTurnRegistry.onDrained(() => {
          this.executePendingRestart(messages.releasedMessage, messages.failureMessage);
        });
        return;
      }

      this.executePendingRestart(messages.releasedMessage, messages.failureMessage);
    });
    return completion;
  }

  /**
   * Execute a pending restart after turns have drained.
   * Clears the pending flag and ceiling timer, then fires restart().
   */
  private executePendingRestart(releasedMessage: string, failureMessage: string): void {
    // TOCTOU: final re-check before committing to restart
    if (agentTurnRegistry.getActiveTurnCount() > 0) {
      logger.debug(
        { activeTurns: agentTurnRegistry.getActiveTurnCount() },
        'Super-MCP executePendingRestart: turns still active, deferring again',
      );
      agentTurnRegistry.onDrained(() => {
        this.executePendingRestart(releasedMessage, failureMessage);
      });
      return;
    }

    if (!this.pendingRestart) return;
    const work = this.pendingRestartWork;

    this.pendingRestart = false;
    this.pendingRestartWork = null;
    if (this.deferralCeilingTimer) {
      clearTimeout(this.deferralCeilingTimer);
      this.deferralCeilingTimer = null;
    }

    logger.info({ context: work?.context }, releasedMessage);
    // Stage 2 (260424): deferred-then-drained execution path — still attributable
    // to `scheduleRestartWhenIdle()` by design.
    if (work) {
      this.lastRestartReason = work.restartReason;
      this.runRestartWork(work, failureMessage);
    }
  }

  /**
   * Get current manager state
   */
  public getState(): SuperMcpHttpManagerState {
    return { ...this.state };
  }

  /**
   * Stage 4a lifecycle + identity snapshot for the perf diagnostic.
   *
   * Pure data read (no I/O, no allocation beyond the return object) — safe
   * to call on every diagnostic tick. Circuit-breaker state is computed
   * from `lastStartupFailureAt` vs `CIRCUIT_BREAKER_COOLDOWN_MS` so the
   * `cooldownRemainingMs` naturally decrements until the window expires.
   */
  public getSubprocessInfo(): SuperMcpSubprocessInfo {
    const pid = this.state.process?.pid ?? null;
    const startTime = this.state.startTime;
    const now = Date.now();

    const circuitBreakerActive =
      this.lastStartupFailureAt !== null &&
      now - this.lastStartupFailureAt < SuperMcpHttpManager.CIRCUIT_BREAKER_COOLDOWN_MS;
    const cooldownRemainingMs =
      circuitBreakerActive && this.lastStartupFailureAt !== null
        ? SuperMcpHttpManager.CIRCUIT_BREAKER_COOLDOWN_MS - (now - this.lastStartupFailureAt)
        : null;

    return {
      pid,
      startTime,
      uptime: startTime !== null && this.state.isRunning ? now - startTime : null,
      isRunning: this.state.isRunning,
      startCount: this.startCount,
      restartCount: this.restartCount,
      lastStartupFailureAt: this.lastStartupFailureAt,
      lastStartupError: this.lastStartupError,
      circuitBreakerActive,
      cooldownRemainingMs,
      lastRestartReason: this.lastRestartReason,
    };
  }

  /**
   * Stage 4b: poll super-mcp's `/stats` endpoint and update the in-memory
   * cache. Always resolves (never rejects) — fail-observable: on failure /
   * timeout / 404, `lastStatsCache` is updated to an explicit status-carrying
   * snapshot rather than left stale or silently skipped.
   *
   * Designed for fire-and-forget from the perf-diagnostic tick:
   *
   * ```ts
   * void manager.fetchStats(); // never awaited
   * const snapshot = manager.getLastStatsCache(); // read prev tick's result
   * ```
   *
   * Gating: skip the fetch entirely (cache untouched) when the manager is
   * not running or the circuit breaker is active — there's no /stats
   * endpoint to call, and a failed fetch would pollute the cache with a
   * less-informative `timeout`/`error` status when the consumer already
   * knows `isRunning: false` and `circuitBreakerActive: true` from
   * `getSubprocessInfo()`.
   *
   * Status mapping:
   * - 404             → `status: 'unsupported'` (older bundled super-mcp).
   * - 2xx             → `status: 'ok'`, `payload` populated.
   * - other non-2xx   → `status: 'error'`, `httpStatus` populated.
   * - AbortError      → `status: 'timeout'`.
   * - other throw     → `status: 'error'`, `lastErr` populated.
   */
  public async fetchStats(): Promise<void> {
    // Skip when there's nothing to poll. Cache intentionally untouched so
    // the perf diagnostic can still surface the most recent known snapshot
    // alongside the `isRunning: false` / circuit-breaker state it already
    // reports via `getSubprocessInfo()`.
    if (!this.state.isRunning) {
      return;
    }
    if (
      this.lastStartupFailureAt !== null &&
      Date.now() - this.lastStartupFailureAt < SuperMcpHttpManager.CIRCUIT_BREAKER_COOLDOWN_MS
    ) {
      return;
    }

    const baseUrl = `http://127.0.0.1:${this.state.port}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SuperMcpHttpManager.STATS_FETCH_TIMEOUT_MS,
    );

    // Capture the generation at fetch-start. If `invalidateStatsCache()`
    // fires while we're awaiting the network (e.g. subprocess exited), the
    // generation advances and we refuse to write our late-arriving result.
    // Stage 4b iter-2 safety refinement — prevents stale dead-process data
    // leaking back into the cache after invalidation.
    const startGen = this.statsGeneration;

    // Staging local for the result so we only mutate instance state AFTER
    // the generation check inside `finally`.
    let nextCache: SuperMcpStatsSnapshot | null = null;

    try {
      const resp = await fetch(`${baseUrl}${SUPER_MCP_REST_ENDPOINTS.STATS}`, { signal: controller.signal });
      if (resp.status === 404) {
        // Older bundled super-mcp lacking the route.
        //
        // This manager owns the port (via `findAvailablePort()` +
        // `cleanupOrphanedProcessesInRange()`), so a 404 here is the
        // actual bundled super-mcp returning 404 — not some other
        // process on the wrong port. Treating as `unsupported` is safe.
        nextCache = { status: 'unsupported', at: Date.now() };
      } else if (!resp.ok) {
        nextCache = {
          status: 'error',
          at: Date.now(),
          httpStatus: resp.status,
          lastErr: `HTTP ${resp.status}`,
        };
      } else {
        const payload = (await resp.json()) as unknown;
        nextCache = { status: 'ok', at: Date.now(), payload };
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      nextCache = {
        status: isAbort ? 'timeout' : 'error',
        at: Date.now(),
        lastErr: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);

      // Race guard: a lifecycle exit/error may have fired during the
      // network wait and invalidated the cache. If so, abandon our result
      // rather than repopulate the cache with dead-process data.
      // Avoid `return` inside `finally` — wrap all state mutations in
      // an if-block so the control flow stays explicit.
      if (this.statsGeneration !== startGen) {
        logger.debug(
          {
            startGen,
            currentGen: this.statsGeneration,
            abandonedStatus: nextCache?.status,
          },
          'super-mcp /stats: abandoning stale in-flight fetch result (cache was invalidated mid-flight)',
        );
      } else {
        this.lastStatsCache = nextCache;
        this.lastStatsFetchAt = Date.now();
        // Stage 4b M5: track the last successful poll so operators can
        // tell a fresh ok from a stale ok followed by silent failures.
        if (this.lastStatsCache?.status === 'ok') {
          this.lastGoodStatsAt = Date.now();
        }
        // Stage 4b M4: emit one log entry per state transition (not per
        // tick) so transient failures are observable without flooding.
        // The `null → 'ok'` first-successful-poll case is intentionally
        // silent — normal startup, not an event of interest.
        const newStatus = this.lastStatsCache?.status ?? null;
        if (newStatus !== null && newStatus !== this.lastStatsStatus) {
          const prev = this.lastStatsStatus;
          const cache = this.lastStatsCache;
          if (prev === 'ok' && newStatus !== 'ok') {
            logger.warn(
              {
                prevStatus: prev,
                newStatus,
                lastErr: cache?.lastErr,
                httpStatus: cache?.httpStatus,
              },
              'super-mcp /stats: status degraded',
            );
          } else if (prev !== null && prev !== 'ok' && newStatus === 'ok') {
            logger.info({ prevStatus: prev }, 'super-mcp /stats: status recovered');
          } else if (prev === null && newStatus === 'unsupported') {
            logger.info(
              { prevStatus: prev, newStatus },
              'super-mcp /stats: endpoint not available (version skew)',
            );
          } else if (prev !== null && prev !== newStatus && newStatus !== 'ok') {
            // e.g. timeout → error, 404 → 500. Still a change of degraded
            // mode worth one log line for triage.
            logger.warn(
              {
                prevStatus: prev,
                newStatus,
                lastErr: cache?.lastErr,
                httpStatus: cache?.httpStatus,
              },
              'super-mcp /stats: degraded status changed',
            );
          }
          this.lastStatsStatus = newStatus;
        }
      }
    }
  }

  /**
   * Read the most recent /stats snapshot. `null` when `fetchStats()` has
   * never been invoked. Synchronous — safe to call from the diagnostic tick.
   */
  public getLastStatsCache(): SuperMcpStatsSnapshot | null {
    return this.lastStatsCache;
  }

  /**
   * ms epoch of the most recent `fetchStats()` completion (success, failure,
   * or abort). `null` when no fetch has completed. Used by consumers to
   * compute `stats_age_ms` for operator diagnostics.
   */
  public getLastStatsFetchAt(): number | null {
    return this.lastStatsFetchAt;
  }

  /**
   * ms epoch of the most recent `fetchStats()` with `status: 'ok'`. `null`
   * when no successful fetch has completed for the current subprocess
   * lifetime (reset on subprocess exit). Used by consumers to compute
   * `last_good_age_ms` — distinguishes a fresh `'ok'` from a stale one
   * followed by silent failures. Stage 4b M5 refinement.
   */
  public getLastGoodStatsAt(): number | null {
    return this.lastGoodStatsAt;
  }

  /**
   * Get HTTP configuration for the agent runtime
   */
  public getHttpConfig(): { type: "http"; url: string } | null {
    if (!this.state.isRunning) {
      return null;
    }

    return {
      type: "http",
      url: this.state.url,
    };
  }

  /**
   * Get MCP servers that were skipped during the last startup due to validation errors.
   * Empty array if no servers were skipped.
   */
  public getSkippedServers(): SkippedServer[] {
    return [...this.skippedServers];
  }

  /**
   * Fetch skipped servers from Super-MCP's HTTP endpoint.
   * Called once after startup to populate this.skippedServers.
   * Best-effort with bounded retry — failure leaves skippedServers as empty.
   */
  private async fetchSkippedServers(): Promise<void> {
    const maxAttempts = 2;
    const retryDelayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${this.state.port}${SUPER_MCP_REST_ENDPOINTS.SKIPPED_SERVERS}`,
          { signal: AbortSignal.timeout(2000) }
        );

        if (response.status === 404) {
          logger.debug("Super-MCP /api/skipped-servers not available (older version)");
          return;
        }

        if (!response.ok) {
          logger.warn({ status: response.status }, "Unexpected response from /api/skipped-servers");
          return;
        }

        const data = await response.json() as { packages?: Array<{ id: string; reason: string }> };
        if (Array.isArray(data?.packages)) {
          this.skippedServers = data.packages.map(p => ({
            id: String(p.id),
            reason: String(p.reason),
          }));
        }

        if (this.skippedServers.length > 0) {
          logger.info(
            { count: this.skippedServers.length, ids: this.skippedServers.map(s => s.id) },
            "Fetched skipped MCP servers from Super-MCP",
          );
        }
        return;
      } catch (error) {
        if (attempt < maxAttempts) {
          logger.debug({ attempt, err: error }, "Retrying /api/skipped-servers fetch");
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        } else {
          logger.warn(
            { err: error, attempts: maxAttempts },
            "Failed to fetch skipped servers from Super-MCP (non-fatal)",
          );
        }
      }
    }
  }

  /**
   * Reconfigure the Super-MCP HTTP server with a new config path.
   * Stops the current server (if running) and starts with the new configuration.
   * Re-acquires an available port to prevent conflicts with other app instances.
   *
   * @param newConfigPath - Path to the new MCP configuration file
   */
  public async reconfigure(
    newConfigPath: string,
    auth: ImmediateSuperMcpLifecycleAuth,
  ): Promise<void> {
    void auth;
    await this.reconfigureNow(newConfigPath);
  }

  private async reconfigureNow(newConfigPath: string): Promise<void> {
    if (!this.config) {
      throw new Error(
        "Super-MCP HTTP manager not configured - call configure() first",
      );
    }

    const wasRunning = this.state.isRunning;
    const previousPath = this.config.configPath;
    const previousPort = this.config.port;

    logger.info(
      {
        previousPath,
        newConfigPath,
        previousPort,
        wasRunning,
      },
      "Reconfiguring Super-MCP HTTP server with new config path",
    );

    // Stage 2 (260424): attribute the restart BEFORE stop() — `isStopForRestart`
    // keeps the attribution alive across the stop; `force: true` on
    // `startWithRetries` below prevents the circuit-breaker-reset branch from
    // overwriting it.
    this.lastRestartReason = SUPER_MCP_RESTART_REASON.RECONFIGURE;

    // Stop if currently running
    // Note: stop() now handles port release polling internally
    if (wasRunning) {
      this.isStopForRestart = true;
      try {
        await this.stopNow();
      } finally {
        this.isStopForRestart = false;
      }
    }

    // Update config path before restart — startWithRetries handles port selection
    this.config.configPath = newConfigPath;

    // Use the robust retry path (force: true bypasses circuit breaker for config changes)
    const result = await this.startWithRetries(newConfigPath, {
      logContext: 'reconfigure',
      force: true,
    });

    if (!result.success) {
      throw new Error(`Failed to restart Super-MCP after reconfigure: attempts=${result.attempts}`);
    }

    logger.info(
      {
        newConfigPath,
        port: this.state.port,
        portChanged: previousPort !== this.state.port,
        attempts: result.attempts,
      },
      "Super-MCP HTTP server reconfigured successfully",
    );
  }

  /**
   * Ensure Super-MCP is running after system resume from sleep.
   * Called from powerMonitor.on('resume') to recover from sleep-induced process death.
   * Uses isRecovering flag to prevent concurrent recovery attempts (e.g., duplicate resume events).
   * Re-acquires an available port to prevent conflicts with other app instances that may have
   * taken the port while this app was sleeping.
   */
  public async ensureRunningAfterResume(): Promise<void> {
    if (!this.config) return;
    if (this.isRecovering) {
      logger.debug("Super-MCP recovery already in progress, skipping");
      return;
    }

    this.isRecovering = true;
    // Resume from sleep is not a retry of a failed startup — clear stale breaker
    this.resetCircuitBreaker();
    try {
      // Always probe health after resume — state.isRunning may be stale after sleep.
      // Force a live TCP probe by clearing trust window (process may have died during sleep).
      this.lastHealthyAt = 0;
      const isHealthy = await this.checkHealth();

      if (isHealthy) {
        logger.debug("Super-MCP healthy after resume, no action needed");
        return;
      }

      logger.info("Super-MCP not healthy after system resume, restarting...");

      // Stage 2 (260424): attribute this restart BEFORE startWithRetries.
      // `force: true` below prevents the circuit-breaker-reset branch inside
      // `startWithRetries` from overwriting 'post-resume'.
      this.lastRestartReason = SUPER_MCP_RESTART_REASON.POST_RESUME;

      // Use the robust retry path — handles port reselection, retries, and diagnostics
      const result = await this.startWithRetries(this.config.configPath, {
        logContext: 'resume-recovery',
        force: true,
      });

      if (result.success) {
        logger.info(
          { port: this.state.port, url: this.state.url, attempts: result.attempts },
          "Super-MCP restarted successfully after system resume",
        );
      } else {
        logger.error({ attempts: result.attempts }, "Failed to restart Super-MCP after system resume");
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to recover Super-MCP after system resume");
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Check if the manager has been configured
   */
  public isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Stable boundary for `mcpRuntimeHealth` and any future caller that needs
   * read-only visibility into the manager's startup-failure state. Returning
   * a snapshot (not a live reference) makes the contract explicit and decouples
   * health-check consumers from internal field renames or `#private`
   * migration. Matches the manifest field `mcp_transition.data.consecutiveFailures`.
   */
  public getStartupHealthSnapshot(): { consecutiveFailures: number } {
    return { consecutiveFailures: this.consecutiveStartupFailures };
  }
}

// Export singleton instance
export const superMcpHttpManager = new SuperMcpHttpManager();

/**
 * Start Super-MCP HTTP server with retries.
 *
 * Canonical lifecycle wrapper for resilient startup. Kept in the Super-MCP
 * manager module so shared headless bootstraps do not need to import broad
 * diagnostics modules such as systemHealthService.
 */
export async function startSuperMcpWithRetries(
  configPath: string,
  options?: {
    /** Custom logger prefix for context. */
    logContext?: string;
    /** Bypass the circuit breaker (e.g. for user-initiated restarts). */
    force?: boolean;
    /** Preferred HTTP port for this owner/process. */
    preferredPort?: number;
    /** Number of candidate ports to scan. */
    portRange?: number;
    /** Startup health-check timeout. */
    startupTimeoutMs?: number;
  },
): Promise<SuperMcpStartResult> {
  return superMcpHttpManager.startWithRetries(configPath, options);
}

export async function stopSuperMcpForAppShutdown(): Promise<void> {
  await superMcpHttpManager.stop(createImmediateSuperMcpLifecycleAuth('app-shutdown'));
}

export async function stopSuperMcpForHeadlessCleanup(): Promise<void> {
  await superMcpHttpManager.stop(createImmediateSuperMcpLifecycleAuth('headless-cleanup'));
}
