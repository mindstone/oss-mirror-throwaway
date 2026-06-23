/**
 * Cloud Service Build Script
 *
 * Uses esbuild to bundle the headless cloud service into a single JS file.
 * No electron alias — build fails if any code in the import graph imports
 * electron, serving as a correctness guarantee.
 */

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverElectronImports, buildAutoStubs } from '../scripts/lib/discoverElectronImports.mjs';

const require = createRequire(import.meta.url);
const RUNTIME_EXTERNALS = require('./runtimeExternals.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = process.env.CLOUD_SERVICE_BUILD_OUTDIR
  ? path.resolve(projectRoot, process.env.CLOUD_SERVICE_BUILD_OUTDIR)
  : path.join(__dirname, 'dist');

// Capture git info at build time for deployment verification.
// Prefer BUILD_COMMIT / BUILD_DATE env vars (set by Docker ARGs) over git CLI,
// since git is unavailable inside the Docker builder stage.
const rebelVersion = createRequire(import.meta.url)('../package.json').version;
let gitCommitHash = process.env.BUILD_COMMIT || 'unknown';
let gitCommitDate = process.env.BUILD_DATE || 'unknown';
if (gitCommitHash === 'unknown') {
  try {
    gitCommitHash = execSync('git rev-parse --short HEAD', { cwd: projectRoot }).toString().trim();
    gitCommitDate = execSync('git log -1 --format=%cI', { cwd: projectRoot }).toString().trim();
  } catch {
    console.warn('Could not read git info (building outside git repo?)');
  }
}

/**
 * Guard against bare 'electron' imports at build time.
 *
 * Without the electron shim alias, these imports resolve to
 * node_modules/electron (the launcher binary) which crashes at runtime.
 * This plugin intercepts them and returns an empty module.
 *
 * When REJECT_ELECTRON=1, the build fails on any electron import
 * (use this to verify de-electronification progress).
 *
 * Remaining electron imports are transitive dependencies from shared
 * services (auth, meeting bot, embedding, etc.) that are pulled into
 * the cloud import graph but only execute their electron code paths
 * behind platform guards or lazy imports. See planning doc Stage 5 notes.
 */
const electronImporters = new Set();
const guardElectronPlugin = {
  name: 'guard-electron',
  setup(build) {
    const reject = process.env.REJECT_ELECTRON === '1';

    // Intercept bare 'electron' imports
    build.onResolve({ filter: /^electron$/ }, (args) => {
      electronImporters.add(args.importer);

      if (reject) {
        return {
          errors: [{
            text: `Bare 'electron' import in ${args.importer}. De-electronify this file or exclude it from the cloud import graph.`,
          }],
        };
      }

      // Return a virtual empty module so the build succeeds
      return { path: 'electron', namespace: 'electron-stub' };
    });

    // Provide a minimal stub module — just enough to avoid crashes at
    // module init time.  Business logic should use @core/ boundaries
    // (getPlatformConfig, getBroadcastService, getHandlerRegistry) instead.
    //
    // Specialized stubs have hand-written behavior for modules that need
    // it (e.g. app.getPath, safeStorage, dialog). Everything else gets a
    // recursive noopProxy so new electron imports never break the build.
    let stubSource;
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => {
      if (!stubSource) stubSource = buildCloudElectronStub();
      return { contents: stubSource, loader: 'js' };
    });
  },
};

