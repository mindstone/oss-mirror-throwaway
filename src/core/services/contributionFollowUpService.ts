/**
 * Contribution Follow-Up Session Service
 *
 * Spawns a linked follow-up conversation when a PR gets "changes requested"
 * or CI fails. The follow-up session:
 * - References the original build session (linked via contribution store)
 * - Includes a summary of what was built (connector name)
 * - Includes the review notes from the PR
 * - Links to the GitHub PR for context
 *
 * Platform-agnostic — no Electron or React imports. Returns the prompt
 * and context needed by the renderer to seed a new conversation.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (D4)
 */

import { createScopedLogger } from '@core/logger';
import {
  getContributionById,
  addLinkedSession,
} from './contributionStore';
import type { ConnectorContribution } from './contributionTypes';

const log = createScopedLogger({ service: 'contribution-follow-up' });

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Context needed to spawn a follow-up session.
 * The renderer uses this to seed a new conversation.
 */
export interface FollowUpSessionContext {
  /** The seeded prompt for the follow-up conversation. */
  prompt: string;
  /** The skill mention path to include in the conversation. */
  skillMention: string;
  /** The contribution ID for linking. */
  contributionId: string;
  /** The original build session ID. */
  originalSessionId: string;
  /** The connector name. */
  connectorName: string;
}

// ─── Prompt Building ────────────────────────────────────────────────

/**
 * Build the seeded prompt for a changes-requested follow-up session.
 * Includes:
 * - Connector name
 * - Review notes (if any)
 * - PR URL for reference
 * - Link to original session
 */
function buildChangesRequestedPrompt(contribution: ConnectorContribution): string {
  const parts: string[] = [
    `The community connector "${contribution.connectorName}" received changes requested on its pull request.`,
  ];

  if (contribution.reviewNotes) {
    parts.push('');
    parts.push('**Review notes from maintainer:**');
    parts.push(contribution.reviewNotes);
  }

  if (contribution.prUrl) {
    parts.push('');
    parts.push(`**PR:** ${contribution.prUrl}`);
  }

  parts.push('');
  parts.push('Please address the requested changes and update the connector accordingly.');

  return parts.join('\n');
}

/**
 * Build the seeded prompt for a CI-failure follow-up session.
 */
function buildCIFailurePrompt(contribution: ConnectorContribution): string {
  const parts: string[] = [
    `The community connector "${contribution.connectorName}" has CI failures on its pull request.`,
  ];

  if (contribution.prUrl) {
    parts.push('');
    parts.push(`**PR:** ${contribution.prUrl}`);
  }

  parts.push('');
  parts.push('Please investigate and fix the CI failures for this connector.');

  return parts.join('\n');
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Create follow-up session context for a contribution.
 *
 * Returns the prompt, skill mention, and context needed by the renderer
 * to spawn a linked follow-up conversation. Does NOT create the session
 * itself — that's handled by the renderer using startFreshSession().
 *
 * @param contributionId - The contribution to create a follow-up for.
 * @returns FollowUpSessionContext or null if the contribution doesn't exist
 *          or isn't in a state that warrants a follow-up.
 */
export function createFollowUpSessionContext(
  contributionId: string,
): FollowUpSessionContext | null {
  const contribution = getContributionById(contributionId);

  if (!contribution) {
    log.warn({ contributionId }, 'Cannot create follow-up: contribution not found');
    return null;
  }

  // Only changes_requested and ci_fail warrant follow-up sessions
  if (contribution.status !== 'changes_requested' && contribution.status !== 'ci_fail') {
    log.warn(
      { contributionId, status: contribution.status },
      'Cannot create follow-up: contribution is not in changes_requested or ci_fail state',
    );
    return null;
  }

  const prompt = contribution.status === 'changes_requested'
    ? buildChangesRequestedPrompt(contribution)
    : buildCIFailurePrompt(contribution);

  // The extend-mcp-server skill is used for follow-up fix cycles
  const skillMention = 'extend-mcp-server/SKILL.md';

  log.info(
    { contributionId, status: contribution.status, connectorName: contribution.connectorName },
    'Created follow-up session context',
  );

  return {
    prompt,
    skillMention,
    contributionId: contribution.id,
    originalSessionId: contribution.sessionId,
    connectorName: contribution.connectorName,
  };
}

/**
 * Link a follow-up session to a contribution.
 *
 * Called by the renderer after creating the follow-up session to record
 * the link in the contribution store.
 *
 * Stage 2.D (260426): now delegates to `addLinkedSession` (which keeps the
 * deprecated `followUpSessionIds` view in sync). The exported function name
 * is preserved because it backs the `contribution:link-follow-up-session`
 * IPC handler.
 *
 * @param contributionId - The contribution ID.
 * @param followUpSessionId - The newly created follow-up session ID.
 * @returns The updated contribution or undefined if not found.
 */
export function linkFollowUpSession(
  contributionId: string,
  followUpSessionId: string,
): ConnectorContribution | undefined {
  return addLinkedSession(contributionId, followUpSessionId);
}
