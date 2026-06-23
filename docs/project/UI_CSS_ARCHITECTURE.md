---
description: "Renderer CSS architecture — design tokens, theme layers, typography, utilities, CSS modules, Tailwind usage"
last_updated: "2026-05-23"
---

# UI CSS Architecture

This document describes the CSS architecture, design token system, theming, and styling conventions used in Mindstone Rebel's renderer.

## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) – High-level UI layout and interaction patterns
- [DESIGN.md](DESIGN.md) – Visual design choices, branding, and iconography
- [UI_ICONS.md](UI_ICONS.md) – Icon library (lucide-react) conventions
- [src/renderer/components/ui/README.md](../../src/renderer/components/ui/README.md) – Shared UI component library with usage examples
- [UI_SETTINGS_AND_FORMS.md](UI_SETTINGS_AND_FORMS.md) – Layout patterns and component conventions for settings/form pages


## Overview

The renderer styling follows a **design tokens + CSS modules** architecture:

- **Design tokens** (`tokens.css`) define the foundational values: colors, spacing, radii, shadows, motion, and z-index scales
- **Theme layer** (`theme.css`) provides light/dark mode overrides and Tailwind CSS integration
- **Typography** (`typography.css`) establishes global type styles and Markdown rendering
- **Utilities** (`utilities.css`) offers reusable utility classes for common patterns
- **CSS modules** (`.module.css`) provide scoped, component-specific styles

Tailwind CSS exists in the project but **CSS modules + design tokens are the primary styling mechanism**. Tailwind is used selectively for rapid prototyping and spacing utilities.


## File Structure

```
src/renderer/styles/
├── index.css              # Entry point, imports all layers
├── foundations/
│   ├── reset.css          # CSS reset/normalization
│   ├── tokens.css         # Design tokens (colors, spacing, etc.)
│   ├── theme.css          # Light/dark mode theming, Tailwind config
│   ├── typography.css     # Global typography and Markdown styles
│   └── utilities.css      # Reusable utility classes
└── layout/
    └── app-shell.css      # App shell layout and aurora backgrounds
```


## Design Token System

All design tokens are defined as CSS custom properties in `tokens.css`. Using tokens ensures visual consistency and makes theming straightforward.

### Color Tokens

#### Core Palette

```css
--color-bg-page: #f4f7fb;          /* Page background */
--color-surface-1: #ffffff;         /* Primary surface */
--color-surface-muted: rgba(255, 255, 255, 0.92);
--color-surface-glass: rgba(255, 255, 255, 0.85);
--color-backdrop: rgba(15, 23, 42, 0.08);
```

#### Text Colors

```css
--color-text-primary: #0f172a;      /* Main text */
--color-text-secondary: rgba(15, 23, 42, 0.6);
--color-text-inverse: #ffffff;      /* Text on dark backgrounds */
--color-text-muted: rgba(30, 41, 59, 0.55);
```

#### Border Colors

```css
--color-border-soft: rgba(226, 232, 240, 0.7);
--color-border-strong: rgba(15, 23, 42, 0.18);
```

#### Brand Colors

```css
--color-brand-indigo: #4f46e5;
--color-brand-indigo-soft: rgba(99, 102, 241, 0.18);
--color-brand-blue: #2563eb;
--color-brand-cyan: #0ea5e9;
--color-brand-pink: #db2777;
```

#### Semantic Colors

```css
--color-success: #10b981;
--color-warning: #f97316;
--color-danger: #dc2626;
--color-info: #22d3ee;

/* Destructive actions */
--color-destructive: #dc2626;
--color-destructive-foreground: #ffffff;
--color-destructive-hover: #b91c1c;
```

#### Glass Surfaces

```css
--glass-panel-bg: rgba(255, 255, 255, 0.9);
--glass-panel-border: rgba(226, 232, 240, 0.85);
--glass-panel-shadow: 0 34px 68px rgba(15, 23, 42, 0.2);
--glass-panel-blur: 24px;
```

