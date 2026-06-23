import { describe, expect, it } from 'vitest';
import { assemblePersonaPrompt } from '../personaPromptAssembly';

describe('personaPromptAssembly', () => {
  it('assembles stable persona prompt sections', () => {
    const prompt = assemblePersonaPrompt({
      callerContext: 'Workspace context',
      persona: 'You are the Skeptical Engineer.',
      voiceFraming: ['Be direct.', 'Prefer concrete risks.'],
      grounding: 'Company builds workflow software for finance teams.',
      diaryEntries: ['Flagged launch risk yesterday.', 'Approved simpler rollout.'],
      focus: 'Review this release plan.',
    });

    expect(prompt).toBe([
      'Workspace context',
      '',
      'You are the Skeptical Engineer.',
      'Be direct.',
      'Prefer concrete risks.',
      '',
      '<operator_grounding>',
      'Company builds workflow software for finance teams.',
      '</operator_grounding>',
      '',
      '<operator_diary>',
      '- Flagged launch risk yesterday.',
      '- Approved simpler rollout.',
      '</operator_diary>',
      '',
      '<operator_focus>',
      'Review this release plan.',
      '</operator_focus>',
    ].join('\n'));
  });

  it('preserves council prompt shape when only caller context and persona framing are provided', () => {
    const prompt = assemblePersonaPrompt({
      callerContext: 'Base system prompt',
      persona: 'You are a council member.',
      voiceFraming: [
        'Investigate thoroughly.',
        'Return findings.',
      ],
    });

    expect(prompt).toBe([
      'Base system prompt',
      '',
      'You are a council member.',
      'Investigate thoroughly.',
      'Return findings.',
    ].join('\n'));
  });
});
