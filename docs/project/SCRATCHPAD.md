---
description: "Scratchpad architecture and implementation — modal UI, autosave, memory-file integration, IPC handlers, note promotion"
last_updated: "2026-01-03"
---

# Scratchpad

The Scratchpad is a quick-capture modal for jotting down thoughts, ideas, and notes without interrupting your current workflow. It integrates with Rebel's memory system to help organize captured content into the right memory spaces.

## See Also

- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) - Memory write safety and approval flow
- [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) - Workspace file operations and access patterns
- [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) - Implementation details for keyboard shortcuts
- [rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md](../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md) - User-facing shortcuts reference
- `src/renderer/features/scratchpad/` - UI components and hooks
- `src/main/ipc/scratchpadHandlers.ts` - Main process IPC handlers
- `src/shared/ipc/channels/scratchpad.ts` - IPC channel definitions

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Renderer Process                     │
│  ┌────────────────────────────────────────────────────┐ │
│  │              ScratchpadModal.tsx                   │ │
│  │  - Textarea for note capture                       │ │
│  │  - "Last updated" display                          │ │
│  │  - Recent files display                            │ │
│  │  - "New Note" with LLM-suggested location          │ │
│  └────────────────────────────────────────────────────┘ │
│              │                           │               │
│              ▼                           ▼               │
│  ┌──────────────────────┐   ┌──────────────────────┐    │
│  │   useScratchpad()    │   │useRecentMemoryFiles()│    │
│  │  - Load/save content │   │ - Fetch recent files │    │
│  │  - Debounced autosave│   └──────────────────────┘    │
│  │  - Selection tracking│                               │
│  └──────────────────────┘                               │
└─────────────────────────────────────────────────────────┘
                        │ IPC
                        ▼
┌─────────────────────────────────────────────────────────┐
│                     Main Process                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │            scratchpadHandlers.ts                   │ │
│  │  - scratchpad:load   → Read scratchpad.md          │ │
│  │  - scratchpad:save   → Write scratchpad.md         │ │
│  │  - scratchpad:list-recent-memory-files             │ │
│  │  - scratchpad:suggest-location → LLM-based naming  │ │
│  └────────────────────────────────────────────────────┘ │
│                        │                                 │
│                        ▼                                 │
│              Chief-of-Staff/memory/                      │
│                   scratchpad.md                          │
└─────────────────────────────────────────────────────────┘
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘/Ctrl+Shift+N | Open Scratchpad modal |
| Escape | Close Scratchpad (saves automatically) |

The scratchpad can also be opened via the sticky note icon in the app header.

## UI Components

### ScratchpadModal

The main modal component (`src/renderer/features/scratchpad/components/ScratchpadModal.tsx`) provides:

- **Text area** for capturing notes with monospace font
- **"Last updated" display** showing when the scratchpad was last modified
- **Recent files** quick-access in the footer (up to 3 files)
- **"New Note" button** for promoting selected text to a standalone note
- **Settings access** for configuring excluded folders
- **Auto-save** with debouncing (1 second delay)

### Recent Files Section

The footer displays up to 3 recently modified files from the memory folder:
- Sorted by modification time (most recent first)
- Clicking a file closes the scratchpad and opens that file in the workspace editor
- Tooltips show the full relative path
- Settings icon opens the settings panel for folder exclusion configuration

**Note**: The IPC channel defaults to returning 5 files, but the UI currently displays only 3. Each file entry includes both an absolute `path` (for file operations) and a `relativePath` (for display).

## Scratchpad File Location

The scratchpad content is persisted at:

```
{coreDirectory}/Chief-of-Staff/memory/scratchpad.md
```

The directory structure is created automatically if it doesn't exist.

## Memory Folder Scanning

The `scratchpad:list-recent-memory-files` handler scans `Chief-of-Staff/memory/` for recent markdown files:

### Scan Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Root path | `Chief-of-Staff/memory/` | Memory folder within workspace |
| Max depth | 5 levels | Prevents deep recursion |
| File type | `.md` only | Markdown files only |
| Excluded | `scratchpad.md` | Don't list the scratchpad itself |
| Default excluded folders | `['meetings']` | Configurable via settings |

### Excluded Folders Configuration

Users can configure which folders to exclude from the "Recent Files" list:

**Via Settings** → configure in the scratchpad settings accessible from the modal footer.

