/**
 * Singleton in-memory flag indicating whether an auto-update is currently
 * downloading. Extracted to its own module so that `gracefulShutdown` can
 * read the flag without creating an import cycle with the much larger
 * `autoUpdateService` (which itself depends on `gracefulShutdown` for
 * shutdown coordination).
 */

let isDownloadingUpdate = false;

export function isUpdateDownloading(): boolean {
  return isDownloadingUpdate;
}

export function setUpdateDownloading(downloading: boolean): void {
  isDownloadingUpdate = downloading;
}
