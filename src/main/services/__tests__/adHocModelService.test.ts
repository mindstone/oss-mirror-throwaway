/**
 * Ad-Hoc Model Dispatch Unit Tests
 *
 * Tests the model reference detection and ad-hoc agent config builder:
 * - detectModelReferences: @-mention and natural language model matching
 * - buildAdHocAgentConfig: agent definition + route table generation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectModelReferences,
  buildAdHocAgentConfig,
} from '../adHocAgentService';
import {
  detectClaudeModelReferences,
  buildClaudeSubagentConfig,
  CLAUDE_MENTION_TARGETS,
} from '../claudeMentionAgentService';
import type { ClaudeMentionTarget } from '../claudeMentionAgentService';
import type { AppSettings, ModelProfile } from '@shared/types';

/** Helper to create a minimal ModelProfile */
function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://localhost:1234',
    createdAt: Date.now(),
    councilEnabled: false,
    model: 'test-model',
    ...overrides,
  };
}

const anthropicSettings = { activeProvider: 'anthropic' } as AppSettings;

describe('detectModelReferences', () => {
  it('matches @model:`profileName` mention', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Please @model:`GPT-5.2` review this code', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('matches @model:`profileName` case-insensitively', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Ask @model:`gpt-5.2` to check', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('matches legacy @model:profileName mention for backward compatibility', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Please @model:GPT-5.2 review this code', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('matches bare model name in natural language', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'My OpenAI Model', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Can you ask gpt-5.2-codex to review this?', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('matches profile display name case-insensitively', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Ask gpt-5.2 to review this document', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('does NOT match partial words for model names', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT Model', model: 'gpt-5.2-codex' }),
    ];
    // "gpt" alone should not match "gpt-5.2-codex" (word boundary prevents it)
    const result = detectModelReferences('I like gpt models in general', profiles);
    expect(result).toHaveLength(0);
  });

  it('does NOT match short profile names as bare words', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'AI', model: 'some-model' }),
    ];
    // "AI" is too short (< 4 chars) to match as a bare word
    const result = detectModelReferences('Use AI to help with this task', profiles);
    expect(result).toHaveLength(0);
  });

  it('matches short profile names via backtick-quoted @model mention', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'AI', model: 'some-model' }),
    ];
    const result = detectModelReferences('Ask @model:`AI` about this', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('deduplicates by model name', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'First GPT', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'b', name: 'Second GPT', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('Ask gpt-5.2-codex to review', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a'); // First wins
  });

  it('skips profiles without model field', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'No Model', model: undefined }),
      makeProfile({ id: 'b', name: 'Empty Model', model: '' }),
    ];
    const result = detectModelReferences('Ask @model:`No Model` to help', profiles);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when no matches', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = detectModelReferences('Just a normal question about cooking', profiles);
    expect(result).toHaveLength(0);
  });

  it('matches multiple different models', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'b', name: 'DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'c', name: 'Gemini', model: 'gemini-3-pro' }),
    ];
    const result = detectModelReferences('Ask GPT-5.2 and DeepSeek to both review this', profiles);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.id).sort()).toEqual(['a', 'b']);
  });

  it('returns empty array for empty profiles', () => {
    const result = detectModelReferences('Ask GPT-5.2 to review', []);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty prompt', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = detectModelReferences('', profiles);
    expect(result).toHaveLength(0);
  });

  it('sanitizes special characters in profile names before matching', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'Model (v2)', model: 'model-v2' }),
    ];
    // After sanitization "Model (v2)" becomes "Model v2"
    const result = detectModelReferences('Ask Model v2 to help', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });
});

