import { describe, it, expect } from 'vitest';
import { buildToolLabel, extractBasename, sanitizeCommandForDisplay } from '../toolLabels';

describe('toolLabels', () => {
  it('maps standard file tools and extracts basename', () => {
    const readResult = buildToolLabel('Read', JSON.stringify({ file_path: '/workspace/src/index.ts' }));
    expect(readResult.label).toBe('Read file');
    expect(readResult.shortDetail).toBe('index.ts');

    const writeResult = buildToolLabel('str_replace_editor', JSON.stringify({ path: '/workspace/app/main.py' }));
    expect(writeResult.label).toBe('Write file');
    expect(writeResult.shortDetail).toBe('main.py');
  });

  it('maps other standard tools', () => {
    expect(buildToolLabel('Grep').label).toBe('Search');
    expect(buildToolLabel('LS').label).toBe('List directory');
    expect(buildToolLabel('Glob').label).toBe('Find files');
    expect(buildToolLabel('WebSearch').label).toBe('Web search');
    expect(buildToolLabel('WebFetch').label).toBe('Fetch page');
    expect(buildToolLabel('SearchFiles').label).toBe('Search files');
    expect(buildToolLabel('TodoWrite').label).toBe('Update todos');
  });

  it('extracts and sanitizes command details', () => {
    const result = buildToolLabel(
      'Bash',
      JSON.stringify({
        command: 'OPENAI_API_KEY=sk-ant-very-secret-value npm run dev --api-key sk-ant-another-secret',
      }),
    );

    expect(result.label).toBe('Run command');
    expect(result.shortDetail).toContain('npm run dev');
    expect(result.shortDetail).toContain('***');
    expect(result.shortDetail).not.toContain('very-secret-value');
    expect(result.shortDetail!.length).toBeLessThanOrEqual(60);
  });

  it('truncates shortDetail to 60 characters with ellipsis', () => {
    const result = buildToolLabel(
      'bash',
      JSON.stringify({ cmd: `echo ${'a'.repeat(100)}` }),
    );

    expect(result.shortDetail).toBeDefined();
    expect(result.shortDetail!.length).toBeLessThanOrEqual(60);
    expect(result.shortDetail).toMatch(/[….]$/);
  });

  it('builds MCP router labels from tool_name and server_name', () => {
    const fromToolName = buildToolLabel(
      'mcp__super-mcp-router__use_tool',
      JSON.stringify({ tool_name: 'google-calendar__list_events' }),
    );
    expect(fromToolName.label).toBe('Google Calendar • List Events');

    const fromServerName = buildToolLabel(
      'mcp__super-mcp-router__list_tools',
      JSON.stringify({ server_name: 'google-calendar' }),
    );
    expect(fromServerName.label).toBe('Google Calendar • List Tools');
  });

  it('falls back gracefully for unknown, malformed, and empty detail', () => {
    expect(buildToolLabel('custom_magic_tool').label).toBe('Custom Magic Tool');

    const malformed = buildToolLabel('read_file', '{"file_path":');
    expect(malformed.label).toBe('Read file');
    expect(malformed.shortDetail).toBeUndefined();

    const empty = buildToolLabel('bash', '');
    expect(empty.label).toBe('Run command');
    expect(empty.shortDetail).toBeUndefined();
  });

  it('sanitizes API keys from command strings', () => {
    const command = 'curl https://user:pass@example.com --api-key sk-ant-top-secret-token-1234';
    const sanitized = sanitizeCommandForDisplay(command);

    expect(sanitized).toContain('***');
    expect(sanitized).not.toContain('top-secret-token-1234');
    expect(sanitized.length).toBeLessThanOrEqual(60);
  });

  it('extracts basename for unix and windows paths', () => {
    expect(extractBasename('/Users/name/project/src/file.ts')).toBe('file.ts');
    expect(extractBasename('C:\\Users\\name\\project\\file.tsx')).toBe('file.tsx');
  });

  it('handles nested arrays and objects in tool detail arguments', () => {
    // file_path as an array — collectStringValuesFromUnknown recurses into arrays
    const arrayPaths = buildToolLabel(
      'Read',
      JSON.stringify({ file_path: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );
    expect(arrayPaths.shortDetail).toBe('a.ts');

    // Deeply nested object — collectValuesByKeys recurses into child objects
    const nested = buildToolLabel(
      'Read',
      JSON.stringify({ wrapper: { inner: { file_path: '/deep/nested/file.rs' } } }),
    );
    expect(nested.shortDetail).toBe('file.rs');
  });

  it('handles double-encoded JSON in tool detail', () => {
    // parseToolDetail applies JSON.parse twice when the first parse returns a string
    const doubleEncoded = buildToolLabel(
      'bash',
      JSON.stringify(JSON.stringify({ command: 'npm test' })),
    );
    expect(doubleEncoded.label).toBe('Run command');
    expect(doubleEncoded.shortDetail).toBe('npm test');
  });

  it('resolves server from the "server" key alias', () => {
    // SERVER_NAME_KEY_SET includes 'server' alongside 'server_name'
    const result = buildToolLabel(
      'mcp__super-mcp-router__use_tool',
      JSON.stringify({ tool_name: 'list_events', server: 'google-calendar' }),
    );
    // server derived from tool_name identifier (no __ separator), falls back to 'server' field
    expect(result.label).toBe('Google Calendar • List Events');
  });

  it('extracts values from nested structures with recursive precedence', () => {
    // command key nested inside an outer object — collectValuesByKeys finds it recursively
    const nestedCommand = buildToolLabel(
      'bash',
      JSON.stringify({ execution: { command: 'git status' } }),
    );
    expect(nestedCommand.shortDetail).toBe('git status');

    // Both path and command present — commands take precedence in shortDetail
    const both = buildToolLabel(
      'bash',
      JSON.stringify({ command: 'ls -la', file_path: '/some/path.txt' }),
    );
    expect(both.shortDetail).toBe('ls -la');
  });
});
