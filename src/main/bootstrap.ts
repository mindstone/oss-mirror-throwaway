/* eslint-disable no-console -- bootstrap: runs before structured logger init */
// IMPORT ORDER MATTERS - these are side-effect imports that set app.setPath('userData')
// Precedence: Rebel-test composition > Test isolation > Demo mode > Default (shared identity)
//
// NOTE: applyThreadpoolSize MUST be the very first import — even before
// installGracefulFs. It sets `UV_THREADPOOL_SIZE` to buffer the shared libuv
// pool against dead-cloud-mount exhaustion (turn-hang root, see
// docs/plans/260619_turn-hang-bugmode/PLAN.md). libuv reads that env var ONCE,
// at the first async threadpool op, so it must be set before any async fs/dns/
// crypto runs — and installGracefulFs (next) is the first fs touch.
import './startup/applyThreadpoolSize';       // libuv pool buffer (must be FIRST — before any async pool op)
//
// NOTE: installGracefulFs MUST be the next import. It calls
// `gracefulify(fs)` so every subsequent fs op (including the synchronous
// reads in the userData-path setup below) gets EMFILE/ENFILE retry
// resilience. See docs/plans/260428_graceful_fs_emfile_fix.md.
import './startup/installGracefulFs';        // Boot-time graceful-fs patch (must be first after the pool buffer)
//
// NOTE: initNodePath MUST come next — after the two side-effects above (whose
// header comments require them first) but BEFORE every other import. It
// prepends app.asar.unpacked/node_modules to NODE_PATH so the packaged app can
// require() unpacked native modules. It MUST run at the head of the
// module-hoist phase: chokidar is bundled into the main asar and its
// fsevents-handler runs an eager `require('fsevents')` during hoist — if the
// shim ran later, that require throws, chokidar memoizes fsevents=undefined and
// disables the native backend (degraded macOS file watching + disarmed quit-time
// fsevents leak guard). See docs/plans/260623_fsevents-interception-regression/.
import './startup/initNodePath';             // NODE_PATH shim for unpacked natives (must precede any chokidar import)
import { raiseFdLimit } from './startup/raiseFdLimit';
import './startup/ensureRebelTestMode';     // Composes env vars for --rebel-test flag (must be first)
import './startup/ensureAppIdentity';       // Sets userData to shared path
import './startup/ensureDemoModeUserData';  // Overrides if demo flag exists
import './startup/ensureTestUserData';      // Test isolation takes final precedence
import './startup/ensureMigrationImport';   // Adopts staged migration import (runs LAST so it
                                            // reads the FINAL userData path: under demo/test the
                                            // staging-must-be-sibling guard then refuses a stray
                                            // production flag instead of touching the real profile)

// Enable V8 code caching for faster subsequent startups
// Uses Node.js 22.8.0+ built-in API (Electron 39.5.x bundles Node 22.22.0)
// Must be after userData setup but before bulk of module loading
try {
   
  const nodeModule = require('node:module') as typeof import('node:module');
  const { enableCompileCache, constants } = nodeModule;
  const result = enableCompileCache();
  const { compileCacheStatus } = constants;
  if (result.status === compileCacheStatus.ENABLED) {
    console.log('[bootstrap] V8 compile cache enabled:', result.directory);
  } else if (result.status === compileCacheStatus.ALREADY_ENABLED) {
    // Already enabled via prior call or NODE_COMPILE_CACHE env var - no action needed
  } else if (result.status === compileCacheStatus.FAILED) {
    console.warn('[bootstrap] V8 compile cache failed:', result.message);
  }
  // status === DISABLED means NODE_DISABLE_COMPILE_CACHE=1 is set - respect user preference
} catch {
  // Ignore - may fail if Node version doesn't support this API
}

// NOTE: the app.asar.unpacked/node_modules NODE_PATH shim moved to the early
// side-effect import `./startup/initNodePath` (above). It MUST run at the head
// of the module-hoist phase — ahead of chokidar's eager `require('fsevents')` —
// so a late top-level statement here would be too late. See
// docs/plans/260623_fsevents-interception-regression/.

