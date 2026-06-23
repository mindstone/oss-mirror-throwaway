/**
 * Core Navigation Resolver
 *
 * Translates a `rebel://` URL (or a pre-parsed `NavigationTarget`) into a
 * `NavigationAction` that any surface dispatcher can execute without further
 * validation. Space links are resolved to library actions at their
 * workspace-relative path via the `SpaceResolver` boundary.
 *
 * This function is the single place where URL validation + space resolution
 * live. Surface dispatchers should never re-implement either — they only
 * switch on `action.kind`.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

import type { NavigationTarget } from '@shared/navigation/types';
import { parseNavigationUrl } from '@shared/navigation/urlParser';

import type { SpaceResolver } from './boundaries';
import type { NavigationAction, NavigationActionErrorCode } from './types';

export interface ResolveLinkContext {
  /**
   * Platform adapter for space-link resolution. Pass `NullSpaceResolver` if
   * the current surface cannot resolve space links (space links will surface
   * as `{ kind: 'error', code: 'space-not-found' }`).
   */
  spaceResolver: SpaceResolver;
  /**
   * Optional diagnostic tag identifying the surface ('desktop' | 'mobile' |
   * 'cloud'). Propagated onto error actions as `source` for log correlation.
   * Does not affect resolution behaviour.
   */
  surface?: string;
}

/**
 * Resolve a URL string or `NavigationTarget` into a `NavigationAction`.
 *
 * The resolver is pure except for calls into `ctx.spaceResolver`. It performs
 * no UI side-effects, no session-existence checks, no surface-specific
 * branching — it just converts input into a validated action that dispatchers
 * can blindly execute.
 *
 * Returns an `{ kind: 'error', ... }` action on any failure. Callers should
 * always switch on `action.kind` and handle the `error` case explicitly.
 */
export async function resolveLink(
  urlOrTarget: string | NavigationTarget,
  ctx: ResolveLinkContext,
): Promise<NavigationAction> {
  // Step 1: normalise input to a parsed NavigationTarget.
  let target: NavigationTarget | null;
  let source: string | undefined;
  if (typeof urlOrTarget === 'string') {
    source = urlOrTarget;
    target = parseNavigationUrl(urlOrTarget);
    if (!target) {
      return buildError('invalid-url', "The link isn't in a form Rebel understands.", source);
    }
  } else {
    target = urlOrTarget;
  }

  // Step 2: map each NavigationTarget variant to its terminal NavigationAction.
  switch (target.type) {
    case 'home':
      return { kind: 'open-home' };

    case 'settings':
      return { kind: 'open-settings', tab: target.tab, section: target.section };

    case 'sessions':
      if (target.sessionId) {
        return { kind: 'open-session', sessionId: target.sessionId };
      }
      return { kind: 'open-session-surface' };

    case 'dashboard-chat':
      return { kind: 'open-seeded-chat', token: target.token };

    case 'library': {
      const filter = target.filter ? { filter: target.filter } : {};
      if (target.folderPath) {
        return { kind: 'open-library-folder', relativePath: target.folderPath, ...filter };
      }
      if (target.filePath) {
        return { kind: 'open-library-file', relativePath: target.filePath, ...filter };
      }
      return { kind: 'open-library-root', ...filter };
    }

    case 'space':
      return resolveSpace(target, ctx, source);

    case 'automations':
      return { kind: 'open-automations', automationId: target.automationId };

    case 'tasks':
      return { kind: 'open-tasks', focusApprovalId: target.focusApprovalId };

    case 'team':
      return { kind: 'open-team', roleId: target.roleId };

    case 'usecases':
      return { kind: 'open-usecases', useCaseId: target.useCaseId };

    case 'insights':
      return { kind: 'open-insights', turnId: target.turnId };

    case 'media':
      return { kind: 'open-media', resourcePath: target.resourcePath };

    case 'focus':
      return { kind: 'open-focus', lens: target.lens };

    case 'feedback':
      return {
        kind: 'open-feedback',
        feedbackType: target.feedbackType,
        description: target.description,
        stepsToReproduce: target.stepsToReproduce,
        expectedBehavior: target.expectedBehavior,
        attachContinuityDiagnostics: target.attachContinuityDiagnostics,
      };

    case 'plugin':
      return {
        kind: 'open-plugin',
        pluginId: target.pluginId,
        tabId: target.tabId,
        params: target.params,
      };

    case 'action':
      return { kind: 'invoke-action', action: target.action, params: target.params };

    default: {
      // Exhaustiveness check. If this compiles, every variant above was handled.
      const _exhaustive: never = target;
      return buildError('invalid-url', 'Unrecognised navigation target.', source);
    }
  }
}

/**
 * Resolve a `{ type: 'space', ... }` target to a library action via the
 * SpaceResolver boundary. Swallows and wraps resolver exceptions so callers
 * always get a typed action instead of a thrown promise rejection.
 */
async function resolveSpace(
  target: Extract<NavigationTarget, { type: 'space' }>,
  ctx: ResolveLinkContext,
  source: string | undefined,
): Promise<NavigationAction> {
  let result;
  try {
    result = await ctx.spaceResolver.resolveSpaceLink({
      spaceName: target.spaceName,
      filePath: target.filePath,
      folderPath: target.folderPath,
    });
  } catch (err) {
    return buildError(
      'resolver-failed',
      err instanceof Error ? err.message : 'Space resolver threw an unexpected error.',
      source,
    );
  }

  if (!result.ok) {
    return buildError(result.error, errorCodeToMessage(result.error), source);
  }

  // A space link with a filePath resolves to a library file action; folderPath
  // (or the space-root bare form) resolves to a folder action. The resolver
  // returns the workspace-relative path that the library surface understands.
  if (target.folderPath) {
    return { kind: 'open-library-folder', relativePath: result.workspaceRelativePath };
  }
  if (target.filePath) {
    return { kind: 'open-library-file', relativePath: result.workspaceRelativePath };
  }
  // Bare `rebel://space/{name}` — open the space's root folder in the library.
  return { kind: 'open-library-folder', relativePath: result.workspaceRelativePath };
}

function buildError(
  code: NavigationActionErrorCode,
  message: string,
  source: string | undefined,
): NavigationAction {
  return { kind: 'error', code, message, source };
}

function errorCodeToMessage(code: 'space-not-found' | 'file-not-found' | 'path-invalid'): string {
  switch (code) {
    case 'space-not-found':
      return "That space isn't set up on your machine.";
    case 'file-not-found':
      return "Found the space, but that file doesn't exist yet.";
    case 'path-invalid':
      return "That link doesn't look right — the path may have been corrupted.";
  }
}
