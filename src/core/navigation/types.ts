/**
 * Core Navigation Types
 *
 * The `NavigationAction` discriminated union produced by `resolveLink`. Every
 * surface dispatcher (desktop NavigationContext, mobile, future cloud/web)
 * consumes the same action shape, so adding a new surface means wiring one
 * switch statement rather than re-implementing URL parsing + space resolution.
 *
 * Design note: this is a FLAT union. Space links resolve into library actions
 * before the action is returned — dispatchers never see `open-space-file`,
 * only `open-library-file` with a workspace-relative path. This keeps each
 * dispatcher's switch isomorphic to "what this surface can do" rather than
 * "what the URL looked like".
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

import type { FeedbackTargetType, LibraryNavigationFilter, SettingsTabId } from '@shared/navigation/types';

/**
 * Typed error codes surfaced by `resolveLink` when a URL cannot produce a
 * usable action. Each code has a canonical user-facing copy entry in
 * `NAVIGATION_ERROR_COPY` below so surfaces present the same message.
 */
export type NavigationActionErrorCode =
  | 'invalid-url'
  | 'space-not-found'
  | 'file-not-found'
  | 'path-invalid'
  | 'unsupported-on-this-surface'
  | 'resolver-failed';

/**
 * Action a surface dispatcher can execute. Produced by `resolveLink`.
 *
 * Kinds group by terminal UI intent, not by URL shape. Space-link URLs produce
 * `open-library-file` / `open-library-folder` actions after resolution.
 */
export type NavigationAction =
  | { kind: 'open-home' }
  | { kind: 'open-session'; sessionId: string }
  | { kind: 'open-session-surface' }
  | { kind: 'open-settings'; tab?: SettingsTabId; section?: string }
  | { kind: 'open-library-file'; relativePath: string; filter?: LibraryNavigationFilter }
  | { kind: 'open-library-folder'; relativePath: string; filter?: LibraryNavigationFilter }
  | { kind: 'open-library-root'; filter?: LibraryNavigationFilter }
  | { kind: 'open-automations'; automationId?: string }
  | { kind: 'open-tasks'; focusApprovalId?: string }
  | { kind: 'open-seeded-chat'; token: string }
  | { kind: 'open-team'; roleId?: string }
  | { kind: 'open-usecases'; useCaseId?: string }
  | { kind: 'open-insights'; turnId: string }
  | { kind: 'open-media'; resourcePath: string }
  | { kind: 'open-focus'; lens?: 'week' | 'month' | 'quarter' }
  | {
      kind: 'open-feedback';
      feedbackType?: FeedbackTargetType;
      description?: string;
      stepsToReproduce?: string;
      expectedBehavior?: string;
      attachContinuityDiagnostics?: boolean;
    }
  | { kind: 'open-plugin'; pluginId: string; tabId?: string; params?: Record<string, string> }
  | { kind: 'invoke-action'; action: string; params?: Record<string, string> }
  | {
      kind: 'error';
      code: NavigationActionErrorCode;
      /** Short human-readable description. Surfaces may override before display. */
      message: string;
      /** The original URL / target that failed, for logging & debugging. */
      source?: string;
    };

/**
 * Canonical user-facing copy for resolver error codes. Every surface that
 * renders a toast / inline error should source its copy from this table so
 * "space not found" reads the same on desktop and mobile.
 *
 * Surfaces may compose additional context (e.g. include the URL in the
 * description) but should not replace the base copy without a product reason.
 */
export const NAVIGATION_ERROR_COPY: Record<
  NavigationActionErrorCode,
  { title: string; description: string }
> = {
  'invalid-url': {
    title: "Couldn't open that link",
    description: "Rebel doesn't recognize the shape of it.",
  },
  'space-not-found': {
    title: "That space isn't here",
    description:
      "It might not be set up on this machine yet. Ask the sender which space it's in, or check your workspace settings.",
  },
  'file-not-found': {
    title: "Can't find that file",
    description: "Got the space — but the file isn't here. It may still be syncing.",
  },
  'path-invalid': {
    title: "That link's not quite right",
    description: "The path may have gotten scrambled in transit.",
  },
  'unsupported-on-this-surface': {
    title: "Can't open this here",
    description: "The link works — just not on this screen.",
  },
  'resolver-failed': {
    title: "Couldn't follow that link",
    description: 'Something went sideways resolving it.',
  },
};
