/**
 * Thrown by `enqueueOrThrow` when the queue has reached its size cap.
 * Callers should catch this and display a user-visible message.
 */
export class QueueFullError extends Error {
  constructor(public readonly maxSize: number) {
    super(`Queue full (${maxSize} items)`);
    this.name = 'QueueFullError';
  }
}
