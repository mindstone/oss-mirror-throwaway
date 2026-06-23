---
description: "High-level renderer shell, built-in surfaces, and navigation patterns"
last_updated: "2026-04-16"
---

# UI Overview

Mindstone Rebel's renderer is structured around a single **app shell** that hosts multiple **surfaces**. The current built-in surface inventory is **Home**, **Focus**, **Conversations**, **Actions**, **Automations**, **The Spark**, **Library**, **Settings**, and **Operators** (when the roles feature is enabled). Users navigate between surfaces via header tabs, while the left sidebar shows conversation history and the right drawer can show insights or document previews.

This document describes the high‑level UI layout and core interaction patterns so future changes can stay coherent with the existing design.


## See Also

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, component responsibilities, and data flows
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) - Renderer state architecture, session engine internals, data flow patterns, and state layer guidelines
- [UI_NAVIGATION.md](UI_NAVIGATION.md) - Unified navigation system: `useAppNavigation()` hook, URL parsing, and deep-linking
- [URL_PROTOCOL.md](URL_PROTOCOL.md) - Complete reference for `rebel://` URL protocols including the canonical `rebel://library/` form (plus legacy `library://` / `workspace://` reader support)
- [CONTEXT_AND_PROVIDER_HIERARCHY.md](CONTEXT_AND_PROVIDER_HIERARCHY.md) - React context tree structure, available contexts, and patterns for consuming/adding contexts
- [HOOK_CONVENTIONS.md](HOOK_CONVENTIONS.md) - Hook naming conventions, dependency patterns, side-effect isolation, and common pitfalls
- [UI_CSS_ARCHITECTURE.md](UI_CSS_ARCHITECTURE.md) - CSS architecture, design tokens, theming, and styling conventions. **Important:** See the "Theming Checklist" section when creating new components to ensure light/dark mode compatibility.
- [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) - Voice/audio pipeline (STT/TTS, permissions, playback) and provider behavior
- [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) - Library file tree, file operations, file-access permissions, and OS-level file access checks
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Agent session model, history persistence, and context-resume behavior
- [UI_SIDEBAR_SESSION_HISTORY.md](UI_SIDEBAR_SESSION_HISTORY.md) - Session sidebar UI: list display, search, filtering, pinning, and session actions
- [UI_COMPOSER_INTERACTION_STRIP.md](UI_COMPOSER_INTERACTION_STRIP.md) - Composer and interaction strip: component hierarchy, file attachments, @-mentions, voice controls, and message queue UI
- [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) - Message queue and interrupt-mode design for sending messages while an agent turn is running
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) - IPC contract system: domain-organized handlers, typed contracts, generated preload bridge, and validation scripts
- [../src/renderer/components/ui/README.md](../../src/renderer/components/ui/README.md) - Shared UI component library with usage examples and design tokens
- [UI_LOADING_SPINNER.md](./UI_LOADING_SPINNER.md) - Spinner references, shared utility, and feature-specific implementations
- [UI_SETTINGS_AND_FORMS.md](UI_SETTINGS_AND_FORMS.md) - Layout patterns, hierarchy, and component conventions for settings/form pages
- [THE_SPARK.md](THE_SPARK.md) - The Spark dashboard: coaching insights, spaces synthesis, community highlights, personalized workflows
- [INBOX_PANEL.md](INBOX_PANEL.md) - Architecture for the **Actions** surface (internal `tasks` surface ID), including deferred tasks and pending approvals. `DrawerApprovalCard` now includes a "Why?" details toggle showing a Rebel-voice explanation of why approval is needed — see [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md)
- [AUTOMATIONS.md](AUTOMATIONS.md) - Scheduled headless agent runs
- [UI_LABS_BETA_DENOTATION.md](UI_LABS_BETA_DENOTATION.md) - Feature maturity badges (Labs, Early, Beta) for indicating experimental or evolving features
- [UI_CONTEXT_MENUS.md](UI_CONTEXT_MENUS.md) - Native-style context menu pattern: when to use, design guidelines, CSS patterns, and reference implementations
- [ONBOARDING_SETUP_WIZARD.md](ONBOARDING_SETUP_WIZARD.md) - Onboarding journey, screens, and escape hatch
- [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) - Keyboard shortcut implementation patterns and available shortcuts


## Principles and Key Decisions

