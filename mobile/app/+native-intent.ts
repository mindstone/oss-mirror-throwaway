import { generateMobileSessionId } from '../src/utils/sessionId';
import { createLogger } from '@rebel/cloud-client';
import { parseNavigationUrl } from '@shared/navigation/urlParser';
import type { NavigationTarget } from '@shared/navigation/types';

const log = createLogger('nativeIntent');

/**
 * Expo Router native intent handler. Intercepts deep links before React rendering.
 *
 * `initial` is part of the Expo Router API (true on cold start) but behavior is
 * identical for this use case regardless of cold/warm start.
 *
 * Single source of truth: paths that look like `rebel://...` (or the legacy
 * empty-host `rebel:///...` form) are parsed via the shared `parseNavigationUrl`
 * and mapped to Expo Router paths below. Non-rebel paths (`/conversation/abc`,
 * `/inbox`, etc.) pass through unchanged. See
 * `docs/plans/260416_centralize_cross_surface_links.md` for the architecture.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const e2ePairPath = mapE2ePairDeepLink(path);
    if (e2ePairPath) {
      return e2ePairPath;
    }

    // The parser only accepts well-formed URLs with the rebel scheme. Expo Router
    // also delivers bare paths like `/start-voice` from some surfaces (e.g. widget
    // path-only form). Normalize those to the canonical empty-host URL so the
    // parser can recognise them; this keeps the regex-matching inlined here to
    // one place rather than scattered across handlers.
    const urlLike = normaliseToRebelUrl(path);
    if (!urlLike) {
      return path;
    }

    const target = parseNavigationUrl(urlLike);
    if (!target) {
      return path;
    }

    const mapped = mapTargetToExpoPath(target);
    return mapped ?? path;
  } catch (error) {
    log.error('Redirect failed', { err: error instanceof Error ? error.message : String(error), path });
    return path;
  }
}

function mapE2ePairDeepLink(path: string): string | null {
  if (process.env.EXPO_PUBLIC_REBEL_E2E !== '1' || !path.startsWith('rebel://e2e/pair')) {
    return null;
  }

  const queryStart = path.indexOf('?');
  return queryStart === -1 ? '/(e2e)/pair' : `/(e2e)/pair${path.slice(queryStart)}`;
}

/**
 * Convert the raw path Expo Router hands us into a parser-friendly URL.
 *
 * Accepts:
 * - `rebel://...` — already canonical, pass through
 * - `/{verb}` where verb is a known widget action (so `/start-voice` becomes
 *   `rebel:///start-voice`, which the parser handles via its empty-host branch)
 * - `/inbox-item/{id}` (legacy widget tap) → `rebel:///inbox-item/{id}`
 *
 * Returns null for anything else, letting Expo Router handle it natively.
 */
function normaliseToRebelUrl(path: string): string | null {
  if (path.startsWith('rebel://')) {
    return path;
  }

  // Path-only forms only make sense for the legacy widget verbs.
  if (path === '/start-voice' || path === '/start-meeting-recording' || path === '/stop-meeting-recording') {
    return `rebel://${path}`;
  }

  const inboxMatch = path.match(/^\/inbox-item\/(.+)$/);
  if (inboxMatch) {
    return `rebel:///inbox-item/${inboxMatch[1]}`;
  }

  return null;
}

/**
 * Translate a parsed `NavigationTarget` to the Expo Router path that should
 * actually be rendered. Returning null means "don't redirect, let Expo handle
 * whatever the original path was" — used for targets the mobile app doesn't
 * currently surface.
 */
function mapTargetToExpoPath(target: NavigationTarget): string | null {
  switch (target.type) {
    case 'action': {
      switch (target.action) {
        case 'start-voice': {
          const sessionId = generateMobileSessionId();
          return `/conversation/${sessionId}?autoRecord=true&source=widget`;
        }
        case 'start-meeting-recording':
          return '/meeting-recording?source=widget';
        case 'stop-meeting-recording':
          return '/meeting-recording?action=stop&source=widget';
        default:
          // Unknown widget verb — surface as no-op so we don't silently swallow.
          log.warn('Unknown widget action verb', { action: target.action });
          return null;
      }
    }

    case 'tasks': {
      // `rebel:///inbox-item/{id}` parses as `{ type: 'tasks', focusApprovalId }`.
      // Mobile uses the same "inbox" tab for this concept.
      if (target.focusApprovalId) {
        return `/(tabs)/inbox?itemId=${encodeURIComponent(target.focusApprovalId)}&source=widget`;
      }
      return '/(tabs)/inbox';
    }

    case 'feedback': {
      const params = new URLSearchParams();
      if (target.feedbackType) params.set('feedbackType', target.feedbackType);
      if (target.description) params.set('description', target.description);
      if (target.stepsToReproduce) params.set('stepsToReproduce', target.stepsToReproduce);
      if (target.expectedBehavior) params.set('expectedBehavior', target.expectedBehavior);
      if (target.attachContinuityDiagnostics) params.set('attachContinuityDiagnostics', '1');
      const query = params.toString();
      return query ? `/(tabs)/help?${query}` : '/(tabs)/help';
    }

    // The remaining target types are valid NavigationTargets but mobile's
    // deep-link surface area is intentionally narrow for now. Returning null
    // lets Expo Router's native handler take over, matching legacy behaviour.
    default:
      return null;
  }
}
