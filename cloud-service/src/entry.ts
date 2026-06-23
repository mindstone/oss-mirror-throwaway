/**
 * Cloud Service Entry Point
 *
 * Runs the pre-bootstrap watchdog BEFORE any heavy server module evaluates,
 * then dynamically imports `./server` to start the actual cloud service.
 *
 * Why a separate entry shim (Decision D10):
 *   - If the watchdog logic lives inside server.ts, a crash in server.ts'
 *     module-init code (e.g. an import-time throw) bypasses the watchdog
 *     entirely — exactly the failure mode that bricked dev-37738d9 in
 *     production. This shim runs in a separate module that imports nothing
 *     heavy until the watchdog has armed.
 *   - The shim's only imports are `node:fs`, `node:console`, and the
 *     watchdog. The watchdog itself reaches into `@core/services/flyApiClient`
 *     for the rollback primitive, but that path does not crash on its own
 *     and is the canonical implementation we already trust.
 *
 * Outcomes:
 *   - `recovered` → Fly will restart this machine with the LKG image; we
 *     exit(0) so the restart is intentional, not a crash.
 *   - any other outcome → fall through to `import('./server.mjs')`, which
 *     either boots normally or fails in the same way as before, but with
 *     the boot-state record now updated for the NEXT boot's watchdog.
 *
 * Stage C2 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 */

import path from 'node:path';
import { runPreBootstrapWatchdog, type WatchdogEvent } from './preBootstrapWatchdog';
import { assertTestDataRootSafe } from './testDataRootGuard';

declare const __BUILD_COMMIT__: string | undefined;
declare const __SCHEMA_FINGERPRINT__: string | undefined;

function emit(event: WatchdogEvent): void {
  try {
    console.error(`[watchdog] ${JSON.stringify(event)}`);
  } catch {
    console.error(`[watchdog] ${event.kind}`);
  }
}

async function main(): Promise<void> {
  assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'cloud entry REBEL_USER_DATA' });
  const dataDir = process.env.REBEL_USER_DATA || '/data';
  const bakedSchemaFingerprint =
    typeof __SCHEMA_FINGERPRINT__ === 'string' && __SCHEMA_FINGERPRINT__.length > 0
      ? __SCHEMA_FINGERPRINT__
      : undefined;
  const fallbackLkgPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'default-lkg.json',
  );

  const outcome = await runPreBootstrapWatchdog({
    dataDir,
    fallbackLkgPath,
    bakedSchemaFingerprint,
    log: emit,
  });

  if (outcome.kind === 'recovered') {
    console.error(
      `[watchdog] Recovery applied → ${outcome.targetImage}. Exiting 0 so Fly can restart with the rolled-back image.`,
    );
    process.exit(0);
  }

  // Resolve `./server.mjs` against this module's URL at runtime so esbuild
  // does not try to bundle/resolve it at build time (the import target is a
  // sibling artifact, not a source dependency of entry.ts).
  const serverUrl = new URL('./server.mjs', import.meta.url).href;
  await import(/* @vite-ignore */ serverUrl);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : '';
  console.error(`[fatal] entry.ts failed before server load: ${message}`);
  if (stack) console.error(stack);
  process.exit(1);
});
