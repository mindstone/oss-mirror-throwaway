---
description: "Post-setup onboarding checklist state, including the Home attention-card intro and conversation-based tutorials."
last_updated: "2026-06-11"
---

### Introduction

The **Tutorial Checklist** tracks post-wizard onboarding progress. Step 0 is the Home activation intro: a persistent, non-dismissible but non-blocking card in "Needs your attention today" that starts or resumes the onboarding coach conversation. Steps 1-4 are interactive conversation-based tutorials for Rebel's core capabilities.

The Home activation card disappears only after the coach intro completes. The coach is **not** auto-launched after the setup wizard — it starts only from the Home card CTA or by resuming an incomplete coach session (see `docs/plans/260505_home_onboarding_activation.md`).

> **Status note (2026-06):** the sidebar "Getting Started" widget and its step-progression hook were removed in Feb 2026 (`38c57b15d`), so steps 1-4 currently have no launcher UI — `getIntro` for those steps is unwired. The step config remains the single source of truth for step definitions and completion bookkeeping (`OnboardingCoachOrchestrator` uses it to decide when the checklist is fully complete), and persisted `onboardingChecklist` state is still read by What's New gating and the coach-completion signals. Historically, each tutorial step created a dedicated conversation session with pre-injected instructions that guide the user through a specific capability.


### See Also

- [ONBOARDING_SETUP_WIZARD](ONBOARDING_SETUP_WIZARD.md) – The first-run setup wizard (workspace, API keys, permissions)
- [UI_SIDEBAR_SESSION_HISTORY](UI_SIDEBAR_SESSION_HISTORY.md) – Session sidebar where the checklist widget appears
- [THE_SPARK](THE_SPARK.md) – Dashboard tab; personalized workflows are generated during step 4


### The Steps

| Step | Label | What User Learns |
|------|-------|------------------|
| 0 | Home activation intro | How Rebel becomes more useful when it understands goals and connected context |
| 1 | Use your first connector | How to access email, calendar, and other connected tools |
| 2 | Execute your first skill | How to invoke skills with `@` mentions, e.g., `@meeting-prep/` |
| 3 | Add some memory | How Rebel remembers context across conversations |
| 4 | Try your first use case | Personalized workflow suggestions based on connected tools |

Each step:
- Creates a new conversation session when started
- Injects hidden instructions that guide the agent's response
- Displays an intro with imagery (hosted on GCS) and clear prompts
- Can be completed in any order (non-sequential)
- Can be restarted via the "Undo" button


### Technical Overview

#### Code References

| Component | Location |
|-----------|----------|
| **Step config (single source of truth)** | `src/renderer/features/onboarding/config/tutorialChecklistConfig.ts` |
| Step 0 launch + completion bookkeeping | `src/renderer/features/onboarding/OnboardingCoachOrchestrator.tsx` (`handleCoachComplete`) |
| Coach-completion signal SSOT (read/clear) | `src/renderer/features/onboarding/utils/coachCompletionState.ts` |
| Widget UI | *Removed Feb 2026* (`38c57b15d`); the sidebar slot now hosts `WhatsNewWidget` |
| Progression logic | *Removed Feb 2026* with the widget (`useChecklistProgression.ts`) |
| Type definitions | `src/shared/types/settings.ts` (`OnboardingChecklist`, `OnboardingChecklistStep`) |
| App integration | `src/renderer/App.tsx` (activation-card gating, `handleResetOnboardingChecklist`) |
| Hidden message filter | `src/renderer/features/agent-session/store/selectors.ts` (`selectVisibleMessages`) |

#### State Management

The checklist state is stored in `AppSettings.onboardingChecklist`:

```typescript
interface OnboardingChecklist {
  step: OnboardingChecklistStep;  // 0 | 1 | 2 | 3 | 4 | 'complete' | 'dismissed'
  sessionIds?: Partial<Record<0 | 1 | 2 | 3 | 4, string>>;  // Session per step
  completedSteps?: Partial<Record<0 | 1 | 2 | 3 | 4, boolean>>;  // Individual completion
  isExpanded?: boolean;  // Widget collapsed/expanded state
}
```

**Lifecycle:**
- Step 0 is owned by Home and `OnboardingCoachOrchestrator`.
- `step: 1-4` – Active checklist, indicates suggested next step
- `step: 'complete'` – All 4 steps completed, shows celebration screen
- `step: 'dismissed'` – User dismissed the widget, no longer shown

#### Hidden Prompt Injection

Step intro content is injected as the user's first message in each conversation. These messages are hidden from the transcript via a prefix filter:

```typescript
// In selectors.ts
const HIDDEN_ONBOARDING_PROMPT_PREFIX = '[ONBOARDING STEP';
// Messages starting with this prefix are filtered from visible messages
```

The agent receives the full instructions and outputs a polished intro. Users only see the agent's response.

#### Step Content Location

Step definitions are centralized in `tutorialChecklistConfig.ts`:

```typescript
// Single source of truth for step UI and content
export const TUTORIAL_STEPS: TutorialStepConfig[] = [
  { id: 1, label: 'Integrations', icon: Plug, getIntro: () => '...' },
  { id: 2, label: 'Memory spaces', icon: FolderHeart, getIntro: () => '...' },
  // etc.
];

// Derived type ensures consistency
export type TutorialStepId = (typeof TUTORIAL_STEPS)[number]['id'];
```

Each step's `getIntro()` returns a complete intro message including:
- GCS-hosted image URL
- Markdown-formatted educational content
- Example prompts for the user to try
- Instructions for the agent on how to conclude

**To add/modify steps:** Edit `tutorialChecklistConfig.ts`. The widget and hook automatically pick up changes via `TUTORIAL_STEPS`.

#### Resetting the Checklist

Users can restart the tutorial checklist via:
- **Settings → Diagnostics → Reset Tutorial Checklist** – Resets checklist state without affecting other settings

The reset clears `completedSteps` and sets `step: 1` (`handleResetOnboardingChecklist` in `src/renderer/App.tsx`).

This is deliberately separate from **Relaunch onboarding** (Settings), which clears the coach-completion signals but does NOT reset tutorial-checklist progress — see [ONBOARDING_SETUP_WIZARD § first-run gating](ONBOARDING_SETUP_WIZARD.md) and `src/renderer/features/onboarding/utils/coachCompletionState.ts` for the contract.


### Analytics

The tutorial checklist tracks:
- `tracking.onboarding.checklistStepStarted(step, sessionId)` – When a step session is created
- `tracking.onboarding.checklistStepCompleted(step, sessionId)` – When user marks a step done


### Future Considerations

- **Daily scheduled items**: Could extend the checklist with new items unlocked over time
- **Parallel conversations**: Users can already switch between step sessions; no concurrent LLM calls
- **Multimedia embedding**: Step intros support markdown images; video URLs would auto-embed via `MediaEmbed` (YouTube requires the localhost wrapper server — see [REACT_PLAYER_INTEGRATION.md](REACT_PLAYER_INTEGRATION.md#stop--youtube-embeds-require-the-localhost-wrapper-server))
- **Archived step 5**: A planned "Extend or create a skill" step was archived before implementation – see `docs/obsolete/tutorial_checklist_step5_skill_creation.md`
