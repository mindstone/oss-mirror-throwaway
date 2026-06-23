/**
 * URL Parser for Navigation System
 *
 * Handles parsing and formatting of rebel:// URLs for navigation.
 * Part of the Unified Navigation System (see docs/plans/finished/251219_unified_navigation_system.md).
 */

import {
  LIBRARY_NAVIGATION_FILTERS,
  resolveSettingsTabId,
  type FeedbackTargetType,
  type LibraryNavigationFilter,
  type NavigationTarget,
  type SettingsTabId,
} from './types';

const FEEDBACK_TYPES = new Set<FeedbackTargetType>(['bug', 'improvement']);
const MAX_FEEDBACK_DESCRIPTION_LENGTH = 5000;

/**
 * Legacy three-slash action verbs: `rebel:///{verb}`.
 *
 * These were emitted by the iOS widget before we had a proper `action` host
 * in the schema. They parse as URLs with an empty host (`parsed.hostname === ''`)
 * and the verb sitting on the pathname. The parser maps them to the canonical
 * `{ type: 'action', action: ... }` target so every surface sees the same
 * NavigationTarget regardless of which form the URL used.
 *
 * Keep the three-slash form working for at least one stable-release cycle after
 * widget binaries are rebuilt to emit the canonical `rebel://action/{verb}` form.
 * See docs/plans/260416_centralize_cross_surface_links.md.
 */
const LEGACY_THREE_SLASH_VERBS = new Set([
  'start-voice',
  'start-meeting-recording',
  'stop-meeting-recording',
]);

/**
 * Validates a workspace path for security (path traversal prevention).
 *
 * @param urlPathname - The raw URL pathname (starts with /)
 * @returns true if the path is safe, false if it contains traversal attempts
 */
function isValidWorkspacePath(urlPathname: string): boolean {
  // Strip leading slash from URL pathname (rebel://workspace/foo → /foo → foo)
  const path = urlPathname.startsWith('/') ? urlPathname.slice(1) : urlPathname;

  // Empty path is valid (just opens workspace surface)
  if (!path) return true;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed encoding - reject
    return false;
  }

  // Split into segments and validate each
  const segments = decoded.split('/');
  for (const segment of segments) {
    // Reject traversal segments
    if (segment === '..' || segment === '.') return false;
    // Reject backslashes (Windows path injection)
    if (segment.includes('\\')) return false;
    // Reject NUL bytes
    if (segment.includes('\0')) return false;
  }

  // Reject absolute paths (after stripping URL leading /)
  if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) || decoded.startsWith('\\\\')) {
    return false;
  }

  return true;
}

/**
 * Extracts segments from a URL pathname, handling leading slash and trailing slashes.
 *
 * @param pathname - The URL pathname (e.g., "/settings/agents/")
 * @returns Array of non-empty path segments
 */
