/**
 * Re-export shim — canonical implementation lives in @core/utils/nativeArch.
 * Remove once all consumers are migrated.
 */
export {
  getNativeArch,
  isRunningUnderEmulation,
} from '@core/utils/nativeArch';
