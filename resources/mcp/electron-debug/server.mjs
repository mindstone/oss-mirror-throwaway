#!/usr/bin/env node
/**
 * Simplified Electron debugging MCP server inspired by
 * https://github.com/amafjarkasi/electron-mcp-server (ISC license).
 *
 * This variant is tailored for Mindstone Rebel so that AI agents can
 * launch, inspect, and control local Electron builds through the
 * Model Context Protocol.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const ELECTRON_RESOURCES = {
  INFO: 'electron://info',
  PROCESS: 'electron://process/',
  LOGS: 'electron://logs/',
  TARGETS: 'electron://targets'
};

const ELECTRON_TOOLS = {
  START: 'electron_start_app',
  CONNECT_EXISTING: 'electron_connect_existing_app',
  STOP: 'electron_stop_app',
  LIST: 'electron_list_apps',
  TARGETS: 'electron_list_targets',
  RELOAD: 'electron_reload',
  EVALUATE: 'electron_evaluate',
  CDP: 'electron_cdp_command',
  READ_LOG_FILES: 'read_log_files',
  SPAWN_DEV_SERVER: 'spawn_dev_server',
  CLICK_BUTTON: 'click_button',
  FILL_INPUT: 'fill_input',
  GET_PAGE_STATE: 'get_page_state',
  TAKE_SCREENSHOT: 'take_screenshot'
};

// App name variants for log directory detection (dev vs packaged vs beta)
const APP_NAME_VARIANTS = ['mindstone-rebel', 'Mindstone Rebel', 'Mindstone Rebel Beta', 'Electron'];

const MAX_LOG_LINES = 1000;
const MAX_DEV_SERVER_OUTPUT_LINES = 500;
const DEV_SERVER_PROCESS_ID = 'dev-server';
const MANAGED_DEV_SERVER_STATE_VERSION = 1;
const MANAGED_DEV_SERVER_USER_DATA_BASENAME = 'rebel-mcp-dev-userdata';

// Dev server singleton state
let devServerProcess = null;
let devServerOutput = [];  // Circular buffer of stdout/stderr lines
let devServerStartTime = null;
let devServerRepoRoot = null;
let devServerDebugPort = null;  // CDP port for interaction tools
let devServerRendererPort = null;
let devServerPgid = null;
let devServerTestUserDataDir = null;
let devServerStateSource = null;
const electronProcesses = new Map(); // id -> descriptor
const cdpClients = new Map(); // `${processId}:${targetId}` -> client
const cdpSessions = new Map(); // `${processId}:${targetId}` -> sessionId

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRendererDevPort = () => {
  const raw = process.env.ELECTRON_RENDERER_PORT;
  if (!raw) return 5173;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 5173;
};

const findAvailablePort = async (startPort, maxAttempts = 10) => {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    const check = await checkPortAvailable('127.0.0.1', port);
    if (check.available) {
      return port;
    }
  }
  return null;
};

const checkPortAvailable = (host, port, timeoutMs = 1_000) => {
  return new Promise((resolve) => {
    const server = net.createServer();

    const done = (result) => {
      try {
        server.removeAllListeners();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      done({ available: false, code: 'TIMEOUT' });
    }, timeoutMs);

    server.once('error', (err) => {
      clearTimeout(timer);
      done({ available: false, code: err?.code ?? 'ERROR' });
    });

    server.once('listening', () => {
      clearTimeout(timer);
      server.close(() => done({ available: true }));
    });

    server.listen(port, host);
  });
};

const httpGetJson = async (url, timeoutMs = 1_500) => {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e?.message ?? e}`));
          }
          return;
        }
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} from ${url}`));
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });

    req.on('error', (err) => reject(err));
  });
};

const waitForDevtools = async ({ debugPort, timeoutMs, requireDevServerProcess = true }) => {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${debugPort}/json/version`;
  while (Date.now() < deadline) {
    if (requireDevServerProcess && !devServerProcess) {
      return { ready: false, reason: 'dev-server-exited' };
    }

    try {
      const data = await httpGetJson(url, 800);
      if (data?.webSocketDebuggerUrl) {
        return { ready: true, webSocketDebuggerUrl: data.webSocketDebuggerUrl };
      }
    } catch {
      // keep polling
    }
    await sleep(300);
  }

  return { ready: false, reason: 'timeout' };
};

const formatDevServerStartFailure = ({ reason, rendererPort, debugPort }) => {
  const tail = devServerOutput.slice(-40);
  const tailText = tail.length ? `\n\nRecent dev output:\n${tail.join('\n')}` : '';

  // Heuristic hints for common failure modes.
  const joined = tail.join('\n').toLowerCase();
  const hints = [];

  if (joined.includes('eaddrinuse') || joined.includes('port 5173') || joined.includes('strictport')) {
    hints.push(
      `Port ${rendererPort} is already in use (usually another \`npm run dev\` is already running).\n` +
        `- Stop the existing dev server (Ctrl+C), or run it on a different port via \`ELECTRON_RENDERER_PORT=5174 npm run dev\`.\n` +
        `- If you just want to kill the current renderer dev server, try \`npm run dev:stop\`.`
    );
  }

  if (reason === 'dev-server-exited') {
    hints.push(
      `The dev process exited before the CDP debug port (${debugPort}) became available.\n` +
        `This can happen if forge thinks the session is non-interactive, or if Electron exits during startup.\n` +
        `Try re-running the skill, or run \`npm run dev\` manually in a terminal to see the full error output.`
    );
  }

  if (!hints.length) {
    hints.push(
      `Rebel didn't expose the CDP debug port (${debugPort}) in time.\n` +
        `Common causes: the renderer dev port (${rendererPort}) is busy, Electron exited on startup, or the build is still running.`
    );
  }

  return {
    error: `Dev server failed to become ready (${reason}).`,
    rendererPort,
    debugPort,
    hint: hints.join('\n\n'),
    devServerOutputTail: tailText
  };
};

const withTimeout = async (promise, timeoutMs, message) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(message ?? `Operation timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const CDP_CONNECT_TIMEOUT_MS = 15_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;

const getPackagedAsarEntry = () => {
  const outDir = path.resolve(process.cwd(), 'out');
  if (!fs.existsSync(outDir)) {
    return null;
  }

  const tryGetAsarCandidates = (baseDir) => {
    const candidates = [];

    // macOS: Forge outputs a .app bundle.
    try {
      const children = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || !child.name.endsWith('.app')) continue;
        const asarPath = path.join(baseDir, child.name, 'Contents', 'Resources', 'app.asar');
        if (fs.existsSync(asarPath)) {
          candidates.push(asarPath);
        }
      }
    } catch {
      // ignore
    }

    // Windows/Linux: Forge typically outputs resources/app.asar.
    const resourcesAsar = path.join(baseDir, 'resources', 'app.asar');
    if (fs.existsSync(resourcesAsar)) {
      candidates.push(resourcesAsar);
    }

    return candidates;
  };

  const outChildren = fs.readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const asarCandidates = outChildren.flatMap((dirent) => tryGetAsarCandidates(path.join(outDir, dirent.name)));
  if (!asarCandidates.length) {
    return null;
  }

  const newest = asarCandidates
    .map((candidate) => {
      try {
        return { candidate, mtimeMs: fs.statSync(candidate).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  return newest?.candidate ?? null;
};

const defaultAppEntry = () => {
  if (process.env.MCP_ELECTRON_APP_PATH) {
    return process.env.MCP_ELECTRON_APP_PATH;
  }

  // Prefer a packaged build when present (works reliably with CDP).
  const packagedAsar = getPackagedAsarEntry();
  if (packagedAsar) {
    return packagedAsar;
  }

  // Fallback to vite "build" output.
  return path.resolve(process.cwd(), 'out/main/index.js');
};

const ensureFile = (candidate) => {
  if (!candidate) {
    throw new Error('electron app path missing. Provide appPath or set MCP_ELECTRON_APP_PATH');
  }
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new Error(`electron app entry not found at ${resolved}. Build the app first (e.g. npm run package).`);
  }
  return resolved;
};

const getElectronBinary = () => {
  if (process.env.MCP_ELECTRON_BINARY) {
    return process.env.MCP_ELECTRON_BINARY;
  }
  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  const local = path.resolve(process.cwd(), 'node_modules', '.bin', binName);
  if (fs.existsSync(local)) {
    return local;
  }
  if (process.platform === 'win32') {
    const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', binName);
    if (fs.existsSync(npmGlobal)) {
      return npmGlobal;
    }
  }
  return binName;
};

const randomDebugPort = () => Math.floor(Math.random() * (9999 - 9222 + 1)) + 9222;

const startElectronApp = async ({ appPath, debugPort, extraArgs = [] }) => {
  const entry = ensureFile(appPath ?? defaultAppEntry());
  const port = debugPort || randomDebugPort();
  const id = `electron-${Date.now()}`;
  const bin = getElectronBinary();
  const args = ['--enable-logging', `--remote-debugging-port=${port}`, entry, ...extraArgs];

  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const descriptor = {
    id,
    process: child,
    name: path.basename(entry),
    status: 'starting',
    pid: child.pid,
    debugPort: port,
    startTime: new Date(),
    logs: [],
    appPath: entry,
    targets: [],
    lastTargetUpdate: null
  };

  const pushLog = (prefix, chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      descriptor.logs.push(`[${prefix}] ${line}`);
    }
    if (descriptor.logs.length > MAX_LOG_LINES) {
      descriptor.logs.splice(0, descriptor.logs.length - MAX_LOG_LINES);
    }
  };

  child.stdout.on('data', (data) => pushLog('stdout', data));
  child.stderr.on('data', (data) => pushLog('stderr', data));
  child.on('exit', (code) => {
    descriptor.status = code === 0 ? 'stopped' : 'crashed';
    cleanupProcess(descriptor.id);
  });

  electronProcesses.set(id, descriptor);
  await sleep(1200);
  descriptor.status = 'running';
  await updateTargets(descriptor).catch((error) => {
    console.warn(`[MCP electron] failed to fetch targets for ${id}:`, error.message);
  });
  return descriptor;
};

const connectExistingElectronApp = async ({ debugPort, processId, name = 'Existing Rebel dev app' }) => {
  const port = Number(debugPort);
  const id = processId || `existing-${port}`;
  if (electronProcesses.has(id)) {
    throw new Error(`Electron process id ${id} is already registered.`);
  }

  const ready = await waitForDevtools({ debugPort: port, timeoutMs: 5_000, requireDevServerProcess: false });
  if (!ready.ready) {
    throw new Error(
      `No CDP endpoint found on port ${port}. Relaunch the real dev app with ` +
        `REMOTE_DEBUGGING_PORT=${port} npm run dev, then connect again.`
    );
  }

  const descriptor = {
    id,
    process: null,
    external: true,
    name,
    status: 'running',
    pid: null,
    debugPort: port,
    startTime: new Date(),
    logs: [`[info] Registered existing Electron app on CDP port ${port}.`],
    appPath: null,
    targets: [],
    lastTargetUpdate: null
  };

  electronProcesses.set(id, descriptor);
  try {
    await updateTargets(descriptor);
    return descriptor;
  } catch (error) {
    electronProcesses.delete(id);
    throw error;
  }
};

const stopElectronApp = (processId) => {
  const descriptor = electronProcesses.get(processId);
  if (!descriptor) {
    throw new Error(`No electron process with id ${processId}`);
  }
  if (!descriptor.external) {
    descriptor.process.kill();
  } else {
    electronProcesses.delete(processId);
  }
  descriptor.status = 'stopped';
  cleanupProcess(processId);
  return descriptor;
};

const cleanupProcess = (processId) => {
  for (const key of cdpClients.keys()) {
    if (key.startsWith(`${processId}:`)) {
      try {
        cdpClients.get(key)?.close();
      } catch {
        // ignore
      }
      cdpClients.delete(key);
    }
  }

  for (const key of cdpSessions.keys()) {
    if (key.startsWith(`${processId}:`)) {
      cdpSessions.delete(key);
    }
  }
};

const updateTargets = async (descriptor) => {
  if (!descriptor.debugPort) {
    throw new Error('Process missing debug port');
  }
  const response = await fetch(`http://127.0.0.1:${descriptor.debugPort}/json/list`);
  if (!response.ok) {
    throw new Error(`debug target request failed ${response.status}`);
  }
  descriptor.targets = await response.json();
  descriptor.lastTargetUpdate = new Date();
  return descriptor.targets;
};

const ensureTargets = async (descriptor) => {
  if (!descriptor.targets || descriptor.targets.length === 0) {
    await updateTargets(descriptor);
  }
  return descriptor.targets;
};

const getProcessOrThrow = (processId) => {
  const descriptor = electronProcesses.get(processId);
  if (!descriptor) {
    throw new Error(`Process ${processId} not found`);
  }
  if (descriptor.status !== 'running') {
    throw new Error(`Process ${processId} is not running`);
  }
  return descriptor;
};

const pickTargetId = async (descriptor, requestedTargetId) => {
  if (requestedTargetId) {
    await updateTargets(descriptor).catch(() => {});
    const targets = descriptor.targets ?? [];
    if (targets.some((target) => target.id === requestedTargetId)) {
      return requestedTargetId;
    }
    throw new Error(`No target with given id found: ${requestedTargetId}`);
  }
  // Targets can change during app startup (window creation). Refresh opportunistically.
  await updateTargets(descriptor).catch(() => {});
  const targets = descriptor.targets ?? [];
  if (!targets.length) {
    throw new Error('No debuggable targets exposed yet');
  }

  const pageTargets = targets.filter((target) => target.type === 'page');
  const appPageTargets = pageTargets.filter((target) =>
    typeof target.url === 'string' &&
    !target.url.startsWith('devtools://') &&
    !target.url.includes('gpu-worker')
  );
  const preferred =
    // Prefer the main renderer window when present (dev: http://127.0.0.1..., packaged: .../renderer/main_window/index.html)
    appPageTargets.find((target) =>
      typeof target.url === 'string' &&
      (target.url.includes('127.0.0.1') ||
        target.url.includes('localhost') ||
        target.url.includes('/renderer/') ||
        target.url.includes('main_window'))
    ) ||
    // Avoid auxiliary pages (e.g. gpu-worker)
    appPageTargets.find((target) =>
      typeof target.url === 'string' && target.url.length > 0
    ) ||
    pageTargets[0] ||
    targets[0];
  return preferred.id;
};

const getBrowserCdpClient = async (descriptor) => {
  const cacheKey = `${descriptor.id}:browser`;
  if (cdpClients.has(cacheKey)) {
    return cdpClients.get(cacheKey);
  }
  if (!descriptor.debugPort) {
    throw new Error('Process missing debug port');
  }

  const versionRes = await fetch(`http://127.0.0.1:${descriptor.debugPort}/json/version`);
  if (!versionRes.ok) {
    throw new Error(`debug version request failed ${versionRes.status}`);
  }

  const versionJson = await versionRes.json();
  const wsUrl = versionJson?.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('debug version response missing webSocketDebuggerUrl');
  }

  const client = await withTimeout(
    CDP({ target: wsUrl }),
    CDP_CONNECT_TIMEOUT_MS,
    `CDP connect timed out (browser endpoint) for ${descriptor.id} (${descriptor.debugPort})`
  );

  cdpClients.set(cacheKey, client);
  client.on('disconnect', () => cdpClients.delete(cacheKey));
  return client;
};

const getTargetSessionId = async (descriptor, targetId) => {
  const cacheKey = `${descriptor.id}:${targetId}`;
  const cached = cdpSessions.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = await getBrowserCdpClient(descriptor);
  const attachResult = await withTimeout(
    client.send('Target.attachToTarget', { targetId, flatten: true }),
    CDP_COMMAND_TIMEOUT_MS,
    'CDP command timed out: Target.attachToTarget'
  );

  const sessionId = attachResult?.sessionId;
  if (!sessionId) {
    throw new Error('Target.attachToTarget did not return sessionId');
  }

  cdpSessions.set(cacheKey, sessionId);
  return sessionId;
};

const isRecoverableTargetError = (error) =>
  error instanceof Error &&
  /(No target with given id found|Session with given id not found|Cannot find context with specified id)/i.test(
    error.message
  );

const executeCdpCommand = async (processId, targetId, domain, command, params = {}) => {
  const descriptor = getProcessOrThrow(processId);
  const actualTarget = await pickTargetId(descriptor, targetId);
  const client = await getBrowserCdpClient(descriptor);

  const executeForTarget = async (target) => {
    const sessionId = await getTargetSessionId(descriptor, target);
    const result = await withTimeout(
      client.send(`${domain}.${command}`, params, sessionId),
      CDP_COMMAND_TIMEOUT_MS,
      `CDP command timed out: ${domain}.${command}`
    );
    return { result, processId, targetId: target, command: `${domain}.${command}` };
  };

  try {
    return await executeForTarget(actualTarget);
  } catch (error) {
    if (!isRecoverableTargetError(error)) {
      throw error;
    }

    cdpSessions.delete(`${descriptor.id}:${actualTarget}`);
    await updateTargets(descriptor).catch(() => {});
    const refreshedTarget = await pickTargetId(descriptor, targetId);
    if (refreshedTarget !== actualTarget) {
      cdpSessions.delete(`${descriptor.id}:${refreshedTarget}`);
    }
    return executeForTarget(refreshedTarget);
  }
};

const summarizeProcesses = () => {
  if (electronProcesses.size === 0) {
    return 'No Electron apps are currently running.';
  }
  const lines = [];
  for (const descriptor of electronProcesses.values()) {
    lines.push(
      `${descriptor.id} — ${descriptor.name} [${descriptor.status}] pid=${descriptor.pid ?? 'n/a'} port=${descriptor.debugPort ?? 'n/a'}`
    );
  }
  return lines.join('\n');
};

// --- Log file reading helpers ---

/**
 * Get the log directory path for the Rebel app.
 * Auto-detects from multiple app name variants (dev, stable, beta).
 * @param {string|null} preferredVariant - Optional preferred app name variant (must be in APP_NAME_VARIANTS)
 * @returns {string} Path to the logs directory
 */
