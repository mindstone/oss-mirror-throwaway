/**
 * One-shot screenshot of a running --rebel-test app over CDP.
 *
 * Connects via Playwright `connectOverCDP`, picks the first non-DevTools page
 * (in dev mode the first CDP target is often the DevTools window — the classic
 * wrong-surface-screenshot trap that resources/mcp/electron-debug/cdp-screenshot.cjs
 * falls into without an explicit targetId), screenshots it, and disconnects.
 * Read-only: never closes or mutates the app.
 *
 * Usage (app launched via scripts/ui-test/launch-rebel-test.ts --keep-alive):
 *   npx tsx scripts/ui-test/screenshot.ts --out /tmp/shot.png
 *   npx tsx scripts/ui-test/screenshot.ts --cdp-port 9222 --out /tmp/shot.png
 *
 * CJS file (repo has no "type":"module"): run via `npx tsx`, no top-level await.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const val = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};

const cdpPort = Number(val('--cdp-port') ?? 9222);
const outPath = val('--out');

void (async () => {
  if (!outPath) {
    console.error('Usage: npx tsx scripts/ui-test/screenshot.ts [--cdp-port <n>] --out <path.png>');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15_000 });
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((p) => !p.url().startsWith('devtools://'));
    if (!page) {
      console.error(`No non-DevTools page target on CDP port ${cdpPort} (targets: ${pages.map((p) => p.url()).join(', ') || 'none'}).`);
      process.exit(1);
    }
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`[screenshot] ${page.url()} → ${outPath}`);
  } finally {
    await browser.close(); // connectOverCDP: disconnects only, does not kill the app
  }
})().catch((err: unknown) => {
  console.error(`[screenshot] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
