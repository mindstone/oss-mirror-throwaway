---
description: "Global voice activation hotkey architecture — Electron registration, screenshot capture, IPC flow, configuration, and recovery"
last_updated: "2026-04-28"
---

# Global Hotkey (Voice Activation)

System-wide keyboard shortcut that activates voice recording even when the app is unfocused or minimized. Automatically captures a screenshot of what the user was looking at.

## See Also

- [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) - All keyboard shortcuts and implementation patterns
- [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) - Voice recording and TTS pipeline
- [keyboard-shortcuts-and-hotkeys.md](../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md) - User-facing shortcut reference
- `src/main/services/voiceHotkeyService.ts` - Main process registration, screenshot capture, and IPC emission
- `src/main/services/screenshotService.ts` - Screenshot capture using Electron desktopCapturer
- `src/renderer/hooks/useVoiceHotkeyListener.ts` - Renderer-side subscription hook
- `src/shared/types.ts` - `DEFAULT_VOICE_ACTIVATION_HOTKEY` constant

## Default Shortcut

**Ctrl+Alt+Space** (configurable in Settings > Shortcuts)

## Architecture

The global hotkey spans three Electron processes:

| Layer | File | Responsibility |
|-------|------|----------------|
| Main | `voiceHotkeyService.ts` | Register Electron `globalShortcut`, focus window, emit IPC |
| Preload | `index.ts` | Expose `window.api.onVoiceActivationHotkey()` subscription |
| Renderer | `useVoiceHotkeyListener.ts` | Subscribe to IPC, trigger voice recording |

## Event Flow

```
User presses Ctrl+Alt+Space (system-wide)
    ↓
voiceHotkeyService: globalShortcut callback fires
    ↓
screenshotService.captureActiveDisplay() — captures display under cursor
    ↓
focusWindowForHotkey(): show/restore/focus main window
    ↓
webContents.send('voice:activation-hotkey-fired', { screenshot, screenshotError })
    ↓
useVoiceHotkeyListener: calls handleVoiceActivationHotkey(payload)
    ↓
App.tsx: attaches screenshot to composer, starts voice recording
    ↓
On send: screenshot included as image attachment in message
```

**Screenshot timing**: The screenshot is captured *before* the Rebel window is focused, so it captures what the user was actually looking at when they pressed the hotkey.

## Implementation Details

### Main Process (voiceHotkeyService.ts)

Key exports:
- `applyVoiceActivationHotkey(accelerator)` - Register a new hotkey (unregisters previous)
- `unregisterVoiceActivationHotkey()` - Remove the current registration
- `setMainWindowGetter(fn)` - Provide the window reference for focusing

The service handles:
- **Screenshot capture**: Calls `screenshotService.captureActiveDisplay()` before focusing
- **Deferred registration**: If called before `app.isReady()`, stores as pending
- **Window focusing**: Shows/restores/focuses before emitting event
- **Fallback window**: Uses any available window if main window is unavailable
- **Error handling**: Returns a result object instead of throwing. On failure (e.g., shortcut already in use by another app), returns `{ success: false, error: "..." }` and the app continues without the hotkey feature

### Screenshot Service (screenshotService.ts)

Captures screenshots using Electron's `desktopCapturer` API:
- **Display detection**: Captures the display under the cursor
- **Resizing**: Limit-only — captures at native display × scaleFactor; resizes only when source exceeds Anthropic's 8000 px hard ceiling (`IMAGE_HARD_DIMENSION_LIMIT`). Preserves OCR-quality text legibility. See `docs-private/investigations/260428_screenshot_text_unreadable.md`.
- **No disk storage**: Returns base64 data directly — screenshot is never written to disk
- **macOS permission**: Checks `screen` media access status; returns `screen-permission` error if denied
- **Error handling**: Returns typed errors (`screen-permission` | `capture-failed`) for user feedback

Privacy note: Screenshots exist only in memory until sent with the message, then become part of conversation history.

### Renderer Hook (useVoiceHotkeyListener.ts)

```tsx
export function useVoiceHotkeyListener(handler: (payload?: VoiceActivationHotkeyPayload) => void): void
```

The handler receives the payload containing screenshot data and any capture errors. Uses a ref pattern so the IPC subscription doesn't need to re-subscribe when the handler callback changes. The hook:
1. Keeps `handlerRef.current` in sync with the latest `handler`
2. Subscribes once on mount with a stable listener that calls `handlerRef.current()`
3. Cleans up subscription on unmount

### Configuration

Users change the hotkey via Settings > Shortcuts. The `ShortcutsTab` component calls the `settings:update` IPC to save the new accelerator, which triggers `applyVoiceActivationHotkey()` in the main process.

## Troubleshooting

**Hotkey doesn't work**:
1. Check if another app has registered the same shortcut
2. Verify the shortcut is enabled in Settings > Shortcuts
3. Check main process logs for registration errors

**Hotkey focuses app but doesn't start recording**:
- Ensure `useVoiceHotkeyListener` is mounted in App.tsx
- Check renderer console for errors in `handleVoiceActivationHotkey`

**Screenshot not captured (macOS)**:
- Grant Screen Recording permission: System Settings → Privacy & Security → Screen Recording → Enable Rebel
- Toast will show "no screenshot (enable Screen Recording in System Settings)" if permission is missing

**Screenshot not captured (other reasons)**:
- Check main process logs for `screenshotService` errors
- Verify `desktopCapturer.getSources()` returns sources
