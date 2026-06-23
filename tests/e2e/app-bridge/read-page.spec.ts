/**
 * Stage 9 Scenario 2 — read-page
 *
 * Simulates the happy path where the agent calls `rebel_browser_read_page`
 * through the MCP relay, the bridge dispatches to the paired extension,
 * and the extension returns extracted article text. We use a fixture HTML
 * file (`fixtures/fixture-article.html`) so the content is deterministic.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 9)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  connectFakeExtension,
  pairAsExtension,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
} from './helpers';

test.describe('App Bridge — read_page relay', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('MCP relay → WS dispatch → extension response returns article text', async ({}, testInfo) => {
    const handle = await startTestBridge(testInfo);
    try {
      const { token } = await pairAsExtension(handle);

      const fixturePath = path.join(
        __dirname,
        'fixtures',
        'fixture-article.html',
      );
      const fixtureHtml = await fs.readFile(fixturePath, 'utf8');

      const conn = await connectFakeExtension(handle, token, {
        commandHandler: async (cmd) => {
          if (cmd.action !== 'read_page') {
            return { success: false, error: `unexpected action ${cmd.action}` };
          }
          // The extension content script would parse textContent here; for
          // the E2E we just assert a non-empty body and echo the expected
          // shape the real script emits.
          return {
            success: true,
            data: {
              title: 'Stripe pricing — Fixture Article',
              url: `file://${fixturePath}`,
              text: fixtureHtml
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 5000),
            },
          };
        },
      });

      const relayRes = await fetch(
        `http://127.0.0.1:${handle.port}/apps/${TEST_APP_ID}/read_page`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.routerInternalToken}`,
            'x-rebel-app-id': TEST_APP_ID,
          },
          body: JSON.stringify({
            payload: {
              tabContext: { tabId: 1, url: `file://${fixturePath}` },
              maxChars: 5000,
            },
          }),
        },
      );
      expect(relayRes.status).toBe(200);
      const relayBody = (await relayRes.json()) as {
        success: boolean;
        data: { text: string; title: string };
      };
      expect(relayBody.success).toBe(true);
      expect(relayBody.data.title).toContain('Stripe pricing');
      expect(relayBody.data.text).toContain('pay-as-you-go');
      expect(relayBody.data.text).toContain('Rebel');

      await conn.close();
    } finally {
      await handle.stop();
    }
  });
});