const getLogDirectory = (preferredVariant = null) => {
  const platform = process.platform;
  const home = os.homedir();

  let baseDir;
  if (platform === 'darwin') {
    baseDir = path.join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    baseDir = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else {
    // Linux and other Unix-like systems
    baseDir = path.join(home, '.config');
  }

  // SECURITY: Only allow known variants to prevent path injection
  if (preferredVariant && APP_NAME_VARIANTS.includes(preferredVariant)) {
    const preferred = path.join(baseDir, preferredVariant, 'logs');
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  }

  // Auto-detect: find first existing logs directory
  for (const variant of APP_NAME_VARIANTS) {
    const candidate = path.join(baseDir, variant, 'logs');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to dev name (may not exist yet)
  return path.join(baseDir, 'mindstone-rebel', 'logs');
};

/**
 * Check if a requested path is safe (no path traversal).
 * Uses string-based check only - for symlink protection, use isPathSafeWithSymlinks().
 * @param {string} requestedPath - The path requested by the user
 * @param {string} baseDir - The base directory to restrict access to
 * @returns {boolean} True if path is safe, false if it escapes baseDir
 */
const isPathSafe = (requestedPath, baseDir) => {
  const resolved = path.resolve(baseDir, requestedPath);
  const relative = path.relative(baseDir, resolved);
  // Safe if: relative path doesn't escape (is '..' or starts with '../')
  // Note: '.../file' is a valid filename, only '..' and '../' patterns are unsafe
  if (relative === '..' || relative.startsWith('..' + path.sep)) {
    return false;
  }
  // Also reject absolute paths in the relative result
  return !path.isAbsolute(relative);
};

/**
 * Check if a file path is safe after resolving symlinks.
 * SECURITY: This prevents symlink-based directory escapes.
 * @param {string} filePath - The resolved file path to check
 * @param {string} baseDir - The base directory to restrict access to
 * @returns {Promise<{safe: boolean, realPath?: string, error?: string}>}
 */
const isPathSafeWithSymlinks = async (filePath, baseDir) => {
  try {
    // Get real paths (follows symlinks)
    const realBase = await fs.promises.realpath(baseDir);
    const realTarget = await fs.promises.realpath(filePath);
    
    // Check containment using the real paths
    const relative = path.relative(realBase, realTarget);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return { safe: false, error: 'Path escapes log directory (symlink detected)' };
    }
    
    return { safe: true, realPath: realTarget };
  } catch (err) {
    // If realpath fails (file doesn't exist, permission denied), check string path
    if (err.code === 'ENOENT') {
      return { safe: false, error: 'File not found' };
    }
    return { safe: false, error: `Path resolution failed: ${err.message}` };
  }
};

/**
 * List log files in the log directory with metadata.
 * @param {string} logDir - Path to the logs directory
 * @returns {Promise<Array<{name: string, size: number, modified: string, isDirectory: boolean}>>}
 */
const listLogFiles = async (logDir) => {
  if (!fs.existsSync(logDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(logDir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      results.push({
        name: entry.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        isDirectory: entry.isDirectory()
      });
    } catch {
      // Skip files we can't stat (permission issues, etc.)
    }
  }

  // Sort by modification time (newest first)
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return results;
};

/**
 * Read a log file with optional line limits.
 * By default reads from the END (tail-like behavior) which is most useful for logs.
 * @param {string} filePath - Full path to the log file
 * @param {number} lines - Maximum number of lines to return (default: 100)
 * @param {number|null} fromLine - If specified, read from this line number (0-based, from start). If null, reads from end.
 * @returns {Promise<{content: string, totalLines: number, truncated: boolean}>}
 */
const readLogFile = async (filePath, lines = 100, fromLine = null) => {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  // Handle both Unix (\n) and Windows (\r\n) line endings
  const allLines = content.split(/\r?\n/);
  const totalLines = allLines.length;

  let startLine, endLine, selectedLines;

  if (fromLine !== null) {
    // Read from specific line (head-like, from start)
    startLine = Math.max(0, Math.min(fromLine, totalLines));
    endLine = Math.min(startLine + lines, totalLines);
    selectedLines = allLines.slice(startLine, endLine);
  } else {
    // Default: read from end (tail-like behavior - most useful for logs)
    startLine = Math.max(0, totalLines - lines);
    endLine = totalLines;
    selectedLines = allLines.slice(startLine, endLine);
  }

  const truncated = startLine > 0 || endLine < totalLines;

  return {
    content: selectedLines.join('\n'),
    totalLines,
    linesReturned: selectedLines.length,
    startLine,
    endLine,
    truncated,
    mode: fromLine !== null ? 'from_line' : 'tail'
  };
};

// --- Dev server spawning helpers ---

/**
 * Find the repo root by searching upward for package.json with name "mindstone-rebel".
 * Starts from the given directory or cwd.
 * @param {string|null} startDir - Starting directory (defaults to cwd)
 * @returns {string|null} Path to repo root, or null if not found
 */
const findRepoRoot = (startDir = null) => {
  let dir = startDir ? path.resolve(startDir) : process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'mindstone-rebel') {
          return dir;
        }
      } catch {
        // Invalid JSON, continue searching
      }
    }
    dir = path.dirname(dir);
  }

  return null;
};

