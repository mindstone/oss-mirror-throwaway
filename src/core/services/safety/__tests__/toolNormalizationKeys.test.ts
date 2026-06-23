import { describe, it, expect } from 'vitest';

import {
  buildNormalizedToolKey,
  bashKey,
  editWriteKey,
  mcpRouterKey,
  imageGenKey,
  defaultKey,
  canonicalArgsJSON,
} from '../toolNormalizationKeys';

describe('canonicalArgsJSON', () => {
  it('sorts object keys recursively', () => {
    const a = { b: 2, a: 1, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 1, b: 2 };
    expect(canonicalArgsJSON(a)).toBe(canonicalArgsJSON(b));
  });

  it('strips volatile fields', () => {
    const a = { foo: 1, _rebel_staged: true };
    const b = { foo: 1, _rebel_staged_id: 'abc' };
    const c = { foo: 1, _rebel_staged_message: 'msg' };
    const d = { foo: 1, _internal_trace: 'xyz' };
    const expected = canonicalArgsJSON({ foo: 1 });
    expect(canonicalArgsJSON(a)).toBe(expected);
    expect(canonicalArgsJSON(b)).toBe(expected);
    expect(canonicalArgsJSON(c)).toBe(expected);
    expect(canonicalArgsJSON(d)).toBe(expected);
  });

  it('preserves array order', () => {
    const a = { recipients: ['a@example.com', 'b@example.com'] };
    const b = { recipients: ['b@example.com', 'a@example.com'] };
    expect(canonicalArgsJSON(a)).not.toBe(canonicalArgsJSON(b));
  });
});

describe('bashKey', () => {
  it('returns same key when commands match (cwd identical)', () => {
    const k1 = bashKey('Bash', { command: 'ls -la', cwd: '/work' });
    const k2 = bashKey('Bash', { command: 'ls -la', cwd: '/work' });
    expect(k1).toBe(k2);
  });

  it('returns same key when only the 2>/dev/null suffix differs', () => {
    const k1 = bashKey('Bash', { command: 'find . -name *.md', cwd: '/work' });
    const k2 = bashKey('Bash', { command: 'find . -name *.md 2>/dev/null', cwd: '/work' });
    expect(k1).toBe(k2);
  });

  it('returns same key when whitespace runs differ', () => {
    const k1 = bashKey('Bash', { command: 'ls   -la', cwd: '/work' });
    const k2 = bashKey('Bash', { command: 'ls -la', cwd: '/work' });
    expect(k1).toBe(k2);
  });

  it('returns different key when cwd differs', () => {
    const k1 = bashKey('Bash', { command: 'ls -la', cwd: '/work-a' });
    const k2 = bashKey('Bash', { command: 'ls -la', cwd: '/work-b' });
    expect(k1).not.toBe(k2);
  });

  it('returns null for missing command', () => {
    expect(bashKey('Bash', {})).toBeNull();
    expect(bashKey('Bash', null)).toBeNull();
  });
});

describe('editWriteKey (deprecated — file writes are not memoized)', () => {
  it('always returns null so file writes always re-evaluate', () => {
    expect(editWriteKey('Edit', { file_path: '/work/foo.md', new_string: 'hello' })).toBeNull();
    expect(editWriteKey('Write', { path: '/work/foo.md', file_text: 'A' })).toBeNull();
    expect(editWriteKey('Create', { file_path: '/work/foo.md' })).toBeNull();
    expect(editWriteKey('str_replace_editor', { file_path: '/work/foo.md' })).toBeNull();
    expect(editWriteKey('write_file', { path: '/work/foo.md' })).toBeNull();
    expect(editWriteKey('create_file', { path: '/work/foo.md' })).toBeNull();
  });
});

describe('mcpRouterKey', () => {
  const baseArgs = (toolInput: unknown) => ({
    toolName: 'mcp__super-mcp-router__use_tool',
    effectiveToolId: 'send_message',
    packageId: 'PkgA',
    toolInput,
  });

  it('produces same key when args object is reordered', () => {
    const a = baseArgs({
      package_id: 'PkgA',
      tool_id: 'send_message',
      args: { channel: 'C1', text: 'hello' },
    });
    const b = baseArgs({
      tool_id: 'send_message',
      args: { text: 'hello', channel: 'C1' },
      package_id: 'PkgA',
    });
    expect(mcpRouterKey(a)).toBe(mcpRouterKey(b));
  });

  it('strips _rebel_staged_id volatile field', () => {
    const a = baseArgs({
      package_id: 'PkgA',
      tool_id: 'send_message',
      args: { channel: 'C1', text: 'hello' },
    });
    const b = baseArgs({
      package_id: 'PkgA',
      tool_id: 'send_message',
      args: { channel: 'C1', text: 'hello' },
      _rebel_staged_id: 'staged-123',
    });
    expect(mcpRouterKey(a)).toBe(mcpRouterKey(b));
  });
});

