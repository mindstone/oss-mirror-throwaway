---
description: "Tips and quips system for agent work status messages — display timing, data structures, dynamic generation, repetition control"
last_updated: "2026-02-04"
---

### Introduction

Mindstone Rebel displays contextual messages while the agent is working to keep users engaged and informed. This document describes the **tips and quips system**: static tips that help users discover features, followed by dynamic quips that provide personality during longer runs.

### See Also

- [BRAND_VOICE](BRAND_VOICE.md) — Overall voice principles, personality traits, and design philosophy
- `src/shared/data/tips.ts` — Static tips data, categories, and random selection helpers
- `src/renderer/features/agent-session/work-surface/utils/personaQuips.ts` — Quip system with duration buckets, tool-specific quips, and rotation logic
- `src/renderer/features/agent-session/work-surface/hooks/useWorkSurfaceView.ts` — Hook that orchestrates tips/quips display timing
- `src/main/services/quipGeneratorService.ts` — Dynamic quip generation via Claude Haiku for long-running turns
- [UI_LAYOUT_AND_INTERACTION_PATTERNS](UI_OVERVIEW.md) — Overall UI patterns including the session status display
- [DESIGN_ICONS](UI_ICONS.md) — Icon library conventions (lucide-react)


### Principles, key decisions

- **Tips teach, quips entertain**: Tips help users discover features; quips provide personality and reassurance during waits.
- **Progressive disclosure**: Show tips early (when users are most attentive), switch to quips for longer runs.
- **Consistent visual feedback**: All tips and quips display with the animated Rebel loading GIF for a unified look.
- **Non-intrusive**: Messages appear in the existing status area without disrupting workflow.


### Display timing

The system uses time-based phases during agent work:

| Phase | Duration | Content | Visual |
|-------|----------|---------|--------|
| **Initial** | 0–4 seconds | Spinner only (ellipsis state) | Loading GIF |
| **Tips** | 4–10.5 seconds | Random product tips | Loading GIF |
| **Quips** | 10.5+ seconds | Persona quips (static or tool-specific) | Loading GIF |
| **Dynamic quips** | 30+ seconds | Haiku-generated contextual quips | Loading GIF |

The thresholds are defined in `personaQuips.ts`:

```typescript
export const PERSONA_QUIP_DELAY_MS = 4000;    // When to start showing content
export const TIP_PHASE_DURATION_MS = 6500;    // How long tips show before quips
export const DYNAMIC_QUIP_THRESHOLD_MS = 30_000; // When to request Haiku quips
export const PERSONA_QUIP_ROTATION_MS = 6500; // How often content rotates
```


### Visual feedback

All tips and quips display with the animated Rebel loading GIF (`@renderer/assets/animations/loading.gif`), providing consistent visual feedback during agent processing. Router phase icons (Brain, Zap, Search, Check) are shown during the initial evaluation phase before tips begin.


### Tips data structure

Tips are stored in `src/shared/data/tips.ts`:

```typescript
interface Tip {
  id: string;
  category: 'keyboard' | 'voice' | 'workspace' | 'skills' | 'mcp' | 'settings' | 'productivity' | 'advanced';
  content: string; // Markdown-formatted
}
```

Tips support **bold** formatting and can include feature names. They are randomly selected, with recent tips excluded to avoid repetition.

Categories enable future filtering (e.g., show only keyboard tips, or weight by user behaviour).


### Quips data structure

Quips are organised by persona state (duration bucket × processing stage):

```typescript
type PersonaState = 'processing_intro' | 'processing_short' | ... | 'generation_epic';
```

Additionally, **tool-specific quips** are shown when the agent is actively using a tool:

```typescript
type ToolCategory = 'search' | 'read' | 'write' | 'command' | 'web' | 'agent' | 'unknown';
```

For runs exceeding 30 seconds, **dynamic quips** are generated via Claude Haiku using the user's message context for more relevant, witty status messages.


### Implementation notes

**Rendering location**: Tips and quips appear in `SessionStatusTicker` within the conversation pane, alongside the thinking elapsed timer.

**State management**: The `useWorkSurfaceView` hook manages:
- `busyElapsedMs` — Time since turn started
- `personaHeadline` — Current tip or quip text
- `dynamicQuips` — Haiku-generated quips (cached per turn)
- Phase transitions based on elapsed time

**Avoiding repetition**: Tips use `getRandomTipExcluding(recentIds)` to track recently shown tips. Quips use cursor refs per state to cycle through options.


### Future considerations

- **User preferences**: Allow disabling tips or quips in settings
- **Tip targeting**: Show tips based on unused features or user behaviour
- **Tip dismissal**: Let users dismiss a tip permanently
- **Analytics**: Track which tips lead to feature discovery


### Appendix: Adding new tips

1. Edit `src/shared/data/tips.ts`
2. Add a new `Tip` object with unique `id`, appropriate `category`, and markdown `content`
3. Test by triggering a short agent run and verifying tips appear
4. No rebuild required—tips are loaded at runtime

Example:

```typescript
{
  id: 'new-feature-tip',
  category: 'productivity',
  content: '**Tip:** You can now do X by pressing **⌘Y** or using the menu.',
}
```


