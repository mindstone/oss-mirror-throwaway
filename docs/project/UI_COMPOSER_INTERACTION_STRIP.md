---
description: "Composer and interaction strip architecture — voice/text input, attachments, mentions, session controls, queue integration"
last_updated: "2026-06-06"
---

# UI Composer & Interaction Strip

The composer and interaction strip form the primary user input surface in Mindstone Rebel. This document describes the component hierarchy, state management, and key behaviors for voice/text input, file attachments, @-mentions, and message queue integration.


## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) — High-level UI layout and interaction patterns
- [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) — Queue/interrupt semantics for sending messages while agent is busy
- [CONVERSATION_MENTIONS.md](CONVERSATION_MENTIONS.md) — @-mention syntax and conversation reference behavior
- [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) — Voice pipeline (STT/TTS), permissions, and playback
- [PRIVACY_MODE.md](PRIVACY_MODE.md) — Per-session privacy toggle behavior
- `src/renderer/features/composer/` — All composer components and hooks


## Component Hierarchy

The composer follows a layered architecture with clear separation of concerns:

```
InteractionStrip (footer wrapper)
├── External Mic Button (voice input)
├── ComposerWithState (stateful wrapper)
│   └── AgentComposer (presentation layer)
│       ├── AttachmentThumbnailStrip
│       ├── TextInput (textarea)
│       ├── Attach Button (Paperclip)
│       ├── Clear Button (X)
│       ├── Internal Mic Button (transcription)
│       ├── MentionPopover (autocomplete)
│       ├── MentionedFilesPanel
│       └── Primary Button (Send/Stop/Interrupt)
├── FilesIndicatorButton (conversation-level file activity popover)
└── SessionSettingsMenu (voice replies, private mode, auto-done toggles, model info)
```

### Component Responsibilities

| Component | Location | Role |
|-----------|----------|------|
| `InteractionStrip` | `InteractionStrip.tsx` | Footer shell with voice controls and session controls |
| `ComposerWithState` | `ComposerWithState.tsx` | State management, imperative handle, file/mention hooks |
| `AgentComposer` | `AgentComposer.tsx` | Pure presentation layer, receives all props from parent |
| `MentionPopover` | `components/MentionPopover.tsx` | @-mention autocomplete dropdown |
| `SessionSettingsMenu` | `SessionSettingsMenu.tsx` | Floating menu with toggle switches for voice replies, private mode, auto-done, "Mark as done" action, and model info row |
| `FilesIndicatorButton` | `FilesIndicatorButton.tsx` | Badge + popover showing files created/modified in the conversation |

### SessionSettingsMenu Model Info Row

The menu includes a model info row (using the `'info'` `MenuItemConfig` type) that shows current Working and Thinking model names with a hover tooltip revealing all three roles (Working, Thinking, Background). Clicking navigates to Settings > AI & Models.

Data flows from the `useModelRoles()` hook (called in `App.tsx`) through the prop chain: `App.tsx` → `SessionSurfaceContent` → `InteractionStrip` → `SessionSettingsMenu`. The hook is in `src/renderer/hooks/useModelRoles.ts` and the resolved data is passed as primitive-dep-memoized `modelInfo` and a stable `onNavigateToModelSettings` callback to avoid busting InteractionStrip's `memo()` boundary.

See `docs/plans/260330_move_model_switcher_to_session_settings_menu.md` for the full design rationale.


## State Architecture

State is deliberately lifted to `ComposerWithState` to allow parent components (`App.tsx`) to interact with the composer programmatically via the imperative handle.

### ComposerHandle Interface

The `ComposerWithState` component exposes an imperative handle for parent control:

```typescript
interface ComposerHandle {
  getText: () => string;
  setText: (value: string) => void;
  insertAtCursor: (text: string) => void;
  clear: () => void;
  focus: () => void;
  getTextareaRef: () => HTMLTextAreaElement | null;
  getMentionState: () => MentionState;
  getAttachments: () => FileAttachment[];
  clearMentionState: () => void;
}
```

