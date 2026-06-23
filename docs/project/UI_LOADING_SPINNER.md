---
description: "Concise reference for loading indicators in Mindstone Rebel, with signposts to UI/Design docs and key code locations."
last_updated: "2026-05-05"
---

# Loading Spinners

Short reference for where and how loading spinners are implemented in the app.

## See also

- [UI_OVERVIEW.md](./UI_OVERVIEW.md) — Busy states and how we surface progress/interrupt options in the UI.
- [DESIGN.md](./DESIGN.md) — Visual hierarchy; motion/animation guidelines to expand in future.
- [ARCHITECTURE_MESSAGE_QUEUE.md](./ARCHITECTURE_MESSAGE_QUEUE.md) — Busy/queue states that often pair with spinners.
- `src/renderer/components/ui/Spinner.tsx` — Shared Spinner component (preferred for new UI).

## Loading Taxonomy

Storybook now has a `Design System/Mixed/Loading Indicators` page that separates loading by user meaning:

- `Spinner` — compact utility wait for small controls, rows, dropdowns, and inline status text.
- `RebelLoadingIndicator` — mascot-spinner indicator for meaningful waits where Rebel is visibly thinking, preparing, generating, or setting something up.
- Skeletons — fill-only page or card placeholders when the final content shape is known. Do not add strokes to skeleton shapes.

The mascot is intentionally not the default spinner. It should reassure users during substantive Rebel work, not decorate every tiny wait state.

## Shared Spinner Component (Utility)

For new UI, use the shared `<Spinner />` component from the UI library:

```tsx
import { Spinner } from '@renderer/components/ui';

// Basic usage
<Spinner />

// With size and label
<Spinner size="sm" label="Loading..." />

// Decorative, for use inside a button that already exposes the loading state
<Spinner size="xs" decorative />
```

**Props:**
- `size`: `'xs'` (12px), `'sm'` (14px), `'md'` (20px, default), `'lg'` (32px)
- `label`: Optional text displayed alongside the spinner
- `decorative`: Hides the spinner from assistive technology. Use only when a parent control already has a loading-state label or visible loading text; do not combine with `label`.
- `className`: Additional CSS classes

**Location:** `src/renderer/components/ui/Spinner.tsx`

## Mascot Loading Indicator

Use `<RebelLoadingIndicator />` when the waiting state is part of the product experience. It uses the same `loading.gif` mascot spinner as the conversation thinking panel:

```tsx
import { RebelLoadingIndicator } from '@renderer/components/ui';

<RebelLoadingIndicator
  layout="stacked"
  size="lg"
  label="Rebel is thinking"
  description="This can take a moment."
/>
```

Good fits:
- agent thinking and progress surfaces
- onboarding and setup checks
- generation or preparation flows where reassurance helps

Avoid it for:
- table cells
- tiny retry buttons
- dropdown loading
- dense settings rows

**Location:** `src/renderer/components/ui/RebelLoadingIndicator.tsx`


## CSS Utility (Legacy Only)

The legacy `spinner-small` CSS class remains available for old surfaces, but new production TSX should use `<Spinner />`:

- Defined at: `src/renderer/styles/foundations/utilities.css`

```tsx
// Inline indicator next to status text
<span className="spinner-small" aria-hidden /> Loading…
```

Notes:
- Size inherits from the CSS class; color inherits via `currentColor`.
- For decorative spinners, include `aria-hidden`. For regions that are waiting, prefer setting a container `aria-busy="true"` and optionally `aria-live="polite"` for the status text.
- New compact utility waits should use `<Spinner />`, not new `spinner-small` call sites.

## Specialized module styles

Some features use local CSS‑module spinners for bespoke visuals:

- Onboarding wizard: `src/renderer/features/onboarding/OnboardingWizard.module.css` (`.spinner`) with usages in `OnboardingWizard.tsx`.
- Compaction overlay: `src/renderer/features/agent-session/components/CompactionOverlay.module.css` (`.spinner`) with usages in `CompactionOverlay.tsx`.
- Settings save toast: inline SVG icon animated via `src/renderer/features/settings/components/SettingsSurface.module.css` (`animation: spin …`) used in `SettingsSurface.tsx`.

## Known usages (non‑exhaustive)

- `src/renderer/features/composer/AgentComposer.tsx` — uses `<Spinner />` for primary button pending states and dense voice-processing waits.
- `src/renderer/features/composer/InteractionStrip.tsx` — uses `<Spinner />` for the external mic processing state.
- `src/renderer/features/agent-session/components/UserQuestionCard.tsx` — uses `<Spinner />` for supplemental mic and file upload processing states.
- `src/renderer/features/composer/components/MentionPopover.tsx` — uses `<Spinner />` for compact library loading.
- `src/renderer/features/onboarding/steps/WelcomeStep.tsx` — uses `<RebelLoadingIndicator />` for setup checks and `<Spinner />` for compact retry waits.
- `src/renderer/features/onboarding/OnboardingWizard.tsx` — shows module‑scoped `.spinner` during validation/connectivity checks.
- `src/renderer/features/agent-session/components/CompactionOverlay.tsx` — shows module‑scoped `.spinner` during compaction phase.
- `src/renderer/features/settings/components/SettingsSurface.tsx` — uses rotating `SpinnerIcon` during “saving…” toast.

## Related: skeleton loading

Skeletons should structurally mirror their post-load shell — when a shell is redesigned, audit and update the corresponding skeleton in the same change, or the placeholder visibly "jumps" on load.

Skeleton placeholders are used where content shape is known:
- Onboarding skeleton button: `src/renderer/features/onboarding/OnboardingWizard.module.css` (`.skeletonButton`)
- Contextual dashboard skeletons: `src/renderer/features/contextual-dashboard/ContextualReveal.module.css`

## Future improvements

- Consider removing the legacy `spinner-small` class once no markdown/docs examples or older surfaces need it.
- Consider consolidating module-scoped spinner styles (onboarding wizard, compaction, settings save toast) to use the shared component where the visual contract matches.
- Review meaningful wait states for `RebelLoadingIndicator` adoption instead of treating the mascot as a generic spinner replacement.


