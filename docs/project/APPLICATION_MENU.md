---
description: "Native Electron application menu reference — platform-specific menus, shortcuts, dev-mode items, renderer IPC commands"
last_updated: "2025-12-16"
---

# Application Menu

The native application menu bar for Mindstone Rebel.

## Overview

The menu is defined in `src/main/index.ts` after window creation using Electron's `Menu.buildFromTemplate()` and `Menu.setApplicationMenu()` APIs.

## Menu Structure

| Menu | Contents | Notes |
|------|----------|-------|
| **Mindstone Rebel** (macOS only) | About, Settings (Cmd+,), Services, Hide, Quit | Standard macOS app menu |
| **Edit** | Undo, Redo, Cut, Copy, Paste, Delete, Select All | Required for clipboard in text fields |
| **View** | Toggle Full Screen, Zoom In/Out/Reset, (Dev tools in dev mode) | macOS auto-adds fullscreen |
| **Window** | Minimize, Zoom, (Close on Windows/Linux) | Platform-specific items |
| **Help** | Ask Rebel for Help Directly, Ask the Community, Keyboard Shortcuts, Check for Updates, Download Diagnostics | IPC + external link |

## Platform Behavior

### macOS
- First menu uses `app.name` and includes standard macOS items (About, Services, Hide, Quit)
- **Fullscreen**: macOS may inject its own "Enter Full Screen" item into View menus (since El Capitan), resulting in two fullscreen entries. We include ours explicitly to ensure the Ctrl+Cmd+F shortcut works reliably.
- Window menu includes "Bring All to Front" via `role: 'front'`

### Windows/Linux
- No app-name menu (Edit menu is first)
- Window menu includes Close instead of "Bring All to Front"

## Keyboard Shortcuts Provided

These shortcuts are automatically bound via Electron's `role` property:

| Shortcut | Action | Platform |
|----------|--------|----------|
| Cmd+, | Open Settings | macOS |
| Ctrl+Cmd+F | Toggle fullscreen | macOS |
| F11 | Toggle fullscreen | Windows/Linux |
| Cmd/Ctrl+Plus | Zoom in | All |
| Cmd/Ctrl+Minus | Zoom out | All |
| Cmd/Ctrl+0 | Reset zoom | All |
| Cmd+C/V/X/Z | Copy/Paste/Cut/Undo | macOS |
| Ctrl+C/V/X/Z | Copy/Paste/Cut/Undo | Windows/Linux |
| Cmd+H | Hide app | macOS |
| Cmd+Q | Quit | macOS |

## Dev Mode Extras

When `app.isPackaged` is false, the View menu includes:
- Reload (Cmd/Ctrl+R)
- Force Reload (Cmd/Ctrl+Shift+R)
- Toggle Developer Tools (Cmd/Ctrl+Shift+I)

## Implementation Notes

### Why We Need an Explicit Menu

Without `Menu.setApplicationMenu()`:
- Keyboard shortcuts like Ctrl+Cmd+F (fullscreen) don't work
- Copy/paste may not work in text fields on some platforms
- No standard OS menu bar behavior

## Menu Commands via IPC

Some menu items communicate with the renderer via IPC:

| Menu Item | IPC Channel | Behavior |
|-----------|-------------|----------|
| Settings… (Cmd+,) | `menu:open-settings` | Opens Settings panel in renderer |
| Ask Rebel for Help Directly | `menu:ask-rebel-help` | Focuses composer for user to ask Rebel |
| Check for Updates… | `menu:check-for-updates` | Triggers update check, shows toast |
| Download Diagnostics… | `menu:download-diagnostics` | Downloads diagnostic bundle with logs |

The renderer listens for these in `App.tsx` via `window.api.onMenuOpenSettings()`, `window.api.onMenuAskRebelHelp()`, and `window.api.onMenuCheckForUpdates()`.

## See Also

- [KEYBOARD_SHORTCUTS.md](./KEYBOARD_SHORTCUTS.md) - Full keyboard shortcuts documentation
- [Electron Menu API](https://www.electronjs.org/docs/latest/api/menu)
- [Electron MenuItem roles](https://www.electronjs.org/docs/latest/api/menu-item#roles)
