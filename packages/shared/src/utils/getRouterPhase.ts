/**
 * Visual phase derived from the agent thinking headline.
 * Used by both desktop (TurnStepsInline) and mobile (AgentActivityBubble)
 * to show phase-appropriate icons during live activity.
 */
export type RouterPhase = 'evaluating' | 'direct' | 'research' | 'found' | 'default';

export function getRouterPhase(headline: string | undefined): RouterPhase {
  if (!headline) return 'default';
  const lower = headline.toLowerCase();
  if (lower.includes('evaluating')) return 'evaluating';
  if (lower.includes('got it') || lower.includes('answering from')) return 'direct';
  if (lower.includes('deeper research') || lower.includes('needs research')) return 'research';
  if (lower.includes('found') && lower.includes('file')) return 'found';
  return 'default';
}
