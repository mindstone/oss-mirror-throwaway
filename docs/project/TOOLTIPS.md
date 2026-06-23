---
description: "Tooltip usage guidance for Rebel UI — custom Tooltip component, native title tradeoffs, accessibility, theming"
last_updated: "2026-05-23"
---

# Tooltips

Guidance for using tooltips in Mindstone Rebel, including when to use our custom `<Tooltip>` component vs native `title` attributes.

## See Also

- [UI Component Library](../../src/renderer/components/ui/README.md) - Full component documentation
- [KEYBOARD_SHORTCUTS.md](./KEYBOARD_SHORTCUTS.md) - Shortcut hints in tooltips
- [UI_ICONS.md](./UI_ICONS.md) - Icon guidelines (tooltips often accompany icon-only buttons)
- [UI_CSS_ARCHITECTURE.md](./UI_CSS_ARCHITECTURE.md) - Design tokens, theming, and light/dark mode. See "Theming Checklist" when adding tooltips with custom content


## Our Tooltip Component

**Location:** `src/renderer/components/ui/Tooltip.tsx`

Uses `@floating-ui/react` for viewport-aware positioning with intelligent repositioning when near edges.

```tsx
import { Tooltip } from '@renderer/components/ui';

<Tooltip content="Helpful tip" placement="top" delayShow={300}>
  <button>Hover me</button>
</Tooltip>
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `ReactNode` | required | Tooltip content (can include JSX) |
| `children` | `ReactElement` | required | Trigger element |
| `placement` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` | Preferred position (auto-flips if constrained) |
| `delayShow` | `number` | `200` | Delay before showing (ms) |
| `delayHide` | `number` | `0` | Delay before hiding (ms) |
| `disabled` | `boolean` | `false` | Disables tooltip without removing wrapper |


### Strengths

1. **Viewport-aware positioning** - Automatically repositions to stay visible
2. **Consistent styling** - Uses design tokens, always looks correct
3. **Rich content support** - Can render JSX, multi-line text, keyboard shortcuts
4. **Animation** - Smooth fade-in (150ms)
5. **Accessibility** - Proper `role="tooltip"`, focus support, dismiss handling
6. **Configurable delays** - Prevent tooltip spam on quick mouse movements

### Theming

The `<Tooltip>` component uses a dark background with white text that works in both light and dark modes. No extra work needed for standard text content.

**If using custom JSX content:** Avoid hardcoded colors; verify contrast in both themes. See the "Theming Checklist" in [UI_CSS_ARCHITECTURE.md](./UI_CSS_ARCHITECTURE.md#theming-checklist-for-new-components).


### Limitations

1. **Wrapper overhead** - Clones children and adds ref/event handlers
2. **Bundle size** - `@floating-ui/react` is ~15KB gzipped (already in bundle)
3. **No arrow on flip** - Arrow positioning works but can look awkward on edge cases
4. **Single child only** - Must wrap in a single element if you have fragments


## Native `title` Attribute

Browser-native tooltips via the HTML `title` attribute.

```tsx
<button title="Simple hint">Click</button>
```

### Strengths

1. **Zero overhead** - No JS, no wrapper, no bundle cost
2. **Universal** - Works on any element
3. **Simpler code** - No imports, no components

### Limitations

1. **Unstyled** - Browser-dependent appearance, often ugly
2. **No positioning control** - Browser decides placement
3. **No delay control** - Usually ~500ms delay, varies by browser/OS
4. **Text only** - Cannot render rich content or keyboard shortcuts
5. **Accessibility concerns** - Screen readers may not announce, inconsistent behavior


## When to Use Each

### Use `<Tooltip>` for:

- **Primary UI actions** - Buttons in toolbars, action bars, main interaction areas
- **Icon-only buttons** - Where the tooltip is essential for understanding
- **Keyboard shortcut hints** - e.g., `"New chat (⌘N)"` - these need rich formatting
- **Multi-line or rich content** - Status explanations, detailed hints
- **Accessibility-critical elements** - Where screen reader support matters

### Use `title` for:

- **Truncated text fallback** - Show full text when ellipsized (see `TruncatedTextWithTooltip`)
- **Dense data displays** - Tables, lists where every cell has potential tooltip
- **Secondary/contextual hints** - Non-essential supplementary info
- **Deep component hierarchies** - Where wrapping adds complexity


## Current Codebase Analysis

### Using `<Tooltip>` (35+ usages)

Correctly used throughout:
- `AgentComposer.tsx` - Attach file, clear input buttons
- `InteractionStrip.tsx` - Mic and speaker toggle buttons
- `VoiceControls.tsx`, `VoiceModeOverlay.tsx` - Audio device selectors
- `WorkspaceCommandShelf.tsx` - Toolbar actions (new file, refresh, etc.)
- `TimeSavedIndicator.tsx`, `MemoryUpdateIndicator.tsx` - Rich status tooltips
- `SkillCard.tsx` - Skill info popups
- `ConnectionsSection.tsx` - Add connection, usage limits

### Using `title` (30+ usages)

Mixed appropriateness:

**Appropriate uses of `title`:**
- `TruncatedTextWithTooltip.tsx` - Overflow detection for truncated text
- `SubAgentCapsuleStack.tsx` - Compact tool chips in dense timeline
- `StepPill.tsx` - Truncated step labels

**Could benefit from `<Tooltip>`:**
- `ThemeToggle.tsx` - Standalone toggle button, primary action
- `DocumentHeader.tsx` - Focus/Copy/Open actions (Preview/Edit toggle has been removed)
- `App.tsx` - "New chat" button with `⌘N` shortcut (line 2083, 2620)
- `AgentSessionSidebar.tsx` - Pin/unpin, delete, expand actions (lines 331, 435, 458)
- `HistoryFilterDropdown.tsx` - Filter dropdown trigger
- `FlowPanelsShell.tsx` - History expand/collapse toggle


## Migration Recommendations

### High Priority (user-facing primary actions with shortcuts)

1. **New Chat button** (`App.tsx:2083, 2620`) - Shows `⌘N`, should be styled tooltip
2. **Document header focus button** (`DocumentHeader.tsx`) - Focus mode `⌘\`
3. **Theme toggle** (`ThemeToggle.tsx:26`) - Consistent with other toggle buttons

### Medium Priority (primary actions without shortcuts)

1. **Sidebar session actions** (`AgentSessionSidebar.tsx`) - Pin, delete, expand
2. **History toggle** (`FlowPanelsShell.tsx:226`) - Collapse/expand history
3. **Filter dropdown** (`HistoryFilterDropdown.tsx:77`) - Current filter display

### Low Priority (acceptable as `title`)

- Truncated text components (purpose-built for this)
- Dense data displays (tool chips, file lists)
- Breadcrumb segments in editor


## Implementation Pattern

When migrating from `title` to `<Tooltip>`:

```tsx
// Before
<Button title={`Action (${shortcut})`} onClick={...}>
  <Icon />
</Button>

// After
import { Tooltip } from '@renderer/components/ui';

<Tooltip content={`Action (${shortcut})`} placement="top" delayShow={300}>
  <Button onClick={...}>
    <Icon />
  </Button>
</Tooltip>
```

For keyboard shortcuts with platform-aware display:
```tsx
import { formatAcceleratorDisplay } from '@renderer/utils/keyboard';

<Tooltip content={`New chat (${formatAcceleratorDisplay('CommandOrControl+N')})`}>
  ...
</Tooltip>
```
