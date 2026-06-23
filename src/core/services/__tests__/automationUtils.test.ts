import { describe, expect, it } from 'vitest';
import {
  stripYamlFrontmatter,
  formatLastSuccessTimestamp,
  substitutePromptVariables,
  sanitizeContextValue,
  injectEventContext,
  buildAutomationPrompt,
  normalizeAutomationModelOverride,
} from '../automationUtils';

describe('stripYamlFrontmatter', () => {
  it('returns content unchanged when no frontmatter', () => {
    expect(stripYamlFrontmatter('Hello world')).toBe('Hello world');
  });

  it('strips valid YAML frontmatter', () => {
    const input = '---\ntitle: Test\nauthor: Bot\n---\nContent here';
    expect(stripYamlFrontmatter(input)).toBe('Content here');
  });

  it('returns content unchanged when opening --- but no closing ---', () => {
    const input = '---\ntitle: Test\nauthor: Bot\nContent here';
    expect(stripYamlFrontmatter(input)).toBe(input);
  });

  it('handles frontmatter with trailing newline', () => {
    const input = '---\ntitle: Test\n---\n\nBody text';
    // The regex captures the closing --- plus trailing \n, leaving one \n consumed
    expect(stripYamlFrontmatter(input)).toBe('Body text');
  });

  it('handles frontmatter at the very end of content', () => {
    const input = '---\ntitle: Test\n---\n';
    expect(stripYamlFrontmatter(input)).toBe('');
  });

  it('does not strip content that starts with --- but is not frontmatter', () => {
    expect(stripYamlFrontmatter('---not frontmatter')).toBe('---not frontmatter');
  });
});

describe('formatLastSuccessTimestamp', () => {
  it('returns "Never" for null', () => {
    expect(formatLastSuccessTimestamp(null)).toBe('Never');
  });

  it('returns "Never" for undefined', () => {
    expect(formatLastSuccessTimestamp(undefined)).toBe('Never');
  });

  it('formats a valid timestamp as ISO with UTC label', () => {
    const ts = new Date('2026-03-15T10:00:00Z').getTime();
    expect(formatLastSuccessTimestamp(ts)).toBe('2026-03-15T10:00:00.000Z (UTC)');
  });
});

describe('substitutePromptVariables', () => {
  it('replaces [LAST_EXECUTED_SUCCESS] with "Never" when no timestamp', () => {
    const prompt = 'Last run: [LAST_EXECUTED_SUCCESS]';
    expect(substitutePromptVariables(prompt, {})).toBe('Last run: Never');
  });

  it('replaces [LAST_EXECUTED_SUCCESS] with formatted timestamp', () => {
    const ts = new Date('2026-01-15T08:30:00Z').getTime();
    const prompt = 'Since [LAST_EXECUTED_SUCCESS], check new items.';
    expect(substitutePromptVariables(prompt, { lastSuccessAt: ts })).toBe(
      'Since 2026-01-15T08:30:00.000Z (UTC), check new items.',
    );
  });

  it('is case-insensitive', () => {
    const prompt = '[last_executed_success] and [LAST_EXECUTED_SUCCESS]';
    expect(substitutePromptVariables(prompt, {})).toBe('Never and Never');
  });

  it('handles whitespace in brackets', () => {
    const prompt = '[ LAST_EXECUTED_SUCCESS ]';
    expect(substitutePromptVariables(prompt, {})).toBe('Never');
  });

  it('returns prompt unchanged when no variable present', () => {
    const prompt = 'No variables here.';
    expect(substitutePromptVariables(prompt, {})).toBe(prompt);
  });
});

describe('sanitizeContextValue', () => {
  it('converts non-string to string', () => {
    expect(sanitizeContextValue(42)).toBe('42');
    expect(sanitizeContextValue(true)).toBe('true');
  });

  it('escapes newlines', () => {
    expect(sanitizeContextValue('line1\nline2')).toBe('line1 line2');
  });

  it('escapes backticks', () => {
    expect(sanitizeContextValue('some `code` here')).toBe("some 'code' here");
  });

  it('removes heading markers at start of line', () => {
    // The regex /^#+\s/gm removes heading markers (# followed by space) at line start
    expect(sanitizeContextValue('## Heading')).toBe('Heading');
    expect(sanitizeContextValue('# Title')).toBe('Title');
    expect(sanitizeContextValue('Not ## a heading')).toBe('Not ## a heading');
  });

  it('truncates long values at 500 chars', () => {
    const long = 'x'.repeat(600);
    const result = sanitizeContextValue(long);
    expect(result).toBe('x'.repeat(500) + '...');
  });
});

describe('injectEventContext', () => {
  it('appends context block to prompt', () => {
    const result = injectEventContext('Base prompt', { key: 'value' });
    expect(result).toContain('Base prompt');
    expect(result).toContain('## Event Context');
    expect(result).toContain('- key: value');
  });

  it('filters out null and undefined values', () => {
    const result = injectEventContext('Prompt', {
      present: 'yes',
      absent: null,
      missing: undefined,
    });
    expect(result).toContain('- present: yes');
    expect(result).not.toContain('absent');
    expect(result).not.toContain('missing');
  });

  it('handles array values', () => {
    const result = injectEventContext('Prompt', { items: ['a', 'b', 'c'] });
    expect(result).toContain('- items: a, b, c');
  });

  it('handles empty array', () => {
    const result = injectEventContext('Prompt', { items: [] });
    expect(result).toContain('- items: (none)');
  });
});

describe('buildAutomationPrompt', () => {
  it('strips frontmatter, substitutes variables, and trims', () => {
    const raw = '---\ntitle: Test\n---\n\nSince [LAST_EXECUTED_SUCCESS], do stuff.';
    const result = buildAutomationPrompt(raw, { lastSuccessAt: null });
    expect(result).toBe('Since Never, do stuff.');
  });

  it('injects event context when provided', () => {
    const raw = 'Do the thing.';
    const result = buildAutomationPrompt(raw, {}, { source: 'transcript' });
    expect(result).toContain('Do the thing.');
    expect(result).toContain('## Event Context');
    expect(result).toContain('- source: transcript');
  });

  it('skips event context when empty object', () => {
    const raw = 'Do the thing.';
    const result = buildAutomationPrompt(raw, {}, {});
    expect(result).toBe('Do the thing.');
    expect(result).not.toContain('Event Context');
  });

  it('skips event context when undefined', () => {
    const raw = 'Do the thing.';
    const result = buildAutomationPrompt(raw, {});
    expect(result).toBe('Do the thing.');
  });
});

describe('normalizeAutomationModelOverride', () => {
  it('returns undefined for non-string', () => {
    expect(normalizeAutomationModelOverride(undefined)).toBeUndefined();
    expect(normalizeAutomationModelOverride(null)).toBeUndefined();
    expect(normalizeAutomationModelOverride(42)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizeAutomationModelOverride('')).toBeUndefined();
    expect(normalizeAutomationModelOverride('   ')).toBeUndefined();
  });

  it('returns trimmed string for valid model', () => {
    expect(normalizeAutomationModelOverride('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeAutomationModelOverride('  claude-opus-4-7  ')).toBe('claude-opus-4-7');
  });
});