/**
 * Append output to the dev server circular buffer.
 * @param {string} text - Text to append
 * @param {string} prefix - 'stdout' or 'stderr'
 */
const appendDevServerOutput = (text, prefix = 'out') => {
  const timestamp = new Date().toISOString();
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  for (const line of lines) {
    devServerOutput.push(`[${timestamp}] [${prefix}] ${line}`);
  }
  // Maintain circular buffer limit
  if (devServerOutput.length > MAX_DEV_SERVER_OUTPUT_LINES) {
    devServerOutput.splice(0, devServerOutput.length - MAX_DEV_SERVER_OUTPUT_LINES);
  }
};

const getChildTmpDir = () => {
  if (process.platform === 'win32') {
    return os.tmpdir();
  }
  return process.env.TMPDIR ? path.resolve(process.env.TMPDIR) : '/tmp';
};

const getDefaultTestUserDataDir = () =>
  path.join(getChildTmpDir(), MANAGED_DEV_SERVER_USER_DATA_BASENAME);

const getDevServerStatePath = (repoRoot = null) => {
  const root = repoRoot ? path.resolve(repoRoot) : findRepoRoot();
  const key = root
    ? createHash('sha1').update(root).digest('hex').slice(0, 12)
    : 'unknown';
  return path.join(getChildTmpDir(), `rebel-electron-mcp-dev-server-${key}.json`);
};

const normalizeDevServerState = (state) => {
  if (!state || typeof state !== 'object') return null;
  const pid = Number(state.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const pgid = Number(state.pgid);
  const debugPort = Number(state.debugPort);
  const rendererPort = Number(state.rendererPort);

  return {
    version: MANAGED_DEV_SERVER_STATE_VERSION,
    pid,
    pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : pid,
    repoRoot: typeof state.repoRoot === 'string' ? path.resolve(state.repoRoot) : null,
    rendererPort: Number.isInteger(rendererPort) && rendererPort > 0 ? rendererPort : null,
    debugPort: Number.isInteger(debugPort) && debugPort > 0 ? debugPort : null,
    processId: DEV_SERVER_PROCESS_ID,
    testUserDataDir: typeof state.testUserDataDir === 'string' ? state.testUserDataDir : null,
    startedAt: typeof state.startedAt === 'string' ? state.startedAt : new Date().toISOString(),
    source: state.source ?? 'state-file'
  };
};

const readDevServerState = (repoRoot = null) => {
  const statePath = getDevServerStatePath(repoRoot);
  try {
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (parsed?.version !== MANAGED_DEV_SERVER_STATE_VERSION) return null;
    const state = normalizeDevServerState(parsed);
    return state ? { ...state, statePath, source: 'state-file' } : null;
  } catch (error) {
    appendDevServerOutput(`Ignoring unreadable dev-server state file: ${error.message}`, 'system');
    return null;
  }
};

const writeDevServerState = (state) => {
  const normalized = normalizeDevServerState(state);
  if (!normalized?.repoRoot) return;

  const statePath = getDevServerStatePath(normalized.repoRoot);
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    appendDevServerOutput(`Failed to persist dev-server state: ${error.message}`, 'system');
  }
};

const removeDevServerState = (repoRoot = null) => {
  try {
    fs.rmSync(getDevServerStatePath(repoRoot), { force: true });
  } catch (error) {
    appendDevServerOutput(`Failed to remove dev-server state: ${error.message}`, 'system');
  }
};

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const isProcessGroupAlive = (pgid) => {
  if (process.platform === 'win32') {
    return isProcessAlive(pgid);
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const execFileText = (command, args, timeoutMs = 4_000) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${error.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve(stdout.toString());
    });
  });

const parsePosixProcessTable = (stdout) =>
  stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4]
      };
    })
    .filter(Boolean);

