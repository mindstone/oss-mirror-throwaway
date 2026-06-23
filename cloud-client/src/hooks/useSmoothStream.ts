// cloud-client/src/hooks/useSmoothStream.ts
// Thin wrapper over the shared smooth-streaming hook with cloud-appropriate defaults.
// The canonical implementation lives in packages/shared/src/hooks/useSmoothStream.ts.

import { useSmoothStream as useSmoothStreamBase } from '@rebel/shared';

/**
 * Smooths streaming text for cloud/mobile consumers.
 * Delegates to the shared hook with a cloud-appropriate default speed.
 *
 * @param rawText - The full text received so far (grows as chunks arrive)
 * @param isStreaming - Whether new chunks are still arriving (preserves display during stream)
 * @param speed - Milliseconds per character (default 7 for cloud/mobile, ~143 chars/sec)
 * @returns The portion of rawText to display
 */
export function useSmoothStream(
  rawText: string | undefined,
  isStreaming: boolean,
  speed = 7,
): string {
  return useSmoothStreamBase(rawText, isStreaming, speed);
}
