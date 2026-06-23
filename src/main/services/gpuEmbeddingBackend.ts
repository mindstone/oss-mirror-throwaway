/**
 * GPU Embedding Backend
 *
 * Manages a Hidden BrowserWindow for GPU-accelerated embedding generation.
 * Uses WebGPU when available, with automatic fallback detection.
 *
 * Key features:
 * - Sandboxed, isolated session for security
 * - Crash recovery with permanent downgrade after repeated failures
 * - Proper disposal with request drain to prevent race conditions
 *
 * IMPORTANT: This is a completely separate implementation from the CPU worker.
 * Do not share state between GPU and CPU backends.
 */

import { BrowserWindow, ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import type { CallerIntent } from '@core/embeddingGenerator';
import { GPU_EMBEDDING_CHANNEL } from '@shared/ipc/gpuEmbeddingContract';
import type { GpuEmbedRequest, GpuEmbedResponse } from '@shared/ipc/gpuEmbeddingContract';
import { fireAndForget } from '@shared/utils/fireAndForget';

const logger = createScopedLogger({ service: 'gpuEmbeddingBackend' });

const PROBE_TIMEOUT_MS = 5000;
const INIT_TIMEOUT_MS = 60000;
const PRIORITY_REQUEST_TIMEOUT_MS = 5000; // 5s for priority requests (user-facing queries)
const BATCH_REQUEST_TIMEOUT_MS = 15000; // 15s for batch requests (background indexing)
const MAX_CONSECUTIVE_FAILURES = 3;
const RESTART_DELAY_MS = 1000;
const DRAIN_TIMEOUT_MS = 10000;

interface PendingRequest {
  resolve: (value: number[] | number[][]) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

function normalizeCallerIntent(callerIntent: CallerIntent | boolean | undefined): CallerIntent {
  if (callerIntent === true) return 'user_query';
  if (callerIntent === false || callerIntent === undefined) return 'background_indexing';
  return callerIntent;
}

function usesPriorityQueue(callerIntent: CallerIntent): boolean {
  return callerIntent === 'user_query';
}

/**
 * Callback type for GPU backend disposal notifications.
 * Called when the GPU backend disposes itself (e.g., due to idle timeout).
 * The embedding service uses this to synchronize its state.
 */
export type GpuDisposalCallback = () => void;

export class GpuEmbeddingBackend {
  private readonly responseChannel = `${GPU_EMBEDDING_CHANNEL}:response`;
  private readonly onResponse = (event: Electron.IpcMainEvent, response: GpuEmbedResponse) => {
    this.handleResponse(event, response);
  };
  private tempResponseListeners = new Set<(
    event: Electron.IpcMainEvent,
    response: GpuEmbedResponse
  ) => void>();

  private window: BrowserWindow | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private consecutiveFailures = 0;
  private permanentlyDisabled = false;
  private gpuAvailable = false;
  private isInitialized = false;
  private isDisposing = false;
  private initPromise: Promise<boolean> | null = null;
  private disposePromise: Promise<void> | null = null;
  private cacheDir: string;
  private idleTimerMs: number = process.platform === 'darwin' ? 30 * 1000 : 5 * 60 * 1000;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = Date.now();
  private onIdleCallback: (() => void) | null = null;
  private onDisposalCallback: GpuDisposalCallback | null = null;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /**
   * Register a callback to be notified when the GPU backend disposes itself.
   * This allows the embedding service to synchronize its state (e.g., clear gpuBackend reference).
   * The callback is invoked AFTER disposal completes.
   */
  onDisposal(callback: GpuDisposalCallback): void {
    this.onDisposalCallback = callback;
  }

  async initialize(): Promise<boolean> {
    if (this.permanentlyDisabled) {
      logger.warn('GPU backend permanently disabled due to repeated failures');
      return false;
    }

    // Wait for any in-progress disposal to complete before re-initializing
    if (this.disposePromise) {
      await this.disposePromise;
    }
    this.isDisposing = false;

    if (this.isInitialized && this.window && !this.window.isDestroyed()) {
      return this.gpuAvailable;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    try {
      await this.createWindow();

      // First probe WebGPU availability
      this.gpuAvailable = await this.probeWebGPU();

      if (!this.gpuAvailable) {
        logger.info('WebGPU not available in this environment');
        await this.dispose();
        return false;
      }

      // Initialize the embedding pipeline
      await this.initPipeline();

      this.isInitialized = true;
      this.consecutiveFailures = 0;
      getErrorReporter().addBreadcrumb({
        category: 'gpu-worker',
        message: 'GPU backend initialized',
        data: { gpuAvailable: this.gpuAvailable },
        level: 'info',
      });
      logger.info('GPU embedding backend initialized with WebGPU');

      // Start idle timer with default disposal behavior
      this.startIdleTimer(() => {
        fireAndForget(this.dispose(), 'gpuEmbeddingBackend.line150');
      });

      return true;
    } catch (error) {
      // Renderer ready timeout is expected on slow devices (e.g., Windows software renderer)
      // This is graceful degradation to CPU, not an error
      if (error instanceof Error && error.message === 'Renderer ready timeout') {
        logger.info('GPU renderer ready timeout - falling back to CPU (expected on slow devices)');
      } else {
        logger.error({ err: error }, 'Failed to initialize GPU embedding backend');
      }
      await this.dispose();
      return false;
    } finally {
      this.initPromise = null;
    }
  }

  private async createWindow(): Promise<void> {
    // Ensure app is ready before creating BrowserWindow
    // This prevents "Cannot create BrowserWindow before app is ready" errors
    await app.whenReady();

    const preloadPath = this.getPreloadPath();

    this.window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        // NOTE: nodeIntegration must be disabled for WebGPU on Windows (Electron #44880)
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: false,
        backgroundThrottling: false,
        offscreen: true,
        preload: preloadPath,
      },
      skipTaskbar: true,
      focusable: false,
    });

    // Set up response handler (remove any existing to prevent leaks on restart)
    ipcMain.off(this.responseChannel, this.onResponse);
    ipcMain.on(this.responseChannel, this.onResponse);

    // Capture console messages for debugging
    this.window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const logLevel = level <= 1 ? 'debug' : level === 2 ? 'warn' : 'error';
      logger[logLevel]({ source: sourceId, line }, `[GPU Worker Console] ${message}`);
    });

    // Crash recovery
    this.window.webContents.on('render-process-gone', (_event, details) => {
      logger.error({ reason: details.reason, exitCode: details.exitCode }, 'GPU worker crashed');
      this.handleCrash();
    });

    this.window.on('closed', () => {
      this.window = null;
      if (this.isInitialized) {
        logger.warn('GPU worker window closed unexpectedly');
        this.handleCrash();
      }
    });

    this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      logger.error({ errorCode, errorDescription }, 'GPU worker page failed to load');
    });

    // Set up rendererReady listener BEFORE loading
    const rendererReadyPromise = this.waitForRendererReady();

    const htmlPath = this.getHtmlPath();
    logger.debug({ preloadPath, htmlPath }, 'Loading GPU worker HTML...');

    // Await loadFile and rendererReady concurrently to prevent unhandled rejection.
    // If we await sequentially, the rendererReady timeout can fire while no handler
    // is attached to the promise (during loadFile), causing an unhandled rejection.
    await Promise.all([
      this.window.loadFile(htmlPath).then(() => {
        logger.debug('GPU worker HTML loaded successfully');
      }),
      rendererReadyPromise.then(() => {
        logger.debug('GPU worker renderer is ready');
      })
    ]);
  }

  private isFromWorker(event: Electron.IpcMainEvent): boolean {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  private addTempResponseListener(
    handler: (event: Electron.IpcMainEvent, response: GpuEmbedResponse) => void
  ): () => void {
    ipcMain.on(this.responseChannel, handler);
    this.tempResponseListeners.add(handler);
    return () => {
      ipcMain.removeListener(this.responseChannel, handler);
      this.tempResponseListeners.delete(handler);
    };
  }

  private clearTempResponseListeners(): void {
    for (const handler of this.tempResponseListeners) {
      ipcMain.removeListener(this.responseChannel, handler);
    }
    this.tempResponseListeners.clear();
  }

  private waitForRendererReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line prefer-const -- declared before cleanup/timeout mutual reference
      let timeout: NodeJS.Timeout;

      const cleanup = this.addTempResponseListener((event, response) => {
        if (!this.isFromWorker(event)) return;
        if (response.type === 'rendererReady') {
          clearTimeout(timeout);
          cleanup();
          logger.debug('Received rendererReady signal from GPU worker');
          resolve();
        }
      });

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Renderer ready timeout'));
      }, 10000);
    });
  }

  private getPreloadPath(): string {
    if (app.isPackaged) {
      return path.join(
        app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
        'gpu-worker',
        'preload.js'
      );
    }
    const possiblePaths = [
      path.join(__dirname, 'gpu-worker', 'preload.js'),
      path.join(app.getAppPath(), 'out', 'main', 'gpu-worker', 'preload.js'),
      path.join(process.cwd(), 'out', 'main', 'gpu-worker', 'preload.js')
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
    return possiblePaths[1];
  }

  private getHtmlPath(): string {
    if (app.isPackaged) {
      return path.join(
        app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
        'gpu-worker',
        'index.html'
      );
    }
    const possiblePaths = [
      path.join(__dirname, 'gpu-worker', 'index.html'),
      path.join(app.getAppPath(), 'out', 'main', 'gpu-worker', 'index.html'),
      path.join(process.cwd(), 'out', 'main', 'gpu-worker', 'index.html')
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
    return possiblePaths[1];
  }

  private handleResponse(event: Electron.IpcMainEvent, response: GpuEmbedResponse): void {
    // IMPORTANT: Do NOT check isDisposing here - we need to process responses during drain!
    // The isDisposing flag is only set AFTER drain completes.

    if (!this.isFromWorker(event)) {
      return;
    }

    // These are handled by temporary listeners during initialization
    if (
      response.type === 'rendererReady' ||
      response.type === 'probeResult' ||
      response.type === 'ready' ||
      response.type === 'disposed'
    ) {
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      if (response.type === 'error') {
        logger.debug(
          { responseId: response.id, error: response.error },
          'Received error response for unknown request'
        );
        return;
      }
      logger.warn(
        { responseId: response.id, responseType: response.type },
        'Received response for unknown request'
      );
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(response.id);

    if (response.type === 'error') {
      pending.reject(new Error(response.error ?? 'Unknown error'));
    } else if (response.type === 'embedding') {
      if (!response.vector) { pending.reject(new Error('Embedding response missing vector')); return; }
      pending.resolve(response.vector);
    } else if (response.type === 'embeddings') {
      if (!response.vectors) { pending.reject(new Error('Embeddings response missing vectors')); return; }
      pending.resolve(response.vectors);
    }
  }

  private handleCrash(): void {
    this.consecutiveFailures++;
    this.isInitialized = false;
    this.gpuAvailable = false;
    this.clearTempResponseListeners();
    this.rejectAllPending(new Error('GPU worker crashed'));
    
    // Clear idle timer to prevent stale callbacks
    this.resetIdleTimer();
    this.onIdleCallback = null;
    
    // Clean up crashed window to prevent leaks
    const crashedWindow = this.window;
    this.window = null;
    if (crashedWindow && !crashedWindow.isDestroyed()) {
      // Remove event listeners before closing to prevent recursive handleCrash calls
      crashedWindow.removeAllListeners('closed');
      crashedWindow.webContents.removeAllListeners('render-process-gone');
      crashedWindow.destroy();
    }

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.permanentlyDisabled = true;
      logger.error(
        { failures: this.consecutiveFailures },
        'GPU backend permanently disabled after repeated failures'
      );
    } else {
      logger.warn(
        { failures: this.consecutiveFailures, maxFailures: MAX_CONSECUTIVE_FAILURES },
        'GPU worker crashed, will attempt restart'
      );
      setTimeout(() => {
        if (!this.permanentlyDisabled) {
          fireAndForget(this.initialize(), 'gpuEmbeddingBackend.line405');
        }
      }, RESTART_DELAY_MS);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private sendRequest(request: GpuEmbedRequest, priority?: boolean): void {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error('GPU worker window not available');
    }
    // Include priority in the request if specified
    const requestWithPriority = priority !== undefined ? { ...request, priority } : request;
    this.window.webContents.send(GPU_EMBEDDING_CHANNEL, requestWithPriority);
  }

  private async probeWebGPU(): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      // eslint-disable-next-line prefer-const -- declared before cleanup/timeout mutual reference
      let timeout: NodeJS.Timeout;

      const cleanup = this.addTempResponseListener((event, response) => {
        if (!this.isFromWorker(event)) return;
        if (response.id !== id) return;

        if (response.type === 'probeResult') {
          clearTimeout(timeout);
          cleanup();
          resolve(response.gpuAvailable ?? false);
          return;
        }

        if (response.type === 'error') {
          clearTimeout(timeout);
          cleanup();
          logger.debug({ error: response.error }, 'WebGPU probe returned error');
          resolve(false);
        }
      });

      timeout = setTimeout(() => {
        cleanup();
        logger.warn('WebGPU probe timed out');
        resolve(false);
      }, PROBE_TIMEOUT_MS);

      this.sendRequest({ id, type: 'probe' });
    });
  }

  private async initPipeline(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      // eslint-disable-next-line prefer-const -- declared before cleanup/timeout mutual reference
      let timeout: NodeJS.Timeout;

      const cleanup = this.addTempResponseListener((event, response) => {
        if (!this.isFromWorker(event)) return;
        if (response.id !== id) return;

        clearTimeout(timeout);
        cleanup();

        if (response.type === 'ready') {
          this.gpuAvailable = response.gpuAvailable ?? false;
          resolve();
        } else if (response.type === 'error') {
          reject(new Error(response.error ?? 'Pipeline initialization failed'));
        }
      });

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Pipeline initialization timed out'));
      }, INIT_TIMEOUT_MS);

      this.sendRequest({ id, type: 'init', cacheDir: this.cacheDir });
    });
  }

  async generateEmbedding(
    text: string,
    callerIntent: CallerIntent | boolean = 'background_indexing',
  ): Promise<Float32Array> {
    this.markActivity();

    if (!this.isInitialized || !this.window || this.window.isDestroyed()) {
      throw new Error('GPU backend not initialized');
    }

    if (this.permanentlyDisabled) {
      throw new Error('GPU backend permanently disabled');
    }

    if (this.isDisposing) {
      throw new Error('GPU backend is disposing');
    }

    const id = crypto.randomUUID();
    const priority = usesPriorityQueue(normalizeCallerIntent(callerIntent));
    // Use shorter timeout for priority requests (user-facing queries)
    const timeoutMs = priority ? PRIORITY_REQUEST_TIMEOUT_MS : BATCH_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Embedding request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (vector) => resolve(new Float32Array(vector as number[])),
        reject,
        timeoutId,
      });

      this.sendRequest({ id, type: 'embed', text }, priority);
    });
  }

  async generateEmbeddings(
    texts: string[],
    callerIntent: CallerIntent | boolean = 'background_indexing',
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    this.markActivity();

    if (!this.isInitialized || !this.window || this.window.isDestroyed()) {
      throw new Error('GPU backend not initialized');
    }

    if (this.permanentlyDisabled) {
      throw new Error('GPU backend permanently disabled');
    }

    if (this.isDisposing) {
      throw new Error('GPU backend is disposing');
    }

    const id = crypto.randomUUID();
    const priority = usesPriorityQueue(normalizeCallerIntent(callerIntent));
    // Use shorter timeout for priority requests (user-facing queries)
    const timeoutMs = priority ? PRIORITY_REQUEST_TIMEOUT_MS : BATCH_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Batch embedding request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (vectors) => resolve((vectors as number[][]).map((v) => new Float32Array(v))),
        reject,
        timeoutId,
      });

      this.sendRequest({ id, type: 'embedBatch', texts }, priority);
    });
  }

  isReady(): boolean {
    return this.isInitialized && !this.permanentlyDisabled && !this.isDisposing && !!this.window && !this.window.isDestroyed();
  }

  isPermanentlyDisabled(): boolean {
    return this.permanentlyDisabled;
  }

  hasGpuSupport(): boolean {
    return this.gpuAvailable;
  }

  /**
   * Control background throttling for the GPU worker window.
   * When enabled, reduces CPU usage when the app is in background.
   * @param enabled - true to enable throttling (reduce CPU), false to disable (full speed)
   */
  setThrottling(enabled: boolean): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    this.window.webContents.setBackgroundThrottling(enabled);
    // Frame rate control for offscreen rendering - minimum is 1
    if (enabled) {
      this.window.webContents.setFrameRate(1);
    } else {
      this.window.webContents.setFrameRate(60);
    }
    logger.debug({ enabled }, 'GPU worker throttling changed');
  }

  /**
   * Mark recent activity to reset idle timer.
   * Call this when GPU is used for embeddings.
   */
  markActivity(): void {
    this.lastActivityTime = Date.now();
    this.rescheduleIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Start the idle timer with a callback to invoke when idle threshold is reached.
   * The callback is stored and reused when rescheduling after activity.
   */
  startIdleTimer(onIdle: () => void): void {
    this.onIdleCallback = onIdle;
    this.rescheduleIdleTimer();
  }

  private rescheduleIdleTimer(): void {
    this.resetIdleTimer();
    if (!this.onIdleCallback || !this.isInitialized) return;

    // Calculate remaining time until idle threshold
    // This ensures the timer fires at lastActivityTime + idleTimerMs, not now + idleTimerMs
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    const timeUntilIdle = Math.max(0, this.idleTimerMs - timeSinceActivity);
    // Minimum delay to prevent busy-loop when pending requests keep timer from firing
    const MIN_RESCHEDULE_DELAY_MS = 1000;
    const delay = Math.max(timeUntilIdle, MIN_RESCHEDULE_DELAY_MS);

    this.idleTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastActivityTime;
      // Double-check idle time as safety (in case of clock adjustments or race conditions)
      if (idleMs >= this.idleTimerMs && this.pendingRequests.size === 0) {
        getErrorReporter().addBreadcrumb({
          category: 'gpu-worker',
          message: 'GPU backend idle timeout triggered',
          data: { idleMs, threshold: this.idleTimerMs },
          level: 'info',
        });
        this.onIdleCallback?.();
      } else if (this.pendingRequests.size > 0) {
        // Has pending requests - reschedule with minimum delay
        logger.debug({ pendingCount: this.pendingRequests.size, idleMs }, 'Idle timer rescheduled - pending requests');
        this.rescheduleIdleTimer();
      } else {
        // Not yet idle - reschedule for remaining time
        this.rescheduleIdleTimer();
      }
    }, delay);
  }

  /**
   * Dispose of the GPU backend.
   * Uses re-entrancy protection to prevent concurrent disposals.
   */
  async dispose(): Promise<void> {
    // Prevent re-entrant disposal - await existing disposal if in progress
    if (this.disposePromise) {
      return this.disposePromise;
    }

    // Mark as no longer initialized to prevent new requests
    this.isInitialized = false;

    // Create disposal promise and store it for re-entrancy protection
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    // Clear idle timer first
    this.resetIdleTimer();
    this.onIdleCallback = null;

    const windowToClose = this.window;

    // If no window, just clean up
    if (!windowToClose || windowToClose.isDestroyed()) {
      this.isDisposing = true;
      this.window = null;
      this.rejectAllPending(new Error('GPU backend disposed'));
      this.clearTempResponseListeners();
      ipcMain.off(this.responseChannel, this.onResponse);
      this.disposePromise = null;
      logger.info('GPU embedding backend disposed (no window)');
      return;
    }

    // Remove event listeners BEFORE disposal to prevent handleCrash from being triggered
    windowToClose.removeAllListeners('closed');
    windowToClose.webContents.removeAllListeners('render-process-gone');
    windowToClose.webContents.removeAllListeners('console-message');
    windowToClose.webContents.removeAllListeners('did-fail-load');

    // Step 1: Wait for in-flight requests to complete (up to 10s)
    // IMPORTANT: Don't set isDisposing=true yet, otherwise handleResponse()
    // will ignore responses and pendingRequests.size will never shrink!
    const pendingDrainStart = Date.now();
    while (this.pendingRequests.size > 0 && Date.now() - pendingDrainStart < DRAIN_TIMEOUT_MS) {
      logger.debug({ pending: this.pendingRequests.size }, 'Waiting for pending requests to drain');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.pendingRequests.size > 0) {
      logger.warn({ pending: this.pendingRequests.size }, 'Pending requests did not drain in time');
    }

    // NOW it's safe to set isDisposing=true (after drain completes)
    this.isDisposing = true;

    // Step 2: Send dispose request and wait for acknowledgment
    const disposeId = crypto.randomUUID();
    try {
      await new Promise<void>((resolve) => {
        // eslint-disable-next-line prefer-const -- declared before cleanup/timeout mutual reference
        let timeout: NodeJS.Timeout;

        const cleanup = this.addTempResponseListener((event, response) => {
          if (!windowToClose.isDestroyed() && event.sender === windowToClose.webContents) {
            if (response.id === disposeId && (response.type === 'disposed' || response.type === 'error')) {
              clearTimeout(timeout);
              cleanup();
              logger.debug('Received dispose acknowledgment from GPU worker');
              resolve();
            }
          }
        });

        timeout = setTimeout(() => {
          cleanup();
          logger.warn('Dispose acknowledgment timeout, proceeding with cleanup');
          resolve();
        }, 5000);

        windowToClose.webContents.send(GPU_EMBEDDING_CHANNEL, {
          id: disposeId,
          type: 'dispose',
        });
      });
    } catch {
      // Ignore errors during dispose handshake
    }

    // Step 3: Clean up
    this.window = null;
    this.rejectAllPending(new Error('GPU backend disposed'));
    this.clearTempResponseListeners();

    if (!windowToClose.isDestroyed()) {
      windowToClose.destroy();
    }

    ipcMain.off(this.responseChannel, this.onResponse);
    this.disposePromise = null;
    getErrorReporter().addBreadcrumb({
      category: 'gpu-worker',
      message: 'GPU backend disposed',
      level: 'info',
    });
    logger.info('GPU embedding backend disposed');

    // Notify the embedding service that we've disposed (for idle disposal sync)
    // This MUST happen after all cleanup is complete
    if (this.onDisposalCallback) {
      try {
        this.onDisposalCallback();
      } catch (err) {
        logger.warn({ err }, 'Error in GPU disposal callback');
      }
    }
  }
}
