/**
 * Global userData Write Gate
 *
 * Centralized read-only flag that protects ALL persistent stores when
 * the current app version is older than the one that last wrote to userData.
 *
 * Set early in bootstrap.ts (before any stores are imported).
 * Checked by storeFactory, incrementalSessionStore, inboxStore, and other
 * direct file-write locations.
 *
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

let _readOnly = false;
let _reason: string | null = null;
let _newerAppVersion: string | null = null;

export function setUserDataReadOnly(reason: string, newerAppVersion?: string): void {
  _readOnly = true;
  _reason = reason;
  _newerAppVersion = newerAppVersion ?? null;
}

export function isUserDataReadOnly(): boolean {
  return _readOnly;
}

export function getUserDataReadOnlyReason(): string | null {
  return _reason;
}

export function getUserDataNewerAppVersion(): string | null {
  return _newerAppVersion;
}
