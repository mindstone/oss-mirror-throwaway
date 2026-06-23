# Archived: Tutorial Checklist Step 5 - Skill Creation

**Archived:** 2026-01-03
**Status:** Never implemented

## What Was Planned

Step 5 of the tutorial checklist was intended to guide users through creating or extending a skill:

- **Label:** "Extend or create a skill"
- **Icon:** PenTool (lucide-react)
- **Goal:** Teach users how to use `@skill-creator/` to create custom skills

## Why It Was Removed

Step 5 was removed because:

1. **Never implemented**: The UI widget displayed step 5, but no `STEP_INTROS[5]` content was created
2. **Redundant with step 2**: Step 2's conclusion already mentions `@skill-creator/`:
   > "You can create your own skills for tasks you repeat, just use @skill-creator/."
3. **Keeps checklist lean**: 4 steps is more approachable than 5

## Files That Were Changed

- `src/shared/types.ts` – `OnboardingChecklistStep` removed `5` from union
- `src/renderer/features/onboarding/components/OnboardingChecklistWidget.tsx` – Removed step 5 from `CHECKLIST_STEPS`
- `src/shared/utils/settingsUtils.ts` – Added migration to clean up any persisted step 5 data

## How to Resurrect

If you want to add step 5 back:

1. Add `5` back to `OnboardingChecklistStep` union in `src/shared/types.ts`
2. Update `sessionIds` and `completedSteps` Record types to include `5`
3. Add `STEP_INTROS[5]` content in `useChecklistProgression.ts` following the pattern of steps 1-4
4. Add step 5 to `CHECKLIST_STEPS` array in `OnboardingChecklistWidget.tsx`
5. Update `handleChecklistStepClick` in `App.tsx` to accept `1 | 2 | 3 | 4 | 5`
6. Update the completion check in `useChecklistProgression.ts` to include step 5

### Suggested Content (Draft)

If implementing, consider this structure:

```typescript
5: `[ONBOARDING STEP 5 - OUTPUT THIS INTRO VERBATIM, THEN WAIT FOR USER]

Start your response with this text EXACTLY:
---

![Skills](${ONBOARDING_IMAGE_BASE}/skill-creator.jpg)

## Create your own skill.

You've seen what skills can do. Now let's create one tailored to your work.

A skill is just a set of instructions I follow. You describe what you want done, and I save it for next time.

---

### Create a skill for something you do regularly.

Type:

> **@skill-creator/ create a skill that...**

Describe a task you repeat often. For example:
- "Create a skill that summarizes my unread Slack messages each morning"
- "Create a skill that drafts a weekly status update from my calendar and emails"

---

INSTRUCTIONS:
1. Wait for the user to invoke @skill-creator/
2. Guide them through skill creation
3. After the skill is saved, wrap up with: "Your first custom skill is ready. You can invoke it anytime with @your-skill-name/."
`
```

## See Also

- [ONBOARDING_TUTORIAL_CHECKLIST](../project/ONBOARDING_TUTORIAL_CHECKLIST.md) – Current tutorial checklist documentation
- [SKILLS_DISCOVERY](../project/SKILLS_DISCOVERY.md) – How skills are discovered and invoked
