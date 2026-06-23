/**
 * @device-scoped: native STT crash-loop counters protect the device runtime across accounts.
 *
 * Crash containment for local STT inference on mobile.
 *
 * Tracks whether the app crashed during native Moonshine inference
 * and auto-disables local STT after repeated crash loops.
 *
 * Pattern:
 *   1. Before native inference: markInferenceStarted()
 *   2. After successful inference: markInferenceCompleted()
 *   3. On next app startup / hook mount: checkForInferenceCrash()
 *      — if the "in-progress" flag is still set, the previous inference
 *        crashed the app. Increment the crash counter.
 *   4. After MAX_CONSECUTIVE_CRASHES crashes: shouldDisableLocalStt()
 *      returns true → auto-switch to cloud.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const INFERENCE_FLAG_KEY = 'rebel:localSttInferenceInProgress';
const CRASH_COUNT_KEY = 'rebel:localSttConsecutiveCrashCount';

/** Number of consecutive inference crashes before auto-disabling local STT. */
const MAX_CONSECUTIVE_CRASHES = 3;

/** User-facing message when local STT is auto-disabled. */
export const CRASH_DISABLE_MESSAGE =
  'Local transcription has been temporarily disabled after repeated errors. ' +
  'Try using cloud transcription, or remove and re-download the voice model in Settings.';

/**
 * Mark that native inference is about to start.
 * If the app crashes during inference, this flag remains set.
 */
export async function markInferenceStarted(): Promise<void> {
  try {
    await AsyncStorage.setItem(INFERENCE_FLAG_KEY, 'true');
  } catch {
    // Non-critical — crash tracking is best-effort
  }
}

/**
 * Mark that native inference completed successfully.
 * Clears the in-progress flag and resets the crash counter.
 */
export async function markInferenceCompleted(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([INFERENCE_FLAG_KEY, CRASH_COUNT_KEY]);
  } catch {
    // Non-critical
  }
}

/**
 * Mark that native inference failed with a handled error (not a process crash).
 * Clears the in-progress flag but does NOT reset or increment the crash counter.
 * This prevents handled errors (bad audio, model errors) from being misclassified
 * as app crashes, which would lead to premature auto-disable.
 */
export async function markInferenceFailed(): Promise<void> {
  try {
    await AsyncStorage.removeItem(INFERENCE_FLAG_KEY);
  } catch {
    // Non-critical
  }
}

/**
 * Check if the previous inference session crashed (flag still set from before).
 * If so, clears the flag and increments the crash counter.
 *
 * Call this on hook mount / app startup.
 *
 * @returns true if a crash was detected
 */
export async function checkForInferenceCrash(): Promise<boolean> {
  try {
    const flag = await AsyncStorage.getItem(INFERENCE_FLAG_KEY);
    if (flag !== 'true') return false;

    // Previous inference crashed — clear flag, increment counter
    await AsyncStorage.removeItem(INFERENCE_FLAG_KEY);
    const count = await getCrashCount();
    await AsyncStorage.setItem(CRASH_COUNT_KEY, String(count + 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current consecutive crash count.
 */
export async function getCrashCount(): Promise<number> {
  try {
    const value = await AsyncStorage.getItem(CRASH_COUNT_KEY);
    return value ? parseInt(value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Returns true if local STT should be auto-disabled due to repeated crashes.
 */
export async function shouldDisableLocalStt(): Promise<boolean> {
  try {
    return (await getCrashCount()) >= MAX_CONSECUTIVE_CRASHES;
  } catch {
    return false;
  }
}

/**
 * Reset all crash tracking state. Call when the user re-downloads the model
 * or explicitly re-enables local STT.
 */
export async function resetCrashState(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([INFERENCE_FLAG_KEY, CRASH_COUNT_KEY]);
  } catch {
    // Non-critical
  }
}
