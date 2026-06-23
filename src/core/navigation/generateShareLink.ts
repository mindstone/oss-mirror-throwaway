/**
 * Core Share-Link Generator
 *
 * Produces `rebel://` URLs (and optional `https://.../app/open?u=...`
 * launcher URLs) for a shareable resource. The "Copy shareable link" UI on
 * every surface calls this one function rather than hand-building URLs.
 *
 * Design choices:
 *
 * - Absolute-path library files are reverse-resolved through
 *   `spaceResolver.filePathToSpaceLink`. If the file lives in a shareable
 *   space, we emit `rebel://space/{space}/{path}` (works for any recipient
 *   who has the space synced). Otherwise we return `{ ok: false }` — core
 *   never emits a bare `rebel://library/` URL as a shareable link because
 *   workspace-relative paths don't resolve on other users' machines.
 *
 * - When `cloudBaseUrl` is set, we also emit a `/app/open?u=<rebel>` launcher
 *   URL. The launcher (built in Stage F) attempts the deep-link on the
 *   recipient's OS and falls back to `getrebel.mindstone.com` when the app
 *   isn't installed.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C / F / G.
 */

import { formatNavigationUrl } from '@shared/navigation/urlParser';

import type { SpaceResolver } from './boundaries';

/**
 * The resource a caller wants to share. Shapes match `NavigationAction`
 * where possible; library-file/folder take absolute paths because that is
 * the natural "right-click on a file in the library" input.
 */
export type ShareableResource =
  | { kind: 'conversation'; sessionId: string }
  | { kind: 'library-file'; absolutePath: string }
  | { kind: 'library-folder'; absolutePath: string }
  | { kind: 'space-file'; spaceName: string; relativePath: string }
  | { kind: 'space-folder'; spaceName: string; relativePath: string }
  | { kind: 'tasks'; focusApprovalId?: string }
  | { kind: 'action'; action: string; params?: Record<string, string> };

export interface GenerateShareLinkContext {
  /**
   * Platform adapter. Used by `library-file` / `library-folder` resources to
   * reverse-resolve an absolute path to a space-scoped URL.
   */
  spaceResolver: SpaceResolver;
  /**
   * Cloud origin (e.g. `https://cloud.getrebel.com`). When provided, the
   * result includes an `https` launcher URL in addition to the `rebel://`
   * form. Trailing slashes are stripped.
   */
  cloudBaseUrl?: string;
}

export type ShareLinkResult =
  | {
      ok: true;
      /** Canonical rebel:// URL. Always present when ok. */
      rebel: string;
      /**
       * `https://{cloudBaseUrl}/app/open?u=<encoded>` launcher URL. Present
       * iff `cloudBaseUrl` was provided to the context.
       */
      https?: string;
      /** What the rebel link actually points to — drives UI labelling. */
      preferred: 'space' | 'conversation' | 'tasks' | 'action' | 'library';
    }
  | {
      ok: false;
      /**
       * Why no shareable link was produced. Callers should disable the
       * "Copy shareable link" UI and surface a helpful tooltip.
       */
      reason: 'private-space' | 'not-in-workspace' | 'unsupported-resource';
    };

/**
 * Build a shareable link for `resource`. Returns both the `rebel://` URL
 * and, when `ctx.cloudBaseUrl` is set, an HTTPS launcher URL that works for
 * recipients without Rebel installed.
 */
export async function generateShareLink(
  resource: ShareableResource,
  ctx: GenerateShareLinkContext,
): Promise<ShareLinkResult> {
  switch (resource.kind) {
    case 'conversation': {
      const rebel = formatNavigationUrl({ type: 'sessions', sessionId: resource.sessionId });
      return wrapSuccess(rebel, 'conversation', ctx.cloudBaseUrl);
    }

    case 'library-file':
    case 'library-folder': {
      const reverse = await ctx.spaceResolver.filePathToSpaceLink(resource.absolutePath);
      if (!reverse) {
        // Either the path is in a private space or not inside any space at
        // all. Either way, there is no shareable form — caller disables the UI.
        return { ok: false, reason: 'private-space' };
      }
      const rebel = formatNavigationUrl(
        resource.kind === 'library-file'
          ? { type: 'space', spaceName: reverse.spaceName, filePath: reverse.relativePath }
          : { type: 'space', spaceName: reverse.spaceName, folderPath: reverse.relativePath },
      );
      return wrapSuccess(rebel, 'space', ctx.cloudBaseUrl);
    }

    case 'space-file': {
      const rebel = formatNavigationUrl({
        type: 'space',
        spaceName: resource.spaceName,
        filePath: resource.relativePath,
      });
      return wrapSuccess(rebel, 'space', ctx.cloudBaseUrl);
    }

    case 'space-folder': {
      const rebel = formatNavigationUrl({
        type: 'space',
        spaceName: resource.spaceName,
        folderPath: resource.relativePath,
      });
      return wrapSuccess(rebel, 'space', ctx.cloudBaseUrl);
    }

    case 'tasks': {
      const rebel = formatNavigationUrl({
        type: 'tasks',
        focusApprovalId: resource.focusApprovalId,
      });
      return wrapSuccess(rebel, 'tasks', ctx.cloudBaseUrl);
    }

    case 'action': {
      const rebel = formatNavigationUrl({
        type: 'action',
        action: resource.action,
        params: resource.params,
      });
      return wrapSuccess(rebel, 'action', ctx.cloudBaseUrl);
    }

    default: {
      // Exhaustiveness check.
      const _exhaustive: never = resource;
      return { ok: false, reason: 'unsupported-resource' };
    }
  }
}

function wrapSuccess(
  rebel: string,
  preferred: Extract<ShareLinkResult, { ok: true }>['preferred'],
  cloudBaseUrl: string | undefined,
): ShareLinkResult {
  if (!cloudBaseUrl) {
    return { ok: true, rebel, preferred };
  }
  const trimmed = cloudBaseUrl.replace(/\/+$/, '');
  const https = `${trimmed}/app/open?u=${encodeURIComponent(rebel)}`;
  return { ok: true, rebel, https, preferred };
}
