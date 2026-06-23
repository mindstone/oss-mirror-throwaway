/**
 * Tracker — platform-agnostic analytics/tracking interface.
 *
 * Replaces direct analytics.ts imports in core business logic.
 * Electron impl wraps Rudderstack/analytics; cloud impl is typically no-op.
 */

export interface Tracker {
  track(event: string, properties?: Record<string, unknown>): void;
  identify(userId: string, traits?: Record<string, unknown>): void;
  /** Stable per-install anonymous identifier. Used for idempotency keys in reporting services. */
  getAnonymousId(): string;
  /** Whether the tracking backend can queue events (mirrors analyticsClientAvailable). */
  isAvailable(): boolean;
}

const _noop: Tracker = { track: () => {}, identify: () => {}, getAnonymousId: () => '', isAvailable: () => false };

let _tracker: Tracker = _noop;

export function setTracker(tracker: Tracker): void {
  _tracker = tracker;
}

export function getTracker(): Tracker {
  return _tracker;
}
