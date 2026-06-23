/**
 * Re-export shim — canonical implementation lives in @core/utils/cloudStorageUtils.
 * Remove once all consumers are migrated.
 */
export {
  detectCloudStorage,
  detectInPlaceCloudDocuments,
  shouldSkipCloudSymlinkTarget,
  getTimeoutForPath,
  FS_TIMEOUT_LOCAL_MS,
  FS_TIMEOUT_CLOUD_MS,
} from '@core/utils/cloudStorageUtils';
export type { CloudProvider, CloudStorageInfo } from '@core/utils/cloudStorageUtils';
