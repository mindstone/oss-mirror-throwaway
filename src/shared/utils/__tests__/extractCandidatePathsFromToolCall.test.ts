import { describe, it, expect } from 'vitest';
import { extractCandidatePathsFromToolCall } from '../extractCandidatePathsFromToolCall';

/**
 * Stage 3.B (260426) — unit tests for the shared path-token extractor.
 *
 * Each test exercises one of the four input shapes the helper consolidates,
 * plus a combined dedupe test and a malformed-input test. The helper is
 * pure (no side effects), so every case is a single deterministic call.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.B
 * @see src/shared/utils/extractCandidatePathsFromToolCall.ts
 */
describe('extractCandidatePathsFromToolCall', () => {
  it('1. args.args-only: returns every absolute path-shaped string entry, drops non-path tokens', () => {
    const result = extractCandidatePathsFromToolCall({
      args: [
        '/Users/alex/mcp-servers/foo-mcp/dist/index.js',
        'node',
        '--inspect',
        '~/mcp-servers/bar-mcp',
        'C:\\Users\\alex\\mcp-servers\\baz-mcp\\index.js',
      ],
    });

    expect(result).toEqual([
      '/Users/alex/mcp-servers/foo-mcp/dist/index.js',
      '~/mcp-servers/bar-mcp',
      'C:\\Users\\alex\\mcp-servers\\baz-mcp\\index.js',
    ]);
  });

  it('2. args.command-only: quote-aware tokenisation surfaces path-shaped tokens (incl. spaced paths)', () => {
    const result = extractCandidatePathsFromToolCall({
      command: 'node "/Users/alex/My MCP/index.js" --port=3000 ~/mcp-servers/foo',
    });

    expect(result).toEqual([
      '/Users/alex/My MCP/index.js',
      '~/mcp-servers/foo',
    ]);
  });

  it('3. args.cwd-only: single working-directory string surfaces as one candidate', () => {
    const result = extractCandidatePathsFromToolCall({
      cwd: '/Users/alex/mcp-servers/qux-mcp',
    });

    expect(result).toEqual(['/Users/alex/mcp-servers/qux-mcp']);
  });

  it('4. file_path / path / filePath aliases: Write/Create/Edit-style inputs surface a single candidate (preserving first-seen order)', () => {
    // file_path alone
    expect(
      extractCandidatePathsFromToolCall({
        file_path: '/Users/alex/mcp-servers/foo-mcp/src/index.ts',
      }),
    ).toEqual(['/Users/alex/mcp-servers/foo-mcp/src/index.ts']);

    // path alias
    expect(
      extractCandidatePathsFromToolCall({
        path: '/Users/alex/mcp-servers/bar-mcp/package.json',
      }),
    ).toEqual(['/Users/alex/mcp-servers/bar-mcp/package.json']);

    // filePath camelCase alias
    expect(
      extractCandidatePathsFromToolCall({
        filePath: '/Users/alex/mcp-servers/baz-mcp/README.md',
      }),
    ).toEqual(['/Users/alex/mcp-servers/baz-mcp/README.md']);
  });

  it('5. all-four-combined: dedupes path-shaped tokens across args/command/cwd/file_path while preserving first-seen order (args > command > cwd > file_path)', () => {
    const result = extractCandidatePathsFromToolCall({
      args: [
        '/Users/alex/mcp-servers/foo-mcp/dist/index.js',
        '--inspect',
      ],
      // Same path appears in command — should be deduped (first-seen wins, args > command).
      command:
        'node /Users/alex/mcp-servers/foo-mcp/dist/index.js --port=3000 /Users/alex/mcp-servers/foo-mcp/another-file.ts',
      cwd: '/Users/alex/mcp-servers/foo-mcp',
      file_path: '/Users/alex/mcp-servers/foo-mcp/src/index.ts',
    });

    expect(result).toEqual([
      // From args.args (first-seen)
      '/Users/alex/mcp-servers/foo-mcp/dist/index.js',
      // From args.command (deduped — index.js already seen via args)
      '/Users/alex/mcp-servers/foo-mcp/another-file.ts',
      // From args.cwd
      '/Users/alex/mcp-servers/foo-mcp',
      // From file_path
      '/Users/alex/mcp-servers/foo-mcp/src/index.ts',
    ]);
  });

  it('6. malformed input: null / undefined / non-object / mixed-type values yield [] without throwing', () => {
    // null and undefined.
    expect(extractCandidatePathsFromToolCall(null)).toEqual([]);
    expect(extractCandidatePathsFromToolCall(undefined)).toEqual([]);
    // Empty object.
    expect(extractCandidatePathsFromToolCall({})).toEqual([]);
    // Non-object passed via a deliberately loose cast — helper must NOT throw.
    expect(extractCandidatePathsFromToolCall('not-a-record' as unknown as Record<string, unknown>))
      .toEqual([]);
    expect(extractCandidatePathsFromToolCall(42 as unknown as Record<string, unknown>)).toEqual([]);
    // Wrong shapes for each scanned key — non-array args, non-string command/cwd/file_path,
    // and non-string entries inside args. The helper must drop them all silently.
    expect(
      extractCandidatePathsFromToolCall({
        args: 'not-an-array',
        command: 12345,
        cwd: { weird: 'object' },
        file_path: null,
        path: false,
        filePath: ['/Users/alex/wrong/shape'],
      }),
    ).toEqual([]);
    // Tokens that don't look like absolute paths get dropped (relative paths, plain
    // command verbs, env-style values).
    expect(
      extractCandidatePathsFromToolCall({
        args: ['relative/path/foo.ts', 'node', './local'],
        command: 'echo hello world',
        cwd: '   ', // whitespace-only -> trimmed -> empty -> dropped
      }),
    ).toEqual([]);
  });
});
