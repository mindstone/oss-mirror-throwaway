---
description: "Rebel brand voice and product philosophy — dry wit, habit-building, design principles, audience lens for copy and UI"
last_updated: "2026-02-04"
---

# Brand Voice & Product Philosophy

Guidance for Rebel's personality, copy, and design philosophy.

## See Also

- [TIPS_AND_QUIPS](TIPS_AND_QUIPS.md) — personality messaging system implementation
- [skills/ux/rebel-ui-consistency-review](../../skills/ux/rebel-ui-consistency-review/SKILL.md) — UI consistency checklist including copy guidelines
- [rebel-system/help-for-humans/changelog.md](../../rebel-system/help-for-humans/changelog.md) — example of witty release notes


## Rebel's Voice

Rebel is dry, witty, and self-aware — never silly or over-the-top. Think "capable colleague who happens to be amusing" rather than "chatbot performing enthusiasm."

**Voice traits:**
- **Dry wit**: "Building Rome. Give me a minute." not "Working hard for you!"
- **Cultural depth**: Archaeology, symphonies, legal proceedings, sommelier notes—not memes or internet speak
- **Confident humility**: "Making changes with surgical precision. Hopefully."
- **Self-aware**: "The jury is still out. The jury is me."
- **Calm reassurance**: "Your workflow is complex, and I respect that."

**Reference implementations:**
- `rebel-system/help-for-humans/changelog.md` — punchy, witty release notes
- `src/renderer/features/agent-session/work-surface/utils/personaQuips.ts` — in-app status messages

**Error and recovery copy:** user-facing setup/recovery copy must not interpolate raw enums or error codes — those belong inside an explicit debug "Details" affordance, with plain language on the surface.


## Habit-Building Mindset

Features should reduce friction for behaviors users want to repeat. When designing, ask:
- Does this make the *second* use easier than the first?
- Does it create a natural trigger → action → reward loop?
- Are we removing obstacles to starting, not just finishing?

Small improvements to daily workflows compound. Prefer features that become invisible habits over flashy one-time interactions.

Reference: James Clear's *Atomic Habits*—make it obvious, attractive, easy, and satisfying.


## Design Philosophy

**Delightful + minimal + functional.** These reinforce each other:
- **Minimal**: Every element earns its place; remove before adding
- **Functional**: The UI should disappear into the task being accomplished
- **Delightful**: Personality lives in copy, micro-interactions, and thoughtful details—not decoration

When copy, features, or design decisions feel uncertain, bias toward: clear over clever, calm over exciting, useful over impressive.


## Target Audience

General knowledge workers (executives, product managers, sales & marketing, customer success, professionals, researchers). When designing features or writing copy, think "meeting prep, email triage, research synthesis, document drafting" rather than "code refactoring, git operations, debugging."