- **Voice‑first, text‑friendly UI**: The layout and affordances are optimized for "press to speak → agent responds" as the default, while keeping text input fully capable and easily accessible. Voice and text are always available simultaneously (no mode toggle).
- **Single window, surface-based navigation**: The renderer uses one window with one main shell (`App.tsx`) hosting multiple surfaces. Users switch surfaces via header tabs rather than multiple windows.
- **Conversation-centric**: The Conversations surface is primary; other surfaces (Home, Focus, Actions, Automations, The Spark, Library, Settings, Operators) support the main conversation workflow.
- **Parallel, but understandable workflows**: Voice, text, message queuing, and file operations are surfaced through a small set of consistent controls so users can predict what happens next.
- **Non‑destructive by default**: Actions that change files or sessions are explicit (e.g. create/rename/delete), with clear affordances and minimal risk of accidental destructive operations.
- **Responsive, but desktop‑first**: Layouts favor desktop/laptop usage, with CSS that adapts to narrower viewports.


## High‑Level Layout

The UI is organized around **Flow Panels** - a shell that manages multiple surfaces and resizable sidebars.

**Key code locations:**
- `src/renderer/features/flow-panels/FlowPanelsShell.tsx` - Main shell component
- `src/renderer/features/flow-panels/FlowPanelsProvider.tsx` - Surface state context
- `src/renderer/styles/layout/app-shell.css` - Layout styles
- `src/renderer/App.tsx` - Top-level orchestration

### Layout Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Brand | Surface Tabs | Actions (Settings, etc.)        │
├──────────────┬──────────────────────────────┬───────────────────┤
│              │                              │                   │
│  Sessions    │     Active Surface           │   Insights /      │
│  Sidebar     │     (Home, Conversations,    │   Document        │
│  (history)   │      Actions, Library, etc.) │   Preview         │
│              │                              │   (optional)      │
│              │                              │                   │
├──────────────┴──────────────────────────────┴───────────────────┤
│  Interaction Strip: Mic | Composer | Session Controls           │
└─────────────────────────────────────────────────────────────────┘
```

**CSS classes:**
- `.app-shell` - Main container
- `.app-header` - Fixed header row
- `.flow-body` - Grid body containing columns
- `.flow-column--sessions` - Left sidebar (collapsible, ~340px)
- `.flow-main` - Center surface area
- `.flow-column--insights` - Right drawer (resizable, optional)


## UI Surfaces

The app currently has **nine built-in surfaces** (plus optional plugin surfaces shown in the overflow menu when registered).

**Canonical surface IDs** come from `src/renderer/features/flow-panels/constants.ts`:

```typescript
export const FLOW_SURFACES = ['home', 'focus', 'sessions', 'usecases', 'library', 'automations', 'tasks', 'team', 'settings'] as const;
```

**Current tab labels** are defined in `src/renderer/App.tsx`, so some surface IDs intentionally differ from user-facing copy:

| Surface ID | Current UI Label | Icon | Notes / Purpose |
|------------|------------------|------|-----------------|
| `home` | Home | Home | Landing surface with recommendations, summaries, and entry points into active work |
| `focus` | Focus | Target | Goal and planning surface; only shown when the experimental focus flag is enabled |
| `sessions` | Conversations | MessageSquare | Primary chat surface; start new conversations and resume history |
| `tasks` | Actions | Inbox | Saved action items, approvals, and deferred execution. Internal ID remains `tasks` for compatibility |
| `automations` | Automations | Zap | Scheduled or triggered background runs |
| `team` | Operators | Users | Operators surface; only shown when the roles feature flag is enabled |
| `usecases` | The Spark | Rocket | Suggestions, coaching insights, and quick links |
| `library` | Library | FolderOpen | Unified file workspace with lens controls (`Show` × `View as`) |
| `settings` | Settings | Settings | App configuration and diagnostics |

### Onboarding / Coach Mode

During first-run onboarding, the UI enters "coach mode" which hides the sidebar and surface tabs to provide a focused voice-first experience. Normal navigation becomes available after onboarding completes.

### Library Lens

The Library surface now uses a two-axis lens bar:

- **Show:** `Spaces`, `Skills`, `Memory`, `Everything`
- **View as:** `Folders`, `Cards`, `Atlas`

This replaces the old scope-tab model. The same underlying files remain visible; the lens chooses slice (`Show`) and representation (`View as`).

Stage 5B behavior details:

- **Filter-aware create action (`+`)**
  - `Show: Memory` seeds a new chat with `Remember this: `
  - `Show: Spaces` deep-links to Settings → Spaces and opens Add Space via a pending intent model
- **Filter-aware sort options**
  - Skills cards: `Suggested`, `Most used`, `Most polished`, `A-Z`
  - Memory cards: `Most recent`, `Date created`, `Alphabetical` (`Most relevant` appears only while searching)
  - Spaces cards: `Name`, `Last active`
- **Classified reveal actions** use “Show in …” labels and route to the matching lens filter.


## Session Sidebar and History

The **session sidebar** (left column) organizes conversations as durable "sessions" aligned with the session model in `ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md`.

**Key code:** `src/renderer/features/agent-session/components/AgentSessionSidebar.tsx`

- **Session list**: Vertical list with title, preview snippet, timestamp, and status dots (idle/thinking)
- **Selection**: Clicking switches the active session; styling distinguishes the active entry
- **Actions**: Hover reveals delete, pin, and other session actions
- **Collapsible**: Sidebar can be collapsed to maximize surface area

See [UI_SIDEBAR_SESSION_HISTORY.md](UI_SIDEBAR_SESSION_HISTORY.md) for detailed behavior.


## Conversation Pane and Messages

The **conversation surface** displays the message log for the active session. See [UI_CONVERSATIONS](UI_CONVERSATIONS.md) for full details on component boundaries, data flow, auto-scroll architecture, and the dual turn ID model.

**Key code:** `src/renderer/features/agent-session/components/MessageItem.tsx`

### Message Display

- Messages use the class `agent-turn-message` with a `data-role` attribute (`user`, `assistant`, or `result`)
- User messages align right with accent styling; assistant messages align left
- Body content renders via `MessageMarkdown` supporting Markdown and internal links (canonical `rebel://library/` plus legacy `library://` / `workspace://` for back-compat)
- Result/summary messages may show token usage (development builds only)

