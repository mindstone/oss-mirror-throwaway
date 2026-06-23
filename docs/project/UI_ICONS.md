---
description: "Lucide icon library guidance — import conventions, sizing, currentColor styling, accessible icon-only buttons, spinners"
last_updated: "2026-05-22"
---

# Icon Library: lucide-react

Mindstone Rebel uses **[lucide-react](https://lucide.dev/)** as its single icon library for all UI icons.

## Rationale

- **Consistency**: Single library avoids mixing icon styles across the app
- **Tree-shaking**: Lucide has excellent bundle optimization, only used icons are included
- **Naming convention**: PascalCase without `Icon` suffix (e.g., `Mic` not `MicrophoneIcon`)
- **Active maintenance**: Regular updates and comprehensive icon set
- **TypeScript support**: First-class TypeScript definitions

## Import Convention

```tsx
import { Mic, Settings, ChevronDown, X } from 'lucide-react';
```

## Icon Usage

### Size Prop

Lucide icons use a `size` prop instead of separate `width`/`height`:

```tsx
// ✓ Good
<Mic size={20} />

// ✓ Also works with className
<Mic className="w-5 h-5" />

// ✗ Avoid (Heroicons pattern)
<MicrophoneIcon width={20} height={20} />
```

### Color

Icons inherit `currentColor` by default. Set color via CSS:

```tsx
<Mic className="text-blue-500" />
```

### Styling

Icons accept standard React props including `className`:

```tsx
<Settings className="w-6 h-6 text-muted-foreground hover:text-foreground transition-colors" />
```

## Common Icon Patterns

### Action Buttons

```tsx
<button type="button" onClick={handleAction}>
  <Trash2 size={16} aria-hidden />
  <span>Delete</span>
</button>
```

### Icon-only Buttons

Always include `aria-label` for accessibility:

```tsx
<button type="button" aria-label="Close dialog">
  <X size={18} />
</button>
```

### Status Indicators

```tsx
const StatusIcon = ({ status }) => {
  switch (status) {
    case 'success': return <Check className="text-green-500" />;
    case 'error': return <AlertTriangle className="text-red-500" />;
    case 'loading': return <Loader2 className="animate-spin" />;
    default: return null;
  }
};
```

### Loading Spinner

See [UI_LOADING_SPINNER.md](./UI_LOADING_SPINNER.md) for comprehensive loading spinner guidance.

Use the `Spinner` component from the UI library for consistent loading states:

```tsx
import { Spinner } from '@renderer/components/ui';

// Basic usage
<Spinner />

// With size variants (sm, md, lg)
<Spinner size="sm" />
<Spinner size="lg" />

// With accessible label
<Spinner label="Loading settings..." />
```

For inline loading indicators within other components, use `Loader2` directly:

```tsx
import { Loader2 } from 'lucide-react';

<Loader2 size={14} className="animate-spin" />
```

## Inline SVGs

For special cases (brand logos, highly custom graphics), inline SVGs are acceptable:

```tsx
// Brand icons - keep as PNG/SVG in assets
// Complex one-off graphics - inline SVG is fine
// Animation-heavy icons - may need custom SVG
```

## Semantic Icon Reference

### Privacy & Sharing

| Icon | Usage | Example |
|------|-------|---------|
| `Lock` | Private / restricted access | Memory entries, skills folders |
| `Globe` | Public / shared with everyone | Shared memory, public content |
| `Users` | Team-level sharing | Team-shared spaces |
| `Building2` | Company-wide sharing | Organization-wide content |

### Storage & Syncing

| Icon | Usage | Example |
|------|-------|---------|
| `HardDrive` | Local storage | Local-only files |
| `Link2` | Symlink / linked folder | Workspace symlinks |
| `Cloud` | Cloud provider (with color) | Dropbox, Box, iCloud |
| `CloudCog` | Unknown cloud provider | External storage |
| Brand PNGs | Major cloud providers | Google Drive, OneDrive |

Brand icons live in `src/renderer/assets/brand/`:
- `google-drive.png` - Google Drive synced folders
- `onedrive.png` - OneDrive synced folders

Cloud icons use provider-specific colors:
- Dropbox: `#0061fe` (Dropbox blue)
- Box: `#0061d5` (Box blue)  
- iCloud: `#3693f3` (iCloud blue)

### Skills & Content Types

| Icon | Usage | Example |
|------|-------|---------|
| `Sparkles` | Built-in / platform features | Rebel system skills |
| `ScrollText` | Skills section header | Skills strip/tab header |
| `Lightbulb` | Empty state / suggestions | No skills found |
| `WandSparkles` | Skill file in mentions | Autocomplete skill items |
| `ScanSearch` | File search | @files mention |
| `Play` | Run / execute | "Use This Skill" button |
| `Wrench` | Tools required | Skills tool requirements |

### Workspace & Files

| Icon | Usage | Example |
|------|-------|---------|
| `Folder` | Directory / folder | File tree folders |
| `FolderOpen` | Open/expanded folder | Workspace empty state |
| `FileText` | Generic file | File tree items |
| `FilePlus` | Create new file | Command shelf actions |
| `FolderPlus` | Create new folder | Command shelf actions |

**File type icons** (see `features/library/utils/fileTypeIcons.tsx`):
- `FileJson` - JSON files
- `FileCode` - Code files (js, ts, py, etc.)
- `Image` - Image files
- `FileVideo` / `FileAudio` - Media files
- `FileSpreadsheet` - CSV, Excel files
- `FileArchive` - Zip, tar files

### Navigation & Controls

| Icon | Usage | Example |
|------|-------|---------|
| `ChevronRight` | Collapsed / expand | Accordion headers |
| `ChevronDown` | Expanded / collapse | Accordion headers |
| `ChevronUp` | Show less | "Show fewer" buttons |
| `Plus` | Create / add new | New skill button |
| `X` | Close / dismiss | Dialog close, clear filter |
| `RefreshCw` | Refresh / reload | Memory refresh button |
| `Search` | Search | Search inputs |
| `Filter` | Filter / narrow results | History filter dropdown |
| `MoreHorizontal` | Overflow menu | Session actions menu |
| `MoreVertical` | Item actions | Library tree item menu |
| `ExternalLink` | Open externally | Document preview, external links |
| `Copy` | Copy to clipboard | Copy text, copy link |
| `ArrowUp` | Send / submit | Composer send button |
| `SendHorizontal` | Send now / interrupt | Composer send-now button, queued message send-now |

### Session History & Actions

| Icon | Usage | Example |
|------|-------|---------|
| `Inbox` | Active conversations section | Sidebar "Active" header |
| `Archive` | Archived conversations / archive action | Sidebar "Archived" header, move to archive |
| `ArchiveRestore` | Activate / unarchive action | Restore archived conversation to active |
| `Star` | Favourites | Sidebar "Favourites" header, star toggle |
| `Trash2` | Deleted / trash | Sidebar "Trash" header, delete action |

### Status & Feedback

| Icon | Usage | Example |
|------|-------|---------|
| `Check` | Success / completed | Validation success |
| `AlertTriangle` | Warning / error | Error states |
| `AlertCircle` | Error state | Connection errors, tool failures |
| `Loader2` | Loading (animated) | Async operations |
| `Brain` | Memory / AI knowledge | Library `Show: Memory` empty state |
| `MessageSquare` | Conversation | Session links, comments |
| `Info` | Informational hint | Tooltips, diagnostic info |
| `HelpCircle` | Help / troubleshooting | Safe mode support |
| `Stethoscope` | Diagnose | Conversation diagnostics dialog |

### Automations & Tools

| Icon | Usage | Example |
|------|-------|---------|
| `Zap` | Automations / quick action | Automations panel header |
| `Bot` | Agent-driven action | "Set up with Rebel" |
| `Cpu` | Model / compute | Model switcher |
| `Mail` | Email automation | Daily email digest |
| `CalendarDays` | Scheduled / meeting | Meeting status indicator |
| `Clock` | Time indicator | Time saved display |
| `Timer` | Duration / time saved | Time saved widget |

### Security & MCP Tools

| Icon | Usage | Example |
|------|-------|---------|
| `ShieldAlert` | Security approval needed | Tool approval bar |
| `Ban` | Blocked by policy | MCP blocked tools |
| `ToggleLeft` / `ToggleRight` | Enabled/disabled toggle | MCP tool enable state |
| `LogIn` | Re-authenticate | MCP re-auth prompt |

### Comments & Annotations

| Icon | Usage | Example |
|------|-------|---------|
| `MessageCircle` | Chat / replies | Community replies, chat mode |
| `MessageSquarePlus` | Add comment | Text selection comment action |
| `Send` | Send message/comments | Annotation bar send |

### Theme & Network

| Icon | Usage | Example |
|------|-------|---------|
| `Sun` / `Moon` | Theme toggle | Light/dark mode switch |
| `WifiOff` | Offline state | Offline banner |
| `Volume2` / `VolumeX` | Audio on/off | Auto-speak toggle |

### App Navigation

| Icon | Usage | Example |
|------|-------|---------|
| `StickyNote` | Scratchpad | App toolbar scratchpad button |
| `SquarePen` | New chat | App toolbar new chat button |
| `ListPlus` | Queue for later | Composer queue action |
| `ListTodo` | Tasks list | Tasks panel header |
| `RotateCcw` | Restore / retry | Inbox restore, undo actions |

## Migration Notes

This codebase was migrated from a dual-library setup (`@heroicons/react` + `lucide-react`) to lucide-react only. Common Heroicons → Lucide mappings:

| Heroicons | Lucide |
|-----------|--------|
| `MicrophoneIcon` | `Mic` |
| `StopIcon` | `Square` |
| `XMarkIcon` | `X` |
| `ChevronDownIcon` | `ChevronDown` |
| `ArrowPathIcon` | `RefreshCw` |
| `MagnifyingGlassIcon` | `Search` |
| `TrashIcon` | `Trash2` |
| `PencilSquareIcon` | `PenSquare` |
| `ExclamationTriangleIcon` | `AlertTriangle` |
| `DocumentTextIcon` | `FileText` |
| `PaperClipIcon` | `Paperclip` |

## See Also

- [UI Component Library](../../src/renderer/components/ui/README.md) - Shared UI components
- [UI_LABS_BETA_DENOTATION.md](UI_LABS_BETA_DENOTATION.md) - MaturityBadge component for Labs/Early/Beta feature indicators
- [lucide.dev/icons](https://lucide.dev/icons) - Icon search and reference
