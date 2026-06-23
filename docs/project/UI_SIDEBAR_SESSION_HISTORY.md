---
description: "Agent session sidebar UI — history list, search, filters, pinning, session actions, status indicators, selection states"
last_updated: "2026-02-23"
---

### Introduction

The agent session sidebar is the persistent left-hand panel that displays the user's conversation history. It provides session listing, search, filtering, pinning, and session management actions.

This document covers the UI components and interaction patterns. For the underlying data model, persistence, and context-resume behavior, see [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md).


### See Also

- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — Session data model, persistence, and upstream context resume
- [UI_OVERVIEW.md](UI_OVERVIEW.md) — High-level UI layout and interaction patterns
- [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) — All keyboard shortcuts including sidebar-related ones
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — Renderer state architecture and session store internals


### Component Architecture

The sidebar is implemented as a set of React components in `src/renderer/features/agent-session/components/`:

```
AgentSessionSidebar.tsx (main container)
├── Search box with clear button
├── Checklist widget slot (onboarding)
├── Session list
│   ├── Pinned sessions section (with "Active pinned" header)
│   ├── Divider
│   └── Regular sessions
│       └── Session entry (per session)
│           ├── SessionTooltipContent (hover details)
│           ├── Pin button
│           └── SessionActionsMenu (more actions dropdown)
└── UserMenu (footer)
```

**Key files:**
- `AgentSessionSidebar.tsx` — Main sidebar component (~350 LOC)
- `AgentSessionSidebar.module.css` — Extensive styling for all sidebar states
- `SessionActionsMenu.tsx` — Floating dropdown with Rename/Delete actions
- `SessionDeleteDialog.tsx` — Confirmation dialog for session deletion
- `HistoryFilterDropdown.tsx` — Filter between Conversations and Automations
- `PinnedFavoritesTabs.tsx` — Horizontal tab bar for pinned sessions


### Session List Display

Each session in the list displays as a card with:

| Element | Description |
|---------|-------------|
| **Title** | Session title with optional automation badge |
| **Preview** | Truncated last message text |
| **Timestamp** | Relative time ("2h ago", "Yesterday") |
| **Status icon** | Spinner for thinking sessions |
| **Time saved** | Optional "~Xm saved" indicator for sessions ≥5 minutes |
| **Coaching accent** | Left border accent when coaching insights are available |
| **Memory accent** | Left border accent when memory approval is pending |

**Data source:** Sessions are provided as `AgentSessionSidebarEntry[]` from the parent component:

```typescript
type AgentSessionSidebarEntry = {
  id: string;
  title: string;
  preview: string;
  timestamp: number;
  status: AgentSessionSidebarStatus;  // 'idle' | 'ready' | 'thinking'
  isActive?: boolean;  // doneAt == null (lifecycle: Active vs Done — renamed from isPinned; see UI_CONVERSATIONS.md / ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md)
  origin?: 'manual' | 'automation';
  isCorrupted: boolean;
  isResolved: boolean;
  timeSavedMinutes?: number | null;
  hasCoaching?: boolean;
  hasPendingMemoryApproval?: boolean;
  // ... additional fields
};
```


### Status Indicators

Sessions show visual status based on their current state:

| Status | Visual | Meaning |
|--------|--------|---------|
| `idle` | No icon | Session is dormant |
| `ready` | No icon | Session available for new turns |
| `thinking` | Inline spinner | Agent turn is currently running |

Corrupted sessions display a ⚠️ icon and are styled distinctly. They cannot be opened.


### Session Selection

- **Active session**: The currently viewed session, styled with `.entryActive`
- **Selected session**: Keyboard-highlighted result in search, styled with `.entrySelected`

Clicking a session entry calls `onSelectSession(sessionId, isHistory)`, which triggers:
1. Session state restoration in the renderer
2. Upstream SDK session restoration (if applicable and recent)
3. UI update to show the selected conversation


### Search and Filtering

#### Conversation Search

The search box at the top filters sessions by title and message content:

```
┌─────────────────────────────┐
│ 🔍 Search conversations...  │
└─────────────────────────────┘
```

- **Behavior**: Filters the visible session list as you type
- **Results**: Shows matching sessions with highlighted match text
- **Empty state**: "No conversations match 'query'" with hint to try different keywords

**Search result display:**
- Title match: Shows the title directly
- Content match: Shows quoted match text (`"matched text"`)
- Metadata: Message count and timestamp

#### History Filter Dropdown

`HistoryFilterDropdown` allows filtering between:

| Filter | Description |
|--------|-------------|
| **Conversations** | User-initiated sessions (default) |
| **Automations** | Sessions created by scheduled automations |