### Status and Events

Tool usage, context compaction, errors, and other events are grouped into collapsible sections to keep the main transcript clean while exposing details for debugging.


## Interaction Strip and Composer

The **interaction strip** at the bottom is the main input surface.

**Key code:**
- `src/renderer/features/composer/InteractionStrip.tsx` - Container with mic and composer
- `src/renderer/features/composer/ComposerWithState.tsx` - Text input with @-mentions, attachments

### Voice Controls

- External mic button with audio level visualization
- States: idle, recording, processing
- Push-to-talk or toggle modes available
- See [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) for underlying behavior

### Text Input

- Multi-line composer with @-mention autocomplete
- File attachments via drag-drop or button
- Send button (or Enter) starts a turn when agent is idle
- When busy, shows queued message count and interrupt options

### Session Controls

- Speaker toggle (TTS on/off)
- Private mode toggle
- Auto-done toggle
- Stop button during active turns

### Model Tier Selector

The conversation header includes a **quality tier selector** (`ConversationModelSelector.tsx`) that maps user-friendly tiers (Quick/Balanced/Thorough/Maximum) to model configurations. Model roles are labeled **Working** (main execution model) and **Thinking** (planning/reasoning model) — renamed from the earlier "Main" and "Deep reasoning" labels to align with multi-provider terminology. See `src/shared/data/qualityTiers.ts` and `src/renderer/hooks/useModelRoles.ts`.

See [UI_COMPOSER_INTERACTION_STRIP.md](UI_COMPOSER_INTERACTION_STRIP.md) for detailed component documentation.

### Keyboard Shortcuts

The composer supports context-sensitive shortcuts:
- **Alt/Option+Enter**: Queues the message while busy (same as Enter). Send-now/interrupt is button-only (no keyboard shortcut as of 2026-06-06).
- **Escape / double Escape**: Stop voice/turn controls
- **@-mention navigation**: ArrowUp/Down, Enter/Tab, Escape

See [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) for the full shortcut reference and implementation details.


## Message Queue and Interrupt UI

The message queue lets users queue additional messages while the agent is busy.

**Key code:** `src/renderer/features/composer/QueuedMessagesTray.tsx`

- **Queue tray**: Expandable panel showing pending messages with remove/clear actions
- **Send behavior**: while busy, Enter and Alt+Enter both queue; send-immediately/interrupt is the **Send now** button only
- **Queue indicator**: Badge showing count of queued messages

See [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) for the underlying model.


## Library Surface

The **Library** surface provides access to files in the configured core directory. (Note: Internal code may reference "workspace"; user-facing terminology is "Library".)

**Key code:** `src/renderer/features/library/`

