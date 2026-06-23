/**
 * Marker base class for known structured errors that must be captured via
 * `captureKnownCondition` (once introduced) instead of ad-hoc capture calls.
 *
 * This enables cross-surface runtime guard checks at the ErrorReporter
 * boundary without changing error behavior.
 */
export abstract class KnownStructuredError extends Error {}
