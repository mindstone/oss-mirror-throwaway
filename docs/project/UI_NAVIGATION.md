---
description: "Unified navigation system: URL-based routing, type-safe navigation actions, and app surface coordination"
last_updated: "2026-03-27"
---

# UI Navigation System

The unified navigation system provides type-safe, URL-based navigation across all app surfaces.

## See Also

- [URL_PROTOCOL.md](URL_PROTOCOL.md) — Full URL scheme reference with all supported formats; includes the three-layer architecture (shared parser / core resolver / surface dispatchers)
- [UI_OVERVIEW.md](UI_OVERVIEW.md) — High-level UI layout and interaction patterns
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — State architecture including FlowSurface
- [../plans/finished/251219_unified_navigation_system.md](../plans/finished/251219_unified_navigation_system.md) — Original implementation plan (completed)
- [../plans/260416_centralize_cross_surface_links.md](../plans/260416_centralize_cross_surface_links.md) — Cross-surface link centralisation (shared parser / core resolver / surface dispatchers); source for the sync-vs-async decision tree below

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    URL String                                │
│            "rebel://settings/agents#voiceAudio"              │
└─────────────────────┬───────────────────────────────────────┘
                      │ parseNavigationUrl()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  NavigationTarget                            │
│     { type: 'settings', tab: 'agents', section: 'voiceAudio' }│
└─────────────────────┬───────────────────────────────────────┘
                      │ navigate()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              NavigationContext                               │
│   Coordinates: setActiveSurface, openSettingsDialog, etc.    │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/shared/navigation/types.ts` | `NavigationTarget` type, `SettingsTabId` |
| `src/shared/navigation/urlParser.ts` | `parseNavigationUrl()`, `formatNavigationUrl()`, `formatLibraryUrl()` — shared parser (pure, sync, import-safe on any surface) |
| `src/core/navigation/` | **Canonical navigation primitive.** Platform-agnostic resolver (`resolveLink`), share-link generator (`generateShareLink`), and preprocessor helper (`toBestFileLink`). Use this from async, side-effect flows. |
| `packages/shared/src/utils/markdownLinkHandler.ts` | `createMarkdownLinkHandler()` — sync click dispatcher for React `onClick`/`onPress`. Mirrors the shared parser's host allowlist. |
| `src/renderer/contexts/NavigationContext.tsx` | `NavigationProvider`, `useNavigation()` |
| `src/renderer/hooks/useAppNavigation.ts` | Convenience re-export |

For the full architectural picture (why each layer exists and which surfaces use which entry point), see [URL_PROTOCOL.md § Three-Layer Architecture](URL_PROTOCOL.md#three-layer-architecture).


## Usage

### Basic Navigation

```typescript
import { useAppNavigation } from '@renderer/hooks/useAppNavigation';

function MyComponent() {
  const { navigate, currentSurface } = useAppNavigation();

  // Navigate by URL string
  const openSettings = () => navigate('rebel://settings/agents');

  // Navigate by target object (type-safe)
  const openConversation = (id: string) => 
    navigate({ type: 'sessions', sessionId: id });

  return (
    <button onClick={openSettings}>Open Settings</button>
  );
}
```

### Safe Navigation (Outside Provider)

For components that may render outside `NavigationProvider` (e.g., in tests):

```typescript
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';

function SharedComponent() {
  const navigation = useNavigationSafe();

  const handleClick = () => {
    if (navigation) {
      navigation.navigate('rebel://settings');
    } else {
      // Fallback behavior
    }
  };
}
```


## NavigationTarget Types

The `NavigationTarget` discriminated union covers all navigation destinations:

```typescript
type NavigationTarget =
  | { type: 'settings'; tab?: SettingsTabId; section?: string }
  | { type: 'sessions'; sessionId?: string }
  | { type: 'library'; filePath?: string } | { type: 'library'; folderPath: string }
  | { type: 'space'; spaceName: string; filePath?: string; folderPath?: string }
  | { type: 'automations'; automationId?: string }
  | { type: 'tasks'; focusApprovalId?: string }
  | { type: 'team'; roleId?: string }
  | { type: 'focus'; lens?: 'week' | 'month' | 'quarter' }
  | { type: 'usecases'; useCaseId?: string }
  | { type: 'insights'; turnId: string }
  | { type: 'media'; resourcePath: string }
  | { type: 'feedback'; feedbackType?: 'bug' | 'improvement'; description?: string; stepsToReproduce?: string; expectedBehavior?: string }
  | { type: 'plugin'; pluginId: string; tabId?: string; params?: Record<string, string> }
  | { type: 'action'; action: string; params?: Record<string, string> };

type SettingsTabId =
  | 'system' | 'spaces' | 'meetings' | 'tools'
  | 'agents' | 'safety' | 'diagnostics' | 'usage';
```

### Navigation vs Action Targets

Navigation targets (`settings`, `sessions`, `library`, `space`, `automations`, `tasks`, `team`, `focus`, `usecases`, `insights`, `feedback`, `plugin`) open a screen or drawer. The `action` target instead fires a side-effect (e.g. widget verbs `start-voice`, `start-meeting-recording`). Per-surface dispatchers decide which action verbs they handle; unknown verbs surface an observable "unsupported" state rather than silently succeeding. See [URL_PROTOCOL.md § Navigation vs Action Intents](URL_PROTOCOL.md#navigation-vs-action-intents).

### Legacy URL Aliases

- `rebel://workspace/...` → `rebel://library/...` (backwards-compat)
- `rebel:///start-voice`, `rebel:///start-meeting-recording`, `rebel:///stop-meeting-recording` → `rebel://action/{verb}` (iOS widget pre-schema URLs)
- `rebel:///inbox-item/{id}` → `{ type: 'tasks', focusApprovalId: id }` (treated as navigation, not action)