describe('buildAdHocAgentConfig', () => {
  it('returns null for empty matches', () => {
    const result = buildAdHocAgentConfig([], 'base prompt');
    expect(result).toBeNull();
  });

  it('builds correct agents with model- prefix', () => {
    const profiles = [
      makeProfile({ id: 'abc123', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = buildAdHocAgentConfig(profiles, 'base prompt');
    expect(result).not.toBeNull();
    const agentNames = Object.keys(result!.agents);
    expect(agentNames).toHaveLength(1);
    // Dots are stripped during slug generation (same as council)
    expect(agentNames[0]).toBe('model-gpt-5-2');
  });

  it('builds correct route table', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'b', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    expect(result!.routeTable.routes.size).toBe(2);
    expect(result!.routeTable.routes.has('gpt-5.2-codex')).toBe(true);
    expect(result!.routeTable.routes.has('deepseek-r1')).toBe(true);
  });

  it('system prompt hint lists all matched models', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'b', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    // Dots are stripped during slug generation
    expect(result!.systemPromptHint).toContain('model-gpt-5-2');
    expect(result!.systemPromptHint).toContain('model-deepseek');
    expect(result!.systemPromptHint).toContain('ad_hoc_models');
  });

  it('uses "working" as the model alias for proxy-routed agents', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.model).toBe('working');
  });

  it('sets routedModel metadata on ad-hoc agent definitions', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.routedModel).toBe('gpt-5.2-codex');
  });

  it('sanitizes profile names in descriptions', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT<script>alert(1)</script>', model: 'gpt-5' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    // Special chars should be stripped
    expect(agent.description).not.toContain('<script>');
    expect(agent.description).toContain('GPTscriptalert1script');
  });

  it('skips duplicate model names (first wins)', () => {
    const profiles = [
      makeProfile({ id: 'first', name: 'First GPT', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'second', name: 'Second GPT', model: 'gpt-5.2-codex' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.agents)).toHaveLength(1);
    expect(result!.routeTable.routes.get('gpt-5.2-codex')?.id).toBe('first');
  });

  it('generates unique agent names for slug collisions', () => {
    const profiles = [
      makeProfile({ id: 'aaaa1111', name: 'GPT-5', model: 'gpt-5-turbo' }),
      makeProfile({ id: 'bbbb2222', name: 'GPT 5', model: 'gpt-5-standard' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agentNames = Object.keys(result!.agents);
    expect(agentNames).toHaveLength(2);
    expect(agentNames[0]).toBe('model-gpt-5');
    expect(agentNames[1]).toBe('model-gpt-5-bbbb2222');
  });

  it('builds modelDisplayNames map correctly', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    expect(result!.modelDisplayNames.get('gpt-5.2-codex')).toBe('GPT-5.2');
  });

  it('includes base system prompt context in agent prompts when provided', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const basePrompt = '# Rebel\n\n## [CONTEXT]\nSpaces and env here.';
    const result = buildAdHocAgentConfig(profiles, basePrompt);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.prompt).toContain('Spaces and env here.');
    expect(agent.prompt).toContain('independent consultant');
    expect(agent.routedModel).toBe('deepseek-r1');
  });

  it('agent description uses soft consultation tone', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.description).toContain('Consult');
    expect(agent.description).toContain('independent perspective');
    // Should NOT use council-style "Council member" language
    expect(agent.description).not.toContain('Council member');
  });

  it('propagates full MCP server configs to all ad-hoc agent definitions', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
      makeProfile({ id: 'b', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const mcpSpecs = [{ 'hubspot': { type: 'http' as const, url: 'http://localhost:3200/mcp' }, 'google-calendar': { type: 'http' as const, url: 'http://localhost:3201/mcp' } }];
    const result = buildAdHocAgentConfig(profiles, '', mcpSpecs);
    expect(result).not.toBeNull();
    for (const agent of Object.values(result!.agents)) {
      expect(agent.mcpServers).toEqual(mcpSpecs);
    }
  });

  it('omits mcpServers when mcpServerSpecs is undefined', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.mcpServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Claude Model @-Mention Detection
// ---------------------------------------------------------------------------

describe('detectClaudeModelReferences', () => {
  it('matches @model:`Haiku 4.5` → haiku target', () => {
    const result = detectClaudeModelReferences('Please @model:`Haiku 4.5` review this code');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
    expect(result[0].modelValue).toBe('claude-haiku-4-5');
    expect(result[0].label).toBe('Haiku 4.5');
  });

  it('matches @model:`Sonnet 4.6` → sonnet target', () => {
    const result = detectClaudeModelReferences('Ask @model:`Sonnet 4.6` for a second opinion');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('sonnet');
    expect(result[0].modelValue).toBe('claude-sonnet-4-6');
  });

  it('matches @model:`Opus` → opus target', () => {
    const result = detectClaudeModelReferences('Let @model:`Opus` handle the hard part');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('opus');
    expect(result[0].modelValue).toBe('claude-opus-4-8');
  });

  it('matches backtick mentions case-insensitively', () => {
    const result = detectClaudeModelReferences('Ask @model:`haiku 4.5` to check');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
  });

  it('matches legacy @model:label format', () => {
    const result = detectClaudeModelReferences('Ask @model:Haiku 4.5 to review');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
  });

  it('matches bare label "Haiku 4.5" (case-insensitive)', () => {
    const result = detectClaudeModelReferences('Can you ask haiku 4.5 to review this?');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
  });

  it('matches bare label "Sonnet 4.6"', () => {
    const result = detectClaudeModelReferences('I want Sonnet 4.6 to help here');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('sonnet');
  });

  it('matches full model name "claude-haiku-4-5"', () => {
    const result = detectClaudeModelReferences('Route this to claude-haiku-4-5 please');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
    expect(result[0].modelValue).toBe('claude-haiku-4-5');
  });

  it('matches full model name "claude-sonnet-4-6"', () => {
    const result = detectClaudeModelReferences('Use claude-sonnet-4-6 for this');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('sonnet');
  });

  it('matches full model name "claude-opus-4-7"', () => {
    const result = detectClaudeModelReferences('Delegate to claude-opus-4-7');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('opus');
  });

  it('returns empty for unrelated text', () => {
    const result = detectClaudeModelReferences('Just a normal question about cooking');
    expect(result).toHaveLength(0);
  });

  it('returns empty for empty prompt', () => {
    const result = detectClaudeModelReferences('');
    expect(result).toHaveLength(0);
  });

  it('matches "Opus" as bare label (exactly MIN_BARE_NAME_LENGTH chars)', () => {
    // "Opus" is exactly 4 chars = MIN_BARE_NAME_LENGTH, so >= 4 matches.
    const result = detectClaudeModelReferences('Let Opus handle this');
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('opus');
  });

  it('deduplication: same model mentioned twice → only one result', () => {
    const result = detectClaudeModelReferences(
      'Ask @model:`Haiku 4.5` and also mention haiku 4.5 again',
    );
    expect(result).toHaveLength(1);
    expect(result[0].modelAlias).toBe('haiku');
  });

  it('matches multiple different Claude models', () => {
    const result = detectClaudeModelReferences(
      'Ask @model:`Haiku 4.5` and @model:`Opus` to both review this',
    );
    expect(result).toHaveLength(2);
    const aliases = result.map(t => t.modelAlias).sort();
    expect(aliases).toEqual(['haiku', 'opus']);
  });

  it('matches all three Claude models at once', () => {
    const result = detectClaudeModelReferences(
      'Get @model:`Haiku 4.5`, @model:`Sonnet 4.6`, and @model:`Opus` perspectives',
    );
    expect(result).toHaveLength(3);
    const aliases = result.map(t => t.modelAlias).sort();
    expect(aliases).toEqual(['haiku', 'opus', 'sonnet']);
  });

  it('does not match partial model names', () => {
    // "claude" alone should not match "claude-haiku-4-5"
    const result = detectClaudeModelReferences('I like claude models in general');
    expect(result).toHaveLength(0);
  });

  it('CLAUDE_MENTION_TARGETS has expected entries', () => {
    expect(CLAUDE_MENTION_TARGETS).toHaveLength(3);
    expect(CLAUDE_MENTION_TARGETS.map(t => t.modelAlias).sort()).toEqual(['haiku', 'opus', 'sonnet']);
  });
});

// ---------------------------------------------------------------------------
// Claude Subagent Config Builder
// ---------------------------------------------------------------------------

describe('buildClaudeSubagentConfig', () => {
  const haikuTarget: ClaudeMentionTarget = {
    label: 'Haiku 4.5',
    modelValue: 'claude-haiku-4-5',
    modelAlias: 'haiku',
  };
  const sonnetTarget: ClaudeMentionTarget = {
    label: 'Sonnet 4.6',
    modelValue: 'claude-sonnet-4-6',
    modelAlias: 'sonnet',
  };
  const opusTarget: ClaudeMentionTarget = {
    label: 'Opus',
    modelValue: 'claude-opus-4-7',
    modelAlias: 'opus',
  };

  it('returns null for empty targets', () => {
    const result = buildClaudeSubagentConfig([], anthropicSettings);
    expect(result).toBeNull();
  });

  it('creates agent definitions with correct SDK aliases', () => {
    const result = buildClaudeSubagentConfig([haikuTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.model).toBe('haiku');
  });

  it('uses sonnet alias for Sonnet target', () => {
    const result = buildClaudeSubagentConfig([sonnetTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.model).toBe('sonnet');
  });

  it('uses opus alias for Opus target', () => {
    const result = buildClaudeSubagentConfig([opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.model).toBe('opus');
  });

  it('agent names use claude- prefix', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, sonnetTarget, opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agentNames = Object.keys(result!.agents);
    expect(agentNames).toHaveLength(3);
    expect(agentNames.sort()).toEqual(['claude-haiku', 'claude-opus', 'claude-sonnet']);
  });

  it('does NOT produce a route table (no proxy routing)', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, sonnetTarget], anthropicSettings);
    expect(result).not.toBeNull();
    // ClaudeSubagentConfig has no routeTable field — that's the point
    expect((result as unknown as Record<string, unknown>).routeTable).toBeUndefined();
  });

  it('generates system prompt hint', () => {
    const result = buildClaudeSubagentConfig([haikuTarget], anthropicSettings);
    expect(result).not.toBeNull();
    expect(result!.systemPromptHint).toContain('claude_subagents');
    expect(result!.systemPromptHint).toContain('claude-haiku');
    expect(result!.systemPromptHint).toContain('Haiku 4.5');
  });

  it('system prompt hint lists all matched models', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    expect(result!.systemPromptHint).toContain('claude-haiku');
    expect(result!.systemPromptHint).toContain('claude-opus');
    expect(result!.systemPromptHint).toContain('Task tool');
  });

  it('agent description uses consultation tone', () => {
    const result = buildClaudeSubagentConfig([sonnetTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.description).toContain('Consult');
    expect(agent.description).toContain('Claude Sonnet 4.6');
    expect(agent.description).toContain('independent perspective');
  });

  it('agent prompt references Claude model name', () => {
    const result = buildClaudeSubagentConfig([haikuTarget], anthropicSettings);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.prompt).toContain('Claude Haiku 4.5');
    expect(agent.routedModel).toBeUndefined();
  });

  it('builds modelDisplayNames map correctly', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    expect(result!.modelDisplayNames.get('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(result!.modelDisplayNames.get('claude-opus-4-7')).toBe('Opus');
  });

  it('builds correct config for all three models', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, sonnetTarget, opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.agents)).toHaveLength(3);
    expect(result!.modelDisplayNames.size).toBe(3);

    // Verify each agent has the right SDK alias
    expect(result!.agents['claude-haiku'].model).toBe('haiku');
    expect(result!.agents['claude-sonnet'].model).toBe('sonnet');
    expect(result!.agents['claude-opus'].model).toBe('opus');
  });

  it('does NOT include routedModel metadata in Claude subagent prompts', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, sonnetTarget], anthropicSettings);
    expect(result).not.toBeNull();
    for (const agent of Object.values(result!.agents)) {
      expect(agent.routedModel).toBeUndefined();
    }
  });

  it('does NOT have routeTable property (no proxy routing)', () => {
    const result = buildClaudeSubagentConfig([haikuTarget, sonnetTarget, opusTarget], anthropicSettings);
    expect(result).not.toBeNull();
    // Claude subagents go through SDK natively — no route table field exists
    expect(result).not.toHaveProperty('routeTable');
  });
});

describe('mixed Claude + third-party detection', () => {
  it('detectModelReferences ignores Claude model names (not in profiles)', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    // "claude-haiku-4-5" should NOT match as a third-party profile
    const result = detectModelReferences('Ask claude-haiku-4-5 and GPT-5.2 to review', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('Claude and third-party models can be detected independently from same prompt', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' }),
    ];
    const profileMatches = detectModelReferences('Ask GPT-5.2 and @model:`Haiku 4.5` to review', profiles);
    const claudeMatches = detectClaudeModelReferences('Ask GPT-5.2 and @model:`Haiku 4.5` to review');

    expect(profileMatches).toHaveLength(1);
    expect(profileMatches[0].model).toBe('gpt-5.2-codex');

    expect(claudeMatches).toHaveLength(1);
    expect(claudeMatches[0].modelAlias).toBe('haiku');
  });
});
