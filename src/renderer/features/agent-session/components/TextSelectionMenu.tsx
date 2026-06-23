/**
 * TextSelectionMenuLayer
 *
 * A self-contained layer that shows a native-style context menu on right-click
 * when text is selected within chat messages or document viewers, or when clicking on links.
 * Provides Copy, Ask Rebel in New Chat, Comment, and Copy Link actions in a vertical menu
 * matching macOS/Windows desktop conventions.
 *
 * IMPORTANT: This component manages its own state to avoid triggering re-renders
 * in parent components (which would collapse the browser selection).
 * It only calls back to App.tsx when the user actually clicks an action.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SELECTION-SNAPSHOT CONTRACT — DO NOT BREAK 🚨  (REBEL-4ZV / FOX-3174)
 *                                  …and previously: FOX-2159, 260224 incident
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * The `SelectionSnapshot` interface below MUST contain only IMMUTABLE
 * primitives — no live `HTMLElement`, no live `Range`, no `Selection`.
 *
 * Why: between `mousedown` and `contextmenu`, React can remount the markdown
 * subtree (any parent re-render before MessageMarkdown's stable-components
 * fix landed; virtualizer recycles for offscreen rows; theme / settings
 * cascades). A stale element reference then fails `element.contains(target)`
 * containment checks against a detached node, the snapshot is dropped, and
 * the user's right-click menu disappears.
 *
 * Use IDs (`messageId`, `documentPath`) that re-resolve from the live DOM.
 * `resolveSnapshotContainer()` and `containerOwnsTarget()` below handle the
 * re-resolution. `containerOwnsTarget` falls back to identity-based comparison
 * (matching messageId / documentPath) when `element.contains()` fails.
 *
 * Generic snapshots without `documentPath` are intentionally DROPPED rather
 * than aliased to "the first selectable container in the DOM" — two unrelated
 * editors rendered concurrently would otherwise cross-contaminate.
 *
 * This is the THIRD documented occurrence of selection collapse caused by
 * trusting a live DOM reference past a render boundary. See
 * `docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md`
 * and `docs/project/UI_CONTEXT_MENUS.md § Selection Snapshot Resilience`.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * UX: Shows on right-click (contextmenu) only, matching native desktop behavior.
 * The menu appears at the mouse cursor position, not above the selection.
 * This prevents the "selection keeps moving" issue (FOX-2159) where the menu
 * appearing on mouseup interfered with natural text selection.
 *
 * Link support: When right-clicking on a link, shows "Copy Link" option.
 * If there's also a text selection in a message, shows both link and selection options.
 * Link detection works app-wide via data-href attribute or valid href.
 *
 * Generic selectable content: Document viewers and other containers can opt-in to
 * context menu support by adding `data-selectable-content="copy,reply"` attribute.
 * This enables Copy/Ask Rebel without requiring full message context (no annotations).
 *
 * @see docs/project/UI_CONTEXT_MENUS.md for the context menu design pattern
 */

import { useEffect, useState, useCallback, useRef, useLayoutEffect, useMemo, type FC, memo } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, Copy, Link, SquarePen } from 'lucide-react';
import styles from './TextSelectionMenu.module.css';

export interface SelectionData {
  rect: DOMRect;
  messageId: string;
  text: string;
  textBefore: string;
  textAfter: string;
  /** Character offset from start of message body text content */
  startOffset: number;
  /** Character offset for end of selection (startOffset + text.length) */
  endOffset: number;
}

/**
 * Discriminated union for selection context.
 * - 'message': Selection within a chat message (supports full SelectionData; annotations only for assistant/result)
 * - 'generic': Selection within a data-selectable-content container (supports copy/ask rebel but no annotations)
 */
export type SelectionContext =
  | { kind: 'message'; selection: SelectionData; role: 'user' | 'assistant' | 'result' }
  | { kind: 'generic'; text: string; documentPath?: string; startOffset?: number };

/**
 * Allowed actions for generic selectable content containers.
 * Parsed from the `data-selectable-content` attribute.
 */
