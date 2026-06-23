/**
 * Ollama Model Manager
 *
 * Manages model downloads via Ollama's REST API. Ollama must be running before
 * calling these methods (ensured by the IPC handlers).
 *
 * Security:
 * - Only accepts ollamaTag values that exist in LOCAL_MODEL_CATALOG
 * - Progress broadcast via BroadcastService (not BrowserWindow)
 *
 * After a successful pull, auto-creates a ModelProfile with providerType: 'local'
 * but does NOT auto-set it as the working model (per review finding F2).
 */

import { getBroadcastService } from '@core/broadcastService';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getCatalogEntryByTag } from '@core/services/localInference/modelCatalog';
import { OLLAMA_API_URL, OLLAMA_OPENAI_URL } from '@core/services/localInference/ollamaTypes';
import { getSettings, updateSettings } from '@core/services/settingsStore';

import type { ModelProfile } from '@shared/types/settings';

const log = createScopedLogger({ service: 'OllamaModelManager' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Throttle interval for progress broadcasts (ms). */
const PROGRESS_THROTTLE_MS = 250;

/** Timeout for list/delete API calls (ms). */
const API_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

interface OllamaTagsResponse {
  models?: OllamaModel[];
}

interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class OllamaModelManager {
  private abortController: AbortController | null = null;
  private pullInProgress = false;
  private lastProgressSendTime = 0;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Pull (download) a model from Ollama's registry.
   *
   * The ollamaTag MUST be in the LOCAL_MODEL_CATALOG (enforced here + at IPC layer).
   * Progress is broadcast on `local-inference:download-progress` with type 'model'.
   *
   * On completion, auto-creates a ModelProfile for the downloaded model.
   */
  async pullModel(ollamaTag: string): Promise<void> {
    // Security: validate tag against catalog
    const catalogEntry = getCatalogEntryByTag(ollamaTag);
    if (!catalogEntry) {
      throw new Error(`Model "${ollamaTag}" is not in the approved catalog.`);
    }

    if (this.pullInProgress) {
      throw new Error('A model download is already in progress.');
    }

    this.pullInProgress = true;
    this.abortController = new AbortController();

    try {
      log.info({ ollamaTag, catalogId: catalogEntry.id }, 'Starting model pull');
      this.broadcastProgress({ type: 'model', progress: 0, status: 'downloading' });

      const response = await fetch(`${OLLAMA_API_URL}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ollamaTag }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama pull failed (HTTP ${response.status}): ${body}`);
      }

      if (!response.body) {
        throw new Error('Ollama pull response has no body');
      }

      // Parse NDJSON stream for progress
      await this.consumeProgressStream(response.body);

      // Verify the model is actually present (Ollama can return 200 with empty stream)
      const models = await this.listModels();
      const modelExists = models.some(
        (m) => m.name === ollamaTag || m.name === `${ollamaTag}:latest`,
      );
      if (!modelExists) {
        throw new Error(`Model pull appeared to succeed but "${ollamaTag}" was not found.`);
      }

      log.info({ ollamaTag }, 'Model pull complete');
      this.broadcastProgress({ type: 'model', progress: 100, status: 'complete' });

      // Auto-create ModelProfile for the downloaded model
      this.createModelProfile(catalogEntry);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info({ ollamaTag }, 'Model pull cancelled');
        this.broadcastProgress({ type: 'model', progress: 0, status: 'cancelled' });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, ollamaTag }, 'Model pull failed');
      getErrorReporter().captureException(err instanceof Error ? err : new Error(message), {
        tags: { area: 'local-inference', component: 'ollama-model-pull' },
        extra: { ollamaTag },
      });
      this.broadcastProgress({
        type: 'model',
        progress: 0,
        status: 'error',
        error: this.friendlyError(message),
      });
      throw err;
    } finally {
      this.pullInProgress = false;
      this.abortController = null;
    }
  }

  /**
   * List all models installed in the managed Ollama instance.
   */
  async listModels(): Promise<Array<{ name: string; sizeBytes: number; modifiedAt: string }>> {
    try {
      const response = await fetch(`${OLLAMA_API_URL}/tags`, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'Failed to list Ollama models');
        return [];
      }

      const data = (await response.json()) as OllamaTagsResponse;
      return (data.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        modifiedAt: m.modified_at,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to list Ollama models');
      return [];
    }
  }

  /**
   * Delete a model from the managed Ollama instance.
   */
  async deleteModel(modelName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${OLLAMA_API_URL}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.error({ modelName, status: response.status, body }, 'Failed to delete model');
        return { success: false, error: `Failed to delete model (HTTP ${response.status})` };
      }

      log.info({ modelName }, 'Model deleted from Ollama');
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, modelName }, 'Failed to delete model');
      return { success: false, error: message };
    }
  }

  /**
   * Cancel an in-flight model pull.
   */
  cancelPull(): void {
    if (this.abortController) {
      this.abortController.abort();
      log.info('Model pull cancel requested');
    }
  }

  /**
   * Whether a model pull is currently in progress.
   */
  isPullInProgress(): boolean {
    return this.pullInProgress;
  }

  // -------------------------------------------------------------------------
  // Private: NDJSON stream consumption
  // -------------------------------------------------------------------------

  /**
   * Consume the NDJSON progress stream from Ollama's /api/pull endpoint.
   * Each line is a JSON object with { status, digest?, total?, completed? }.
   */
  private async consumeProgressStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const progress = JSON.parse(trimmed) as OllamaPullProgress;
            this.handlePullProgress(progress);
          } catch {
            // Skip malformed lines
            log.debug({ line: trimmed }, 'Skipped malformed NDJSON line');
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const progress = JSON.parse(buffer.trim()) as OllamaPullProgress;
          this.handlePullProgress(progress);
        } catch {
          // Skip malformed final line
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle a single progress event from the NDJSON stream.
   */
  private handlePullProgress(progress: OllamaPullProgress): void {
    if (progress.error) {
      throw new Error(progress.error);
    }
    if (progress.total && progress.completed) {
      const pct = Math.min(Math.round((progress.completed / progress.total) * 99), 99);
      this.throttledBroadcastProgress({
        type: 'model',
        progress: pct,
        status: progress.status || 'downloading',
      });
    } else if (progress.status) {
      // Status-only updates (e.g., "verifying sha256 digest", "writing manifest")
      this.throttledBroadcastProgress({
        type: 'model',
        progress: -1, // indeterminate
        status: progress.status,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: Profile creation
  // -------------------------------------------------------------------------

  /**
   * Auto-create a ModelProfile for a downloaded model.
   * Uses deterministic ID `local-${catalogEntry.id}` to avoid duplicates.
   * Does NOT auto-set as working model (per review finding F2).
   */
  private createModelProfile(
    catalogEntry: { id: string; displayName: string; ollamaTag: string; contextWindowDefault: number },
  ): void {
    const profileId = `local-${catalogEntry.id}`;
    const settings = getSettings();
    const existingProfiles = settings.localModel?.profiles ?? [];

    // Check if profile already exists (re-download of same model)
    const existing = existingProfiles.find((p) => p.id === profileId);
    if (existing) {
      log.info({ profileId }, 'ModelProfile already exists for this model, skipping creation');
      return;
    }

    const newProfile: ModelProfile = {
      id: profileId,
      name: `${catalogEntry.displayName} (Local)`,
      serverUrl: OLLAMA_OPENAI_URL,
      model: catalogEntry.ollamaTag,
      providerType: 'local',
      contextWindow: catalogEntry.contextWindowDefault,
      createdAt: Date.now(),
    };

    const updatedProfiles = [...existingProfiles, newProfile];

    updateSettings({
      localModel: {
        ...settings.localModel,
        profiles: updatedProfiles,
        activeProfileId: settings.localModel?.activeProfileId ?? null,
      },
    });

    log.info(
      { profileId, name: newProfile.name, model: newProfile.model },
      'Created ModelProfile for downloaded local model',
    );
  }

  // -------------------------------------------------------------------------
  // Private: Progress broadcasting
  // -------------------------------------------------------------------------

  /**
   * Broadcast progress to all renderer windows. Terminal states sent immediately.
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
    if (now - this.lastProgressSendTime >= PROGRESS_THROTTLE_MS) {
      this.broadcastProgress(data);
    }
  }

  // -------------------------------------------------------------------------
  // Private: Utilities
  // -------------------------------------------------------------------------

  /**
   * Map raw error messages to user-friendly descriptions.
   */
  private friendlyError(raw: string): string {
    if (/ECONNREFUSED/.test(raw)) {
      return 'Could not connect to the local model engine. Make sure it is running.';
    }
    if (/ETIMEDOUT|ECONNRESET|timeout/i.test(raw)) {
      return 'The model download was interrupted. Please try again.';
    }
    if (/ENOSPC/.test(raw)) {
      return 'Not enough disk space to download this model.';
    }
    if (/not in the approved catalog/.test(raw)) {
      return 'This model is not available for download.';
    }
    return 'Model download failed. Please try again.';
  }
}

// Singleton instance
export const ollamaModelManager = new OllamaModelManager();

// Export class for testing
export { OllamaModelManager };