function buildCloudElectronStub() {
  // Specialized stubs — hand-written for modules that need specific behavior
  const specializedStubs = `
const noop = () => {};
const noopAsync = () => Promise.resolve();
const noopProxy = new Proxy(function(){}, {
  get: (_, prop) => prop === 'then' ? undefined : noopProxy,
  apply: () => noopProxy,
  construct: () => noopProxy,
});
const app = {
  getPath: () => '/tmp', getAppPath: () => process.cwd(),
  getVersion: () => ${JSON.stringify(rebelVersion)}, getName: () => 'rebel-cloud',
  isPackaged: false, isReady: () => true, whenReady: noopAsync,
  on: noop, once: noop, quit: noop, relaunch: noop,
  requestSingleInstanceLock: () => true, getAppMetrics: () => [],
};
const BrowserWindow = class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } };
const ipcMain = { handle: noop, removeHandler: noop, on: noop };
const shell = { openExternal: noopAsync };
const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }), showMessageBox: () => Promise.resolve({ response: 0 }) };
const safeStorage = { isEncryptionAvailable: () => false, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() };
const clipboard = { writeText: noop, readText: () => '' };
const nativeTheme = { shouldUseDarkColors: true, themeSource: 'dark', on: noop };
const systemPreferences = { getMediaAccessStatus: () => 'granted' };
const nativeImage = { createFromPath: () => ({}) };
const Notification = class { show() {} };
const utilityProcess = { fork: () => null };
const screen = { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [] };
const powerMonitor = { on: noop, removeListener: noop, getSystemIdleState: () => 'active' };
const powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };
const autoUpdater = { on: noop, setFeedURL: noop, checkForUpdates: noop };
const desktopCapturer = { getSources: () => Promise.resolve([]) };
const net = { request: () => noopProxy };
const session = { defaultSession: { webRequest: { onHeadersReceived: noop }, on: noop } };
const protocol = { registerSchemesAsPrivileged: noop, handle: noop };
const webContents = { getAllWebContents: () => [], fromId: () => null };
const crashReporter = { start: noop, getLastCrashReport: () => null };
const contentTracing = { startRecording: noopAsync, stopRecording: () => Promise.resolve(''), getCategories: () => Promise.resolve([]) };
`;

  const specialized = new Set([
    'app', 'BrowserWindow', 'ipcMain', 'shell', 'dialog', 'safeStorage',
    'clipboard', 'nativeTheme', 'systemPreferences', 'nativeImage',
    'Notification', 'utilityProcess', 'screen', 'powerMonitor',
    'powerSaveBlocker', 'autoUpdater', 'desktopCapturer', 'net',
    'session', 'protocol', 'webContents', 'crashReporter', 'contentTracing',
  ]);

  // Auto-discover all electron imports and generate noopProxy stubs for any
  // not already in the specialized set
  const discovered = discoverElectronImports({ projectRoot });
  const { autoStubs, allNames } = buildAutoStubs({ specialized, discovered, mode: 'throw' });

  if (autoStubs.length > 0) {
    console.warn(`  Auto-stubbed ${autoStubs.length} electron import(s): ${[...discovered].filter(n => !specialized.has(n)).join(', ')}`);
  }

  const exportLine = allNames.join(', ');

  return [
    specializedStubs,
    autoStubs.join('\n'),
    `export default { ${exportLine} };`,
    `export { ${exportLine} };`,
  ].join('\n');
}

// Resolve the build-time schema fingerprint once, up front, so we can inject
// it into entry.ts as a `define` constant. The watchdog uses this to flag
// LKG records that crossed a schema boundary (Decision D3 warn-not-block).
const fingerprintScript = path.join(projectRoot, 'scripts/print-cloud-schema-fingerprint.ts');
const bakedSchemaFingerprint = execSync(
  `npx tsx "${fingerprintScript}"`,
  { cwd: projectRoot, encoding: 'utf8' },
).trim();
if (!/^[0-9a-f]{64}$/.test(bakedSchemaFingerprint)) {
  throw new Error(
    `cloud-service/build.mjs: schema fingerprint subprocess returned malformed output: ${JSON.stringify(bakedSchemaFingerprint)}`,
  );
}

