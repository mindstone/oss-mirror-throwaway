# UI Component Token Inventory

Generated: 2026-06-18T22:04:25.279Z

This report inventories existing UI components in `src/renderer/components/ui` and the tokens they use.
It is documentation-only: no component behavior changes.

## Summary

- Components scanned: **27**
- Unique CSS var tokens used by UI components: **82**
- Tokens defined across renderer styles: **203**
- CSS tokens used by components but not found in renderer style definitions: **4**

## Component Matrix

| Component | Source | Style files | CSS tokens | Undefined tokens | Semantic utility classes |
|---|---|---:|---:|---:|---:|
| `Badge` | `src/renderer/components/ui/Badge.tsx` | 1 | 15 | 0 | 0 |
| `BillingBadge` | `src/renderer/components/ui/BillingBadge.tsx` | 0 | 0 | 0 | 0 |
| `Button` | `src/renderer/components/ui/Button.tsx` | 1 | 0 | 0 | 4 |
| `Card` | `src/renderer/components/ui/Card.tsx` | 1 | 15 | 0 | 0 |
| `ConversationPill` | `src/renderer/components/ui/ConversationPill.tsx` | 1 | 5 | 0 | 0 |
| `DecisionCardGroup` | `src/renderer/components/ui/DecisionCardGroup.tsx` | 1 | 12 | 0 | 0 |
| `Dialog` | `src/renderer/components/ui/Dialog.tsx` | 1 | 18 | 0 | 0 |
| `FileLocationBadge` | `src/renderer/components/ui/FileLocationBadge.tsx` | 1 | 4 | 0 | 0 |
| `IconButton` | `src/renderer/components/ui/IconButton.tsx` | 1 | 8 | 0 | 0 |
| `IconTile` | `src/renderer/components/ui/IconTile.tsx` | 1 | 10 | 2 | 0 |
| `InlineToggle` | `src/renderer/components/ui/InlineToggle.tsx` | 1 | 1 | 0 | 0 |
| `Input` | `src/renderer/components/ui/Input.tsx` | 1 | 11 | 0 | 0 |
| `MaturityBadge` | `src/renderer/components/ui/MaturityBadge.tsx` | 1 | 4 | 0 | 0 |
| `Notice` | `src/renderer/components/ui/Notice.tsx` | 1 | 34 | 0 | 0 |
| `PageHeader` | `src/renderer/components/ui/PageHeader.tsx` | 1 | 2 | 0 | 0 |
| `PrivacyIndicator` | `src/renderer/components/ui/PrivacyIndicator.tsx` | 1 | 0 | 0 | 0 |
| `RebelLoadingIndicator` | `src/renderer/components/ui/RebelLoadingIndicator.tsx` | 1 | 7 | 0 | 0 |
| `RichSelect` | `src/renderer/components/ui/RichSelect.tsx` | 1 | 17 | 2 | 0 |
| `SectionHeader` | `src/renderer/components/ui/SectionHeader.tsx` | 1 | 2 | 0 | 0 |
| `Select` | `src/renderer/components/ui/Select.tsx` | 1 | 12 | 0 | 0 |
| `Spinner` | `src/renderer/components/ui/Spinner.tsx` | 0 | 0 | 0 | 1 |
| `SplitButton` | `src/renderer/components/ui/SplitButton.tsx` | 1 | 7 | 0 | 0 |
| `Tabs` | `src/renderer/components/ui/Tabs.tsx` | 1 | 18 | 0 | 0 |
| `ThemeToggle` | `src/renderer/components/ui/ThemeToggle.tsx` | 1 | 3 | 0 | 0 |
| `Toast` | `src/renderer/components/ui/Toast.tsx` | 1 | 11 | 0 | 0 |
| `Toggle` | `src/renderer/components/ui/Toggle.tsx` | 1 | 4 | 0 | 0 |
| `Tooltip` | `src/renderer/components/ui/Tooltip.tsx` | 1 | 2 | 0 | 0 |

## Undefined Token Watchlist

- `--color-border-hover`
- `--color-text-tertiary`
- `--icon-tile-color`
- `--icon-tile-icon-size`

## Component Details

### Badge
- Source: `src/renderer/components/ui/Badge.tsx`
- Style files: `src/renderer/components/ui/Badge.module.css`
- Variant-like props detected: variant: default | destructive | info | muted | outline | primary | secondary | success | warning ; size: lg | md | sm
- CSS var tokens used (15): `--color-border`, `--color-destructive`, `--color-info`, `--color-muted`, `--color-muted-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-success`, `--color-text-primary`, `--color-text-secondary`, `--color-warning`, `--motion-duration-fast`, `--radius-pill`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### BillingBadge
- Source: `src/renderer/components/ui/BillingBadge.tsx`
- Style files: none
- Variant-like props detected: n/a
- CSS var tokens used (0): none
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Button
- Source: `src/renderer/components/ui/Button.tsx`
- Style files: `src/renderer/components/ui/Button.css`
- Variant-like props detected: variant: default | destructive | ghost | outline | secondary ; size: default | icon | lg | sm | xs | xxs
- CSS var tokens used (0): none
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (4): `bg-primary`, `ring-ring`, `text-foreground`, `text-primary-foreground`

