import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSearchQueries } from '../queryGenerationService';
import { getPrompt, PROMPT_IDS } from '../promptFileService';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';

describe('parseSearchQueries', () => {
  it('parses valid JSON with all fields', () => {
    const input = JSON.stringify({
      file_query: 'meeting agenda template',
      tool_query: 'calendar scheduling',
      conversation_query: 'Acme Corp discussion',
      skill_query: 'meeting preparation',
    });
    const result = parseSearchQueries(input);
    expect(result).toEqual({
      file_query: 'meeting agenda template',
      tool_query: 'calendar scheduling',
      conversation_query: 'Acme Corp discussion',
      skill_query: 'meeting preparation',
    });
  });

  it('treats missing fields as empty string', () => {
    const input = JSON.stringify({
      file_query: 'find docs',
      tool_query: 'search tool',
    });
    const result = parseSearchQueries(input);
    expect(result).toEqual({
      file_query: 'find docs',
      tool_query: 'search tool',
      conversation_query: '',
      skill_query: '',
    });
  });

  it('treats null fields as empty string', () => {
    const input = JSON.stringify({
      file_query: 'test',
      tool_query: null,
      conversation_query: 'past chats',
      skill_query: null,
    });
    const result = parseSearchQueries(input);
    expect(result).toEqual({
      file_query: 'test',
      tool_query: '',
      conversation_query: 'past chats',
      skill_query: '',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseSearchQueries('not json')).toBeNull();
    expect(parseSearchQueries('{broken')).toBeNull();
    expect(parseSearchQueries('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseSearchQueries('"just a string"')).toBeNull();
    expect(parseSearchQueries('42')).toBeNull();
    expect(parseSearchQueries('null')).toBeNull();
  });

  it('treats arrays as invalid (missing required fields → empty strings)', () => {
    // Arrays pass typeof === 'object' check but have no named fields
    const result = parseSearchQueries('[]');
    expect(result).toEqual({
      file_query: '',
      tool_query: '',
      conversation_query: '',
      skill_query: '',
    });
  });

  it('returns null when a field has non-string value', () => {
    const input = JSON.stringify({
      file_query: 'valid',
      tool_query: 42,
      conversation_query: 'valid',
      skill_query: 'valid',
    });
    expect(parseSearchQueries(input)).toBeNull();
  });

  it('returns null when a field is a boolean', () => {
    const input = JSON.stringify({
      file_query: 'valid',
      tool_query: true,
      conversation_query: 'valid',
      skill_query: 'valid',
    });
    expect(parseSearchQueries(input)).toBeNull();
  });

  it('handles empty string queries (skip index)', () => {
    const input = JSON.stringify({
      file_query: '',
      tool_query: '',
      conversation_query: '',
      skill_query: '',
    });
    const result = parseSearchQueries(input);
    expect(result).toEqual({
      file_query: '',
      tool_query: '',
      conversation_query: '',
      skill_query: '',
    });
  });

  it('handles extra fields gracefully', () => {
    const input = JSON.stringify({
      file_query: 'docs',
      tool_query: 'tools',
      conversation_query: 'chats',
      skill_query: 'skills',
      extra_field: 'ignored',
    });
    const result = parseSearchQueries(input);
    expect(result).toEqual({
      file_query: 'docs',
      tool_query: 'tools',
      conversation_query: 'chats',
      skill_query: 'skills',
    });
  });
});

describe('query generation prompt (from prompt file)', () => {
  beforeEach(() => setupPromptService());
  afterEach(() => teardownPromptService());

  it('contains all four query field instructions', () => {
    const prompt = getPrompt(PROMPT_IDS.INTELLIGENCE_QUERY_GENERATION);
    expect(prompt).toContain('file_query');
    expect(prompt).toContain('tool_query');
    expect(prompt).toContain('conversation_query');
    expect(prompt).toContain('skill_query');
  });

  it('urlDomainHints enrichment appends to base prompt without mutating it', () => {
    const prompt = getPrompt(PROMPT_IDS.INTELLIGENCE_QUERY_GENERATION);
    const hints = 'Google Docs document reader, Google Sheets spreadsheet reader';
    const enriched = `${prompt}\n\nThe user's message references URLs from these services: ${hints}. Consider tools for reading/fetching content from these services when generating tool search queries.`;
    expect(enriched).toContain(prompt);
    expect(enriched).toContain(hints);
    expect(enriched).toContain('Consider tools for reading/fetching');
  });
});
