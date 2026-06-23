---
description: "React hook conventions for Mindstone Rebel — naming patterns, feature-folder organisation, dependency rules, and best practices"
last_updated: "2026-01-10"
---

# Hook Conventions

**Last Updated:** 2025-11-26
**Purpose:** Establish naming patterns, dependency management, and best practices for React hooks in Mindstone Rebel.

---

## See Also

- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) - Renderer state architecture, session engine internals, data flow patterns, and state layer guidelines
- [CONTEXT_AND_PROVIDER_HIERARCHY.md](CONTEXT_AND_PROVIDER_HIERARCHY.md) - React context tree structure, available contexts, and patterns for consuming/adding contexts
- [UI_OVERVIEW.md](UI_OVERVIEW.md) - Main UI layout, voice/text interaction patterns, history sidebar, workspace drawer, and permissions UX
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) - IPC contract system: domain-organized handlers, typed contracts, generated preload bridge, and validation scripts
- [../src/renderer/components/ui/README.md](../../src/renderer/components/ui/README.md) - Shared UI component library with usage examples and design tokens

---

## Naming Conventions

### Standard Hooks

| Pattern | Use Case | Example |
|---------|----------|---------|
| `use<Feature>` | Simple feature state/actions | `useInbox`, `useAutomations` |
| `use<Feature>Engine` | Complex state machine with many actions | `useAgentSessionEngine` |
| `use<Feature>View` | View-specific derived state | `useWorkSurfaceView`, `useSessionHistoryView` |
| `use<Noun>State` | Isolated state management | `useComposerState` |
| `use<Noun>Search` | Search functionality | `useSessionSearch`, `useWorkspaceSearch` |

### Context Hooks

| Pattern | Use Case | Example |
|---------|----------|---------|
| `use<Context>` | Standard context consumer | `useAppContext`, `useFlowPanels` |
| `use<Context>Safe` | Returns null if outside provider | `useAppContextSafe` |

### Utility Hooks

| Pattern | Use Case | Example |
|---------|----------|---------|
| `use<Action>` | Single-purpose action | `useAudioPlayback`, `useVoiceRecording` |
| `use<Noun>Autocomplete` | Autocomplete behavior | `useMentionAutocomplete` |

---

## File Organization

```
src/renderer/features/<feature>/
├── hooks/
│   ├── use<Feature>.ts          # Main feature hook
│   ├── use<Feature>View.ts      # View-specific derived state
│   └── use<Feature>Search.ts    # Search functionality
├── utils/
│   ├── <domain>State.ts         # Pure state transformations
│   └── <domain>Helpers.ts       # Pure utility functions
└── types.ts                     # Feature-specific types
```

**Export pattern:**
```typescript
// features/<feature>/index.ts
export { useMyFeature } from './hooks/useMyFeature';
export type { MyFeatureApi } from './hooks/useMyFeature';
```

---

## Dependency Declaration Patterns

### useEffect Dependencies

**Rule:** Include all values from the component scope that the effect uses.

```typescript
// GOOD: All deps declared
useEffect(() => {
  emitLog({ level: 'info', message: 'Session changed', sessionId, timestamp: Date.now() });
}, [emitLog, sessionId]);

// BAD: Missing dependency
useEffect(() => {
  emitLog({ level: 'info', message: 'Session changed', sessionId, timestamp: Date.now() });
}, [sessionId]); // emitLog missing!
```

**Exception:** Intentionally omitting deps for "run once" effects:
```typescript
// Mount-only effect (document with comment)
useEffect(() => {
  window.api.loadAgentSessions().then(setSessions);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // Intentionally empty: load once on mount
```

### useCallback Dependencies

**Rule:** Include all closure values that could change.

```typescript
// GOOD
const handleSubmit = useCallback(() => {
  processMessage(textPrompt, attachments);
}, [processMessage, textPrompt, attachments]);

// GOOD: Stable function from context (no deps needed if context memoized)
const { showToast } = useAppContext();
const handleSuccess = useCallback(() => {
  showToast({ title: 'Done!' });
}, [showToast]);
```

### useMemo Dependencies

**Rule:** Same as useCallback — include all computed values.

```typescript
const sortedSessions = useMemo(
  () => sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
  [sessions]
);
```

---

## Side-Effect Isolation

### Pattern: Pure Reducers + Effectful Handlers

Separate state transformations from side effects:

