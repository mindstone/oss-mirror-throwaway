/**
 * @file Tutorial Checklist Configuration
 * 
 * TERMINOLOGY NOTE:
 * - "Use Cases" = the personalized workflow suggestions generated for users
 * - "The Spark" = the UI sidebar tab where use cases are displayed
 * 
 * When referencing the UI tab in user-facing text, always use "The Spark tab"
 * (not "Use Cases tab"). The feature was renamed in Dec 2025.
 * 
 * @see rebel-system/help-for-humans/the-spark.md
 * @see rebel-system/help-for-humans/terminology.md
 */

import type { LucideIcon } from 'lucide-react';
import { Handshake, Mail, ScrollText, Brain, Sparkles } from 'lucide-react';
import type { PersonalizedUseCase } from '@shared/types';

/**
 * Base URL for onboarding step images in GCS.
 */
export const ONBOARDING_IMAGE_BASE = 'https://storage.googleapis.com/mindstone-public-assets/rebel';

/**
 * Configuration for a single tutorial checklist step.
 */
interface TutorialStepConfig {
  /** Step ID (numeric for backward compatibility with persisted user data) */
  readonly id: 0 | 1 | 2 | 3 | 4;
  /** User-facing label shown in the checklist widget */
  readonly label: string;
  /** Icon component from lucide-react */
  readonly icon: LucideIcon;
  /**
   * Returns the intro message for this step.
   * Step 0 (coach) starts only from the explicit Home activation card CTA (or
   * by resuming an incomplete coach session) — see
   * docs/plans/260505_home_onboarding_activation.md — and has its own prompt,
   * so its getIntro is unused.
   * Step 4 accepts optional useCases for dynamic content.
   */
  readonly getIntro: (useCases?: PersonalizedUseCase[]) => string;
  /**
   * If true, this step auto-completes based on external signals (not manual "Mark done").
   * Step 0 (coach) auto-completes when the coach conversation finishes.
   */
  readonly autoComplete?: boolean;
}

/**
 * Centralized configuration for all tutorial checklist steps.
 * This is the single source of truth for step UI definitions.
 * 
 * @see docs/plans/finished/260103_tutorial_checklist_extensibility.md
 */
