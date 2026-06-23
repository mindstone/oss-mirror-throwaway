import type { z } from 'zod';
import type { SafeModeErrorCategorySchema } from '@shared/ipc/schemas/common';

// =============================================================================
// Safe Mode Types
// =============================================================================

/** Reason for entering Safe Mode */
export type SafeModeReason = 'cli' | 'timeout' | 'failure' | 'user';

/**
 * Controlled enum for error categories — prevents accidental privacy leaks.
 * Derived from error codes, NOT error messages.
 */
export type SafeModeErrorCategory = z.infer<typeof SafeModeErrorCategorySchema>;

/** Full Safe Mode context including reason and error details */
export interface SafeModeContext {
  isEnabled: boolean;
  reason?: SafeModeReason;
  triggeredAt?: string; // ISO timestamp
  sentryEventId?: string; // Sentry event ID for support
  errorCategory?: SafeModeErrorCategory;
}
