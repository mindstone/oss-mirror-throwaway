/**
 * Stage 9 Scenario 5 — click-destructive-reject
 *
 * A `rebel_browser_click` on a destructive control (e.g. `Delete Account`)
 * without explicit approval must be blocked at the extension boundary.
 * The relay surfaces a 502 with `code: SAFETY_BLOCKED` so the user surface
 * can render a "pending approval" state with brand-voice copy.
 *
 * Matches eval fixture 156 (`browser-click-destructive-element`).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 * @see evals/fixtures/safety-prompt/156_browser-control_click-destructive-element.json
 */
import { expect, test } from '@playwright/test';
import {
  connectFakeExtension,
  pairAsExtension,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
} from './helpers';

const DESTRUCTIVE_KEYWORDS = /delete|pay|cancel|uninstall|remove|unsubscribe/i;

test.describe('App Bridge — click destructive reject', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('click on "Delete Account" without approval → 502 SAFETY_BLOCKED', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const { token } = await pairAsExtension(handle);

      const conn = await connectFakeExtension(handle, token, {
        commandHandler: async (cmd) => {
          if (cmd.action !== 'click') {
            return { success: false, error: `unexpected action ${cmd.action}` };
          }
          const elementLabel = String(cmd.params['elementLabel'] ?? '');
          const destructiveLabel = Boolean(cmd.params['destructiveLabel']);
          const approved = Boolean(cmd.params['approved']);
          if (
            (destructiveLabel || DESTRUCTIVE_KEYWORDS.test(elementLabel)) &&
            !approved
          ) {
            return {
              success: false,
              code: 'SAFETY_BLOCKED',
              error: `I won't click destructive controls without explicit approval. Blocked: "${elementLabel}".`,
            };
          }
          return { success: true, data: { clicked: true } };
        },
      });

      const relayRes = await fetch(
        `http://127.0.0.1:${handle.port}/apps/${TEST_APP_ID}/click`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.routerInternalToken}`,
            'x-rebel-app-id': TEST_APP_ID,
          },
          body: JSON.stringify({
            payload: {
              tabContext: { tabId: 1, url: 'https://example.com/account' },
              selector: 'button#delete-account',
              elementLabel: 'Delete Account',
              destructiveLabel: true,
            },
          }),
        },
      );
      expect(relayRes.status).toBe(502);
      const body = (await relayRes.json()) as {
        success: boolean;
        code: string;
        message: string;
      };
      expect(body.success).toBe(false);
      expect(body.code).toBe('SAFETY_BLOCKED');
      expect(body.message).toMatch(/Delete Account/i);

      await conn.close();
    } finally {
      await handle.stop();
    }
  });
});
