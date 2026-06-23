import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const START_TIMEOUT_MS = 120_000;
const BUNDLE_TIMEOUT_MS = 180_000;
const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createBundleUrl(port) {
  return `http://127.0.0.1:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true&minify=false`;
}

function createReadline(stream, onLine) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', onLine);
  return rl;
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(start = 8082, end = 8120) {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port in range ${start}-${end}`);
}

async function waitForProcessExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function stopExpoServer(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  const exitedAfterTerm = await waitForProcessExit(child);
  if (exitedAfterTerm) {
    return;
  }

  child.kill('SIGKILL');
  await waitForProcessExit(child, 2_000);
}

async function startExpoServer(port) {
  const logs = [];
  const child = spawn(npmCmd, ['exec', '--', 'expo', 'start', '--clear', '--port', String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const readyRegexes = [
    new RegExp(`Waiting on http://localhost:${port}`),
    new RegExp(`Metro waiting on .*:${port}`),
  ];

  let isReady = false;
  let markReady = null;
  let failReady = null;
  const readyPromise = new Promise((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });

  const onLine = (line) => {
    logs.push(line);
    if (!isReady && readyRegexes.some((regex) => regex.test(line))) {
      isReady = true;
      markReady();
    }
  };

  const stdoutRl = createReadline(child.stdout, onLine);
  const stderrRl = createReadline(child.stderr, onLine);

  child.once('error', (error) => {
    if (!isReady) {
      failReady(error);
    }
  });

  child.once('exit', (code, signal) => {
    if (!isReady) {
      failReady(
        new Error(
          `Expo exited before startup (code=${String(code)}, signal=${String(signal)})\n${logs.slice(-40).join('\n')}`,
        ),
      );
    }
  });

  const timeout = setTimeout(() => {
    if (!isReady) {
      failReady(new Error(`Timed out waiting ${START_TIMEOUT_MS}ms for Expo server startup`));
    }
  }, START_TIMEOUT_MS);

  await readyPromise;
  clearTimeout(timeout);

  return {
    child,
    closeReadlines: () => {
      stdoutRl.close();
      stderrRl.close();
    },
  };
}

async function fetchBundle(bundleUrl) {
  const deadline = Date.now() + BUNDLE_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      const response = await fetch(bundleUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/javascript',
        },
      });
      clearTimeout(timeout);

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Bundle request failed with HTTP ${response.status}: ${body.slice(0, 1_000)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      await sleep(1_500);
    }
  }

  throw new Error(`Timed out fetching Metro bundle: ${String(lastError)}`);
}

function validateBundle(bundleText) {
  const duplicateDependencyRegex = /cloud-client[\\/]+node_modules[\\/]+(react|zustand)[\\/]/g;
  const duplicateMatches = [...bundleText.matchAll(duplicateDependencyRegex)].slice(0, 10).map((match) => match[0]);
  if (duplicateMatches.length > 0) {
    throw new Error(
      `Bundle contains forbidden duplicate dependencies from cloud-client node_modules: ${duplicateMatches.join(', ')}`,
    );
  }

  const reactPathRegex = /"([^"\n]*node_modules\/react\/index\.js)"\)/g;
  const reactPaths = [...new Set([...bundleText.matchAll(reactPathRegex)].map((match) => match[1]))];
  if (reactPaths.length !== 1) {
    throw new Error(`Expected exactly one React module path, found ${reactPaths.length}: ${reactPaths.join(', ')}`);
  }

  if (!/cloud-client[\\/]+src[\\/]/.test(bundleText)) {
    throw new Error('Bundle does not include cloud-client source files, package resolution may be broken.');
  }
}

async function main() {
  const port = await findAvailablePort();
  const bundleUrl = createBundleUrl(port);

  console.log(`[runtime-integrity] Starting Expo on port ${port}`);
  const { child, closeReadlines } = await startExpoServer(port);

  try {
    console.log('[runtime-integrity] Fetching Metro iOS bundle');
    const bundle = await fetchBundle(bundleUrl);
    validateBundle(bundle);
    console.log('[runtime-integrity] Passed');
  } finally {
    closeReadlines();
    await stopExpoServer(child);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('[runtime-integrity] Failed');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  },
);