- **Lens controls**: `Show` chips + `View as` chips in `LibraryLensBar` (replaces legacy scope tabs)
- **File tree**: Navigate folders, open files
- **Editor**: View and edit files with syntax highlighting and Markdown preview
- **Context menus**: Create/rename/delete files and folders
- **Cards resiliency**: Memory/Spaces cards show loading/error states from their own data sources instead of falling through to empty-state copy

See [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) for file operations and access checks.


### Document Annotations

Rebel has **two** annotation surfaces, intentionally distinct but sharing a single formatter:

- **Conversation annotations** — highlight text inside an AI reply and send it back as context.
- **Document annotations** — highlight + comment on selections inside a markdown file, then Send to Rebel with the file itself still open for editing.

**Shared primitives (single source of truth):** `packages/shared/src/annotationUtils.ts` owns `generateAnnotationId`, `formatAnnotationMessage`, and `buildAnnotationMessageSafe`. The formatter wraps untrusted file/comment text in a nonce-sealed fence with a trusted prologue (injection hardening); `buildAnnotationMessageSafe` retries 3× on fence collision and then throws `AnnotationFormatExhaustionError` — call sites abort the send and surface a toast rather than silently dropping content.

**Key code:**
- `src/renderer/features/library/extensions/tiptapAnnotationExtension.ts` — ProseMirror plugin for document annotations (adds `clearIds` meta + `dispatchClearStagedAnnotations`, throws `EditorUnmountedError` on dead editor)
- `src/renderer/features/library/hooks/useTipTapAnnotations.ts` — polymorphic `clearAnnotations(ids?)`, re-reads the React snapshot from PM state post-dispatch
- `src/renderer/features/document-editor/components/DocumentFooter.tsx` — snapshots staged IDs at Send click and commits the clear via an async `onCommit` that also flushes persistence
- `src/renderer/features/agent-session/hooks/useConversationAnnotations.ts` + `components/AnnotationOrchestrator.tsx` — same formatter, same abort-on-exhaustion contract for the conversation surface

