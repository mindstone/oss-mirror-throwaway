/**
 * Gate for `UnifiedDocumentEditor`'s window-level keyboard-shortcut listener.
 *
 * The listener is registered in capture phase (so it can intercept Cmd+S/E
 * etc. before editor inputs), which has a side-effect: when a nested
 * dialog-style modal is open, Escape and Cmd-shortcuts would fire against the
 * editor before the dialog's own handler, breaking user intent (e.g. Escape
 * closing the whole editor instead of just the GoTo dialog).
 *
 * This predicate captures the intent: "is the editor-level shortcut handler
 * the right place to handle this event, given current editor state?"
 *
 * In-surface UI (`showFindBar`, `isImageExpanded`) is NOT a modal — its Escape
 * handling lives inside the same editor listener below this gate, so those
 * booleans are intentionally excluded.
 */
export interface EditorShortcutGateState {
  showGoToHeading: boolean;
  showSkillHistory: boolean;
}

export const shouldHandleEditorShortcut = (
  state: EditorShortcutGateState,
): boolean => !(state.showGoToHeading || state.showSkillHistory);