**Stored in**: `AppSettings.scratchpad.excludedFolders` (default: `['meetings']`)

**Matching behavior**: Exclusions match by **folder name only** (case-insensitive), not full relative paths. For example, adding `"drafts"` to excluded folders will skip any directory named `drafts` at any level under the memory folder.

## LLM-Assisted Note Organization

The "New Note" feature uses Claude to suggest appropriate locations for notes.

### Workflow

1. Select text in the scratchpad
2. Click "New Note" (sparkle icon)
3. LLM analyzes content and suggests location
4. Confirmation dialog shows:
   - Suggested folder path
   - Suggested filename (lowercase, hyphenated)
   - Brief reasoning
5. Click "Create Note" to save

### Location Suggestion Logic

The `scratchpad:suggest-location` handler:

1. Scans existing folder structure under `Chief-of-Staff/memory/`
2. Sends content (first 1000 chars) + folder list to Claude
3. Claude suggests:
   - Existing folder if topic fits
   - New subfolder under `Chief-of-Staff/memory/topics/` otherwise
   - Descriptive, hyphenated filename (e.g., `meeting-prep-q1.md`)

### Fallback Behavior

If no API key is configured or the LLM call fails:
- Extracts keywords from first 50 characters
- Defaults to `Chief-of-Staff/memory/topics/` folder
- Generates filename from keywords (e.g., `project-budget-review.md`)

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `scratchpad:load` | Renderer → Main | Load scratchpad content |
| `scratchpad:save` | Renderer → Main | Save scratchpad content |
| `scratchpad:list-recent-memory-files` | Renderer → Main | Get recently modified memory files |
| `scratchpad:suggest-location` | Renderer → Main | LLM-suggest location for a note |

### Channel Definitions

Located in `src/shared/ipc/channels/scratchpad.ts`:

```typescript
export const scratchpadChannels = {
  'scratchpad:load': defineInvokeChannel({
    request: z.object({}),
    response: z.object({
      content: z.string(),
      exists: z.boolean(),
      lastModified: z.number().nullable(),
    }),
  }),
  'scratchpad:save': defineInvokeChannel({
    request: z.object({ content: z.string() }),
    response: z.object({ success: z.boolean() }),
  }),
  // ... etc
};
```

## Settings

Scratchpad settings are stored in `AppSettings.scratchpad`:

```typescript
interface ScratchpadSettings {
  /** Folders to exclude from recent files list */
  excludedFolders?: string[];  // Default: ['meetings']
}
```

## Integration with Workspace

### Opening Files

When a user clicks a recent file in the scratchpad footer:
1. Scratchpad closes (saving content)
2. `onOpenFile(path)` is called with the absolute file path
3. File opens in the workspace editor

### Creating Notes

The "New Note" feature:
1. Creates folder if needed via `libraryApi.createFolder()`
2. Writes file via `libraryApi.writeFile()`
3. Removes selected text from scratchpad
4. Saves updated scratchpad content
5. Refreshes recent files list

## Hooks

### useScratchpad

Primary hook for scratchpad state management:

```typescript
const {
  content,          // Current scratchpad content
  setContent,       // Update content
  loading,          // Loading state
  error,            // Error message if any
  isDirty,          // Has unsaved changes
  lastModified,     // Timestamp of last modification (ms since epoch)
  save,             // Manual save function
  load,             // Load from disk
  textareaRef,      // Ref for the textarea element
  selection,        // Current text selection
  updateSelection,
} = useScratchpad({ coreDirectory, onError });
```

### useRecentMemoryFiles

Hook for fetching recently modified memory files:

```typescript
const {
  files,    // Array of MemoryFileInfo
  loading,  // Loading state
  error,    // Error message
  refresh,  // Manual refresh function
} = useRecentMemoryFiles({ coreDirectory, enabled: isOpen });
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No workspace configured | Returns empty content silently (no-op) |
| Scratchpad file missing | Creates on first save |
| Directory doesn't exist | Created automatically on save |
| LLM call fails | Falls back to keyword-based filename |
| File write fails | Shows toast error, content preserved |

## Future Considerations

- **Search within scratchpad**: Add search/filter for long scratchpads
- **Multiple scratchpads**: Support topic-specific scratchpads
- **Rich text**: Consider markdown preview mode
- **Tags/categories**: Auto-categorize entries based on content
