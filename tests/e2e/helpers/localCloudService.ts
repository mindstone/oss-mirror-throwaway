import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

/**
 * Shared E2E helper for spawning a real local cloud-service that desktop E2E specs
 * sync against (Slack listener / inbound-author-policy). Single source of truth for
 * the two specs that previously hand-rolled an identical copy of this logic.
 *
 * Intentionally SEPARATE from the cloud-sync harness's
 * `src/test-utils/cloudHarness/localCloudServiceFixture.ts`: that one is the SSOT
 * for vitest cloud-sync tests (HTTP `/api/health` readiness, `NODE_ENV=test` +
 * mock-agent runtime preset). The E2E specs run in Playwright's loader (which
 * resolves no path aliases) and need a different runtime profile —
 * `NODE_ENV=development`, stdout-logline readiness, a per-pid build outdir, and the
 * caller's Slack mock env. Forcing the cloud-sync preset onto these specs would
 * change cloud-service behaviour they don't cover (REBEL_MOCK_AGENT_TURNS swaps the
 * agent executor; NODE_ENV=test suppresses cloud builtins + flips test-only seams).
 * See docs/plans/260606_flake-investigation/APPENDIX_shared_local_cloud_e2e_harness.md.
 *
 * Keep this module free of `@playwright/test` and other tests/e2e imports so it can
 * be type-checked via tsconfig.node.json (the E2E specs themselves are not).
 */

/** Stdout marker the cloud-service prints once it is listening. */
export const READY_MARKER = '[ready] Rebel Cloud Service listening on port';

export interface LocalCloudService {
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartLocalCloudServiceForE2EOptions {
  /** Cloud-service auth token (REBEL_CLOUD_TOKEN). */
  token: string;
  /**
   * Extra/override server env (e.g. Slack mock vars: SLACK_API_BASE_URL,
   * SLACK_SIGNING_SECRET, MINDSTONE_SLACK_CLIENT_ID/SECRET). Spread last so a caller
   * can also override NODE_ENV if it ever needs to.
   */
  env?: Record<string, string>;
  /** Relative dir (under cwd) for the cloud-service's isolated REBEL_USER_DATA. */
  userDataPrefix: string;
  /** Readiness budget. Default: CI ? 90s : 30s — CI runners are slower/contended. */
  readyTimeoutMs?: number;
}

let cloudBundlePromise: Promise<string> | null = null;

/**
 * Builds the cloud-service bundle once per process to a per-pid outdir (avoids
 * contention/staleness with a shared `cloud-service/dist`) and returns server.mjs.
 */
export function getCloudServiceBundleEntry(): Promise<string> {
  if (!cloudBundlePromise) {
    cloudBundlePromise = Promise.resolve().then(() => {
      const relativeOutdir = path.join('tmp', 'e2e-cloud-service-bundle', String(process.pid));
      const result = spawnSync(process.execPath, ['cloud-service/build.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLOUD_SERVICE_BUILD_OUTDIR: relativeOutdir,
        },
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (result.status !== 0) {
        throw new Error(`Cloud-service test bundle failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
      }
      return path.join(process.cwd(), relativeOutdir, 'server.mjs');
    });
  }
  return cloudBundlePromise;
}

function waitForFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a local cloud-service port')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Spawn the local cloud-service and resolve once it logs READY_MARKER. Rejects on
 * timeout (logs included) or early exit. Returns `{ baseUrl, stop }`.
 */
export async function startLocalCloudServiceForE2E(
  opts: StartLocalCloudServiceForE2EOptions,
): Promise<LocalCloudService> {
  const port = await waitForFreePort();
  const serverEntry = await getCloudServiceBundleEntry();
  const cloudUserData = path.join(process.cwd(), opts.userDataPrefix, String(Date.now()));
  const readyTimeoutMs = opts.readyTimeoutMs ?? (process.env.CI ? 90_000 : 30_000);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      REBEL_USER_DATA: cloudUserData,
      REBEL_CLOUD_TOKEN: opts.token,
      NODE_ENV: 'development',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for local cloud service. Logs:\n${logs.join('')}`));
    }, readyTimeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      logs.push(text);
      if (text.includes(READY_MARKER)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Local cloud service exited early (${code ?? signal}). Logs:\n${logs.join('')}`));
    });
  });

  await ready;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => stopChild(child),
  };
}
