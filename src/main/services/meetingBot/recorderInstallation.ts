import { RECALL_DESKTOP_SDK_PACKAGE_NAME } from '@shared/recallRecorder';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export const FORCE_RECORDER_UNINSTALLED_ENV = 'REBEL_FORCE_RECORDER_UNINSTALLED';

type ResolvePackage = (id: string) => string;

export function isRecorderInstalled(resolvePackage: ResolvePackage = require.resolve): boolean {
  // Dev/test escape hatch only. This is intentionally env-only, never persisted
  // in user settings, so production defaults to the actual runtime module state.
  if (process.env[FORCE_RECORDER_UNINSTALLED_ENV]) {
    return false;
  }

  try {
    resolvePackage(RECALL_DESKTOP_SDK_PACKAGE_NAME);
    return true;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'isRecorderInstalled',
      reason: 'missing Recall Desktop SDK is represented as recorder-not-installed',
    });
    return false;
  }
}
