import { expect, test } from '@playwright/test';
import {
  assertExtensionBuilt,
  evaluateInExtensionServiceWorker,
  launchExtensionBrowserForE2E,
  makeStateDir,
  skipIfHeadlessLinux,
  startTestBridge,
  TEST_APP_ID,
  TEST_CLIENT_ID,
} from './helpers';

const BRIDGE_BROWSER_PORTS = [52320, 52321, 52322, 52323, 52324, 52325];

test.describe('App Bridge — real extension intent roundtrip', () => {
  test.beforeEach(skipIfHeadlessLinux);

  test('extension intent survives bridge restart via persisted paired token', async ({}, testInfo) => {
    await assertExtensionBuilt();
    const stateDirectory = await makeStateDir(testInfo);
    const browser = await launchExtensionBrowserForE2E(testInfo);
    const { context, cdp, extensionId } = browser;

    try {
      const bridgeOptions = {
        stateDirectory,
        portCandidates: BRIDGE_BROWSER_PORTS,
        allowedChromeExtensionIds: [extensionId],
        intentHandlers: {
          createConversation: async () => ({
            conversationId: 'conv-e2e-real-intent',
            state: 'new' as const,
          }),
        },
      };

      const first = await startTestBridge(testInfo, bridgeOptions);
      let second:
        | Awaited<ReturnType<typeof startTestBridge>>
        | null = null;

      try {
        const pending = first.pairingStore.createPendingSession(TEST_APP_ID);
        const claim = first.pairingStore.claim(pending.code, {
          clientId: TEST_CLIENT_ID,
        });
        expect(claim.ok).toBe(true);
        if (!claim.ok) {
          throw new Error(`Expected direct pair-store claim to succeed, got ${claim.error}`);
        }

        await first.stop();

        second = await startTestBridge(testInfo, bridgeOptions);
        await expect
          .poll(
            () =>
              evaluateInExtensionServiceWorker<boolean>(
                cdp,
                extensionId,
                'Boolean(globalThis.__rebelE2E__)',
              ),
            { timeout: 10_000, intervals: [100, 200, 500] },
          )
          .toBe(true);
        await evaluateInExtensionServiceWorker(
          cdp,
          extensionId,
          `globalThis.__rebelE2E__.seedPairing({
            clientId: ${JSON.stringify(TEST_CLIENT_ID)},
            token: ${JSON.stringify(claim.token)},
          })`,
        );

        const page = await context.newPage();
        await page.goto('https://example.com/');
        const target = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          text: document.body?.innerText ?? '',
        }));

        const outcome = await evaluateInExtensionServiceWorker<{
          status: number;
          body: { conversationId?: string; state?: string } | null;
        }>(
          cdp,
          extensionId,
          `globalThis.__rebelE2E__.sendStoredConversationIntent({
            port: ${second.port},
            intent: 'summarise',
            target: ${JSON.stringify(target)},
          })`,
        );

        expect(outcome.status).toBe(200);
        expect(outcome.body).toMatchObject({
          conversationId: 'conv-e2e-real-intent',
          state: 'new',
        });
      } finally {
        await second?.stop();
      }
    } finally {
      await browser.close();
    }
  });
});
