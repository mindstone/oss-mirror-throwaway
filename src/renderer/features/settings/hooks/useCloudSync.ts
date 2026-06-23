// Star topology: this hook MUST NOT import other cloud hooks.

/**
 * useCloudSync
 *
 * Manages sync and migration state: incremental sync, full resync,
 * initial migration (called by CloudTab after connect/provision).
 *
 * Module-level state (_syncInProgress, _lastProgress, _lastResult,
 * _lastResultIsError) survives component unmount/remount so the UI
 * doesn't lose track of an in-flight migration when the user navigates away.
 */

import { useState, useCallback } from 'react';
import type { CloudInstanceConfig, AppSettings } from '@shared/types';
import type { CloudMigrationProgress } from '@shared/cloudMigrationTypes';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import {
  getLastProgress,
  isMigrationInProgress,
  setLastProgress,
  setSyncInProgress,
  __resetMigrationCoordinatorForTesting,
} from './migrationProgressCoordinator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateRoot = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

// Re-export the canonical type so renderer callers that import from this hook
// module keep compiling without churn.
export type { CloudMigrationProgress };

export interface MigrateResult {
  success: boolean;
  message: string;
  shouldReload: boolean;
}

export interface UseCloudSyncParams {
  cloudInstance: CloudInstanceConfig | undefined;
  updateDraft: UpdateRoot;
  isConnected: boolean;
}

export interface UseCloudSyncResult {
  // Sync state
  migrationProgress: CloudMigrationProgress | null;
  migrationResult: string | null;
  migrationResultIsError: boolean;
  syncInProgress: boolean;

  // Full resync confirmation
  confirmFullResync: boolean;
  setConfirmFullResync: (v: boolean) => void;

  // Handlers
  handleSync: () => Promise<void>;
  handleFullResync: () => Promise<void>;
  migrate: () => Promise<MigrateResult>;

  // Reset (for post-connect/post-provision cleanup)
  clearResults: () => void;
  setMigrationResult: (v: string | null) => void;
  setMigrationResultIsError: (v: boolean) => void;
  setMigrationProgress: (v: CloudMigrationProgress | null) => void;

  // Test seam
  __resetForTesting: () => void;
}

// ---------------------------------------------------------------------------
// Module-level sync state — survives component unmount/remount so the UI
// doesn't lose track of an in-flight migration when the user navigates away.
//
// The `syncInProgress` / `lastProgress` slices live in the separate
// `migrationProgressCoordinator` module so the provider-switch flow in
// `useCloudProvisioning` can set them without violating the star topology.
// Only the result fields (`_lastResult`, `_lastResultIsError`) remain local
// because only this hook ever needs them.
// ---------------------------------------------------------------------------

let _lastResult: string | null = null;
let _lastResultIsError = false;

// Re-export the coordinator's helpers so existing callers that imported
// these names from `./useCloudSync` keep compiling. New callers should
// prefer importing from `./migrationProgressCoordinator` directly.
export {
  beginExternalMigration,
  endExternalMigration,
  isMigrationInProgress,
} from './migrationProgressCoordinator';