### Card
- Source: `src/renderer/components/ui/Card.tsx`
- Style files: `src/renderer/components/ui/Card.module.css`
- Variant-like props detected: variant: default | elevated | glass | outlined
- CSS var tokens used (15): `--color-border`, `--color-border-strong`, `--color-card`, `--color-card-foreground`, `--color-text-primary`, `--color-text-secondary`, `--glass-panel-bg`, `--glass-panel-blur`, `--glass-panel-border`, `--glass-panel-shadow`, `--radius-lg`, `--shadow-medium`, `--space-1`, `--space-3`, `--space-6`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### ConversationPill
- Source: `src/renderer/components/ui/ConversationPill.tsx`
- Style files: `src/renderer/components/ui/ConversationPill.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (5): `--color-text-primary`, `--color-text-secondary`, `--glass-overlay-blur`, `--motion-duration-fast`, `--radius-xs`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### DecisionCardGroup
- Source: `src/renderer/components/ui/DecisionCardGroup.tsx`
- Style files: `src/renderer/components/ui/DecisionCardGroup.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (12): `--color-border-soft`, `--color-card`, `--color-primary`, `--color-surface-elevated`, `--color-text-muted`, `--color-text-primary`, `--color-text-secondary`, `--motion-duration-fast`, `--radius-md`, `--space-2`, `--space-3`, `--space-5`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Dialog
- Source: `src/renderer/components/ui/Dialog.tsx`
- Style files: `src/renderer/components/ui/Dialog.module.css`
- Variant-like props detected: size: lg | md | sm | xl
- CSS var tokens used (18): `--color-foreground`, `--color-muted-foreground`, `--color-text-primary`, `--color-text-secondary`, `--glass-overlay-blur`, `--motion-ease-out`, `--radius-lg`, `--radius-md`, `--radius-xl`, `--shadow-hard`, `--space-2`, `--space-3`, `--space-4`, `--space-5`, `--space-6`, `--space-7`, `--space-8`, `--z-modal`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### FileLocationBadge
- Source: `src/renderer/components/ui/FileLocationBadge.tsx`
- Style files: `src/renderer/components/ui/FileLocationBadge.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (4): `--color-muted-foreground`, `--color-text-secondary`, `--color-warning`, `--space-1`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### IconButton
- Source: `src/renderer/components/ui/IconButton.tsx`
- Style files: `src/renderer/components/ui/IconButton.module.css`
- Variant-like props detected: size: lg | md | sm | xs ; variant: framed | ghost | subtle
- CSS var tokens used (8): `--color-destructive`, `--color-foreground`, `--color-muted-foreground`, `--color-primary`, `--color-text-primary`, `--color-text-secondary`, `--motion-duration-fast`, `--radius-md`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### IconTile
- Source: `src/renderer/components/ui/IconTile.tsx`
- Style files: `src/renderer/components/ui/IconTile.module.css`
- Variant-like props detected: size: lg | md | sm
- CSS var tokens used (10): `--color-brand-indigo`, `--color-info`, `--color-primary`, `--color-success`, `--color-text-secondary`, `--color-warning`, `--icon-tile-color`, `--icon-tile-icon-size`, `--radius-md`, `--radius-sm`
- CSS tokens without renderer style definition (2): `--icon-tile-color`, `--icon-tile-icon-size`
- Semantic utility classes in TSX (0): none

### InlineToggle
- Source: `src/renderer/components/ui/InlineToggle.tsx`
- Style files: `src/renderer/components/ui/InlineToggle.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (1): `--motion-duration-fast`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Input
- Source: `src/renderer/components/ui/Input.tsx`
- Style files: `src/renderer/components/ui/Input.module.css`
- Variant-like props detected: inputSize: lg | md | sm
- CSS var tokens used (11): `--color-background`, `--color-border-input`, `--color-destructive`, `--color-placeholder-foreground`, `--color-text-primary`, `--motion-duration-fast`, `--radius-md`, `--space-2`, `--space-3`, `--space-4`, `--space-5`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### MaturityBadge
- Source: `src/renderer/components/ui/MaturityBadge.tsx`
- Style files: `src/renderer/components/ui/MaturityBadge.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (4): `--color-muted-foreground`, `--color-primary`, `--motion-duration-fast`, `--radius-sm`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Notice
- Source: `src/renderer/components/ui/Notice.tsx`
- Style files: `src/renderer/components/ui/Notice.module.css`
- Variant-like props detected: variant: primary | secondary
- CSS var tokens used (34): `--color-accent`, `--color-black`, `--color-destructive-border`, `--color-destructive-border-strong`, `--color-destructive-icon`, `--color-destructive-surface`, `--color-destructive-surface-strong`, `--color-info-border`, `--color-info-border-strong`, `--color-info-icon`, `--color-info-surface`, `--color-info-surface-strong`, `--color-success-border`, `--color-success-border-strong`, `--color-success-icon`, `--color-success-surface`, `--color-success-surface-strong`, `--color-text-primary`, `--color-text-secondary`, `--color-warning-border`, `--color-warning-border-strong`, `--color-warning-icon`, `--color-warning-surface`, `--color-warning-surface-strong`, `--color-white`, `--motion-duration-fast`, `--motion-ease-out`, `--radius-md`, `--radius-sm`, `--space-1`, `--space-2`, `--space-3`, `--space-4`, `--space-5`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### PageHeader
- Source: `src/renderer/components/ui/PageHeader.tsx`
- Style files: `src/renderer/components/ui/PageHeader.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (2): `--color-muted-foreground`, `--color-text-primary`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### PrivacyIndicator
- Source: `src/renderer/components/ui/PrivacyIndicator.tsx`
- Style files: `src/renderer/components/ui/PrivacyIndicator.module.css`
- Variant-like props detected: tooltipPlacement: bottom | left | right | top
- CSS var tokens used (0): none
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### RebelLoadingIndicator
- Source: `src/renderer/components/ui/RebelLoadingIndicator.tsx`
- Style files: `src/renderer/components/ui/RebelLoadingIndicator.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (7): `--color-text-primary`, `--color-text-secondary`, `--space-1`, `--space-10`, `--space-12`, `--space-3`, `--space-6`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### RichSelect
- Source: `src/renderer/components/ui/RichSelect.tsx`
- Style files: `src/renderer/components/ui/RichSelect.module.css`
- Variant-like props detected: size: md | sm
- CSS var tokens used (17): `--color-background`, `--color-border`, `--color-border-hover`, `--color-border-input`, `--color-foreground`, `--color-popover`, `--color-primary`, `--color-ring`, `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary`, `--glass-overlay-blur`, `--motion-duration-fast`, `--radius-md`, `--space-2`, `--space-3`, `--space-4`
- CSS tokens without renderer style definition (2): `--color-border-hover`, `--color-text-tertiary`
- Semantic utility classes in TSX (0): none

### SectionHeader
- Source: `src/renderer/components/ui/SectionHeader.tsx`
- Style files: `src/renderer/components/ui/SectionHeader.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (2): `--color-foreground`, `--color-muted-foreground`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Select
- Source: `src/renderer/components/ui/Select.tsx`
- Style files: `src/renderer/components/ui/Select.module.css`
- Variant-like props detected: selectSize: lg | md | sm
- CSS var tokens used (12): `--color-background`, `--color-border-input`, `--color-destructive`, `--color-ring`, `--color-text-primary`, `--color-text-secondary`, `--motion-duration-fast`, `--radius-md`, `--space-2`, `--space-3`, `--space-4`, `--space-5`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Spinner
- Source: `src/renderer/components/ui/Spinner.tsx`
- Style files: none
- Variant-like props detected: n/a
- CSS var tokens used (0): none
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (1): `text-muted-foreground`