function getPathSegments(pathname: string): string[] {
  // Strip leading slash and split
  const path = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  // Filter out empty segments (handles trailing slashes)
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Parses a rebel:// URL into a NavigationTarget.
 *
 * @param url - The URL string to parse (e.g., "rebel://settings/agents#voiceAudio")
 * @returns NavigationTarget if valid, null if invalid or malformed
 *
 * URL format: rebel://{surface}[/{id}][#section]
 *
 * Supported URLs:
 * - rebel://settings[/tab][#section]
 * - rebel://settings/?tab=cloud&section=messagingChannels
 * - rebel://conversation/{sessionId}
 * - rebel://sessions[/{sessionId}]
 * - rebel://chat/from-dashboard?token={dashboardShareToken}
 * - rebel://home
 * - rebel://library[/{path}][?type=folder]  (type=folder for folder navigation)
 * - rebel://workspace[/{path}]  (legacy alias for library)
 * - rebel://automations[/{automationId}]
 * - rebel://team[/{roleId}]
 * - rebel://tasks
 * - rebel://usecases[/{useCaseId}]
 * - rebel://insights/{turnId}
 * - rebel://media/{resourcePath}
 * - rebel://plugin/{pluginId}[/{tabId}]
 */
export function parseNavigationUrl(url: string): NavigationTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Case-insensitive scheme matching
  if (parsed.protocol.toLowerCase() !== 'rebel:') {
    return null;
  }

  // Get segments from pathname
  // Note: URL constructor normalizes rebel://settings to have hostname 'settings' and empty pathname
  // vs rebel://settings/ which may have pathname '/'
  const host = parsed.hostname.toLowerCase();
  const segments = getPathSegments(parsed.pathname);
  const section = parsed.hash ? parsed.hash.slice(1) : undefined; // Remove leading #

  // Legacy three-slash form: rebel:///{verb} and rebel:///inbox-item/{id}
  // These predate the `rebel://action/...` host. Map them into the canonical
  // action target so the rest of the pipeline doesn't care which form shipped.
  if (host === '') {
    const firstSegment = segments[0];
    if (!firstSegment) {
      return null;
    }

    // rebel:///inbox-item/{id} → { type: 'tasks', focusApprovalId }.
    // Legacy iOS widget format. We map it to surface navigation (tasks with
    // focused approval) rather than an action verb because "open the inbox
    // item" is inherently about landing on a screen, not firing a side-effect.
    if (firstSegment === 'inbox-item' && segments[1]) {
      try {
        return { type: 'tasks', focusApprovalId: decodeURIComponent(segments[1]) };
      } catch {
        return null;
      }
    }

    if (LEGACY_THREE_SLASH_VERBS.has(firstSegment)) {
      return { type: 'action', action: firstSegment };
    }

    // Unknown empty-host path; reject rather than silently route.
    return null;
  }

  // Decode section if present (can throw on malformed input)
  let decodedSection: string | undefined;
  if (section) {
    try {
      decodedSection = decodeURIComponent(section);
    } catch {
      // Invalid hash encoding - ignore section but continue parsing
      decodedSection = undefined;
    }
  }

  if (host === 'chat') {
    const route = segments[0] ?? parsed.pathname.replace(/^\//, '');
    if (route !== 'from-dashboard') return null;

    const token = parsed.searchParams.get('token')?.trim();
    if (!token) return null;

    return { type: 'dashboard-chat', token };
  }

  switch (host) {
    case 'settings': {
      const tabStr = parsed.searchParams.get('tab') ?? segments[0];
      let tab: SettingsTabId | undefined;
      if (tabStr) {
        try {
          const decodedTab = decodeURIComponent(tabStr);
          tab = resolveSettingsTabId(decodedTab);
        } catch {
          // Malformed encoding - ignore tab
        }
      }
      const querySection = parsed.searchParams.get('section') ?? undefined;
      let resolvedQuerySection: string | undefined;
      if (querySection) {
        try {
          resolvedQuerySection = decodeURIComponent(querySection);
        } catch {
          resolvedQuerySection = undefined;
        }
      }
      return { type: 'settings', tab, section: resolvedQuerySection ?? decodedSection };
    }

    case 'conversation':
    case 'sessions': {
      const sessionId = segments[0];
      if (sessionId) {
        try {
          return { type: 'sessions', sessionId: decodeURIComponent(sessionId) };
        } catch {
          return null;
        }
      }
      return { type: 'sessions' };
    }

    case 'library':
    case 'workspace': {
      // 'workspace' kept for backwards compatibility with old URLs
      // Validate path for security
      if (!isValidWorkspacePath(parsed.pathname)) {
        return null;
      }

      const pathStr = segments.join('/');
      const isFolder = parsed.searchParams.get('type') === 'folder';
      const filterParam = parsed.searchParams.get('filter');
      const filter = filterParam && (LIBRARY_NAVIGATION_FILTERS as readonly string[]).includes(filterParam)
        ? (filterParam as LibraryNavigationFilter)
        : undefined;

      if (pathStr) {
        try {
          const decodedPath = decodeURIComponent(pathStr);
          if (isFolder) {
            return { type: 'library', folderPath: decodedPath, ...(filter ? { filter } : {}) };
          }
          return { type: 'library', filePath: decodedPath, ...(filter ? { filter } : {}) };
        } catch {
          return null;
        }
      }
      return { type: 'library', ...(filter ? { filter } : {}) };
    }

    case 'space': {
      // First segment = spaceName (required, URI-decoded)
      const spaceNameEncoded = segments[0];
      if (!spaceNameEncoded) {
        return null; // spaceName is required
      }

      let spaceName: string;
      try {
        spaceName = decodeURIComponent(spaceNameEncoded);
      } catch {
        return null;
      }

      // Remaining segments form the relative path within the space
      const remainingSegments = segments.slice(1);

      // Validate relative path for security (traversal, backslash, NUL byte prevention)
      if (remainingSegments.length > 0) {
        const relativePathname = '/' + remainingSegments.join('/');
        if (!isValidWorkspacePath(relativePathname)) {
          return null;
        }
      }

      const pathStr = remainingSegments.join('/');
      const isFolder = parsed.searchParams.get('type') === 'folder';

      if (pathStr) {
        try {
          const decodedPath = decodeURIComponent(pathStr);
          if (isFolder) {
            return { type: 'space', spaceName, folderPath: decodedPath };
          }
          return { type: 'space', spaceName, filePath: decodedPath };
        } catch {
          return null;
        }
      }

      return { type: 'space', spaceName };
    }

    case 'home':
      return { type: 'home' };

    case 'automations': {
      const automationId = segments[0];
      if (automationId) {
        try {
          return { type: 'automations', automationId: decodeURIComponent(automationId) };
        } catch {
          return null;
        }
      }
      return { type: 'automations' };
    }

    case 'focus': {
      const lensStr = segments[0];
      const validLenses = new Set(['week', 'month', 'quarter']);
      let lens: 'week' | 'month' | 'quarter' | undefined;
      if (lensStr && validLenses.has(lensStr)) {
        lens = lensStr as 'week' | 'month' | 'quarter';
      }
      return { type: 'focus', lens };
    }

    case 'tasks': {
      // Accept focus via either path (`rebel://tasks/{id}`) or query param
      // (`rebel://tasks?focusApprovalId={id}`). Path form is what the widget
      // and deep links emit; query form is symmetric with the internal type.
      const pathId = segments[0];
      const queryId = parsed.searchParams.get('focusApprovalId') ?? undefined;
      try {
        const focusApprovalId = pathId ? decodeURIComponent(pathId) : queryId;
        return { type: 'tasks', ...(focusApprovalId ? { focusApprovalId } : {}) };
      } catch {
        return null;
      }
    }

    case 'team': {
      const roleId = segments[0];
      if (roleId) {
        try {
          return { type: 'team', roleId: decodeURIComponent(roleId) };
        } catch {
          return null;
        }
      }
      return { type: 'team' };
    }

    case 'usecases': {
      const useCaseId = segments[0];
      if (useCaseId) {
        try {
          return { type: 'usecases', useCaseId: decodeURIComponent(useCaseId) };
        } catch {
          return null;
        }
      }
      return { type: 'usecases', useCaseId: undefined };
    }

    case 'insights': {
      const turnId = segments[0];
      if (!turnId) {
        return null; // turnId is required
      }
      try {
        return { type: 'insights', turnId: decodeURIComponent(turnId) };
      } catch {
        return null;
      }
    }

    case 'media': {
      // Resource path is required for media
      const resourcePath = segments.join('/');
      if (!resourcePath) {
        return null;
      }
      try {
        return { type: 'media', resourcePath: decodeURIComponent(resourcePath) };
      } catch {
        return null;
      }
    }

    case 'feedback': {
      // rebel://feedback[/bug|/improvement][?description=...]
      const feedbackTypeStr = segments[0];
      let feedbackType: FeedbackTargetType | undefined;
      if (feedbackTypeStr && FEEDBACK_TYPES.has(feedbackTypeStr as FeedbackTargetType)) {
        feedbackType = feedbackTypeStr as FeedbackTargetType;
      }

      let description: string | undefined;
      const rawDescription = parsed.searchParams.get('description');
      if (rawDescription) {
        description = rawDescription.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH);
      }

      let stepsToReproduce: string | undefined;
      const rawSteps = parsed.searchParams.get('stepsToReproduce');
      if (rawSteps) {
        stepsToReproduce = rawSteps.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH);
      }

      let expectedBehavior: string | undefined;
      const rawExpected = parsed.searchParams.get('expectedBehavior');
      if (rawExpected) {
        expectedBehavior = rawExpected.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH);
      }

      const attachContinuityRaw = parsed.searchParams.get('attachContinuityDiagnostics');
      const attachContinuityDiagnostics = attachContinuityRaw === '1' || attachContinuityRaw === 'true';

      return {
        type: 'feedback',
        feedbackType,
        description,
        stepsToReproduce,
        expectedBehavior,
        ...(attachContinuityDiagnostics ? { attachContinuityDiagnostics } : {}),
      };
    }

    case 'plugin': {
      // rebel://plugin/{pluginId}[/{tabId}][?key=value&...]
      const pluginIdSegment = segments[0];
      if (!pluginIdSegment) {
        return null; // pluginId is required
      }
      try {
        const pluginId = decodeURIComponent(pluginIdSegment);
        const tabIdSegment = segments[1];
        const tabId = tabIdSegment ? decodeURIComponent(tabIdSegment) : undefined;
        // Extract query params
        const params: Record<string, string> = {};
        for (const [key, value] of parsed.searchParams.entries()) {
          params[key] = value;
        }
        const hasParams = Object.keys(params).length > 0;
        return { type: 'plugin', pluginId, tabId, ...(hasParams ? { params } : {}) };
      } catch {
        return null;
      }
    }

    case 'action': {
      // rebel://action/{verb}[?key=value&...]
      // Verb is open-ended — the dispatcher (per surface) decides what to do
      // with unknown verbs and surfaces an "unsupported action" error for ones
      // it can't handle. Parser accepts anything percent-decodable so plugins
      // and future work can extend without a schema bump.
      const verbSegment = segments[0];
      if (!verbSegment) {
        return null;
      }
      try {
        const action = decodeURIComponent(verbSegment);
        const params: Record<string, string> = {};
        for (const [key, value] of parsed.searchParams.entries()) {
          params[key] = value;
        }
        const hasParams = Object.keys(params).length > 0;
        return { type: 'action', action, ...(hasParams ? { params } : {}) };
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Formats a NavigationTarget into a rebel:// URL string.
 *
 * @param target - The navigation target to format
 * @returns URL string
 *
 * Note: Sessions are formatted as rebel://conversation/{id} to match existing usage,
 * not rebel://sessions/{id}.
 */
export function formatNavigationUrl(target: NavigationTarget): string {
  switch (target.type) {
    case 'home':
      return 'rebel://home';

    case 'settings': {
      let url = 'rebel://settings';
      if (target.tab) {
        url += `/${encodeURIComponent(target.tab)}`;
      }
      if (target.section) {
        url += `#${encodeURIComponent(target.section)}`;
      }
      return url;
    }

    case 'sessions':
      // Use 'conversation' in URL to match existing rebel://conversation/{id} format
      if (target.sessionId) {
        return `rebel://conversation/${encodeURIComponent(target.sessionId)}`;
      }
      return 'rebel://conversation';

    case 'dashboard-chat':
      return `rebel://chat/from-dashboard?token=${encodeURIComponent(target.token)}`;

    case 'library': {
      const filterQuery = target.filter ? `filter=${encodeURIComponent(target.filter)}` : null;
      if (target.folderPath) {
        const base = `rebel://library/${encodeURIComponent(target.folderPath)}?type=folder`;
        return filterQuery ? `${base}&${filterQuery}` : base;
      }
      if (target.filePath) {
        const base = `rebel://library/${encodeURIComponent(target.filePath)}`;
        return filterQuery ? `${base}?${filterQuery}` : base;
      }
      return filterQuery ? `rebel://library?${filterQuery}` : 'rebel://library';
    }

    case 'space': {
      let url = `rebel://space/${encodeURIComponent(target.spaceName)}`;
      if (target.folderPath) {
        url += `/${encodeURIComponent(target.folderPath)}?type=folder`;
      } else if (target.filePath) {
        url += `/${encodeURIComponent(target.filePath)}`;
      }
      return url;
    }

    case 'automations':
      if (target.automationId) {
        return `rebel://automations/${encodeURIComponent(target.automationId)}`;
      }
      return 'rebel://automations';

    case 'focus':
      if (target.lens) {
        return `rebel://focus/${encodeURIComponent(target.lens)}`;
      }
      return 'rebel://focus';

    case 'tasks':
      return target.focusApprovalId
        ? `rebel://tasks/${encodeURIComponent(target.focusApprovalId)}`
        : 'rebel://tasks';

    case 'team':
      if (target.roleId) {
        return `rebel://team/${encodeURIComponent(target.roleId)}`;
      }
      return 'rebel://team';

    case 'usecases':
      if (target.useCaseId) {
        return `rebel://usecases/${encodeURIComponent(target.useCaseId)}`;
      }
      return 'rebel://usecases';

    case 'insights':
      return `rebel://insights/${encodeURIComponent(target.turnId)}`;

    case 'media':
      return `rebel://media/${encodeURIComponent(target.resourcePath)}`;

    case 'feedback': {
      let url = 'rebel://feedback';
      if (target.feedbackType) {
        url += `/${encodeURIComponent(target.feedbackType)}`;
      }
      const params = new URLSearchParams();
      if (target.description) {
        params.set('description', target.description.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH));
      }
      if (target.stepsToReproduce) {
        params.set('stepsToReproduce', target.stepsToReproduce.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH));
      }
      if (target.expectedBehavior) {
        params.set('expectedBehavior', target.expectedBehavior.slice(0, MAX_FEEDBACK_DESCRIPTION_LENGTH));
      }
      if (target.attachContinuityDiagnostics) {
        params.set('attachContinuityDiagnostics', '1');
      }
      const paramStr = params.toString();
      if (paramStr) {
        url += `?${paramStr}`;
      }
      return url;
    }

    case 'plugin': {
      let url = `rebel://plugin/${encodeURIComponent(target.pluginId)}`;
      if (target.tabId) {
        url += `/${encodeURIComponent(target.tabId)}`;
      }
      if (target.params && Object.keys(target.params).length > 0) {
        const searchParams = new URLSearchParams(target.params);
        url += `?${searchParams.toString()}`;
      }
      return url;
    }

    case 'action': {
      let url = `rebel://action/${encodeURIComponent(target.action)}`;
      if (target.params && Object.keys(target.params).length > 0) {
        const searchParams = new URLSearchParams(target.params);
        url += `?${searchParams.toString()}`;
      }
      return url;
    }
  }
}

/**
 * Formats a workspace-relative file path as a `rebel://library/` URL.
 *
 * This is the canonical form emitted by every surface for new content
 * (markdown rendering, TipTap editor, widget/action URLs, share-link
 * generation). `library://` and `workspace://` remain **readable** indefinitely
 * via `extractLibraryPath` / `getLibraryProtocol` so existing content,
 * third-party pastes, and saved documents keep working — but we stop emitting
 * those legacy forms.
 *
 * Stage H of docs/plans/260416_centralize_cross_surface_links.md unifies the
 * emission under one protocol so recipients on any surface see the same URL.
 *
 * @param filePath - Workspace-relative path (e.g. `docs/file.md`)
 * @returns Encoded `rebel://library/` URL string
 */
export function formatLibraryUrl(filePath: string): string {
  return `rebel://library/${encodeURIComponent(filePath)}`;
}
