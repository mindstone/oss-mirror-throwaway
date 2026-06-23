/**
 * Main window creation (`createWindow`).
 *
 * Extracted from `src/main/index.ts` (Stage 3 of the index.ts startup refactor —
 * see docs/plans/260623_refactor-index-startup-extract/PLAN.md). Behaviour is
 * preserved verbatim; this module owns ONLY the `createWindow` function body and
 * its window/webContents lifecycle listeners. It imports all of its non-local
 * service dependencies (cloudRouter, schedulers, tracking, settings, nav guards,
 * embedding/GPU, auto-update, Sentry, …) DIRECTLY.
 *
 * The state that genuinely lives in index.ts is injected via `deps` (Option B —
 * index.ts keeps `mainWindow` as the single source of truth):
 *   - `setMainWindow(win)` — the two writes (create + closed→null).
 *   - `getMainWindow()` — every in-body read re-reads fresh (invariant #10: NEVER
 *     cache the result across an `await`; the original code read the module global
 *     at every point of use).
 *   - `getAutomationScheduler()` / `getAppReadyTime()` — getters over mutable lets.
 *   - `getCatalogOverrideBanner()` + `clearCatalogOverrideBanner()` — guarded clear
 *     (clear happens ONLY inside the live-window guard, preserving guard-before-clear).
 *   - `getPendingNavigationUrl()` + `clearPendingNavigationUrl()` — guarded clear,
 *     inside the FIRST live-window guard (BEFORE the 500ms React-mount setTimeout);
 *     the deferred send re-reads the window fresh inside the timeout (invariants #8/#10).
 *   - `tryEagerStartOfficeSidecar(trigger)` — injected callback (couples to
 *     whenReady-owned state that stays in index.ts).
 *   - `mainDir` (⚠️ `import.meta.url`-bound — INJECTED, never recomputed here, or
 *     preload/renderer path resolution breaks), `anonymousId`, `appVersion`,
 *     `appName` — index.ts-derived values.
 *
 * The injected-getter wiring (setMainWindowGetter / setUpdateMainWindowGetter /
 * setPluginCompileMainWindow / cloudRouter.setBroadcastService) stays INSIDE the
 * moved `createWindow` (invariant #11) so a window re-create re-wires them.
 *
 * index.ts references this only via `createWindowForEnsure = createWindow` — there
 * is NO literal `createWindow(` call in index.ts (invariant #2), keeping the
 * startup-ipc-ordering guard inert on index.ts.
 */

import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import path from 'node:path';
import fsSync from 'node:fs';

import { createScopedLogger, logger, getLogDirectory } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isTooManyOpenFilesError } from '@core/utils/emfileRetry';
import { tagFsExhaustion } from '@core/utils/gracefulFsObservability';

import { isRebelTestMode, isE2eTestMode } from '../utils/testIsolation';
import { getBuildChannel } from '../utils/buildChannel';
import { isAllowedExternalUrl, safeUrlScheme } from '../utils/isAllowedExternalUrl';
import { isSentryExplicitlyDisabledByEnv } from '@shared/telemetry/sentryConfig';
import { isAnalyticsDisabledByEnv } from '../analytics';
import { captureMainException } from '../sentry';
import { toTelemetrySafeUrl } from '../utils/processGoneCapture';
import { mainTracking } from '../tracking';
import { getSettings, settingsStore } from '../settingsStore';
import { getDiagnosticsSnapshot } from '../settingsStore';
import { maybeSurfaceFdExhaustionWarning } from '../diagnostics/mainDiagnostics';

import { cloudRouter } from '../services/cloud/cloudRouter';
import {
  setGpuWorkerThrottling,
  disposeGpuBackendOnBlur,
  warmUpGpuBackend,
} from '../services/embeddingService';
import { initVisibilityScheduler, initBlurScheduler } from '../services/visibilityAwareScheduler';
import { initDockBadge, clearUnreadDot } from '../services/dockBadgeService';
import { startCloudUpdateScheduler } from '../services/cloudUpdateScheduler';
import { isUpdateDownloading } from '../services/autoUpdateService';
import { setMainWindowGetter } from '../services/voiceHotkeyService';
import { setUpdateMainWindowGetter } from '../services/updateNotificationState';
import { setPluginCompileMainWindow } from '../services/pluginCompileBridge';
import type { AutomationScheduler } from '../services/automationScheduler';

