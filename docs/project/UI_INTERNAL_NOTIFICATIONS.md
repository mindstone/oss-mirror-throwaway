---
description: "In-app notification system — taxonomy, visual spec, API, and guidelines for building or modifying notifications."
last_updated: "2026-03-20"
---

# In-App Notifications

Rebel's notification system covers three categories: **floating toasts**, **persistent panels**, and **inline banners**. Floating toasts and inline notices share tone, icon, copy, action, and dismissal rules, while preserving their different jobs: Toast is transient and floating; Notice is persistent and in-flow.

**Implementation:** The toast system is built on [Sonner](https://sonner.emilkowal.ski/), a headless toast library for React. Our `ToastProvider` wraps Sonner's API with consistent theming and convenience methods.

> **Note:** This covers in-app notifications only. For OS-level desktop notifications (e.g., "conversation finished" when app is unfocused), see [UI_DESKTOP_NOTIFICATIONS.md](UI_DESKTOP_NOTIFICATIONS.md).


## See Also

- [UI_DESKTOP_NOTIFICATIONS.md](UI_DESKTOP_NOTIFICATIONS.md) — OS-level notifications for background events
- [src/renderer/components/ui/Toast.tsx](../../src/renderer/components/ui/Toast.tsx) — Toast component implementation
- [src/renderer/components/ui/Toast.module.css](../../src/renderer/components/ui/Toast.module.css) — Visual spec (CSS source of truth)
- [src/renderer/components/ui/Notice.tsx](../../src/renderer/components/ui/Notice.tsx) — In-flow notice implementation
- [src/renderer/components/ui/Feedback.stories.tsx](../../src/renderer/components/ui/Feedback.stories.tsx) — Storybook review surface for notification roles
- [src/renderer/components/ui/README.md](../../src/renderer/components/ui/README.md) — UI component library overview


## Notification Taxonomy

| Type | Example | Position | Behavior | When to Use |
|------|---------|----------|----------|-------------|
| **Floating toast** | "Settings saved", "File deleted" | Top-right, 80px below header | Auto-dismisses (default 4s) | Ephemeral feedback for user actions or system events |
| **Persistent panel** | NotificationDrawer (bell icon / "Review" button) | Right-side overlay | Stays until user acts | Requires user decision (approve/deny) |
| **Inline banner** | OfflineBanner, VersionOutdatedBanner | Fixed top / inline in layout | Conditional on state | Persistent status indicators |

### Decision guide: which type to use?

1. **Does it need the user to take action?** → Persistent panel (or toast with `duration: 0` + action button)
2. **Is it ephemeral feedback?** → Floating toast via `showToast()`
3. **Is it a persistent status?** → Inline banner
4. **Never** build a custom floating notification component. Use `showToast()`.


## Visual Spec — Feedback Surfaces

The CSS sources of truth are `Toast.module.css` for transient floating feedback and `Notice.module.css` for persistent in-flow feedback. Both use the same severity token families (`info`, `success`, `warning`, `destructive/error`) so feedback feels related without flattening role or hierarchy.

### Card Surface

| Property | Dark Mode | Light Mode |
|----------|-----------|------------|
| Background | Tone-tinted `var(--color-card)` | Tone-tinted `var(--color-card)` |
| Border-radius | `var(--radius-lg)` | `var(--radius-lg)` |
| Width | Responsive toast width, capped near the current compact card width | same |
| Padding | Token spacing with reserved room for the close icon | same |

### Tone & Elevation

Toast elevation communicates "floating, temporary chrome." Tone communicates semantic meaning through the icon, border, and quiet tinted surface. Notice uses the same tone family but no floating elevation.

| Variant | Tone tokens |
|---------|-------------|
| default / info | `--color-info-surface`, `--color-info-border`, `--color-info-icon` |
| success | `--color-success-surface`, `--color-success-border`, `--color-success-icon` |
| warning | `--color-warning-surface`, `--color-warning-border`, `--color-warning-icon` |
| error | `--color-destructive-surface`, `--color-destructive-border`, `--color-destructive-icon` |

### Typography

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Title | 0.8125rem (13px) | 600 | `var(--color-text-primary)` |
| Description | 0.75rem (12px) | normal | `var(--color-text-secondary)` |
| Both | line-height 1.4 | — | — |

### Close / Dismiss Button

All floating notifications use the same dismiss button pattern:

```
Position: absolute, top 12px, right 12px
Size: 18 × 18px
Border-radius: var(--radius-xs)
Default: opacity 0.5, color var(--color-text-muted)
Hover: opacity 1, background var(--color-destructive-surface), color var(--color-destructive-icon)
```


## API Reference

### How to show a toast (the only way)

```tsx
import { useAppContext } from '@renderer/contexts';

function MyComponent() {
  const { showToast } = useAppContext();
  
  showToast({ title: 'Settings saved' });
}
```

Or with direct hook access (when you need programmatic dismiss):

```tsx
import { useToast } from '@renderer/components/ui';

function MyComponent() {
  const { showToast, dismissToast } = useToast();
  const toastId = showToast({ title: 'Processing...', duration: 0 });
  // Later:
  dismissToast(toastId);
}
```

### Toast options

```tsx
showToast({
  title: 'Required — the main message',
  description: 'Optional — supporting detail',
  variant: 'success',           // 'default' | 'success' | 'warning' | 'error' | 'info'
  duration: 4000,               // ms. Set 0 for no auto-dismiss.
  icon: <SomeIcon size={16} />, // Optional icon left of title
  action: (                     // Optional action button
    <Button size="sm" variant="ghost" onClick={handleUndo}>
      Undo
    </Button>
  ),
  onClose: () => {},            // Called on dismiss (manual or auto)
});
```

### Rules for action buttons

- **Always use `<Button size="sm">`** from `@renderer/components/ui`
- Never use raw `<button>` elements or inline Tailwind classes
- For a single action: pass one `<Button>`
- For multiple actions: wrap in a flex div


## Variants

| Variant | Use Case | Visual Difference |
|---------|----------|-------------------|
| `default` | General notifications | Info-family tone treatment |
| `success` | Successful operations | Success-family tone treatment |
| `warning` | Cautions, non-blocking issues | Warning-family tone treatment |
| `error` | Failed operations, errors | Destructive-family tone treatment |
| `info` | Informational messages | Info-family tone treatment |

Severity is communicated by icon, message text, border, and quiet tone surface. Avoid high-saturation fills or glows for routine feedback.


## Behavior

### Timing

- **Default duration:** 4000ms
- **Set `duration: 0`** to prevent auto-dismiss (requires manual dismissal)

### Display

- **Position:** Top-right, 80px below header
- **Stacking:** Up to 3 visible toasts, stacked vertically with 8px gap
- **Close button:** All toasts have X button (matches dismiss pattern above)
- **Animation:** Sonner built-in (slide from right edge)

### Accessibility

- Toasts have `role="alert"` for screen reader announcements
- The viewport region has `aria-label="Notifications"`
- Close buttons have `aria-label="Dismiss"`


## Adding a New Notification — Checklist

1. **Use `showToast()`.** Do not create a new component.
2. Pick the right variant (`default` for most things, `success` for completions, `error` for failures).
3. Keep the title short (one line, sentence case, no period).
4. Add a description only if the title isn't self-explanatory.
5. If you need an action button, use `<Button size="sm">` — never raw `<button>`.
6. Test in **both light and dark mode**.
7. If you think you need a custom notification component, read the taxonomy above. You probably don't.
