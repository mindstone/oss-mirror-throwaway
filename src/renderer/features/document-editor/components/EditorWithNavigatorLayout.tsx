import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { EditorKioskLevel } from '../hooks/useEditorKiosk';
import styles from './EditorWithNavigatorLayout.module.css';

type EditorWithNavigatorLayoutClassNames = {
  splitLayout?: string;
  navigatorPane?: string;
  resizeHandle?: string;
  editorPane?: string;
};

export type EditorWithNavigatorLayoutProps = {
  /** Slot for the file navigator. Pass null to hide the navigator pane entirely. */
  navigator: ReactNode | null;
  /** Slot for the editor. Required. */
  editor: ReactNode;
  /** Optional ref forwarded to the layout container. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Whether the editor has documents open. Drives layout proportions. */
  editorHasDocuments: boolean;
  /** Current focus/kiosk level. */
  kioskLevel: EditorKioskLevel;
  /** Navigator pane width as a percent of container (used in 'off' default split). */
  navigatorWidthPercent: number;
  /** Navigator rail width as a percent of container in wide focus mode. */
  focusNavigatorWidthPercent: number;
  /** Whether the editor is in floating mode. */
  floatingEditorMode: boolean;
  /** Whether a resize drag is in progress (drives cursor/select styles). */
  isResizing: boolean;
  /** Handlers for the inner resize handle between navigator and editor. */
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  onResizeDoubleClick: (event: ReactMouseEvent) => void;
  onResizeContextMenu: (event: ReactMouseEvent) => void;
  /** Optional test id for the outer container. Defaults to 'editor-with-navigator-layout'. */
  testId?: string;
  /** Optional test id for the navigator pane wrapper. */
  navigatorTestId?: string;
  /** Optional test id for the resize handle. Defaults to 'editor-navigator-resize-handle'. */
  resizeHandleTestId?: string;
  /**
   * Optional slot class overrides used by host surfaces that need extra
   * surface-specific CSS hooks (for example floating editor mode overrides).
   */
  classNames?: EditorWithNavigatorLayoutClassNames;
};

export function EditorWithNavigatorLayout({
  navigator,
  editor,
  containerRef,
  editorHasDocuments,
  kioskLevel,
  navigatorWidthPercent,
  focusNavigatorWidthPercent,
  floatingEditorMode,
  isResizing,
  onResizeMouseDown,
  onResizeDoubleClick,
  onResizeContextMenu,
  testId,
  navigatorTestId,
  resizeHandleTestId,
  classNames,
}: EditorWithNavigatorLayoutProps) {
  const showNavigatorPane = navigator !== null && (!editorHasDocuments || kioskLevel !== 'zen');
  const showResizeHandle = navigator !== null
    && editorHasDocuments
    && (kioskLevel === 'off' || kioskLevel === 'wide');

  const navigatorWidthPct = kioskLevel === 'wide'
    ? focusNavigatorWidthPercent
    : navigatorWidthPercent;

  const navigatorStyle = editorHasDocuments
    && (
      kioskLevel === 'wide'
      || (kioskLevel === 'off' && !floatingEditorMode)
    )
    ? { flex: `0 0 ${navigatorWidthPct}%` }
    : undefined;

  return (
    <div
      ref={containerRef}
      className={cn(styles.splitLayout, classNames?.splitLayout)}
      data-testid={testId ?? 'editor-with-navigator-layout'}
      data-editor-open={editorHasDocuments}
      data-resizing={isResizing}
      data-focus-mode={kioskLevel !== 'off'}
      data-kiosk-level={kioskLevel}
    >
      {showNavigatorPane && (
        <div
          className={cn(styles.navigatorPane, classNames?.navigatorPane)}
          style={navigatorStyle}
          data-testid={navigatorTestId ?? 'editor-navigator-pane'}
        >
          {navigator}
        </div>
      )}
      {editorHasDocuments ? (
        <>
          {showResizeHandle && (
            <div
              className={cn(styles.resizeHandle, classNames?.resizeHandle)}
              data-resizing={isResizing}
              onMouseDown={onResizeMouseDown}
              onDoubleClick={onResizeDoubleClick}
              onContextMenu={onResizeContextMenu}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor panels"
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              data-testid={resizeHandleTestId ?? 'editor-navigator-resize-handle'}
            >
              <GripVertical
                className={styles.resizeHandleGrip}
                size={14}
                aria-hidden
                focusable="false"
              />
            </div>
          )}
          <div className={cn(styles.editorPane, classNames?.editorPane)}>
            {editor}
          </div>
        </>
      ) : null}
    </div>
  );
}
