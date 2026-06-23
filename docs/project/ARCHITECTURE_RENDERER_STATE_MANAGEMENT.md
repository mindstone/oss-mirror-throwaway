---
description: "Renderer state-management guide — React state layers, Zustand session store, lazy session loading, persistence patterns"
last_updated: "2026-05-01"
---

# Renderer State Management

**Last Updated:** 2026-04-10  
**Purpose:** Guide LLM coding agents through the renderer's state architecture, patterns, and data flow.

> **Stage 7b Lazy Loading (2026-01-27):** The renderer now uses lazy session loading to reduce memory from 5.5GB to ~31MB for 720 sessions. Key changes:
> - `sessionSummaries` is the source of truth for sidebar display (lightweight metadata)
> - `loadedSessions` LRU cache (30 sessions) holds full session data  
> - Sessions load on-demand via `sessions:get` IPC when opened
> - `agentSessions` array is deprecated (kept for backward compat during migration)

---

## Overview

Mindstone Rebel's renderer uses a layered state model:

| Layer | Scope | Examples | Persistence |
|-------|-------|----------|-------------|
| **React Local State** | Single component | UI toggles, form inputs, animation state | None |
| **Context** | Subtree of components | `AppContext` (logging, toasts), `FlowPanelsProvider` (surface navigation) | None |
| **Zustand Store** | Feature-wide | `useSessionStore` (agent session state) | Disk via IPC |
| **Feature Hooks** | Feature boundary | `useAgentSessionEngine`, `useSettingsFeature`, `useInbox` | Disk via IPC |
| **Shared Types** | Cross-process | `AgentSession`, `AppSettings`, `InboxItem` | Defined in `src/shared/types.ts` |

The agent session state is managed via **Zustand** (`src/renderer/features/agent-session/store/`). Other features continue to use hooks with `useState`/`useRef` and persist via `window.api` IPC calls.

## See Also

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, major components, and data flows
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) - IPC contract system, domain-organized handlers, typed contracts, and validation scripts
- [CONTEXT_AND_PROVIDER_HIERARCHY.md](CONTEXT_AND_PROVIDER_HIERARCHY.md) - React context tree structure, available contexts, and patterns for adding new contexts
- [HOOK_CONVENTIONS.md](HOOK_CONVENTIONS.md) - Hook naming conventions, dependency patterns, side-effect isolation, and common pitfalls
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Agent session model, history persistence, and context-resume behavior
- [ZUSTAND_REFERENCE](../research/libraries/ZUSTAND_REFERENCE.md) - Deep-dive on Zustand patterns, middleware, and best practices

---

## Zustand Store Architecture (Agent Session)

The agent session engine uses Zustand for centralized state management, enabling:
- **Testability:** Store can be used outside React (see CLI replay harness)
- **Fine-grained selectors:** Components subscribe to specific slices, reducing re-renders
- **DevTools:** State inspection via Zustand devtools (dev mode only)

### Store Structure

```
src/renderer/features/agent-session/store/
├── index.ts                    # Public exports
├── sessionStore.ts             # Zustand store definition
├── reducers/
│   ├── index.ts
│   ├── conversationReducer.ts  # Message/event state transformations
│   ├── runtimeReducer.ts       # Turn timing and busy state
│   └── historyReducer.ts       # Session list operations
└── effects/
    ├── index.ts
    ├── persistenceManager.ts   # Load/save sessions via IPC
    ├── analyticsTracker.ts     # Turn completion/error tracking
    └── toastNotifications.ts   # User feedback toasts
```

### Store Slices

The store combines several state slices:

```typescript
type SessionStoreState = 
  ConversationStateShape &  // messages, eventsByTurn, activeTurnId (processing) + focusedTurnId (focus, ephemeral), isBusy, lastError
  SessionMetaState &        // currentSessionId, currentSessionTitle, currentSessionOrigin, etc.
  UIState &                 // showConversation, editingMessageId, isStopping, busyElapsedMs
  {
    runtime: SessionRuntimeState;
    // Stage 7b Lazy Loading:
    sessionSummaries: AgentSessionSummary[];  // SOURCE OF TRUTH for sidebar (lightweight)
    loadedSessions: Map<string, AgentSessionWithRuntime>;  // LRU cache (30 sessions max)
    agentSessions: AgentSessionWithRuntime[];  // DEPRECATED - kept for backward compat
  };
```

