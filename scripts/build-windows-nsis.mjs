#!/usr/bin/env node
/**
 * Windows NSIS build script.
 * Handles dynamic prepackaged path based on BUILD_CHANNEL.
 * Generates app-update.yml to ensure runtime uses correct update URL.
 */

import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const buildChannel = process.env.BUILD_CHANNEL || 'stable';
const isBeta = buildChannel === 'beta';
const appName = isBeta ? 'Mindstone Rebel Beta' : 'Mindstone Rebel';
const prepackagedPath = `out/${appName}-win32-x64`;

// Determine update URL - supports UPDATE_FEED_PATH for isolated testing (e.g., nsis-test branch)
// NOTE: Update URL pattern is defined in multiple places - keep in sync:
//   - scripts/build-windows-nsis.mjs (here) - local build app-update.yml generation
//   - forge.config.cjs - packageAfterCopy Step 10 (CI uses this)
//   - electron-builder.cjs - build-time publish config
//   - src/main/services/autoUpdateService.ts - runtime fallback
//   - src/main/services/health/checks/updates.ts - health check diagnostics
const updateBasePath = process.env.UPDATE_FEED_PATH || (isBeta ? 'updates-beta' : 'updates');
const updateUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}/win32/x64/`;

console.log(`[build-windows-nsis] Build channel: ${buildChannel}`);
console.log(`[build-windows-nsis] Prepackaged path: ${prepackagedPath}`);
console.log(`[build-windows-nsis] Update URL: ${updateUrl}`);

// Generate app-update.yml so runtime uses correct update URL
// Without this, autoUpdateService.ts falls back to hardcoded updates-beta/updates paths
const resourcesPath = join(prepackagedPath, 'resources');
const appUpdateYmlPath = join(resourcesPath, 'app-update.yml');

if (!existsSync(resourcesPath)) {
  mkdirSync(resourcesPath, { recursive: true });
}

const appUpdateYml = `provider: generic
url: ${updateUrl}
channel: ${isBeta ? 'beta' : 'latest'}
useMultipleRangeRequest: false
`;

writeFileSync(appUpdateYmlPath, appUpdateYml, 'utf8');
console.log(`[build-windows-nsis] Generated app-update.yml at ${appUpdateYmlPath}`);

const cmd = `npx electron-builder --win --x64 --prepackaged "${prepackagedPath}" --config electron-builder.cjs`;
console.log(`[build-windows-nsis] Running: ${cmd}`);

execSync(cmd, { stdio: 'inherit' });
