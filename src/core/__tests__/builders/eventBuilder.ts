/**
 * Test data builders for AgentEvent variants.
 *
 * Provides builder functions for the most commonly used AgentEvent types.
 * Each builder returns a valid AgentEvent of the specified type.
 *
 * Usage:
 *   const event = buildAgentEvent();                          // default: status event
 *   const status = buildStatusEvent({ message: 'Loading' });
 *   const result = buildResultEvent({ model: 'claude-opus-4-7' });
 *   const tool = buildToolEvent({ toolName: 'read_file', stage: 'start' });
 *   const error = buildErrorEvent({ error: 'Rate limited' });
 */
import type { AgentEvent } from '@shared/types';

type StatusEvent = Extract<AgentEvent, { type: 'status' }>;
type AssistantEvent = Extract<AgentEvent, { type: 'assistant' }>;
type ResultEvent = Extract<AgentEvent, { type: 'result' }>;
type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;
type ErrorEvent = Extract<AgentEvent, { type: 'error' }>;

/**
 * Build a status AgentEvent with optional overrides.
 */
export function buildStatusEvent(overrides?: Partial<StatusEvent>): StatusEvent {
  return {
    type: 'status',
    message: 'Processing',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build an assistant AgentEvent with optional overrides.
 */
export function buildAssistantEvent(overrides?: Partial<AssistantEvent>): AssistantEvent {
  return {
    type: 'assistant',
    text: 'Test assistant response',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build a result AgentEvent with optional overrides.
 */
export function buildResultEvent(overrides?: Partial<ResultEvent>): ResultEvent {
  return {
    type: 'result',
    text: 'Test result',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build a tool AgentEvent with optional overrides.
 */
export function buildToolEvent(overrides?: Partial<ToolEvent>): ToolEvent {
  return {
    type: 'tool',
    toolName: 'test_tool',
    detail: 'Test tool detail',
    stage: 'start',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build an error AgentEvent with optional overrides.
 */
export function buildErrorEvent(overrides?: Partial<ErrorEvent>): ErrorEvent {
  return {
    type: 'error',
    error: 'Test error',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Build any AgentEvent. Defaults to a status event.
 * For type-specific builders with better autocomplete, use the named builders above.
 */
export function buildAgentEvent(overrides?: Partial<AgentEvent>): AgentEvent {
  const type = overrides?.type ?? 'status';
  switch (type) {
    case 'status':
      return buildStatusEvent(overrides as Partial<StatusEvent>);
    case 'assistant':
      return buildAssistantEvent(overrides as Partial<AssistantEvent>);
    case 'result':
      return buildResultEvent(overrides as Partial<ResultEvent>);
    case 'tool':
      return buildToolEvent(overrides as Partial<ToolEvent>);
    case 'error':
      return buildErrorEvent(overrides as Partial<ErrorEvent>);
    default:
      return buildStatusEvent(overrides as Partial<StatusEvent>);
  }
}
