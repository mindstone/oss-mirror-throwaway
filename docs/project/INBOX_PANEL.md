---
description: Inbox panel — "later list" for actionable items, staged files, and execution flow
last_updated: 2026-04-16
---

# Inbox Panel

The Inbox is a lightweight "later list" where users can save actionable items, then run them with Rebel or share them to social platforms. Previously known as "Task Queue".

## See Also

- [`ARCHITECTURE_OVERVIEW.md`](./ARCHITECTURE_OVERVIEW.md) — Where Inbox fits in renderer/main architecture
- [`ACTIONS_AUTO_RESOLUTION.md`](./ACTIONS_AUTO_RESOLUTION.md) — Why Actions cleanup has separate backlog/daily modes, connector-agnostic evidence routing, and cost/trust guardrails
- [`MCP_ARCHITECTURE.md`](./MCP_ARCHITECTURE.md) — MCP server configuration and discovery
- `src/renderer/features/inbox/` — Renderer UI components and hooks
- `src/main/services/inboxStore.ts` — Persistent store (index + entry files)
- `resources/mcp/rebel-inbox/` — Bundled MCP server with inbox tools

## Rename Note

The feature was renamed from "Task Queue" to "Inbox" in December 2025 (commit `0ba968e`). IPC channels use the `inbox:` prefix, but legacy `tasks:*` aliases exist in `src/shared/ipc/channels/inbox.ts` for backwards compatibility. Deprecated type aliases exist in `src/shared/types.ts` (e.g., `TaskQueueItem` → `InboxItem`).


## Overview

The Inbox uses an **Eisenhower Matrix** layout with four quadrants based on urgency and importance:

| Quadrant | Criteria | Description |
|----------|----------|-------------|
| **Do Now** | Urgent + Important | Items requiring immediate attention |
| **Schedule** | Important, not urgent | Strategic items to plan for |
| **Delegate** | Urgent, not important | Tasks to hand off or automate |
| **Consider** | Neither | Low-priority items to review later |

Items can be dragged between quadrants to reclassify them (or use the Move menu via keyboard: Cmd/Ctrl+M).

### View Tabs

The Inbox has three view tabs:

1. **Active** — Items awaiting user action (execute, archive, or delete)
2. **Archived** — Items marked as handled (can be restored)
3. **Executed** — Items run with Rebel, with links to their conversations

### Item Sorting

Within each quadrant, items are sorted automatically:
- **Drafts first** — Items with pre-generated content ready for approval appear at the top
- **Then by date** — Urgent quadrants (Do Now, Delegate) show oldest first; non-urgent quadrants show newest first

This sorting is currently automatic; manual reordering is not supported.

### Data Model

```ts
// From src/shared/types.ts
type InboxItem = {
  id: string;
  title: string;
  text: string;
  source?: InboxSource | null;      // Origin context
  references: InboxReference[];     // Related files/URLs
  addedAt: number;
  archived?: boolean;               // true = archived/handled
  archivedAt?: number;              // When archived (epoch ms)
  actions?: InboxAction[];          // UI buttons (execute, share)
  // Eisenhower Matrix classification
  urgent?: boolean;                 // Requires immediate attention
  important?: boolean;              // Matters for goals/values (default: true)
  // Content fields
  clarifyingQuestion?: string;      // Optional prompt from Rebel
  draft?: string;                   // Pre-drafted content for approval
  executingSessionId?: string;      // Tracks active background execution
};

type InboxHistoryEntry = InboxItem & {
  executedAt: number;
  sessionId: string;
  mode: 'execute' | 'execute_with_context';
};
```


## MCP Server (Auto-configured)

The Rebel Internal MCP server (which includes inbox tools) is **automatically added** to the user's MCP config on app startup via `upsertMcpServersBatch()` in `src/main/index.ts`.

If not connected, users can manually add it via the Inbox panel's "Enable" button.

### MCP Tools

| Tool | Description |
|------|-------------|
| `rebel_inbox_add` | Create a new inbox item |
| `rebel_inbox_update` | Edit an existing item |
| `rebel_inbox_remove` | Delete an item |
| `rebel_inbox_list` | List all items with IDs |

