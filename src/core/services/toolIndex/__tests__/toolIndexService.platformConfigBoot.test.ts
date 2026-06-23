/**
 * Regression test: importing toolIndexService must NOT read PlatformConfig.
 *
 * The bug: toolIndexService evaluated getNativeModuleRequire() at module-load
 * time, which calls isPackaged() -> getPlatformConfig(). When the module is
 * imported before bootstrap calls setPlatformConfig() (as on the OSS desktop
 * build), getPlatformConfig() throws "PlatformConfig not initialized", crashing
 * the app at startup.
 *
 * This test pins the invariant that the import must resolve cleanly even when
 * PlatformConfig has never been initialised. It runs the child fixture
 * (toolIndexService.platformConfigBoot.child.ts) in a FRESH process so it is
 * isolated from vitest's global setup (vitest.setup.ts calls setPlatformConfig()
 * for the whole desktop project, which would otherwise mask the bug entirely).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// repo root: src/core/services/toolIndex/__tests__ -> up 5 levels
const repoRoot = path.resolve(here, '../../../../..');
const childFixture = path.join(here, 'toolIndexService.platformConfigBoot.child.ts');

describe('toolIndexService boot invariant', () => {
  it('imports without PlatformConfig being initialised (does not crash at module load)', () => {
    // Sanitise the child's env: IS_CLOUD_SERVICE MUST be unset for this test to
    // exercise the throwing path. isPackaged() (src/core/utils/dataPaths.ts)
    // short-circuits to `false` WITHOUT calling getPlatformConfig() when
    // IS_CLOUD_SERVICE === '1'. If the child inherited IS_CLOUD_SERVICE=1 (e.g.
    // from a cloud-shaped shell/CI env), the PRE-FIX eager getNativeModuleRequire()
    // would NOT reach getPlatformConfig() and so would NOT throw — the test would
    // go GREEN even on unfixed code (a false pass). Deleting it forces isPackaged()
    // down the getPlatformConfig() path the regression is about.
    // Destructure IS_CLOUD_SERVICE out of the inherited env (rather than
    // `delete`, which TS rejects on the typed process.env shape) so the child
    // never sees it.
    const { IS_CLOUD_SERVICE: _omitCloudFlag, ...inheritedEnv } = process.env;
    const childEnv = { ...inheritedEnv, TS_NODE_PROJECT: 'tsconfig.node.json' };

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--require', 'tsconfig-paths/register', childFixture],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: childEnv,
        timeout: 120000,
      },
    );

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    // Must not have crashed with the PlatformConfig error.
    expect(combined).not.toContain('PlatformConfig not initialized');
    // Must have completed the import cleanly (exit 0 + sentinel).
    expect(result.status, `child exited non-zero.\n${combined}`).toBe(0);
    expect(combined).toContain('IMPORT_OK');
  });
});
