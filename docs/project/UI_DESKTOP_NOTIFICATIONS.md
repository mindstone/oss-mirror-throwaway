---
description: "Desktop notification pipelines for turn completion, Actions-related navigation, and meeting detection"
last_updated: "2026-06-10"
---

# Desktop Notifications

Rebel uses native OS notifications to alert users when background work finishes or when meeting detection needs attention.

## See Also

- [MEETING_BOT](MEETING_BOT.md) - Meeting detection triggers notifications when auto-join is disabled
- [ARCHITECTURE_IPC](ARCHITECTURE_IPC.md) - IPC patterns for notification channels
- Planning doc: `docs/plans/finished/251220_desktop_notifications_on_turn_complete.md` - Original implementation plan

## Code Entry Points

### Turn-complete notifications (main-process-triggered)

- `src/main/services/agentEventDispatcher.ts` - Watches `result` events, classifies the turn (`conversation`, `automation`, `role-checkin`), checks notification settings, and calls the shared notification helper
- `src/main/services/desktopNotificationService.ts` - Thin facade over the desktop notification sink
- `src/main/services/desktopNotification/electronDesktopNotificationSink.ts` - Electron `Notification` adapter: GC retention, click handler, main-window targeting, payload-free nudge
- `src/main/services/desktopNotification/notificationClickIntent.ts` - Single-slot pending click-intent store (record / consume-once / TTL) and main-window getter wiring
- `src/shared/ipc/channels/app.ts` - `app:consume-pending-notification-click` invoke channel (pull semantics)
- `src/main/ipc/appHandlers.ts` - Consume handler; logs hit/miss + intent age at `info`
- `src/preload/index.ts` - Buffers payload-free `notification:clicked` nudges until the renderer subscribes
- `src/renderer/hooks/useNotificationClickNavigation.ts` - Pull-based consume + route (mount and nudge coalesced)
- `src/renderer/App.tsx` - Injects `openNotificationConversation` / `openNotificationFile` adapters; wires the hook

### Generic desktop notifications (renderer → main helper)

- `src/shared/ipc/channels/app.ts` - `app:show-notification` channel definition
- `src/main/ipc/appHandlers.ts` - IPC handler that forwards to `desktopNotificationService.ts`

### Meeting-detected notifications

- `src/main/services/meetingBot/desktopSdkService.ts` - `showMeetingDetectedNotification()` creates the meeting notification directly
- `src/preload/index.ts` - `onMeetingNotificationClicked` subscription wrapper
- `src/renderer/App.tsx` - Handles click → triggers the meeting "Send Rebel" action

## Notification Types

| Type | Trigger | Settings gate | Title |
|------|---------|---------------|-------|
| Conversation complete | User-facing turn with category `conversation` (or uncategorised legacy turn) finishes while the app window is unfocused | `notifications.conversationComplete` | `Rebel conversation finished` |
| Automation complete | Turn with category `automation` finishes while the app window is unfocused | `notifications.automationComplete` | `Rebel automation complete` |
| Role check-in complete | Turn with category `role-checkin` finishes while the app window is unfocused | `notifications.roleComplete` | `Rebel role check-in complete` |
| Meeting detected | Desktop SDK sees a meeting and auto-join is not taking over | Meeting bot join mode / provider logic | Meeting-specific title/body |

The master toggle for the first three lives in **Settings → Account Preferences → Desktop Notifications**. In user-facing copy, this surfaces when work finishes in the background while you are elsewhere in the app or in another app; the tab formerly described as **Tasks** is now **Actions**.

## How It Works

### Turn-complete notifications

When `dispatchAgentEvent()` receives a `result` event, it:

1. Delivers the event through the core dispatcher
2. Looks up the renderer session and turn category via `agentTurnRegistry`
3. Verifies the event is user-facing (`conversation`, `automation`, or `role-checkin`)
4. Verifies the main window is currently **not focused**
5. Checks `settings.notifications.enabled` and the category-specific toggle
6. Resolves a session title (best effort) and calls `showDesktopNotification()`

`showDesktopNotification()` then:

- checks `Notification.isSupported()`
- no-ops in test mode or when notifications are disabled
- creates the native OS notification and retains it in a size-capped set (see **GC retention** below)
- on click: records intent in the main-process store, ensures/focuses the **main** window, and sends a payload-free `notification:clicked` nudge

