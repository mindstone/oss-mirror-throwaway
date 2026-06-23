/**
 * Re-export shim — canonical implementation lives in @core/logBuffer.
 * This file remains so that existing src/main/ consumers continue to resolve
 * without updating their import paths. Remove once all consumers are migrated.
 */
export { addToLogBuffer, getRecentLogs, clearLogBuffer } from '@core/logBuffer';
export type { LogBufferEntry } from '@core/logBuffer';
