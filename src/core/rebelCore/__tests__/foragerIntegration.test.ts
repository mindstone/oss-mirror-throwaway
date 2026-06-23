import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildAgentToolDefinition } from '../agentTool';
import { buildForagerAgentDef, FORAGER_BTS_CATEGORY, FORAGER_SYSTEM_PROMPT } from '../foragerPrompt';
import type { RebelCoreAgentDefinition } from '../types';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';

let tmpDir: string;

beforeEach(() => {
  _resetForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forager-int-test-'));
  const promptDir = path.join(tmpDir, 'agent');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, 'forager.md'), `---
description: Forager agent prompt
service: src/core/rebelCore/foragerPrompt.ts
variables: []
---
${FORAGER_SYSTEM_PROMPT}`, 'utf-8');
  configurePromptFileService(tmpDir);
});

afterEach(() => {
  _resetForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type AgentProperty = {
  enum?: string[];
  description?: string;
};

const readAgentProperty = (
  agents: Record<string, RebelCoreAgentDefinition>,
): AgentProperty => {
  const toolDef = buildAgentToolDefinition(agents);
  return toolDef.input_schema.properties.agent as AgentProperty;
};

describe('buildAgentToolDefinition', () => {
  it('includes enum values with agent names when agents are provided', () => {
    const agentProperty = readAgentProperty({
      forager: {
        description: 'Cheap extractive triage agent',
        prompt: 'forager prompt',
      },
      'knowledge-worker': {
        description: 'General deep-work agent',
        prompt: 'knowledge worker prompt',
      },
    });

    expect(agentProperty.enum).toEqual(expect.arrayContaining(['forager', 'knowledge-worker']));
    expect(agentProperty.enum).toHaveLength(2);
  });

  it('includes agent descriptions in the agent parameter description', () => {
    const agentProperty = readAgentProperty({
      forager: {
        description: 'Cheap extractive triage agent',
        prompt: 'forager prompt',
      },
      reviewer: {
        description: 'Code review specialist',
        prompt: 'reviewer prompt',
      },
    });

    expect(agentProperty.description).toContain('forager — Cheap extractive triage agent');
    expect(agentProperty.description).toContain('reviewer — Code review specialist');
  });

  it('uses generic agent description and undefined enum when agents are empty', () => {
    const agentProperty = readAgentProperty({});

    expect(agentProperty.enum).toBeUndefined();
    expect(agentProperty.description).toBe('Name of the agent to invoke.');
  });
});

describe('forager registration', () => {
  it('forager def includes btsCategory: \'foraging\' when registered', () => {
    const foragerDef = buildForagerAgentDef();
    foragerDef.btsCategory = FORAGER_BTS_CATEGORY;
    expect(foragerDef.btsCategory).toBe('foraging');
  });
});
