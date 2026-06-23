/**
 * Unit tests for MCP Apps IPC handler utilities.
 *
 * Tests pure functions (extractSourcePackageId, normalizeScopedToolId)
 * and the tool allowlist enforcement logic.
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  extractSourcePackageId,
  normalizeScopedToolId,
} from '../mcpAppsHandlers';
import { mcpAppsChannels } from '@shared/ipc/channels/mcpApps';

// ---------------------------------------------------------------------------
// extractSourcePackageId
// ---------------------------------------------------------------------------

describe('extractSourcePackageId', () => {
  it('returns direct package ID as-is', () => {
    expect(extractSourcePackageId('google-workspace')).toBe('google-workspace');
  });

  it('extracts hostname from ui:// URI', () => {
    expect(extractSourcePackageId('ui://google-workspace/compose-email')).toBe('google-workspace');
  });

  it('extracts hostname from ui:// URI with .html path', () => {
    expect(extractSourcePackageId('ui://google-workspace/compose-email.html')).toBe('google-workspace');
  });

  it('handles ui:// URI with nested path', () => {
    expect(extractSourcePackageId('ui://my-app/v2/dashboard')).toBe('my-app');
  });

  it('returns null for empty string', () => {
    expect(extractSourcePackageId('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(extractSourcePackageId('   ')).toBeNull();
  });

  it('trims whitespace from direct package ID', () => {
    expect(extractSourcePackageId('  google-workspace  ')).toBe('google-workspace');
  });

  it('returns null for ui:// with no hostname', () => {
    expect(extractSourcePackageId('ui://')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeScopedToolId
// ---------------------------------------------------------------------------

describe('normalizeScopedToolId', () => {
  it('returns bare tool name unchanged', () => {
    expect(normalizeScopedToolId('send_workspace_email', 'google-workspace')).toEqual({
      toolId: 'send_workspace_email',
    });
  });

  it('strips matching package prefix', () => {
    expect(
      normalizeScopedToolId('google-workspace__send_workspace_email', 'google-workspace'),
    ).toEqual({ toolId: 'send_workspace_email' });
  });

  it('rejects cross-package tool name', () => {
    const result = normalizeScopedToolId('other-package__dangerous_tool', 'google-workspace');
    expect(result.error).toMatch(/outside source package scope/);
    expect(result.toolId).toBeUndefined();
  });

  it('returns error for empty tool name', () => {
    const result = normalizeScopedToolId('', 'google-workspace');
    expect(result.error).toBe('Tool name is required');
  });

  it('returns error for whitespace-only tool name', () => {
    const result = normalizeScopedToolId('   ', 'google-workspace');
    expect(result.error).toBe('Tool name is required');
  });

  it('returns error for package prefix with empty tool ID', () => {
    const result = normalizeScopedToolId('google-workspace__', 'google-workspace');
    expect(result.error).toBe('Invalid namespaced tool name');
  });

  it('handles double underscore in tool name (no package prefix)', () => {
    // Tool name itself contains __ but doesn't start with a known package
    // The first segment matches sourcePackageId, so it's treated as a prefix
    const result = normalizeScopedToolId('google-workspace__nested__tool', 'google-workspace');
    expect(result.toolId).toBe('nested__tool');
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation: mcp:call-tool
// ---------------------------------------------------------------------------

describe('mcp:call-tool Zod schema', () => {
  const schema = mcpAppsChannels['mcp:call-tool'].request;

  it('accepts appFamily + optional sourcePackageId', () => {
    const result = schema.parse({
      appFamily: 'google-workspace',
      sourcePackageId: 'GoogleWorkspace-greg',
      toolUseId: 'tool-1',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      iframeInstanceId: 'iframe-1',
      nonce: 'nonce-1',
      toolName: 'send_workspace_email',
      args: { to: 'user@example.com' },
    });
    expect(result.appFamily).toBe('google-workspace');
    expect(result.sourcePackageId).toBe('GoogleWorkspace-greg');
  });

  it('rejects appFamily without trust fields', () => {
    expect(() => schema.parse({
      appFamily: 'google-workspace',
      toolName: 'send_workspace_email',
      args: {},
    })).toThrow(ZodError);
  });

  it('rejects missing appFamily', () => {
    expect(() =>
      schema.parse({
        toolName: 'send_workspace_email',
        args: {},
      }),
    ).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation: mcp:read-resource
// ---------------------------------------------------------------------------

describe('mcp:read-resource Zod schema', () => {
  const schema = mcpAppsChannels['mcp:read-resource'].request;

  it('accepts uri + sourcePackageId', () => {
    const result = schema.parse({
      uri: 'ui://google-workspace/compose-email',
      sourcePackageId: 'GoogleWorkspace-greg',
    });
    expect(result.uri).toBe('ui://google-workspace/compose-email');
    expect(result.sourcePackageId).toBe('GoogleWorkspace-greg');
  });

  it('accepts uri without sourcePackageId', () => {
    const result = schema.parse({
      uri: 'ui://google-workspace/compose-email',
    });
    expect(result.sourcePackageId).toBeUndefined();
  });
});