import { app } from 'electron';
import { showStartupErrorBox } from './startup/startupDialog';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setPlatformConfig } from '@core/platform';
import { PRIVATE_MINDSTONE_BOOTSTRAP_MODE } from '@private/mindstone/mode';
import { setAppNavigationService } from '@core/appNavigationService';
import { setAssetStore } from '@core/assetStore';
import { setContentStore } from '@core/contentStore';
import { setCloudCapabilityProbe } from '@core/cloudCapabilityProbe';
import { peekCloudCapabilities as peekCloudClientCapabilities } from '@rebel/cloud-client/cloudClient';
import { setScreenshotCaptureService } from '@core/screenshotCaptureService';
import { createScopedLogger, getTurnContext } from '@core/logger';
import { setFallbackTelemetryTurnContextProvider } from '@shared/utils/emitFallbackTelemetry';
import { setInvariantLogger } from '@shared/utils/invariant';
import { setIntentionalSwallowSinks } from '@shared/utils/intentionalSwallow';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { desktopAppNavigationService } from './services/desktopAppNavigationService';
import { DesktopAssetStore } from './services/assetStoreDesktop';
import { DesktopContentStore } from './services/contentStoreDesktop';
import { desktopScreenshotCaptureService } from './services/desktopScreenshotCaptureService';
import { recordMainBreadcrumb } from './sentry';
export { cloudConnectionReconciler } from './services/cloud/cloudConnectionReconcilerSingleton';

process.env.REBEL_SURFACE = 'desktop';

// Initialize PlatformConfig so that @core modules (logger, dataPaths, etc.)
// can resolve paths without importing electron directly.
// Must run after ensureAppIdentity (which calls app.setPath('userData')).
setPlatformConfig({
  userDataPath: app.getPath('userData'),
  appPath: app.getAppPath(),
  tempPath: app.getPath('temp'),
  logsPath: app.getPath('logs'),
  homePath: app.getPath('home'),
  documentsPath: app.getPath('documents'),
  desktopPath: app.getPath('desktop'),
  appDataPath: app.getPath('appData'),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  totalMemoryBytes: os.totalmem(),
  arch: process.arch,
  surface: 'desktop',
  // OSS build signal: derived from the pure private-mode module (resolves to
  // 'stub' only when the mirror strips private/mindstone/src). Stage 1 seam
  // only — no behavioural consumption yet.
  isOss: PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub',
  getAppMetrics: () => app.getAppMetrics(),
});

setScreenshotCaptureService(desktopScreenshotCaptureService);
setAppNavigationService(desktopAppNavigationService);
setAssetStore(new DesktopAssetStore());
setContentStore(new DesktopContentStore());
setCloudCapabilityProbe(() => peekCloudClientCapabilities());

// Stage 4 (provider-aware fallback telemetry): wire the main-process turn
// context reader so `emitFallbackTelemetryAuto()` in shared utils can
// resolve the active turn join-keys without forcing shared to import
// `@core/logger` (which is Node-only and breaks the renderer build).
setFallbackTelemetryTurnContextProvider(() => getTurnContext());

const invariantLog = createScopedLogger({ service: 'invariant' });
setInvariantLogger(invariantLog);

const intentionalSwallowLog = createScopedLogger({ service: 'intentional-swallow' });
setIntentionalSwallowSinks({
  log: (level, message, context) => {
    if (level === 'warn') {
      intentionalSwallowLog.warn(context, message);
      return;
    }
    intentionalSwallowLog.debug(context, message);
  },
  breadcrumb: (message, context) => {
    recordMainBreadcrumb({
      category: 'silent_fallback',
      level: context.severity === 'warn' ? 'warning' : 'debug',
      message,
      data: context,
    });
  },
});

import { ensureArchitectureMatch } from './startup/ensureArchitectureMatch';
import { ensureVersionCompatibility } from './startup/ensureVersionCompatibility';
import { ensureUserDataHealth } from './startup/ensureUserDataHealth';
import { acquireSingleInstanceLock } from './startup/singleInstanceLock';
import { AssetUploadOutbox } from './services/assetUploadOutbox';
import { ContentUploadOutbox } from './services/contentUploadOutbox';
import { startBugReportOutbox, stopBugReportOutbox } from './ipc/bugReportHandlers';
import { installFseventsLeakGuard } from './services/fseventsLeakGuard';

let assetUploadOutbox: AssetUploadOutbox | null = null;
let assetUploadOutboxQuitInProgress = false;
let assetUploadOutboxQuitDrained = false;
let contentUploadOutbox: ContentUploadOutbox | null = null;
let contentUploadOutboxQuitInProgress = false;
let contentUploadOutboxQuitDrained = false;
// Bug-report outbox (durable persist-before-accept, replay-until-delivered).
let bugReportOutboxStarted = false;
let bugReportOutboxQuitInProgress = false;
let bugReportOutboxQuitDrained = false;