The dropdown shows a running indicator (pulsing dot + "Running" badge) when an automation is currently executing.


### Pinned Sessions

Users can pin important sessions to keep them at the top of the list.

**Pinning behavior:**
- Pinned sessions appear first with an "Active pinned" header
- A visual divider separates pinned from unpinned sessions
- Pin button toggles between filled (pinned) and outlined states
- Pins are persisted in user settings

**Pin interaction:**
- Click the pin icon on any session to toggle
- Keyboard: No direct shortcut; use mouse or access via actions menu

**PinnedFavoritesTabs component:**
When the flow history panel is closed, pinned sessions also appear as horizontal tabs above the main content area:

```
┌─────────────┬─────────────┬─────────────┐
│ Project A 📌│ Research B 📌│ Notes C 📌 │
└─────────────┴─────────────┴─────────────┘
```

This provides quick access without opening the full sidebar.


### Session Actions

#### Inline Actions

Each session entry shows action buttons on hover:

| Action | Icon | Behavior |
|--------|------|----------|
| **Pin/Unpin** | 📌 | Toggles pinned state |
| **More actions** | ⋯ | Opens SessionActionsMenu |

#### SessionActionsMenu

A floating dropdown with:

- **Rename** — Activates inline title editing
- **Delete** — Opens deletion confirmation dialog

The menu uses `@floating-ui/react` for positioning and auto-closes on outside click or Escape.

#### Inline Renaming

When renaming:
1. The title becomes an editable input
2. Enter confirms the new title
3. Escape cancels and reverts to original
4. Blur (clicking away) confirms the change


### Session Deletion

`SessionDeleteDialog` provides a confirmation step before permanent deletion:

```
┌──────────────────────────────────────┐
│ 🗑️ Delete conversation               │
│                                      │
│ "Meeting Notes - Project Alpha"      │
│ 12 messages · Updated 2 hours ago    │
│                                      │
│ Deleting removes this transcript,    │
│ steps, and tool history forever.     │
│ This cannot be undone.               │
│                                      │
│ • Current agent run will be stopped. │
│ • Clears 2 queued messages.          │
│                                      │
│ [Keep conversation]  [Delete forever]│
└──────────────────────────────────────┘
```

**Contextual warnings shown when:**
- Deleting the active session (will stop current run)
- Session has queued messages (will be cleared)

**Delete animation:**
Sessions being deleted receive the `.listItemDeleting` class for a fade-out transition.


### Keyboard Navigation

The sidebar supports keyboard navigation when search is active:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate search results |
| `Enter` | Open selected session |
| `Escape` | Close search / clear query |

**Keyboard hint footer** (visible during search):
```
↵ Open · ↑↓ Navigate · Esc Close
```

#### Pinned Session Cycling

From anywhere in the app (via `usePinnedSessionNavigation` hook):

| Shortcut | Action |
|----------|--------|
| `Ctrl+Tab` | Next pinned session |
| `Ctrl+Shift+Tab` | Previous pinned session |

This cycles through pinned sessions in order, useful for quickly switching between active projects.


### Visual States and Styling

The sidebar uses CSS modules (`AgentSessionSidebar.module.css`) with distinct states:

| State | Class | Visual treatment |
|-------|-------|------------------|
| Active | `.entryActive` | Highlighted background |
| Selected (search) | `.entrySelected` | Keyboard focus indicator |
| Corrupted | `.entryCorrupted` | Warning styling, ⚠️ icon |
| Resolved | `.entryResolved` | Subtle styling difference |
| Deleting | `.listItemDeleting` | Fade-out animation |

**"Rebel recommends" chip:**
- `.recommendsChip` — Small indigo chip below preview text, shown when coaching insights are available (`hasCoaching`) or memory approval is pending (`hasPendingMemoryApproval`). Replaces the previous left-border accent bars.


### Tooltip Behavior

Hovering over a session shows detailed information via `SessionTooltipContent`:

- Full title (untruncated)
- First user message preview
- Last message preview
- Message count
- Total session cost (if available)
- Timestamp

Tooltips are disabled during inline editing and for corrupted sessions.


### Implementation Notes

**Performance:**
- The sidebar component is wrapped in `memo()` to prevent unnecessary re-renders
- Mouse leave handlers blur action buttons to prevent focus trapping

**Accessibility:**
- Session list uses proper `ul`/`li` semantics
- Action buttons have descriptive `aria-label` attributes
- Pin buttons use `aria-pressed` to communicate toggle state
- Filter dropdown uses `role="menu"` and `menuitemradio` patterns

**Automation badge:**
Sessions with `origin === 'automation'` display an "Automation" badge in their title row, helping users distinguish scheduled runs from manual conversations.
