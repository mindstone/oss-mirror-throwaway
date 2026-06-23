/**
 * Shared preservation schema for context compaction.
 *
 * Defines the 6 categories of information that must survive any form of
 * context compression — whether Anthropic's server-side compact_20260112,
 * client-side BTS summarization, or incremental state updates.
 *
 * Single source of truth consumed by:
 * - anthropicClient.ts (compact_20260112 instructions)
 * - contextStateUpdate.ts (BTS summarization prompt + incremental updates)
 *
 * Categories validated against external research:
 * - Factory "Evaluating Context Compression" (Dec 2025)
 * - Anthropic "Effective Context Engineering" (Sep 2025)
 * - JetBrains "Cutting Through the Noise" (Dec 2025)
 * - OpenAI session-memory patterns (2026)
 *
 * See docs/plans/260405_cache_aware_context_management.md for full research citations.
 */

import type { RebelCoreContextState } from './taskState';

export const PRESERVATION_CATEGORIES = [
  { key: 'taskContext', label: 'Task Context', instruction: "The user's current goal, what success looks like, and any constraints or preferences they stated." },
  { key: 'keyDecisions', label: 'Key Decisions', instruction: 'Technology choices, design decisions, selected approaches, and WHY alternatives were rejected.' },
  { key: 'artifacts', label: 'Artifacts', instruction: 'All file paths, URLs, tool names, ticket/PR references, configuration values, and specific identifiers mentioned. List these explicitly.' },
  { key: 'constraints', label: 'Constraints', instruction: 'Budget limits, deadlines, performance requirements, compliance needs, platform restrictions, and any explicit "must not" rules.' },
  { key: 'progressState', label: 'Progress State', instruction: 'What has been accomplished, what remains, and any blockers or open questions.' },
  { key: 'recentContextSummary', label: 'Recent Context', instruction: 'Preserve the most recent exchanges in detail — they contain the active working context.' },
] as const;

export type PreservationCategoryKey = typeof PRESERVATION_CATEGORIES[number]['key'];

/**
 * Format preservation categories as numbered instructions for compaction prompts.
 * Used by both Anthropic compact_20260112 and client-side BTS summarization.
 */
export function formatPreservationInstructions(): string {
  const header = 'When summarizing this conversation, you MUST preserve:';
  const categories = PRESERVATION_CATEGORIES.map((cat, i) =>
    `${i + 1}. ${cat.label.toUpperCase()}: ${cat.instruction}`
  ).join('\n\n');
  const footer = 'Format the summary with clear sections. Prefer preserving specific details over general descriptions.';
  return `${header}\n\n${categories}\n\n${footer}`;
}

/**
 * Format a RebelCoreContextState into a human-readable summary for injection
 * into message history after compaction. Used by client-side BTS compaction.
 */
export function formatContextStateSummary(state: RebelCoreContextState): string {
  const sections: string[] = [];

  if (state.taskContext) {
    const tc = state.taskContext;
    const parts: string[] = [];
    if (tc.goals) parts.push(tc.goals);
    if (tc.constraints) parts.push(`Constraints: ${tc.constraints}`);
    if (tc.requirements) parts.push(`Requirements: ${tc.requirements}`);
    if (parts.length > 0) sections.push(`## Task Context\n${parts.join('\n')}`);
  }

  if (state.keyDecisions && state.keyDecisions.length > 0) {
    const decisions = state.keyDecisions
      .filter(d => d.choice)
      .map(d => {
        let line = `- ${d.choice}`;
        if (d.rationale) line += `: ${d.rationale}`;
        if (d.rejectedAlternatives && d.rejectedAlternatives.length > 0) {
          line += ` (rejected: ${d.rejectedAlternatives.join(', ')})`;
        }
        return line;
      });
    if (decisions.length > 0) sections.push(`## Key Decisions\n${decisions.join('\n')}`);
  }

  if (state.artifacts && state.artifacts.length > 0) {
    const artifacts = state.artifacts
      .filter(a => a.pathOrUrl || a.identifier)
      .map(a => `- ${a.pathOrUrl}${a.identifier ? ` (${a.identifier})` : ''}`);
    if (artifacts.length > 0) sections.push(`## Artifacts\n${artifacts.join('\n')}`);
  }

  if (state.constraints && state.constraints.length > 0) {
    const constraints = state.constraints.filter(Boolean).map(c => `- ${c}`);
    if (constraints.length > 0) sections.push(`## Constraints\n${constraints.join('\n')}`);
  }

  if (state.progressState) {
    const ps = state.progressState;
    const parts: string[] = [];
    if (ps.accomplished && ps.accomplished.length > 0) parts.push(`Done: ${ps.accomplished.join('; ')}`);
    if (ps.remaining && ps.remaining.length > 0) parts.push(`Remaining: ${ps.remaining.join('; ')}`);
    if (ps.blockers && ps.blockers.length > 0) parts.push(`Blockers: ${ps.blockers.join('; ')}`);
    if (ps.failedApproaches && ps.failedApproaches.length > 0) parts.push(`Failed: ${ps.failedApproaches.join('; ')}`);
    if (parts.length > 0) sections.push(`## Progress\n${parts.join('\n')}`);
  }

  if (state.recentContextSummary) {
    sections.push(`## Recent Context\n${state.recentContextSummary}`);
  }

  return sections.join('\n\n');
}
