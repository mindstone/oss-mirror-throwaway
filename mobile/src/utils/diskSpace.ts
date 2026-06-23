// mobile/src/utils/diskSpace.ts
// Shared disk-space preflight check for recording hooks (voice + meeting).

import * as FileSystem from 'expo-file-system/legacy';

/** Minimum free disk space required before starting a recording (200 MB). */
export const MIN_FREE_DISK_SPACE_BYTES = 200 * 1024 * 1024;

export interface DiskSpaceOk {
  ok: true;
}

export interface DiskSpaceInsufficient {
  ok: false;
  freeBytes: number;
  requiredBytes: number;
}

/**
 * Check whether the device has sufficient free disk space for recording.
 * Returns `{ ok: true }` if space is available, or `{ ok: false, freeBytes, requiredBytes }`
 * if the device is below the minimum threshold.
 */
export async function checkSufficientDiskSpace(): Promise<DiskSpaceOk | DiskSpaceInsufficient> {
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  if (freeBytes < MIN_FREE_DISK_SPACE_BYTES) {
    return { ok: false, freeBytes, requiredBytes: MIN_FREE_DISK_SPACE_BYTES };
  }
  return { ok: true };
}