**Example usage (from agent perspective):**
```
User: "Add to my inbox: summarize yesterday's standup"
Agent: [calls rebel_inbox_add with title and text]
```


## UI Components

### Connection Status

When the Rebel inbox MCP server isn't configured, the panel shows a subtle info notice:
- **"Rebel can't add items yet"** — Informational (not alarming); includes tooltip explaining that the inbox works fine for viewing items, but agents can't add new ones
- **Enable button** — Adds the MCP server entry and restarts MCP connections

This is intentionally low-severity: the inbox data is local and fully functional regardless of MCP status. The MCP server is only needed when agents want to programmatically add items during conversations.

### UI Components

See `src/renderer/features/inbox/components/`:
- `InboxPanel.tsx` — Main panel with connection status, view tabs, and grid
- `EisenhowerGrid.tsx` — The 4-quadrant grid layout with drag-and-drop
- `QuadrantCard.tsx` — Individual item cards with expand/collapse, actions, voice input

### Item Interactions

**Expand/Collapse:**
- Items can be expanded to show full text, references, and draft content
- Click the chevron button to toggle (title click does not expand)
- Collapsed items show title, source badge, and timestamp

**Drag and Drop:**
- Drag items between quadrants to change their urgent/important classification
- Cross-quadrant drag is fully supported
- Within-quadrant reordering is NOT supported (items auto-sort)

**Item Actions:**
Each active item shows:
- **Context input** — Add notes/context before executing
- **Voice mic** — Voice input for context (tap to record, double-tap to send)
- **Go button** — Execute with Rebel (archives when complete)
- **Go & Pin** — Execute and keep conversation pinned
- **Move menu** — Move to another quadrant (hover or Cmd/Ctrl+M)
- **Archive button** — Mark as handled
- **Delete button** — Permanently remove

**Draft Items:**
Items with pre-drafted content show Send/Edit buttons instead of Go:
- **Send** — Send the draft as-is
- **Edit** — Open in conversation to revise

Archived items show Restore and Delete buttons.

### CTA Label Framework

The primary action button on each inbox card uses a context-sensitive label resolved by a **priority chain** — first matching condition wins. The same framework applies on the homepage Today cards (`resolveInboxCta` in `useTodayStream.ts`) and in the full Inbox view (`resolveInboxCtaLabel` in `resolveInboxCtaLabel.ts`).

| Priority | Condition | Label | User's action |
|----------|-----------|-------|---------------|
| 1 | `item.draft` exists | **Send** | Review and approve a pre-drafted deliverable |
| 2 | `item.clarifyingQuestion` exists | **Decide** | Give Rebel a yes/no or directional answer |
| 3 | Source is transcript/recording | **Catch up** | Review what happened in a meeting/recording |
| 4 | Default | **Review** (homepage) / **Go** (inbox) | General review with Rebel |

**Key files:**
- `src/renderer/features/homepage/hooks/useTodayStream.ts` — `resolveInboxCta()` returns `{ label, prompt }` for homepage Today cards
- `src/renderer/features/inbox/utils/resolveInboxCtaLabel.ts` — `resolveInboxCtaLabel()` returns label string for inbox QuadrantCard and InboxListActions
- `src/renderer/utils/formatSourceLabel.ts` — `isTranscriptSource()` identifies transcript/recording sources
- Tests: `src/renderer/features/homepage/hooks/__tests__/resolveInboxCta.test.ts` and `src/renderer/features/inbox/utils/__tests__/resolveInboxCtaLabel.test.ts`

**Design principle:** Add a new CTA tier only when the user's *action* is genuinely different (e.g., sending vs. deciding vs. catching up), not just because the item's *origin* differs. "Review" / "Go" covers all "look at this and decide what to do" scenarios.

**Future: conversational sources.** When email/Slack integrations ship, add a new tier between "Decide" and "Catch up" for items from message threads: `isConversationalSource(item.source?.label)` → **"Reply"**. This is the only scenario where "Reply" is appropriate — the user is composing a response to another person.


## Staged Files — Conflict & Error Feedback

The Inbox includes a **staged files strip** that shows files pending user approval. When approving ("quick-approve" from the strip, or via the preview dialog), two feedback paths handle edge cases:

