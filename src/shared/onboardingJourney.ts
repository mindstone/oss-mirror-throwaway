/**
 * 14-Day Onboarding Journey
 * 
 * Daily tasks that guide users from AI novice to AI-fluent.
 * Week 1: Rebel Basics + AI Foundations
 * Week 2: Advanced Patterns + Graduation
 */

export interface DailyTask {
  title: string;
  description: string;
  prompt: string;
}

export const DAILY_TASKS: Record<number, DailyTask> = {
  // WEEK 1: Rebel Basics + AI Foundations
  1: {
    title: 'Context matters',
    description: 'The more context you give, the better the answer. Try it.',
    prompt: 'Tell me what\'s on my mind this week — but first without checking anything. Then check my calendar and emails and show me the difference. I want to see how much context matters.'
  },
  2: {
    title: 'Let AI ask you',
    description: 'Instead of crafting the perfect prompt, let Rebel interview you',
    prompt: 'Run the @meeting-prep skill for my next meeting. I want to see how you ask me questions instead of me having to think of everything.'
  },
  3: {
    title: 'AI that knows you',
    description: 'Teach Rebel something that will make every future conversation better',
    prompt: 'Help me add something important to my memory - my role, how I like to communicate, key projects I\'m working on, or people I work with regularly.'
  },
  4: {
    title: 'High-impact workflows',
    description: 'Not all AI use cases are equal. Find the ones worth your time.',
    prompt: 'Based on what you know about my work, what are the highest-impact ways I could use you? I want workflows that save real time, not party tricks.'
  },
  5: {
    title: 'Build a skill',
    description: 'Turn something you do repeatedly into a reusable template',
    prompt: 'Help me create a skill for something I do often. Walk me through it step by step - I want to understand how skills work so I can make more.'
  },
  6: {
    title: 'Coaching insights',
    description: 'See how Rebel reflects on your conversations to help you improve',
    prompt: 'Look at my recent conversations and give me honest coaching feedback. What patterns do you see? How could I be using you more effectively?'
  },
  7: {
    title: 'Week one review',
    description: 'Celebrate your first week and capture what\'s working',
    prompt: 'Help me review my first week with Rebel. What workflows have I used? What\'s been most valuable? Let\'s document my top 5 so I don\'t forget them.'
  },

  // WEEK 2: Advanced Patterns
  8: {
    title: 'Scheduled AI',
    description: 'Set up an automation that works while you sleep',
    prompt: 'Help me create my first automation - a daily morning briefing that summarizes what I need to know before I start my day.'
  },
  9: {
    title: 'Think out loud',
    description: 'Use voice to brainstorm - click the mic and just talk',
    prompt: 'I want to brainstorm something with you using voice. When I click send, I\'ll use the microphone button to talk through my ideas instead of typing.'
  },
  10: {
    title: 'Chain of thought',
    description: 'Watch Rebel combine multiple tools to solve something complex',
    prompt: 'I have a complex task that needs research, analysis, and writing. Help me with it and show me how you chain multiple tools together - I want to see the full workflow.'
  },
  11: {
    title: 'Find automations',
    description: 'Interview yourself to discover what could run on autopilot',
    prompt: 'Run the @interview-me-to-look-for-ai-automations skill. Ask me about my weekly routines and help me find tasks that are ripe for automation.'
  },
  12: {
    title: 'Organize your context',
    description: 'Structure your memory spaces for maximum usefulness',
    prompt: 'Help me think about how my spaces are organized. Should I create new ones? Restructure what\'s there? I want my context to be well-organized for you.'
  },
  13: {
    title: 'Extend capabilities',
    description: 'Connect a new tool to expand what Rebel can do',
    prompt: 'What integrations would be most valuable for my work that I haven\'t connected yet? Help me set one up - I want to see how MCPs extend your capabilities.'
  },
  14: {
    title: 'Your AI playbook',
    description: 'Graduate with a personal strategy for the next 90 days',
    prompt: 'Help me create my Personal AI Playbook - a document capturing my best workflows, the skills I\'ve built, my automations, and my plan for the next 90 days. This is my graduation from the 14-day journey.'
  }
};

/**
 * AI Competency lessons for each day.
 * These are the "mini-lessons" that explain WHY each task matters.
 */
