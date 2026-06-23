/**
 * Re-export canonical sort from packages/shared.
 * The sort logic lives in @rebel/shared so desktop, mobile, and web-companion
 * all use the same algorithm.
 */
export { sortInboxItems } from '@rebel/shared';
