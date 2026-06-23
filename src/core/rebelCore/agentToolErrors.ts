export class AgentToolTimeoutError extends Error {
  readonly maxDurationMs?: number;

  constructor(message = 'Sub-agent timed out', maxDurationMs?: number) {
    super(message);
    this.name = 'AgentToolTimeoutError';
    this.maxDurationMs = maxDurationMs;
  }
}

export const isAgentToolTimeoutError = (error: unknown): error is AgentToolTimeoutError =>
  error instanceof AgentToolTimeoutError || (error instanceof Error && error.name === 'AgentToolTimeoutError');