export type SelectableAction = 'copy' | 'reply' | 'add-comment';

/**
 * Parses the `data-selectable-content` attribute value into allowed actions.
 * Handles whitespace trimming, case-insensitive matching, and ignores unknown tokens.
 * @param attrValue The raw attribute value (e.g., "copy, Reply, add-comment")
 * @returns Set of allowed actions
 */
function parseSelectableContentAttr(attrValue: string | null): Set<SelectableAction> {
  const actions = new Set<SelectableAction>();
  if (!attrValue) return actions;

  const tokens = attrValue.split(',').map((t) => t.trim().toLowerCase());
  for (const token of tokens) {
    if (token === 'copy' || token === 'reply' || token === 'add-comment') {
      actions.add(token);
    }
    // Unknown tokens are silently ignored (defensive parsing)
  }
  return actions;
}

export interface TextSelectionMenuLayerProps {
  /** Whether the layer is enabled */
  enabled?: boolean;
  /** Callback when user clicks Ask Rebel - receives full selection context */
  onReply: (context: SelectionContext) => void;
  /** Callback when user clicks Ask Rebel in New Chat - receives full selection context */
  onReplyInNewChat?: (context: SelectionContext) => void;
  /** Callback when user clicks Add Comment on chat messages - receives full selection data */
  onComment: (selection: SelectionData) => void;
  /**
   * Callback when user clicks Add Comment on generic content (e.g., Library editor).
   * Only called for containers with `data-selectable-content` including "add-comment".
   * Receives selected text, optional document path, and an approximate selection offset.
   */
  onGenericAddComment?: (text: string, documentPath?: string, hintOffset?: number) => void;
  /** Optional toast callback for user feedback */
  showToast?: (options: { title: string }) => void;
  /** Callback when menu opens or closes - useful for pausing auto-scroll during streaming */
  onMenuOpenChange?: (isOpen: boolean) => void;
}

interface MenuState {
  /** Mouse click position for menu placement */
  clickX: number;
  clickY: number;
  /** Selection context for text actions (null if no valid selection) */
  selectionContext: SelectionContext | null;
  /** Allowed actions for generic selections (empty for message context = all allowed) */
  allowedActions: Set<SelectableAction>;
  /** Link URL for copy link action (null if not clicking a link) */
  linkUrl: string | null;
}

/** Menu action definition */
interface MenuAction {
  id: string;
  label: string;
  icon: FC<{ size: number; className: string }>;
  onClick: () => void;
  testId: string;
}

const preserveSelectionOnMouseDown = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

/**
 * Internal menu component - renders the native-style vertical context menu
 * Now supports dynamic actions based on what's available (link, selection, or both)
 */
interface InternalMenuProps {
  clickX: number;
  clickY: number;
  actions: MenuAction[];
  onClose: () => void;
}

const InternalMenu: FC<InternalMenuProps> = memo(({
  clickX,
  clickY,
  actions,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: clickX, y: clickY });
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Clamp menu position to viewport after render
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const padding = 8;
    let x = clickX;
    let y = clickY;
    // Prevent overflow on right
    if (x + rect.width + padding > viewportW) {
      x = Math.max(padding, viewportW - rect.width - padding);
    }
    // Prevent overflow on bottom
    if (y + rect.height + padding > viewportH) {
      y = Math.max(padding, viewportH - rect.height - padding);
    }
    setMenuPos(prev => (prev.x === x && prev.y === y ? prev : { x, y }));
  }, [clickX, clickY]);

  // Dismiss on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [onClose]);

  // Keyboard navigation - vertical menu uses up/down arrows
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => (prev === 0 ? actions.length - 1 : prev - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => (prev === actions.length - 1 ? 0 : prev + 1));
          break;
        case 'Enter':
          e.preventDefault();
          actions[focusedIndex]?.onClick();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [focusedIndex, onClose, actions]);

  return createPortal(
    <div
      ref={menuRef}
      className={styles.contextMenu}
      style={{ top: menuPos.y, left: menuPos.x }}
      role="menu"
      aria-label="Context menu"
      data-text-selection-menu
      data-testid="text-selection-menu"
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          type="button"
          className={`${styles.contextMenuItem} ${focusedIndex === index ? styles.contextMenuItemFocused : ''}`}
          onMouseDown={preserveSelectionOnMouseDown}
          onClick={action.onClick}
          role="menuitem"
          data-testid={action.testId}
        >
          <action.icon size={14} className={styles.contextMenuIcon} />
          <span className={styles.contextMenuLabel}>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
});

