import { z } from 'zod';
import { defineInvokeChannel, SafeModeErrorCategorySchema } from '../schemas';

/**
 * Result of an `app:reveal-path` (FOX-3422). The handler never rejects; on
 * failure it returns `{ ok: false, reason, message }` so the renderer can show
 * a toast. `reason`:
 *  - 'missing'    — the path no longer exists (moved/deleted)
 *  - 'permission' — access denied (EACCES/EPERM, e.g. Full Disk Access on macOS)
 *  - 'system'     — any other shell/OS failure
 */
export type RevealPathResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'permission' | 'system'; message: string };

export const PendingNotificationClickIntentSchema = z.object({
  sessionId: z.string().optional(),
  filePath: z.string().optional(),
  clickedAt: z.number(),
}).refine((payload) => Boolean(payload.sessionId || payload.filePath), {
  message: 'Either sessionId or filePath must be provided',
});

export const appChannels = {
  'app:was-clean-exit': defineInvokeChannel({
    channel: 'app:was-clean-exit',
    request: z.void(),
    response: z.boolean(),
    description: 'Check if the last app shutdown was clean (false = crash/force-quit)',
  }),

  'app:open-path': defineInvokeChannel({
    channel: 'app:open-path',
    request: z.string(),
    response: z.void(),
    description: 'Open a path in the system file explorer',
  }),

  'app:open-url': defineInvokeChannel({
    channel: 'app:open-url',
    request: z.string(),
    response: z.void(),
    description: 'Open a URL in the default browser',
  }),

  'app:reveal-path': defineInvokeChannel({
    channel: 'app:reveal-path',
    request: z.string(),
    // FOX-3422: structured result so the renderer can surface a toast when a
    // reveal fails (missing/moved file, permission/Full Disk Access block).
    // Still resolves (never rejects) so fire-and-forget callers don't trigger
    // unhandled rejections (REBEL-2E).
    response: z.union([
      z.object({ ok: z.literal(true) }),
      z.object({
        ok: z.literal(false),
        reason: z.enum(['missing', 'permission', 'system']),
        message: z.string(),
      }),
    ]),
    description: 'Reveal a file or folder in the system file explorer',
  }),

  'app:show-notification': defineInvokeChannel({
    channel: 'app:show-notification',
    request: z.object({
      title: z.string(),
      body: z.string(),
      sessionId: z.string().optional(),
      filePath: z.string().optional(),
    }).refine((payload) => Boolean(payload.sessionId || payload.filePath), {
      message: 'Either sessionId or filePath must be provided',
    }),
    response: z.void(),
    description: 'Show a desktop notification that navigates to a session or library file on click',
  }),

  'app:consume-pending-notification-click': defineInvokeChannel({
    channel: 'app:consume-pending-notification-click',
    request: z.void(),
    // filePath takes priority over sessionId when both are present.
    response: z.union([PendingNotificationClickIntentSchema, z.null()]),
    description: 'Consume the pending desktop notification click intent, if any',
  }),

  'app:copy-image-to-clipboard': defineInvokeChannel({
    channel: 'app:copy-image-to-clipboard',
    request: z.object({
      dataUrl: z.string().optional(),
      filePath: z.string().optional(),
    }).refine((data) => data.dataUrl || data.filePath, {
      message: 'Either dataUrl or filePath must be provided',
    }),
    response: z.void(),
    description: 'Copy an image to the system clipboard from a data URL or file path',
  }),

  'app:save-image-as': defineInvokeChannel({
    channel: 'app:save-image-as',
    request: z.object({
      dataUrl: z.string().optional(),
      filePath: z.string().optional(),
      defaultName: z.string().optional(),
    }).refine((data) => data.dataUrl || data.filePath, {
      message: 'Either dataUrl or filePath must be provided',
    }),
    response: z.object({
      saved: z.boolean(),
      savedPath: z.string().optional(),
    }),
    description: 'Show a save dialog and save an image to a user-chosen location',
  }),

  'app:save-text-as': defineInvokeChannel({
    channel: 'app:save-text-as',
    request: z.object({
      content: z.string(),
      defaultName: z.string().optional(),
      defaultPath: z.string().optional(),
    }),
    response: z.object({
      saved: z.boolean(),
      savedPath: z.string().optional(),
    }),
    description: 'Show a save dialog and save text to a user-chosen location',
  }),

  'app:safe-mode-state': defineInvokeChannel({
    channel: 'app:safe-mode-state',
    request: z.void(),
    response: z.object({
      isEnabled: z.boolean(),
      reason: z.enum(['cli', 'timeout', 'failure', 'user']).optional(),
      triggeredAt: z.string().optional(),
      sentryEventId: z.string().optional(),
      errorCategory: SafeModeErrorCategorySchema.optional(),
    }),
    description: 'Get current safe mode state with full context',
  }),

  'app:enter-safe-mode': defineInvokeChannel({
    channel: 'app:enter-safe-mode',
    request: z.object({
      reason: z.enum(['cli', 'timeout', 'failure', 'user']),
      sentryEventId: z.string().optional(),
      errorCategory: SafeModeErrorCategorySchema.optional(),
    }),
    response: z.void(),
    description: 'Enter safe mode and restart the app with context',
  }),

  'app:exit-safe-mode': defineInvokeChannel({
    channel: 'app:exit-safe-mode',
    request: z.void(),
    response: z.void(),
    description: 'Exit safe mode and restart the app',
  }),

  'app:get-tutorial-player-url': defineInvokeChannel({
    channel: 'app:get-tutorial-player-url',
    request: z.string().describe('YouTube video ID (11 characters)'),
    response: z.string().nullable().describe('Full URL to the localhost tutorial player, or null if server not running'),
    description: 'Get the localhost URL for embedding a YouTube video via the tutorial player server (workaround for file:// protocol Referer issues)',
  }),

  'app:relaunch': defineInvokeChannel({
    channel: 'app:relaunch',
    request: z.void(),
    response: z.void(),
    description: 'Relaunch the entire application (quit and restart)',
  }),
} as const;

export type ConsumePendingNotificationClickResponse = z.infer<
  typeof appChannels['app:consume-pending-notification-click']['response']
>;
export type PendingNotificationClickIntent = Exclude<ConsumePendingNotificationClickResponse, null>;
