/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader)
 *  - Adapter-shaped extension point (§2 success criteria)
 *  - D1: ExternalContext / ExternalConversationAdapter / ConversationScopeResolver naming (Chief Designer confirmed)
 *  - D2: Only browser-tab, office-document, slack-thread, slack-mention-poll land in Stage 1 (DA-trim)
 *  - D8: Slack transport splits into cloud-webhook (slack-thread) vs desktop-polling (slack-mention-poll)
 *  - D9: deriveScopeKey is loose; tabContextsMateriallyMatch is strict — DO NOT collapse them
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (R10/D15 — DOM-tool fingerprint)
 * @see docs/plans/finished/260213_inbound-trigger-framework.md (slack-mention-poll shape preserved)
 */

import type { TabContext } from '@core/appBridge/shared/protocol';

export * from '@rebel/shared/types/externalContext';

function normalizeTabLocation(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Strict fingerprint match — for DOM-tool dispatch and other safety-critical checks.
 * This is the existing behavior from browserConversationScopeRegistry.
 */
export function tabContextsMateriallyMatch(
  expected: TabContext,
  actual: TabContext,
): boolean {
  if (
    typeof expected.tabId === 'number' &&
    typeof actual.tabId === 'number' &&
    expected.tabId !== actual.tabId
  ) {
    return false;
  }

  const expectedLocation = normalizeTabLocation(expected.url);
  const actualLocation = normalizeTabLocation(actual.url);
  if (expectedLocation && actualLocation && expectedLocation !== actualLocation) {
    return false;
  }

  return true;
}
