/**
 * Shared session/conversation menu action definitions.
 * Used by both SessionActionsMenu (sidebar) and ConversationActionsMenu (main view).
 */

import type { MouseEvent as ReactMouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Pencil,
  Search,
  Trash2,
  Star,
  CheckCircle2,
  RotateCcw,
  FileDown,
  ClipboardCopy,
  Link,
  Share2,
  PanelLeft,
  Stethoscope,
  ScrollText,
  CloudOff,
  Cloud,
  FolderInput,
} from 'lucide-react';

export type SessionMenuActionId =
  | 'rename'
  | 'findSimilar'
  | 'delete'
  | 'toggleStar'
  | 'togglePin'
  | 'toggleCloudContinuity'
  | 'shareConversation'
  | 'copyMarkdown'
  | 'exportMarkdown'
  | 'copyLink'
  | 'revealInSidebar'
  | 'diagnose'
  | 'exportLogs'
  | 'moveToFolder'
  | 'removeFromFolder';

export interface SessionMenuAction {
  id: SessionMenuActionId;
  label: string | ((context: SessionMenuContext) => string);
  /** Static icon for the action (dynamic icons handled in getActionIcon) */
  icon: LucideIcon;
  /** Whether this action has a danger/destructive styling */
  isDanger?: boolean;
  /** Whether to show a divider before this action */
  dividerBefore?: boolean;
  /** 
   * Where this action is available:
   * - 'both': Available in sidebar and conversation view
   * - 'sidebar': Only in sidebar context menu
   * - 'conversation': Only in conversation view menu
   */
  availability: 'both' | 'sidebar' | 'conversation';
}

export interface SessionMenuContext {
  sessionId: string;
  sessionTitle: string;
  isStarred: boolean;
  /** True when the session is Active (`doneAt == null`). */
  isActive: boolean;
  /** Whether this session is cloud_active. Only relevant when cloud mode is connected. */
  isCloudActive?: boolean;
}