#### Stage 7b Data Flow

```
┌─────────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│   Sidebar UI    │ ───▶ │  sessionSummaries   │ ◀─── │  sessions:list  │
│  (lightweight)  │      │  (source of truth)  │      │     (IPC)       │
└─────────────────┘      └─────────────────────┘      └─────────────────┘

┌─────────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│  Conversation   │ ───▶ │   loadedSessions    │ ◀─── │  sessions:get   │
│      Pane       │      │   (LRU cache)       │      │     (IPC)       │
└─────────────────┘      └─────────────────────┘      └─────────────────┘
```

**Key patterns:**
- Sidebar derives from `sessionSummaries` (never `agentSessions`)
- Opening a session checks `loadedSessions` first, then loads via IPC
- Metadata changes (pin/star/delete/rename) update BOTH `sessionSummaries` AND persist via IPC upsert
- The current session is always in `loadedSessions` after first message

### Using the Store

```typescript
import { useSessionStore } from '../store';
import { useShallow } from 'zustand/react/shallow';

// Select specific state slices to prevent unnecessary re-renders
const { messages, isBusy } = useSessionStore(
  useShallow((s) => ({ messages: s.messages, isBusy: s.isBusy }))
);

// Call actions via getState()
const handleReset = () => {
  useSessionStore.getState().resetSession();
};
```

### Pure Reducers

Reducers are pure functions that transform state without side effects:

```typescript
// conversationReducer.ts
export const processEvent = (
  state: ConversationStateShape,
  turnId: string,
  event: AgentEvent
): ConversationStateShape => updateConversation(state, turnId, event);
```

### Side Effects

Side effects are separated from the store and triggered via subscriptions:

```typescript
// In useAgentSessionEngine - current session persistence
useEffect(() => {
  const unsubscribe = store.subscribe(
    (state) => ({ messages: state.messages, eventsByTurn: state.eventsByTurn }),
    () => scheduleIdleSave() // Debounced save of current session
  );
  return unsubscribe;
}, []);
```

**Stage 7b persistence model:**
- **Current session:** Saved via debounced `scheduleIdleSave()` on message/event changes
- **Non-current sessions:** Metadata changes persist immediately via `sessions:upsert` IPC
- **Startup:** Only loads `sessionSummaries` via `sessions:list` (not full sessions)
- **Session opening:** Loads full session via `sessions:get` IPC, caches in `loadedSessions`

### CLI Replay Harness

The store can be used without React for testing:

```bash
npm run replay:session-trace <trace.json>
```

This replays events through the store and outputs the final state, useful for regression testing.

---

## Key State Domains

### 1. Agent Session Engine

**Store:** `src/renderer/features/agent-session/store/sessionStore.ts`  
**Hook:** `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts`

This is the core state machine for agent conversations. It manages:

- **Conversation state:** `messages`, `eventsByTurn`, `activeTurnId` (processing turn), `focusedTurnId` (focus turn — renderer-only, ephemeral, stripped on persist)
- **Runtime state:** `isBusy`, `isStopping`, `busyElapsedMs`, `currentRuntime`
- **Session metadata:** `currentSessionId`, `currentSessionTitle`, `currentSessionOrigin`
- **History:** `agentSessions` (array of past sessions with runtime info)
- **UI state:** `showConversation`, `editingMessageId`, `error`

**State Shape:**