/**
 * Index.ts-local accessors + values the window factory depends on. Everything
 * else is imported directly (Decision Log §8.2 idiom) — only this bundle is state
 * that genuinely lives in index.ts.
 */
export interface MainWindowFactoryDeps {
  /** Set the main window (covers create-assign + closed→null). index.ts owns the `let`. */
  setMainWindow: (win: BrowserWindow | null) => void;
  /**
   * Read the main window fresh. ⚠️ invariant #10: call AT POINT OF USE; NEVER cache
   * across an `await` (async webContents handlers + the 500ms pending-nav timeout).
   */
  getMainWindow: () => BrowserWindow | null;
  /**
   * Mutable automation scheduler (getter, not a snapshot). Reads the raw nullable
   * `let` — returns null when not yet created (NO lazy creation side-effect, matching
   * the original in-body `const scheduler = automationScheduler;`).
   */
  getAutomationScheduler: () => AutomationScheduler | null;
  /** App-ready timestamp; non-consuming. `isColdStart = getAppReadyTime() !== null`. */
  getAppReadyTime: () => number | null;
  /** Catalog-override startup banner (getter). */
  getCatalogOverrideBanner: () => string | null;
  /** Clear the catalog-override banner — called ONLY inside the live-window guard. */
  clearCatalogOverrideBanner: () => void;
  /** Buffered cold-start navigation URL (getter). */
  getPendingNavigationUrl: () => string | null;
  /** Clear the pending navigation URL — called ONLY inside the live-window guard. */
  clearPendingNavigationUrl: () => void;
  /** Eager-start the Office sidecar (couples to whenReady-owned state in index.ts). */
  tryEagerStartOfficeSidecar: (trigger: string) => void;
  /** ⚠️ `import.meta.url`-derived dir from index.ts — INJECTED, never recomputed here. */
  mainDir: string;
  /** Anonymous analytics id ('' when telemetry not permitted). */
  anonymousId: string;
  /** App version string. */
  appVersion: string;
  /** App name. */
  appName: string;
}

/**
 * Build the `createWindow` function with its injected dependency bundle. The
 * returned async function is wired into index.ts as `createWindowForEnsure`
 * (after IPC handler registration — invariant #1); it is never called by name
 * literally in index.ts (invariant #2).
 */
