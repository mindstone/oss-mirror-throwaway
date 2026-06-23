import type { MouseEvent as ReactMouseEvent } from 'react';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import type { SessionListItemActionsProps } from '../components/SessionListItemActions';
import type { SessionMenuCallbacks } from '../components/sessionMenuActions';

/**
 * Per-row policy inputs for the sidebar/search session row action buttons.
 *
 * Single source of truth for what the three `SessionListItemActions` call sites
 * in `AgentSessionSidebar.tsx` (the main list row, the Fuse search row, and the
 * deep-search row) used to assemble inline. Pure: feed it `ctx` (per-row state)
 * + `handlers` (component callbacks) and it returns the exact prop block, minus
 * the per-render `contextAnchor`/`onContextClose` which stay at the call site.
 */
export interface SessionRowActionsContext {
  sessionId: string;
  sessionTitle: string;
  isActive: boolean;
  isStarred: boolean;
  isCloudActive: boolean;
  isInFolder: boolean;
  hasContinuityApi: boolean;
  /** true for search-result rows (omit folder move/remove actions) */
  isSearchContext: boolean;
}

/**
 * Callbacks supplied by the component. Entry-specific handlers (`onToggleStar`)
 * are already bound to the right entry by the caller.
 */
export interface SessionRowActionsHandlers {
  /** Already bound to the right entry by the caller. */
  onToggleStar: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTogglePin: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleCloudContinuity: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onDelete: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Optional menu pass-throughs (match `SessionMenuCallbacks`' optional shape). */
  onFindSimilar?: (sessionId: string) => void;
  onCopyMarkdown?: (sessionId: string) => void;
  onExportMarkdown?: (sessionId: string) => void;
  onCopyLink?: (sessionId: string) => void;
  onShareConversation?: (sessionId: string) => void;
  onDiagnose?: (sessionId: string) => void;
  onExportLogs?: (sessionId: string) => void;
  onMoveToFolder: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRemoveFromFolder: (sessionId: string) => void;
}

/**
 * Build the `SessionListItemActions` props for one row, reproducing the gating
 * the three sidebar call sites used to do inline:
 * - `cloudToggle` shown iff `hasContinuityApi && isActive`
 * - menu `onShareConversation` iff `isCloudActive`
 * - menu `onToggleCloudContinuity` iff `isActive`
 * - folder actions (`onMoveToFolder`/`onRemoveFromFolder`) included iff `!isSearchContext`
 * - `isInFolder` always passed through
 */
export function buildSessionRowActionsProps(
  ctx: SessionRowActionsContext,
  handlers: SessionRowActionsHandlers,
): Pick<
  SessionListItemActionsProps,
  'sessionId' | 'sessionTitle' | 'star' | 'doneToggle' | 'cloudToggle' | 'isCloudActive' | 'menu'
> {
  const isBackground = isBackgroundConversationSession(ctx.sessionId);
  const menu: SessionMenuCallbacks = {
    onRename: handlers.onRename,
    onDelete: handlers.onDelete,
    onFindSimilar: handlers.onFindSimilar,
    onToggleStar: handlers.onToggleStar,
    onTogglePin: isBackground ? undefined : handlers.onTogglePin,
    onCopyMarkdown: handlers.onCopyMarkdown,
    onExportMarkdown: handlers.onExportMarkdown,
    onCopyLink: handlers.onCopyLink,
    onShareConversation: ctx.isCloudActive ? handlers.onShareConversation : undefined,
    onDiagnose: handlers.onDiagnose,
    onExportLogs: handlers.onExportLogs,
    onToggleCloudContinuity: ctx.isActive ? handlers.onToggleCloudContinuity : undefined,
    ...(ctx.isSearchContext
      ? {}
      : {
          onMoveToFolder: handlers.onMoveToFolder,
          onRemoveFromFolder: handlers.onRemoveFromFolder,
        }),
    isInFolder: ctx.isInFolder,
  };

  return {
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    star: { isStarred: ctx.isStarred, onToggle: handlers.onToggleStar },
    doneToggle: isBackground
      ? undefined
      : { isActive: ctx.isActive, onToggle: handlers.onTogglePin },
    cloudToggle:
      ctx.hasContinuityApi && ctx.isActive
        ? { isCloudActive: ctx.isCloudActive, onToggle: handlers.onToggleCloudContinuity }
        : undefined,
    isCloudActive: ctx.isCloudActive,
    menu,
  };
}
