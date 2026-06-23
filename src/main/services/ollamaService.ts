/**
 * Ollama Service
 *
 * Manages the Ollama child process lifecycle: start, stop, health check,
 * crash recovery with exponential backoff.
 *
 * Key design decisions:
 * - Port 11435 (non-default, avoids conflict with user-installed Ollama on 11434)
 * - Minimal env allowlist: only OLLAMA_HOST, OLLAMA_KV_CACHE_TYPE, OLLAMA_NUM_PARALLEL,
 *   OLLAMA_MODELS, OLLAMA_TMPDIR, PATH, HOME. No full process.env inheritance.
 * - Models stored at {userDataPath}/ollama/models to isolate from user's Ollama
 * - Max 3 restart attempts with exponential backoff (1s, 4s, 16s) before giving up
 * - Uses BroadcastService for status updates to renderer
 * - Uses execFile (no shell) to prevent shell injection
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getBroadcastService } from '@core/broadcastService';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import {
  OLLAMA_API_URL,
  OLLAMA_PORT,
  type InferenceStrategy,
  type OllamaCapabilities,
  type OllamaRuntimeStatus,
} from '@core/services/localInference';

import { ollamaRuntimeManager } from './ollamaRuntimeManager';

const log = createScopedLogger({ service: 'OllamaService' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum automatic restart attempts after crash. */
const MAX_RESTART_ATTEMPTS = 3;

/** Backoff delays for restart attempts (ms): 1s, 4s, 16s. */
const RESTART_BACKOFF_MS = [1_000, 4_000, 16_000];

/** Timeout for health check requests (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** How long to wait for graceful SIGTERM shutdown before SIGKILL (ms). */
const GRACEFUL_STOP_TIMEOUT_MS = 3_000;