### Conflict Detection

If the underlying file was modified after staging (e.g., another agent turn wrote to it), the publish attempt returns `hasConflict: true` with a diff payload. The UI responds by:

1. Opening `StagedFilePreviewDialog` with the conflict pre-populated
2. Showing a split diff view (current file vs. staged version) via `react-diff-viewer-continued`
3. Offering **Keep Mine** (overwrite with staged), **Keep Theirs** (discard staged), or **instruct Rebel** to merge

### Error Feedback

Non-conflict publish errors on quick-approve (from the strip and `NotificationDrawer`) surface via toast notification (`useToast`). In the preview dialog, errors render as inline text. Discard failures are currently not surfaced.

### Key Components

| Component | Location | Role |
|-----------|----------|------|
| `StagedFilesStrip` | `src/renderer/features/inbox/components/StagedFilesStrip.tsx` | Strip of staged-file cards with quick-approve; detects conflicts and opens preview |
| `StagedFilePreviewDialog` | `src/renderer/features/inbox/components/StagedFilePreviewDialog.tsx` | Full preview with diff view, conflict resolution, and instruction input |
| `ApprovalPointerBar` | `src/renderer/features/agent-session/components/ApprovalPointerBar.tsx` | Lightweight per-conversation pointer that opens NotificationDrawer |
| `NotificationDrawer` | `src/renderer/features/inbox/components/NotificationDrawer.tsx` | Right-side grouped approval drawer with full approval management |

### Skill/Space Change Notification Invariants

The `NotificationDrawer` displays skill and space change notifications via `useSkillChangeNotifications`. Two invariants apply:

1. **Dismissals must persist.** When a user dismisses a notification, the dismissal is recorded durably so the notification does not resurface on app restart or panel re-focus.
2. **Stale notification cleanup.** Notifications targeting deleted or renamed skills/spaces must be automatically dismissed rather than shown to the user. When the user clicks a notification whose underlying skill file no longer exists, the drawer auto-dismisses it and shows a "This skill has been removed" toast instead of navigating to a broken path.

See `useSkillChangeNotifications` hook and the `NotificationDrawer` click handler for implementation.


## Execution Flow

1. User clicks **Execute** (optionally adds context text)
2. Renderer creates new agent conversation with constructed prompt + any referenced files
3. On submission, `inbox:record-execution` moves item to Executed section
4. Executed entry includes session ID for "Open conversation" link


## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `inbox:load` | renderer→main | Load full inbox state (legacy) |
| `inbox:load-index` | renderer→main | Load metadata index only (for lazy loading) |
| `inbox:load-items` | renderer→main | Load full details for specific item IDs |
| `inbox:delete` | renderer→main | Remove item |
| `inbox:record-execution` | renderer→main | Move to Executed section |
| `inbox:set-archived` | renderer→main | Archive or restore item |
| `inbox:mark-archived` | renderer→main | Mark item as archived (one-way) |
| `inbox:set-quadrant` | renderer→main | Change item's quadrant (urgent/important) |
| `inbox:set-executing` | renderer→main | Set/clear executing session ID |
| `inbox:state` | main→renderer | Push state updates |


## Storage Architecture

Inbox data uses a two-tier storage system (migrated from single-file in v4):

1. **Index Store** (`inbox-index.json`) — Lightweight metadata for fast startup
   - Entry IDs, titles, archived status, quadrant flags
   - Loaded synchronously at startup

2. **Entry Files** (`inbox/{id}.json`) — Full item content
   - Loaded on-demand when items are expanded or executed
   - Atomic writes (temp file + rename)


## Troubleshooting

**Inbox shows "Rebel can't add items yet":**
- This is informational, not an error. Your inbox works fine for viewing/managing items.
- Click "Enable" to add the MCP server, or restart the app (it auto-configures on startup)
- If "Enable" isn't available, check that an MCP config file is selected in settings

**Items not appearing after asking Rebel to add them:**
- Click "Enable" if the setup notice is showing
- Verify agent used `rebel_inbox_add` tool (check session transcript)

**Execute button missing:**
- Item was added without `{ type: 'execute' }` action
- Agent should include this action for executable tasks

