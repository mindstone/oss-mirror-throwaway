/**
 * Re-export shim — canonical implementation lives in @core/utils/dataPaths.
 * This file remains so that existing src/main/ consumers continue to resolve
 * without updating their import paths. Remove once all consumers are migrated.
 */
export { getDataPath, getAppVersion, isPackaged, getAppRoot } from '@core/utils/dataPaths';