InternalMenu.displayName = 'InternalMenu';

/**
 * Computes the character offset of a Range's start/end position within an element's text content.
 * Uses the browser's native Range API to compute offsets, which handles all container types
 * (Text nodes, Element nodes, mixed content) without manual TreeWalker traversal.
 */
function getSelectionOffsets(
  element: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number } | null {
  try {
    // Compute start offset: create a range from element start to selection start,
    // then measure its text length
    const preRange = document.createRange();
    preRange.selectNodeContents(element);
    preRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = preRange.toString().length;

    // Compute end offset: create a range from element start to selection end,
    // then measure its text length
    const endRange = document.createRange();
    endRange.selectNodeContents(element);
    endRange.setEnd(range.endContainer, range.endOffset);
    const endOffset = endRange.toString().length;

    if (endOffset > startOffset) {
      return { startOffset, endOffset };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Result from findSelectableContainer - either a message container or a generic selectable container.
 */
type SelectableContainerResult =
  | { kind: 'message'; element: HTMLElement; messageId: string; role: 'user' | 'assistant' | 'result' }
  | { kind: 'generic'; element: HTMLElement; allowedActions: Set<SelectableAction>; documentPath?: string };

/** Selectable elements use the data-message-id attribute for messages. */
const MESSAGE_ID_ATTR = 'data-message-id';

/**
 * Look up a fresh selectable container that matches a previously-captured
 * snapshot's identifiers. Resolves the container from the live DOM rather than
 * holding a stale HTMLElement reference, so React remounts of the markdown
 * subtree don't invalidate the snapshot.
 *
 * Returns null if the source container is no longer present in the DOM.
 */
function resolveSnapshotContainer(snapshot: {
  kind: 'message' | 'generic';
  messageId?: string;
  role?: 'user' | 'assistant' | 'result';
  allowedActions?: Set<SelectableAction>;
  documentPath?: string;
}): SelectableContainerResult | null {
  if (snapshot.kind === 'message' && snapshot.messageId && snapshot.role) {
    // Escape backslashes BEFORE quotes so we don't double-escape escape chars.
    const cssId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
      ? CSS.escape(snapshot.messageId)
      : snapshot.messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const element = document.querySelector<HTMLElement>(
      `[${MESSAGE_ID_ATTR}="${cssId}"]`,
    );
    if (!element) return null;
    return {
      kind: 'message',
      element,
      messageId: snapshot.messageId,
      role: snapshot.role,
    };
  }

  if (snapshot.kind === 'generic' && snapshot.allowedActions) {
    // Generic containers don't have a unique ID — only resolve via documentPath.
    // Without a documentPath we can't safely identify the source container, so
    // we drop the snapshot rather than risk aliasing two unrelated generic
    // editors (e.g. Library editor + Doc viewer rendered concurrently).
    if (!snapshot.documentPath) return null;
    const escapedPath = snapshot.documentPath
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    const match = document.querySelector<HTMLElement>(
      `[data-selectable-content][data-document-path="${escapedPath}"]`,
    );
    if (!match) return null;
    return {
      kind: 'generic',
      element: match,
      allowedActions: new Set(snapshot.allowedActions),
      documentPath: snapshot.documentPath,
    };
  }

  return null;
}

/**
 * Identity-based containment check that survives React remounts. Re-resolves
 * the target's selectable container from the live DOM and compares its
 * messageId / documentPath against the supplied container.
 */
function containerOwnsTarget(container: SelectableContainerResult, target: Node): boolean {
  if (container.element.contains(target)) return true;

  const targetContainer = findSelectableContainer(target);
  if (!targetContainer) return false;
  if (container.kind === 'message' && targetContainer.kind === 'message') {
    return container.messageId === targetContainer.messageId;
  }
  if (container.kind === 'generic' && targetContainer.kind === 'generic') {
    return (container.documentPath ?? null) === (targetContainer.documentPath ?? null);
  }
  return false;
}

/**
 * Finds the closest selectable container from a node.
 * First checks for existing `data-role` pattern for chat messages (full message context).
 * Then checks for new `data-selectable-content` attribute (generic context).
 */
function findSelectableContainer(node: Node | null): SelectableContainerResult | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      // First check for existing message pattern (user, assistant, or result roles)
      const role = current.getAttribute('data-role');
      const msgId = current.getAttribute('data-message-id');
      if ((role === 'user' || role === 'assistant' || role === 'result') && msgId) {
        return { kind: 'message', element: current, messageId: msgId, role: role as 'user' | 'assistant' | 'result' };
      }

      // Then check for new generic selectable content pattern
      const selectableContent = current.getAttribute('data-selectable-content');
      if (selectableContent !== null) {
        const allowedActions = parseSelectableContentAttr(selectableContent);
        const documentPath = current.getAttribute('data-document-path') ?? undefined;
        return { kind: 'generic', element: current, allowedActions, documentPath };
      }
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Checks if a URL is a meaningful link worth copying.
 * Excludes fragment-only anchors like "#" or "#section" since they're
 * not useful outside the current page context.
 */
function isMeaningfulUrl(url: string | null): boolean {
  if (!url) return false;
  // Skip fragment-only links (e.g., "#", "#top", "#section-1")
  if (url.startsWith('#')) return false;
  return true;
}

/**
 * Finds the closest link element from a node and extracts its URL.
 * Checks data-href first (for internal links that use href="#"),
 * then falls back to href attribute. Skips fragment-only anchors.
 */
function findLinkUrl(node: Node | null): string | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLAnchorElement) {
      // Prefer data-href (set by MessageMarkdown for internal links)
      const dataHref = current.getAttribute('data-href');
      if (isMeaningfulUrl(dataHref)) {
        return dataHref;
      }
      // Fall back to href
      const href = current.getAttribute('href');
      if (isMeaningfulUrl(href)) {
        return href;
      }
      return null;
    }
    current = current.parentNode;
  }
  return null;
}

