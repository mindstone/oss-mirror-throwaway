---
description: "React context tree structure, available contexts, and patterns for consuming/adding new contexts"
last_updated: "2026-04-16"
---

# Context and Provider Hierarchy

> **This doc is about the React context/provider component tree in the renderer — NOT LLM
> context windows or model providers.** If you came looking for how a model is chosen, routed,
> authed, or billed across Anthropic / OpenRouter / Codex / local, start at
> [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md).

---

## See Also

- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) - Renderer state architecture, session engine internals, data flow patterns, and state layer guidelines
- [HOOK_CONVENTIONS.md](HOOK_CONVENTIONS.md) - Hook naming conventions, dependency patterns, side-effect isolation, and common pitfalls
- [UI_OVERVIEW.md](UI_OVERVIEW.md) - Main UI layout, voice/text interaction patterns, history sidebar, workspace drawer, and permissions UX
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, component responsibilities, and data flows
- [../src/renderer/components/ui/README.md](../../src/renderer/components/ui/README.md) - Shared UI component library with usage examples and design tokens

---

## Provider Tree

The renderer mounts providers in `src/renderer/main.tsx`:

```
<SentryErrorBoundary fallback={ErrorFallback}>
  <HotkeysProvider initiallyActiveScopes={['*']}>
    <ToastProvider>
      <MeetingStatusProvider>
        <FlowPanelsProvider>
          <DevPerformanceMonitor>
            <App />
              └── <AppProvider value={...}>
                    └── {feature components}
          </DevPerformanceMonitor>
        </FlowPanelsProvider>
      </MeetingStatusProvider>
    </ToastProvider>
  </HotkeysProvider>
</SentryErrorBoundary>
```

> **Note:** `React.StrictMode` wraps the tree only when `VITE_REACT_STRICT_MODE=true` in dev mode (opt-in for double-render debugging, via `npm run dev:strict`). It is **not** enabled by `dev` or `dev:perf` — StrictMode was decoupled from `VITE_PERFORMANCE` so `dev:perf` stays heap-snapshot-safe (see [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md)).

### Provider Order (outermost → innermost)

| Provider | Location | Purpose |
|----------|----------|---------|
| `SentryErrorBoundary` | `main.tsx` | Catches unhandled errors, reports to Sentry |
| `HotkeysProvider` | `main.tsx` | Keyboard shortcut scoping (`react-hotkeys-hook`) |
| `ToastProvider` | `main.tsx` | Toast notification context for the UI component library |
| `MeetingStatusProvider` | `main.tsx` | Tracks active meeting/calendar status |
| `FlowPanelsProvider` | `main.tsx` | Manages which surface/panel is active |
| `DevPerformanceMonitor` | `main.tsx` | Dev-only typing-lag and render performance monitor |
| `AppProvider` | `App.tsx` | Provides logging, toast, settings to subtree |

---

## Available Contexts

### 1. AppContext

**File:** `src/renderer/contexts/AppContext.tsx`

**Value Shape:**
```typescript
type AppContextValue = {
  emitLog: EmitLogFn;              // Structured logging to main process
  showToast: ShowToastFn;          // Display toast notification
  recordBreadcrumb: RecordBreadcrumbFn; // Add breadcrumb for error context
  settings: AppSettings | null;    // Current app settings (may be null during load)
};
```

**Consumption:**
```typescript
import { useAppContext } from '@renderer/contexts';

const MyComponent = () => {
  const { emitLog, showToast, settings } = useAppContext();
  
  const handleAction = () => {
    emitLog({ level: 'info', message: 'Action performed', timestamp: Date.now() });
    showToast({ title: 'Done!' });
  };
};
```

**Safe Variant:**
```typescript
// Returns null if outside provider (useful for optional features)
const context = useAppContextSafe();
if (!context) return null;
```

**Provider Setup (in App.tsx):**
```typescript
const appContextValue: AppContextValue = useMemo(
  () => ({ emitLog, showToast, recordBreadcrumb, settings }),
  [emitLog, showToast, recordBreadcrumb, settings]
);

return (
  <AppProvider value={appContextValue}>
    {children}
  </AppProvider>
);
```

### 2. FlowPanelsContext

**File:** `src/renderer/features/flow-panels/FlowPanelsProvider.tsx`