#### Tool Chip Colors

Category-specific colors for tool usage indicators:

```css
--chip-files-bg: rgba(16, 185, 129, 0.12);
--chip-files-text: #059669;
--chip-shell-bg: rgba(234, 179, 8, 0.12);
--chip-shell-text: #d97706;
--chip-network-bg: rgba(59, 130, 246, 0.12);
--chip-network-text: #2563eb;
--chip-planning-bg: rgba(168, 85, 247, 0.12);
--chip-planning-text: #7c3aed;
```


### Spacing Scale

A consistent spacing scale from 0-12:

```css
--space-0: 0px;
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-7: 28px;
--space-8: 32px;
--space-9: 40px;
--space-10: 48px;
--space-11: 56px;
--space-12: 64px;
```

Usage:
```css
.component {
  padding: var(--space-4);
  margin-bottom: var(--space-6);
  gap: var(--space-3);
}
```


### Radius Scale

Border radius tokens for consistent corner rounding:

```css
--radius-xs: 4px;
--radius-sm: 6px;
--radius-md: 10px;
--radius-button: 12px;
--radius-lg: 16px;
--radius-xl: 24px;
--radius-2xl: 32px;
--radius-pill: 999px;
```


### Shadow Scale

Three elevation levels:

```css
--shadow-soft: 0 10px 24px rgba(15, 23, 42, 0.12);
--shadow-medium: 0 24px 48px rgba(15, 23, 42, 0.18);
--shadow-hard: 0 44px 94px -40px rgba(15, 23, 42, 0.38);
```


### Z-Index Scale

Layering hierarchy:

```css
--z-base: 1;
--z-shell: 5;
--z-overlay: 30;
--z-permission-banner: 1000;
--z-modal: 1300;
--z-toast: 1400;
```


### Motion Tokens

Animation timing:

```css
--motion-duration-fast: 120ms;
--motion-duration-medium: 260ms;
--motion-duration-slow: 520ms;
--motion-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--motion-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

Usage:
```css
.animated-element {
  transition: transform var(--motion-duration-fast) var(--motion-ease-out),
              opacity var(--motion-duration-fast) var(--motion-ease-out);
}
```


### Layout Tokens

Responsive layout values:

```css
--outer-gutter: clamp(24px, 4vw, 64px);
--app-max-width: clamp(1180px, 82vw, 1440px);
--app-max-width-flow: clamp(1180px, 94vw, 1600px);
--sidebar-width-min: 288px;
--sidebar-width-preferred: 320px;
--sidebar-width-max: 360px;
--shell-radius: 36px;
--conversation-content-max-width: 900px;
```


## Theme System

### Light/Dark Mode Implementation

The theme system uses CSS custom properties with mode-specific overrides. Dark mode is applied via the `.dark` class on the body element.

**Default (light mode)** is defined in `:root` and `.light`:

```css
:root, .light {
  color-scheme: light;
  --color-bg-page: #f4f7fb;
  --color-text-primary: #0f172a;
  /* ... other light mode values */
}
```

**Dark mode** overrides these values:

```css
.dark {
  color-scheme: dark;
  --color-bg-page: #0a0a0e;
  --color-text-primary: #f8faff;
  /* ... other dark mode values */
}
```

### Tailwind CSS Integration

`theme.css` uses Tailwind's `@theme` directive to expose tokens as Tailwind utilities:

```css
@theme {
  --default-font-family: "Figtree", ui-sans-serif, system-ui, sans-serif;
  --color-primary: var(--color-primary);
  --color-secondary: var(--color-secondary);
  /* ... maps CSS variables to Tailwind */
}
```

This allows both CSS modules and Tailwind to share the same design tokens.

### How Themes Are Applied

1. The app detects system preference or user setting
2. Body element receives `.dark` or `.light` class
3. CSS custom properties cascade new values
4. All components automatically receive themed values


## CSS Module Conventions

### When to Use CSS Modules

CSS modules (`.module.css`) are used for component-specific styles:

- **Co-located with components**: Each component can have its own `ComponentName.module.css`
- **Scoped by default**: Class names are automatically hashed to prevent collisions
- **Import and use**: Classes are imported as a JavaScript object

Example structure:
```
src/renderer/features/agent-session/components/
├── ToolChip.tsx
├── ToolChip.module.css
├── SessionStatusTicker.tsx
└── SessionStatusTicker.module.css
```

### Naming Patterns

Use **camelCase** for class names in CSS modules:

```css
/* ToolChip.module.css */
.chip { /* base styles */ }
.chipIcon { /* child element */ }
.chipLabel { /* child element */ }
.chipFiles { /* variant */ }
.chipNetwork { /* variant */ }
.chipCompact { /* size modifier */ }
```

Usage in React:
```tsx
import styles from './ToolChip.module.css';

