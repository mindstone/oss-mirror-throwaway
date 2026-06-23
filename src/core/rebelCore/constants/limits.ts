/**
 * Maximum concurrent sub-agent tool dispatches allowed per turn.
 *
 * Shared by runtime enforcement (agentLoop) and execution prompt guidance
 * (planningMode) to keep behavior and instructions in sync.
 *
 * Default is 4. Override via the `REBEL_PARALLEL_AGENT_CAP` environment
 * variable to act as a runtime kill-switch / tuning lever (e.g. set to `1`
 * to serialize all sub-agent dispatches without redeploying). Invalid
 * values are ignored and the default is used; the value is clamped to
 * integer `>= 1`.
 */
const DEFAULT_PARALLEL_AGENT_CAP = 4;

const resolveParallelAgentCap = (): number => {
  const raw = typeof process !== 'undefined' ? process.env?.REBEL_PARALLEL_AGENT_CAP : undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DEFAULT_PARALLEL_AGENT_CAP;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      '[parallel-agent-cap] Ignoring invalid REBEL_PARALLEL_AGENT_CAP value, falling back to default',
      { raw, default: DEFAULT_PARALLEL_AGENT_CAP },
    );
    return DEFAULT_PARALLEL_AGENT_CAP;
  }
  return parsed;
};

export const PARALLEL_AGENT_CAP = resolveParallelAgentCap();