const getProcessTable = async () => {
  if (process.platform === 'win32') {
    try {
      const stdout = await execFileText('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
      ], 8_000);
      const parsed = JSON.parse(stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => ({
          pid: Number(row.ProcessId),
          ppid: Number(row.ParentProcessId),
          pgid: Number(row.ProcessId),
          command: String(row.CommandLine ?? '')
        }))
        .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
    } catch (error) {
      appendDevServerOutput(`Failed to inspect Windows process table: ${error.message}`, 'system');
      return [];
    }
  }

  try {
    return parsePosixProcessTable(await execFileText('ps', ['-axo', 'pid=,ppid=,pgid=,command=']));
  } catch (error) {
    appendDevServerOutput(`Failed to inspect process table: ${error.message}`, 'system');
    return [];
  }
};

const commandHasManagedMarkers = (command, expected = {}) => {
  if (!/(^|\s)--rebel-test(?=\s|$)/.test(command)) return false;
  if (!command.includes('--rebel-test-user-data-dir=')) return false;

  const expectedUserData = expected.testUserDataDir ?? null;
  if (expectedUserData && !command.includes(expectedUserData)) return false;
  if (!expectedUserData && !command.includes(MANAGED_DEV_SERVER_USER_DATA_BASENAME)) return false;

  if (expected.debugPort && !command.includes(`--remote-debugging-port=${expected.debugPort}`)) {
    return false;
  }

  return true;
};

