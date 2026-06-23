/**
 * Mock agent turn executor for E2E tests.
 *
 * Fires synthetic assistant + result events without calling the Anthropic API.
 * Activated when REBEL_MOCK_AGENT_TURNS=1 (wired in bootstrap.ts).
 */

import { dispatchAgentEvent } from '@core/services/agentEventDispatcher';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { EventWindow } from '@core/types';

async function waitForListener(turnId: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (agentTurnRegistry.getEventListener(turnId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `[mockExecuteAgentTurn] Listener for turn ${turnId} not registered within ${timeoutMs}ms`,
  );
}

export async function mockExecuteAgentTurn(
  win: EventWindow | null,
  turnId: string,
  prompt: string,
  _options: { sessionId: string; [key: string]: unknown },
): Promise<void> {
  await waitForListener(turnId);

  // Fire assistant message event
  dispatchAgentEvent(win, turnId, {
    type: 'assistant',
    text: `[mock] Response to: ${prompt.slice(0, 100)}`,
    timestamp: Date.now(),
  });

  // Small delay between events (realistic sequencing)
  await new Promise(resolve => setTimeout(resolve, 10));

  // Fire result event (triggers session persistence + WS close in agent.ts)
  dispatchAgentEvent(win, turnId, {
    type: 'result',
    text: `[mock] Response to: ${prompt.slice(0, 100)}`,
    timestamp: Date.now(),
  });

  // Clean up registry state (mirrors completeTurnCleanup)
  agentTurnRegistry.cleanupTurn(turnId);
}