// Detect x64 (Intel) build running on Apple Silicon via Rosetta.
// Must run after setPlatformConfig() but before heavy initialization.
ensureArchitectureMatch();

// Check version compatibility BEFORE any stores are imported.
// Sets global read-only flag if userData was written by a newer app version.
// Must run after setPlatformConfig() (needs userDataPath) and after
// ensureTestUserData (test mode bypasses the gate).
ensureVersionCompatibility();

import type { UserDataHealthResult } from './startup/ensureUserDataHealth';

/**
 * Extract error message from unknown error type.
 */
function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Show a dialog to the user when startup fails. Routes through `showStartupErrorBox`
 * (src/main/startup/startupDialog.ts), which no-ops in any automated/headless context
 * (the `isAutomatedOrHeadlessContext()` SSOT) so a parent-less startup `[NSAlert runModal]`
 * can't wedge the automated/E2E boot — and reliably shows even before `app` is ready.
 */
function showStartupFailureDialog(error: unknown, health: UserDataHealthResult): void {
  const logsPath = path.join(app.getPath('userData'), 'logs');
  const errorMessage = formatStartupError(error);
  const title = 'Rebel startup failed';

  let message: string;
  if (health.settingsCorrupted) {
    message = [
      'Rebel could not start because the settings file appears corrupted.',
      '',
      `File: ${health.settingsPath}`,
      '',
      'Tip: Renaming or deleting the file will let Rebel recreate defaults.',
      '',
      'Need help? Contact hello@mindstone.com',
    ].join('\n');
  } else {
    message = [
      'Rebel could not start due to a startup error.',
      '',
      `Error: ${errorMessage}`,
      '',
      `Logs: ${logsPath}`,
      '',
      'Need help? Contact hello@mindstone.com',
    ].join('\n');
  }

  showStartupErrorBox(title, message);
}

// NOTE: Squirrel.Windows event handling was removed in the NSIS migration (2026-01).
// All Windows users now use NSIS installer. Old Squirrel installations on Windows are
// cleaned up by ./services/squirrelCleanupService.ts on first NSIS app launch.
// macOS continues to use Squirrel.Mac via update-electron-app (no CLI args needed).

// Early health check: create logs dir, detect (but don't fix) corrupted state.
// Must run BEFORE singleInstanceLock to ensure logs/ exists for diagnostics.
// Capture result for potential error dialog if startup fails.
let startupHealth: UserDataHealthResult = {
  healthy: true,
  issues: [],
  settingsCorrupted: false,
  settingsPath: '',
};
try {
  startupHealth = ensureUserDataHealth();
} catch (err) {
  console.error('[bootstrap] Health check failed:', err);
}

// Acquire single-instance lock (skipped in headless CLI mode)
acquireSingleInstanceLock();

// Inject system certificates into Node.js TLS and start the main app.
// Must run before import('./index') so all HTTPS calls trust the OS cert store.
// NOTE: Startup modules above (ensureAppIdentity, health check, etc.) must remain HTTP-free.

// Write a bootstrap diagnostic line to a persistent log file.
// console.log/warn in bootstrap runs before pino, so it only goes
// to stdout (invisible in packaged builds). This writes to a real file.
function logBootstrap(message: string): void {
  console.log(message);
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, 'bootstrap-diagnostics.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Best effort
  }
}

/**
 * Load OS system certificates into Node.js TLS default CA list.
 *
 * Node.js uses a hardcoded Mozilla CA bundle by default, which does NOT include
 * corporate SSL inspection proxy CAs installed in the Windows/macOS cert store.
 * This causes "unable to get local issuer certificate" errors on enterprise networks.
 *
 * Uses native Node.js 22.15+ APIs (no external dependencies):
 * - tls.getCACertificates('system') — reads the OS certificate store
 * - tls.getCACertificates('bundled') — returns the built-in Mozilla CA bundle
 * - tls.setDefaultCACertificates() — replaces the default CA list for all TLS connections
 *
 * This replaces the deprecated `win-ca` package which relied on a fragile `roots.exe`
 * binary, CJS interop hacks, and asar unpacking — and silently failed in production.
 *
 * @see https://nodejs.org/api/tls.html#tlsgetcacertificatestype
 * @see https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts
 * @see docs/project/WINDOWS_SUPPORT.md (TLS Certificate Trust section)
 */