const extractManagedDevServerFields = (commands) => {
  const joined = commands.join(' ');
  const debugPortMatch = joined.match(/--remote-debugging-port=(\d+)/);
  const userDataMatch = joined.match(/--rebel-test-user-data-dir=("[^"]+"|'[^']+'|\S+)/);
  return {
    debugPort: debugPortMatch ? Number(debugPortMatch[1]) : null,
    testUserDataDir: userDataMatch
      ? userDataMatch[1].replace(/^['"]|['"]$/g, '')
      : null
  };
};

const validateManagedDevServerState = async (state) => {
  const normalized = normalizeDevServerState(state);
  if (!normalized || !isProcessAlive(normalized.pid)) return null;

  const rows = await getProcessTable();
  if (!rows.length) {
    return null;
  }

  const target = rows.find((row) => row.pid === normalized.pid);
  if (!target) return null;

  const pgid = process.platform === 'win32' ? normalized.pid : (target.pgid || normalized.pgid || normalized.pid);
  const groupRows = process.platform === 'win32'
    ? rows.filter((row) => row.pid === normalized.pid || row.ppid === normalized.pid)
    : rows.filter((row) => row.pgid === pgid);
  const commands = groupRows.map((row) => row.command);
  const hasManagedMarkers = commands.some((command) => commandHasManagedMarkers(command, normalized));
  const hasRepoMarker = !normalized.repoRoot || commands.some((command) => command.includes(normalized.repoRoot));

  if (!hasManagedMarkers || !hasRepoMarker) return null;

  const extracted = extractManagedDevServerFields(commands);
  return {
    ...normalized,
    pgid,
    debugPort: normalized.debugPort ?? extracted.debugPort,
    testUserDataDir: normalized.testUserDataDir ?? extracted.testUserDataDir
  };
};

const findManagedDevServerFromProcesses = async (repoRoot = null) => {
  if (process.platform === 'win32') {
    return null;
  }

  const root = repoRoot ? path.resolve(repoRoot) : findRepoRoot();
  const rows = await getProcessTable();
  const groups = new Map();

  for (const row of rows) {
    const key = process.platform === 'win32' ? row.pid : row.pgid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const [pgid, groupRows] of groups.entries()) {
    const commands = groupRows.map((row) => row.command);
    const hasManagedMarkers = commands.some((command) => commandHasManagedMarkers(command));
    const hasRepoMarker = !root || commands.some((command) => command.includes(root));
    if (!hasManagedMarkers || !hasRepoMarker) continue;

    const rootRow = groupRows.find((row) => row.pid === pgid) ?? groupRows[0];
    const extracted = extractManagedDevServerFields(commands);
    return {
      version: MANAGED_DEV_SERVER_STATE_VERSION,
      pid: rootRow.pid,
      pgid: process.platform === 'win32' ? rootRow.pid : pgid,
      repoRoot: root,
      rendererPort: null,
      debugPort: extracted.debugPort,
      processId: DEV_SERVER_PROCESS_ID,
      testUserDataDir: extracted.testUserDataDir,
      startedAt: new Date().toISOString(),
      source: 'process-scan'
    };
  }

  return null;
};

const registerDevServerDescriptor = (state) => {
  const normalized = normalizeDevServerState(state);
  if (!normalized) return null;

  devServerStartTime = new Date(normalized.startedAt);
  if (Number.isNaN(devServerStartTime.getTime())) {
    devServerStartTime = new Date();
  }
  devServerRepoRoot = normalized.repoRoot;
  devServerDebugPort = normalized.debugPort;
  devServerRendererPort = normalized.rendererPort;
  devServerPgid = normalized.pgid;
  devServerTestUserDataDir = normalized.testUserDataDir;
  devServerStateSource = normalized.source ?? 'memory';

  electronProcesses.set(DEV_SERVER_PROCESS_ID, {
    id: DEV_SERVER_PROCESS_ID,
    name: 'Dev Server (electron-vite)',
    status: 'running',
    pid: normalized.pid,
    debugPort: normalized.debugPort,
    startTime: devServerStartTime.toISOString(),
    appPath: normalized.repoRoot,
    targets: [],
    logs: []
  });

  return normalized;
};

const clearDevServerState = ({ removeState = true } = {}) => {
  const repoRoot = devServerRepoRoot;
  devServerProcess = null;
  devServerStartTime = null;
  devServerRepoRoot = null;
  devServerDebugPort = null;
  devServerRendererPort = null;
  devServerPgid = null;
  devServerTestUserDataDir = null;
  devServerStateSource = null;
  electronProcesses.delete(DEV_SERVER_PROCESS_ID);
  if (removeState) {
    removeDevServerState(repoRoot);
  }
};

const discoverManagedDevServer = async (repoRoot = null) => {
  if (devServerProcess && isProcessAlive(devServerProcess.pid)) {
    return {
      version: MANAGED_DEV_SERVER_STATE_VERSION,
      pid: devServerProcess.pid,
      pgid: devServerPgid ?? devServerProcess.pid,
      repoRoot: devServerRepoRoot,
      rendererPort: devServerRendererPort,
      debugPort: devServerDebugPort,
      processId: DEV_SERVER_PROCESS_ID,
      testUserDataDir: devServerTestUserDataDir,
      startedAt: devServerStartTime?.toISOString() ?? new Date().toISOString(),
      source: 'memory'
    };
  }

  if (devServerProcess) {
    clearDevServerState({ removeState: false });
  }

  const root = repoRoot ? path.resolve(repoRoot) : (devServerRepoRoot ?? findRepoRoot());
  const persisted = readDevServerState(root);
  if (persisted) {
    const validPersisted = await validateManagedDevServerState(persisted);
    if (validPersisted) {
      const adopted = registerDevServerDescriptor({ ...validPersisted, source: 'state-file' });
      writeDevServerState(adopted);
      return { ...adopted, source: 'state-file' };
    }
    removeDevServerState(root);
  }

  const scanned = await findManagedDevServerFromProcesses(root);
  if (scanned) {
    const adopted = registerDevServerDescriptor(scanned);
    writeDevServerState(adopted);
    appendDevServerOutput(`Adopted existing MCP-managed dev server pid=${adopted.pid}`, 'system');
    return adopted;
  }

  return null;
};

const waitForDevServerExit = async ({ pid, pgid, timeoutMs = 2_500 }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !isProcessGroupAlive(pgid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid) && !isProcessGroupAlive(pgid);
};

/**
 * Start the dev server (npm run dev).
 * @param {string|null} repoRoot - Path to repo root (auto-detected if null)
 * @returns {{success: boolean, error?: string, pid?: number, repoRoot?: string}}
 */
const startDevServer = (repoRoot = null, options = {}) => {
  if (devServerProcess && isProcessAlive(devServerProcess.pid)) {
    return {
      success: false,
      error: 'Dev server already running',
      pid: devServerProcess.pid
    };
  }
  if (devServerProcess) {
    clearDevServerState({ removeState: false });
  }

  // Find repo root if not provided
  const root = repoRoot ? path.resolve(repoRoot) : findRepoRoot();
  if (!root) {
    return {
      success: false,
      error: 'Could not find repo root (looking for package.json with name "mindstone-rebel")'
    };
  }

  // Verify package.json exists
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return {
      success: false,
      error: `package.json not found at ${pkgPath}`
    };
  }

  // Cross-platform spawn configuration
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  
  // Generate a random debug port for CDP connection
  const debugPort = randomDebugPort();

  // Use isolated userData for MCP-driven dev runs to avoid single-instance lock
  // conflicts with installed/beta builds and to prevent writing test state to real user data.
  // Keep it stable across runs so onboarding/settings can be set up once.
  //
  // IMPORTANT: ensureTestUserData.ts enforces that REBEL_TEST_USER_DATA_DIR is under os.tmpdir().
  // In some non-interactive shells TMPDIR may be unset, causing os.tmpdir() to fall back to /tmp.
  // To keep the containment check consistent, we also force TMPDIR for the child process.
  const childTmpDir = getChildTmpDir();
  const defaultTestUserDataDir = getDefaultTestUserDataDir();
  const testUserDataDir = process.env.REBEL_TEST_USER_DATA_DIR ?? defaultTestUserDataDir;
  
  const rendererPort = options.rendererPort ?? getRendererDevPort();

  try {
    // NOTE: We pass electron args via `npm run dev -- -- <args>` so they reach the Electron
    // process even if electron-forge does not inherit all env vars.
    const npmArgs = [
      'run',
      'dev',
      '--',
      '--',
      '--rebel-test',
      `--remote-debugging-port=${String(debugPort)}`,
      `--rebel-test-user-data-dir=${testUserDataDir}`
    ];

    const child = spawn(npmCmd, npmArgs, {
      cwd: root,
      shell: true,
      // On Unix, use detached mode to create a process group for cleanup
      // On Windows, taskkill /t handles the tree automatically
      detached: !isWindows,
      // Keep stdin open. electron-forge/plugin-vite dev mode expects an interactive
      // session; if stdin is closed, it may exit immediately after launch.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { 
        ...process.env,
        ...(isWindows ? {} : { TMPDIR: childTmpDir }),
        ELECTRON_RENDERER_PORT: String(rendererPort),
        // Enable remote debugging for CDP interaction tools
        REMOTE_DEBUGGING_PORT: String(debugPort),
        // Test mode skips the production single-instance lock and keeps
        // managed MCP UI checks from stealing the user's running Rebel.
        REBEL_TEST_MODE: '1',
        REBEL_E2E_TEST_MODE: '1',
        // Prefer a stable isolated test userData dir unless the caller provided one.
        // (See src/main/startup/ensureTestUserData.ts)
        REBEL_TEST_USER_DATA_DIR: testUserDataDir
      }
    });

    devServerProcess = child;
    devServerOutput = [];  // Clear previous output
    const state = {
      version: MANAGED_DEV_SERVER_STATE_VERSION,
      pid: child.pid,
      pgid: isWindows ? child.pid : child.pid,
      repoRoot: root,
      rendererPort,
      debugPort,
      processId: DEV_SERVER_PROCESS_ID,
      testUserDataDir,
      startedAt: new Date().toISOString(),
      source: 'memory'
    };
    registerDevServerDescriptor(state);
    const descriptor = electronProcesses.get(DEV_SERVER_PROCESS_ID);
    if (descriptor) descriptor.status = 'starting';
    writeDevServerState(state);

    child.stdout.on('data', (data) => {
      appendDevServerOutput(data.toString(), 'stdout');
    });

    child.stderr.on('data', (data) => {
      appendDevServerOutput(data.toString(), 'stderr');
    });

    child.on('exit', (code, signal) => {
      const exitInfo = `[exit] Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
      appendDevServerOutput(exitInfo, 'system');
      if (devServerProcess === child) {
        clearDevServerState();
      }
    });

    child.on('error', (err) => {
      appendDevServerOutput(`[error] ${err.message}`, 'system');
      if (devServerProcess === child) {
        clearDevServerState();
      }
    });

    // Mark as running after a short delay to allow Electron to start
    // The actual CDP target detection happens when interaction tools are used
    setTimeout(() => {
      const desc = electronProcesses.get(DEV_SERVER_PROCESS_ID);
      if (desc && desc.status === 'starting') {
        desc.status = 'running';
      }
    }, 5000);

    return {
      success: true,
      pid: child.pid,
      repoRoot: root,
      rendererPort,
      debugPort,
      processId: DEV_SERVER_PROCESS_ID,
      testUserDataDir
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to spawn dev server: ${err.message}`
    };
  }
};

/**
 * Stop the dev server with proper process tree cleanup.
 * @returns {{success: boolean, error?: string, pid?: number}}
 */
const stopDevServer = async () => {
  const managed = await discoverManagedDevServer();
  if (!managed) {
    return {
      success: false,
      error: 'Dev server is not running'
    };
  }

  const pid = managed.pid;
  const pgid = managed.pgid ?? pid;
  const isWindows = process.platform === 'win32';
  const cleanupStages = [];

  try {
    if (isWindows) {
      // Windows: use taskkill to kill the entire process tree
      cleanupStages.push('taskkill-sent');
      await new Promise((resolve) => {
        const taskkill = spawn('taskkill', ['/pid', pid.toString(), '/t', '/f'], {
          shell: true,
          stdio: 'ignore'
        });
        taskkill.on('close', resolve);
        taskkill.on('error', resolve);
      });
    } else {
      // Unix: kill the process group (negative PID)
      // First try SIGTERM for graceful shutdown
      try {
        process.kill(-pgid, 'SIGTERM');
        cleanupStages.push('sigterm-group-sent');
      } catch (e) {
        // If process group kill fails, try direct kill
        if (e.code !== 'ESRCH') {
          devServerProcess?.kill('SIGTERM');
          cleanupStages.push('sigterm-direct-sent');
        } else {
          cleanupStages.push('already-gone-before-sigterm');
        }
      }
    }

    let stopped = await waitForDevServerExit({ pid, pgid, timeoutMs: 2_500 });
    if (!stopped && !isWindows) {
      try {
        process.kill(-pgid, 'SIGKILL');
        cleanupStages.push('sigkill-group-sent');
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          try {
            devServerProcess?.kill('SIGKILL');
            cleanupStages.push('sigkill-direct-sent');
          } catch {
            cleanupStages.push('sigkill-direct-failed');
          }
        } else {
          cleanupStages.push('already-gone-before-sigkill');
        }
      }
      stopped = await waitForDevServerExit({ pid, pgid, timeoutMs: 2_500 });
    }

    if (!stopped) {
      return {
        success: false,
        error: 'Failed to confirm dev server stopped; state retained so stop can be retried.',
        pid,
        pgid,
        cleanupStages
      };
    }

    clearDevServerState();
    
    return {
      success: true,
      pid,
      pgid,
      cleanupStages
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to stop dev server: ${err.message}`,
      pid
    };
  }
};

/**
 * Get dev server status.
 * @returns {{running: boolean, pid?: number, repoRoot?: string, startTime?: string, uptime?: number}}
 */
const getDevServerStatus = async () => {
  const managed = await discoverManagedDevServer();
  if (!managed) {
    return { running: false };
  }

  const uptime = devServerStartTime 
    ? Math.floor((Date.now() - devServerStartTime.getTime()) / 1000)
    : null;

  return {
    running: true,
    pid: managed.pid,
    pgid: managed.pgid,
    repoRoot: devServerRepoRoot,
    startTime: devServerStartTime?.toISOString(),
    uptimeSeconds: uptime,
    rendererPort: devServerRendererPort,
    debugPort: devServerDebugPort,
    processId: DEV_SERVER_PROCESS_ID,
    testUserDataDir: devServerTestUserDataDir,
    source: managed.source ?? devServerStateSource,
    adopted: managed.source !== 'memory'
  };
};

/**
 * Get recent dev server output from the circular buffer.
 * @param {number} lines - Number of lines to return (default: 50)
 * @returns {{output: string[], totalLines: number, truncated: boolean}}
 */
const getDevServerLogs = (lines = 50) => {
  const totalLines = devServerOutput.length;
  const requestedLines = Math.min(lines, totalLines);
  const output = devServerOutput.slice(-requestedLines);
  
  return {
    output,
    totalLines,
    linesReturned: output.length,
    truncated: requestedLines < totalLines
  };
};

const listTargets = async (processId) => {
  const descriptor = getProcessOrThrow(processId);
  await ensureTargets(descriptor);
  const rows = descriptor.targets?.map((target) => ({
    id: target.id,
    title: target.title || target.url,
    type: target.type,
    url: target.url
  })) ?? [];
  return rows;
};

const server = new McpServer({
  name: 'mindstone-electron-mcp',
  version: '0.1.0'
}, {
  capabilities: {
    resources: {}
  }
});

// Resource discovery -------------------------------------------------------
server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [
    {
      uri: ELECTRON_RESOURCES.INFO,
      name: 'Electron processes overview',
      description: 'High-level list of managed Electron processes',
      mimeType: 'application/json'
    },
    {
      uri: ELECTRON_RESOURCES.TARGETS,
      name: 'Electron debug targets',
      description: 'Active Chrome DevTools targets discovered across processes',
      mimeType: 'application/json'
    }
  ];

  for (const descriptor of electronProcesses.values()) {
    resources.push(
      {
        uri: `${ELECTRON_RESOURCES.PROCESS}${descriptor.id}`,
        name: `Process ${descriptor.id}`,
        description: `Debug info for ${descriptor.name}`,
        mimeType: 'application/json'
      },
      {
        uri: `${ELECTRON_RESOURCES.LOGS}${descriptor.id}`,
        name: `Logs ${descriptor.id}`,
        description: `Recent stdout/stderr for ${descriptor.name}`,
        mimeType: 'text/plain'
      }
    );
  }

  return { resources };
});

server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === ELECTRON_RESOURCES.INFO) {
    const payload = Array.from(electronProcesses.values()).map((descriptor) => ({
      id: descriptor.id,
      status: descriptor.status,
      pid: descriptor.pid,
      debugPort: descriptor.debugPort,
      appPath: descriptor.appPath,
      startTime: descriptor.startTime
    }));
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  }

  if (uri === ELECTRON_RESOURCES.TARGETS) {
    const snapshot = [];
    for (const descriptor of electronProcesses.values()) {
      if (descriptor.status !== 'running') continue;
      await ensureTargets(descriptor).catch(() => {});
      for (const target of descriptor.targets ?? []) {
        snapshot.push({ processId: descriptor.id, target });
      }
    }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) }] };
  }

  if (uri.startsWith(ELECTRON_RESOURCES.PROCESS)) {
    const processId = uri.slice(ELECTRON_RESOURCES.PROCESS.length);
    const descriptor = electronProcesses.get(processId);
    if (!descriptor) {
      throw new Error(`Process ${processId} not found`);
    }
    await ensureTargets(descriptor).catch(() => {});
    const payload = {
      id: descriptor.id,
      status: descriptor.status,
      pid: descriptor.pid,
      debugPort: descriptor.debugPort,
      targets: descriptor.targets ?? [],
      startTime: descriptor.startTime
    };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  }

  if (uri.startsWith(ELECTRON_RESOURCES.LOGS)) {
    const processId = uri.slice(ELECTRON_RESOURCES.LOGS.length);
    const descriptor = electronProcesses.get(processId);
    if (!descriptor) {
      throw new Error(`Process ${processId} not found`);
    }
    return { contents: [{ uri, mimeType: 'text/plain', text: descriptor.logs.join('\n') || 'no logs captured yet' }] };
  }

  throw new Error(`Unknown resource ${uri}`);
});

// Tool schemas -------------------------------------------------------------
const startSchema = z.object({
  appPath: z.string().min(1).optional(),
  debugPort: z.number().int().min(1024).max(65535).optional(),
  args: z.array(z.string()).optional()
});

const connectExistingSchema = z.object({
  debug_port: z.number().int().min(1024).max(65535).optional(),
  process_id: z.string().min(1).optional(),
  debugPort: z.number().int().min(1024).max(65535).optional(),
  processId: z.string().min(1).optional(),
  name: z.string().min(1).optional()
}).refine(
  (input) => input.debug_port !== undefined || input.debugPort !== undefined,
  { message: 'debug_port is required' }
);

const normalizeConnectExistingInput = (input) => ({
  debugPort: input.debug_port ?? input.debugPort,
  processId: input.process_id ?? input.processId,
  name: input.name
});

const stopSchema = z.object({
  processId: z.string().min(1)
});

const reloadSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional()
});

const evaluateSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional(),
  expression: z.string().min(1),
  returnByValue: z.boolean().optional()
});

const cdpSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional(),
  domain: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.string(), z.any()).optional()
});

const listTargetsSchema = z.object({
  processId: z.string().min(1).optional()
});

const readLogFilesSchema = z.object({
  action: z.enum(['list', 'read']),
  filename: z.string().optional(),      // Required for 'read' action
  lines: z.number().int().positive().max(MAX_LOG_LINES).optional(),  // Max lines to return (default: 100, max: 1000)
  fromLine: z.number().int().min(0).optional(),   // If specified, read from this line (otherwise reads from end)
  appVariant: z.enum(['mindstone-rebel', 'Mindstone Rebel', 'Mindstone Rebel Beta', 'Electron']).optional()
});

const spawnDevServerSchema = z.object({
  action: z.enum(['start', 'stop', 'status', 'logs']),
  repoRoot: z.string().optional(),      // For 'start' action - auto-detected if not provided
  logLines: z.number().int().positive().max(MAX_DEV_SERVER_OUTPUT_LINES).optional(),  // For 'logs' action (default: 50)
  waitForReadyMs: z.number().int().positive().max(120_000).optional().describe("For 'start' action (default: 90000)"), // For 'start' action (default: 90000)
  rendererPort: z.number().int().positive().max(65_535).optional(), // For 'start' action; defaults to ELECTRON_RENDERER_PORT or 5173
  autoAlternatePort: z.boolean().optional() // For 'start' action; default true, tries the next available port if rendererPort is busy
});

// Stage 3: Interaction wrapper tool schemas
const clickButtonSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional(),
  selector: z.string().optional(),    // CSS selector
  text: z.string().optional(),        // Button text content to find
  testId: z.string().optional()       // data-testid value
}).refine(
  data => data.selector || data.text || data.testId,
  { message: 'At least one of selector, text, or testId must be provided' }
);

const fillInputSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional(),
  selector: z.string().optional(),      // CSS selector
  placeholder: z.string().optional(),   // Placeholder text to find input by
  testId: z.string().optional(),        // data-testid value
  value: z.string()                     // Value to fill
}).refine(
  data => data.selector || data.placeholder || data.testId,
  { message: 'At least one of selector, placeholder, or testId must be provided' }
);

const getPageStateSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional()
});

const takeScreenshotSchema = z.object({
  processId: z.string().min(1),
  targetId: z.string().optional(),
  filename: z.string().optional(),  // If not provided, generates timestamped filename
  format: z.enum(['png', 'jpeg', 'webp']).optional(),  // Default: png
  includeBase64: z.boolean().optional()  // Default: false (to avoid large responses)
});

server.registerTool(
  ELECTRON_TOOLS.START,
  {
    title: 'Start Electron app',
    description:
      'Launches an Electron build (defaults to out/main/index.js). Provide `appPath` if you want a different entry.',
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: startSchema
  },
  async (input) => {
    const descriptor = await startElectronApp(input ?? {});
    return {
      content: [
        {
          type: 'text',
          text: `Started ${descriptor.name} (${descriptor.id}) on port ${descriptor.debugPort}.`
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.CONNECT_EXISTING,
  {
    title: 'Connect to existing Electron app',
    description:
      'Registers a real, already-running Electron dev app that exposes Chrome DevTools Protocol. For live Rebel UI reviews, use this with the app launched as REMOTE_DEBUGGING_PORT=9222 npm run dev instead of spawn_dev_server, which starts an isolated test-mode app. Prefer debug_port/process_id; debugPort/processId remain accepted for existing callers.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: connectExistingSchema
  },
  async (input) => {
    const descriptor = await connectExistingElectronApp(normalizeConnectExistingInput(input));
    return {
      content: [
        {
          type: 'text',
          text: `Connected to ${descriptor.name} (${descriptor.id}) on port ${descriptor.debugPort}. Use processId "${descriptor.id}" for screenshots and page inspection.`
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.STOP,
  {
    title: 'Stop Electron app',
    description: 'Stops a running Electron session by id.',
        annotations: { readOnlyHint: false, destructiveHint: true },
inputSchema: stopSchema
  },
  async (input) => {
    const descriptor = stopElectronApp(input.processId);
    return {
      content: [
        {
          type: 'text',
          text: `Stopped ${descriptor.name} (${descriptor.id}).`
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.LIST,
  {
    title: 'List Electron apps',
    description: 'Lists all processes managed by this MCP server.',
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: summarizeProcesses()
      }
    ]
  })
);

server.registerTool(
  ELECTRON_TOOLS.TARGETS,
  {
    title: 'List debug targets',
    description: 'Shows available Chrome DevTools targets (pages) for one process or all.',
        annotations: { readOnlyHint: true },
inputSchema: listTargetsSchema
  },
  async (input) => {
    if (input?.processId) {
      const rows = await listTargets(input.processId);
      return {
        content: [
          {
            type: 'text',
            text: rows.length ? JSON.stringify(rows, null, 2) : 'No targets exposed yet.'
          }
        ]
      };
    }
    const summary = [];
    for (const descriptor of electronProcesses.values()) {
      if (descriptor.status !== 'running') continue;
      const rows = await listTargets(descriptor.id).catch(() => []);
      summary.push({ processId: descriptor.id, targets: rows });
    }
    return {
      content: [
        {
          type: 'text',
          text: summary.length ? JSON.stringify(summary, null, 2) : 'No running processes expose targets yet.'
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.RELOAD,
  {
    title: 'Reload Electron window',
    description: 'Invokes Page.reload through the Chrome DevTools protocol.',
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: reloadSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);
    await executeCdpCommand(input.processId, targetId, 'Page', 'reload');
    return {
      content: [
        {
          type: 'text',
          text: `Requested reload on ${targetId}`
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.EVALUATE,
  {
    title: 'Evaluate JavaScript in renderer',
    description: 'Runs Runtime.evaluate against a renderer target.',
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: evaluateSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);
    const payload = await executeCdpCommand(input.processId, targetId, 'Runtime', 'evaluate', {
      expression: input.expression,
      returnByValue: input.returnByValue ?? true
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload.result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.CDP,
  {
    title: 'Send arbitrary CDP command',
    description: 'Advanced escape hatch for Chrome DevTools commands.',
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: cdpSchema
  },
  async (input) => {
    const payload = await executeCdpCommand(
      input.processId,
      input.targetId,
      input.domain,
      input.command,
      input.params ?? {}
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload.result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.READ_LOG_FILES,
  {
    title: 'Read Rebel app log files',
    description: `Read log files from the Rebel app's log directory. Use action 'list' to see available files, or 'read' to read a specific file. Supports multiple app variants (dev, stable, beta).`,
        annotations: { readOnlyHint: true },
inputSchema: readLogFilesSchema
  },
  async (input) => {
    const logDir = getLogDirectory(input.appVariant);

    if (input.action === 'list') {
      const files = await listLogFiles(logDir);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              logDirectory: logDir,
              files,
              hint: files.length === 0
                ? 'No log files found. The app may not have been run yet, or logs are in a different variant directory.'
                : `Found ${files.length} entries. Use action 'read' with a filename to view contents.`
            }, null, 2)
          }
        ]
      };
    }

    if (input.action === 'read') {
      if (!input.filename) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: "filename is required for 'read' action" })
            }
          ],
          isError: true
        };
      }

      // Security: prevent path traversal (string-based check first)
      if (!isPathSafe(input.filename, logDir)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Invalid filename: path traversal detected' })
            }
          ],
          isError: true
        };
      }

      const filePath = path.join(logDir, input.filename);

      // Check if file exists and is not a symlink escaping the directory
      // SECURITY: This prevents symlink-based directory escapes
      const symlinkCheck = await isPathSafeWithSymlinks(filePath, logDir);
      if (!symlinkCheck.safe) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: symlinkCheck.error || 'File access denied' })
            }
          ],
          isError: true
        };
      }

      // Check if it's a directory - if so, list its contents
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        const subFiles = await listLogFiles(filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                directory: input.filename,
                files: subFiles,
                hint: `This is a directory. Use 'read' with filename '${input.filename}/<file>' to read a specific file.`
              }, null, 2)
            }
          ]
        };
      }

      // Read the file (defaults to tail-like behavior if fromLine not specified)
      const lines = input.lines ?? 100;
      const fromLine = input.fromLine ?? null;  // null = read from end (tail)
      const result = await readLogFile(filePath, lines, fromLine);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              filename: input.filename,
              ...result,
              hint: result.truncated
                ? `Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use 'offset' to paginate.`
                : undefined
            }, null, 2)
          }
        ]
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown action: ${input.action}` })
        }
      ],
      isError: true
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.SPAWN_DEV_SERVER,
  {
    title: 'Spawn dev server',
    description: `Manage the Electron dev server (npm run dev). Supports actions: 'start', 'stop', 'status', 'logs'.