### Internal Hooks

| Hook | Purpose |
|------|---------|
| `useFileAttachments` | File attachment state, drag/drop, paste handling, MIME validation |
| `useMentionAutocomplete` | @-mention trigger detection, result navigation, insertion |
| `useDraftPersistence` | Auto-save/restore draft text per session |
| `useComposerState` | (Legacy) Basic text state, largely replaced by `ComposerWithState` |
| `useTranscriptionMic` | Recording lifecycle, audio encoding, STT integration |


## Voice vs Text Mode

The interaction strip supports simultaneous voice and text input, with mode-specific controls:

### Mode Toggle

The `ModeToggle` button switches between:
- **Agent mode** (Briefcase icon) — Full agent with tools, file access, and multi-step reasoning
- **Chat mode** (MessageCircle icon) — Fast replies, no tool use, simple Q&A

A one-time toast educates users on first switch to chat mode.

### Voice Controls

**External mic button** (left of composer):
- Single click: Start/stop recording
- Double click while recording: Stop and send immediately
- Visual states: idle, recording (pulsing), processing (spinner)
- Audio level indicator during recording

**Internal mic button** (inside textarea, hidden when external mic is shown):
- Transcription-to-text for voice dictation into the text field
- Controlled via `hideInternalMic` prop

**Speaker toggle** (right of composer):
- Enables/disables auto-speak for agent responses
- Visual states: Volume2 (on) / VolumeX (off, muted style)

### Missing Voice Key Behavior

When voice API keys are not configured:
- Mic and speaker buttons show disabled styling
- Tooltip explains: "Voice API key not configured. Add one in Settings → Agents & Voice → Voice provider."
- Clicking opens Settings directly via `onOpenSettings` callback
- Stopping (if already recording) is always allowed


## File Attachments

The composer supports attaching files via multiple methods:

### Attachment Methods

1. **Click attach button** (Paperclip) — Opens file picker
2. **Paste** — Ctrl/Cmd+V with file in clipboard
3. **Drag and drop** — Drop files onto the composer

### Supported File Types

| Category | Types | Size Limit | Processing |
|----------|-------|------------|------------|
| Images | PNG, JPEG, GIF, WebP | 10MB | Limit-only resize: pass-through unless source exceeds 8000 px (`IMAGE_HARD_DIMENSION_LIMIT`) |
| PDFs | application/pdf | 32MB (API limit) | Small: base64, Large (>25MB): text extraction |
| Office | DOCX, DOC, XLSX, XLS | 50MB | Extract text via mammoth/xlsx |
| Text | 80+ extensions (.md, .json, .py, etc.) | 5MB | Read as UTF-8 |

### Limits and Validation

- Maximum 5 attachments per message
- Extracted text limited to 500KB (~125k tokens)
- Binary files detected and rejected
- Error feedback via toast notifications

### Attachment UI

- `AttachmentThumbnailStrip`: Shows attached file thumbnails with remove buttons
- Drop zone overlay: Visual indicator during drag-over
- Attach button disabled when at max capacity


## Mentions Autocomplete

The @-mention system provides inline autocomplete for files and conversations.

### Trigger Behavior

Typing `@` anywhere in the input triggers autocomplete when:
- Preceded by whitespace or start of line
- Followed by optional query characters

### Unified Results

The popover shows both files and conversations in a single list:

| Result Type | Icon | Details Shown |
|-------------|------|---------------|
| File | FileText/FolderOpen | Relative path, highlighted matches |
| Skill | WandSparkles | Skill name and path |
| Conversation | MessageSquare | Title, relative time, badges (current, auto) |
| Command | ScanSearch | `@files` to search all workspace files |

For detailed mention syntax and resolution semantics, see [CONVERSATION_MENTIONS.md](CONVERSATION_MENTIONS.md).

### Keyboard Navigation

