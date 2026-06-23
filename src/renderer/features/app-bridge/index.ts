/**
 * App Bridge (Stage 7) — renderer-facing feature barrel.
 *
 * Surfaces the two UI chips used when the Rebel browser extension
 * drives a conversation: `BrowserContextChip` tags the conversation as
 * originating from a specific tab, and `ExternalContextIndicator` shows
 * the "held for you" state when intent messages arrived during an
 * active turn and are sitting in the main-process buffer.
 */
export { BrowserContextChip } from './BrowserContextChip';
export type { BrowserContextChipProps } from './BrowserContextChip';

export { OfficeContextChip } from './OfficeContextChip';
export type { OfficeContextChipProps } from './OfficeContextChip';

export { SlackContextChip } from './SlackContextChip';
export type { SlackContextChipProps } from './SlackContextChip';

export { ExternalContextIndicator } from './ExternalContextIndicator';
export type { ExternalContextIndicatorProps } from './ExternalContextIndicator';