export function createMainWindowFactory(deps: MainWindowFactoryDeps): () => Promise<void> {
  const {
    setMainWindow,
    getMainWindow,
    getAutomationScheduler,
    getAppReadyTime,
    getCatalogOverrideBanner,
    clearCatalogOverrideBanner,
    getPendingNavigationUrl,
    clearPendingNavigationUrl,
    tryEagerStartOfficeSidecar,
    mainDir,
    anonymousId,
    appVersion,
    appName,
  } = deps;

  return async function createWindow(): Promise<void> {
    // Window object identity is stable once created; index.ts owns `mainWindow`.
    // We attach listeners to this object directly, but every in-callback / post-await
    // read goes through getMainWindow() to re-read the module global (invariant #10).
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      // 640px lets the window snap to half-screen on common laptops (1280/1440/1512
      // logical px → 640/720/756 half-width) for split-screen use (FOX-3259). The
      // renderer's responsive layout adapts below this (app shell at 900px, panels to
      // 640px). minHeight stays 700 — left/right split-screen constrains width, not height.
      minWidth: 640,
      minHeight: 700,
      show: false,
      title: isRebelTestMode() ? 'Mindstone Rebel [TEST]' : 'Mindstone Rebel',
      webPreferences: {
        preload: (() => {
          // Forge builds put preload.js alongside main; electron-vite builds put it in ../preload/
          const forgePath = path.join(mainDir, 'preload.js');
          const evitePath = path.join(mainDir, '../preload/index.js');
          if (fsSync.existsSync(forgePath)) return forgePath;
          if (fsSync.existsSync(evitePath)) {
            logger.warn({ forgePath, evitePath }, 'Using electron-vite preload path (Forge preload not found)');
            return evitePath;
          }
          logger.error({ forgePath, evitePath }, 'No preload script found at either path');
          return forgePath; // let Electron surface the error
        })(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Required for Chromium's built-in PDF viewer (PDFium) used by the
        // document preview panel. Navigation guards (will-navigate, setWindowOpenHandler,
        // frame-level navigation blocking) restrict where plugins can operate.
        plugins: true,
        additionalArguments: [
          // OSS no-phone-home gate: ANONYMOUS_ID is '' when telemetry is not
          // permitted (OSS opt-in OFF). Omit the flag entirely in that case so the
          // renderer's preload parses `null` rather than an empty identity.
          ...(anonymousId ? [`--anonymous-id=${anonymousId}`] : []),
          `--app-version=${appVersion}`,
          `--app-name=${appName}`,
          `--build-channel=${getBuildChannel()}`,
          `--disable-analytics=${isAnalyticsDisabledByEnv() ? 'true' : 'false'}`,
          // Runtime Sentry kill-switch bridge: renderer Sentry enablement is
          // build-inlined (import.meta.env), so a runtime SENTRY_ENABLED=0 (e.g.
          // CI packaged-app launches) would suppress only MAIN. Propagate the
          // explicit opt-out so the renderer bails before Sentry.init. The flag
          // wins over everything renderer-side (incl. OSS settings telemetry) —
          // it only appears when the host was explicitly disabled at runtime.
          ...(isSentryExplicitlyDisabledByEnv() ? ['--rebel-sentry-disabled'] : []),
          // E2E test mode flags - survive Vite bundling since they're passed at runtime
          ...(process.env.REBEL_E2E_TEST_MODE === '1' ? ['--e2e-test-mode'] : []),
          ...(process.env.REBEL_TEST_USER_DATA_DIR ? [`--e2e-test-user-data-dir=${process.env.REBEL_TEST_USER_DATA_DIR}`] : []),
          ...(process.env.REBEL_TEST_MODE === '1' ? ['--rebel-test-mode'] : [])
        ]
      }
    });
    setMainWindow(win);

    // In E2E test mode, keep the window hidden to avoid blocking the developer's
    // screen. Playwright uses CDP (not native events), so interactions work on
    // non-shown windows. We skip maximize() too because on macOS it force-shows
    // the window. backgroundThrottling=false ensures Chromium treats the page as
    // visible (document.hidden stays false, timers/RAF run at full speed).
    // Note: mainWindow.on('focus') never fires for a never-shown window, so
    // cloudRouter.onAppFocused() and clearUnreadDot() won't run — both are
    // irrelevant in E2E (cloud sync is mocked, dock badge is suppressed).
    // Test-utils overrides window size to 1280x800 via trySetDeterministicWindowBounds.
    if (isE2eTestMode()) {
      win.webContents.backgroundThrottling = false;
      win.setSize(1440, 900);
      if (process.platform === 'darwin') {
        try {
          app.dock?.hide();
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'e2e-hide-dock',
            reason: 'dock API may not be available',
          });
        }
      }
    } else {
      win.maximize();
      win.show();
    }

    // Windows: Hide window (instead of closing) when update is downloading
    // This gives immediate visual feedback while keeping the process alive for Squirrel
    // See: docs/plans/finished/260127_Fix_Windows_Squirrel_Download_Quit.md
    let isHiddenForUpdateDownload = false;
    let isSystemShuttingDown = false;

    // Detect OS shutdown - don't fight the system, let it close us
    // Use .once to prevent duplicate registrations if createWindow is called again (macOS)
    powerMonitor.once('shutdown', () => {
      logger.info('[powerMonitor] System shutdown detected - bypassing update download interception');
      isSystemShuttingDown = true;
    });

    // GPU worker throttling + blur disposal based on app visibility
    // Throttling is immediate; GPU disposal is debounced to avoid churn on quick alt-tab
    let gpuBlurDisposalTimer: ReturnType<typeof setTimeout> | null = null;
    const GPU_BLUR_DISPOSAL_DELAY_MS = 15_000;

    win.on('focus', () => {
      setGpuWorkerThrottling(false); // Full speed when focused
      // Cancel pending GPU disposal if user returned quickly
      if (gpuBlurDisposalTimer !== null) {
        clearTimeout(gpuBlurDisposalTimer);
        gpuBlurDisposalTimer = null;
      }
      warmUpGpuBackend();
      cloudRouter.onAppFocused(); // Sync sessions from cloud if in cloud mode
      clearUnreadDot();
    });

    win.on('blur', () => {
      setGpuWorkerThrottling(true); // Immediate throttle
      // Clear any existing timer to prevent stacking on rapid blur events
      if (gpuBlurDisposalTimer !== null) {
        clearTimeout(gpuBlurDisposalTimer);
      }
      // Debounced disposal — only if blur persists for 15s
      gpuBlurDisposalTimer = setTimeout(() => {
        gpuBlurDisposalTimer = null;
        disposeGpuBackendOnBlur();
      }, GPU_BLUR_DISPOSAL_DELAY_MS);
    });

    win.on('closed', () => {
      if (gpuBlurDisposalTimer !== null) {
        clearTimeout(gpuBlurDisposalTimer);
        gpuBlurDisposalTimer = null;
      }
    });

    // Initialize visibility-aware scheduler for main process intervals
    // Allows non-critical background tasks to pause/throttle when app is hidden
    initVisibilityScheduler(win);
    // Initialize blur-aware scheduler (independent from minimize-based visibility)
    // Enables opt-in pause/throttle when user switches to another app (e.g., Zoom)
    initBlurScheduler(win);
    initDockBadge(win);

    // NOTE: Battery scheduler (initBatteryScheduler) is initialized earlier in app.on('ready')
    // before any services start, since it doesn't require the window (only powerMonitor).

    // Auto-update the user's BYOK cloud (Continuity) instance on startup + every 24h.
    // Must run after visibility/blur schedulers because the 24h interval opts into
    // pauseOnBlur. The scheduler is a no-op when the user isn't on a BYOK cloud.
    startCloudUpdateScheduler(getSettings);

    win.on('close', (event) => {
      const downloading = isUpdateDownloading();
      logger.debug({ downloading, isHiddenForUpdateDownload, isSystemShuttingDown }, '[mainWindow.close] Close event fired');

      // Only intercept on Windows when an update is downloading AND we haven't already handled it
      // Don't intercept during OS shutdown - the system will kill us anyway
      if (process.platform === 'win32' && downloading && !isHiddenForUpdateDownload && !isSystemShuttingDown) {
        event.preventDefault();
        isHiddenForUpdateDownload = true;

        logger.info('[mainWindow.close] Update downloading - hiding window and triggering graceful shutdown');

        // Show brief dialog, then hide window and trigger app.quit()
        // The gracefulShutdown handler will keep process alive until download completes.
        // eslint-disable-next-line rebel-startup-dialog/no-raw-startup-dialog -- This is window-PARENTED (passes the live BrowserWindow), so it is a window sheet, not a parent-less app-modal [NSAlert runModal] — explicitly the "OUT" / non-hazard case per startupDialog.ts's class boundary. It is also win32-update-download-close only (never the automated/headless boot path), so routing through showStartupMessageBox would (a) be the wrong tool and (b) drop the parent and change behaviour. Behaviour preserved verbatim from the original index.ts createWindow body.
        dialog.showMessageBox(getMainWindow() as Electron.BaseWindow, {
          type: 'info',
          title: 'Update Downloading',
          message: 'An update is downloading in the background. Rebel will close automatically when it finishes.',
          buttons: ['OK'],
          noLink: true,
        }).then(() => {
          logger.info('[mainWindow.close] User acknowledged, hiding window and initiating quit');
          const liveWin = getMainWindow();
          if (liveWin && !liveWin.isDestroyed()) {
            liveWin.hide();
          }
          // Trigger app.quit() which enters gracefulShutdown's "wait for download" path
          // The window is hidden but process stays alive
          app.quit();
        }).catch(() => {
          logger.warn('[mainWindow.close] Dialog failed, hiding window and initiating quit anyway');
          const liveWin = getMainWindow();
          if (liveWin && !liveWin.isDestroyed()) {
            liveWin.hide();
          }
          app.quit();
        });

        return;
      }

      // If already hidden waiting for download, only block if download is still in progress
      // Once download completes (or errors), allow the close to proceed normally
      if (isHiddenForUpdateDownload && downloading) {
        event.preventDefault();
        logger.info('[mainWindow.close] Already hidden for update download, blocking close while download in progress');
        return;
      }
    });

    win.on('closed', () => {
      logger.debug('[mainWindow.closed] Window destroyed');
      setMainWindow(null);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- intentionally passing null to clear the reference; setBroadcastService's type doesn't accept null but teardown requires it
      cloudRouter.setBroadcastService(null!);
      // On Windows/Linux: closing the main UI window should quit the app, even if hidden
      // utility windows exist (e.g. GPU embedding worker).
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    // Set main window getter for voice hotkey service
    setMainWindowGetter(() => getMainWindow());

    // Set main window getter for update notifications (auto-update and Linux update prompts)
    setUpdateMainWindowGetter(() => getMainWindow());

    // Set main window getter for plugin compile bridge (avoids targeting hidden utility windows)
    setPluginCompileMainWindow(() => getMainWindow());

    // Set broadcast service for cloud router agent event dispatch (uses BroadcastService boundary interface, not BrowserWindow directly)
    cloudRouter.setBroadcastService(getBroadcastService());

    // Show a diagnostic error page if the renderer fails to load (prevents blank white screen)
    let hasShownLoadError = false;
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */ || hasShownLoadError) return;
      hasShownLoadError = true;
      logger.error({ errorCode, errorDescription, validatedURL }, 'Renderer failed to load');
      const logDir = getLogDirectory();
      const errorHtml = `<html><body style="font-family:system-ui;padding:40px;background:#1a1a1a;color:#e0e0e0;">
        <h1 style="color:#f87171;">Failed to load</h1>
        <p><strong>Error ${errorCode}:</strong> ${errorDescription}</p>
        <p style="color:#888;">URL: ${validatedURL}</p>
        <p style="margin-top:24px;color:#888;">Logs: <code>${logDir}</code></p>
        <p style="color:#666;font-size:13px;">For development, run <code>npm run dev</code> (or <code>npm start</code> to skip predev).<br/>
        To test a production build, use <code>npm run package:run</code>.</p>
      </body></html>`;
      fireAndForget(
        Promise.resolve(getMainWindow()?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`)),
        'index.didFailLoad.loadErrorPage',
      );
      // Surface the blank-screen-causing load failure to Sentry. Previously this
      // was logged to pino only, so a renderer that never loaded was invisible to
      // fleet monitoring (the "app won't work at all" / blank-screen class). The
      // existing guards above (main-frame only, !ERR_ABORTED, hasShownLoadError
      // latch) already prevent benign/duplicate captures. Sync capture +
      // enlarged log buffer; never throws (sentry.ts guards internally).
      captureMainException(new Error('Renderer failed to load'), {
        // Static message + faceting via tags/extra → one stable Sentry issue,
        // not a fragment per errorCode (rebel-sentry/no-dynamic-capture-message;
        // the REBEL-1AR fingerprint-fragmentation lesson).
        tags: { area: 'renderer', component: 'load', errorCode: String(errorCode) },
        extra: { errorCode, errorDescription, validatedURL: toTelemetrySafeUrl(validatedURL) },
      });
    });

    // Load renderer with Electron Forge Vite plugin support
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      // Development mode - use Vite dev server for HMR
      await win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      // Only open devtools in development mode
      if (!app.isPackaged) {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    } else {
      // Production mode - load from built files
      // Handle both Forge build (MAIN_WINDOW_VITE_NAME = "main_window") and
      // electron-vite build (MAIN_WINDOW_VITE_NAME = undefined)
      const rendererPath = MAIN_WINDOW_VITE_NAME
        ? path.join(mainDir, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
        : path.join(mainDir, '../renderer/index.html');
      await win.loadFile(rendererPath);
    }

    // Post-await: re-read the module global ONCE into `loadedWin` and register the
    // synchronous post-load listeners on it directly (invariant #10 — this re-read is
    // AFTER the load await and used SYNCHRONOUSLY: there is NO `await` between this
    // re-read and the last registration below, so a single local is correct here).
    // The original code dereferenced the `mainWindow` global directly at these sites,
    // which would THROW LOUDLY if it were unexpectedly null; we preserve that loud
    // failure (rather than silently skipping security/lifecycle listeners) by guarding
    // explicitly and bailing observably. Note: deferred re-reads INSIDE async callbacks
    // (event handlers, the 500ms setTimeout) MUST still re-read fresh via getMainWindow()
    // at their point of use — only this synchronous registration block uses `loadedWin`.
    const loadedWin = getMainWindow();
    if (!loadedWin || loadedWin.isDestroyed()) {
      logger.error(
        { hasWindow: Boolean(loadedWin) },
        'createWindow: main window absent/destroyed before post-load listener registration — skipping lifecycle/security listeners',
      );
      return;
    }

    loadedWin.webContents.once('did-finish-load', () => {
      // Track startup duration to RudderStack for performance monitoring
      // coldStart=true for initial launch (vs window recreation on macOS activate)
      const appReadyTime = getAppReadyTime();
      const launchDurationMs = appReadyTime ? Date.now() - appReadyTime : 0;
      const isColdStart = appReadyTime !== null;
      mainTracking.applicationOpened(isColdStart, launchDurationMs);
      logger.info({ launchDurationMs, coldStart: isColdStart }, '[startup] Application Opened event sent to analytics');

      const scheduler = getAutomationScheduler();
      const schedulerWin = getMainWindow();
      if (scheduler && schedulerWin && !schedulerWin.isDestroyed()) {
        schedulerWin.webContents.send('automation:state', scheduler.getState());
      }

      // Push stored email to renderer for analytics identification
      // (email no longer passed via CLI args for privacy)
      const storedEmail = settingsStore.store.userEmail;
      const emailWin = getMainWindow();
      if (storedEmail && emailWin && !emailWin.isDestroyed()) {
        emailWin.webContents.send('user:email-identified', { email: storedEmail });
      }

      const banner = getCatalogOverrideBanner();
      const bannerWin = getMainWindow();
      if (banner && bannerWin && !bannerWin.isDestroyed()) {
        bannerWin.webContents.send('catalog:override-warning', {
          message: banner,
        });
        clearCatalogOverrideBanner();
      }

      // Flush any buffered navigation deep link from cold start
      const pendingNav = getPendingNavigationUrl();
      const navWin = getMainWindow();
      if (pendingNav && navWin && !navWin.isDestroyed()) {
        const url = pendingNav;
        clearPendingNavigationUrl();
        // Small delay to let React mount the NavigationProvider and register the listener
        setTimeout(() => {
          const delayedWin = getMainWindow();
          if (delayedWin && !delayedWin.isDestroyed()) {
            delayedWin.webContents.send('app:navigate-deep-link', url);
          }
        }, 500);
      }

      tryEagerStartOfficeSidecar('did-finish-load');
    });

    // Prevent navigation within the main window - external links should use shell.openExternal
    loadedWin.webContents.on('will-navigate', (event, url) => {
      const currentUrl = getMainWindow()?.webContents.getURL() ?? '';
      // Allow navigation to the same origin (for dev server HMR) but block external URLs
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        // Dev mode: allow same-origin navigation
        const currentOrigin = new URL(currentUrl).origin;
        const targetOrigin = new URL(url).origin;
        if (currentOrigin !== targetOrigin) {
          logger.warn({ url, currentUrl }, 'Blocked navigation to external URL in dev mode');
          event.preventDefault();
          // Fail-closed: only forward http(s) URLs to the OS. See
          // src/main/utils/isAllowedExternalUrl.ts and
          // docs-private/investigations/260423_ui_canvas_link_opens_firefox.md.
          if (isAllowedExternalUrl(url)) {
            shell.openExternal(url).catch((err) => {
              logger.warn({ err, url }, 'Failed to open external URL');
            });
          } else {
            logger.warn({ url, scheme: safeUrlScheme(url) }, 'Blocked navigation attempt with non-http(s) URL');
          }
        }
      } else {
        // Production: block all navigation (app should use IPC for external URLs)
        logger.warn({ url, currentUrl }, 'Blocked navigation attempt in production - this may indicate a bug');
        event.preventDefault();
      }
    });

    // Block new window creation and open external URLs in browser instead.
    // Fail-closed: only http(s) URLs are forwarded to the OS. Other schemes
    // (ui://, javascript:, file:, data:, rebel://, ...) are denied without
    // calling shell.openExternal, because macOS delegates unknown schemes to
    // the default browser — silently escaping in-app resource URIs. See
    // src/main/utils/isAllowedExternalUrl.ts and
    // docs-private/investigations/260423_ui_canvas_link_opens_firefox.md.
    loadedWin.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        logger.info({ url }, 'New-window request — denying in-app, opening in external browser');
        shell.openExternal(url).catch((err) => {
          logger.warn({ err, url }, 'Failed to open external URL');
        });
      } else {
        const scheme = safeUrlScheme(url);
        logger.warn({ url, scheme }, 'Blocked new-window request with non-http(s) URL');
      }
      return { action: 'deny' };
    });

    // Block iframe navigation to external URLs (security for rebel-html:// preview iframes)
    // This prevents HTML files from navigating their iframe to external sites
    loadedWin.webContents.on('will-frame-navigate', (event) => {
      const frame = event.frame;
      const url = event.url;
      // Allow navigation within our custom protocols (rebel-html, rebel-tutorial, rebel-media, rebel-preview)
      if (url.startsWith('rebel-html://') || url.startsWith('rebel-tutorial://') || url.startsWith('rebel-media://') || url.startsWith('rebel-preview://')) {
        return;
      }
      // Allow blob URLs for MCP Apps sandboxed iframes
      // These are created by McpAppView component for rendering UI resources
      // Security: blob URLs are scoped to the creating origin, and the iframe uses
      // sandbox="allow-scripts" which prevents most dangerous operations
      if (url.startsWith('blob:')) {
        return;
      }
      // Allow YouTube embeds for tutorial videos and conversation media embeds
      if (url.startsWith('https://www.youtube.com/embed/') || url.startsWith('https://www.youtube-nocookie.com/embed/')) {
        return;
      }
      // Allow tutorial player server (localhost wrapper for YouTube embeds in production)
      // This workaround is needed because file:// protocol cannot send valid HTTP Referer headers
      // Use strict pathname matching to prevent bypass attacks
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.hostname === '127.0.0.1' && parsedUrl.pathname === '/tutorial-player') {
          return;
        }
      } catch (error) {
        // Malformed URL intentionally falls through to the block-navigation
        // default below; the secure fail-closed block IS the handling. Record
        // the swallow at debug for observability.
        ignoreBestEffortCleanup(error, {
          operation: 'iframe-navigation-url-parse',
          reason: 'unparseable URL falls through to navigation block',
        });
      }
      // Block all other navigation from non-main frames (iframes)
      if (!frame || !frame.parent) {
        // This is the main frame (or frame is null) - let it through (handled by will-navigate)
        return;
      }
      logger.warn({ url, frameUrl: frame.url }, 'Blocked iframe navigation to external URL');
      event.preventDefault();
    });

    // NOTE: Context menu handler is registered globally via app.on('web-contents-created')
    // at the start of app.on('ready') - see "Global Context Menu Handler" section.

    // Capture renderer console output for debugging (useful for AI agents reading logs)
    // Dev: all levels captured. Production: warn/error always; log/debug gated behind diagnostics.
    const rendererConsoleLogger = createScopedLogger({ channel: 'renderer-console' });
    loadedWin.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      try {
        // Level mapping: 0=verbose/debug, 1=info/log, 2=warning, 3=error
        const isVerbose = level <= 1;
        if (isVerbose && app.isPackaged) {
          // In production: verbose console is gated behind diagnostics mode
          const diagnostics = getDiagnosticsSnapshot();
          const diagnosticsActive = Boolean(diagnostics.debugBreadcrumbsUntil && diagnostics.debugBreadcrumbsUntil > Date.now());
          if (!diagnosticsActive) {
            return;
          }
        }

        const logLevel = level <= 1 ? 'debug' : level === 2 ? 'warn' : 'error';
        rendererConsoleLogger[logLevel]({ source: sourceId, line }, `[Renderer] ${message}`);
      } catch (error) {
        if (isTooManyOpenFilesError(error)) {
          tagFsExhaustion(error, 'console_message_relay');
          maybeSurfaceFdExhaustionWarning();
          // Record the FD-exhaustion swallow for observability (tagFsExhaustion /
          // maybeSurfaceFdExhaustionWarning handle the operational side-effects;
          // this marks the catch as an intentional best-effort swallow).
          ignoreBestEffortCleanup(error, {
            operation: 'console-message-relay',
            reason: 'renderer console relay hit FD exhaustion',
          });
          return;
        }
        // rendererConsoleLogger is a scoped @core/logger instance, so this warn
        // is structured observability for the relay failure.
        rendererConsoleLogger.warn({ err: error }, 'console-message relay failed');
        return;
      }
    });
  };
}
