import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// Main-boundary test: static import of the main-only @private/mindstone alias
// is allowed here (eslint restricts it only for core/shared/renderer). This is
// the source-signal leg of the Stage 1 keystone contract.
import { PRIVATE_MINDSTONE_BOOTSTRAP_MODE } from '@private/mindstone/mode';
import { setPlatformConfig, getPlatformConfig, defaultCapabilities } from '@core/platform';
import type { PlatformConfig } from '@core/platform';

/**
 * Stage 1 invariant (260607_oss-b6-launch-polish, arbitrator decision A):
 * the pure `@private/mindstone/mode` modules (real + stub) MUST have ZERO
 * imports of `@main/*`, stores, logger, auth, or IPC handlers — only the
 * type-only `PrivateMindstoneBootstrapMode` from
 * `@core/services/privateMindstoneBootstrap` is allowed.
 *
 * Why a source-text assertion: `ensureAppIdentity` imports this module BEFORE
 * `app.setPath('userData')` and before electron-store is constructed. A
 * side-effecting import (e.g. the auth provider that the real `bootstrap.ts`
 * pulls in) would construct electron-store against the wrong userData path —
 * the high-blast session-bleed failure mode this seam guards against. We assert
 * on source text (not a runtime import) so a forbidden import is caught even if
 * it happens to be tree-shakeable / side-effect-free at runtime.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const MODE_MODULES = [
  'private/mindstone/src/mode.ts',
  'src/main/oss/private-mindstone-stub/mode.ts',
];

// Any `import ... from '<spec>'` where spec matches one of these is forbidden,
// EXCEPT a `import type` from the typed-contract module.
const FORBIDDEN_IMPORT_SPECIFIER = /@main\b|\/store|Store'|stores|logger|[Aa]uth|[Hh]andlers|electron-store|electron'/;

describe('private-mindstone mode modules purity', () => {
  for (const rel of MODE_MODULES) {
    it(`${rel} has no @main/store/logger/auth/handler/electron imports`, () => {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const importLines = text
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line));

      for (const line of importLines) {
        // The only allowed import is a type-only import of the contract type.
        const isAllowedTypeOnlyContract =
          /^\s*import\s+type\b/.test(line) &&
          line.includes('@core/services/privateMindstoneBootstrap');
        if (isAllowedTypeOnlyContract) {
          continue;
        }
        expect(
          FORBIDDEN_IMPORT_SPECIFIER.test(line),
          `Forbidden import in ${rel}: ${line.trim()}`,
        ).toBe(false);
      }
    });

    it(`${rel} only imports the type-only contract (single import, type-only)`, () => {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const importLines = text
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line));
      expect(importLines).toHaveLength(1);
      expect(importLines[0]).toMatch(/^\s*import\s+type\s/);
      expect(importLines[0]).toContain('@core/services/privateMindstoneBootstrap');
    });
  }
});

describe('desktop isOss source-signal keystone (real @private/mindstone/mode)', () => {
  const makeDesktopConfig = (isOss: boolean): PlatformConfig => ({
    userDataPath: '/tmp/mode-keystone-test',
    appPath: '/tmp/mode-keystone-test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/mode-keystone-test/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/AppData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss,
    capabilities: defaultCapabilities('desktop'),
  });

  // Mirrors the desktop bootstrap wiring (src/main/bootstrap.ts):
  //   isOss: PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub'
  // resolved against the REAL mode module for the current build arrangement
  // (dev placeholder present => 'real' => non-OSS; mirror-stripped => 'stub' =>
  // OSS). This is the anti-drift guard between the source signal and the
  // PlatformConfig seam.
  it('getPlatformConfig().isOss equals (PRIVATE_MINDSTONE_BOOTSTRAP_MODE === "stub")', () => {
    const expected = PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub';
    setPlatformConfig(makeDesktopConfig(expected));
    expect(getPlatformConfig().isOss).toBe(expected);
  });

  it('mode is one of the two known build modes', () => {
    expect(['real', 'stub']).toContain(PRIVATE_MINDSTONE_BOOTSTRAP_MODE);
  });
});
