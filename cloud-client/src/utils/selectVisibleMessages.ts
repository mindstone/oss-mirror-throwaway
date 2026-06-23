/**
 * Tombstone file. Previously a hand-maintained mirror of the desktop
 * visibility rules — Stage 0.A (cross-surface centralization) replaced
 * that pattern with the canonical implementation in @rebel/shared (and
 * ultimately src/core/services/conversationState/).
 *
 * cloud-client/src/index.ts re-exports selectVisibleMessages from
 * @rebel/shared directly. This file remains only to ensure any stale
 * direct import path (`cloud-client/src/utils/selectVisibleMessages`)
 * still resolves to the canonical implementation instead of accidentally
 * resurrecting a drifting copy.
 */
export { selectVisibleMessages } from '@rebel/shared';
