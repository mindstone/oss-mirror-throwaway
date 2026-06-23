import { describe, it, expect } from 'vitest';
import { buildSubagentMemberContext } from '../agentContextHelpers';

describe('buildSubagentMemberContext', () => {
  it('returns the full prompt when no sections are excluded', () => {
    const prompt = '# Rebel\n\n## [CONTEXT]\nSpaces.\n\n## [TOOL_USE]\nTools.';
    const result = buildSubagentMemberContext(prompt);
    expect(result).toContain('Spaces.');
    expect(result).toContain('Tools.');
  });

  it('strips sections with <!-- council: exclude --> marker', () => {
    const prompt = [
      '# Preamble',
      '',
      '## [KEEP_ME]\nKept content.',
      '',
      '## [EXCLUDE_ME] <!-- council: exclude -->\nExcluded content.',
      '',
      '## [ALSO_KEEP]\nAlso kept.',
    ].join('\n');
    const result = buildSubagentMemberContext(prompt);
    expect(result).toContain('Preamble');
    expect(result).toContain('Kept content.');
    expect(result).toContain('Also kept.');
    expect(result).not.toContain('Excluded content.');
    expect(result).not.toContain('EXCLUDE_ME');
  });

  it('handles multiple excluded sections', () => {
    const prompt = [
      '## [A]\nContent A.',
      '## [B] <!-- council: exclude -->\nContent B.',
      '## [C] <!-- council: exclude -->\nContent C.',
      '## [D]\nContent D.',
    ].join('\n\n');
    const result = buildSubagentMemberContext(prompt);
    expect(result).toContain('Content A.');
    expect(result).toContain('Content D.');
    expect(result).not.toContain('Content B.');
    expect(result).not.toContain('Content C.');
  });

  it('returns empty string for empty input', () => {
    expect(buildSubagentMemberContext('')).toBe('');
  });

  it('returns prompt as-is when no section headers exist', () => {
    const prompt = 'Just some text without headers.';
    expect(buildSubagentMemberContext(prompt)).toBe(prompt);
  });
});
