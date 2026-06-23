/**
 * Child fixture for toolIndexService.platformConfigBoot.test.ts.
 *
 * Runs in a fresh process (via tsx + tsconfig-paths) and imports
 * toolIndexService WITHOUT calling setPlatformConfig(). It must resolve
 * cleanly. Pre-fix, the eager getNativeModuleRequire() at module top-level
 * calls isPackaged() -> getPlatformConfig(), which throws here.
 *
 * Exit codes:
 *   0 -> import succeeded with PlatformConfig uninitialised (expected, post-fix)
 *   2 -> precondition failed: PlatformConfig was already initialised
 *   1 -> import threw (the bug: "PlatformConfig not initialized")
 */
import { getPlatformConfig } from '@core/platform';

async function main(): Promise<void> {
  // Sanity: confirm PlatformConfig really is uninitialised in this realm.
  let initialised = true;
  try {
    getPlatformConfig();
  } catch {
    initialised = false;
  }
  if (initialised) {
    console.error('PRECONDITION_FAILED: PlatformConfig unexpectedly initialised');
    process.exit(2);
  }

  // The load-bearing assertion: importing the service must not throw.
  await import('@core/services/toolIndex/toolIndexService');
  process.stdout.write('IMPORT_OK\n');
}

void main();