const DAILY_LESSONS: Record<number, string> = {
  1: `The same question gets wildly different answers depending on what context you provide. Most people type a question and hope for the best. The 5% who've figured this out start by giving context — their situation, constraints, what they've already tried.

Today's task shows you the difference. You'll ask me something with no context, then watch what happens when I can actually see your calendar and recent emails. The gap is dramatic. This is the single biggest lever in working with AI.`,

  2: `Here's a secret: you don't need to craft the perfect prompt. That's exhausting and often wrong. Instead, let me interview you. When you run a skill, I'll ask the questions that surface what I actually need to know.

This is called "reverse prompting" — and it's how the best AI users work. They start with a rough direction and let the conversation sharpen it. The meeting-prep skill is a perfect example. You'll see how my questions help you think through things you wouldn't have remembered to mention.`,

  3: `Every conversation with me starts from scratch unless you teach me otherwise. When you add something to memory, you're investing in every future conversation — I'll know your role, your projects, the people you work with.

Think of memory as compound interest. The more I know about your world, the less explaining you need to do each time. Today, add something that will make your next hundred conversations better.`,

  4: `Not all AI use cases are worth your time. Some are party tricks (write me a haiku!), some are marginal (summarize this email), and some are transformational (synthesize everything about this client before the call).

The framework is simple: high value × easy to do = focus here. Today we'll find your highest-impact workflows — the ones that actually deserve your attention. Skip the party tricks.`,

  5: `A skill is just a reusable prompt that can read your context. Once you create one, you've turned a 10-step process into a single command.

The best AI users build small libraries of these. Not complicated — just the things they do over and over. A weekly update template. A client research pattern. Today you'll create your first skill and understand the pattern for making more.`,

  6: `I notice patterns in how you use me. Some are great — you should lean into them. Others might be limiting what you get out of this relationship.

Today's task is about honest feedback. I'll look at your recent conversations and tell you what I see. Where are you using me well? Where are you leaving value on the table? This is the kind of coaching that accelerates fluency.`,

  7: `After a week, you've likely found 2-3 workflows that actually stick. Maybe more. Today we're documenting them so you don't lose them.

Your Personal AI Playbook starts here — a record of what works for YOU. Not generic tips. Not what works for other people. The specific patterns that match your work and your style. We'll capture your top 5 before the second week begins.`,

  8: `Everything so far has been you initiating conversations. But the real leverage comes when AI works in the background — when I'm synthesizing your morning briefing while you sleep.

Automations are the difference between "tool" and "teammate." Today you'll create your first one. It's simpler than you think, and once you see it working, you'll think of a dozen more.`,

  9: `Some thoughts are easier to speak than to type. When you're brainstorming, working through a problem, or just thinking out loud, voice removes the friction of editing yourself.

Today's task is about trying a different mode of thinking. Click the microphone and just talk. Don't worry about structure — that's my job. You might be surprised how much easier complex thoughts flow when you're not watching yourself type.`,

  10: `Simple questions get simple answers. Complex problems need multiple tools — research, analysis, comparison, synthesis.

Today you'll bring me something that requires chaining capabilities together. Watch how I orchestrate multiple tools to solve it. This is where AI goes from "helpful assistant" to "force multiplier." Understanding this pattern unlocks a different level of delegation.`,

  11: `You have routines you do every week that you barely notice anymore. Check-ins. Reports. Summaries. Updates. Many of these are automatable — you just haven't thought to look.

Today I'll interview you about your weekly rhythms and help you spot the candidates. Not everything should be automated. But the things that can be? That's time you get back. Permanently.`,

  12: `Context only works if it's organized. A messy memory space means I'm searching through noise to find signal.

Today we'll look at how your spaces are structured. Maybe you need new ones for different projects. Maybe some need cleanup. The goal is to make it easy for me to find the right context at the right time — which makes every conversation better.`,

  13: `Every tool I can't access is a wall in what I can help with. MCPs (Model Context Protocol) let you extend my capabilities — connect Notion, Slack, your CRM, whatever your work lives in.

Today you'll add a new integration. Pick something you use often that I can't currently see. Watch how it changes what becomes possible. This is how you build a truly personalized AI stack.`,

  14: `You've learned the foundations, built habits, created automations, and extended capabilities. Now we capture it all in one place — your Personal AI Playbook.

This isn't a certificate. It's a working document you'll reference and update. Your best workflows. Your skills. Your automations. And your plan for the next 90 days. The journey doesn't end today — it graduates to the next level.`
};

/**
 * Get Rebel's voice explanation for the current day.
 * Returns the full mini-lesson for deeper understanding.
 */
export function getJourneyExplanation(day: number): string {
  return DAILY_LESSONS[day] ?? 'Every day brings something new. Complete today\'s task in The Spark.';
}
