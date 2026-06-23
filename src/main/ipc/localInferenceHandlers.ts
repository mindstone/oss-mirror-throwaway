/**
 * IPC Handlers for Local Inference (Bundled Ollama)
 *
 * Follows the localSttHandlers.ts pattern: register handlers via ipcMain.handle().
 * Uses BroadcastService for progress (not BrowserWindow).
 */

import { ipcMain } from 'electron';

import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { TURBO_QUANT_STRATEGY } from '@core/services/localInference/inferenceStrategy';
import { getCatalogEntryByTag } from '@core/services/localInference/modelCatalog';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { getThinkingProfileId, getWorkingProfileId } from '@core/rebelCore/settingsAccessors';
import type { AppSettings } from '@shared/types';

import { ollamaModelManager } from '../services/ollamaModelManager';
import { ollamaRuntimeManager } from '../services/ollamaRuntimeManager';
import { ollamaService } from '../services/ollamaService';

import type { LocalInferenceStatus } from '@core/services/localInference/ollamaTypes';

const log = createScopedLogger({ service: 'LocalInferenceHandlers' });

type WritableModelSettings = NonNullable<AppSettings['models']>;

function getWritableModelSettings(settings: ReturnType<typeof getSettings>): WritableModelSettings {
  return {
    // eslint-disable-next-line no-restricted-properties -- Local inference maintenance needs a writable full-model snapshot before targeted profile-id cleanup writes.
    ...(settings.models ?? {}),
  } as WritableModelSettings;
}

/**
 * Remove any local profiles whose model tag is no longer in the catalog.
 * Runs once on handler registration to clean up after catalog changes.
 */
function cleanupStaleLocalProfiles(): void {
  try {
    const settings = getSettings();
    const profiles = settings.localModel?.profiles ?? [];
    const localProfiles = profiles.filter((p) => p.providerType === 'local');
    if (localProfiles.length === 0) return;

    const stale = localProfiles.filter((p) => !getCatalogEntryByTag(p.model ?? ''));
    if (stale.length === 0) return;

    const staleIds = new Set(stale.map((p) => p.id));
    const models = getWritableModelSettings(settings);
    const workingProfileId = getWorkingProfileId(settings);
    const thinkingProfileId = getThinkingProfileId(settings);
    if (workingProfileId && staleIds.has(workingProfileId)) {
      models.workingProfileId = undefined;
    }
    if (thinkingProfileId && staleIds.has(thinkingProfileId)) {
      models.thinkingProfileId = undefined;
    }

    const filteredProfiles = profiles.filter((p) => !staleIds.has(p.id));
    updateSettings({
      models,
      localModel: {
        ...settings.localModel,
        profiles: filteredProfiles,
        activeProfileId: settings.localModel?.activeProfileId && staleIds.has(settings.localModel.activeProfileId)
          ? null
          : settings.localModel?.activeProfileId ?? null,
      },
    });

    log.info(
      { removedCount: stale.length, removedIds: [...staleIds] },
      'Cleaned up stale local profiles (model tags no longer in catalog)',
    );
  } catch (err) {
    log.warn({ err }, 'Failed to clean up stale local profiles');
  }
}

/**
 * Register IPC handlers for local inference management.
 */
