/**
 * Settings Store Adapter — platform-agnostic interface.
 *
 * Platform implementations (Electron's electron-store, cloud's env/file-backed store)
 * register an adapter at startup. Core modules import getSettings/updateSettings from
 * here instead of directly depending on electron-store.
 */

import type { AppSettings } from '@shared/types';

export interface UpdateSettingsAtomicOptions {
  /**
   * When true, the desktop adapter additionally pushes the resulting settings
   * doc to the user's cloud instance via `cloudRouter.forward('settings:update', ...)`.
   * Cloud's adapter no-ops on this flag (it is already authoritative for its
   * own surface). See docs/plans/260503_unify_learned_limits_into_profiles.md
   * — "Storage boundary".
   */
  sync?: boolean;
}

export interface SettingsStoreAdapter {
  getSettings(): AppSettings;
  updateSettings(partial: Partial<AppSettings>): void;
  /**
   * Atomic update with a functional updater. The closure receives a fresh
   * snapshot of current settings and returns a partial diff. Implementations
   * MUST run the read + write synchronously under Node's single-threaded
   * event loop so concurrent writers see each other's source-guard fields.
   *
   * `options.sync = true` triggers cross-surface sync (cloud dual-write on
   * desktop; no-op on cloud).
   */
  updateSettingsAtomic(
    updater: (current: AppSettings) => Partial<AppSettings>,
    options?: UpdateSettingsAtomicOptions,
  ): void;
  onSettingsChange?(callback: (current: AppSettings) => void): () => void;
}

let _adapter: SettingsStoreAdapter | undefined;

export function setSettingsStoreAdapter(adapter: SettingsStoreAdapter): void {
  _adapter = adapter;
}

export function getSettings(): AppSettings {
  if (!_adapter) throw new Error('SettingsStoreAdapter not initialized. Call setSettingsStoreAdapter() at startup.');
  return _adapter.getSettings();
}

export function updateSettings(partial: Partial<AppSettings>): void {
  if (!_adapter) throw new Error('SettingsStoreAdapter not initialized. Call setSettingsStoreAdapter() at startup.');
  _adapter.updateSettings(partial);
}

export function updateSettingsAtomic(
  updater: (current: AppSettings) => Partial<AppSettings>,
  options?: UpdateSettingsAtomicOptions,
): void {
  if (!_adapter) throw new Error('SettingsStoreAdapter not initialized. Call setSettingsStoreAdapter() at startup.');
  _adapter.updateSettingsAtomic(updater, options);
}

export function onSettingsChange(callback: (current: AppSettings) => void): () => void {
  if (!_adapter) throw new Error('SettingsStoreAdapter not initialized. Call setSettingsStoreAdapter() at startup.');
  if (!_adapter.onSettingsChange) {
    // Graceful fallback for environments that haven't implemented it yet
    return () => {};
  }
  return _adapter.onSettingsChange(callback);
}
