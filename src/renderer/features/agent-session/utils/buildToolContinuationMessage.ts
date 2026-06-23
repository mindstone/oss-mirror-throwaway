import { summarizeToolForApproval } from './toolChips';

/**
 * Build continuation message for approved tool operations.
 * Instructs the agent to retry the approved tool.
 */
export function buildToolContinuationMessage(toolName: string, input: Record<string, unknown>): string {
  const summary = summarizeToolForApproval(toolName, input);
  return `Approved. Please retry: ${summary.label}${summary.detail ? ` (${summary.detail})` : ''}`;
}
