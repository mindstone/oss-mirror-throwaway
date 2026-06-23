/**
 * useCoachContent - Determines Coach section framing by user state
 *
 * Provides title, subtitle, and sizing for the Coach section.
 * Content comes from three dynamic sources (managed by CoachSection):
 *   1. Coaching insights — generated from past conversations (7-day TTL)
 *   2. Use cases — personalized from the use case library
 *   3. Connector suggestions — only for new users with zero connectors
 *
 * Static suggestions are limited to onboarding guidance (connector setup,
 * capability discovery). Established users see only dynamic content.
 */

import { useMemo } from 'react';
import type { HomepageUserState } from './useHomepageState';

export type CoachSize = 'large' | 'small' | 'minimal';

export interface CoachSuggestion {
  id: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaPrompt: string;
}

export interface CoachContentResult {
  size: CoachSize;
  title: string;
  subtitle?: string;
  suggestions: CoachSuggestion[];
}

/** Suggestions for users who have NO connectors — focused on value of connecting */
const CONNECT_TOOLS_SUGGESTIONS: CoachSuggestion[] = [
  {
    id: 'connect-calendar',
    title: 'Connect your calendar',
    description: 'I\'ll prep you for your next meeting — context, talking points, and follow-ups ready in 30 seconds.',
    ctaLabel: 'Connect calendar',
    ctaPrompt: 'Help me connect my calendar so you can prep me for meetings.',
  },
  {
    id: 'connect-email',
    title: 'Connect your email',
    description: 'I\'ll summarise what needs your attention, flag urgent threads, and draft replies.',
    ctaLabel: 'Connect email',
    ctaPrompt: 'Help me connect my email so you can manage my inbox.',
  },
  {
    id: 'connect-slack',
    title: 'Connect Slack',
    description: 'I\'ll surface important mentions, summarise channels, and help you respond faster.',
    ctaLabel: 'Connect Slack',
    ctaPrompt: 'Help me connect Slack so you can keep me on top of messages.',
  },
];

/** Backfill suggestions for established users — shown when use cases are dismissed
 * to keep the carousel populated with diverse content types */
const ESTABLISHED_BACKFILL_SUGGESTIONS: CoachSuggestion[] = [
  {
    id: 'fyi-weekly-review',
    title: 'Run a weekly review',
    description: 'I can pull together what happened this week — decisions made, threads left open, and what\'s coming up next.',
    ctaLabel: 'Try this',
    ctaPrompt: 'Help me do a weekly review. Summarise my key decisions, open threads, and what\'s coming up next week.',
  },
  {
    id: 'fyi-automate-something',
    title: 'Automate a recurring task',
    description: 'If you find yourself doing the same thing every Monday, I can probably handle it. Tell me what\'s repetitive.',
    ctaLabel: 'Try this',
    ctaPrompt: 'I want to automate a recurring task. Help me figure out what I can delegate to you on a schedule.',
  },
  {
    id: 'fyi-decision-log',
    title: 'Start a decision log',
    description: 'Track the decisions you\'re making and why. Useful when someone asks "why did we do that?" in three months.',
    ctaLabel: 'Try this',
    ctaPrompt: 'Help me start a decision log. I want to track key decisions and the reasoning behind them.',
  },
];

/** Capability suggestions for new users — only shown before the use case library populates */
const CAPABILITY_SUGGESTIONS: CoachSuggestion[] = [
  {
    id: 'try-email-draft',
    title: 'Draft emails in your voice',
    description: 'Tell me who it\'s to and what you need to say. I\'ll handle tone, formatting, and follow-ups.',
    ctaLabel: 'Try this',
    ctaPrompt: 'Help me draft a professional email.',
  },
  {
    id: 'try-document-summary',
    title: 'Summarise any document',
    description: 'Drop a report or contract and I\'ll give you the key takeaways in seconds.',
    ctaLabel: 'Try this',
    ctaPrompt: 'I want to summarise a document. How do I share one with you?',
  },
  {
    id: 'try-research',
    title: 'Research a topic',
    description: 'Preparing for a call or need to dig into something? I can synthesise what you need to know.',
    ctaLabel: 'Try this',
    ctaPrompt: 'I need to research a topic. Can you help me synthesise what I need to know?',
  },
];

export function useCoachContent(userState: HomepageUserState): CoachContentResult {
  return useMemo(() => {
    switch (userState.kind) {
      case 'new-loading':
        return {
          size: 'large' as CoachSize,
          title: 'Ways I can help',
          subtitle: 'I\'m getting to know your work. In a moment, I\'ll have suggestions tailored to your day.',
          suggestions: CAPABILITY_SUGGESTIONS.slice(0, 2),
        };

      case 'new-no-data':
        return {
          size: 'large' as CoachSize,
          title: 'Ways I can help',
          subtitle: 'Based on what I know so far, here are some things I can help with.',
          suggestions: CAPABILITY_SUGGESTIONS,
        };

      case 'new-no-connectors':
        return {
          size: 'large' as CoachSize,
          title: 'Connect your tools',
          subtitle: 'The more I know about your work, the more I can help. Connect a tool to get started.',
          suggestions: CONNECT_TOOLS_SUGGESTIONS,
        };

      case 'established-daily':
        return {
          size: 'small' as CoachSize,
          title: 'Coach',
          suggestions: ESTABLISHED_BACKFILL_SUGGESTIONS,
        };

      case 'returning-after-idle':
        return {
          size: 'minimal' as CoachSize,
          title: 'Coach',
          suggestions: ESTABLISHED_BACKFILL_SUGGESTIONS,
        };
    }
  }, [userState.kind]);
}