**Dispatch-commit contract:** document annotations do **not** clear when the user clicks Send. They clear only after the message actually dispatches (`processMessage`/`rerunEditedMessage` resolves). This is wired through the per-message `onCommit` callback on `QueuedMessage` — see [ARCHITECTURE_MESSAGE_QUEUE.md § Per-message `onCommit`](ARCHITECTURE_MESSAGE_QUEUE.md#per-message-oncommit-callback). The user can still back out by editing or abandoning the composer. App.tsx accumulates per-session onCommit callbacks (`Map<sessionId, Array<…>>`) and drops them on session delete, draft discard, or composer-empty transitions.


## Right-Side Drawers

The right column can show contextual panels:

### Insights Drawer

- Shows details for a specific turn: thinking process, tool usage, timing
- Opens via turn menu or `rebel://insights/{turnId}` URL

### Document Preview Drawer

- Preview files without leaving the current surface
- Supports Markdown, code, and other previewable formats


## Permissions and Onboarding

Permissions are surfaced through banners and the onboarding wizard.

**Key code:** `src/renderer/PermissionComponents.tsx`, `src/renderer/features/onboarding/`

- **Permission banner**: Fixed at top when mic or file access needs attention
- **Onboarding wizard**: Multi-step flow for first-run setup (see [ONBOARDING_SETUP_WIZARD.md](ONBOARDING_SETUP_WIZARD.md))

### Escape Hatch Hotkey

A secret hotkey (`Cmd/Ctrl + Shift + Alt/Option + E`) provides emergency escape from:
- **Onboarding wizard**: Skip onboarding if something goes wrong
- **Login screen**: Enter guest mode if auth is problematic

Intended for support staff; not documented to users. See [ONBOARDING_SETUP_WIZARD.md](ONBOARDING_SETUP_WIZARD.md) for full details.


## Startup and Auth

### Startup Loading

Startup uses a two-step loading UI:
1. **HTML spinner** (`#app-loading` in `index.html`) - shown immediately until React mounts
2. **React splash** (`.app-loading-splash` in `App.tsx`) - shown while settings initialize, with recovery dialogs if startup stalls

**Key code:** `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`

### Auth Gating

The renderer is wrapped in `AuthGate` (`src/renderer/features/auth/components/AuthGate.tsx`), which:
- Shows a spinner while auth initializes
- Renders `LoginScreen` when unauthenticated (unless guest mode is enabled)
- Renders children when authenticated or in guest mode


## Error Boundaries

Crashes are contained at multiple levels to prevent one failure from taking down the entire app:

- **Global boundary**: `SentryErrorBoundary` in `main.tsx` with `ErrorFallback` offering reload/restart recovery
- **Per-surface boundary**: `SurfaceErrorBoundary` wraps each surface so one can fail independently with "Try again" reset

**Key code:** `src/renderer/main.tsx`, `src/renderer/features/app-shell/components/SurfaceErrorBoundary.tsx`


## Focus Restoration

When inline approval bars or dialogs close, focus returns to the composer so users can continue typing immediately.

**Pattern**: A reactive `useEffect` in `App.tsx` watches state arrays (e.g., `deniedOperations.length`) becoming empty, then calls `focusComposer()`. Guards prevent false triggers during session switches.


## Toasts and Banners

The UI uses consistent patterns for transient messages:

- **Error banner**: Inline within the conversation area for conversation-scoped errors. Shows user-friendly summary; full diagnostics go to logs.
- **Toast notification**: Bottom-of-window toast for transient global messages ("Copied to clipboard", etc.). Uses shared `showToast()` helper.
- **Severity**: Banners for errors requiring follow-up; toasts for success/info messages.

**Toast infrastructure**: `src/renderer/main.tsx` wraps the app with `<ToastProvider />`.

### End-of-Turn Banners (Silent Stop Detection)

When an agent turn ends with incomplete tasks, the `ContextualProgressCard` displays a **differentiated banner** based on a 5-category classification from `detectSilentStop()`:

| Classification | Banner Text | Icon | Visual Style | Continue Offered? |
|----------------|-------------|------|--------------|-------------------|
| `none` | *(no banner)* | — | — | No |
| `user_stopped` | "Stopped by you — N steps remaining" | StopCircle | Info (muted) | Yes |
| `awaiting_user` | "Waiting for you — N steps remaining" | MessageSquare | Info (muted) | No (user should answer) |
| `error_exit` | *(defers to existing error handling)* | — | — | No |
| `unexpected_stop` | "Stopped — N steps remaining" | AlertTriangle | Warning (amber) | Yes |

The **Continue** button appears only for `user_stopped` and `unexpected_stop` classifications, only on the last turn, and only when no turn is currently processing. It sends a continuation message to resume incomplete work.

**Key code:**
- `src/renderer/features/agent-session/utils/detectSilentStop.ts` — classification logic and `canOfferContinue()` eligibility
- `src/renderer/features/agent-session/components/ContextualProgressCard.tsx` — banner rendering and analytics tracking

See also:
- [LOGGING.md](LOGGING.md) - Logging pipeline and error diagnostics
- [RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md](RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md) - Error handling and recovery


## Navigation

The app uses a **unified navigation system** for programmatic navigation and deep-linking.

**Key code:** `src/shared/navigation/types.ts`, `src/shared/navigation/urlParser.ts`

### URL Protocol

All surfaces support `rebel://` URLs:

| URL Pattern | Target |
|-------------|--------|
| `rebel://conversation/{sessionId}` | Open specific conversation |
| `rebel://sessions[/{sessionId}]` | Alias for conversation |
| `rebel://settings[/tab][#section]` | Settings (optionally with tab and section scroll) |
| `rebel://library[/{path}]` | Library, optionally opening a file or folder |
| `rebel://workspace[/{path}]` | Legacy alias for library |
| `rebel://automations[/{id}]` | Automations surface |
| `rebel://focus[/week|month|quarter]` | Focus surface |
| `rebel://tasks` | Actions surface (internal `tasks` route name) |
| `rebel://team[/{roleId}]` | Operators surface |
| `rebel://usecases[/{id}]` | The Spark surface |
| `rebel://insights/{turnId}` | Open insights drawer |
| `rebel://media/{resourcePath}` | Media content |

See [URL_PROTOCOL.md](URL_PROTOCOL.md) for complete URL reference including query parameters.

> **Note:** There is currently no dedicated `rebel://home` deep-link target. Home is the default landing surface, but the typed URL parser only supports the routes listed above.

### Programmatic Navigation

```typescript
const { navigate, currentSurface } = useAppNavigation();

// Navigate by URL
navigate('rebel://settings/agents#voiceAudio');
navigate('rebel://tasks');

// Navigate by object (type-safe)
navigate({ type: 'sessions', sessionId: 'abc-123' });
navigate({ type: 'library', filePath: 'skills/my-skill.md' });
navigate({ type: 'focus', lens: 'week' });
```

See [UI_NAVIGATION.md](UI_NAVIGATION.md) for full details on URL formats and `NavigationTarget` types.