/** Env vars allowed in the child process. Everything else is stripped. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'OLLAMA_HOST',
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MODELS',
  'OLLAMA_TMPDIR',
] as const;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OllamaService {
  private process: ChildProcess | null = null;
  private status: OllamaRuntimeStatus = 'not_installed';
  private startTime: number | null = null;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;

  /**
   * Promise for the in-flight ensureRunning() call.
   * Concurrent callers wait on the same startup instead of racing.
   */
  private ensureRunningPromise: Promise<void> | null = null;

  /**
   * The strategy used for the current running instance (for status reporting).
   */
  private activeStrategy: InferenceStrategy | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ensure Ollama is running and healthy.
   * - If not running: starts it.
   * - If running but unhealthy: restarts it.
   * - Concurrent calls coalesce into a single startup (single-flight).
   */
  async ensureRunning(strategy: InferenceStrategy): Promise<void> {
    // Check if runtime is installed
    const { installed } = ollamaRuntimeManager.getInstallStatus();
    if (!installed) {
      this.setStatus('not_installed');
      throw new Error('Ollama runtime is not installed. Download it first from Settings.');
    }

    // Coalesce concurrent calls
    if (this.ensureRunningPromise) {
      log.debug('ensureRunning already in progress, waiting for completion');
      return this.ensureRunningPromise;
    }

    this.ensureRunningPromise = this.doEnsureRunning(strategy);
    try {
      await this.ensureRunningPromise;
    } finally {
      this.ensureRunningPromise = null;
    }
  }

  /**
   * Start the Ollama process with the given inference strategy.
   */
  async start(strategy: InferenceStrategy): Promise<void> {
    if (this.process && !this.isShuttingDown) {
      log.debug('Ollama process already running');
      return;
    }

    const binaryPath = ollamaRuntimeManager.getRuntimePath();
    if (!fs.existsSync(binaryPath)) {
      this.setStatus('not_installed');
      throw new Error('Ollama binary not found. Please download the runtime first.');
    }

    const config = getPlatformConfig();
    const modelsDir = path.join(config.userDataPath, 'ollama', 'models');
    const tmpDir = path.join(config.tempPath, 'ollama');

    // Ensure models and tmp directories exist
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // Build minimal env from allowlist + strategy
    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const val = process.env[key];
      if (val !== undefined) {
        env[key] = val;
      }
    }
    // Override/add Ollama-specific vars
    env['OLLAMA_HOST'] = `127.0.0.1:${OLLAMA_PORT}`;
    env['OLLAMA_MODELS'] = modelsDir;
    env['OLLAMA_TMPDIR'] = tmpDir;
    // Apply strategy env vars (OLLAMA_KV_CACHE_TYPE, OLLAMA_NUM_PARALLEL, etc.)
    Object.assign(env, strategy.ollamaEnv);

    log.info(
      {
        binaryPath,
        port: OLLAMA_PORT,
        strategy: strategy.id,
        kvCacheType: strategy.kvCacheType,
        modelsDir,
      },
      'Starting Ollama process',
    );

    this.isShuttingDown = false;
    this.activeStrategy = strategy;

    const proc = spawn(binaryPath, ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env,
      // shell: false is the default for spawn, which is what we want
    });

    this.process = proc;
    this.startTime = Date.now();

    // Capture stdout/stderr for logging
    proc.stdout?.on('data', (data: Buffer) => {
      log.debug({ source: 'stdout' }, data.toString().trim());
    });
    proc.stderr?.on('data', (data: Buffer) => {
      log.debug({ source: 'stderr' }, data.toString().trim());
    });

    // Handle process exit
    proc.on('exit', (code, signal) => {
      const uptime = this.startTime ? Date.now() - this.startTime : 0;
      log.warn(
        { code, signal, uptime, restartAttempts: this.restartAttempts },
        'Ollama process exited',
      );

      this.process = null;
      this.startTime = null;

      if (!this.isShuttingDown) {
        // Unexpected exit — attempt restart with backoff
        this.handleCrash(strategy);
      }
    });

    proc.on('error', (err) => {
      log.error({ err }, 'Ollama process error');
      getErrorReporter().captureException(err, {
        tags: { area: 'local-inference', component: 'ollama-service' },
        extra: { port: OLLAMA_PORT, strategy: strategy.id },
      });
      this.process = null;
    });

    // Wait for health check to confirm startup
    await this.waitForHealthy();

    this.restartAttempts = 0;
    this.setStatus('running');
    log.info({ port: OLLAMA_PORT, pid: proc.pid }, 'Ollama process started and healthy');
  }

  /**
   * Stop the Ollama process gracefully.
   * SIGTERM → wait 3s → SIGKILL if still alive.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      log.debug('No Ollama process to stop');
      return;
    }

    const pid = this.process.pid;
    log.info({ pid }, 'Stopping Ollama process');

    try {
      // Send SIGTERM for graceful shutdown
      this.process.kill('SIGTERM');

      // Wait for exit or timeout
      const exited = await this.waitForExit(GRACEFUL_STOP_TIMEOUT_MS);

      if (!exited && this.process) {
        // Force kill
        log.warn({ pid }, 'Ollama did not exit gracefully, sending SIGKILL');
        try {
          this.process.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
        await this.waitForExit(2_000);
      }

      log.info({ pid }, 'Ollama process stopped');
    } catch (err) {
      log.warn({ err, pid }, 'Error stopping Ollama process');
    } finally {
      this.process = null;
      this.startTime = null;
      this.activeStrategy = null;
      this.restartAttempts = 0;
      this.setStatus('installed');
    }
  }

  /**
   * Check if the Ollama process is alive AND the health endpoint responds.
   */
  async isRunning(): Promise<boolean> {
    if (!this.process || this.process.killed) return false;

    try {
      return await this.checkHealth();
    } catch {
      return false;
    }
  }

  /**
   * Query Ollama capabilities by hitting the /api/version endpoint.
   * Returns null if Ollama is not running.
   */
  async getCapabilities(): Promise<OllamaCapabilities | null> {
    try {
      const response = await fetch(`${OLLAMA_API_URL}/version`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { version?: string };
      const version = data.version ?? 'unknown';

      return {
        version,
        // TurboQuant support detection — version-gated
        turboQuantSupported: this.versionSupportsFeature(version, '0.9.8'),
        kvCacheTypes: this.versionSupportsFeature(version, '0.9.8')
          ? ['turbo3', 'q4_0', 'q8_0', 'f16']
          : ['q4_0', 'q8_0', 'f16'],
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): OllamaRuntimeStatus {
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Private: Startup helpers
  // -------------------------------------------------------------------------

  private async doEnsureRunning(strategy: InferenceStrategy): Promise<void> {
    // Already running? Check health
    if (this.process && !this.process.killed) {
      const healthy = await this.checkHealth();
      if (healthy) {
        this.setStatus('running');
        return;
      }
      // Unhealthy — stop and restart
      log.warn('Ollama process running but unhealthy, restarting');
      await this.stop();
    }

    await this.start(strategy);
  }

  /**
   * Wait for Ollama to become healthy (health endpoint responding).
   * Polls every 500ms for up to 30s.
   */
  private async waitForHealthy(): Promise<void> {
    const maxWaitMs = 30_000;
    const pollMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // Check if process died during startup
      if (!this.process || this.process.killed) {
        throw new Error('Ollama process exited during startup');
      }

      try {
        const healthy = await this.checkHealth();
        if (healthy) return;
      } catch {
        // Expected during startup
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`Ollama did not become healthy within ${maxWaitMs}ms`);
  }

  /**
   * Wait for the process to exit within a timeout.
   * Returns true if the process exited, false if timeout.
   */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private: Health check
  // -------------------------------------------------------------------------

  /**
   * Check health by hitting GET /api/version with a timeout.
   */
  private async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${OLLAMA_API_URL}/version`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private: Crash recovery
  // -------------------------------------------------------------------------

  /**
   * Handle unexpected process exit. Attempt restart with exponential backoff.
   * Gives up after MAX_RESTART_ATTEMPTS and sets status to 'error'.
   */
  private handleCrash(strategy: InferenceStrategy): void {
    this.restartAttempts++;

    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      log.error(
        { attempts: this.restartAttempts, maxAttempts: MAX_RESTART_ATTEMPTS },
        'Ollama crashed too many times, giving up',
      );
      this.setStatus('error');
      getErrorReporter().captureMessage('Ollama crash loop detected', {
        // Explicit level: previously omitted, which Sentry silently defaulted
        // to 'info' (invisible to the raw-level guards). A crash loop that
        // exhausted all restart attempts is a defect-grade signal.
        level: 'error',
        tags: { area: 'local-inference', component: 'ollama-service' },
        extra: {
          attempts: this.restartAttempts,
          strategy: strategy.id,
        },
      });
      return;
    }

    const delayMs = RESTART_BACKOFF_MS[this.restartAttempts - 1] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    log.info(
      { attempt: this.restartAttempts, maxAttempts: MAX_RESTART_ATTEMPTS, delayMs },
      'Scheduling Ollama restart after crash',
    );

    this.setStatus('installed'); // Transition away from 'running' during backoff
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.isShuttingDown) return;
      this.start(strategy).catch((err) => {
        log.error({ err, attempt: this.restartAttempts }, 'Ollama restart failed');
      });
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // Private: Status management
  // -------------------------------------------------------------------------

  /**
   * Update status and broadcast to renderer.
   */
  private setStatus(newStatus: OllamaRuntimeStatus): void {
    if (this.status === newStatus) return;
    const previousStatus = this.status;
    this.status = newStatus;
    log.info({ previousStatus, newStatus }, 'Ollama status changed');

    try {
      getBroadcastService().sendToAllWindows('local-inference:status-changed', {
        status: newStatus,
        strategy: this.activeStrategy?.id ?? null,
      });
    } catch {
      // BroadcastService may not be initialized in tests
    }
  }

  // -------------------------------------------------------------------------
  // Private: Utilities
  // -------------------------------------------------------------------------

  /**
   * Simple semver "greater-than-or-equal" check for feature gating.
   */
  private versionSupportsFeature(version: string, minimumVersion: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const [aMaj = 0, aMin = 0, aPat = 0] = parse(version);
    const [bMaj = 0, bMin = 0, bPat = 0] = parse(minimumVersion);
    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPat >= bPat;
  }
}

// Singleton instance
export const ollamaService = new OllamaService();

// Export class for testing
export { OllamaService };