IMPORTANT: 'npm run dev' runs electron-forge which automatically launches the Electron app.
Do NOT use both spawn_dev_server AND electron_start_app together - choose one workflow:
1. **Forge dev mode**: Use spawn_dev_server only (app launches automatically via forge)
2. **Built app mode**: Use electron_start_app with pre-built 'out/main/index.js'

Only one dev server can run at a time (singleton pattern).

If the requested renderer port is busy, the tool automatically starts the managed dev app on the next available port unless autoAlternatePort is false.`,
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: spawnDevServerSchema
  },
  async (input) => {
    switch (input.action) {
      case 'start': {
        const existingManaged = await discoverManagedDevServer(input.repoRoot);
        if (existingManaged) {
          const waitForReadyMs = input.waitForReadyMs ?? 90_000;
          const ready = existingManaged.debugPort
            ? await waitForDevtools({
                debugPort: existingManaged.debugPort,
                timeoutMs: waitForReadyMs,
                requireDevServerProcess: false
              })
            : { ready: false, reason: 'missing-debug-port' };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: ready.ready,
                  message: ready.ready
                    ? 'Adopted existing MCP-managed dev server'
                    : 'Found existing MCP-managed dev server, but CDP is not ready',
                  adopted: true,
                  source: existingManaged.source,
                  ready: ready.ready,
                  reason: ready.ready ? undefined : ready.reason,
                  pid: existingManaged.pid,
                  pgid: existingManaged.pgid,
                  repoRoot: existingManaged.repoRoot,
                  rendererPort: existingManaged.rendererPort,
                  debugPort: existingManaged.debugPort,
                  processId: DEV_SERVER_PROCESS_ID,
                  testUserDataDir: existingManaged.testUserDataDir,
                  webSocketDebuggerUrl: ready.webSocketDebuggerUrl,
                  hint: ready.ready
                    ? "Use processId='dev-server' with interaction tools. Use action 'stop' to clean it up."
                    : "Use action 'stop' to clean up this stale managed dev server, then retry start."
                }, null, 2)
              }
            ],
            isError: ready.ready ? undefined : true
          };
        }

        const requestedRendererPort = input.rendererPort ?? getRendererDevPort();
        const autoAlternatePort = input.autoAlternatePort ?? true;
        let rendererPort = requestedRendererPort;
        const portCheck = await checkPortAvailable('127.0.0.1', rendererPort);
        if (!portCheck.available && portCheck.code === 'EADDRINUSE') {
          if (autoAlternatePort) {
            const availablePort = await findAvailablePort(requestedRendererPort + 1, 10);
            if (availablePort) {
              rendererPort = availablePort;
            } else {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: `Renderer dev port ${requestedRendererPort} is already in use and no alternate port was available.`,
                      requestedRendererPort,
                      triedAlternateRange: `${requestedRendererPort + 1}-${requestedRendererPort + 10}`,
                      likelyCause: "You already have a dev server running (e.g. another 'npm run dev' in another terminal).",
                      whatToDo: [
                        `Stop the existing dev server (Ctrl+C in that terminal), then retry.`,
                        `Or kill the process using the port via: npm run dev:stop.`,
                        `Note: this MCP server can only reliably control the dev server it starts itself.`
                      ]
                    }, null, 2)
                  }
                ],
                isError: true
              };
            }
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Renderer dev port ${rendererPort} is already in use.` ,
                    likelyCause: "You already have a dev server running (e.g. another 'npm run dev' in another terminal).",
                    whatToDo: [
                      `Stop the existing dev server (Ctrl+C in that terminal), then retry.`,
                      `Or run your manual dev server on a different port (e.g. ELECTRON_RENDERER_PORT=5174 npm run dev).`,
                      `Or kill the process using the port via: npm run dev:stop.`,
                      `Note: this MCP server can only reliably control the dev server it starts itself.`
                    ]
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        }

        const result = startDevServer(input.repoRoot, { rendererPort });
        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: result.error,
                  ...(result.pid && { existingPid: result.pid })
                }, null, 2)
              }
            ],
            isError: true
          };
        }

        const waitForReadyMs = input.waitForReadyMs ?? 90_000;
        const ready = await waitForDevtools({ debugPort: result.debugPort, timeoutMs: waitForReadyMs });
        if (!ready.ready) {
          const failure = formatDevServerStartFailure({
            reason: ready.reason ?? 'unknown',
            rendererPort,
            debugPort: result.debugPort
          });
          const cleanup = await stopDevServer();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    ...failure,
                    cleanup
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Dev server started successfully',
                  ...(rendererPort !== requestedRendererPort && {
                    portFallback: {
                      requestedRendererPort,
                      actualRendererPort: rendererPort,
                      reason: 'requested-port-in-use'
                    }
                  }),
                ready: true,
                pid: result.pid,
                repoRoot: result.repoRoot,
                  rendererPort: result.rendererPort,
                debugPort: result.debugPort,
                processId: result.processId,
                testUserDataDir: result.testUserDataDir,
                webSocketDebuggerUrl: ready.webSocketDebuggerUrl,
                hint: "DevTools is reachable on the debugPort (CDP is ready). Use processId='dev-server' with interaction tools (get_page_state, click_button, fill_input, electron_evaluate). Use action 'logs' to see output."
              }, null, 2)
            }
          ]
        };
      }

      case 'stop': {
        const result = await stopDevServer();
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Dev server stopped',
                  pid: result.pid,
                  pgid: result.pgid,
                  cleanupStages: result.cleanupStages
                }, null, 2)
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: result.error,
                  pid: result.pid,
                  pgid: result.pgid,
                  cleanupStages: result.cleanupStages
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      case 'status': {
        const status = await getDevServerStatus();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(status, null, 2)
            }
          ]
        };
      }

      case 'logs': {
        const logLines = input.logLines ?? 50;
        const logs = getDevServerLogs(logLines);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...logs,
                hint: logs.totalLines === 0
                  ? "No output captured yet. The dev server may still be starting."
                  : logs.truncated
                    ? `Showing last ${logs.linesReturned} of ${logs.totalLines} lines. Use 'logLines' param for more.`
                    : undefined
              }, null, 2)
            }
          ]
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown action: ${input.action}` })
            }
          ],
          isError: true
        };
    }
  }
);

// Stage 3: Interaction wrapper tools ----------------------------------------
// These provide high-level abstractions over electron_evaluate for common UI interactions

server.registerTool(
  ELECTRON_TOOLS.CLICK_BUTTON,
  {
    title: 'Click button or clickable element',
    description: `Click a button or clickable element in the Electron app's renderer.
