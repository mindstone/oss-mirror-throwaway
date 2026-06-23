---
description: "Keyboard shortcut implementation guide — Electron menus, global shortcuts, useGlobalHotkey, editable-surface handling, and call sites"
last_updated: "2026-06-06"
---

# Keyboard Shortcuts Implementation

Internal documentation for keyboard shortcut implementation in Mindstone Rebel.

**For the list of available shortcuts**, see the canonical user-facing reference:
- [keyboard-shortcuts-and-hotkeys.md](../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md) — All shortcuts and customization options

## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) - High-level UI layout and interaction patterns
- [docs/plans/finished/251212_keyboard_shortcuts_feature.md](../plans/finished/251212_keyboard_shortcuts_feature.md) - Original planning doc
- [docs/plans/260505_hotkeys_contenteditable_regression_fix.md](../plans/260505_hotkeys_contenteditable_regression_fix.md) - Why `useGlobalHotkey` exists (TipTap contenteditable regression)
- [docs/plans/obsolete/251226_command_palette_action_registry.md](../plans/obsolete/251226_command_palette_action_registry.md) - **Planned**: Action Registry to centralize shortcuts and enable command palette
- [SCRATCHPAD.md](SCRATCHPAD.md) - Scratchpad quick-capture feature (⌘/Ctrl+Shift+N)
- [GLOBAL_HOTKEY.md](GLOBAL_HOTKEY.md) - Global voice activation hotkey architecture and implementation
- `src/renderer/hooks/useGlobalHotkey.ts` - Canonical wrapper for global app shortcuts; the only allowed consumer of bare `useHotkeys`
- `src/renderer/hooks/usePinnedSessionNavigation.ts` - Ctrl+Tab / Ctrl+Shift+Tab pinned-session cycling

## Architecture

Three patterns for keyboard shortcuts:

| Pattern | Scope | Implementation | Use Case |
|---------|-------|----------------|----------|
| **Electron Menu** | Native OS menu bar | `src/main/index.ts` | Fullscreen, zoom, edit operations |
| **Electron globalShortcut** | System-wide (works when app unfocused) | `src/main/services/voiceHotkeyService.ts` | Voice activation hotkey |
| **react-hotkeys-hook** (via `useGlobalHotkey`) | Renderer process (in-app) | `useGlobalHotkey()` wrapper hook | App-specific shortcuts |
| **Native `addEventListener`** | Renderer process (in-app) | `window.addEventListener('keydown', ...)` | Context-specific shortcuts that should be inert in editable surfaces (e.g., inbox, dialog Esc) |

> ### Why `useGlobalHotkey` and not bare `useHotkeys`?
>
> `react-hotkeys-hook` v5 treats `enableOnFormTags` and `enableOnContentEditable` as **independent gates**. With only `enableOnFormTags: true`, hotkeys silently stop firing whenever focus is inside a `contenteditable` element — and Rebel's main composer (`TipTapPromptEditor`) and document editor (`UnifiedDocumentEditor`, `TipTapMarkdownEditor`) are TipTap-rendered contenteditable surfaces. Six shortcuts silently broke when the composer migrated to TipTap (commit `967f0b058`, 2026-04-29) before the regression was diagnosed.
>
> `useGlobalHotkey` bakes in the canonical options `{ preventDefault: true, enableOnFormTags: true, enableOnContentEditable: true }` so all global shortcuts behave consistently. An ESLint `no-restricted-imports` rule (`eslint.config.mjs`) blocks direct `useHotkeys` imports outside the wrapper. `HotkeysProvider` remains importable for `src/renderer/main.tsx`.
>
> Use **bare native `addEventListener` + an `isEditableElement` guard** (see `useInboxKeyboardShortcuts.ts`) when a shortcut SHOULD be inert in editable surfaces. Document the intent at the call site.

### Electron Application Menu

The native menu is set up in `src/main/index.ts` after window creation. It provides:
- **Edit menu**: Cut/Copy/Paste/Undo/Redo (required for text fields to work properly)
- **View menu**: Toggle fullscreen (Ctrl+Cmd+F on Mac, F11 on Windows/Linux), zoom controls
- **Window menu**: Minimize, zoom, close
- **Help menu**: Link to Mindstone help

Using Electron's built-in `role` properties automatically binds the correct platform-specific accelerators.

### Library: react-hotkeys-hook

