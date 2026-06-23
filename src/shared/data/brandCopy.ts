/**
 * Centralized UI copy constants for Rebel's brand voice.
 *
 * Toast titles follow the convention: short, sentence case, no period.
 * See docs/project/UI_INTERNAL_NOTIFICATIONS.md for toast guidelines.
 * See docs/project/BRAND_VOICE.md for voice principles.
 */

// Export feedback (no period per toast convention)
export const EXPORT_SUCCESS = 'Exported successfully';
export const EXPORT_FAILED = "Export didn't work — give it another go";

// Conversation empty state prompts (rotating)
// Uses useState lazy initializer for stable-per-mount selection.
// Voice: capable colleague, dry, calm. Terse > chirpy. Verb-neutral
// so they don't pre-frame what the user wants to do.
export const TEXT_EMPTY_PROMPTS = [
  'What are we working on?',
  'Ready when you are',
  "Right. What's on?",
  'What needs doing?',
  "What's the situation?",
  "Tell me what you're working on.",
  'Where shall we start?',
  "What's the latest?",
] as const;

export const VOICE_EMPTY_PROMPTS = [
  "I'm listening",
  'Go ahead',
  'Whenever you\u2019re ready',
  'Just say what you need',
] as const;

export const getRandomItem = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)];