**Click behavior:** the renderer never trusts the push payload. On hook mount and on each nudge it **pulls** via `app:consume-pending-notification-click` (`window.appApi.consumePendingNotificationClick()`). Consume is **once-only** at the main-process chokepoint; TTL is **5 minutes from `clickedAt`**; **latest click wins** in the single-slot store. With a consumed intent:

- `filePath` → library navigation (skill-change / P3a notifications)
- `sessionId` → open conversation **by ID** via `executeOpenHistorySession(sessionId, 'notification')` — no `sessionSummaries` membership gate; telemetry source is `'notification'`
- failed open → warn log + "That conversation is gone…" toast

If the user was on **Actions**, Settings, or another surface, the renderer routes them to the clicked target after focus is restored.

### Meeting detection notifications

When a meeting is detected via the Desktop SDK and auto-join is disabled (`joinMode: 'ask'` or `joinMode: 'prompt'`), a notification prompts the user to send Rebel.

Notification is suppressed when:

- `joinMode: 'auto'`
- an external provider (for example Fireflies or Fathom) is configured
- Rebel is running in test mode

**Code path:** `desktopSdkService.ts` → `showMeetingDetectedNotification()` → `meeting-notification:clicked` IPC event → `App.tsx` handler → `sendMeetingBot`

## Architecture

### Turn-complete pipeline (Main → OS → Renderer click handling)

```
┌──────────────────────┐     ┌────────────────────────────┐     ┌──────────────────┐
│ agentEventDispatcher │────▶│ electronDesktopNotification│────▶│ OS Notification  │
│ (result event)       │     │ Sink (+ intent store)      │     │ Center           │
└──────────────────────┘     └────────────────────────────┘     └──────────────────┘
                                                        │ click
                                                        ▼
                              ┌─────────────────────────────────────────────┐
                              │ record intent → ensure main window → nudge  │
                              │ (payload-free notification:clicked)         │
                              └─────────────────────────────────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────────────────┐
                              │ useNotificationClickNavigation              │
                              │ pull app:consume-pending-notification-click │
                              │ → route sessionId / filePath                │
                              └─────────────────────────────────────────────┘
```

### Meeting pipeline (Main → OS)

```
┌────────────────────┐     ┌──────────────────┐
│  desktopSdkService │────▶│  OS Notification │
│  (meeting-detected)│     │  Center          │
└────────────────────┘     └──────────────────┘
          │ click
          ▼
┌────────────────────┐     ┌──────────────────┐
│  webContents.send  │────▶│  App.tsx handler │
│  meeting-notif:    │     │  → sendMeetingBot│
└────────────────────┘     └──────────────────┘
```

## Implementation Notes

- **Platform support:** Checked via `Notification.isSupported()` before showing
- **Window focus:** On click, the sink targets the injected **main** window getter (not first-alive-window). Minimized windows are restored before focus.
- **GC retention:** `Notification` objects are retained in a module-level `Set` (cap ~50) until `click` or `failed`. **Not** released on `close` — macOS can emit `close` when a banner auto-dismisses to Notification Center, which is exactly the delayed-click case retention exists for.
- **Defensive coding:** Payload validation plus destroyed window / destroyed `webContents` guards; click intent recorded before any windowing so no-window paths still leave a pullable intent.
- **Logging:** Shown / clicked / consumed paths log at `info` (persisted + Sentry breadcrumbs). Click-handler errors and no-main-window paths log at `warn`. Settings / test-mode / unsupported gate bails stay at `debug`. Renderer failed open emits `emitLog` at `warn`.
- **Race handling:** Preload still buffers the payload-free nudge so cold-start clicks are not lost. Startup reload-restore waits for the hook's initial consume to complete (with timeout) before navigating.

## Limitations

- **No cooldown:** Rapid conversation / automation / role-check-in completions will each raise a notification
- **OS permissions:** First use may trigger a system permission prompt
- **Cross-platform UX differs:** Electron abstracts delivery, but Windows / macOS / Linux notification centers still behave differently
- **Dead-instance clicks:** A notification posted by a previous app instance cannot be recovered after process exit (click handler is in-memory only)
