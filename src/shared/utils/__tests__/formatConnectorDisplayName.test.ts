import { describe, it, expect } from 'vitest';
import { formatConnectorDisplayName } from '../formatConnectorDisplayName';

describe('formatConnectorDisplayName', () => {
  it('converts kebab-case to Title Case', () => {
    expect(formatConnectorDisplayName('apple-shortcuts')).toBe('Apple Shortcuts');
  });

  it('converts snake_case to Title Case (trailing "mcp" plumbing stripped)', () => {
    // The build skill's canonical slug is `<api-name>-mcp`, so "my_custom_mcp"
    // → "My Custom" — the plumbing suffix would read as a typo to users.
    expect(formatConnectorDisplayName('my_custom_mcp')).toBe('My Custom');
  });

  it('strips trailing mcp / server plumbing tokens', () => {
    expect(formatConnectorDisplayName('apple-shortcuts-mcp')).toBe('Apple Shortcuts');
    expect(formatConnectorDisplayName('typeform-mcp')).toBe('Typeform');
    expect(formatConnectorDisplayName('apple-mcp-server')).toBe('Apple');
    expect(formatConnectorDisplayName('foo-serverkit')).toBe('Foo');
  });

  it('strips leading mcp plumbing tokens', () => {
    expect(formatConnectorDisplayName('mcp-mail-server')).toBe('Mail');
  });

  it('preserves the final token when a name is only plumbing', () => {
    // `formatConnectorDisplayName('mcp')` must still show something; never strip
    // to an empty string.
    expect(formatConnectorDisplayName('mcp')).toBe('Mcp');
    expect(formatConnectorDisplayName('server')).toBe('Server');
  });

  it('handles names with embedded digits', () => {
    expect(formatConnectorDisplayName('apple-shortcuts-2')).toBe('Apple Shortcuts 2');
    expect(formatConnectorDisplayName('v2-connector')).toBe('V2 Connector');
  });

  it('capitalises a single lowercase word', () => {
    expect(formatConnectorDisplayName('figma')).toBe('Figma');
  });

  it('passes through names that already contain whitespace', () => {
    expect(formatConnectorDisplayName('Apple Shortcuts')).toBe('Apple Shortcuts');
    expect(formatConnectorDisplayName('My MCP')).toBe('My MCP');
  });

  it('passes through names that already look titled', () => {
    // Protects hand-curated display names like "GitHub" from being downcased.
    expect(formatConnectorDisplayName('GitHub')).toBe('GitHub');
    expect(formatConnectorDisplayName('Notion')).toBe('Notion');
  });

  it('collapses multiple delimiters', () => {
    expect(formatConnectorDisplayName('foo--bar__baz')).toBe('Foo Bar Baz');
  });

  it('strips surrounding whitespace', () => {
    expect(formatConnectorDisplayName('  apple-shortcuts  ')).toBe('Apple Shortcuts');
  });

  it('handles empty and nullish input', () => {
    expect(formatConnectorDisplayName('')).toBe('');
    expect(formatConnectorDisplayName('   ')).toBe('');
    expect(formatConnectorDisplayName(null)).toBe('');
    expect(formatConnectorDisplayName(undefined)).toBe('');
  });

  it('handles single character names', () => {
    expect(formatConnectorDisplayName('a')).toBe('A');
  });

  it('preserves internal capitalisation inside a word segment', () => {
    // Each segment's first char is uppercased, rest is left as-is — so acronyms
    // in the raw name survive.
    expect(formatConnectorDisplayName('my-API-tool')).toBe('My API Tool');
  });
});