```typescript
// utils/conversationState.ts (PURE)
export const updateConversationWithEvent = (
  state: ConversationStateShape,
  turnId: string,
  event: AgentEvent
): ConversationStateShape => {
  // Pure transformation, no side effects
  return { ...state, messages: [...state.messages, newMessage] };
};

// hooks/useAgentSessionEngine.ts (EFFECTFUL)
const processAgentEvent = useCallback((turnId, sessionId, event) => {
  // Side effect: logging
  emitLog({ level: 'debug', message: `Event: ${event.type}`, turnId, timestamp: event.timestamp });
  
  // Side effect: analytics
  if (event.type === 'result') {
    tracking.chat.turnCompleted({ turnId, sessionId });
  }
  
  // Pure transformation
  const nextState = updateConversationWithEvent(currentState, turnId, event);
  
  // Side effect: state update
  setMessages(nextState.messages);
}, [emitLog, currentState]);
```

### Pattern: Effect Modules

For complex side effects, extract into separate modules:

```typescript
// utils/analyticsTracker.ts
export const trackTurnCompleted = (turnId: string, sessionId: string, usage?: Usage) => {
  tracking.chat.turnCompleted({
    turnId,
    sessionId,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  });
};

// hooks/useAgentSessionEngine.ts
import { trackTurnCompleted } from '../utils/analyticsTracker';

// Call in event handler
if (event.type === 'result') {
  trackTurnCompleted(turnId, sessionId, event.usage);
}
```

---

## Common Pitfalls

### 1. Stale Closures

**Problem:** Callback captures old state value.

```typescript
// BAD
const [count, setCount] = useState(0);
const increment = () => setCount(count + 1); // Always uses initial count!

// GOOD
const increment = () => setCount(prev => prev + 1);
```

**Solution for complex state:** Use ref to mirror state:
```typescript
const [sessionId, setSessionId] = useState('id-1');
const sessionIdRef = useRef(sessionId);
useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

// In long-lived callback
const handler = useCallback(() => {
  console.log('Current:', sessionIdRef.current); // Always latest
}, []); // No deps needed, uses ref
```

### 2. Missing Dependencies

**Problem:** ESLint rule disabled without understanding.

**Solution:** Address the root cause:
- If callback should update when dep changes → add to deps
- If callback should NOT update → use ref pattern above
- If genuinely mount-only → add explanatory comment with disable

### 3. Circular Context Consumption

**Problem:** Provider A uses Provider B's context, and B uses A's.

```typescript
// BAD
const ProviderA = ({ children }) => {
  const { value } = useContextB(); // B not mounted yet!
  return <ContextA.Provider value={...}>{children}</ContextA.Provider>;
};
```

**Solution:** Restructure provider tree or lift shared state up.

### 4. Over-memoization

**Problem:** Wrapping everything in useMemo/useCallback.

```typescript
// UNNECESSARY
const message = useMemo(() => `Hello ${name}`, [name]); // String concat is cheap

// NECESSARY
const sortedList = useMemo(() => 
  items.slice().sort((a, b) => a.score - b.score),
  [items]
); // Sorting is expensive
```

**Rule of thumb:** Memoize when:
- Computation is expensive (O(n) or worse)
- Result is passed to memoized child (`React.memo`)
- Result is used as dependency for other hooks

### 5. Effect Cleanup Leaks

**Problem:** Async effect completes after unmount.

```typescript
// BAD
useEffect(() => {
  fetchData().then(setData); // May set state on unmounted component
}, []);

// GOOD
useEffect(() => {
  let cancelled = false;
  fetchData().then(result => {
    if (!cancelled) setData(result);
  });
  return () => { cancelled = true; };
}, []);
```

---

## Hook Return Patterns

### API Object Pattern (Preferred for Feature Hooks)

```typescript
export type MyFeatureApi = {
  // State
  items: Item[];
  isLoading: boolean;
  error: string | null;
  
  // Actions
  addItem: (item: Item) => void;
  removeItem: (id: string) => void;
  refresh: () => Promise<void>;
};

export const useMyFeature = (): MyFeatureApi => {
  // ... implementation
  return { items, isLoading, error, addItem, removeItem, refresh };
};
```

### Tuple Pattern (For Simple Hooks)

```typescript
export const useToggle = (initial = false): [boolean, () => void] => {
  const [value, setValue] = useState(initial);
  const toggle = useCallback(() => setValue(v => !v), []);
  return [value, toggle];
};
```

---

## Testing Hooks (Future)

When unit tests resume, hooks should be testable via:

1. **React Testing Library's renderHook:**
   ```typescript
   const { result } = renderHook(() => useMyFeature());
   act(() => result.current.addItem({ id: '1' }));
   expect(result.current.items).toHaveLength(1);
   ```

2. **Extracting pure logic:**
   ```typescript
   // Pure function is trivially testable
   expect(updateConversationWithEvent(state, turnId, event)).toEqual(expected);
   ```

---
