/**
 * Shutdown State Module
 *
 * REBEL-4X: Provides a dependency-free way to check if the app is shutting down.
 * This module has no imports to avoid circular dependencies when services need
 * to check shutdown state before creating workers/threads.
 *
 * The state is set by gracefulShutdown.ts and read by embeddingService.ts,
 * atlasService.ts, and any other services that create workers.
 */

let shuttingDown = false;

/**
 * Mark the app as shutting down.
 * Called by gracefulShutdown.ts at the start of the quit sequence.
 */
export function setShuttingDown(): void {
  shuttingDown = true;
}

/**
 * Check if the app is in the shutdown sequence.
 * Services should check this before creating new workers/threads.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * REBEL-HP: Error type for intentional shutdown/disposal rejections.
 * 
 * Services should use this error type when rejecting pending promises during
 * graceful shutdown. The global unhandledRejection handler filters these out
 * to prevent Sentry noise from expected shutdown behavior.
 * 
 * This class is dependency-free to avoid circular imports.
 */
export class ShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShutdownError';
  }
}