```typescript
// Conversation state (per-session)
// Post-C-lite (2026-04-30): activeTurnId means PROCESSING only; focusedTurnId
// carries the renderer-only FOCUS semantics (stripped on persist). See
// docs/project/UI_CONVERSATIONS.md § Dual Turn ID Model and
// docs/plans/260430_isbusy_stale_active_turn_id_root_cause_fix.md.
type ConversationStateShape = {
  messages: AgentTurnMessage[];        // User + assistant messages
  eventsByTurn: Record<string, AgentEvent[]>; // Raw events keyed by turnId
  activeTurnId: string | null;         // PROCESSING turn (the one the agent runtime is executing)
  focusedTurnId: string | null;        // FOCUS turn (user click target); renderer-only, ephemeral, stripped on persist
  isBusy: boolean;                     // Turn in progress
  lastError: string | null;            // Most recent error
};

// Runtime state (transient, not persisted)
type SessionRuntimeState = {
  startedAt: number | null;            // Turn start timestamp
  lastActivityAt: number | null;       // Last event timestamp
  activeTurnId: string | null;         // Redundant but convenient
};

// Full session (includes runtime for active sessions)
type AgentSessionWithRuntime = AgentSession & {
  runtime?: SessionRuntimeState;
  isCorrupted?: boolean;
};
```

**Data Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│                        IPC Event Listener                       │
│              window.api.onAgentEvent(callback)                  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     processAgentEvent()                         │
│  - Resolves sessionId from turnId                               │
│  - Logs event + records breadcrumb                              │
│  - Routes to active session OR history session                  │
│  - `turn_started` flows through normal event pipeline           │
│    (no special interception — sets isBusy/activeTurnId via      │
│    conversation + runtime reducers generically)                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
              ▼                                       ▼
┌─────────────────────────────┐       ┌─────────────────────────────┐
│   Active Session Update     │       │   History Session Update    │
│   updateConversationWithEvent│      │   (via setAgentSessions)    │
│   applyEventToRuntime       │       │                             │
└─────────────────────────────┘       └─────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     React State Updates                         │
│   setMessages, setEventsByTurn, setIsBusy, etc.                 │
└─────────────────────────────────────────────────────────────────┘
```

**Persistence:**

- On change: `agentSessions` auto-saves with 300ms debounce via `window.api.saveAgentSessions()`
- On load: `window.api.loadAgentSessions()` hydrates history at mount
- On unload: `beforeunload` handler snapshots current conversation

### 2. Settings State

**File:** `src/renderer/features/settings/hooks/useSettingsFeature.ts`

Manages `AppSettings` which includes workspace path, MCP config, voice settings, analytics preferences, etc.

**Pattern:**
```typescript
// Load on mount
useEffect(() => {
  window.api.getSettings().then(setSettings);
}, []);

// Save on change (typically via explicit save action)
const updateSetting = async (key, value) => {
  await window.api.setSetting(key, value);
  setSettings(prev => ({ ...prev, [key]: value }));
};
```

### 3. Inbox & Automations

**Files:**
- `src/renderer/features/inbox/hooks/useInbox.ts`
- `src/renderer/features/automations/hooks/useAutomationsCrud.ts` (split into focused sub-hooks with adaptive polling)

Both follow a similar pattern: poll or subscribe for updates, local state mirrors main-process store. The automations hook uses adaptive polling intervals and tracks `busyElapsedMs` locally to reduce IPC overhead.

### 4. Workspace State

**File:** `src/renderer/features/library/hooks/useLibraryIndex.ts`

Manages file tree, open documents, and workspace root path. Updates via IPC calls to workspace handlers.

---

## Session Lifecycle

```
┌──────────┐   resetSessionState()   ┌──────────┐   IPC: run-agent   ┌──────────┐
│  Empty   │ ──────────────────────► │  Ready   │ ─────────────────► │ Running  │
│ Session  │                         │ (new ID) │                    │ (isBusy) │
└──────────┘                         └──────────┘                    └────┬─────┘
                                                                          │
     ┌────────────────────────────────────────────────────────────────────┘
     │
     │  event.type === 'result' OR 'error'
     ▼
