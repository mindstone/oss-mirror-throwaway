/**
 * Utility functions for voice provider classification.
 *
 * Local providers run STT on-device (no cloud API needed).
 * This helper replaces exact `=== 'local-parakeet'` checks where the
 * intent is "is this ANY local provider?" rather than a specific one.
 */

/**
 * Returns true if the given provider runs speech-to-text locally on-device.
 * Local providers don't require API keys for STT and don't support TTS.
 */
export function isLocalProvider(provider: string): boolean {
  return provider === 'local-parakeet' || provider === 'local-moonshine';
}