/** Test seam — resets all module-level state (this hook + coordinator). */
export function __resetSyncStateForTesting(): void {
  __resetMigrationCoordinatorForTesting();
  _lastResult = null;
  _lastResultIsError = false;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCloudSync({
  cloudInstance: cloud,
  updateDraft,
  isConnected: _isConnected,
}: UseCloudSyncParams): UseCloudSyncResult {
  // Seed from module-level state so remounts pick up in-flight syncs
  const [migrationProgress, setMigrationProgress] = useState<CloudMigrationProgress | null>(getLastProgress());
  const [migrationResult, setMigrationResult] = useState<string | null>(_lastResult);
  const [migrationResultIsError, setMigrationResultIsError] = useState(_lastResultIsError);
  const [confirmFullResync, setConfirmFullResync] = useState(false);

  // Listen for migration progress events from main process
  useIpcEvent(window.cloudApi.onMigrationProgress, (step: unknown) => {
    if (isMigrationInProgress()) {
      const progress = step as CloudMigrationProgress;
      setLastProgress(progress);
      setMigrationProgress(progress);
    }
  }, []);

  // ------ Incremental sync ------

  const handleSync = useCallback(async () => {
    if (isMigrationInProgress()) return;
    setMigrationResult(null);
    setMigrationProgress(null);
    setMigrationResultIsError(false);
    try {
      const result = await window.cloudApi.syncNow();
      if (result.success) {
        const msg = result.workspace.pushed > 0
          ? `Caught up. ${result.workspace.pushed} workspace file${result.workspace.pushed === 1 ? '' : 's'} synced.`
          : 'Already up to date. Cloud and desktop are in agreement.';
        _lastResult = msg;
        _lastResultIsError = false;
        setMigrationResult(msg);
        setMigrationResultIsError(false);
        if (!cloud) return;
        await window.cloudApi.reconcile({
          writer: 'manual-refresh',
          cloudUrl: cloud.cloudUrl,
          mode: 'reportSuccess',
        });
        const updated = (await window.settingsApi.get()).cloudInstance;
        if (updated) {
          updateDraft('cloudInstance', updated);
        }
      } else {
        const msg = result.error ?? 'Sync hit a snag. Try again or use full resync below.';
        _lastResult = msg;
        _lastResultIsError = true;
        setMigrationResult(msg);
        setMigrationResultIsError(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed.';
      _lastResult = msg;
      _lastResultIsError = true;
      setMigrationResult(msg);
      setMigrationResultIsError(true);
    }
  }, [cloud, updateDraft]);

  // ------ Full resync (full migration — nuclear option) ------

  const handleFullResync = useCallback(async () => {
    if (!confirmFullResync) {
      setConfirmFullResync(true);
      return;
    }
    if (isMigrationInProgress()) return;
    setSyncInProgress(true);
    _lastResult = null;
    setLastProgress(null);
    setMigrationResult(null);
    setMigrationProgress(null);
    setMigrationResultIsError(false);
    setConfirmFullResync(false);
    try {
      const result = await window.cloudApi.migrate();
      setSyncInProgress(false);
      setLastProgress(null);
      if (result.success) {
        const parts: string[] = [];
        if (result.settingsMigrated) parts.push('settings');
        if (result.sessionsMigrated && result.sessionsMigrated > 0) {
          parts.push(`${result.sessionsMigrated} session${result.sessionsMigrated === 1 ? '' : 's'}`);
        }
        const msg = parts.length > 0 ? 'Full resync complete. Reloading...' : 'Continuity is already up to date.';
        _lastResult = msg;
        _lastResultIsError = false;
        setMigrationResult(msg);
        setMigrationResultIsError(false);
        setMigrationProgress(null);
        if (!cloud) return;
        await window.cloudApi.reconcile({
          writer: 'manual-refresh',
          cloudUrl: cloud.cloudUrl,
          mode: 'reportSuccess',
        });
        const updated = (await window.settingsApi.get()).cloudInstance;
        if (updated) {
          updateDraft('cloudInstance', updated);
        }
        if (parts.length > 0) {
          setTimeout(() => window.location.reload(), 1500);
        }
      } else {
        const msg = result.error ?? 'Full resync failed.';
        _lastResult = msg;
        _lastResultIsError = true;
        setMigrationProgress(null);
        setMigrationResult(msg);
        setMigrationResultIsError(true);
      }
    } catch (err) {
      setSyncInProgress(false);
      setLastProgress(null);
      const msg = err instanceof Error ? err.message : 'Full resync failed.';
      _lastResult = msg;
      _lastResultIsError = true;
      setMigrationProgress(null);
      setMigrationResult(msg);
      setMigrationResultIsError(true);
    } finally {
      setSyncInProgress(false);
    }
  }, [cloud, updateDraft, confirmFullResync]);

  // ------ Initial migration (called by CloudTab after connect/provision) ------

  const migrate = useCallback(async (): Promise<MigrateResult> => {
    setSyncInProgress(true);
    setMigrationProgress(null);
    try {
      const migration = await window.cloudApi.migrate();
      setSyncInProgress(false);
      setLastProgress(null);
      if (migration.success) {
        const parts: string[] = [];
        if (migration.settingsMigrated) parts.push('settings');
        if (migration.sessionsMigrated && migration.sessionsMigrated > 0) {
          parts.push(`${migration.sessionsMigrated} session${migration.sessionsMigrated === 1 ? '' : 's'}`);
        }
        const shouldReload = parts.length > 0;
        const isReconnect = !!cloud?.cloudUrl;
        const msg = shouldReload
          ? `Synced ${parts.join(' and ')} for cloud continuity. Reloading...`
          : isReconnect ? 'Connection updated.' : 'Cloud continuity added. Already up to date.';
        _lastResult = msg;
        _lastResultIsError = false;
        setMigrationResult(msg);
        setMigrationResultIsError(false);
        setMigrationProgress(null);
        return { success: true, message: msg, shouldReload };
      } else {
        const msg = migration.error ?? 'Continuity is on, but sync had issues. Try "Sync now" later.';
        _lastResult = msg;
        _lastResultIsError = true;
        setMigrationProgress(null);
        setMigrationResult(msg);
        setMigrationResultIsError(true);
        return { success: false, message: msg, shouldReload: false };
      }
    } catch {
      setSyncInProgress(false);
      setLastProgress(null);
      const msg = 'Continuity is on, but initial sync failed. You can retry with "Sync now".';
      _lastResult = msg;
      _lastResultIsError = true;
      setMigrationProgress(null);
      setMigrationResult(msg);
      setMigrationResultIsError(true);
      return { success: false, message: msg, shouldReload: false };
    }
  }, [cloud?.cloudUrl]);

  const clearResults = useCallback(() => {
    setMigrationResult(null);
    setMigrationProgress(null);
    setMigrationResultIsError(false);
    _lastResult = null;
    setLastProgress(null);
    _lastResultIsError = false;
  }, []);

  return {
    migrationProgress,
    migrationResult,
    migrationResultIsError,
    syncInProgress: isMigrationInProgress(),

    confirmFullResync,
    setConfirmFullResync,

    handleSync,
    handleFullResync,
    migrate,

    clearResults,
    setMigrationResult,
    setMigrationResultIsError,
    setMigrationProgress,

    __resetForTesting: __resetSyncStateForTesting,
  };
}
