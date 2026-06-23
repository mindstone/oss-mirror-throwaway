import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

// SSOT for "spawn + await-ready a real local cloud-service for tests/spikes" in the
// vitest cloud-sync world (HTTP /api/health readiness, NODE_ENV=test + mock-agent
// preset). Pass extra/override server env via `env`.
//
// Cross-agent note (resolved 2026-06-06): the Playwright desktop-E2E specs
// (tests/e2e/messaging.spec.ts, inbound-author-policy.spec.ts) intentionally do NOT
// consume this fixture — they share their own `tests/e2e/helpers/localCloudService.ts`.
// Reason: they run in Playwright's loader (which resolves no path aliases) and need a
// different runtime profile (NODE_ENV=development, stdout-logline readiness, per-pid
// build outdir, no mock-agent/builtins-suppression preset). Forcing this fixture's
// preset onto them would change cloud-service behaviour they don't cover. Literal SSOT
// across both can be revisited if the E2E loader/type-check story is improved — see
// docs/plans/260606_flake-investigation/APPENDIX_shared_local_cloud_e2e_harness.md.
const DEFAULT_TOKEN = 'local-cloud-sync-harness-token';
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const OUTPUT_BUFFER_LIMIT = 128 * 1024;

export interface LocalCloudService {
  baseUrl: string;
  token: string;
  dataDir: string;
  workspaceDir: string;
  port: number;
  process: ChildProcess;
  /**
   * Bounded snapshot of the server's stdout+stderr so far (last 128 KiB of
   * each). Lets tests assert on bootstrap log sentinels, e.g. the
   * `sentry-enabled` / `sentry-disabled` structured lines.
   */
  getOutput(): string;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface StartLocalCloudOpts {
  repoRoot?: string;
  dataDir?: string;
  port?: number;
  token?: string;
  rebuild?: boolean;
  keepData?: boolean;
  env?: Record<string, string>;
  healthTimeoutMs?: number;
}

function findRepoRoot(startDir = process.cwd()): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, 'cloud-service'))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root containing cloud-service/ from ${startDir}`);
    }
    current = parent;
  }
}

function serverPath(repoRoot: string): string {
  return path.join(repoRoot, 'cloud-service', 'dist', 'server.mjs');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'cloudHarness.localCloudServiceFixture.fileExists',
      reason: 'access-failed-treated-as-absent',
      severity: 'debug',
      owner: 'test-utils.cloudHarness',
    });
    return false;
  }
}

function appendBounded(buffer: string, chunk: Buffer | string): string {
  const next = buffer + String(chunk);
  if (next.length <= OUTPUT_BUFFER_LIMIT) return next;
  return next.slice(next.length - OUTPUT_BUFFER_LIMIT);
}

async function runBuild(repoRoot: string): Promise<void> {
  const buildScript = path.join(repoRoot, 'cloud-service', 'build.mjs');
  let stdout = '';
  let stderr = '';

  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', [buildScript], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `cloud-service build failed code=${code ?? 'null'} signal=${signal ?? 'null'}\n` +
          `stdout:\n${stdout || '<empty>'}\n\nstderr:\n${stderr || '<empty>'}`,
        ),
      );
    });
  });
}

export async function ensureCloudServiceBuilt(repoRoot?: string): Promise<void> {
  const resolvedRoot = findRepoRoot(repoRoot);
  if (await fileExists(serverPath(resolvedRoot))) return;
  await runBuild(resolvedRoot);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a dynamic TCP port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, timeoutMs: number, getOutput: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `cloud-service exited before health check passed code=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}\n` +
        getOutput(),
      );
    }

    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (err) {
      // Server not accepting connections yet — keep polling until the timeout.
      ignoreBestEffortCleanup(err, {
        operation: 'cloudHarness.localCloudServiceFixture.waitForHealth',
        reason: 'health-poll-not-ready-yet',
        severity: 'debug',
        owner: 'test-utils.cloudHarness',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`cloud-service did not become healthy within ${timeoutMs}ms\n${getOutput()}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const waitForExit = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    waitForExit.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 7_000)),
  ]);

  if (!timedOut || child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGKILL');
  await Promise.race([
    waitForExit,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

export async function startLocalCloudService(opts: StartLocalCloudOpts = {}): Promise<LocalCloudService> {
  const repoRoot = findRepoRoot(opts.repoRoot);
  if (opts.rebuild) {
    await runBuild(repoRoot);
  } else {
    await ensureCloudServiceBuilt(repoRoot);
  }

  const port = opts.port ?? (await getFreePort());
  const token = opts.token ?? DEFAULT_TOKEN;
  const dataDir = opts.dataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-local-cloud-service-')));
  const workspaceDir = path.join(dataDir, 'workspace');
  await fsp.mkdir(workspaceDir, { recursive: true });

  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = '';
  let stderr = '';
  const child = spawn('node', [serverPath(repoRoot)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      REBEL_USER_DATA: dataDir,
      REBEL_CLOUD_TOKEN: token,
      IS_CLOUD_SERVICE: '1',
      REBEL_CLOUD_DISABLE_BOOTSTRAP_WARMUP: '1',
      REBEL_MOCK_AGENT_TURNS: '1',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });

  const getOutput = (): string => `stdout:\n${stdout || '<empty>'}\n\nstderr:\n${stderr || '<empty>'}`;

  try {
    await waitForHealth(baseUrl, child, opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS, getOutput);
  } catch (err) {
    await stopProcess(child);
    if (!opts.keepData) {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
    throw err;
  }

  let stopped = false;
  const service: LocalCloudService = {
    baseUrl,
    token,
    dataDir,
    workspaceDir,
    port,
    process: child,
    getOutput,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await stopProcess(child);
    },
    async cleanup(): Promise<void> {
      await service.stop();
      if (!opts.keepData) {
        await fsp.rm(dataDir, { recursive: true, force: true });
      }
    },
  };

  return service;
}
