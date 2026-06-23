import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_DEFINITION } from '../../agentTool';
import { SUB_AGENT_TOOL_NAMES, isSubAgentToolName } from '../toolNames';

describe('toolNames drift guard', () => {
  it('SUB_AGENT_TOOL_NAMES includes the live AGENT_TOOL_DEFINITION.name', () => {
    expect(SUB_AGENT_TOOL_NAMES).toContain(AGENT_TOOL_DEFINITION.name);
  });

  it('isSubAgentToolName returns true for the live AGENT_TOOL_DEFINITION.name', () => {
    expect(isSubAgentToolName(AGENT_TOOL_DEFINITION.name)).toBe(true);
  });

  it('continues to recognize the legacy "Task" alias used by agentTool/rebelCoreQuery', () => {
    expect(isSubAgentToolName('Task')).toBe(true);
  });

  it('rejects unknown tool names', () => {
    expect(isSubAgentToolName('Read')).toBe(false);
    expect(isSubAgentToolName('Bash')).toBe(false);
    expect(isSubAgentToolName('')).toBe(false);
  });
});
