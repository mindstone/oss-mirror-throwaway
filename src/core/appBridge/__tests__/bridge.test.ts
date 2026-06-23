import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { ErrorCode } from '@core/appBridge/shared/errors';
import type { ErrorReporter } from '@core/errorReporter';
import { CapabilityRegistry } from '@core/appBridge/server/capabilityRegistry';
import { CommandRouter } from '@core/appBridge/server/commandRouter';
import { ConnectionManager } from '@core/appBridge/server/connectionManager';
import { DEFAULT_APP_BRIDGE_PORT } from '@core/appBridge/shared/protocol';

/**
 * Windowed fallback ranges keep us off the real 52320–52325 production range
 * so tests never collide with a running bridge on the dev machine. We still
 * verify the default-range behavior in the dedicated "default port" test.
 */
let testPortBase = 53500;
const cleanupHandles: AppBridgeHandle[] = [];
const cleanupDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-bridge-stage2-'));
  cleanupDirs.push(dir);
  return dir;
}

function nextPortRange(count = 3): number[] {
  const start = testPortBase;
  testPortBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function bindHoldingServer(port: number): Promise<net.Server> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve());
  });
  return srv;
}

async function unbindHoldingServer(srv: net.Server): Promise<void> {
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

afterEach(async () => {
  while (cleanupHandles.length > 0) {
    const h = cleanupHandles.pop();
    if (h) await h.stop().catch(() => undefined);
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Reset dev-mode env so tests don't pick up stray process-level config.
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

describe('appBridge/server/bridge — createAppBridge (Stage 2)', () => {
  describe('Stage 1 baseline (still honoured)', () => {
    it('returns a handle with the expected shape', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      cleanupHandles.push(handle);

      expect(handle.port).toBeGreaterThan(0);
      // Stage 3 generates a base64url-encoded 32-byte token (≈ 43 chars).
      expect(typeof handle.routerInternalToken).toBe('string');
      expect(handle.routerInternalToken.length).toBeGreaterThanOrEqual(32);
      expect(handle.connectionManager).toBeInstanceOf(ConnectionManager);
      expect(handle.commandRouter).toBeInstanceOf(CommandRouter);
      expect(handle.capabilityRegistry).toBeInstanceOf(CapabilityRegistry);
      expect(typeof handle.stop).toBe('function');
    });

    it('stop() resolves cleanly and is safe to call multiple times', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      await expect(handle.stop()).resolves.toBeUndefined();
      await expect(handle.stop()).resolves.toBeUndefined();
    });

    it('accepts all Stage 2+ options without throwing', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
        allowedChromeExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
        devMode: true,
        intentHandlers: {
          createConversation: async () => ({ conversationId: 's_stub', state: 'new' }),
        },
      });
      cleanupHandles.push(handle);

      expect(handle.port).toBeGreaterThan(0);
    });
  });

  describe('Stage 2 — HTTP server + state file', () => {
    it('bridge binds on DEFAULT port 52320 when free', async () => {
      // Only run when 52320 is actually free; if another process holds it,
      // this scenario isn't observable and we skip rather than fail flakily.
      let holder: net.Server | null = null;
      try {
        holder = await bindHoldingServer(DEFAULT_APP_BRIDGE_PORT);
      } catch {
        // Port wasn't free — another local dev bridge is running. Skip.
        return;
      }
      await unbindHoldingServer(holder);

      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: [DEFAULT_APP_BRIDGE_PORT],
      });
      cleanupHandles.push(handle);
      expect(handle.port).toBe(DEFAULT_APP_BRIDGE_PORT);
    });

    it('bridge falls back to next port on EADDRINUSE', async () => {
      const [p1, p2, p3] = nextPortRange(3);
      const holder = await bindHoldingServer(p1);
      try {
        const stateDirectory = await makeStateDir();
        const handle = await createAppBridge({
          stateDirectory,
          portCandidates: [p1, p2, p3],
        });
        cleanupHandles.push(handle);
        // Bridge should have skipped p1 (we're holding it) and bound to p2.
        expect(handle.port).toBe(p2);
      } finally {
        await unbindHoldingServer(holder);
      }
    });

    it('state file written atomically with pid + port + protocolVersion + routerToken', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      cleanupHandles.push(handle);

      expect(handle.stateFilePath.endsWith('state.json')).toBe(true);
      const raw = await fs.readFile(handle.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        port: number;
        pid: number;
        protocolVersion: string;
        startedAt: string;
        routerToken: string;
      };
      expect(parsed.port).toBe(handle.port);
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.protocolVersion).toBe('1.0');
      expect(typeof parsed.startedAt).toBe('string');
      // Stage 4 (R5 / D13): the state file carries the router-internal token
      // so the RebelAppBridge stdio MCP server can authenticate its relay
      // calls without any other secret being shared on disk.
      expect(parsed.routerToken).toBe(handle.routerInternalToken);
      expect(parsed.routerToken.length).toBeGreaterThanOrEqual(32);
    });

    it('state file is written with mode 0o600 so only the owner can read routerToken', async () => {
      // This check is POSIX-only; Windows reports a different mode.
      if (process.platform === 'win32') return;
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      cleanupHandles.push(handle);

      const stat = await fs.stat(handle.stateFilePath);
      // Only the low 9 bits encode rwx-rwx-rwx; mask off the rest.
      const perms = stat.mode & 0o777;
      expect(perms).toBe(0o600);
    });

    it('shutdown removes state file', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      expect(await fileExists(handle.stateFilePath)).toBe(true);

      await handle.stop();
      expect(await fileExists(handle.stateFilePath)).toBe(false);
    });

    it('rehydrates hashed app tokens across restart without writing plaintext tokens to disk', async () => {
      const stateDirectory = await makeStateDir();
      const ports = nextPortRange();
      const first = await createAppBridge({
        stateDirectory,
        portCandidates: ports,
      });

      const token = first.tokenStore.issueAppToken(
        'browser-extension',
        'client-a',
        'fingerprint-a',
      );
      const rawState = await fs.readFile(first.stateFilePath, 'utf8');
      expect(rawState).not.toContain(token);

      await first.stop();
      expect(await fileExists(first.stateFilePath)).toBe(true);

      const second = await createAppBridge({
        stateDirectory,
        portCandidates: ports,
      });
      cleanupHandles.push(second);

      expect(
        second.tokenStore.verifyAppToken(token, {
          appId: 'browser-extension',
          clientId: 'client-a',
          fingerprint: 'fingerprint-a',
        }),
      ).toMatchObject({
        appId: 'browser-extension',
        clientId: 'client-a',
        fingerprint: 'fingerprint-a',
      });
    });

    it('does not report the expected "another live bridge owns state" conflict to Sentry (REBEL-5EB)', async () => {
      const stateDirectory = await makeStateDir();
      const stateFilePath = path.join(stateDirectory, 'state.json');

      // A throwaway, genuinely-alive process whose PID is distinct from this one,
      // so the ownership guard (existing.pid alive && !== process.pid) fires.
      const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
        stdio: 'ignore',
      });
      try {
        await new Promise<void>((resolve, reject) => {
          owner.once('spawn', () => resolve());
          owner.once('error', reject);
        });
        await fs.writeFile(
          stateFilePath,
          JSON.stringify({
            port: 65000,
            pid: owner.pid,
            protocolVersion: '1.0',
            startedAt: new Date().toISOString(),
            routerToken: 'r'.repeat(43),
          }),
          'utf8',
        );

        const captureException = vi.fn();
        const errorReporter = { captureException } as unknown as ErrorReporter;

        await expect(
          createAppBridge({
            stateDirectory,
            portCandidates: nextPortRange(),
            errorReporter,
          }),
        ).rejects.toMatchObject({ code: ErrorCode.BRIDGE_ALREADY_RUNNING });

        // REBEL-5EB: an expected ownership conflict must NOT be reported to Sentry.
        // In the non-ownership branch the catch WOULD call captureException, so this
        // also proves the expected-condition branch was taken.
        expect(captureException).not.toHaveBeenCalled();
      } finally {
        owner.kill('SIGKILL');
      }
    });

    it('revoked app tokens stay revoked after restart', async () => {
      const stateDirectory = await makeStateDir();
      const ports = nextPortRange();
      const first = await createAppBridge({
        stateDirectory,
        portCandidates: ports,
      });

      const token = first.tokenStore.issueAppToken('browser-extension', 'client-a');
      first.tokenStore.revokeAppToken(token);
      await first.stop();

      const second = await createAppBridge({
        stateDirectory,
        portCandidates: ports,
      });
      cleanupHandles.push(second);

      expect(
        second.tokenStore.verifyAppToken(token, {
          appId: 'browser-extension',
          clientId: 'client-a',
        }),
      ).toBeNull();
    });

    it('duplicate pid detection removes stale state file and re-binds', async () => {
      const stateDirectory = await makeStateDir();
      const ports = nextPortRange();

      // Seed a stale state file claiming a dead pid.
      const stateFilePath = path.join(stateDirectory, 'state.json');
      await fs.writeFile(
        stateFilePath,
        JSON.stringify({
          port: ports[0],
          pid: 1, // assume pid=1 is init — alive on POSIX, alive on Windows too.
          protocolVersion: '1.0',
          startedAt: new Date(0).toISOString(),
          routerToken: 'stale-token-for-test',
        }),
        'utf8',
      );

      // Replace pid with one guaranteed dead: pick a very high pid.
      const stalePid = await findDeadPid();
      await fs.writeFile(
        stateFilePath,
        JSON.stringify({
          port: ports[0],
          pid: stalePid,
          protocolVersion: '1.0',
          startedAt: new Date(0).toISOString(),
          routerToken: 'stale-token-for-test',
        }),
        'utf8',
      );

      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: ports,
      });
      cleanupHandles.push(handle);

      const raw = await fs.readFile(handle.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { pid: number };
      expect(parsed.pid).toBe(process.pid);
    });

    it('connection-manager disconnect rejects pending commands immediately', async () => {
      const stateDirectory = await makeStateDir();
      const handle = await createAppBridge({
        stateDirectory,
        portCandidates: nextPortRange(),
      });
      cleanupHandles.push(handle);

      const socket = {
        readyState: WebSocket.OPEN,
        send: (_payload: string, cb?: (error?: Error) => void) => cb?.(),
        close: () => {},
        terminate: () => {},
      } as unknown as WebSocket;

      handle.connectionManager.register({
        socket,
        appId: 'browser-extension',
        clientId: 'client-a',
        protocolVersion: '1.0',
        capabilities: [],
      });

      const pending = handle.commandRouter.dispatch({
        appId: 'browser-extension',
        capability: 'status',
        payload: {},
        timeoutMs: 5_000,
      });

      handle.connectionManager.disconnect('browser-extension', 'supersede');

      await expect(pending).rejects.toMatchObject({
        code: 'ADDIN_DISCONNECTED',
        status: 503,
      });
    });
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findDeadPid(): Promise<number> {
  // Walk down from a very high PID until we find one that can't be signalled.
  for (let pid = 900_000; pid > 1_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
    }
  }
  // Extremely unlikely; fall back to a sentinel the bridge will still treat
  // as "alive" (pid=1) — which means the test will fail loudly rather than
  // silently skipping, per "Silent failure is a bug".
  return 1;
}