┌──────────┐   snapshotCurrentConversation()   ┌──────────┐
│ Resolved │ ────────────────────────────────► │ History  │
│ (!isBusy)│   (on session switch/new run)     │ (saved)  │
└──────────┘                                   └──────────┘
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `resetSessionState()` | Creates new session ID, clears conversation, archives current if non-empty |
| `handleUserMessage()` | Sends user input to agent, starts turn, updates state optimistically |
| `stopActiveTurn()` | Signals main process to abort, marks turn as stopped |
| `openHistorySession()` | Switches active view to a past session |
| `deleteHistorySession()` | Removes from history, resets if it was active |
| `snapshotCurrentConversation()` | Returns current session with runtime stripped |

---

## Pure Utilities vs. Stateful Hooks

The codebase separates **pure transformation functions** from **stateful hooks**:

### Pure Utilities (no side effects)

Located in `src/renderer/features/agent-session/utils/`:

- `conversationState.ts` — `updateConversationWithEvent()`, `mergeResultMessage()`
- `runtimeState.ts` — `applyEventToRuntime()`, `createRuntimeState()`
- `sessionTitle.ts` — `createSessionTitle()`

These are safe to call anywhere and easy to test in isolation.

#### `turn_started` event handling

The `turn_started` event (emitted by `executeAgentTurn()` before any model/MCP work) flows through the normal event pipeline — no special interception in `processAgentEvent()`. In the conversation reducer (`updateConversationWithEvent()`), it sets `isBusy = true`, `activeTurnId`, and clears errors, respecting the terminal guard. In the runtime reducer (`applyEventToRuntime()`), it primes the runtime with a dedicated handler that bypasses the cross-turn guard (since it represents a new turn lifecycle start). This replaces the previous safety-net fallback in `processAgentEvent()` that auto-detected server-started turns from their first content event. See `docs/plans/260409_turn_started_event_broadcast.md`.

### Stateful Hooks

Located in `src/renderer/features/*/hooks/`:

- Manage `useState`, `useRef`, `useEffect`
- Call `window.api` for persistence
- Return an "API object" of state + actions

---

## Guidelines for State Changes

### When to Use Local State
- UI-only concerns (hover, focus, animation)
- Form inputs before submission
- Transient display flags

### When to Use `localStorage`
- Small, device-local UI preferences that are safe to lose (view modes, dismissed banners, panel widths, filter prefs).
- Do **not** use for user-created content, large/unbounded data, cross-process state, or anything needing schema migration. Use IPC-backed persistence instead.
- See [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) for the full policy.

### When to Use Context
- Cross-cutting concerns needed by many components (logging, toasts)
- Feature-wide state that multiple siblings need (flow panel navigation)

### When to Use Feature Hooks
- Domain state with persistence requirements
- Complex state machines (agent session)
- State shared across multiple components in a feature

### Anti-patterns to Avoid
- **Prop drilling callbacks:** Use context instead of threading `emitLog`, `showToast` through 5+ levels
- **Storing derived state:** Compute from source data in render or `useMemo`
- **Refs for render-triggering data:** Use `useState` if UI should update on change
- **Mixing concerns:** Keep analytics/logging as side effects, not interleaved with state transitions

---

## Refs vs State

The session engine uses both extensively:

| Use Case | Mechanism | Example |
|----------|-----------|---------|
| UI should re-render | `useState` | `messages`, `isBusy` |
| Stable across renders, no re-render needed | `useRef` | `turnSessionMapRef`, `breadcrumbsRef` |
| Callback needs latest value without dep array | `useRef` + sync effect | `currentSessionIdRef` mirrors `currentSessionId` |

Pattern for keeping refs in sync:
```typescript
const [currentSessionId, setCurrentSessionId] = useState(() => createId());
const currentSessionIdRef = useRef(currentSessionId);

// Mirror state to ref for callbacks
useEffect(() => {
  currentSessionIdRef.current = currentSessionId;
}, [currentSessionId]);
```

---

## Related Docs

- `docs/project/CONTEXT_AND_PROVIDER_HIERARCHY.md` — Provider tree and available contexts
- `docs/project/HOOK_CONVENTIONS.md` — Naming and dependency patterns
- `docs/project/ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` — Session persistence format
- `src/shared/types.ts` — Canonical type definitions