describe('imageGenKey', () => {
  it('same prompt + same model + same size → same key', () => {
    const a = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'a sunset over the ocean', model: 'dall-e-3', size: '1024x1024' },
    });
    const b = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'a sunset over the ocean', model: 'dall-e-3', size: '1024x1024' },
    });
    expect(a).toBe(b);
  });

  it('different prompt → different key', () => {
    const a = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'a sunset', model: 'dall-e-3' },
    });
    const b = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'a sunrise', model: 'dall-e-3' },
    });
    expect(a).not.toBe(b);
  });

  it('different size → different key', () => {
    const a = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'sun', model: 'dall-e-3', size: '1024x1024' },
    });
    const b = imageGenKey({
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'sun', model: 'dall-e-3', size: '512x512' },
    });
    expect(a).not.toBe(b);
  });
});

describe('defaultKey', () => {
  it('uses canonical args hash so reordered args hash the same', () => {
    const a = defaultKey('SomeUnknownTool', { x: 1, y: 2 });
    const b = defaultKey('SomeUnknownTool', { y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

describe('buildNormalizedToolKey dispatcher', () => {
  it('returns null for Read', () => {
    expect(
      buildNormalizedToolKey({
        toolName: 'Read',
        effectiveToolId: 'Read',
        packageId: undefined,
        toolInput: { path: '/x' },
      }),
    ).toBeNull();
  });

  it('returns null for Grep', () => {
    expect(
      buildNormalizedToolKey({
        toolName: 'Grep',
        effectiveToolId: 'Grep',
        packageId: undefined,
        toolInput: { pattern: 'foo' },
      }),
    ).toBeNull();
  });

  it('returns null for Glob', () => {
    expect(
      buildNormalizedToolKey({
        toolName: 'Glob',
        effectiveToolId: 'Glob',
        packageId: undefined,
        toolInput: { pattern: '**/*.ts' },
      }),
    ).toBeNull();
  });

  it('returns null for SearchFiles', () => {
    expect(
      buildNormalizedToolKey({
        toolName: 'SearchFiles',
        effectiveToolId: 'SearchFiles',
        packageId: undefined,
        toolInput: { query: 'TODO' },
      }),
    ).toBeNull();
  });

  it('routes Bash to bashKey', () => {
    const k = buildNormalizedToolKey({
      toolName: 'Bash',
      effectiveToolId: 'Bash',
      packageId: undefined,
      toolInput: { command: 'ls', cwd: '/x' },
    });
    expect(k).toBeTruthy();
    expect(k).toBe(bashKey('Bash', { command: 'ls', cwd: '/x' }));
  });

  it.each([
    ['Edit'],
    ['Write'],
    ['Create'],
    ['str_replace_editor'],
    ['write_file'],
    ['create_file'],
  ])('returns null for %s (file writes always re-evaluate)', (toolName) => {
    expect(
      buildNormalizedToolKey({
        toolName,
        effectiveToolId: toolName,
        packageId: undefined,
        toolInput: { file_path: '/x/y.md', new_string: 'hello' },
      }),
    ).toBeNull();
  });

  it('routes OpenAI image gen to imageGenKey', () => {
    const args = {
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: { prompt: 'sun', model: 'dall-e-3' },
    };
    expect(buildNormalizedToolKey(args)).toBe(imageGenKey(args));
  });

  it('falls through to mcpRouterKey for router calls without family match', () => {
    const args = {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'unknown_action',
      packageId: 'SomePkg',
      toolInput: { tool_id: 'unknown_action', package_id: 'SomePkg', args: { foo: 1 } },
    };
    expect(buildNormalizedToolKey(args)).toBe(mcpRouterKey(args));
  });

  it('falls through to defaultKey for unknown direct tool', () => {
    const k = buildNormalizedToolKey({
      toolName: 'SomeMystery',
      effectiveToolId: 'SomeMystery',
      packageId: undefined,
      toolInput: { x: 1 },
    });
    expect(k).toBe(defaultKey('SomeMystery', { x: 1 }));
  });
});
