import { describe, it, expect } from 'vitest';
import {
  isToolNameLengthError,
  truncateToolName,
  ANTHROPIC_MAX_TOOL_NAME_LENGTH,
} from '../toolNameValidation';

describe('isToolNameLengthError', () => {
  it('returns false for empty string', () => {
    expect(isToolNameLengthError('')).toBe(false);
  });

  it('detects exact Anthropic API error message', () => {
    expect(
      isToolNameLengthError(
        'API Error: 400 invalid_request_error - messages.2.content.0.tool_use.name: String should have at most 200 characters but has 347 characters'
      )
    ).toBe(true);
  });

  it('detects tool_use.name with "characters" keyword', () => {
    expect(isToolNameLengthError('tool_use.name: String should have at most 200 characters')).toBe(true);
  });

  it('detects tool_use.name with "invalid_request_error"', () => {
    expect(isToolNameLengthError('invalid_request_error - tool_use.name exceeds limit')).toBe(true);
  });

  it('detects tool_use.name with "string should have"', () => {
    expect(isToolNameLengthError('tool_use.name: string should have at most 200')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(
      isToolNameLengthError(
        'Tool_Use.Name: String should have at most 200 characters'
      )
    ).toBe(true);
  });

  it('returns false for unrelated error messages', () => {
    expect(isToolNameLengthError('rate_limit: too many requests')).toBe(false);
    expect(isToolNameLengthError('context overflow detected')).toBe(false);
    expect(isToolNameLengthError('tool_use block has no input')).toBe(false);
  });

  it('returns false for text mentioning tool_use.name without validation keywords', () => {
    // Conversational text discussing the API field — should NOT trigger recovery
    expect(isToolNameLengthError('The tool_use.name field is a string identifier')).toBe(false);
    expect(isToolNameLengthError('Check tool_use.name in the docs')).toBe(false);
  });

  it('returns false when keywords match but tool_use.name is absent', () => {
    // Has "at most" and "characters" but no "tool_use.name"
    expect(isToolNameLengthError('name has at most 200 characters')).toBe(false);
    // Has "tool_use" and "name" separately but not "tool_use.name"
    expect(isToolNameLengthError('tool_use block has name with at most 200 characters allowed')).toBe(false);
  });

  it('detects error embedded in longer synthetic assistant text', () => {
    const syntheticText =
      'I encountered an error while processing your request. API Error: 400 invalid_request_error - messages.5.content.0.tool_use.name: String should have at most 200 characters but has 512 characters. Please try again.';
    expect(isToolNameLengthError(syntheticText)).toBe(true);
  });
});

describe('truncateToolName', () => {
  it('returns short names unchanged', () => {
    expect(truncateToolName('my_tool')).toBe('my_tool');
  });

  it('returns names at exactly the limit unchanged', () => {
    const exactName = 'a'.repeat(ANTHROPIC_MAX_TOOL_NAME_LENGTH);
    expect(truncateToolName(exactName)).toBe(exactName);
    expect(truncateToolName(exactName).length).toBe(ANTHROPIC_MAX_TOOL_NAME_LENGTH);
  });

  it('truncates names exceeding the limit', () => {
    const longName = 'x'.repeat(350);
    const result = truncateToolName(longName);
    expect(result.length).toBe(ANTHROPIC_MAX_TOOL_NAME_LENGTH);
    expect(result).toBe('x'.repeat(ANTHROPIC_MAX_TOOL_NAME_LENGTH));
  });

  it('returns empty string unchanged', () => {
    expect(truncateToolName('')).toBe('');
  });
});

describe('ANTHROPIC_MAX_TOOL_NAME_LENGTH', () => {
  it('is 200', () => {
    expect(ANTHROPIC_MAX_TOOL_NAME_LENGTH).toBe(200);
  });
});
