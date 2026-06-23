/**
 * Ollama Runtime Manager
 *
 * On-demand download of the Ollama binary from GitHub Releases.
 * Follows `localSttModelManager.ts` hardening patterns:
 * - Atomic staging directory
 * - SHA256 checksum verification
 * - macOS code signature verification
 * - Throttled progress events (250ms)
 * - Range resume for partial downloads
 * - HTTPS-only redirects
 * - Friendly error messages
 * - Filesystem error early-exit
 *
 * Binary stored at: {PlatformConfig.userDataPath}/ollama/
 */

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { getBroadcastService } from '@core/broadcastService';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';

const log = createScopedLogger({ service: 'OllamaRuntimeManager' });

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub release tag to download. Bump this to ship Ollama updates. */
const OLLAMA_RELEASE_TAG = 'v0.20.0';

/** Base URL for Ollama release artifacts. */
const GITHUB_RELEASE_BASE = `https://github.com/ollama/ollama/releases/download/${OLLAMA_RELEASE_TAG}`;

/** Platform-specific download asset mapping. */
const PLATFORM_ASSETS: Record<string, { asset: string; extractCmd: 'tgz' }> = {
  'darwin-arm64': { asset: 'ollama-darwin.tgz', extractCmd: 'tgz' },
  'darwin-x64': { asset: 'ollama-darwin.tgz', extractCmd: 'tgz' },
};

/** Apple Team ID for Ollama binary code signature verification. */
const OLLAMA_APPLE_TEAM_ID = '3MU9H2V9Y9';

