#!/usr/bin/env npx tsx
/**
 * CLI harness to replay session traces through the Zustand store without React.
 * Demonstrates that the store logic works independently of the React layer.
 *
 * Usage:
 *   npm run replay:session-trace <trace.json>
 *   npx tsx scripts/replay-session-trace.ts <trace.json>
 *
 * Trace format:
 * {
 *   "sessionId": "abc123",
 *   "events": [
 *     { "turnId": "turn-1", "event": { "type": "status", "message": "...", "timestamp": 123 } },
 *     { "turnId": "turn-1", "event": { "type": "assistant", "text": "...", "timestamp": 124 } },
 *     ...
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';
import type { AgentEvent } from '../src/shared/types';

// Mock import.meta.env for Zustand devtools
(globalThis as Record<string, unknown>).import = {
  meta: {
    env: {
      DEV: false
    }
  }
};

// Dynamically import after setting up mocks
async function main() {
  const traceFile = process.argv[2];

  if (!traceFile) {
    console.error('Usage: npm run replay:session-trace <trace.json>');
    console.error('');
    console.error('Trace format:');
    console.error('  {');
    console.error('    "sessionId": "abc123",');
    console.error('    "events": [');
    console.error('      { "turnId": "turn-1", "event": { "type": "assistant", "text": "...", "timestamp": 123 } }');
    console.error('    ]');
    console.error('  }');
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), traceFile);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: File not found: ${resolvedPath}`);
    process.exit(1);
  }

  let trace: {
    sessionId?: string;
    events: Array<{
      turnId: string;
      event: {
        type: string;
        [key: string]: unknown;
      };
    }>;
  };

  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    trace = JSON.parse(content);
  } catch (err) {
    console.error(`Error: Failed to parse trace file: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!Array.isArray(trace.events)) {
    console.error('Error: Trace file must have an "events" array');
    process.exit(1);
  }

  console.log(`\nReplaying ${trace.events.length} events from: ${traceFile}`);
  console.log('---');

  // Import store modules (these don't depend on React)
  const { createSessionStore } = await import(
    '../src/renderer/features/agent-session/store/sessionStore'
  );

  // Create a fresh store instance for the replay
  const store = createSessionStore();

  // If a sessionId is provided, set it
  if (trace.sessionId) {
    store.getState().setCurrentSessionMeta({
      currentSessionId: trace.sessionId
    });
  }

  // Process each event
  for (let i = 0; i < trace.events.length; i++) {
    const { turnId, event } = trace.events[i];
    console.log(`[${i + 1}/${trace.events.length}] Processing ${event.type} event for turn ${turnId}`);

    // For the first event in a turn, we might need to add a user message
    if (event.type === 'status' || event.type === 'assistant') {
      const state = store.getState();
      if (!state.eventsByTurn[turnId]) {
        // This is a new turn, simulate having started it
        store.setState({
          activeTurnId: turnId,
          isBusy: true,
          eventsByTurn: { ...state.eventsByTurn, [turnId]: [] }
        });
      }
    }

    // Process the event through the store
    store.getState().processEvent(turnId, event as AgentEvent);
  }

  // Output final state
  const finalState = store.getState();

  const output = {
    summary: {
      messagesCount: finalState.messages.length,
      turnsCount: Object.keys(finalState.eventsByTurn).length,
      activeTurnId: finalState.activeTurnId,
      isBusy: finalState.isBusy,
      hasError: finalState.lastError !== null
    },
    messages: finalState.messages.map((m) => ({
      id: m.id,
      role: m.role,
      textPreview: m.text.slice(0, 100) + (m.text.length > 100 ? '...' : ''),
      turnId: m.turnId
    })),
    eventsByTurn: Object.fromEntries(
      Object.entries(finalState.eventsByTurn).map(([turnId, events]) => [
        turnId,
        {
          count: events.length,
          types: events.map((e) => e.type)
        }
      ])
    ),
    state: {
      activeTurnId: finalState.activeTurnId,
      isBusy: finalState.isBusy,
      lastError: finalState.lastError,
      currentSessionId: finalState.currentSessionId,
      currentSessionTitle: finalState.currentSessionTitle
    }
  };

  console.log('---');
  console.log('\nFinal State:');
  console.log(JSON.stringify(output, null, 2));

  console.log('\n✓ Replay complete');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