| Key | Action |
|-----|--------|
| ArrowDown | Select next result |
| ArrowUp | Select previous result |
| Enter/Tab | Insert selected mention |
| Escape | Close popover |

### Mentioned Files Panel

Below the textarea, resolved @-mentions display as a list showing:
- File/folder icon (or Sparkles for skills)
- File name (with trailing `/` for directories)
- Relative path


## Message Queue UI

The composer integrates with the message queue system to handle input while the agent is busy.

### Primary Button States

| State | Label | Action |
|-------|-------|--------|
| Idle, no text | "Send" (disabled) | — |
| Idle, with text | "Send" | Start new turn |
| Busy, no text | "Stop" (red, StopCircle icon) | Stop active turn |
| Busy, with text | "Queue" (ListPlus icon) | Add to the message queue (does NOT interrupt). A separate "Send now & interrupt" button performs send-now. |
| Sending | "Sending…" (spinner) | — |
| Stopping | "Stopping…" (spinner) | — |
| Editing | "Save & re-run" | Truncate and re-run from edit point |

### Queue Behavior

When the agent is busy and the user types:
- Text remains in the composer
- The primary button becomes "Queue" (and Enter / Alt+Enter both queue)
- Clicking it adds the message to the queue; the current turn is NOT interrupted
- To send immediately and interrupt, use the separate "Send now & interrupt" button (button-only — no keyboard shortcut as of 2026-06-06)

For full queue semantics (queue mode, priority, auto-processing), see [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md).


## Accessibility

### Keyboard Support

- Full keyboard navigation for mention popover
- Enter to send (queues automatically when agent is busy; when not in mention mode)
- Escape to clear mention state
- Focus management after mention insertion

### ARIA Attributes

| Element | Attributes |
|---------|------------|
| Textarea | `aria-label="Command input"` |
| Mention popover | `role="listbox"`, `aria-label="Mention suggestions"` |
| Popover items | `role="option"`, `aria-selected` |
| Buttons | `aria-label` describing action, `aria-disabled` for blocked state |
| Hidden file input | `aria-hidden="true"`, `tabIndex={-1}` |

### Voice Control Accessibility

- Mic and speaker buttons have descriptive `aria-label` based on current state
- Processing states indicated via spinner with screen reader context
- Tooltip content provides additional context on focus/hover


## Key Files

| File | Purpose |
|------|---------|
| `AgentComposer.tsx` | Presentation component for the text input form |
| `ComposerWithState.tsx` | Stateful wrapper with hooks and imperative handle |
| `InteractionStrip.tsx` | Footer shell integrating voice controls and toggles |
| `ModeToggle.tsx` | Agent/chat mode toggle button |
| `PrivateModeToggle.tsx` | Privacy mode lock toggle |
| `components/MentionPopover.tsx` | @-mention autocomplete dropdown |
| `components/AttachmentThumbnailStrip.tsx` | File attachment preview strip |
| `hooks/useFileAttachments.ts` | File attachment state and processing |
| `hooks/useMentionAutocomplete.ts` | Mention trigger detection and navigation |
| `hooks/useDraftPersistence.ts` | Per-session draft auto-save |
| `hooks/useTranscriptionMic.ts` | Voice transcription recording |


## Textarea Auto-Resize

The textarea automatically grows with content:
- Minimum height: 48px (single line)
- Maximum height: 384px or 35% of viewport (whichever is smaller)
- Overflow: hidden when within bounds, auto when exceeding max
- Resize occurs on text change via `resizeComposerTextarea()`


## Draft Persistence

The `useDraftPersistence` hook auto-saves draft text:
- Saves to `localStorage` keyed by session ID
- Restores on session load
- Clears on submit via `clearDraft()`


## Platform Considerations

- Voice permissions handled per-platform (see [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md))
- File MIME type detection uses both `file.type` and extension fallback
- Drag-and-drop uses counter-based tracking to handle nested elements