### SplitButton
- Source: `src/renderer/components/ui/SplitButton.tsx`
- Style files: `src/renderer/components/ui/SplitButton.module.css`
- Variant-like props detected: type: button | submit ; size: lg | md | sm ; variant: default | outline
- CSS var tokens used (7): `--color-border`, `--color-foreground`, `--color-muted-foreground`, `--color-popover`, `--color-primary`, `--color-primary-foreground`, `--glass-overlay-blur`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Tabs
- Source: `src/renderer/components/ui/Tabs.tsx`
- Style files: `src/renderer/components/ui/Tabs.module.css`
- Variant-like props detected: variant: default | pills | underline
- CSS var tokens used (18): `--color-background`, `--color-border`, `--color-muted`, `--color-primary`, `--color-primary-foreground`, `--color-ring`, `--color-text-primary`, `--color-text-secondary`, `--motion-duration-fast`, `--motion-ease-out`, `--radius-md`, `--radius-pill`, `--radius-sm`, `--shadow-soft`, `--space-1`, `--space-2`, `--space-3`, `--space-4`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### ThemeToggle
- Source: `src/renderer/components/ui/ThemeToggle.tsx`
- Style files: `src/renderer/components/ui/ThemeToggle.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (3): `--color-border`, `--color-muted-foreground`, `--color-primary`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Toast
- Source: `src/renderer/components/ui/Toast.tsx`
- Style files: `src/renderer/components/ui/Toast.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (11): `--color-text-muted`, `--color-text-primary`, `--color-text-secondary`, `--font-family-sans`, `--glass-overlay-blur`, `--motion-duration-fast`, `--motion-ease-out`, `--radius-lg`, `--radius-sm`, `--radius-xs`, `--z-toast`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Toggle
- Source: `src/renderer/components/ui/Toggle.tsx`
- Style files: `src/renderer/components/ui/Toggle.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (4): `--color-primary`, `--color-primary-foreground`, `--color-text-secondary`, `--motion-duration-fast`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none

### Tooltip
- Source: `src/renderer/components/ui/Tooltip.tsx`
- Style files: `src/renderer/components/ui/Tooltip.module.css`
- Variant-like props detected: n/a
- CSS var tokens used (2): `--motion-ease-out`, `--radius-md`
- CSS tokens without renderer style definition (0): none
- Semantic utility classes in TSX (0): none