function loadSystemCertificates(): void {
  try {
     
    const tls = require('node:tls') as typeof import('node:tls');

    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
      logBootstrap(`[bootstrap] System CA APIs not available — skipping (node: ${process.version}, electron: ${process.versions.electron ?? 'n/a'})`);
      return;
    }

    const bundledCerts = tls.getCACertificates('bundled');
    const systemCerts = tls.getCACertificates('system');

    // Merge Mozilla bundle + OS system certs, deduplicating overlaps
    const uniqueCerts = [...new Set([...bundledCerts, ...systemCerts])];
    tls.setDefaultCACertificates(uniqueCerts);

    logBootstrap(`[bootstrap] System certificates loaded — ${systemCerts.length} system + ${bundledCerts.length} bundled → ${uniqueCerts.length} unique CAs`);

    if (systemCerts.length === 0) {
      logBootstrap('[bootstrap] WARNING: 0 system certificates found — corporate proxy CAs will NOT be trusted. TLS errors likely on managed networks.');
    }
  } catch (err) {
    logBootstrap(`[bootstrap] System certificate loading failed (non-fatal): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

async function startApp(): Promise<void> {
  logBootstrap(`--- app start (v${app.getVersion()}, ${process.platform}/${process.arch}, node ${process.version}, electron ${process.versions.electron ?? '?'}) ---`);

  // Raise the open-files (file-descriptor) soft limit toward the OS hard limit
  // BEFORE `./index` is dynamically imported below (which registers/constructs the
  // ~68 electron-store backers and starts the workspace watcher — the biggest fd
  // consumers). Reduces EMFILE under FD pressure. darwin/linux only; no-op on
  // Windows / non-Electron. See docs/plans/260619_sentry-routing-noise-fd/.
  raiseFdLimit();

  // Load OS certificates into Node.js TLS on all platforms.
  // Windows: corporate SSL inspection proxy CAs from the Windows cert store
  // macOS: enterprise CAs from the Keychain
  // Linux: system CAs from /etc/ssl/certs or similar
  loadSystemCertificates();

  // Decouple outbound DNS from the libuv threadpool BEFORE any outbound HTTP.
  // Node's default `dns.lookup` runs on the 4-thread libuv pool shared with fs /
  // crypto / indexing; under load it stalls past undici's 10s connect timeout →
  // connect timeouts to every host. This installs a global undici dispatcher
  // whose connect-time resolver uses c-ares (off-pool) with dns.lookup fallback.
  // Must run after loadSystemCertificates() (TLS trust) and before import('./index')
  // (first outbound HTTP). See docs/plans/260617_meeting-bot-dns-starvation/PLAN.md.
  try {
    const { installGlobalUndiciDnsDecouple } = await import('@core/utils/dnsThreadpoolDecouple');
    installGlobalUndiciDnsDecouple();
  } catch (err) {
    logBootstrap(
      `[bootstrap] DNS threadpool decouple install failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Field-diagnostics breadcrumb for the libuv-pool buffer (Stage 4b F1).
  // applyThreadpoolSize already SET `UV_THREADPOOL_SIZE` as the very first boot
  // import (it MUST precede the first async pool op — see threadpoolSize.ts). The
  // source-order test cannot prove the EMITTED bundle preserved that order, so a
  // bundler reorder would silently make the buffer a no-op (libuv falls back to
  // 4). This records the value libuv will actually read once the structured
  // logger exists, so a field report shows whether the buffer is in force —
  // a cheap one-shot read, NOT a per-boot saturation probe.
  try {
    const os = await import('node:os');
    const { snapshotThreadpoolBuffer } = await import('@core/startup/threadpoolSize');
    const parallelism =
      typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
    const snapshot = snapshotThreadpoolBuffer(process.env.UV_THREADPOOL_SIZE, parallelism);
    const log = createScopedLogger({ service: 'threadpoolBuffer' });
    if (snapshot.bufferApplied) {
      log.info(
        { ...snapshot, parallelism },
        'libuv threadpool buffer in force (UV_THREADPOOL_SIZE applied before first pool op)',
      );
    } else {
      // Buffer NOT in force — either an operator set a smaller value or the
      // emitted-bundle import order regressed and libuv read the default 4.
      // Surface loudly (the turn-hang blast-radius reducer is absent).
      log.warn(
        { ...snapshot, parallelism },
        'libuv threadpool buffer NOT in force — effective pool below desired (possible bundle import-order regression or operator override)',
      );
    }
    recordMainBreadcrumb({
      category: 'startup',
      level: snapshot.bufferApplied ? 'info' : 'warning',
      message: 'libuv threadpool buffer snapshot',
      data: { ...snapshot, parallelism },
    });
  } catch (err) {
    logBootstrap(
      `[bootstrap] threadpool buffer breadcrumb failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Install the fsevents leak guard from EXECUTED code BEFORE './index' loads:
  // index.ts statically imports the chokidar consumers, and chokidar's
  // fsevents-handler reads `fsevents.watch` via call-time property lookup on
  // the shared CJS exports object — patching that object here guarantees every
  // native instance is tracked (quit-time SIGABRT fix, see
  // docs/plans/260611_fsevents-shutdown-crash/PLAN.md Stage 1). Runs after the
  // NODE_PATH shim above so the packaged app resolves the unpacked fsevents.
  // Fail-open: a guard failure must never break boot.
  try {
    const guardResult = installFseventsLeakGuard();
    logBootstrap(`[bootstrap] fsevents leak guard: ${guardResult}`);
  } catch (err) {
    logBootstrap(
      `[bootstrap] fsevents leak guard install failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await import('./index');

  assetUploadOutbox = new AssetUploadOutbox();
  assetUploadOutbox.start().catch((err: unknown) => {
    console.error('[bootstrap] Failed to start AssetUploadOutbox', err);
  });

  contentUploadOutbox = new ContentUploadOutbox();
  contentUploadOutbox.start().catch((err: unknown) => {
    console.error('[bootstrap] Failed to start ContentUploadOutbox', err);
  });

  // Durable bug-report outbox: boot dir-scan replays any report persisted but
  // not yet delivered (offline/quit/power-loss residual). Failure to start must
  // not break boot.
  startBugReportOutbox()
    .then(() => {
      bugReportOutboxStarted = true;
    })
    .catch((err: unknown) => {
      console.error('[bootstrap] Failed to start BugReportOutbox', err);
    });
}

app.on('will-quit', (event) => {
  const assetDone = !assetUploadOutbox || assetUploadOutboxQuitDrained;
  const contentDone = !contentUploadOutbox || contentUploadOutboxQuitDrained;
  const bugReportDone = !bugReportOutboxStarted || bugReportOutboxQuitDrained;
  if (assetDone && contentDone && bugReportDone) {
    return;
  }

  event.preventDefault();
  if (
    assetUploadOutboxQuitInProgress
    || contentUploadOutboxQuitInProgress
    || bugReportOutboxQuitInProgress
  ) {
    return;
  }

  const drains: Array<Promise<unknown>> = [];
  if (assetUploadOutbox && !assetUploadOutboxQuitDrained) {
    assetUploadOutboxQuitInProgress = true;
    drains.push(
      assetUploadOutbox.stop({ timeoutMs: 5000 })
        .catch((err: unknown) => {
          console.error('[bootstrap] Failed to stop AssetUploadOutbox', err);
        })
        .finally(() => {
          assetUploadOutboxQuitDrained = true;
          assetUploadOutboxQuitInProgress = false;
        }),
    );
  }
  if (contentUploadOutbox && !contentUploadOutboxQuitDrained) {
    contentUploadOutboxQuitInProgress = true;
    drains.push(
      contentUploadOutbox.stop({ timeoutMs: 5000 })
        .catch((err: unknown) => {
          console.error('[bootstrap] Failed to stop ContentUploadOutbox', err);
        })
        .finally(() => {
          contentUploadOutboxQuitDrained = true;
          contentUploadOutboxQuitInProgress = false;
        }),
    );
  }
  if (bugReportOutboxStarted && !bugReportOutboxQuitDrained) {
    bugReportOutboxQuitInProgress = true;
    drains.push(
      stopBugReportOutbox(5000)
        .catch((err: unknown) => {
          console.error('[bootstrap] Failed to stop BugReportOutbox', err);
        })
        .finally(() => {
          bugReportOutboxQuitDrained = true;
          bugReportOutboxQuitInProgress = false;
        }),
    );
  }
  fireAndForget(
    Promise.allSettled(drains).finally(() => {
      app.quit();
    }),
    'bootstrap.quitDrains',
  );
});

startApp().catch((err) => {
  console.error('[bootstrap] Failed to load main entry', err);
  showStartupFailureDialog(err, startupHealth);
  process.exit(1);
});