export interface SessionMenuCallbacks {
  onRename?: (sessionId: string, currentTitle: string) => void;
  onDelete?: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onFindSimilar?: (sessionId: string) => void;
  onToggleStar?: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTogglePin?: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleCloudContinuity?: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onCopyMarkdown?: (sessionId: string) => void;
  onExportMarkdown?: (sessionId: string) => void;
  onCopyLink?: (sessionId: string) => void;
  onShareConversation?: (sessionId: string) => void;
  onRevealInSidebar?: (sessionId: string) => void;
  onDiagnose?: (sessionId: string) => void;
  onExportLogs?: (sessionId: string) => void;
  /** Opens the "Move to folder" popover anchored at the click position */
  onMoveToFolder?: (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Removes the session from its current folder */
  onRemoveFromFolder?: (sessionId: string) => void;
  /** Whether this session is currently in a folder (controls removeFromFolder visibility) */
  isInFolder?: boolean;
}

/**
 * All available session menu actions in display order.
 */
const SESSION_MENU_ACTIONS: SessionMenuAction[] = [
  {
    id: 'rename',
    label: 'Rename',
    icon: Pencil,
    availability: 'both',
  },
  {
    id: 'findSimilar',
    label: 'Find similar',
    icon: Search,
    availability: 'both',
  },
  {
    id: 'moveToFolder',
    label: 'Move to folder…',
    icon: FolderInput,
    dividerBefore: true,
    availability: 'both',
  },
  {
    id: 'removeFromFolder',
    label: 'Remove from folder',
    icon: FolderInput,
    availability: 'both',
  },
  {
    id: 'toggleStar',
    dividerBefore: true,
    label: (ctx) => ctx.isStarred ? 'Remove from Starred' : 'Add to Starred',
    icon: Star,
    availability: 'both',
  },
  {
    id: 'togglePin',
    label: (ctx) => ctx.isActive ? 'Mark as done' : 'Reopen',
    icon: CheckCircle2,
    availability: 'both',
  },
  {
    id: 'toggleCloudContinuity',
    label: (ctx) => ctx.isCloudActive ? 'Remove from cloud' : 'Keep in cloud',
    icon: Cloud, // Dynamic icon resolved in getActionIcon
    availability: 'both',
  },
  {
    id: 'revealInSidebar',
    label: 'Reveal in sidebar',
    icon: PanelLeft,
    availability: 'conversation',
  },
  {
    id: 'copyLink',
    label: 'Copy link',
    icon: Link,
    availability: 'both',
    dividerBefore: true,
  },
  {
    id: 'shareConversation',
    label: 'Share publicly\u2026',
    icon: Share2,
    availability: 'both',
  },
  {
    id: 'copyMarkdown',
    label: 'Copy as Markdown',
    icon: ClipboardCopy,
    availability: 'both',
  },
  {
    id: 'exportMarkdown',
    label: 'Export to Markdown',
    icon: FileDown,
    availability: 'both',
  },
  {
    id: 'diagnose',
    label: 'Diagnose this conversation',
    icon: Stethoscope,
    dividerBefore: true,
    availability: 'both',
  },
  {
    id: 'exportLogs',
    label: 'Export conversation diagnostics',
    icon: ScrollText,
    availability: 'both',
  },
  {
    id: 'delete',
    label: 'Delete',
    icon: Trash2,
    isDanger: true,
    dividerBefore: true,
    availability: 'both',
  },
];

/**
 * Get the label for an action, resolving dynamic labels.
 */
export function getActionLabel(action: SessionMenuAction, context: SessionMenuContext): string {
  return typeof action.label === 'function' ? action.label(context) : action.label;
}

/**
 * Get the icon for an action, resolving dynamic icons for special cases.
 */
export function getActionIcon(action: SessionMenuAction, context: SessionMenuContext): LucideIcon {
  // Special case: togglePin uses different icons based on state
  if (action.id === 'togglePin') {
    return context.isActive ? CheckCircle2 : RotateCcw;
  }
  // Special case: toggleCloudContinuity uses different icons based on state
  if (action.id === 'toggleCloudContinuity') {
    return context.isCloudActive ? CloudOff : Cloud;
  }
  return action.icon;
}

/**
 * Filter actions based on menu context (sidebar vs conversation).
 */
export function getActionsForContext(
  menuContext: 'sidebar' | 'conversation',
  callbacks: SessionMenuCallbacks
): SessionMenuAction[] {
  return SESSION_MENU_ACTIONS.filter((action) => {
    // Check availability
    if (action.availability !== 'both' && action.availability !== menuContext) {
      return false;
    }
    // Check if callback is provided
    switch (action.id) {
      case 'rename':
        return Boolean(callbacks.onRename);
      case 'findSimilar':
        return Boolean(callbacks.onFindSimilar);
      case 'moveToFolder':
        return Boolean(callbacks.onMoveToFolder);
      case 'removeFromFolder':
        return Boolean(callbacks.onRemoveFromFolder) && Boolean(callbacks.isInFolder);
      case 'delete':
        return Boolean(callbacks.onDelete);
      case 'toggleStar':
        return Boolean(callbacks.onToggleStar);
      case 'togglePin':
        return Boolean(callbacks.onTogglePin);
      case 'toggleCloudContinuity':
        return Boolean(callbacks.onToggleCloudContinuity);
      case 'copyMarkdown':
        return Boolean(callbacks.onCopyMarkdown);
      case 'exportMarkdown':
        return Boolean(callbacks.onExportMarkdown);
      case 'copyLink':
        return Boolean(callbacks.onCopyLink);
      case 'shareConversation':
        return Boolean(callbacks.onShareConversation);
      case 'revealInSidebar':
        return Boolean(callbacks.onRevealInSidebar);
      case 'diagnose':
        return Boolean(callbacks.onDiagnose);
      case 'exportLogs':
        return Boolean(callbacks.onExportLogs);
      default:
        return false;
    }
  });
}

/**
 * Execute an action with the appropriate callback.
 */
export function executeAction(
  actionId: SessionMenuActionId,
  context: SessionMenuContext,
  callbacks: SessionMenuCallbacks,
  event: ReactMouseEvent<HTMLButtonElement>
): void {
  switch (actionId) {
    case 'rename':
      callbacks.onRename?.(context.sessionId, context.sessionTitle);
      break;
    case 'findSimilar':
      callbacks.onFindSimilar?.(context.sessionId);
      break;
    case 'moveToFolder':
      callbacks.onMoveToFolder?.(context.sessionId, event);
      break;
    case 'removeFromFolder':
      callbacks.onRemoveFromFolder?.(context.sessionId);
      break;
    case 'delete':
      callbacks.onDelete?.(context.sessionId, event);
      break;
    case 'toggleStar':
      callbacks.onToggleStar?.(context.sessionId, event);
      break;
    case 'togglePin':
      callbacks.onTogglePin?.(context.sessionId, event);
      break;
    case 'toggleCloudContinuity':
      callbacks.onToggleCloudContinuity?.(context.sessionId, event);
      break;
    case 'copyMarkdown':
      callbacks.onCopyMarkdown?.(context.sessionId);
      break;
    case 'exportMarkdown':
      callbacks.onExportMarkdown?.(context.sessionId);
      break;
    case 'copyLink':
      callbacks.onCopyLink?.(context.sessionId);
      break;
    case 'shareConversation':
      callbacks.onShareConversation?.(context.sessionId);
      break;
    case 'revealInSidebar':
      callbacks.onRevealInSidebar?.(context.sessionId);
      break;
    case 'diagnose':
      callbacks.onDiagnose?.(context.sessionId);
      break;
    case 'exportLogs':
      callbacks.onExportLogs?.(context.sessionId);
      break;
  }
}