**Value Shape:**
```typescript
type FlowPanelsContextValue = {
  activeSurface: FlowSurface;       // 'session' | 'workspace' | 'settings' | ...
  setActiveSurface: (s: FlowSurface) => void;
  flowHistoryOpen: boolean;         // History sidebar visibility
  setFlowHistoryOpen: (open: boolean) => void;
  toggleFlowHistoryOpen: () => void;
};
```

**Consumption:**
```typescript
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';

const Navigation = () => {
  const { activeSurface, setActiveSurface } = useFlowPanels();
  return <button onClick={() => setActiveSurface('settings')}>Settings</button>;
};
```

---

## Context vs. Props Decision Matrix

| Scenario | Use Context | Use Props |
|----------|-------------|-----------|
| Data needed by many distant descendants | ✅ | ❌ |
| Data needed by 1-2 direct children | ❌ | ✅ |
| Callbacks that rarely change | ✅ | Consider both |
| Frequently changing data (e.g., cursor position) | ❌ (perf) | ✅ |
| Theme/config shared app-wide | ✅ | ❌ |

---

## Adding a New Context

### Checklist

1. **Create context file** in `src/renderer/contexts/` or feature folder:
   ```typescript
   // src/renderer/contexts/MyContext.tsx
   import { createContext, useContext, type ReactNode } from 'react';

   export type MyContextValue = {
     // Define shape
   };

   const MyContext = createContext<MyContextValue | null>(null);

   export const MyProvider = ({ value, children }: { value: MyContextValue; children: ReactNode }) => (
     <MyContext.Provider value={value}>{children}</MyContext.Provider>
   );

   export const useMyContext = (): MyContextValue => {
     const ctx = useContext(MyContext);
     if (!ctx) throw new Error('useMyContext must be used within MyProvider');
     return ctx;
   };
   ```

2. **Export from index** in `src/renderer/contexts/index.ts`:
   ```typescript
   export * from './MyContext';
   ```

3. **Add provider** to the tree (typically in `App.tsx` or `main.tsx`).

4. **Memoize value** to prevent unnecessary re-renders:
   ```typescript
   const myValue = useMemo(() => ({ ... }), [deps]);
   ```

5. **Document** in this file.

---

## Hook Patterns for Context Consumers

### Pattern: Context + Feature Hook

When a feature needs both context values and its own state:

```typescript
// In feature hook
export const useMyFeature = () => {
  const { emitLog, showToast } = useAppContext();
  const [localState, setLocalState] = useState(null);

  const doSomething = useCallback(() => {
    // Use context values
    emitLog({ level: 'info', message: 'doing something', timestamp: Date.now() });
    setLocalState('done');
    showToast({ title: 'Completed!' });
  }, [emitLog, showToast]);

  return { localState, doSomething };
};
```

### Pattern: Derived Context

When you need to expose a subset or transformed version of parent context:

```typescript
const DerivedProvider = ({ children }) => {
  const parentCtx = useParentContext();
  
  const derivedValue = useMemo(() => ({
    specificThing: parentCtx.bigObject.specificThing,
    action: () => parentCtx.complexAction('preset'),
  }), [parentCtx.bigObject.specificThing, parentCtx.complexAction]);

  return <DerivedContext.Provider value={derivedValue}>{children}</DerivedContext.Provider>;
};
```

---

## Current Context Gaps (TODO for Stage 2)

The plan calls for expanding context usage to reduce prop drilling:

| Proposed Context | Purpose | Current Location |
|------------------|---------|------------------|
| `WorkspaceContext` | Workspace path, file tree, open docs | Props from App.tsx |
| `VoiceContext` | Recording state, playback, voice mode | Props from App.tsx |
| `SessionContext` | Session actions, current session metadata | Props from App.tsx |

These will be added as part of the App Shell decomposition.

---

## Performance Considerations

### Context Re-render Behavior

When a context value changes, **all consumers re-render**. Mitigate with:

1. **Split contexts** — Separate frequently-changing values from stable ones
2. **Memoize value objects** — Prevent new object identity on every render
3. **Use selectors** (if adopting Zustand) — Only re-render when selected slice changes

### Example: Splitting Stable vs Dynamic

```typescript
// BAD: Settings rarely change but toastMessage changes often
const value = { settings, toastMessage, showToast };

// BETTER: Two contexts
<SettingsProvider value={settings}>
  <ToastProvider value={{ toastMessage, showToast }}>
    {children}
  </ToastProvider>
</SettingsProvider>
```

---
