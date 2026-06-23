/**
 * Stage 9 Scenario 3 — fill-form-happy
 *
 * When the agent explicitly sets `includeSensitive: true` on a password
 * field AND the user has granted per-field approval upstream (mocked
 * here via the relay caller), `fill_form` reaches the extension and
 * returns `success: true` with the set values.
 *
 * This test exercises the **bridge contract** end-to-end: the safety
 * layer sits upstream of the MCP relay (handled inside `toolSafetyService`)
 * and is not a bridge responsibility. The point of this scenario is that
 * once approval clears, the bridge correctly forwards the sensitive
 * payload to the extension.
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
} from './helpers';

test.describe('App Bridge — fill_form happy path', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('includeSensitive: true + approval → form fields filled via WS dispatch', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const { token } = await pairAsExtension(handle);

      const conn = await connectFakeExtension(handle, token, {
        commandHandler: async (cmd) => {
          if (cmd.action !== 'fill_form') {
            return { success: false, error: `unexpected action ${cmd.action}` };
          }
          const fields = cmd.params['fields'] as Array<{
            selector: string;
            includeSensitive?: boolean;
          }>;
          return {
            success: true,
            data: {
              filled: fields.map((f) => ({
                selector: f.selector,
                applied: true,
                sensitiveApproved: f.includeSensitive === true,
              })),
            },
          };
        },
      });

      const relayRes = await fetch(
        `http://127.0.0.1:${handle.port}/apps/${TEST_APP_ID}/fill_form`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.routerInternalToken}`,
            'x-rebel-app-id': TEST_APP_ID,
          },
          body: JSON.stringify({
            payload: {
              tabContext: { tabId: 1, url: 'https://example.com/login' },
              fields: [
                { selector: '#email', value: 'jo@example.com' },
                {
                  selector: '#password',
                  value: 'correct horse battery staple',
                  sensitive: true,
                  includeSensitive: true,
                },
              ],
            },
          }),
        },
      );
      expect(relayRes.status).toBe(200);
      const body = (await relayRes.json()) as {
        success: boolean;
        data: {
          filled: Array<{
            selector: string;
            applied: boolean;
            sensitiveApproved: boolean;
          }>;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.filled).toHaveLength(2);
      const pw = body.data.filled.find((f) => f.selector === '#password');
      expect(pw?.sensitiveApproved).toBe(true);

      await conn.close();
    } finally {
      await handle.stop();
    }
  });
});