export function registerLocalInferenceHandlers(): void {
  cleanupStaleLocalProfiles();
  // ---------------------------------------------------------------------------
  // get-status: aggregate runtime + Ollama + model + system info
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:get-status', async (): Promise<LocalInferenceStatus> => {
    try {
      const config = getPlatformConfig();
      const { installed } = ollamaRuntimeManager.getInstallStatus();
      const runtimeVersion = installed
        ? await ollamaRuntimeManager.getInstalledVersion()
        : undefined;

      // Lazily start Ollama when the runtime is installed so we can query models
      let running = await ollamaService.isRunning();
      if (installed && !running) {
        try {
          await ollamaService.ensureRunning(TURBO_QUANT_STRATEGY);
          running = true;
        } catch (err) {
          log.warn({ err }, 'Could not auto-start Ollama for status query');
        }
      }
      const capabilities = running ? await ollamaService.getCapabilities() : undefined;
      const installedModels = running ? await ollamaModelManager.listModels() : [];

      // Determine runtime status: binary on disk = at least 'installed'
      let runtimeStatus = ollamaService.getStatus();
      if (installed && runtimeStatus === 'not_installed') {
        runtimeStatus = 'installed';
      }

      return {
        runtimeStatus,
        runtimeVersion: runtimeVersion ?? undefined,
        capabilities: capabilities ?? undefined,
        installedModels,
        systemRAMGB: Math.round(config.totalMemoryBytes / (1024 * 1024 * 1024)),
        arch: config.arch,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to get local inference status');
      return {
        runtimeStatus: 'error',
        installedModels: [],
        systemRAMGB: 0,
        arch: 'unknown',
        error: message,
      };
    }
  });

  // ---------------------------------------------------------------------------
  // activate: download the Ollama runtime
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:activate', async () => {
    try {
      // If already installed, treat as success (idempotent)
      const { installed } = ollamaRuntimeManager.getInstallStatus();
      if (installed) {
        return { started: false, alreadyInstalled: true };
      }

      // Fire-and-forget: download runs in background, progress via broadcast
      ollamaRuntimeManager.downloadRuntime().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ error: msg }, 'Runtime download failed (background)');
      });

      return { started: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to activate local inference');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-inference', component: 'ipc-activate' },
      });
      return { started: false, error: message };
    }
  });

  // ---------------------------------------------------------------------------
  // deactivate: stop Ollama → delete local profiles → remove runtime
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:deactivate', async () => {
    try {
      // Step 1: Clear local profile selections before deleting anything
      const settings = getSettings();
      const localProfileIds = (settings.localModel?.profiles ?? [])
        .filter((p) => p.providerType === 'local')
        .map((p) => p.id);

      if (localProfileIds.length > 0) {
        const models = getWritableModelSettings(settings);
        const workingProfileId = getWorkingProfileId(settings);
        const thinkingProfileId = getThinkingProfileId(settings);
        if (workingProfileId && localProfileIds.includes(workingProfileId)) {
          models.workingProfileId = undefined;
        }
        if (thinkingProfileId && localProfileIds.includes(thinkingProfileId)) {
          models.thinkingProfileId = undefined;
        }

        // Remove local profiles from the list
        const filteredProfiles = (settings.localModel?.profiles ?? []).filter(
          (p) => p.providerType !== 'local',
        );

        updateSettings({
          models,
          localModel: {
            ...settings.localModel,
            profiles: filteredProfiles,
            activeProfileId: settings.localModel?.activeProfileId
              && localProfileIds.includes(settings.localModel.activeProfileId)
              ? null
              : settings.localModel?.activeProfileId ?? null,
          },
        });

        log.info(
          { removedCount: localProfileIds.length },
          'Removed local inference profiles from settings',
        );
      }

      // Step 2: Stop Ollama service
      await ollamaService.stop();

      // Step 3: Remove runtime binary and models
      ollamaRuntimeManager.removeRuntime();

      log.info('Local inference deactivated and cleaned up');
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to deactivate local inference');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-inference', component: 'ipc-deactivate' },
      });
      return { success: false, error: message };
    }
  });

  // ---------------------------------------------------------------------------
  // pull-model: validate tag, ensure Ollama running, start download
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:pull-model', async (_event, args: { ollamaTag: string }) => {
    try {
      const { ollamaTag } = args;

      // Security: validate tag against curated catalog
      const catalogEntry = getCatalogEntryByTag(ollamaTag);
      if (!catalogEntry) {
        return { started: false, error: 'This model is not available for download.' };
      }

      // Ensure the runtime is installed
      const { installed } = ollamaRuntimeManager.getInstallStatus();
      if (!installed) {
        return { started: false, error: 'Local model engine is not installed. Please activate it first.' };
      }

      // Start Ollama if not already running (needed for pull API)
      await ollamaService.ensureRunning(TURBO_QUANT_STRATEGY);

      // Fire-and-forget: pull runs in background, progress via broadcast
      ollamaModelManager.pullModel(ollamaTag).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ error: msg, ollamaTag }, 'Model pull failed (background)');
      });

      return { started: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to start model pull');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-inference', component: 'ipc-pull-model' },
      });
      return { started: false, error: message };
    }
  });

  // ---------------------------------------------------------------------------
  // cancel-pull: cancel in-progress model download
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:cancel-pull', async () => {
    try {
      ollamaModelManager.cancelPull();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to cancel model pull');
    }
  });

  // ---------------------------------------------------------------------------
  // delete-model: remove model from Ollama + remove corresponding profile
  // ---------------------------------------------------------------------------
  ipcMain.handle('local-inference:delete-model', async (_event, args: { modelName: string }) => {
    try {
      const { modelName } = args;

      // Ensure Ollama is running (needed for delete API)
      await ollamaService.ensureRunning(TURBO_QUANT_STRATEGY);

      // Delete from Ollama
      const result = await ollamaModelManager.deleteModel(modelName);
      if (!result.success) {
        return result;
      }

      // Find and remove the corresponding ModelProfile
      const settings = getSettings();
      const profiles = settings.localModel?.profiles ?? [];
      const profileToRemove = profiles.find(
        (p) => p.providerType === 'local' && p.model === modelName,
      );

      if (profileToRemove) {
        const models = getWritableModelSettings(settings);
        const workingProfileId = getWorkingProfileId(settings);
        const thinkingProfileId = getThinkingProfileId(settings);
        // Clear selections if this profile was active
        if (workingProfileId === profileToRemove.id) {
          models.workingProfileId = undefined;
        }
        if (thinkingProfileId === profileToRemove.id) {
          models.thinkingProfileId = undefined;
        }

        const filteredProfiles = profiles.filter((p) => p.id !== profileToRemove.id);

        updateSettings({
          models,
          localModel: {
            ...settings.localModel,
            profiles: filteredProfiles,
            activeProfileId:
              settings.localModel?.activeProfileId === profileToRemove.id
                ? null
                : settings.localModel?.activeProfileId ?? null,
          },
        });

        log.info(
          { profileId: profileToRemove.id, modelName },
          'Removed ModelProfile for deleted model',
        );
      }

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Failed to delete model');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-inference', component: 'ipc-delete-model' },
      });
      return { success: false, error: message };
    }
  });

  log.debug('Local inference handlers registered');
}