<div className={styles.chip}>
  <span className={styles.chipIcon}>...</span>
  <span className={styles.chipLabel}>...</span>
</div>

// With variant
<div className={`${styles.chip} ${styles.chipFiles}`}>
```

### Light Mode Overrides in Modules

Use `:global(body.light)` to target light mode:

```css
.button--ghost {
  background: rgba(79, 70, 229, 0.12);
  color: #c4b5fd;
}

:global(body.light) .button--ghost {
  background: transparent;
  color: var(--color-primary);
}
```

### Avoiding One-Off Styles

- **DO**: Use design tokens for colors, spacing, radii
- **DO**: Create reusable variants in the module
- **DON'T**: Use hardcoded magic numbers
- **DON'T**: Create one-off styles that could be tokens


## Global Utilities

`utilities.css` provides reusable utility classes:

### Accessibility

```css
.visually-hidden {
  position: absolute !important;
  width: 1px;
  height: 1px;
  /* ... screen-reader-only pattern */
}
```

### Glass Effects

```css
.glass-panel {
  background: var(--color-surface-glass);
  backdrop-filter: blur(24px);
  box-shadow: var(--shadow-medium);
}
```

### Text Effects

```css
.text-gradient-brand {
  background: linear-gradient(120deg, var(--color-brand-indigo), var(--color-brand-blue));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

### Focus Indicators

```css
.focus-ring {
  outline: 2px solid var(--color-brand-indigo);
  outline-offset: 3px;
}
```

### Scroll Fades

```css
.scroll-fade-top,
.scroll-fade-bottom {
  position: sticky;
  height: 12px;
  pointer-events: none;
  z-index: 1;
}
```

### Empty States

The `.empty-state` class provides consistent styling for empty content areas with icon, heading, and description.

### Spinners

```css
.spinner-small {
  /* 12px animated spinner */
  animation: spinner-rotate 0.8s linear infinite;
}
```

### When to Use Utilities vs Modules

| Scenario | Use |
|----------|-----|
| Component-specific layout | CSS module |
| Accessibility patterns | Utility class |
| Glass/blur effects | Utility class |
| Brand-specific gradients | Utility class |
| Complex hover states | CSS module |
| Responsive behavior | CSS module |


## Typography

### Font Families

```css
--font-family-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-family-mono: 'SF Mono', 'Monaco', 'Cascadia Code', 'Fira Code', monospace;
```

Note: `theme.css` also references "Figtree" as the default UI font.

### Base Typography

```css
body {
  font-size: var(--font-size-base);    /* 16px */
  line-height: var(--line-height-base); /* 1.6 */
}
```

### Heading Scale

Headings use `clamp()` for responsive sizing:

```css
h1 { font-size: clamp(2rem, 4vw, 3rem); }
h2 { font-size: clamp(1.6rem, 3vw, 2.4rem); }
h3 { font-size: clamp(1.3rem, 2.2vw, 1.8rem); }
h4 { font-size: 1.2rem; }
h5 { font-size: 1.05rem; }
h6 { font-size: 0.95rem; }
```

### Markdown Rendering

The `.markdown-body` class styles rendered Markdown content:

```css
.markdown-body {
  font-size: 15px;
  line-height: 1.8;
}

.markdown-body a {
  color: var(--color-link);
  text-decoration: underline;
  text-underline-offset: 4px;
}
```

### Specialized Link Styles

Workspace and conversation links have pill-styled treatments:

```css
.markdown-link--workspace {
  display: inline-flex;
  padding: 2px 8px 2px 6px;
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.08);
}

.markdown-link--conversation {
  background: rgba(139, 92, 246, 0.12);
  color: rgba(167, 139, 250, 0.95);
}
```


## Glass/Blur Effects and Surfaces

### Surface Hierarchy

1. **Page background** (`--color-bg-page`) – Base layer
2. **Surface 1** (`--color-surface-1`) – Primary cards and panels
3. **Surface muted** (`--color-surface-muted`) – Slightly transparent surfaces
4. **Surface glass** (`--color-surface-glass`) – Glassmorphic panels with blur

### Glass Panel Pattern

```css
.glass-panel {
  background: var(--glass-panel-bg);
  border: 1px solid var(--glass-panel-border);
  border-radius: var(--shell-radius);
  box-shadow: var(--glass-panel-shadow);
  backdrop-filter: blur(var(--glass-panel-blur));
}
```

### Aurora Backgrounds

The app shell uses animated gradient backgrounds (`app-shell.css`):

**Dark mode aurora:**
```css
body.dark::before {
  background:
    radial-gradient(900px 600px at 15% 20%, rgba(124, 58, 237, 0.18), transparent 60%),
    radial-gradient(800px 520px at 85% 80%, rgba(37, 99, 235, 0.16), transparent 60%),
    conic-gradient(from 180deg at 50% 50%, ...);
  animation: auroraDrift 42s ease-in-out infinite alternate;
}
```

**Light mode aurora:**
```css
body.light::before {
  background:
    radial-gradient(800px 550px at 0% 5%, rgba(135, 80, 255, 0.28), transparent 45%),
    /* ... purple-to-cyan spectrum */
}
```

### Performance Optimization

Aurora animations are paused when not visible:

```css
body[data-show-aurora="false"]::before {
  animation-play-state: paused;
  opacity: 0;
}
```


## CSS Variable Inheritance Patterns

### Creating Themeable Sections

Override tokens in a parent scope to theme child components:

```css
.dark-section {
  --color-background: #0f172a;
  --color-text-primary: #f1f5f9;
  --color-border: #334155;
}
```

All child components using these tokens will inherit the new values.

### Component-Level Overrides

Components can define their own contextual tokens:

```css
.card--featured {
  --card-bg: var(--color-brand-indigo-soft);
  --card-border: var(--color-brand-indigo);
}
```

### Dark Mode Pattern in Modules

When a component needs dark mode overrides:

```css
/* Base styles (often optimized for dark mode) */
.component {
  background: rgba(13, 17, 28, 0.92);
  color: rgba(248, 250, 255, 0.95);
}

/* Light mode overrides */
:global(body.light) .component {
  background: var(--color-card);
  color: var(--color-foreground);
}
```


## Responsive Breakpoints

Progressive screen breakpoints expand app width on larger monitors:

```css
/* Default: up to 1800px (laptops, normal monitors) */
:root {
  --app-max-width: clamp(1180px, 82vw, 1440px);
  --conversation-content-max-width: 900px;
}

/* 1800-2799px (large monitors, 1440p) */
@media (min-width: 1800px) {
  :root {
    --app-max-width: clamp(1440px, 88vw, 2100px);
    --conversation-content-max-width: 960px;
  }
}

/* 2800px+ (4K, ultrawides) */
@media (min-width: 2800px) {
  :root {
    --app-max-width: clamp(2100px, 75vw, 2800px);
    --conversation-content-max-width: 1100px;
  }
}
```


## Custom Scrollbar Styling

The app uses custom scrollbar styling for a cleaner, more minimal appearance. This pattern is used in the session sidebar, library drawer, inbox panel, and other scrollable areas.

### Standard Pattern

```css
.scrollableContainer {
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.25) transparent;
}

.scrollableContainer::-webkit-scrollbar {
  width: 6px;
}

.scrollableContainer::-webkit-scrollbar-track {
  background: transparent;
}

.scrollableContainer::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.25);
  border-radius: 999px;
}

.scrollableContainer::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.4);
}
```

### Progressive Disclosure Pattern

For areas where the scrollbar should only appear when the user is interacting with that region (matching the sidebar's hover-reveal pattern):

```css
/* Hidden by default */
.container {
  scrollbar-color: transparent transparent;
}

.container::-webkit-scrollbar-thumb {
  background: transparent;
  transition: background 0.2s ease;
}

/* Reveal on parent hover/focus */
.parent:hover .container,
.parent:focus-within .container {
  scrollbar-color: rgba(148, 163, 184, 0.25) transparent;
}

.parent:hover .container::-webkit-scrollbar-thumb,
.parent:focus-within .container::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.25);
}
```

### Light Mode Overrides

```css
:global(body.light) .scrollableContainer::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.3);
}

:global(body.light) .scrollableContainer::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.45);
}
```

### Reference Implementations

- `AgentSessionSidebar.module.css` — Progressive disclosure scrollbar (appears on sidebar hover)
- `LibraryDrawer.module.css` — Standard custom scrollbar pattern
- `InboxPanel.module.css` — Standard custom scrollbar pattern


## Accessibility

### Reduced Motion

Animations are disabled for users who prefer reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  body.dark::before,
  body.light::before {
    animation: none !important;
  }
}
```

### Focus Indicators

All interactive elements should have visible focus states:

```css
.button:focus-visible {
  outline: 2px solid var(--color-ring, #a78bfa);
  outline-offset: 2px;
}
```


## Best Practices

### DO

- Use design tokens for all colors, spacing, radii, and shadows
- Create CSS modules for component-specific styles
- Use semantic color names (`--color-success`, not `--color-green`)
- Test both light and dark modes
- Use motion tokens for consistent animation timing
- Prefer `var(--token)` over hardcoded values
- Pass **stable function references** to API boundaries that accept React component types (react-markdown `components` maps, virtualized-row renderers, Tiptap nodeViews) — a new identity per render forces a subtree remount
- Choose whitespace handling **deliberately** on user-authored content surfaces: `pre-wrap` when fidelity to the user's line breaks matters, default normalization when prose-style rendering is intended

### DON'T

- Add new styles to `deprecated.css`
- Use magic numbers without context
- Create one-off color values
- Skip focus states on interactive elements
- Forget to handle both theme modes
- Use `!important` except for accessibility overrides


### Cursor Conventions

Use appropriate cursor styles to communicate element behavior:

| Cursor | Use Case | Example |
|--------|----------|---------|
| `pointer` | Clickable actions that trigger something | Buttons, links, menu items |
| `help` | Hover-only info with no click action | Info icons with tooltips, status indicators |
| `default` | Non-interactive or already-active states | Static icons, active/selected items |
| `text` | Text that can be selected | Editable content, copyable text |
| `not-allowed` | Disabled interactive elements | Disabled buttons (via `:disabled`) |
| `grab` / `grabbing` | Draggable elements | Drag handles, reorderable items |

**Key principle:** The cursor should honestly communicate what will happen on click. An info icon that only shows a tooltip on hover should use `cursor: help`, not `cursor: pointer`.

**Pattern for info-only icons:**
```css
.infoIcon {
  cursor: help;
}
```

**Pattern for tooltips on disabled buttons:**
Disabled buttons don't fire hover events, so tooltips won't show. Wrap in a non-disabled span:
```tsx
<Tooltip content="Action unavailable">
  <span className={styles.tooltipTrigger}>
    <button disabled>...</button>
  </span>
</Tooltip>
```


### Theming Checklist for New Components

When creating CSS modules, verify both themes work before merging:

**Check each of these:**
- [ ] All background colors have light mode overrides (or use CSS variables that auto-adapt)
- [ ] All text colors have light mode overrides (or use CSS variables)
- [ ] All border colors have light mode overrides (or use CSS variables)
- [ ] Hover and focus states work in both modes
- [ ] Placeholder text is visible in both modes

**Common mistakes:**
- Setting background without corresponding text color → invisible text
- Using hardcoded `#ffffff` or light text on surfaces that become white in light mode
- Forgetting `:hover`, `:focus`, and `::placeholder` overrides

**Reference implementations:**
- `src/renderer/components/MentionPopover.module.css` — Clean popover example
- `src/renderer/features/inbox/components/InboxPanel.module.css` — Comprehensive example
- `src/renderer/features/workspace/components/AnnotationPopover.module.css` — Recently fixed example


## Surface Toolbar Pattern

Every major surface (Library, Inbox, etc.) uses a **two-row toolbar** at the top for search, scope/filter tabs, and action buttons. Follow this pattern for consistency:

### Layout structure

```
Row 1 (lensBar):     [Show: Spaces/Skills/Memory/Everything] [View as: Folders/Cards/Atlas]
Row 2 (controlsRow): [🔍 Search ............................]  |  [Sort ▼]  |  [Action]
```

### CSS classes

| Class | Purpose | Key properties |
|-------|---------|----------------|
| `.toolbar` | Wrapper, flex-wrap for responsive stacking | `display: flex; flex-wrap: wrap; gap: 12px; container-type: inline-size` |
| `.lensBar` | Full-width lens-chip row above controls | `display: flex; flex: 1 1 100%; min-width: 0` |
| `.controlsRow` | Search + action controls row | `display: flex; align-items: center; gap: 8px` |
| `.actionsDivider` | Vertical line between control groups | `width: 1px; height: 24px; background: rgba(148, 163, 184, 0.15)` |

### Search input

Use a bordered, rounded container (`border-radius: 10px`) with a leading `Search` icon and optional clear button. Focus state: purple border + subtle glow (`box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.06)`).

### Lens chips (`Show` + `View as`)

Lens chips use `padding: 6px 12px`, `border-radius: 8px`, `font-size: 0.8rem`. Active state: `background: rgba(139, 92, 246, 0.18); color: rgba(248, 250, 255, 0.95)`. Light mode: `color: var(--color-primary); background: rgba(139, 92, 246, 0.12)`.

### Reference implementations

- **Library:** `LibraryCommandShelf.tsx` / `.module.css` + `LibraryLensBar.tsx` / `.module.css` — canonical reference (`.toolbar`, `.lensBar`, `.controlsRow`, `.chip`, `.chipActive`)
- **Inbox:** `InboxPanel.tsx` / `.module.css` — follows Library pattern (`.toolbar`, `.searchRow`, `.controlsRow`, `.temporalTab`)

### Responsive behavior

At `@container (max-width: 420px)`, `.lensBar` takes full width (`flex-basis: 100%`), and `.controlsRow` wraps its contents.


## Import Order

Styles are imported in layers via `index.css`:

```css
@layer base, layout, components, utilities;

@import "./foundations/reset.css" layer(base);
@import "./foundations/tokens.css" layer(base);
@import "./foundations/theme.css";
@import "./foundations/typography.css" layer(base);
@import "./foundations/utilities.css" layer(utilities);
@import "./layout/app-shell.css" layer(layout);
```

This ensures proper cascade: reset → tokens → theme → typography → utilities → layout.