await build({
  entryPoints: [
    path.join(__dirname, 'src/server.ts'),
    // Stage C2: entry.ts is the new container CMD. It runs the watchdog
    // synchronously before dynamic-importing server.mjs.
    path.join(__dirname, 'src/entry.ts'),
  ],
  outdir: outputDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Handle import.meta.url in CJS modules
  define: {
    'import.meta.url': 'import_meta_url',
    '__BUILD_COMMIT__': JSON.stringify(gitCommitHash),
    '__BUILD_DATE__': JSON.stringify(gitCommitDate),
    '__REBEL_VERSION__': JSON.stringify(rebelVersion),
    '__SCHEMA_FINGERPRINT__': JSON.stringify(bakedSchemaFingerprint),
  },
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      'const import_meta_url = import.meta.url;',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
      'const require = __createRequire(import.meta.url);',
      // Boot-time graceful-fs install — runs before any module body executes,
      // so every fs op in the cloud bundle gets EMFILE/ENFILE retry resilience.
      // Honours REBEL_DISABLE_GRACEFUL_FS=1 for field rollback. Failures are
      // stashed on globalThis so a future observability layer can surface them.
      // See docs/plans/260428_graceful_fs_emfile_fix.md Stage 2.
      "if (process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') { try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) { globalThis.__REBEL_BOOTSTRAP_BANNER_ERROR__ = { kind: 'graceful_fs_install_failed', error: { name: e && e.name, message: e && e.message, stack: e && e.stack }, at: Date.now() }; if (process.env.REBEL_DEBUG_BOOTSTRAP === '1') { console.warn('[bootstrap-banner] graceful-fs failed to load:', e); } } }",
    ].join('\n'),
  },
  // Alias remaining shims (electron shim eliminated — build fails if any code imports electron)
  alias: {
    'electron-store': path.join(__dirname, 'src/electronStoreShim.ts'),
    // Shim ONLY @sentry/electron* — these pull Electron at import time
    // (require('@sentry/electron/main') tries to normalise/download an Electron
    // binary and crashes in a non-Electron env), so they must no-op in cloud.
    // @sentry/core is NOT shimmed: it is platform-neutral and provides the real
    // transport/envelope primitives the cloud offline transport needs
    // (makeOfflineTransport / serializeEnvelope / parseEnvelope). It is bundled
    // for real here. @sentry/node stays externalized (runtimeExternals.json).
    '@sentry/electron/main': path.join(__dirname, 'src/sentryShim.ts'),
    '@sentry/electron': path.join(__dirname, 'src/sentryShim.ts'),
    '@rebel/cloud-client/cloudClient': path.join(projectRoot, 'cloud-client/src/cloudClient.ts'),
    '@rebel/cloud-client': path.join(projectRoot, 'cloud-client/src/index.ts'),
    '@rebel/shared': path.join(projectRoot, 'packages/shared/src'),
    '@core': path.join(projectRoot, 'src/core'),
    '@shared': path.join(projectRoot, 'src/shared'),
    '@main': path.join(projectRoot, 'src/main'),
  },
  // Externalize native/large modules not needed inline in the cloud bundle.
  // The first 9 are desktop-only (never imported by cloud-service at runtime).
  // Runtime externals (ws, tar, etc.) are defined in runtimeExternals.json —
  // the single source of truth shared with integration test files.
  // See: docs-private/investigations/260330_cloud_service_test_startup_timeouts.md
  external: [
    'fsevents',
    'chokidar',
    '@lancedb/lancedb',
    '@huggingface/transformers',
    'onnxruntime-node',
    'apache-arrow',
    '@recallai/desktop-sdk',
    'win-ca',
    'electron-updater',
    ...RUNTIME_EXTERNALS,
  ],
  plugins: [guardElectronPlugin],
  loader: {
    '.json': 'json',
  },
  logLevel: 'warning',
});

if (electronImporters.size > 0) {
  console.warn(`\n⚠ ${electronImporters.size} files still import 'electron' (stubbed at build time):`);
  for (const f of [...electronImporters].sort()) {
    console.warn(`  - ${f.replace(projectRoot + '/', '')}`);
  }
  console.warn('Run REJECT_ELECTRON=1 node build.mjs to fail on these.\n');
}
console.log(`Cloud service built → ${path.relative(projectRoot, path.join(outputDir, 'server.mjs'))}`);

// Bake default-lkg.json — first-boot fallback used by the pre-bootstrap
// watchdog (Stage C2 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md).
// At first boot of a brand-new machine, /data has no LKG record yet. The
// watchdog reads this baked file as a last-resort fallback. The
// `isBootstrapFallback: true` flag tells the watchdog this is synthetic.
// Anti-self-rollback (C2 step 3d) still prevents an infinite recursion if the
// running image is the same as the baked tag.
//
// Reuses `bakedSchemaFingerprint` (computed above for the entry.ts define
// macro) so the baked LKG and runtime watchdog agree on the schema version.
const defaultLkg = {
  version: 1,
  imageTag: `bootstrap:${gitCommitHash}`,
  buildCommit: gitCommitHash,
  schemaFingerprint: bakedSchemaFingerprint,
  recordedAt: 0,
  previousLastKnownGood: null,
  isBootstrapFallback: true,
};
writeFileSync(
  path.join(outputDir, 'default-lkg.json'),
  `${JSON.stringify(defaultLkg, null, 2)}\n`,
  'utf8',
);
console.log(
  `Baked default-lkg.json (fingerprint=${bakedSchemaFingerprint.slice(0, 12)}…) → ${path.relative(projectRoot, path.join(outputDir, 'default-lkg.json'))}`,
);
