---
description: "Native-style context menu guidance — target actions, layout, dismissal, keyboard navigation, selection snapshot resilience"
last_updated: "2026-04-27"
---

# UI Context Menus

Guidelines for implementing native-style context menus in Mindstone Rebel.


## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) - Overall UI layout and interaction patterns
- [UI_CSS_ARCHITECTURE.md](UI_CSS_ARCHITECTURE.md) - Design tokens and theming; new context menus should follow token conventions
- `src/renderer/features/agent-session/components/TextSelectionMenu.tsx` - Chat text selection with Copy, Reply, Add Comment, Copy Link
- `src/renderer/components/ImageContextMenu.tsx` - Image context menu (Copy Image, Save Image As)
- `src/renderer/components/LinkContextMenu.tsx` - Library/workspace link context menu

## When to Use Context Menus

Use a context menu when:
- The user needs actions related to a **specific target** (selected text, image, item)
- The actions are **secondary** - not the primary way to interact
- The user expects native desktop behavior (right-click)

Do NOT use context menus for:
- Primary actions (use buttons instead)
- Global actions (use the menu bar or command palette)
- Actions that need complex input (use a dialog or popover)

## Design Pattern

### Trigger
- **Right-click** (contextmenu event) for most desktop contexts
- Menu appears at **mouse cursor position**, not above/below the target
- Prevent default browser context menu with `e.preventDefault()`

### Layout
- **Vertical list** of actions (not horizontal toolbar)
- Each item: icon (14px) + label
- Single-column, consistent width

### Dismiss Behavior
- Click outside → dismiss
- Scroll → dismiss
- Escape key → dismiss
- Action click → execute and dismiss

### Keyboard Navigation
- **Up/Down arrows** to navigate between items
- **Enter** to execute focused action
- **Escape** to close

## Reference Implementations

### Chat Text Selection Menu
`src/renderer/features/agent-session/components/TextSelectionMenu.tsx`
- Right-click on selected text in chat messages (user, assistant, or result roles)
- Actions: Copy, Reply, Add Comment (Add Comment only for assistant/result messages)
- When right-clicking on a link: includes Copy Link action
- Supports generic containers via `data-selectable-content` attribute (see below)

### Library Text Selection Menu
`src/renderer/features/agent-session/components/TextSelectionMenu.tsx`
- Mouseup on selected text in editor (CodeMirror integration)
- Actions: Add Comment

### Image Context Menu
`src/renderer/components/ImageContextMenu.tsx`
- Right-click on images in messages
- Actions: Copy Image, Save Image As

### Link Context Menu
`src/renderer/components/LinkContextMenu.tsx`
- Right-click on `rebel://library/` links (and legacy `library://` / `workspace://` for back-compat)
- Actions: Open in Document Preview, Open in Library, Copy relative path, Copy full path, Reveal in file explorer, Open in external app, Copy Rebel link (canonical `rebel://library/…`), Copy web link (when cloud is configured)

## Selection Snapshot Resilience (TextSelectionMenu)

The chat `TextSelectionMenu` captures a **selection snapshot** on right-mousedown so the menu can still show selection actions even if the browser collapses the live selection between `mousedown` and `contextmenu` (CodeMirror, ProseMirror, and certain React re-renders all do this).

**Stability contract (REBEL-4ZV / FOX-3174 — third regression in this area):** the snapshot MUST contain only **immutable primitives** — no live `HTMLElement` references. Storing a stale element invites two failure modes:

1. **Stale-element containment check.** If the source DOM is replaced between mousedown and contextmenu (React remount, virtualizer recycle), `snapshot.containerElement.contains(target)` returns false against a detached node and the snapshot is dropped — collapsing the user's selection.
2. **Stale-element querySelector.** Calling `.querySelector('[data-message-body]')` on a detached node returns null, breaking annotation offset computation.

**Current shape (`TextSelectionMenu.tsx`'s `SelectionSnapshot`):**

- `kind: 'message' | 'generic'`
- For `'message'`: `messageId`, `role`, plus pre-computed `messageSelection` (text, offsets, rect, surrounding context).
- For `'generic'`: `documentPath`, `allowedActions`, plus pre-computed `genericSelection` offsets.

At contextmenu time, `resolveSnapshotContainer()` re-queries the live DOM by `data-message-id` (with `CSS.escape`) or `data-document-path`. Generic snapshots without a `documentPath` are **dropped** rather than risk aliasing across two unrelated editor instances. `containerOwnsTarget()` does an identity-based fallback (compare `messageId` / `documentPath`) when `element.contains()` fails — handles the case where the user right-clicks on a deeply-nested portal child or a remounted-but-equivalent container.

**Anti-patterns to avoid:**

- ❌ `snapshot.containerElement: HTMLElement` — invites stale-DOM bugs. Use IDs that re-resolve from live DOM.
- ❌ Live `Range` objects in the snapshot — collapse on selection change. Pre-compute offsets and rect at mousedown.
- ❌ Falling back to `candidates[0]` when the source generic container has no documentPath — silently aliases unrelated editors.

**Tests:** behavioural tests for snapshot resilience would dispatch real `mousedown` (button=2) + `contextmenu` events with the message DOM replaced between them. (None exist yet — see [`docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md`](../../docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md) for prior incidents and prevention strategy.)


## Selectable Content Opt-In

Document viewers and other containers can enable context menu support via the `data-selectable-content` attribute:

```html
<div data-selectable-content="copy,reply,add-comment" data-document-path="/path/to/doc.md">
  <!-- Content that supports text selection context menu -->
</div>
```

Supported action tokens: `copy`, `reply`, `add-comment`. Unknown tokens are ignored.


## CSS Pattern (Recommended)

New context menus should use design tokens from `tokens.css`. The following pattern is the recommended target:

```css
.contextMenu {
  position: fixed;
  z-index: var(--z-popover);
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: var(--space-xs);
  min-width: 140px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.contextMenuItem {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.contextMenuItem:hover,
.contextMenuItemFocused {
  background: var(--bg-hover);
}

.contextMenuIcon {
  color: var(--text-secondary);
  flex-shrink: 0;
}
```

**Note:** Existing implementations (`TextSelectionMenu.module.css`, `ImageContextMenu.module.css`, `LinkContextMenu.module.css`) may use hardcoded values. New context menus should prefer design tokens for consistency.

## Implementation Checklist

When creating a new context menu:

1. **Use createPortal** to render in `document.body` (avoids overflow clipping)
2. **Track click position** from the contextmenu event
3. **Clamp to viewport** - adjust position if menu would overflow edges
4. **Add dismiss handlers** for click-outside, scroll, and Escape
5. **Implement keyboard navigation** with up/down arrows and Enter
6. **Use consistent styling** from TextSelectionMenu.module.css
7. **Add role="menu"** and **role="menuitem"** for accessibility
8. **Add data-testid** attributes for E2E testing

## Action Guidelines

Context menus should provide actions that are contextually relevant and not easily discoverable through other means.

**Copy action:** Include Copy in text selection menus for convenience. While users can use Ctrl/Cmd+C, having Copy in the context menu provides discoverability and consistency with native apps.

**Link actions:** When right-clicking links, provide Copy Link. The `TextSelectionMenu` detects links via `data-href` or valid `href` attributes and shows Copy Link alongside any text selection actions.

**Specialized actions:** Reserve menu space for actions specific to the target (e.g., Reply, Add Comment for chat messages; Open in Library, Reveal in file explorer for workspace links).
