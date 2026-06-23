---
description: "Feature maturity badge guidance — Labs, Early, Beta, stable states, tooltip behaviour, navigation tab usage"
last_updated: "2026-01-23"
---

# Feature Maturity Denotation (Labs, Beta)

Mindstone Rebel uses visual badges to indicate the maturity level of features, helping users understand which features are experimental, early-stage, or polished.

## See Also

- [UI_ICONS.md](UI_ICONS.md) - Icon library and usage patterns
- [TOOLTIPS.md](TOOLTIPS.md) - Tooltip component usage guidance
- [UI_OVERVIEW.md](UI_OVERVIEW.md) - Overall UI layout and patterns
- [src/renderer/components/ui/MaturityBadge.tsx](../../src/renderer/components/ui/MaturityBadge.tsx) - Badge component implementation


## Maturity Levels

| Level | Badge | Meaning | Visual Style |
|-------|-------|---------|--------------|
| **Labs** | Flask icon | Experimental feature. May not work as expected, could be modified or removed in future versions. | Muted gray flask icon (`FlaskConical`) |
| **Early** | `Early` | Actively being shaped based on feedback. Feature direction may change. | Purple/violet (brand color) |
| **Beta** | Rocket icon | Works well but still being refined. Bug reports welcome. | Muted gray rocket icon (`Rocket`), tab text slightly dimmed |
| *(none)* | - | Stable, production-ready feature. | No badge |


## Component Usage

```tsx
import { MaturityBadge } from '@renderer/components/ui';

// Labs - experimental
<MaturityBadge level="labs" featureName="The Spark" />

// Early - actively evolving
<MaturityBadge level="early" featureName="Memory Sync" />

// Beta - mostly stable
<MaturityBadge level="beta" featureName="Automations" />
```

### In Navigation Tabs

Surface tabs in `FlowPanelsShell` support `maturity` and `dimmed` properties:

```tsx
const surfaceTabs: SurfaceTab[] = [
  { id: 'usecases', label: 'The Spark', icon: Sparkles, maturity: 'labs', dimmed: true },
  // ...
];
```


## Tooltip Behavior

Each badge shows a tooltip on hover explaining what the maturity level means. Clicking the badge opens the community forum for feedback.


## When to Use Each Level

### Labs
- Feature is speculative or proof-of-concept
- Significant changes or removal possible
- Example: The Spark dashboard

### Early
- Feature concept is validated
- Actively collecting feedback to shape direction
- Breaking changes possible but less likely

### Beta
- Feature is functionally complete
- Minor refinements and bug fixes expected
- Will continue to be developed
- Tab text is slightly dimmed to indicate work-in-progress status

### No Badge (Stable)
- Feature is production-ready
- No special warnings needed
