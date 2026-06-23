import { describe, expect, it } from 'vitest';

import { extractParamHints, isEmptyParamSchema, formatSuggestedToolsContext } from '../../utils/agentTurnFormatters';

describe('extractParamHints', () => {
  it('renders basic types and required/optional markers', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        to: { type: 'string', format: 'email' },
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: { type: 'string', format: 'email' },
      },
      required: ['to', 'subject', 'body'],
    });

    expect(result).toBe('(to: email, subject: string, body: string, cc?: email)');
  });

  it('uses format as a type override when provided', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        start: { type: 'string', format: 'date-time' },
      },
      required: ['start'],
    });

    expect(result).toContain('start: date-time');
    expect(result).not.toContain('start: string');
  });

  it('renders inline enums for string and integer fields', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        meetingType: { type: 'string', enum: ['all', 'internal', 'external'] },
        priority: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      },
    });

    expect(result).toContain('meetingType?: "all"|"internal"|"external"');
    expect(result).toContain('priority?: 1|2|3|4|5');
  });

  it('truncates long enums after five values', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        country: {
          type: 'string',
          enum: ['US', 'UK', 'CA', 'AU', 'DE', 'FR', 'JP'],
        },
      },
    });

    expect(result).toContain('country?: "US"|"UK"|"CA"|"AU"|"DE"|...');
    expect(result).not.toContain('"FR"');
  });

  it('falls back to basic type names for nested object/array fields', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        metadata: {
          type: 'object',
          properties: {
            source: { type: 'string' },
          },
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    });

    expect(result).toContain('metadata?: object');
    expect(result).toContain('items?: array');
  });

  it('returns empty string for null, undefined, or empty schema', () => {
    expect(extractParamHints(undefined)).toBe('');
    expect(extractParamHints(null)).toBe('');
    expect(extractParamHints({})).toBe('');
    expect(extractParamHints({ properties: {} })).toBe('');
  });

  it('renders oneOf type unions as pipe-separated types', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        value: {
          description: 'Filter value',
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
      },
    });

    expect(result).toContain('value?: string|number|boolean');
  });

  it('renders oneOf const values as inline enums', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        mode: {
          oneOf: [{ const: 'fast' }, { const: 'balanced' }, { const: 'thorough' }],
        },
      },
    });

    expect(result).toContain('mode?: "fast"|"balanced"|"thorough"');
  });

  it('handles boolean enum values', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        enabled: { type: 'boolean', enum: [true, false] },
      },
    });

    expect(result).toContain('enabled?: true|false');
  });

  it('preserves IMPORTANT hints alongside type annotations', () => {
    const result = extractParamHints({
      type: 'object',
      properties: {
        save_path: {
          type: 'string',
          description: 'Path to save output. IMPORTANT: Must be inside workspace.',
        },
      },
    });

    expect(result).toContain('save_path?: string');
    expect(result).toContain('"Must be inside workspace"');
  });
});

describe('isEmptyParamSchema', () => {
  it('returns true for schema with empty properties', () => {
    expect(isEmptyParamSchema({ type: 'object', properties: {} })).toBe(true);
  });

  it('returns true for schema with empty properties and additionalProperties', () => {
    expect(isEmptyParamSchema({ type: 'object', properties: {}, additionalProperties: false })).toBe(true);
  });

  it('returns false for schema with properties', () => {
    expect(isEmptyParamSchema({ type: 'object', properties: { query: { type: 'string' } } })).toBe(false);
  });

  it('returns false for null/undefined/missing properties', () => {
    expect(isEmptyParamSchema(null)).toBe(false);
    expect(isEmptyParamSchema(undefined)).toBe(false);
    expect(isEmptyParamSchema({})).toBe(false);
    expect(isEmptyParamSchema({ type: 'object' })).toBe(false);
  });
});

describe('formatSuggestedToolsContext', () => {
  const makeTool = (overrides: Partial<Parameters<typeof formatSuggestedToolsContext>[0][0]> = {}) => ({
    toolId: 'send_email',
    serverId: 'GoogleWorkspace',
    serverName: 'Google Workspace',
    description: 'Send an email',
    summary: 'Send an email',
    score: 0.99,
    inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
    ...overrides,
  });

  it('formats tools without parameter hints', () => {
    const context = formatSuggestedToolsContext([
      {
        serverId: 'GoogleWorkspace',
        serverName: 'Google Workspace',
        toolId: 'send_email',
        description: 'Send an email',
        summary: 'Send an email',
        score: 0.99,
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', format: 'email' },
            subject: { type: 'string' },
            priority: { type: 'integer', enum: [1, 2, 3, 4, 5] },
          },
          required: ['to', 'subject'],
        },
      },
    ]);

    expect(context).toContain('package_id=`GoogleWorkspace`, tool_id=`send_email` — Send an email');
    expect(context).not.toContain('params:');
  });

  it('formats zero-param tools without parameter hints', () => {
    const context = formatSuggestedToolsContext([
      {
        serverId: 'Salesforce',
        serverName: 'Salesforce',
        toolId: 'salesforce_connect_account',
        description: 'Connect a Salesforce account via OAuth',
        summary: 'Connect a Salesforce account via OAuth',
        score: 0.95,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ]);

    expect(context).toContain('package_id=`Salesforce`, tool_id=`salesforce_connect_account` — Connect a Salesforce account via OAuth');
    expect(context).not.toContain('params:');
  });

  describe('framing preamble', () => {
    it('starts with the framing preamble mentioning relevance caveat', () => {
      const context = formatSuggestedToolsContext([makeTool()]);
      expect(context).toMatch(/^Potentially relevant tools for this request \(not an exclusive list\)/);
    });

    it('mentions get_tool_details in the preamble', () => {
      const context = formatSuggestedToolsContext([makeTool()]);
      const preamble = context!.split('\n')[0];
      expect(preamble).toContain('get_tool_details');
    });

    it('includes account label in tool line when serverAccountMap provides one', () => {
      const accountMap = new Map([['GoogleWorkspace', 'alice@example.com']]);
      const context = formatSuggestedToolsContext([makeTool()], accountMap);
      expect(context).toContain('(alice@example.com)');
      expect(context).toContain('tool_id=`send_email` (alice@example.com) —');
    });

    it('truncates summaries longer than 150 characters', () => {
      const longSummary = 'A'.repeat(200);
      const context = formatSuggestedToolsContext([makeTool({ summary: longSummary })]);
      // Truncation: first 147 chars + "..."
      expect(context).toContain('A'.repeat(147) + '...');
      expect(context).not.toContain('A'.repeat(148));
    });

    it('does not truncate summaries at exactly 150 characters', () => {
      const exactSummary = 'B'.repeat(150);
      const context = formatSuggestedToolsContext([makeTool({ summary: exactSummary })]);
      expect(context).toContain(exactSummary);
      expect(context).not.toContain('...');
    });

    it('returns undefined for an empty tools array', () => {
      expect(formatSuggestedToolsContext([])).toBeUndefined();
      expect(formatSuggestedToolsContext([], new Map())).toBeUndefined();
    });
  });
});