Find elements by:
- testId: data-testid attribute (recommended, most reliable)
- text: button text content (searches buttons, [role="button"], checkboxes, radios)
- selector: CSS selector (for advanced cases)

The element will be clicked via JavaScript .click() method.`,
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: clickButtonSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);

    let jsCode;
    if (input.testId) {
      // SECURITY: Use JSON.stringify for safe escaping of user input
      const safeTestId = JSON.stringify(input.testId);
      jsCode = `
        (() => {
          try {
            const el = document.querySelector('[data-testid="' + ${safeTestId} + '"]');
            if (el) {
              el.click();
              return { success: true, tag: el.tagName.toLowerCase(), testId: ${safeTestId} };
            }
            return { success: false, error: 'Element with testId not found', testId: ${safeTestId} };
          } catch (e) {
            return { success: false, error: e.message || 'Unknown error', testId: ${safeTestId} };
          }
        })()
      `;
    } else if (input.text) {
      const safeText = JSON.stringify(input.text);
      jsCode = `
        (() => {
          try {
            const searchText = ${safeText};
            const btns = [...document.querySelectorAll('button, [role="button"], input[type="checkbox"], input[type="radio"], a')];
            const btn = btns.find(b => 
              b.textContent?.includes(searchText) || 
              b.innerText?.includes(searchText) ||
              b.getAttribute('aria-label')?.includes(searchText)
            );
            if (btn) {
              btn.click();
              return { success: true, tag: btn.tagName.toLowerCase(), text: btn.textContent?.slice(0, 50) };
            }
            return { success: false, error: 'Element with text not found', searchText };
          } catch (e) {
            return { success: false, error: e.message || 'Unknown error' };
          }
        })()
      `;
    } else if (input.selector) {
      const safeSelector = JSON.stringify(input.selector);
      jsCode = `
        (() => {
          try {
            const el = document.querySelector(${safeSelector});
            if (el) {
              el.click();
              return { success: true, tag: el.tagName.toLowerCase(), selector: ${safeSelector} };
            }
            return { success: false, error: 'Element with selector not found', selector: ${safeSelector} };
          } catch (e) {
            return { success: false, error: e.message || 'Unknown error', selector: ${safeSelector} };
          }
        })()
      `;
    }

    const payload = await executeCdpCommand(input.processId, targetId, 'Runtime', 'evaluate', {
      expression: jsCode,
      returnByValue: true
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload.result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.FILL_INPUT,
  {
    title: 'Fill input field',
    description: `Fill an input or textarea field in the Electron app's renderer.
