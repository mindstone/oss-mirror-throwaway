import { describe, it, expect } from 'vitest';
import { detectModelReferences, buildAdHocAgentConfig } from '../adHocAgentService';
import type { ModelProfile } from '@shared/types';

function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://localhost:1234',
    createdAt: Date.now(),
    councilEnabled: false,
    model: 'test-model',
    ...overrides,
  };
}

describe('detectModelReferences', () => {
  it('matches @model backtick mentions', () => {
    const profiles = [makeProfile({ id: 'a', name: 'GPT-5.2', model: 'gpt-5.2-codex' })];
    const result = detectModelReferences('Ask @model:`GPT-5.2` to review this', profiles);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('does not match short names as bare words', () => {
    const profiles = [makeProfile({ id: 'a', name: 'AI', model: 'some-model' })];
    const result = detectModelReferences('Use AI for this', profiles);
    expect(result).toHaveLength(0);
  });
});

describe('buildAdHocAgentConfig', () => {
  it('builds routed ad-hoc agents', () => {
    const profiles = [makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' })];
    const result = buildAdHocAgentConfig(profiles, '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.model).toBe('working');
    expect(agent.routedModel).toBe('deepseek-r1');
    expect(result!.routeTable.routes.get('deepseek-r1')?.id).toBe('a');
  });

  it('applies shared prompt context filtering for excluded sections', () => {
    const profiles = [makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' })];
    const basePrompt = [
      '## [KEEP_ME]\nSpaces info.',
      '## [EXCLUDE_ME] <!-- council: exclude -->\nInternal-only instructions.',
      '## [ALSO_KEEP]\nTool details.',
    ].join('\n\n');

    const result = buildAdHocAgentConfig(profiles, basePrompt);
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.prompt).toContain('Spaces info.');
    expect(agent.prompt).toContain('Tool details.');
    expect(agent.prompt).not.toContain('Internal-only instructions.');
  });
});
