/**
 * Friendly loading tips — shown as an overlay on top of skeleton states.
 *
 * Each entry is a hand-rewritten, warm rephrasing of a user-facing changelog
 * entry from `rebel-system/help-for-humans/changelog.md`. The mapping keeps
 * rewrites reviewable: `source` is the original changelog highlight title, and
 * `tip` is what the user sees.
 *
 * Authoring rules (see <LoadingTipOverlay /> spec):
 *   - Short, warm, plain English. Max ~70 characters.
 *   - Helpful-teammate tone. No jargon, no version numbers, no "we shipped".
 *   - Discovery-oriented — something the user can do or notice.
 *   - Internal/infra-only changelog entries are deliberately skipped.
 *
 * Add new tips by picking a user-facing changelog highlight and rewriting it
 * in this tone. Keep the list curated and short — this is a surface of
 * delight, not a firehose.
 */

export interface LoadingTip {
  /** Stable id. Format: `<version>__<short-slug>`. */
  id: string;
  /** Original changelog highlight title for traceability. */
  source: string;
  /** The friendly, user-facing tip shown during loading. */
  tip: string;
}

export const LOADING_TIPS: readonly LoadingTip[] = [
  {
    id: 'v0.4.27__share-library',
    source: 'Share Library Files',
    tip: 'Share any library file with a link, plus a password or expiry if needed.',
  },
  {
    id: 'v0.4.27__chatgpt-pro',
    source: 'ChatGPT Pro Support',
    tip: 'You can now connect ChatGPT Pro as a provider in Settings.',
  },
  {
    id: 'v0.4.32__openrouter-any',
    source: 'Any OpenRouter Model',
    tip: 'Any OpenRouter model works now — just paste the model ID.',
  },
  {
    id: 'v0.4.27__recommendations',
    source: 'Recommendation Control',
    tip: 'You choose when Rebel generates daily recommendations now.',
  },
  {
    id: 'v0.4.27__thinking-panel',
    source: 'Smarter Thinking Panel',
    tip: 'The thinking panel is compact now — expand it when you want more.',
  },
  {
    id: 'v0.4.27__focus-skipped',
    source: 'Focus Meeting Visibility',
    tip: 'Skipped meetings stay visible in Focus, with a one-click undo.',
  },
  {
    id: 'v0.4.27__question-details',
    source: 'Better Question Cards',
    tip: 'Question cards now have a "Show details" field for extra context.',
  },
  {
    id: 'v0.4.26__usage-clarity',
    source: 'Subscription Cost Clarity',
    tip: 'Usage shows subscription AI and paid tokens side by side now.',
  },
  {
    id: 'v0.4.26__focus-goals',
    source: 'Focus: Goal-Aligned Calendar',
    tip: 'Focus maps your meetings to goals, so you see where time goes.',
  },
  {
    id: 'v0.4.32__provider-switch',
    source: 'Smarter Provider Switching',
    tip: 'Connect a new provider and Rebel auto-selects it for you.',
  },
  {
    id: 'v0.4.32__future-prep',
    source: 'Future Week Prep',
    tip: 'Focus prep now works for upcoming weeks, not just this one.',
  },
];
