/**
 * Stage 9 Scenario 4 — fill-form-safety-reject
 *
 * A sensitive field (password) submitted WITHOUT `includeSensitive: true`
 * must be denied. The bridge forwards the request, the extension side
 * refuses because the policy flag is missing, and the relay surfaces a
 * structured error the user surface can render with brand-voice copy.
 *
 * Matches eval fixture 154 (`browser-fill-credential-field`).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 * @see evals/fixtures/safety-prompt/154_browser-control_fill-credential-field.json
 */
import { expect, test } from '@playwright/test';
import {
  connectFakeExtension,
  pairAsExtension,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
} from './helpers';

test.describe('App Bridge — fill_form safety reject', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('password without includeSensitive → structured denial', async ({}, testInfo) => {
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
            sensitive?: boolean;
            includeSensitive?: boolean;
          }>;
          const deniedField = fields.find(
            (f) => f.sensitive === true && f.includeSensitive !== true,
          );
          if (deniedField) {
            return {
              success: false,
              code: 'SAFETY_BLOCKED',
              error: `I won't fill sensitive fields without explicit approval. Denied: ${deniedField.selector}.`,
            };
          }
          return { success: true, data: { filled: [] } };
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
                {
                  selector: '#password',
                  value: 'should-not-apply',
                  sensitive: true,
                },
              ],
            },
          }),
        },
      );
      // Extension reported a structured failure → bridge surfaces 502.
      expect(relayRes.status).toBe(502);
      const body = (await relayRes.json()) as {
        success: boolean;
        code: string;
        message: string;
      };
      expect(body.success).toBe(false);
      expect(body.code).toBe('SAFETY_BLOCKED');
      expect(body.message).toMatch(/sensitive fields/i);
      expect(body.message).toMatch(/approval/i);

      await conn.close();
    } finally {
      await handle.stop();
    }
  });
});
