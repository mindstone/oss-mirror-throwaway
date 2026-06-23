/**
 * Stage 9 Scenario 7 — token-revoke
 *
 * When the user revokes a paired client from Settings, the next request
 * the extension attempts must surface an authentication failure the popup
 * can turn into a "please re-pair" state. This scenario verifies:
 *
 *   - Revoke via `tokenStore.revokeAppTokensByClientId` immediately
 *     removes the pairing.
 *   - A WS `auth` with the revoked token closes the socket with a 4001
 *     (UNAUTHORIZED) — the popup should present the "re-pair" CTA.
 *   - A `/pair/revoke` with the revoked token now yields 401, matching
 *     what the extension would see on a subsequent call.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 */
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import {
  pairAsExtension,
  postJson,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
  TEST_CLIENT_ID,
  TEST_EXT_ID,
} from './helpers';

test.describe('App Bridge — token revoke', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('revoke by clientId → subsequent WS auth closes with 4001', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const { token } = await pairAsExtension(handle);
      expect(handle.tokenStore.listAppTokens()).toHaveLength(1);

      // Revoke from the "Settings" surface via the manager snapshot path.
      const revoked =
        handle.tokenStore.revokeAppTokensByClientId(TEST_CLIENT_ID);
      expect(revoked).toBe(1);
      expect(handle.tokenStore.listAppTokens()).toHaveLength(0);

      // Now reconnect — authenticating with the dead token must be rejected.
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        headers: {
          origin: `chrome-extension://${TEST_EXT_ID}`,
          host: `127.0.0.1:${handle.port}`,
        },
      });

      const closeCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for WS close')),
          5_000,
        );
        ws.once('open', () => {
          ws.send(
            JSON.stringify({
              type: 'auth',
              token,
              appId: TEST_APP_ID,
              clientId: TEST_CLIENT_ID,
            }),
          );
        });
        ws.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        ws.once('error', () => {
          // ws will also emit close; ignore error to avoid double-resolving.
        });
      });
      expect(closeCode).toBe(4001);

      // HTTP surface mirrors the story: `/pair/revoke` with the dead token
      // fails 401 (bridge no longer recognises the token).
      const revokeRes = await postJson(
        `http://127.0.0.1:${handle.port}/pair/revoke`,
        {},
        { authorization: `Bearer ${token}` },
      );
      expect(revokeRes.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });
});
