import { describe, expect, it } from 'vitest';
import { canonicalizeSubAgentModel } from '../subAgentRouting';

describe('canonicalizeSubAgentModel', () => {
  it('returns slug unchanged when input is a known model-* slug', () => {
    const result = canonicalizeSubAgentModel('model-google-gemini-pro-3-1', {
      agents: {
        'model-google-gemini-pro-3-1': { routedModel: 'gemini-2.5-pro' },
      },
    });

    expect(result).toEqual({ canonicalSlug: 'model-google-gemini-pro-3-1', warnings: [] });
  });

  it('maps known routed model-id input to the canonical agent slug', () => {
    const result = canonicalizeSubAgentModel('gpt-5.5', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: 'gpt-5.5' },
      },
    });

    expect(result).toEqual({ canonicalSlug: 'model-openai-gpt-5-5', warnings: [] });
  });

  it('returns null + warning for unknown inputs', () => {
    const result = canonicalizeSubAgentModel('model-something-not-in-registry', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: 'gpt-5.5' },
      },
    });

    expect(result).toEqual({
      canonicalSlug: null,
      warnings: ['unknown sub-agent identifier: model-something-not-in-registry; not in registered route table'],
    });
  });

  it('returns null + warning for empty input', () => {
    const result = canonicalizeSubAgentModel('', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: 'gpt-5.5' },
      },
    });

    expect(result).toEqual({
      canonicalSlug: null,
      warnings: ['unknown sub-agent identifier: ; not in registered route table'],
    });
  });

  it("does not match agents with routedModel undefined", () => {
    const result = canonicalizeSubAgentModel('gpt-5.5', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: undefined },
      },
    });

    expect(result).toEqual({
      canonicalSlug: null,
      warnings: ['unknown sub-agent identifier: gpt-5.5; not in registered route table'],
    });
  });

  it('does not match agents with routedModel as empty string', () => {
    const result = canonicalizeSubAgentModel('gpt-5.5', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: '' },
      },
    });

    expect(result).toEqual({
      canonicalSlug: null,
      warnings: ['unknown sub-agent identifier: gpt-5.5; not in registered route table'],
    });
  });

  it('does not match agents with routedModel null', () => {
    const result = canonicalizeSubAgentModel('gpt-5.5', {
      agents: {
        'model-openai-gpt-5-5': { routedModel: null },
      },
    });

    expect(result).toEqual({
      canonicalSlug: null,
      warnings: ['unknown sub-agent identifier: gpt-5.5; not in registered route table'],
    });
  });
});
