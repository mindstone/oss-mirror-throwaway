/**
 * Stage 9 Scenario 6 — offscreen-respawn
 *
 * Chrome MV3 service workers are ephemeral. The Rebel extension keeps the
 * WS alive on an offscreen document, but a hard termination (service worker
 * killed) forces reconnection. This scenario simulates that: after
 * disconnect + reconnect on the same `appId` + `clientId`, a subsequent
 * `read_page` command must succeed.
 *
 * Rather than drive chrome.management (which requires permissions we don't
 * grant to the test extension), we simulate the respawn by closing the
 * WS explicitly and reconnecting with the same credentials.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 */
import { expect, test } from '@playwright/test';
import {
  connectFakeExtension,
  pairAsExtension,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
  TEST_CLIENT_ID,
} from './helpers';

test.describe('App Bridge — offscreen WS respawn', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('abrupt WS termination → reconnect with same token → commands resume', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const { token } = await pairAsExtension(handle);

      const first = await connectFakeExtension(handle, token, {
        commandHandler: async () => ({
          success: true,
          data: { text: 'first-run', title: 't', url: 'u' },
        }),
      });

      // Initial sanity: a read_page works through `first`.
      const r1 = await fetch(
        `http://127.0.0.1:${handle.port}/apps/${TEST_APP_ID}/read_page`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.routerInternalToken}`,
            'x-rebel-app-id': TEST_APP_ID,
          },
          body: JSON.stringify({ payload: { tabContext: { tabId: 1 } } }),
        },
      );
      expect(r1.status).toBe(200);

      // Simulate offscreen termination: rip the socket, wait for the bridge
      // to see the unregister, then reconnect with the same credentials.
      first.ws.terminate();
      await expect
        .poll(
          () =>
            handle.capabilityRegistry.getCapabilities(TEST_APP_ID) === undefined,
          { timeout: 5_000, intervals: [50, 100, 200, 400] },
        )
        .toBe(true);

      const second = await connectFakeExtension(handle, token, {
        clientId: TEST_CLIENT_ID, // same clientId → supersede semantics
        commandHandler: async () => ({
          success: true,
          data: { text: 'second-run', title: 't', url: 'u' },
        }),
      });

      const r2 = await fetch(
        `http://127.0.0.1:${handle.port}/apps/${TEST_APP_ID}/read_page`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.routerInternalToken}`,
            'x-rebel-app-id': TEST_APP_ID,
          },
          body: JSON.stringify({ payload: { tabContext: { tabId: 1 } } }),
        },
      );
      expect(r2.status).toBe(200);
      const body = (await r2.json()) as { data: { text: string } };
      expect(body.data.text).toBe('second-run');

      await second.close();
    } finally {
      await handle.stop();
    }
  });
});
