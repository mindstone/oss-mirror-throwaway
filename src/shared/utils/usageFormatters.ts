import type { AgentEvent } from '@shared/types';

export const formatUsage = (event: AgentEvent): string => {
  if (event.type !== 'result' || !event.usage) return '';
  const parts: string[] = [];
  if (event.usage.inputTokens) parts.push(`in: ${event.usage.inputTokens}`);
  if (event.usage.outputTokens) parts.push(`out: ${event.usage.outputTokens}`);
  if (event.usage.cacheCreationTokens) parts.push(`cache+: ${event.usage.cacheCreationTokens}`);
  if (event.usage.cacheReadTokens) parts.push(`cache✓: ${event.usage.cacheReadTokens}`);
  if (event.usage.costUsd) parts.push(`$${event.usage.costUsd.toFixed(4)}`);
  if (event.usage.contextWindow) {
    const windowLabel = event.usage.contextWindow >= 1_000_000
      ? `${(event.usage.contextWindow / 1_000_000).toFixed(event.usage.contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
      : `${Math.round(event.usage.contextWindow / 1000)}K`;
    const utilization = event.usage.contextUtilization ?? null;
    if (utilization !== null) {
      parts.push(`ctx: ${utilization}% of ${windowLabel}`);
    } else {
      parts.push(`ctx: ${windowLabel}`);
    }
  }
  return parts.length ? parts.join(' · ') : '';
};

/**
 * Format cost in a compact, human-friendly way.
 * Examples: "—" (no cost), "<1¢", "4¢", "$1.23"
 */
export function formatCostCompact(costUsd: number | null | undefined): string {
  if (costUsd == null || costUsd === 0) return '—';
  if (costUsd < 0.01) return '<1¢';
  if (costUsd < 1) return `${Math.round(costUsd * 100)}¢`;
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Format token count in a compact way.
 * Examples: "500", "1.2k", "1.5M"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toString();
}

/**
 * Format cost with "c." (circa) prefix to indicate approximation.
 * Used for auxiliary service costs where we estimate from token counts.
 * Examples: "—" (no cost), "c. <1¢", "c. 4¢", "c. $1.23"
 */
export function formatCostApprox(costUsd: number | null | undefined): string {
  if (costUsd == null || costUsd === 0) return '—';
  if (costUsd < 0.01) return 'c. <1¢';
  if (costUsd < 1) return `c. ${Math.round(costUsd * 100)}¢`;
  return `c. $${costUsd.toFixed(2)}`;
}
