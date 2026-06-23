#!/usr/bin/env npx tsx
/**
 * Cross-platform launcher for the packaged app produced by `npm run package`.
 *
 * Replaces the previous hardcoded `open "out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app"`
 * one-liner in `package:run`. Detects platform + arch at runtime and launches the
 * correct binary so `npm run package:run` works on all supported platforms.
 *
 * Platform/arch/channel detection mirrors `forge.config.cjs` (lines 2-15):
 * - `BUILD_CHANNEL=beta` → productName `"Mindstone Rebel Beta"` and linux executable
 *   `"mindstone-rebel-beta"`. Otherwise stable: `"Mindstone Rebel"` / `"mindstone-rebel"`.
 * - `process.platform` ∈ {darwin, win32, linux}. Other platforms not supported.
 * - `process.arch` ∈ {arm64, x64} typically.
 *
 * Launch mechanism per platform:
 * - darwin: `spawn('open', [appPath])` — standard macOS app launcher.
 * - win32: direct-exec `spawn(exePath, [], { detached: true, stdio: 'ignore' })`.
 *   Chosen over `cmd /c start "" "..."` to sidestep shell quoting hazards with
 *   spaces in the product name.
 * - linux: direct-exec `spawn(exePath, [], { detached: true, stdio: 'ignore' })`.
 *
 * Exit codes:
 * - 0: launched successfully
 * - 1: binary not found at expected path (run `npm run package` first)
 * - 2: unsupported platform
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolvePackagedAppPaths } from './resolve-packaged-app';

const paths = resolvePackagedAppPaths();

function resolveBinary(): { binaryPath: string; launcher: 'open' | 'direct' } {
  switch (paths.platform) {
    case 'darwin':
      return { binaryPath: paths.appPath, launcher: 'open' };
    case 'win32':
      return { binaryPath: paths.exePath, launcher: 'direct' };
    case 'linux':
      return { binaryPath: paths.linuxExePath, launcher: 'direct' };
    default:
      console.error(
        `[launch-packaged-app] Unsupported platform: ${paths.platform}. Supported: darwin, win32, linux.`,
      );
      process.exit(2);
  }
}

function main(): void {
  const { binaryPath, launcher } = resolveBinary();

  if (!existsSync(binaryPath)) {
    console.error(
      `[launch-packaged-app] Packaged app not found at:\n  ${binaryPath}\n` +
        `Run \`npm run package\` first (platform=${paths.platform}, arch=${paths.arch}, ` +
        `channel=${paths.channel}).`,
    );
    process.exit(1);
  }

  console.log(`[launch-packaged-app] Launching: ${binaryPath}`);

  const child =
    launcher === 'open'
      ? spawn('open', [binaryPath], { detached: true, stdio: 'ignore' })
      : spawn(binaryPath, [], { detached: true, stdio: 'ignore' });

  child.on('error', (err) => {
    console.error(`[launch-packaged-app] Failed to spawn: ${err.message}`);
    process.exit(1);
  });

  // Detach so this script exits and the app keeps running.
  child.unref();
}

main();
