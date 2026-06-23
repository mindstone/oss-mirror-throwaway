import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  CLAUDE_MENTION_TARGETS,
  detectClaudeModelReferences,
  buildClaudeSubagentConfig,
  type ClaudeMentionTarget,
} from '../claudeMentionAgentService';

const anthropicSettings = { activeProvider: 'anthropic' } as AppSettings;

describe('detectClaudeModelReferences', () => {
  it('matches backtick model mentions', () => {
    const result = detectClaudeModelReferences('Ask @model:`Haiku 4.5` to review this.');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
  });

  it('matches bare model ids', () => {
    const result = detectClaudeModelReferences('Please delegate this to claude-opus-4-7.');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('opus');
  });

  it('exports expected mention targets', () => {
    expect(CLAUDE_MENTION_TARGETS.map(target => target.modelAlias).sort()).toEqual(['haiku', 'opus', 'sonnet']);
  });
});

describe('buildClaudeSubagentConfig', () => {
  const haikuTarget: ClaudeMentionTarget = {
    label: 'Haiku 4.5',
    modelValue: 'claude-haiku-4-5',
    modelAlias: 'haiku',
  };

  it('builds native Claude subagent definitions without routedModel', () => {
    const result = buildClaudeSubagentConfig([haikuTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = result!.agents['claude-haiku'];
    expect(agent.model).toBe('haiku');
    expect(agent.routedModel).toBeUndefined();
  });

  it('adds model-display mapping and prompt hint', () => {
    const result = buildClaudeSubagentConfig([haikuTarget], anthropicSettings);
    expect(result).not.toBeNull();
    expect(result!.modelDisplayNames.get('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(result!.systemPromptHint).toContain('<claude_subagents>');
    expect(result!.systemPromptHint).toContain('claude-haiku');
  });

  it('returns null and warns when activeProvider is non-Anthropic', () => {
    const openRouterSettings = { activeProvider: 'openrouter' } as AppSettings;
    const result = buildClaudeSubagentConfig([haikuTarget], openRouterSettings);
    expect(result).toBeNull();
  });

  it('returns null and warns when activeProvider is codex', () => {
    const codexSettings = { activeProvider: 'codex' } as AppSettings;
    const result = buildClaudeSubagentConfig([haikuTarget], codexSettings);
    expect(result).toBeNull();
  });

  it('defaults to anthropic when activeProvider is undefined', () => {
    const undefinedProviderSettings = {} as AppSettings;
    const result = buildClaudeSubagentConfig([haikuTarget], undefinedProviderSettings);
    expect(result).not.toBeNull();
    expect(result!.agents['claude-haiku'].model).toBe('haiku');
  });
});