See [260416_centralize_cross_surface_links.md](../plans/260416_centralize_cross_surface_links.md).


## URL Parsing and Formatting

### Parse URL to Target

```typescript
import { parseNavigationUrl } from '@shared/navigation';

const target = parseNavigationUrl('rebel://settings/agents#voiceAudio');
// → { type: 'settings', tab: 'agents', section: 'voiceAudio' }

const invalid = parseNavigationUrl('https://example.com');
// → null (only rebel:// URLs are valid)
```

### Format Target to URL

```typescript
import { formatNavigationUrl } from '@shared/navigation';

const url = formatNavigationUrl({ type: 'settings', tab: 'agents' });
// → 'rebel://settings/agents'

const sessionUrl = formatNavigationUrl({ type: 'sessions', sessionId: 'abc-123' });
// → 'rebel://conversation/abc-123'  (note: uses 'conversation' in URL)
```


## Sync vs Async Click Handling

Routing a `rebel://` URL to a side-effect splits across two entry points depending on the caller's execution contract. Future agents should pick the right one rather than converting between them — the async/sync boundary was an intentional architectural decision, not an oversight.

**Decision tree for future agents:** Sync context (React `onClick`, `onPress`) → use `createMarkdownLinkHandler`. Async context (IPC callback, `useEffect`, side-effect functions) → use `resolveLink` from `@core/navigation`.

This is an architectural decision, not a lapse — do not "fix" Stage I by re-introducing async click handling.

- **Sync (`createMarkdownLinkHandler`)** — `packages/shared/src/utils/markdownLinkHandler.ts`. Inspects `href.startsWith('rebel://')` + the `KNOWN_REBEL_HOSTS` allowlist mirrored from the shared parser, then fires the right `policy.onOpen*` callback immediately. Used by MessageMarkdown's link `onClick`, mobile in-message taps, and the web companion's `ConversationScreen` interceptor. React's sync click contract means this must not await anything — if async work is needed, the dispatcher schedules it *after* returning.
- **Async (`resolveLink`)** — `@core/navigation/resolveLink.ts`. Returns a fully-validated `NavigationAction` (including the result of space-name IPC resolution) so callers can dispatch without re-validating. Used by desktop side-effect flows (`useFileViewerModel`, space-resolution hooks), mobile's `linkDispatcher`, and the cloud launcher.

See [URL_PROTOCOL.md § Three-Layer Architecture](URL_PROTOCOL.md#three-layer-architecture) for the full flow and [260416_centralize_cross_surface_links.md Stage I](../plans/260416_centralize_cross_surface_links.md) for the reconciliation that landed this split.


## File Link Emission in Markdown

When preprocessing markdown for rendered messages (wikilinks, backticked paths, bare absolute paths, explicit file links), always emit URLs via `toBestFileLink` in `@core/navigation`. The helper is pure + sync so it's safe to call on every render:

```typescript
import { toBestFileLink } from '@core/navigation';

const href = toBestFileLink(rawPath, { coreDirectory, spaces, spacesReady }, 'file');
// → 'rebel://space/Exec/Q1.md'      (shareable-space file)
// → 'rebel://library/Exec%2FQ1.md'  (private/local or spaces cache not ready)
```

The helper picks the best portable form (`rebel://space/...`) for files inside shareable spaces and fails closed to `rebel://library/...` for private spaces, files outside any space, and first-render situations before the spaces cache populates. This means links emitted in chat messages work across users and surfaces without the preprocessor needing surface-specific branching. See [URL_PROTOCOL.md § Space Links](URL_PROTOCOL.md#space-links-rebelspace) for the classification rules.


## Navigation Behavior

### Settings Navigation

```typescript
navigate({ type: 'settings', tab: 'agents', section: 'voiceAudio' });
```

1. Sets `activeSurface` to `'settings'`
2. Opens settings dialog to specified tab
3. Scrolls to section (with highlight animation)

### Session Navigation

```typescript
navigate({ type: 'sessions', sessionId: 'abc-123' });
```

1. Closes settings if open
2. Triggers draft protection dialog if unsaved draft exists
3. Opens the specified conversation session

### Surface Navigation

```typescript
navigate({ type: 'library' });
navigate({ type: 'automations' });
navigate({ type: 'tasks' });
navigate({ type: 'usecases' });
```

1. Closes settings if open
2. Switches to the target FlowSurface


## Adding New Navigation Targets

1. **Add to `NavigationTarget` union** in `src/shared/navigation/types.ts`

2. **Update URL parser** in `src/shared/navigation/urlParser.ts`:
   - Add case in `parseNavigationUrl()` switch
   - Add case in `formatNavigationUrl()` switch

3. **Handle in NavigationContext** in `src/renderer/contexts/NavigationContext.tsx`:
   - Add case in `navigate()` switch
   - Wire to appropriate handler

4. **Add tests** in `src/shared/navigation/__tests__/urlParser.test.ts`

5. **Update docs**:
   - Add to URL table in [URL_PROTOCOL.md](URL_PROTOCOL.md)
   - Update this file if needed


## Known Limitations

1. **Settings auto-save**: Navigating away from settings may lose changes made within the 800ms debounce window (pre-existing issue in settings system).

2. **Advanced section deep-links**: Deep-links to sections inside collapsed "Advanced" panels don't auto-expand because the content isn't rendered when collapsed.

3. **Surface side effects**: Programmatic `setActiveSurface()` calls don't trigger the same UI side effects (e.g., `showConversation`, `flowHistoryOpen`) as user tab clicks.

See [planning doc](../plans/finished/251219_unified_navigation_system.md#known-limitations-to-address-later) for full details.
