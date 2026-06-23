import { describe, it, expect } from 'vitest';
import { validateMcpServerEntry } from '../mcpConfigManager';

/**
 * Tests for validateMcpServerEntry() - mirrors Super-MCP's validation rules.
 * 
 * These tests verify that Rebel's pre-validation matches Super-MCP's behavior.
 * See: super-mcp/src/registry.ts - validatePackageFields()
 */
describe('validateMcpServerEntry', () => {
  describe('entry type validation', () => {
    it('rejects null entry', () => {
      const result = validateMcpServerEntry(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Entry must be a non-null object');
    });

    it('rejects undefined entry', () => {
      const result = validateMcpServerEntry(undefined);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Entry must be a non-null object');
    });
  });

  describe('name validation', () => {
    it('accepts valid name in entry', () => {
      const result = validateMcpServerEntry({ name: 'test-server', command: 'npx' });
      expect(result.valid).toBe(true);
    });

    it('accepts serverKey as fallback for name', () => {
      const result = validateMcpServerEntry({ command: 'npx' }, 'server-key');
      expect(result.valid).toBe(true);
    });

    it('prefers entry.name over serverKey', () => {
      const result = validateMcpServerEntry({ name: 'from-entry', command: 'npx' }, 'from-key');
      expect(result.valid).toBe(true);
    });

    it('rejects missing name when no serverKey', () => {
      const result = validateMcpServerEntry({ command: 'npx' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('name is required and must be a non-empty string');
    });

    it('rejects empty string name', () => {
      const result = validateMcpServerEntry({ name: '', command: 'npx' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('name is required and must be a non-empty string');
    });

    it('rejects whitespace-only name', () => {
      const result = validateMcpServerEntry({ name: '   ', command: 'npx' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('name is required and must be a non-empty string');
    });

    it('rejects non-string name', () => {
      const result = validateMcpServerEntry({ name: 123, command: 'npx' } as any);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('name is required and must be a non-empty string');
    });
  });

  describe('stdio transport validation', () => {
    it('accepts valid stdio config with command', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', args: ['mcp-server'] },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts stdio with explicit type', () => {
      const result = validateMcpServerEntry(
        { type: 'stdio', command: 'node', args: ['server.js'] },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('rejects stdio without command', () => {
      const result = validateMcpServerEntry(
        { type: 'stdio' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('command is required and must be a non-empty string for stdio transport');
    });

    it('rejects stdio with empty command', () => {
      const result = validateMcpServerEntry(
        { command: '' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('command is required and must be a non-empty string for stdio transport');
    });

    it('rejects stdio with whitespace-only command', () => {
      const result = validateMcpServerEntry(
        { command: '   ' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('command is required and must be a non-empty string for stdio transport');
    });

    it('rejects stdio with non-string command', () => {
      const result = validateMcpServerEntry(
        { command: 123 } as any,
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('command is required and must be a non-empty string for stdio transport');
    });
  });

  describe('http transport validation', () => {
    it('accepts valid http config with url', () => {
      const result = validateMcpServerEntry(
        { url: 'https://api.example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts http with explicit type', () => {
      const result = validateMcpServerEntry(
        { type: 'http', url: 'https://api.example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts sse type as http transport', () => {
      const result = validateMcpServerEntry(
        { type: 'sse', url: 'https://api.example.com/events' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts https type as http transport', () => {
      const result = validateMcpServerEntry(
        { type: 'https', url: 'https://api.example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts rest type as http transport', () => {
      const result = validateMcpServerEntry(
        { type: 'rest', url: 'https://api.example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts streamable type as http transport', () => {
      const result = validateMcpServerEntry(
        { type: 'streamable', url: 'https://api.example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('rejects http without url', () => {
      const result = validateMcpServerEntry(
        { type: 'http' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url is required and must be a non-empty string for http transport');
    });

    it('rejects http with empty url', () => {
      const result = validateMcpServerEntry(
        { type: 'http', url: '' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url is required and must be a non-empty string for http transport');
    });

    it('rejects http with whitespace-only url', () => {
      const result = validateMcpServerEntry(
        { type: 'http', url: '   ' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url is required and must be a non-empty string for http transport');
    });

    it('rejects http with invalid url format', () => {
      const result = validateMcpServerEntry(
        { url: 'not-a-valid-url' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url must be a valid URL, got "not-a-valid-url"');
    });

    it('rejects http with non-string url', () => {
      const result = validateMcpServerEntry(
        { type: 'http', url: 123 } as any,
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url is required and must be a non-empty string for http transport');
    });
  });

  describe('transport inference', () => {
    it('infers stdio when only command is present', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', args: ['server'] },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('infers http when only url is present', () => {
      const result = validateMcpServerEntry(
        { url: 'https://example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('prefers http when both command and url are present', () => {
      // This matches Super-MCP's behavior where URL presence indicates HTTP transport
      const result = validateMcpServerEntry(
        { command: 'npx', url: 'https://example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('explicit type overrides inference', () => {
      // Even with command present, type=http means we need url
      const result = validateMcpServerEntry(
        { type: 'http', command: 'npx' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('url is required and must be a non-empty string for http transport');
    });

    it('type is case-insensitive', () => {
      const result = validateMcpServerEntry(
        { type: 'HTTP', url: 'https://example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('treats empty string url as no url (matching Super-MCP truthy check)', () => {
      // Super-MCP uses truthy checks: `if (extConfig.url)` - empty string is falsy
      // So { url: "", command: "npx" } should be treated as stdio, not http
      const result = validateMcpServerEntry(
        { url: '', command: 'npx' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('treats empty string command as no command for inference', () => {
      // Similarly, empty command should not trigger stdio inference
      const result = validateMcpServerEntry(
        { command: '', url: 'https://example.com/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('visibility validation', () => {
    it('accepts visibility="default"', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', visibility: 'default' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts visibility="hidden"', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', visibility: 'hidden' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts missing visibility', () => {
      const result = validateMcpServerEntry(
        { command: 'npx' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts null visibility (treated as not present)', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', visibility: null },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('rejects invalid visibility value', () => {
      const result = validateMcpServerEntry(
        { command: 'npx', visibility: 'visible' },
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('visibility must be "default" or "hidden", got "visible"');
    });
  });

  describe('edge cases', () => {
    it('handles entry missing both command and url', () => {
      const result = validateMcpServerEntry(
        {},
        'test-server'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('command is required and must be a non-empty string for stdio transport');
    });

    it('accepts complete stdio config with all optional fields', () => {
      const result = validateMcpServerEntry(
        {
          name: 'full-server',
          command: 'npx',
          args: ['mcp-server', '--port', '3000'],
          env: { API_KEY: 'secret' },
          cwd: '/path/to/dir',
          description: 'A test server',
          visibility: 'default'
        },
        'server-key'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts complete http config with all optional fields', () => {
      const result = validateMcpServerEntry(
        {
          name: 'http-server',
          type: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer token' },
          description: 'An HTTP server',
          visibility: 'hidden'
        },
        'server-key'
      );
      expect(result.valid).toBe(true);
    });

    it('validates localhost URLs', () => {
      const result = validateMcpServerEntry(
        { url: 'http://localhost:3000/mcp' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });

    it('validates URLs with ports', () => {
      const result = validateMcpServerEntry(
        { url: 'https://api.example.com:8443/mcp/v1' },
        'test-server'
      );
      expect(result.valid).toBe(true);
    });
  });
});
