/**
 * Unified discovery slot selection.
 *
 * Pure function that picks ONE discovery item per surface (empty-state whisper
 * or during-turn nudge) between a tutorial candidate and a changelog candidate.
 * Selection is deterministic per `sessionId` and alternates across surfaces so
 * neither content type dominates a single conversation.
 *
 * See `docs/plans/260418_unified_discovery_slot.md` for the full design —
 * complements `contextualVideoSelection.ts` (tutorial-only selection) by
 * treating tutorials and changelog highlights as interchangeable discovery
 * items at the slot level.
 */

import type { TutorialVideo } from '@shared/config/tutorialVideos';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';

/** Which discovery slot is asking for an item. */
export type DiscoverySurface = 'empty-state' | 'nudge';

/**
 * Discriminated union returned by `selectDiscoveryItem`. Consumers branch on
 * `.type` to render the appropriate visual treatment.
 */
export type DiscoveryItem =
  | { type: 'tutorial'; video: TutorialVideo }
  | { type: 'changelog'; highlight: ChangelogHighlight };

/**
 * Inputs required to pick a discovery item for a given surface + session.
 *
 * Caller resolves both candidates up-front (from tutorial + changelog data
 * layers) so this function stays pure and synchronous.
 */
export interface DiscoverySelectionInput {
  /** Current session id; used as the deterministic alternation seed. */
  sessionId: string;
  /** Surface requesting an item — drives per-surface inversion. */
  surface: DiscoverySurface;
  /** Best tutorial candidate, or `null` if none is available. */
  tutorialCandidate: TutorialVideo | null;
  /** Best changelog candidate, or `null` if none is available. */
  changelogCandidate: ChangelogHighlight | null;
}

/**
 * djb2-style string hash. Deterministic, fast, non-cryptographic.
 * Exported for testing.
 *
 * Returns an unsigned 32-bit integer represented as a regular JS number so
 * callers can safely apply arithmetic (e.g. `hash % 2`) without worrying about
 * sign-bit surprises.
 */
export function hashSessionId(sessionId: string): number {
  // djb2: hash = hash * 33 + c, starting at 5381
  let hash = 5381;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) + hash) + sessionId.charCodeAt(i);
  }
  // Force to unsigned 32-bit to keep the value stable and non-negative.
  return hash >>> 0;
}

/**
 * Pick a discovery item for the given surface + session.
 *
 * Logic:
 * 1. Hash `sessionId` → parity bit (even/odd).
 * 2. Apply per-surface offset: 0 for `empty-state`, 1 for `nudge`. This
 *    guarantees that for a given session, the two surfaces prefer opposite
 *    content types — so a single conversation can surface both a tutorial and
 *    a changelog highlight across its lifetime.
 * 3. If the preferred type has a non-null candidate, return it.
 * 4. Otherwise, fall back to the other type's candidate.
 * 5. If neither candidate is available, return `null`.
 *
 * Returns `null` iff both candidates are `null` — intentional "nothing to
 * show" state. Callers should render no discovery slot in that case.
 */
export function selectDiscoveryItem(
  input: DiscoverySelectionInput,
): DiscoveryItem | null {
  const { sessionId, surface, tutorialCandidate, changelogCandidate } = input;

  const hash = hashSessionId(sessionId);
  const surfaceOffset = surface === 'empty-state' ? 0 : 1;
  const prefersTutorial = (hash + surfaceOffset) % 2 === 0;

  if (prefersTutorial) {
    if (tutorialCandidate) return { type: 'tutorial', video: tutorialCandidate };
    if (changelogCandidate) return { type: 'changelog', highlight: changelogCandidate };
    return null;
  }

  // Prefers changelog
  if (changelogCandidate) return { type: 'changelog', highlight: changelogCandidate };
  if (tutorialCandidate) return { type: 'tutorial', video: tutorialCandidate };
  return null;
}
