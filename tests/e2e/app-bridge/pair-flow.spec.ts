/**
 * Stage 9 Scenario 1 — pair-flow
 *
 * Validates the end-to-end 6-digit pairing flow: mint a code via
 * `/pair/start`, claim it via `/pair/claim`, then open a WebSocket with
 * the issued token. A successful `register → registered` handshake and a
 * non-empty paired-client list prove both surfaces agree the connection
 * is live.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 */
import { expect, test } from '@playwright/test';
import {
  connectFakeExtension,
  pairAsExtension,
  postJson,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
} from './helpers';

test.describe('App Bridge — pair flow', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('6-digit code mints a token that unlocks the WS surface', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      // Step 1 — mint the pair code (dev-mode `/pair/start` is permitted).
      const startRes = await postJson(`${base}/pair/start`, {
        appId: TEST_APP_ID,
      });
      expect(startRes.status).toBe(200);
      const body = startRes.body as { code: string; expiresAt: number };
      expect(body.code).toMatch(/^\d{6}$/);
      expect(body.expiresAt).toBeGreaterThan(Date.now());

      // Step 2 — claim it and expect a token.
      const { token } = await pairAsExtension(handle);
      expect(token.length).toBeGreaterThan(16);

      // Step 3 — token is a valid WS credential.
      const conn = await connectFakeExtension(handle, token);

      // Step 4 — the bridge sees exactly one paired client.
      const paired = handle.tokenStore.listAppTokens();
      expect(paired.length).toBe(1);
      expect(paired[0]?.appId).toBe(TEST_APP_ID);

      await conn.close();
    } finally {
      await handle.stop();
    }
  });
});
