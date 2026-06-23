import { z } from 'zod';

export const KNOWN_CONTENT_RESOLUTION_REASONS = [
  'ok',
  'pending-upload',
  'missing',
  'fetch-failed',
  'truncated-for-budget',
  'unknown',
] as const;

export type KnownContentResolutionReason = typeof KNOWN_CONTENT_RESOLUTION_REASONS[number];
export type ContentResolutionReason = KnownContentResolutionReason | string;

export const contentResolutionReasonSchema = z.union([
  z.enum(KNOWN_CONTENT_RESOLUTION_REASONS),
  z.string(),
]);

export function normalizeContentResolutionReason(value: unknown): KnownContentResolutionReason {
  if (typeof value === 'string') {
    if ((KNOWN_CONTENT_RESOLUTION_REASONS as readonly string[]).includes(value)) {
      return value as KnownContentResolutionReason;
    }
  }
  return 'unknown';
}