function hasSpecializedResourceMenu(linkUrl: string): boolean {
  const normalized = linkUrl.toLowerCase();
  return (
    normalized.startsWith('library://') ||
    normalized.startsWith('workspace://') ||
    normalized.startsWith('rebel://library/') ||
    normalized.startsWith('rebel://space/')
  );
}

/**
 * Main layer component - handles right-click context menu for text selection and links.
 * Shows "Copy Link" when clicking on a link, and text selection options (Copy, Ask Rebel, 
 * Add Comment) when there's a selection in a message. Shows both when applicable.
 * Owns its own state to avoid re-rendering parent components.
 */
const TextSelectionMenuLayerComponent: FC<TextSelectionMenuLayerProps> = ({
  enabled = true,
  onReply: _onReply,
  onReplyInNewChat,
  onComment,
  onGenericAddComment,
  showToast,
  onMenuOpenChange,
}) => {
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  // Track if menu is showing (for use in event handlers that can't access state)
  const isMenuShowingRef = useRef(false);

  // Keep ref in sync with state (for use in event handlers)
  // useLayoutEffect ensures ref is updated before browser paint, preventing
  // race conditions where scroll events could slip through before ref is set
  useLayoutEffect(() => {
    const isOpen = menuState !== null;
    isMenuShowingRef.current = isOpen;
    onMenuOpenChange?.(isOpen);
  }, [menuState, onMenuOpenChange]);

  // Helper to cleanly close the menu and clear browser selection
  const closeMenuAndClearSelection = useCallback(() => {
    setMenuState(null);
    // Clear browser selection so it doesn't look weird after action
    window.getSelection()?.removeAllRanges();
  }, []);

  // Build actions based on current menu state
  const actions = useMemo((): MenuAction[] => {
    if (!menuState) return [];

    const result: MenuAction[] = [];
    const { selectionContext, allowedActions, linkUrl } = menuState;

    // Add "Copy Link" if we have a link URL
    if (linkUrl) {
      result.push({
        id: 'copy-link',
        label: 'Copy Link',
        icon: Link,
        onClick: () => {
          navigator.clipboard.writeText(linkUrl).then(
            () => showToast?.({ title: 'Link copied to clipboard' }),
            () => showToast?.({ title: 'Failed to copy link' })
          );
          closeMenuAndClearSelection();
        },
        testId: 'context-menu-copy-link',
      });
    }

    // Add selection actions if we have a valid selection context
    if (selectionContext) {
      const text = selectionContext.kind === 'message' ? selectionContext.selection.text : selectionContext.text;
      
      // Copy - always available for selections
      // For message context, always show; for generic, check allowedActions
      if (selectionContext.kind === 'message' || allowedActions.has('copy')) {
        result.push({
          id: 'copy',
          label: 'Copy',
          icon: Copy,
          onClick: () => {
            navigator.clipboard.writeText(text).catch(() => {
              // Silently fail - user can try Cmd/Ctrl+C as fallback
            });
            closeMenuAndClearSelection();
          },
          testId: 'text-selection-copy',
        });
      }

      // Ask Rebel in New Chat - for message context always show, for generic check allowedActions
      if ((selectionContext.kind === 'message' || allowedActions.has('reply')) && onReplyInNewChat) {
        result.push({
          id: 'reply-new-chat',
          label: 'Ask Rebel in New Chat',
          icon: SquarePen,
          onClick: () => {
            onReplyInNewChat(selectionContext);
            closeMenuAndClearSelection();
          },
          testId: 'text-selection-reply-new-chat',
        });
      }

      // Add Comment for chat messages (assistant/result only - requires annotation support)
      if (selectionContext.kind === 'message' && selectionContext.role !== 'user') {
        result.push({
          id: 'comment',
          label: 'Add Comment',
          icon: MessageSquarePlus,
          onClick: () => {
            onComment(selectionContext.selection);
            closeMenuAndClearSelection();
          },
          testId: 'text-selection-comment',
        });
      }

      // Add Comment for generic content (e.g., Library editor) - requires add-comment in allowedActions
      // IMPORTANT: Don't clear browser selection for generic add-comment, as it would collapse
      // the CodeMirror selection before the event handler can capture it
      if (selectionContext.kind === 'generic' && allowedActions.has('add-comment') && onGenericAddComment) {
        result.push({
          id: 'comment',
          label: 'Add Comment',
          icon: MessageSquarePlus,
          onClick: () => {
            onGenericAddComment(selectionContext.text, selectionContext.documentPath, selectionContext.startOffset);
            // Just close menu, don't clear selection - let the handler use the selection
            setMenuState(null);
          },
          testId: 'text-selection-comment',
        });
      }
    }

    return result;
  }, [menuState, onReplyInNewChat, onComment, onGenericAddComment, showToast, closeMenuAndClearSelection]);

  const handleClose = useCallback(() => {
    closeMenuAndClearSelection();
  }, [closeMenuAndClearSelection]);

  /**
   * Snapshot of selection captured on right-mousedown (before editors can modify it).
   *
   * Stores ONLY immutable primitives — never raw HTMLElement references. React
   * can remount the markdown subtree between mousedown and contextmenu (e.g.
   * when a parent re-renders in response to focusTurn). A stale element
   * reference would then point at a detached DOM node, causing the
   * `element.contains(target)` containment check to drop the snapshot and
   * collapse the user's right-click selection.
   *
   * Fix B from `docs-private/investigations/260427_text_selection_unstable_v2.md`:
   * we identify the source container by `messageId` (or generic `documentPath`)
   * and re-resolve it from the live DOM at contextmenu time.
   */
  interface SelectionSnapshot {
    text: string;
    kind: 'message' | 'generic';
    /** Populated when kind === 'message'. */
    messageId?: string;
    /** Populated when kind === 'message'. */
    role?: 'user' | 'assistant' | 'result';
    /** Populated when kind === 'generic'. */
    allowedActions?: Set<SelectableAction>;
    /** Populated when kind === 'generic'. */
    documentPath?: string;
    /** Pre-computed message selection data (immutable primitives, no live Range objects) */
    messageSelection?: {
      messageId: string;
      text: string;
      textBefore: string;
      textAfter: string;
      startOffset: number;
      endOffset: number;
      rect: DOMRect;
      role: 'user' | 'assistant' | 'result';
    };
    genericSelection?: {
      startOffset: number;
      endOffset: number;
    };
  }
  const selectionSnapshotRef = useRef<SelectionSnapshot | null>(null);

  // Right-click context menu handler - shows menu for links and/or text selection
  // Uses capture phase to ensure we receive the event before editors can stop propagation
  useEffect(() => {
    if (!enabled) {
      setMenuState(null);
      return;
    }

    /**
     * Captures the current selection on right-mousedown (button === 2).
     * This is called BEFORE contextmenu fires, so we can preserve the selection
     * even if CodeMirror or other editors modify it.
     */
    const handleRightMouseDown = (e: MouseEvent) => {
      // Only capture on right-click
      if (e.button !== 2) return;

      selectionSnapshotRef.current = null;
      
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

      const text = selection.toString().trim();
      if (!text || text.length < 2) return;

      const range = selection.getRangeAt(0);
      const startContainer = range.startContainer;
      const endContainer = range.endContainer;

      // Find the closest selectable container
      const containerResult = findSelectableContainer(startContainer);
      if (!containerResult) return;

      const { element } = containerResult;
      // Validate both endpoints are within the container
      if (!element.contains(startContainer) || !element.contains(endContainer)) return;

      // Store the snapshot for use in handleContextMenu — primitives only,
      // no DOM references. The container is re-resolved at contextmenu time
      // via messageId / documentPath so React remounts can't invalidate us.
      const snapshot: SelectionSnapshot = containerResult.kind === 'message'
        ? {
            text,
            kind: 'message',
            messageId: containerResult.messageId,
            role: containerResult.role,
          }
        : {
            text,
            kind: 'generic',
            allowedActions: new Set(containerResult.allowedActions),
            documentPath: containerResult.documentPath,
          };

      // For message containers, pre-compute selection offsets while the selection is still valid.
      // The browser may collapse the selection between mousedown and contextmenu events,
      // so we capture immutable primitives here (no live Range objects).
      if (containerResult.kind === 'message') {
        const messageBody = element.querySelector('[data-message-body]');
        if (messageBody && messageBody.contains(range.startContainer) && messageBody.contains(range.endContainer)) {
          const offsets = getSelectionOffsets(messageBody as HTMLElement, range);
          if (offsets) {
            const fullText = messageBody.textContent || '';
            const textBefore = fullText.slice(Math.max(0, offsets.startOffset - 50), offsets.startOffset);
            const textAfter = fullText.slice(offsets.endOffset, offsets.endOffset + 50);
            const rect = range.getBoundingClientRect();

            snapshot.messageSelection = {
              messageId: containerResult.messageId,
              text,
              textBefore,
              textAfter,
              startOffset: offsets.startOffset,
              endOffset: offsets.endOffset,
              rect: DOMRect.fromRect(rect), // snapshot the rect as immutable copy
              role: containerResult.role,
            };
          }
        }
      } else {
        const offsets = getSelectionOffsets(element, range);
        if (offsets) {
          snapshot.genericSelection = offsets;
        }
      }

      selectionSnapshotRef.current = snapshot;
    };

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as Node;
      
      // Check if clicking on a link (works app-wide)
      const linkUrl = findLinkUrl(target);
      
      // Check for text selection in a selectable container
      let selectionContext: SelectionContext | null = null;
      let allowedActions = new Set<SelectableAction>();
      
      // Try to get current selection first
      const selection = window.getSelection();
      let text = '';
      let containerElement: HTMLElement | null = null;
      let containerResult: SelectableContainerResult | null = null;
      
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const currentText = selection.toString().trim();
        if (currentText && currentText.length >= 2) {
          const range = selection.getRangeAt(0);
          const startContainer = range.startContainer;
          const endContainer = range.endContainer;
          
          const result = findSelectableContainer(startContainer);
          if (result && result.element.contains(startContainer) && result.element.contains(endContainer)) {
            text = currentText;
            containerElement = result.element;
            containerResult = result;
          }
        }
      }
      
      // Fall back to snapshot if current selection is gone but we captured one on mousedown.
      // The snapshot stores only IDs, not DOM refs — re-resolve a fresh container
      // each time so we're resilient to React remounting the markdown subtree
      // between mousedown and contextmenu.
      const snapshot = selectionSnapshotRef.current;
      if (!text && snapshot) {
        const freshContainer = resolveSnapshotContainer(snapshot);
        if (freshContainer) {
          text = snapshot.text;
          containerElement = freshContainer.element;
          containerResult = freshContainer;
        }
      }

      // Containment check: drop the snapshot if the right-click moved to an
      // unrelated container. Use messageId / documentPath identity rather than
      // raw element comparison so a remounted-but-equivalent container is
      // still considered the same.
      if (containerElement && containerResult && !containerOwnsTarget(containerResult, target)) {
        text = '';
        containerElement = null;
        containerResult = null;
      }

      // Clear snapshot after use
      selectionSnapshotRef.current = null;

      // Build selection context if we have valid selection data
      if (text && containerResult && containerElement) {
        if (containerResult.kind === 'message') {
          // Message context: try to compute offsets for annotation support
          const messageBody = containerElement.querySelector('[data-message-body]');
          const currentSelection = window.getSelection();
          
          // Try to create full message context with offsets (needed for Add Comment)
          let createdMessageContext = false;
          if (messageBody && currentSelection && !currentSelection.isCollapsed && currentSelection.rangeCount > 0) {
            const range = currentSelection.getRangeAt(0);
            if (messageBody.contains(range.startContainer) && messageBody.contains(range.endContainer)) {
              const offsets = getSelectionOffsets(messageBody as HTMLElement, range);
              if (offsets) {
                const fullText = messageBody.textContent || '';
                const textBefore = fullText.slice(Math.max(0, offsets.startOffset - 50), offsets.startOffset);
                const textAfter = fullText.slice(offsets.endOffset, offsets.endOffset + 50);
                const rect = range.getBoundingClientRect();

                selectionContext = {
                  kind: 'message',
                  selection: {
                    rect,
                    messageId: containerResult.messageId,
                    text,
                    textBefore,
                    textAfter,
                    startOffset: offsets.startOffset,
                    endOffset: offsets.endOffset,
                  },
                  role: containerResult.role,
                };
                createdMessageContext = true;
              }
            }
          }
          
          // Fallback: if we have text (from snapshot) but couldn't compute offsets from
          // the live selection, check if the snapshot has pre-computed message selection data
          if (!createdMessageContext && text) {
            if (snapshot?.messageSelection) {
              // Use pre-computed data from handleRightMouseDown (captured before browser collapsed selection)
              const ms = snapshot.messageSelection;
              selectionContext = {
                kind: 'message',
                selection: {
                  rect: ms.rect,
                  messageId: ms.messageId,
                  text: ms.text,
                  textBefore: ms.textBefore,
                  textAfter: ms.textAfter,
                  startOffset: ms.startOffset,
                  endOffset: ms.endOffset,
                },
                role: ms.role,
              };
            } else {
              // No snapshot data available — show Copy/Ask Rebel as generic context (without Add Comment)
              selectionContext = {
                kind: 'generic',
                text,
                // No documentPath for chat messages
              };
              // Enable copy and reply for this fallback
              allowedActions = new Set(['copy', 'reply'] as SelectableAction[]);
            }
          }
        } else {
          // Generic context: preserve an approximate start offset so repeated text
          // can be resolved back to the correct document range if the live
          // ProseMirror selection collapses before the comment handler runs.
          if (containerResult.allowedActions.size > 0) {
            const currentSelection = window.getSelection();
            let startOffset = snapshot?.genericSelection?.startOffset;

            if (currentSelection && !currentSelection.isCollapsed && currentSelection.rangeCount > 0) {
              const range = currentSelection.getRangeAt(0);
              if (containerElement.contains(range.startContainer) && containerElement.contains(range.endContainer)) {
                startOffset = getSelectionOffsets(containerElement, range)?.startOffset ?? startOffset;
              }
            }

            selectionContext = {
              kind: 'generic',
              text,
              documentPath: containerResult.documentPath,
              startOffset,
            };
            allowedActions = containerResult.allowedActions;
          }
        }
      }

      // If we have neither a link nor a valid selection, let native context menu show
      if (!linkUrl && !selectionContext) {
        return;
      }

      // File/resource links have their own richer context menu (open in Library,
      // reveal in file explorer, copy path, etc.). Let the link-level handler own
      // plain right-clicks, while still allowing selection actions when text is selected.
      if (linkUrl && hasSpecializedResourceMenu(linkUrl) && !selectionContext) {
        return;
      }

      // Show our context menu
      e.preventDefault();

      setMenuState({
        clickX: e.clientX,
        clickY: e.clientY,
        selectionContext,
        allowedActions,
        linkUrl,
      });
    };

    // Dismiss menu on left-click outside
    const handleMouseDown = (e: MouseEvent) => {
      if (!isMenuShowingRef.current) return;
      
      // Don't dismiss if clicking inside the menu
      const target = e.target as HTMLElement;
      if (target.closest('[data-text-selection-menu]')) {
        return;
      }
      if (target.closest('[data-annotation-popover]')) {
        return;
      }

      // Left-click outside menu - dismiss it
      if (e.button === 0) {
        setMenuState(null);
      }
    };

    // Use capture phase to ensure we receive events before editors can stop propagation
    document.addEventListener('mousedown', handleRightMouseDown, { capture: true });
    document.addEventListener('contextmenu', handleContextMenu, { capture: true });
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('mousedown', handleRightMouseDown, { capture: true });
      document.removeEventListener('contextmenu', handleContextMenu, { capture: true });
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [enabled]);

  /**
   * Scroll blocking effect - ONLY runs when menu is open.
   * 
   * IMPORTANT: These listeners use `passive: false` which forces scroll handling
   * onto the main thread. We MUST only attach them when the menu is actually open.
   * Attaching them globally would degrade scroll smoothness during streaming,
   * as all scroll events would compete with React rendering on the main thread.
   * 
   * @see docs/plans/finished/260110_scroll_render_architecture_analysis.md
   */
  useEffect(() => {
    // Only attach scroll-blocking listeners when menu is open
    if (!menuState) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't block keystrokes aimed at editable elements (textareas, inputs, contenteditable)
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        target.isContentEditable
      ) {
        return;
      }
      // Block keyboard scrolling while menu is open
      const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
      if (scrollKeys.includes(e.key)) {
        e.preventDefault();
      }
    };

    // Attach with passive: false to allow preventDefault
    // These are ONLY attached while menu is open to preserve compositor scrolling otherwise
    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    window.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
      window.removeEventListener('touchmove', handleTouchMove, { capture: true });
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [menuState]);

  if (!menuState || actions.length === 0) {
    return null;
  }

  return (
    <InternalMenu
      clickX={menuState.clickX}
      clickY={menuState.clickY}
      actions={actions}
      onClose={handleClose}
    />
  );
};

TextSelectionMenuLayerComponent.displayName = 'TextSelectionMenuLayer';

export const TextSelectionMenuLayer = memo(TextSelectionMenuLayerComponent);