Find inputs by:
- testId: data-testid attribute (recommended, most reliable)
- placeholder: placeholder text
- selector: CSS selector (for advanced cases)

Uses React-compatible native setter pattern to properly trigger React's synthetic event system.`,
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: fillInputSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);

    // SECURITY: Use JSON.stringify for safe escaping of user input
    const safeValue = JSON.stringify(input.value);
    
    let selectorExpr;
    if (input.testId) {
      selectorExpr = JSON.stringify(`[data-testid="${input.testId}"]`);
    } else if (input.placeholder) {
      // Escape placeholder for use in CSS attribute selector
      const safePlaceholder = input.placeholder.replace(/"/g, '\\"');
      selectorExpr = JSON.stringify(`input[placeholder*="${safePlaceholder}"], textarea[placeholder*="${safePlaceholder}"]`);
    } else {
      selectorExpr = JSON.stringify(input.selector);
    }

    // Use native setter for React controlled inputs compatibility
    const jsCode = `
      (() => {
        try {
          const el = document.querySelector(${selectorExpr});
          if (!el) {
            return { success: false, error: 'Input element not found', selector: ${selectorExpr} };
          }
          
          // Verify element is actually an input or textarea
          const isInput = el instanceof HTMLInputElement;
          const isTextarea = el instanceof HTMLTextAreaElement;
          if (!isInput && !isTextarea) {
            return { success: false, error: 'Element is not an input or textarea', tag: el.tagName.toLowerCase(), selector: ${selectorExpr} };
          }
          
          // Focus the element first
          el.focus();
          
          // Use native setter to trigger React's synthetic event system
          // This is necessary for React controlled inputs that override the value setter
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
          )?.set;
          
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, ${safeValue});
          } else {
            el.value = ${safeValue};
          }
          
          // Dispatch events for React to pick up
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          
          return { 
            success: true, 
            tag: el.tagName.toLowerCase(), 
            value: el.value,
            selector: ${selectorExpr}
          };
        } catch (e) {
          return { success: false, error: e.message || 'Unknown error', selector: ${selectorExpr} };
        }
      })()
    `;

    const payload = await executeCdpCommand(input.processId, targetId, 'Runtime', 'evaluate', {
      expression: jsCode,
      returnByValue: true
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload.result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.GET_PAGE_STATE,
  {
    title: 'Get current page state',
    description: `Get the current state of the Electron app's renderer page.
Returns:
- title: document title
- url: current URL
- testIds: list of elements with data-testid (up to 50)
- visibleText: first 2000 chars of visible body text

Useful for understanding the current UI state before performing interactions.`,
        annotations: { readOnlyHint: true },
inputSchema: getPageStateSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);

    const jsCode = `
      (() => {
        try {
          const testIds = [...document.querySelectorAll('[data-testid]')]
            .slice(0, 50)
            .map(el => ({
              testId: el.dataset.testid,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').slice(0, 50).trim(),
              visible: el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0
            }));
          
          return {
            success: true,
            title: document.title,
            url: window.location.href,
            testIds,
            visibleText: (document.body?.innerText || '').slice(0, 2000),
            testIdCount: document.querySelectorAll('[data-testid]').length
          };
        } catch (e) {
          return { success: false, error: e.message || 'Unknown error' };
        }
      })()
    `;

    const payload = await executeCdpCommand(input.processId, targetId, 'Runtime', 'evaluate', {
      expression: jsCode,
      returnByValue: true
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload.result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  ELECTRON_TOOLS.TAKE_SCREENSHOT,
  {
    title: 'Take screenshot',
    description: `Capture a screenshot of the Electron app's renderer page.
Options:
- processId: required, the electron process ID (e.g., 'dev-server')
- targetId: optional, specific CDP target ID
- filename: optional, filename without extension (default: screenshot_<timestamp>)
- format: optional, 'png' | 'jpeg' | 'webp' (default: 'png')
- includeBase64: optional, whether to include base64 data in response (default: false)

Saves to docs/project/ux_testing/reports/screenshots/. Returns file path; optionally includes base64.`,
        annotations: { readOnlyHint: true },
inputSchema: takeScreenshotSchema
  },
  async (input) => {
    const descriptor = getProcessOrThrow(input.processId);
    const targetId = await pickTargetId(descriptor, input.targetId);
    const format = input.format ?? 'png';

    // Generate filename if not provided
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
    let filename = input.filename ?? `screenshot_${timestamp}`;
    
    // SECURITY: Sanitize filename to prevent path traversal
    // Extract only the basename and remove any path separators or traversal attempts
    filename = path.basename(filename).replace(/\.\./g, '');
    if (!filename || filename === '.' || filename === '..') {
      filename = `screenshot_${timestamp}`;
    }
    
    const extension = format === 'jpeg' ? 'jpg' : format;
    const fullFilename = `${filename}.${extension}`;

    // Determine screenshot directory (relative to repo root)
    const repoRoot = findRepoRoot() ?? process.cwd();
    const screenshotDir = path.join(repoRoot, 'docs', 'project', 'ux_testing', 'reports', 'screenshots');

    // Ensure directory exists
    await fs.promises.mkdir(screenshotDir, { recursive: true });

    const filePath = path.join(screenshotDir, fullFilename);
    
    // SECURITY: Verify the final path is still within screenshotDir
    if (!isPathSafe(fullFilename, screenshotDir)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Invalid filename: path traversal detected'
            }, null, 2)
          }
        ],
        isError: true
      };
    }

    try {
      // Capture screenshot via CDP
      const result = await executeCdpCommand(input.processId, targetId, 'Page', 'captureScreenshot', {
        format: format
      });

      const base64Data = result.result?.data;
      if (!base64Data) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'CDP captureScreenshot did not return image data'
              }, null, 2)
            }
          ],
          isError: true
        };
      }

      // Write to file
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.promises.writeFile(filePath, buffer);

      const response = {
        success: true,
        path: filePath,
        relativePath: path.relative(repoRoot, filePath),
        format: format,
        sizeBytes: buffer.length
      };
      
      // Only include base64 if explicitly requested (to avoid bloating responses)
      if (input.includeBase64) {
        response.base64 = base64Data;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: e.message ?? 'Unknown error capturing screenshot'
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  }
);

// Boot server --------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[electron-mcp] server ready on stdio');

const shutdown = async () => {
  // Stop dev server if running
  try {
    await stopDevServer();
  } catch {
    // ignore
  }

  // Stop all Electron processes
  for (const descriptor of electronProcesses.values()) {
    try {
      descriptor.process?.kill();
    } catch {
      // ignore
    }
  }
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
