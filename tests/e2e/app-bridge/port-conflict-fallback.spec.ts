/**
 * Stage 9 Scenario 8 — port-conflict-fallback
 *
 * Pre-bind the preferred bridge port before `createAppBridge` runs. The
 * bridge must pick the next free port in the fallback range and the
 * state file must reflect the actual bound port. The extension's
 * `bridge-discovery.js` reads this state file, so a working fallback
 * means zero-touch recovery from port collisions.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 * @see resources/mcp/rebel-app-bridge/bridge-discovery.js
 */
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  BRIDGE_E2E_PORT_BASE,
  reserveFreePorts,
  skipIfHeadlessLinux,
  startTestBridge,
} from './helpers';

test.describe('App Bridge — port conflict fallback', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('preferred port taken → bridge binds next candidate + state file reflects it', async ({}, testInfo) => {
    const ports = await reserveFreePorts(BRIDGE_E2E_PORT_BASE + 50, 3);
    const [blocked, fallback1, fallback2] = ports;
    expect(blocked).toBeDefined();

    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(blocked, '127.0.0.1', () => resolve());
    });

    let handle: Awaited<ReturnType<typeof startTestBridge>> | null = null;
    try {
      handle = await startTestBridge(testInfo, {
        portCandidates: [blocked!, fallback1!, fallback2!],
      });
      expect(handle.port).not.toBe(blocked);
      expect([fallback1, fallback2]).toContain(handle.port);

      const state = JSON.parse(await fs.readFile(handle.stateFilePath, 'utf8')) as {
        port: number;
        pid: number;
        protocolVersion: string;
        routerToken: string;
      };
      expect(state.port).toBe(handle.port);
      expect(state.pid).toBe(process.pid);
      expect(state.protocolVersion).toBe('1.0');
      expect(state.routerToken.length).toBeGreaterThan(16);
    } finally {
      if (handle) {
        await handle.stop();
      }
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