export const TUTORIAL_STEPS = [
  {
    id: 0,
    label: 'Quick intro with Rebel',
    icon: Handshake,
    autoComplete: true,
    // Step 0 is the onboarding coach conversation. It is NOT auto-started:
    // since the May 2026 Home-activation redesign
    // (docs/plans/260505_home_onboarding_activation.md), the coach starts only
    // when the user clicks the Home activation card CTA (or resumes an
    // incomplete coach session); OnboardingCoachOrchestrator handles that
    // explicit launch request. getIntro is unused (the coach has its own
    // prompt), but provided for type completeness.
    //
    // Persistence: handleCoachComplete in OnboardingCoachOrchestrator saves the
    // redundant completion-signal set (completedSteps[0], onboardingCompletedAt,
    // onboardingDay) — SSOT for reading/clearing those signals is
    // src/renderer/features/onboarding/utils/coachCompletionState.ts. App.tsx's
    // 'onboarding-coach-complete' listener only auto-navigates home.
    getIntro: () => '',
  },
  {
    id: 1,
    label: 'Use your first connector',
    icon: Mail,
    getIntro: () => `[ONBOARDING STEP 1 - OUTPUT THIS INTRO VERBATIM, THEN WAIT FOR USER]

Start your response with this text EXACTLY (no preamble, no "I'll help you", just start with the intro):
---

![Integrations](${ONBOARDING_IMAGE_BASE}/step%201.jpg)

## Let's talk about integrations.

An AI assistant isn't much help if it can't access your other tools. That's why I connect to **over 70 services** you already use: Gmail, Slack, Google Calendar, HubSpot, Google Drive, Notion, and many more.

Instead of you jumping between apps to check email here, calendar there, docs somewhere else, your apps come to me. One place for everything.

---

### Use your first connector.

Ask me something like:

> "Show me my last 3 emails"

> "What's on my calendar tomorrow?"

> "Who is my next meeting with?"

Go ahead. Ask me to pull something from one of your connected tools.

---

INSTRUCTIONS:
1. After outputting the intro above, wait for the user to ask for something.
2. When they do, fetch the requested data and display it clearly.
3. After showing results, wrap up with: "That's your real data, pulled in seconds. When you're ready, click **Mark done** in the checklist to continue to the next step, where we'll explore skills."
4. Always include blank lines before and after horizontal rules (---) to ensure proper visual separation.`,
  },
  {
    id: 2,
    label: 'Execute your first skill',
    icon: ScrollText,
    getIntro: () => `[ONBOARDING STEP 2 - OUTPUT THIS INTRO VERBATIM, THEN WAIT FOR USER]

Start your response with this text EXACTLY (no preamble, no "I'll help you", just start with the intro):
---

![Skills](${ONBOARDING_IMAGE_BASE}/step%204.jpg)

## Now let's talk about skills.

If integrations let me access your tools, skills tell me what to do with them.

A skill is a saved set of instructions for a task you do regularly. Instead of explaining what you need step by step, you pick a skill and I handle the details. You can use skills we've built, or create your own with my help.

When a task needs information from multiple places, I can check your calendar, scan your emails, and pull from Slack all at once. What might take you an hour takes me a few minutes.

---

### Execute your first skill.

Type **@** and start typing to see available skills. Try:

> **@meeting-prep/ prepare me for my next meeting**

This will find your next meeting, figure out if it's internal or external, and prepare briefing notes from your emails, Slack, and calendar.

 
**Note: this skill may take up to a minute to gather everything.**

---

INSTRUCTIONS:
1. After outputting the intro above, wait for the user to invoke a skill.
2. When the skill completes, the subagent should return a FULL briefing document (starting with a bold title like **Meeting Title - Date**). Copy and display this briefing prominently in your response — the briefing IS the deliverable.
3. If the subagent returned only metadata or a summary (e.g., "I searched emails and found...") instead of the actual briefing content, acknowledge this and ask me to try again or explain what went wrong.
4. After showing the briefing, add: "That's a skill in action. You can create your own skills for tasks you repeat, just use @write-skill/."
5. If the skill encounters issues (no meetings, tools not connected), acknowledge it gracefully and still explain the value.
6. Wrap up with: "When you're ready, click **Mark done** in the checklist to continue to the next step, where we'll explore memory."
7. IMPORTANT: The briefing and your wrap-up should be in the SAME final response, not separate messages.
8. Always include blank lines before and after horizontal rules (---) to ensure proper visual separation.`,
  },
  {
    id: 3,
    label: 'Add some memory',
    icon: Brain,
    getIntro: () => `[ONBOARDING STEP 3 - OUTPUT EVERYTHING BELOW IN ONE RESPONSE]

IMPORTANT: Output this ENTIRE response at once. After sending the intro, quietly start gathering anything you already know about the user from stored memory so it's ready to share. Keep it simple and conversational.

Start your response with this text EXACTLY:
---

![Memory](${ONBOARDING_IMAGE_BASE}/memory.jpg)

## Now let's talk about memory.

Unlike other AI tools, I don't forget everything after each conversation. I learn about you and your work over time.

**Here's the key:** after every conversation, I automatically review what we discussed and decide what's worth saving. You don't have to ask me to remember things. I just do.

### Where things get saved

I automatically figure out where each piece of information belongs:

**🔒 Private Memory**
Your personal notes. Only you can see this. Your preferences, personal context, sensitive matters. Think of it as your private command center.

**👥 Shared Memory**
Team knowledge saved to your shared workspace folder. Client context, project details, team workflows. Visible to colleagues with folder access.

I'll decide based on context, but you can always tell me where you want something saved. Just say "remember this privately" or "save this to the team folder" and I'll put it exactly where you want.

After each conversation, you'll see a small indicator showing what was saved and where.

---

### Let's start building your memory.

Tell me a bit about yourself:

- **What's your role?** What are you mainly responsible for?
- **What projects are you working on?**
- **What tasks take up most of your time?**

**Try the microphone.** It's often easier to talk than type.

---

INSTRUCTIONS:
1. Output the intro and questions above exactly as written.
2. Immediately after sending the intro, start (in the background) retrieving what you already know about the user from stored memory so it's ready to share.
3. Wait for the user to respond.
4. After they respond, thank them and say: "Here are some other things I've already learned about you since you've started using Rebel." Then summarize the memory you fetched.
5. Explain: "Thanks for sharing that. I'll remember this, and as we keep working together, I'll continue learning about your preferences, projects, and the people you work with." Make it clear Rebel will get smarter over time.
6. Wrap up with: "When you're ready, click **Mark done** in the checklist to continue to the final step, your personalized use cases."
7. Always include blank lines before and after horizontal rules (---) to ensure proper visual separation.`,
  },
  {
    id: 4,
    label: 'Try your first use case',
    icon: Sparkles,
    getIntro: (useCases?: PersonalizedUseCase[]) => {
      const baseIntro = `[ONBOARDING STEP 4 - OUTPUT THIS INTRO VERBATIM]

Start your response with this text EXACTLY (no preamble):
---

![Use Cases](${ONBOARDING_IMAGE_BASE}/step%203.jpg)

## You've made it to the final step! 🎉

I've learned a lot about how I can help you.

---

Then continue based on whether use cases are provided below.`;

      if (useCases && useCases.length > 0) {
        // Use cases are available - the UI will show them as cards, so keep the message brief
        return `${baseIntro}

USE CASES AVAILABLE - Keep it brief, the UI shows use case cards below.

INSTRUCTIONS:
1. Output the intro text exactly as specified above.
2. Say: "Based on your tools, calendar, and what you've shared, I've put together some personalized use cases for you."
3. Say: "Pick one below to start a new conversation, or describe something else you'd like to try."
4. End with: "You can revisit these anytime in **The Spark** tab."
5. Always include blank lines before and after horizontal rules (---) to ensure proper visual separation.

DO NOT list the use cases as text - the UI displays them as interactive cards.`;
      }

      return `${baseIntro}

USE CASES NOT YET AVAILABLE - explain they're being generated.

INSTRUCTIONS:
1. After the intro, explain: "I'm still analyzing your emails, calendar, and what you've shared to generate personalized suggestions."
2. Set expectations: "**They'll appear in The Spark tab shortly**, usually within a few minutes. If they don't appear, just click **Generate** in The Spark tab to create them."
3. Encourage them to try something: "In the meantime, is there something you'd like to try? Just describe a task you do regularly, and I'll help you get it done."
4. Wrap up with:

**ACTION:** Open The Spark tab once they appear. If you don't see any, click **Generate**.

Remember, any task you do regularly can be turned into a reusable skill with @write-skill/.

5. Always include blank lines before and after horizontal rules (---) to ensure proper visual separation.`;
    },
  },
] as const satisfies readonly TutorialStepConfig[];
