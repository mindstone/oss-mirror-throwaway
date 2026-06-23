/**
 * Single source of truth for "where did `npm run package` put the .app/.exe/linux exe,
 * and what's its channel-specific name?" Consumed by `package:run`
 * (`scripts/launch-packaged-app.ts`) and `package:alpha-distribution`
 * (`scripts/package-alpha-distribution.ts`).
 *
 * Mirrors the channel-aware productName / bundle-id naming in `forge.config.cjs` (lines
 * 2-15). If the forge config diverges, update both — there is no programmatic link
 * between them.
 *
 * Returns a path for every supported platform regardless of the current `process.platform`.
 * Callers pick the one they need. No filesystem checks here; existence is the caller's
 * responsibility.
 */
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const OUT_DIR = path.join(REPO_ROOT, 'out');

export interface PackagedAppPaths {
  isBeta: boolean;
  channel: 'stable' | 'beta';
  /** Forge-config productName, e.g. "Mindstone Rebel" or "Mindstone Rebel Beta". */
  productName: string;
  /** Channel bundle ID, e.g. "com.mindstone.rebel" or "com.mindstone.rebel.beta". */
  bundleId: string;
  /** Linux launcher executable basename (no extension). */
  linuxExecutableName: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Directory electron-forge writes the packaged app to for the current platform/arch. */
  packageDir: string;
  /** macOS .app path. Always computed; only meaningful on darwin. */
  appPath: string;
  /** Windows .exe path. Always computed; only meaningful on win32. */
  exePath: string;
  /** Linux executable path. Always computed; only meaningful on linux. */
  linuxExePath: string;
}

export function resolvePackagedAppPaths(): PackagedAppPaths {
  const isBeta = process.env.BUILD_CHANNEL === 'beta';
  const channel: 'stable' | 'beta' = isBeta ? 'beta' : 'stable';
  const productName = isBeta ? 'Mindstone Rebel Beta' : 'Mindstone Rebel';
  const bundleId = isBeta ? 'com.mindstone.rebel.beta' : 'com.mindstone.rebel';
  const linuxExecutableName = isBeta ? 'mindstone-rebel-beta' : 'mindstone-rebel';
  const platform = process.platform;
  const arch = process.arch;
  const packageDir = path.join(OUT_DIR, `${productName}-${platform}-${arch}`);

  return {
    isBeta,
    channel,
    productName,
    bundleId,
    linuxExecutableName,
    platform,
    arch,
    packageDir,
    appPath: path.join(packageDir, `${productName}.app`),
    exePath: path.join(packageDir, `${productName}.exe`),
    linuxExePath: path.join(packageDir, linuxExecutableName),
  };
}