/** Download configuration. */
const DOWNLOAD_CONFIG = {
  /** Socket inactivity timeout (ms). */
  timeoutMs: 120_000,
  /** Throttle interval for progress events (ms). */
  progressThrottleMs: 250,
  /** Maximum number of HTTP redirects to follow. */
  maxRedirects: 5,
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface DownloadState {
  inProgress: boolean;
  abortController: AbortController | null;
  downloadedBytes: number;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OllamaRuntimeManager {
  private downloadState: DownloadState = {
    inProgress: false,
    abortController: null,
    downloadedBytes: 0,
    totalBytes: 0,
  };

  /** Timestamp of last IPC progress broadcast (for throttling). */
  private lastProgressSendTime = 0;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Directory where the Ollama binary is installed. */
  getInstallDir(): string {
    return path.join(getPlatformConfig().userDataPath, 'ollama');
  }

  /** Full path to the installed Ollama binary. */
  getRuntimePath(): string {
    return path.join(this.getInstallDir(), 'ollama');
  }

  /** Staging directory used during downloads (atomic install). */
  private getStagingDir(): string {
    return path.join(getPlatformConfig().userDataPath, 'ollama.staging');
  }

  /**
   * Check if the runtime binary exists and is executable.
   */
  getInstallStatus(): { installed: boolean; path: string } {
    const binaryPath = this.getRuntimePath();
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
      return { installed: true, path: binaryPath };
    } catch {
      return { installed: false, path: binaryPath };
    }
  }

  /**
   * Get the installed Ollama version by running `ollama --version`.
   * Returns null if not installed or version cannot be determined.
   */
  async getInstalledVersion(): Promise<string | null> {
    const { installed } = this.getInstallStatus();
    if (!installed) return null;

    try {
      const { stdout } = await execFileAsync(this.getRuntimePath(), ['--version'], {
        timeout: 5_000,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      });
      // Output is typically "ollama version 0.9.6" or just "0.9.6"
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch (err) {
      log.warn({ err }, 'Failed to get Ollama version');
      return null;
    }
  }

  /**
   * Download the Ollama runtime binary from GitHub Releases.
   * Uses atomic staging: download to temp dir, verify, move to final location.
   *
   * Progress is broadcast via `BroadcastService` on channel
   * `local-inference:download-progress`.
   */
  async downloadRuntime(): Promise<void> {
    if (this.downloadState.inProgress) {
      throw new Error('Ollama runtime download already in progress');
    }

    const config = getPlatformConfig();
    const platformKey = `${config.platform}-${config.arch}`;
    const asset = PLATFORM_ASSETS[platformKey];

    if (!asset) {
      throw new Error(
        `Local models are not yet supported on your platform (${config.platform} ${config.arch}). ` +
        'Mac support is available now. Windows and Linux are coming soon.',
      );
    }

    // Set inProgress synchronously to prevent concurrent calls
    this.downloadState = {
      inProgress: true,
      abortController: new AbortController(),
      downloadedBytes: 0,
      totalBytes: 0,
    };

    const stagingDir = this.getStagingDir();
    const installDir = this.getInstallDir();

    try {
      // Clean up any leftover staging directory
      this.removeDirSafely(stagingDir);
      fs.mkdirSync(stagingDir, { recursive: true });

      // Broadcast initial progress
      this.broadcastProgress({ type: 'runtime', progress: 0, status: 'downloading' });

      // Step 1: Download the archive
      const archivePath = path.join(stagingDir, asset.asset);
      const downloadUrl = `${GITHUB_RELEASE_BASE}/${asset.asset}`;
      await this.downloadFile(downloadUrl, archivePath);

      this.checkAborted();

      // Step 2: Download and verify SHA256 checksum
      const sha256Url = `${GITHUB_RELEASE_BASE}/sha256sum.txt`;
      const sha256Path = path.join(stagingDir, 'sha256sum.txt');
      await this.downloadFile(sha256Url, sha256Path, { skipProgress: true });

      this.checkAborted();

      const expectedHash = this.parseChecksumFile(sha256Path, asset.asset);
      if (!expectedHash) {
        throw new Error(
          `SHA256 checksum for ${asset.asset} not found in sha256sum.txt. ` +
          'Cannot verify download integrity. Please try again later.',
        );
      }
      this.broadcastProgress({ type: 'runtime', progress: 95, status: 'verifying' });
      const actualHash = await this.computeSha256(archivePath);
      if (actualHash !== expectedHash) {
        throw new Error(
          `Checksum mismatch for ${asset.asset}: expected ${expectedHash}, got ${actualHash}`,
        );
      }
      log.info({ asset: asset.asset }, 'SHA256 checksum verified');

      this.checkAborted();

      // Step 3: Extract the archive
      this.broadcastProgress({ type: 'runtime', progress: 96, status: 'extracting' });
      await this.extractTgz(archivePath, stagingDir);

      this.checkAborted();

      // Step 4: Find and set up the binary
      const binaryPath = this.findBinaryInStaging(stagingDir);
      if (!binaryPath) {
        throw new Error('Ollama binary not found in extracted archive');
      }

      // chmod +x
      fs.chmodSync(binaryPath, 0o755);

      // Step 5: Verify macOS code signature
      if (config.platform === 'darwin') {
        this.broadcastProgress({ type: 'runtime', progress: 97, status: 'verifying' });
        await this.verifyCodeSignature(binaryPath);
      }

      this.checkAborted();

      // Step 6: Swap binary to install dir (backup existing first for rollback)
      this.broadcastProgress({ type: 'runtime', progress: 98, status: 'installing' });
      const backupDir = installDir + '.bak';
      if (fs.existsSync(installDir)) {
        this.removeDirSafely(backupDir); // clean any stale backup
        fs.renameSync(installDir, backupDir);
      }
      try {
        fs.mkdirSync(installDir, { recursive: true });
        const finalBinaryPath = this.getRuntimePath();
        fs.copyFileSync(binaryPath, finalBinaryPath);
        fs.chmodSync(finalBinaryPath, 0o755);
        // Success — remove backup
        this.removeDirSafely(backupDir);
      } catch (installErr) {
        // Rollback — restore backup if copy/chmod failed
        this.removeDirSafely(installDir);
        if (fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, installDir);
        }
        throw installErr;
      }

      // Clean up staging
      this.removeDirSafely(stagingDir);

      log.info({ installDir, version: OLLAMA_RELEASE_TAG }, 'Ollama runtime installed successfully');
      this.broadcastProgress({ type: 'runtime', progress: 100, status: 'complete' });
    } catch (err) {
      // Clean up staging on failure
      this.removeDirSafely(stagingDir);

      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info('Ollama runtime download cancelled');
        this.broadcastProgress({ type: 'runtime', progress: 0, status: 'cancelled' });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'Ollama runtime download failed');
      getErrorReporter().captureException(err, {
        tags: { area: 'local-inference', component: 'ollama-runtime-download' },
        extra: { platformKey, releaseTag: OLLAMA_RELEASE_TAG },
      });
      this.broadcastProgress({
        type: 'runtime',
        progress: 0,
        status: 'error',
        error: this.friendlyError(message),
      });
      throw err;
    } finally {
      this.downloadState.inProgress = false;
      this.downloadState.abortController = null;
    }
  }

  /**
   * Cancel an in-flight download.
   */
  cancelDownload(): void {
    if (this.downloadState.abortController) {
      this.downloadState.abortController.abort();
    }
    this.broadcastProgress({ type: 'runtime', progress: 0, status: 'cancelled' });
  }

  /**
   * Remove the installed Ollama runtime and its directory.
   */
  removeRuntime(): void {
    const installDir = this.getInstallDir();
    this.removeDirSafely(installDir);
    log.info({ installDir }, 'Ollama runtime removed');
  }

  /**
   * Remove any leftover staging directories from a crashed download.
   * Safe to call unconditionally on every startup.
   */
  cleanupStaleStaging(): void {
    if (this.downloadState.inProgress) return;

    const stagingDir = this.getStagingDir();
    if (fs.existsSync(stagingDir)) {
      this.removeDirSafely(stagingDir);
      log.info({ stagingDir }, 'Removed stale Ollama staging directory from previous crash');
    }
  }

  // -------------------------------------------------------------------------
  // Private: Download helpers
  // -------------------------------------------------------------------------

  /**
   * Download a file over HTTPS with progress tracking and redirect following.
   * Follows only HTTPS redirects (no HTTP downgrades).
   */
  private downloadFile(
    url: string,
    destPath: string,
    options?: { skipProgress?: boolean },
    maxRedirects = DOWNLOAD_CONFIG.maxRedirects,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const tempPath = `${destPath}.downloading`;
      const signal = this.downloadState.abortController?.signal;

      if (signal?.aborted) {
        reject(new DOMException('Download cancelled', 'AbortError'));
        return;
      }

      // Check for existing partial file to enable Range resume
      let existingBytes = 0;
      try {
        if (fs.existsSync(tempPath)) {
          existingBytes = fs.statSync(tempPath).size;
        }
      } catch {
        existingBytes = 0;
      }

      const requestUrl = new URL(url);
      const requestOptions: https.RequestOptions = {
        hostname: requestUrl.hostname,
        path: requestUrl.pathname + requestUrl.search,
        timeout: DOWNLOAD_CONFIG.timeoutMs,
        headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined,
      };

      const request = https.get(requestOptions, (response) => {
        // Handle redirects
        const isRedirect =
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 303 ||
          response.statusCode === 307 ||
          response.statusCode === 308;

        if (isRedirect) {
          response.resume();
          if (maxRedirects <= 0) {
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          const location = response.headers.location;
          if (!location) {
            reject(new Error('Redirect without Location header'));
            return;
          }
          // Only follow HTTPS redirects
          if (location.startsWith('https://')) {
            this.downloadFile(location, destPath, options, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
          } else if (!location.startsWith('http')) {
            // Relative URL
            const redirectUrl = new URL(location, `https://${requestUrl.hostname}`).href;
            this.downloadFile(redirectUrl, destPath, options, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error('Refusing insecure HTTP redirect'));
          }
          return;
        }

        // Determine if resuming
        const isResume = response.statusCode === 206 && existingBytes > 0;

        if (response.statusCode === 200 && existingBytes > 0) {
          // Server doesn't support Range — delete partial and start fresh
          try {
            fs.unlinkSync(tempPath);
          } catch {
            /* ignore */
          }
          existingBytes = 0;
        }

        if (response.statusCode !== 200 && response.statusCode !== 206) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }

        // Track total size from Content-Length
        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        if (!options?.skipProgress && contentLength > 0) {
          this.downloadState.totalBytes = existingBytes + contentLength;
        }

        const fileStream = fs.createWriteStream(tempPath, isResume ? { flags: 'a' } : undefined);
        let downloadedBytes = isResume ? existingBytes : 0;
        let streamClosed = false;

        // Report existing partial bytes as progress
        if (isResume && existingBytes > 0 && !options?.skipProgress) {
          this.downloadState.downloadedBytes = existingBytes;
        }

        const cleanup = (err?: Error) => {
          if (!streamClosed) {
            streamClosed = true;
            response.destroy();
            fileStream.destroy();
            if (err) reject(err);
          }
        };

        // Listen for abort
        const onAbort = () => {
          cleanup(new DOMException('Download cancelled', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        response.on('error', (err) => cleanup(new Error(`Response error: ${err.message}`)));
        response.on('aborted', () => cleanup(new Error('Response aborted')));

        response.on('data', (chunk: Buffer) => {
          if (signal?.aborted) {
            cleanup(new DOMException('Download cancelled', 'AbortError'));
            return;
          }
          downloadedBytes += chunk.length;

          if (!options?.skipProgress) {
            this.downloadState.downloadedBytes = downloadedBytes;
            const total = this.downloadState.totalBytes;
            const progress = total > 0 ? Math.min(Math.round((downloadedBytes / total) * 94), 94) : 0;
            this.throttledBroadcastProgress({
              type: 'runtime',
              progress,
              status: 'downloading',
            });
          }
        });

        response.pipe(fileStream);

        fileStream.on('error', (err) => cleanup(new Error(`File write error: ${err.message}`)));

        fileStream.on('close', () => {
          signal?.removeEventListener('abort', onAbort);
          if (streamClosed) return;
          streamClosed = true;

          // Rename temp file to final
          try {
            fs.renameSync(tempPath, destPath);
            resolve(downloadedBytes);
          } catch (err) {
            reject(
              new Error(
                `Failed to finalize download: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        });
      });

      request.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Download timeout after ${DOWNLOAD_CONFIG.timeoutMs}ms`));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private: Extraction
  // -------------------------------------------------------------------------

  /**
   * Extract a .tgz archive using `tar` (available on macOS/Linux).
   * Uses `execFile` (no shell) to prevent injection.
   */
  private async extractTgz(archivePath: string, destDir: string): Promise<void> {
    await execFileAsync('tar', ['xzf', archivePath, '-C', destDir], {
      timeout: 60_000,
    });
    log.debug({ archivePath, destDir }, 'Extracted tgz archive');
  }

  /**
   * Find the Ollama binary in the staging directory after extraction.
   * The tgz may contain `ollama` at the root or in a subdirectory.
   */
  private findBinaryInStaging(stagingDir: string): string | null {
    // Check common locations
    const candidates = [
      path.join(stagingDir, 'ollama'),
      path.join(stagingDir, 'bin', 'ollama'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }

    // Recurse one level into subdirectories
    try {
      const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nested = path.join(stagingDir, entry.name, 'ollama');
          if (fs.existsSync(nested) && fs.statSync(nested).isFile()) {
            return nested;
          }
        }
      }
    } catch {
      /* ignore read errors */
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Private: Verification
  // -------------------------------------------------------------------------

  /**
   * Parse a sha256sum.txt file and extract the hash for a specific asset.
   * Format: `<hash>  <filename>` (two spaces between hash and filename).
   */
  private parseChecksumFile(checksumPath: string, assetName: string): string | null {
    try {
      const content = fs.readFileSync(checksumPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Format: "<sha256>  <filename>" or "<sha256>  ./<filename>"
        const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
        if (match) {
          // Strip leading ./ prefix (GitHub sha256sum.txt uses ./filename format)
          const filename = match[2].trim().replace(/^\.\//, '');
          if (filename === assetName) {
            return match[1];
          }
        }
      }
    } catch (err) {
      log.warn({ err, checksumPath }, 'Failed to read checksum file');
    }
    return null;
  }

  /**
   * Compute SHA256 hash of a file using streaming.
   */
  private computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => {
        stream.destroy();
        reject(err);
      });
    });
  }

  /**
   * Verify macOS code signature and Team ID of the Ollama binary.
   * Uses `codesign --verify` (available on macOS by default).
   */
  private async verifyCodeSignature(binaryPath: string): Promise<void> {
    // Step 1: Verify signature is valid (exits non-zero if invalid)
    try {
      await execFileAsync('codesign', ['--verify', '--verbose=2', binaryPath], {
        timeout: 15_000,
      });
    } catch (err: unknown) {
      log.error({ err, binaryPath }, 'macOS code signature verification failed');
      throw new Error(
        'The downloaded Ollama binary has an invalid code signature. ' +
        'This may indicate a corrupted or tampered download. Please try again.',
      );
    }

    // Step 2: Check Team ID. codesign -dvv writes signing info to STDERR.
    // execFile returns { stdout, stderr } on success (exit code 0).
    try {
      const { stderr } = await execFileAsync(
        'codesign',
        ['-dvv', binaryPath],
        { timeout: 15_000 },
      );

      const teamMatch = stderr.match(/TeamIdentifier=(\S+)/);
      if (!teamMatch) {
        log.warn({ binaryPath }, 'Could not find TeamIdentifier in codesign output');
        return;
      }

      if (teamMatch[1] !== OLLAMA_APPLE_TEAM_ID && teamMatch[1] !== 'not set') {
        log.error(
          { expected: OLLAMA_APPLE_TEAM_ID, actual: teamMatch[1], binaryPath },
          'Ollama binary Team ID mismatch',
        );
        throw new Error(
          'The downloaded Ollama binary was signed by an unexpected developer. ' +
          'Please try downloading again.',
        );
      }

      log.info({ teamId: teamMatch[1], binaryPath }, 'macOS code signature verified');
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unexpected developer')) throw err;
      log.warn({ err, binaryPath }, 'Could not verify macOS Team ID (non-fatal)');
    }
  }

  // -------------------------------------------------------------------------
  // Private: Progress broadcasting
  // -------------------------------------------------------------------------

  /**
   * Broadcast download progress to all renderer windows via BroadcastService.
   * Terminal states (complete, error, cancelled) are always sent immediately.
   */
  private broadcastProgress(data: {
    type: 'runtime' | 'model';
    progress: number;
    status: string;
    error?: string;
  }): void {
    try {
      getBroadcastService().sendToAllWindows('local-inference:download-progress', data);
    } catch {
      // BroadcastService may not be initialized in tests
    }
    this.lastProgressSendTime = Date.now();
  }

  /**
   * Throttled progress broadcast — at most once per 250ms for non-terminal states.
   */
  private throttledBroadcastProgress(data: {
    type: 'runtime' | 'model';
    progress: number;
    status: string;
    error?: string;
  }): void {
    const now = Date.now();
    if (now - this.lastProgressSendTime >= DOWNLOAD_CONFIG.progressThrottleMs) {
      this.broadcastProgress(data);
    }
  }

  // -------------------------------------------------------------------------
  // Private: Utilities
  // -------------------------------------------------------------------------

  /** Throw if the download has been aborted. */
  private checkAborted(): void {
    if (this.downloadState.abortController?.signal.aborted) {
      throw new DOMException('Download cancelled', 'AbortError');
    }
  }

  /**
   * Safely remove a directory, only if within userDataPath.
   */
  private removeDirSafely(dirPath: string): void {
    try {
      const userDataPath = path.resolve(getPlatformConfig().userDataPath);
      const resolved = path.resolve(dirPath);
      if (!resolved.startsWith(userDataPath + path.sep) && resolved !== userDataPath) {
        log.error({ dirPath, resolved }, 'Refusing to remove directory outside userData');
        return;
      }
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn({ err, dirPath }, 'Failed to remove directory');
    }
  }

  /**
   * Map raw error messages to user-friendly descriptions.
   */
  private friendlyError(raw: string): string {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(raw)) {
      return 'Could not reach the download server. Check your internet connection and try again.';
    }
    if (/ETIMEDOUT|ECONNRESET|socket hang up|timeout/i.test(raw)) {
      return 'The download was interrupted. Your connection may be unstable — try again.';
    }
    if (/ENOSPC/.test(raw)) {
      return 'Not enough disk space to download the local model engine.';
    }
    if (/EACCES|EPERM/.test(raw)) {
      return 'Permission denied. Try restarting the app.';
    }
    if (/HTTP [45]\d\d/.test(raw)) {
      return 'The download server returned an error. Please try again later.';
    }
    if (/Checksum mismatch/.test(raw)) {
      return 'The downloaded file was corrupted. Please try again.';
    }
    if (/code signature/.test(raw) || /Team ID/.test(raw)) {
      return 'The downloaded file could not be verified. Please try again.';
    }
    return 'Download failed. Please try again.';
  }
}

// Singleton instance
export const ollamaRuntimeManager = new OllamaRuntimeManager();

// Export class for testing
export { OllamaRuntimeManager };