- **Version**: ^5.2.3 (resolves 5.2.4 in lockfile; check `package.json` for current)
- **NPM**: [react-hotkeys-hook](https://www.npmjs.com/package/react-hotkeys-hook)
- **Docs**: [react-hotkeys-hook.vercel.app](https://react-hotkeys-hook.vercel.app/)
- **Direct `useHotkeys` use is blocked by ESLint** outside `src/renderer/hooks/useGlobalHotkey.ts`. Use the wrapper for global shortcuts. `HotkeysProvider` (mounted in `src/renderer/main.tsx`) remains importable.

Chosen for: React hooks API, built-in scopes, TypeScript support, 6M+ downloads, zero dependencies.

### Provider Setup

`HotkeysProvider` wraps the app in `src/renderer/main.tsx`:

```tsx
<HotkeysProvider initiallyActiveScopes={['*']}>
  <FlowPanelsProvider>
    <App />
  </FlowPanelsProvider>
</HotkeysProvider>
```

## Shortcut Implementation Locations

| Shortcut | Implementation | Notes |
|----------|----------------|-------|
| Ctrl+Cmd+F (Mac) / F11 | Electron Menu `role: 'togglefullscreen'` | Native OS shortcut |
| Cmd/Ctrl+Plus/Minus/0 | Electron Menu `role: 'zoomIn/Out/resetZoom'` | Native zoom controls |
| Cmd/Ctrl+C/V/X/Z | Electron Menu Edit submenu | Required for text fields |
| Ctrl+Alt+Space | Electron globalShortcut in `index.ts` | Configurable in Settings |
| Cmd/Ctrl+N | `useGlobalHotkey` in App.tsx | New chat |
| Cmd/Ctrl+O | `useGlobalHotkey` in App.tsx | Opens QuickOpenDialog (alias) |
| Cmd/Ctrl+P | `useGlobalHotkey` in App.tsx | Opens QuickOpenDialog |
| Cmd/Ctrl+\\ | `UnifiedDocumentEditor` keydown handler | Cycle Library focus mode (`off → wide → zen → off`) |
| Cmd/Ctrl+Shift+F | `UnifiedDocumentEditor` keydown handler | Hidden library-only alias for Cmd/Ctrl+\\ (muscle-memory back-compat) |
| Cmd/Ctrl+W | `UnifiedDocumentEditor` keydown handler | Close active document tab |
| Cmd/Ctrl+1..9 | `UnifiedDocumentEditor` keydown handler | Jump to document tab index |
| Cmd/Ctrl+Shift+N | `useGlobalHotkey` in App.tsx | Opens Scratchpad modal |
| Cmd/Ctrl+Shift+A | `useGlobalHotkey` in App.tsx | Library lens shortcut: `Show: Spaces` + `View as: Atlas` |
| Cmd/Ctrl+Enter | Capture-phase `addEventListener` in App.tsx | Context-sensitive: done (idle) or toggle auto-done (busy) |
| Ctrl+Tab / Shift+Ctrl+Tab | `useGlobalHotkey` in `usePinnedSessionNavigation.ts` | Cycle pinned sessions |
| Cmd/Ctrl+I | `useAppKeyboardShortcuts` (native listener) | Inbox toggle |
| Cmd/Ctrl+Up | `handleComposerKeyDown` | Context-specific |
| Alt/Option+Enter | `ComposerWithState.handleKeyDown` | Queues the message while busy (same as Enter). Send-now/interrupt is the **Send now** button only — no keyboard shortcut (changed 2026-06-06). |
| Enter | `handleComposerKeyDown` in App.tsx | Stop recording (when transcribing) |
| Escape | `useAppKeyboardShortcuts` in App.tsx | Exit voice mode (single) |
| Escape Escape | `useAppKeyboardShortcuts` in App.tsx | Stop running turn (double-ESC within 500ms) |
| Escape (Library editor, focus active) | `UnifiedDocumentEditor` keydown handler | Exit focus first; only then return to close-editor behavior |

For the full list of shortcuts with user-facing descriptions, see [keyboard-shortcuts-and-hotkeys.md](../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md).

## Implementation Notes

### Pinned Session Cycling

Located in `src/renderer/hooks/usePinnedSessionNavigation.ts`. Wired into App.tsx by `usePinnedSessionNavigation({ pinnedSessions, currentSessionId, onOpenSession })`:

```tsx
import { useGlobalHotkey } from './useGlobalHotkey';

useGlobalHotkey(
  'ctrl+tab',
  () => {
    if (pinnedSessions.length < 2) return;
    const currentIndex = pinnedSessions.findIndex((s) => s.id === currentSessionId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % pinnedSessions.length;
    const targetSession = pinnedSessions[nextIndex];
    if (targetSession && targetSession.id !== currentSessionId && hasNavigableContent(targetSession)) {
      onOpenSession(targetSession.id);
    }
  },
  [pinnedSessions, currentSessionId, onOpenSession]
);
```

**Why `useGlobalHotkey`:** the wrapper bakes in `enableOnContentEditable: true` so the shortcut fires even when the TipTap composer or document editor has focus. See the "Why `useGlobalHotkey`" callout above.

**Edge cases handled:**
- Fewer than 2 pinned sessions: no-op (early return).
- Current session not pinned: starts from first/last pinned.
- Target session has no navigable content (no messages, no draft, not history): no-op.

### Quick Open (Cmd/Ctrl+P, Cmd/Ctrl+O alias)

Located in `App.tsx` alongside other global shortcuts:

```tsx
import { useGlobalHotkey } from './hooks/useGlobalHotkey';

useGlobalHotkey(
  'mod+o',
  handleQuickOpenHotkey,
  [handleQuickOpenHotkey]
);

useGlobalHotkey(
  'mod+p',
  handleQuickOpenHotkey,
  [handleQuickOpenHotkey]
);
```

Opens the QuickOpenDialog for fast file navigation. The dialog supports:
- Lens-aligned filters (`Everything`, `Spaces`, `Skills`, `Memory`)
- Context-aware icons (wand for skills, brain for memory files)
- Keyboard navigation (arrows, enter, escape)

Selected files open in the Document Preview Drawer (for supported text files) or navigate to the Library (for folders/other files).

**UI entry point**: Search icon button in the header right area with tooltip showing the shortcut.

### Library editor focus cycle (Cmd/Ctrl+\\)

`UnifiedDocumentEditor` owns the in-editor focus cycle:

- `off` → normal Library split layout
- `wide` → focus document while keeping the file list visible
- `zen` → hide file list and keep only the document

Cycle shortcut:

- **User-visible:** `Cmd/Ctrl+\\`
- **Hidden alias (library only):** `Cmd/Ctrl+Shift+F` for back-compat muscle memory

Escape behavior:

- If focus is `wide` or `zen`, **Escape exits focus first**
- Once focus is `off`, Escape returns to normal close-editor behavior

### Voice Activation Hotkey (Ctrl+Alt+Space)

System-wide global shortcut that activates voice recording even when the app is unfocused.

See [GLOBAL_HOTKEY.md](GLOBAL_HOTKEY.md) for full architecture, event flow, and implementation details.

### Hook Ordering

`useGlobalHotkey` (and any hook that closes over derived state) must be placed AFTER all dependencies are defined:
- `pinnedFavorites` (useMemo)
- `currentSessionId` (from session engine)
- `handleOpenHistorySession` (useCallback)

Placing hooks before dependencies causes "Cannot access before initialization" errors.

## Settings UI

The Settings dialog surfaces shortcuts via `src/renderer/components/ShortcutsDialog.tsx` (opened with `Cmd/Ctrl+/`). When adding or renaming a shortcut, update that dialog. Older internal references to a `ShortcutsTab.tsx` file are stale; the file no longer exists.

## Adding New Shortcuts

**Checklist for AI agents and developers adding or modifying keyboard shortcuts:**

### 1. Check for conflicts

Before implementing, search for existing uses of the key combination:
- Grep for the key in `src/renderer/` (e.g., `escape`, `mod+n`, `ctrl+tab`)
- Check the "Shortcut Implementation Locations" table above
- Review common conflict points:
  - **ESC**: Used by dialogs, drawers, menus, voice mode, stop turn
  - **Mod+letter**: May conflict with OS or Electron Menu shortcuts
  - **Ctrl+Tab**: Reserved for session cycling on all platforms

If conflicts exist, implement priority logic (check drawer/dialog open state before triggering global action) or flag to the user for a decision.

### 2. Implement the shortcut

- **System-wide shortcuts** (work when app is unfocused): Use Electron `globalShortcut` in `src/main/index.ts`.
- **Global in-app shortcuts** (fire from anywhere, including composer/document editor): Use `useGlobalHotkey()` from `src/renderer/hooks/useGlobalHotkey.ts`. This is the default for app-wide accelerators (Cmd+N-style). Bare `useHotkeys` from `react-hotkeys-hook` is blocked by ESLint outside the wrapper.
- **Context-specific shortcuts** (should be inert when typing in editable surfaces — e.g., inbox navigation): Use a native `window.addEventListener('keydown', ...)` with an `isEditableElement(document.activeElement)` guard. See `src/renderer/features/inbox/hooks/useInboxKeyboardShortcuts.ts` for the canonical pattern.
- **Component-local shortcuts** (only fire while a specific element/dialog is mounted): Handle in the component's own `onKeyDown` handler.

### 3. Add tooltip to trigger UI element

If the shortcut has an associated button or control, add a tooltip showing the shortcut. See [TOOLTIPS.md](./TOOLTIPS.md) for guidelines.

```tsx
import { Tooltip } from '@renderer/components/ui';

<Tooltip content="Stop (Esc)" placement="top">
  <Button onClick={handleStop}>Stop</Button>
</Tooltip>
```

### 4. Update all shortcut references

Update these locations:

1. **User-facing docs**: [keyboard-shortcuts-and-hotkeys.md](../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md)
2. **Shortcuts overlay dialog**: `src/renderer/components/ShortcutsDialog.tsx` (opened via Cmd+/)
3. **Implementation table**: The "Shortcut Implementation Locations" table in this doc

## Platform Considerations

- **Ctrl+Tab**: Uses Ctrl on ALL platforms (Cmd+Tab is reserved for OS app switching on Mac)
- **Windows**: Some window managers may intercept Ctrl+Tab at OS level
- **Dev mode**: Ctrl+Tab may conflict with browser tab switching (not an issue in packaged app)

### Cmd+, (Settings) - Future Enhancement

Cmd+, is the standard macOS shortcut for "Preferences". It cannot be implemented via `react-hotkeys-hook` because macOS intercepts it before it reaches the renderer process.

Now that we have an Electron application menu, adding Cmd+, would require:
1. Adding a "Preferences" menu item with `accelerator: 'CmdOrCtrl+,'`
2. Creating an IPC channel to open settings from the main process
3. Handling the IPC in the renderer to navigate to settings

This is a straightforward enhancement now that the menu infrastructure exists.

## Error Handling Best Practices

Global hotkeys and keyboard shortcuts require defensive error handling to prevent app crashes - especially during startup when failures are "invisible" (no window yet).

### The Problem

1. **Registration failures**: `globalShortcut.register()` returns `false` if the shortcut is already in use by another app, but doesn't throw
2. **Async callbacks**: If the callback passed to `globalShortcut.register()` is async and throws, it becomes an unhandled promise rejection
3. **Window lifecycle**: Callbacks may fire after `webContents` is destroyed (during shutdown)

### Pattern: Non-Throwing Registration

Return a result object instead of throwing on failure:

```typescript
interface HotkeyRegistrationResult {
  success: boolean;
  registeredAccelerator: string | null;
  error?: string;
}

function applyVoiceActivationHotkey(accelerator: string | null): HotkeyRegistrationResult {
  // Deferred registration if app not ready
  if (!app.isReady()) {
    return { success: true, registeredAccelerator: null };
  }
  
  const registered = globalShortcut.register(accelerator, callback);
  if (!registered) {
    const errorMsg = `Shortcut "${accelerator}" may be in use by another application`;
    logger.warn({ accelerator }, errorMsg);
    return { success: false, registeredAccelerator: null, error: errorMsg };
  }
  
  return { success: true, registeredAccelerator: accelerator };
}
```

Callers then check the result and log/notify appropriately without crashing:

```typescript
const result = applyVoiceActivationHotkey(settings.voiceActivationHotkey);
if (!result.success) {
  logger.warn({ error: result.error }, 'Voice hotkey disabled');
  // App continues without the feature
}
```

### Pattern: Safe Async Callbacks

Wrap async callbacks to prevent unhandled rejections:

```typescript
// BAD: Unhandled rejection if emitVoiceActivationHotkey throws
globalShortcut.register(accelerator, emitVoiceActivationHotkey);

// GOOD: Sync wrapper catches and logs errors
globalShortcut.register(accelerator, () => {
  emitVoiceActivationHotkeyImpl().catch((err) => {
    logger.error({ err }, 'Voice activation hotkey callback failed');
  });
});
```

### Pattern: Window Lifecycle Guards

Check `webContents.isDestroyed()` before sending IPC messages from global shortcuts:

```typescript
async function emitVoiceActivationHotkeyImpl(): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) {
    logger.debug('Ignoring hotkey - window not available');
    return;
  }
  win.webContents.send('voice:activation-hotkey-pressed');
}
```

### Reference Implementation

See `src/main/services/voiceHotkeyService.ts` for the full implementation of these patterns.

## Future Improvements

- [ ] Add Cmd+, (Settings) shortcut via menu accelerator + IPC
- [ ] Add "Check for Updates" to Help menu
- [ ] Consolidate inline keyboard handlers to `useGlobalHotkey` (or, where editable-surface inertness is intended, the native `addEventListener` + `isEditableElement` pattern)
- [ ] Extract platform detection to shared utility
- [ ] Consider making more shortcuts configurable
