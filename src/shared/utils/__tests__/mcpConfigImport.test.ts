import { describe, it, expect } from 'vitest';
import { extractServerConfig } from '../mcpConfigImport';

describe('mcpConfigImport', () => {
  describe('extractServerConfig', () => {
    describe('size limits', () => {
      it('should reject configs larger than 10KB', () => {
        // Create a string larger than 10KB
        const largeConfig = JSON.stringify({
          command: 'npx',
          args: ['-y', '@test/server'],
          env: { LARGE_VALUE: 'x'.repeat(15000) }
        });

        const result = extractServerConfig(largeConfig);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Config too large (max 10KB)');
      });

      it('should accept configs under 10KB', () => {
        const validConfig = JSON.stringify({
          command: 'npx',
          args: ['-y', '@test/server']
        });

        const result = extractServerConfig(validConfig);

        expect(result.errors).toHaveLength(0);
        expect(result.config).not.toBeNull();
      });
    });

    describe('JSON parsing', () => {
      it('should return error for invalid JSON', () => {
        const result = extractServerConfig('{ not valid json }');

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toMatch(/^Invalid JSON:/);
      });

      it('should return error for truncated JSON', () => {
        const result = extractServerConfig('{ "command": "npx"');

        expect(result.format).toBe('unknown');
        expect(result.errors[0]).toMatch(/^Invalid JSON:/);
      });

      it('should return error for non-object values', () => {
        const result = extractServerConfig('"just a string"');

        expect(result.format).toBe('unknown');
        expect(result.errors).toContain('Config must be a JSON object');
      });
    });

    describe('standard format', () => {
      it('should detect standard format with command only', () => {
        const input = JSON.stringify({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-example']
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('standard');
        expect(result.config).toEqual({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-example']
        });
        expect(result.extractedName).toBeNull();
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
      });

      it('should detect standard format with url only', () => {
        const input = JSON.stringify({
          url: 'https://mcp.example.com/sse'
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('standard');
        expect(result.config).toEqual({
          url: 'https://mcp.example.com/sse'
        });
        expect(result.errors).toHaveLength(0);
      });

      it('should warn when both command and url are present', () => {
        const input = JSON.stringify({
          command: 'npx',
          args: ['-y', '@test/server'],
          url: 'https://example.com/sse'
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('standard');
        expect(result.config).not.toBeNull();
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toContain(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      });

      it('should include all fields in extracted config', () => {
        const input = JSON.stringify({
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'secret' },
          cwd: '/path/to/server'
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('standard');
        expect(result.config).toEqual({
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'secret' },
          cwd: '/path/to/server'
        });
      });
    });

    describe('keyed format', () => {
      it('should detect keyed format with command', () => {
        const input = JSON.stringify({
          'my-server': {
            command: 'npx',
            args: ['-y', '@test/server']
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('keyed');
        expect(result.config).toEqual({
          command: 'npx',
          args: ['-y', '@test/server']
        });
        expect(result.extractedName).toBe('my-server');
        expect(result.errors).toHaveLength(0);
      });

      it('should detect keyed format with url', () => {
        const input = JSON.stringify({
          'remote-api': {
            url: 'https://api.example.com/mcp'
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('keyed');
        expect(result.extractedName).toBe('remote-api');
        expect(result.config?.url).toBe('https://api.example.com/mcp');
      });

      it('should warn when keyed format has both command and url', () => {
        const input = JSON.stringify({
          'my-server': {
            command: 'npx',
            url: 'https://example.com'
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('keyed');
        expect(result.warnings).toContain(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      });
    });

    describe('Claude Desktop format', () => {
      it('should detect Claude Desktop format with single server', () => {
        const input = JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem']
            }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('claude-desktop');
        expect(result.config).toEqual({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem']
        });
        expect(result.extractedName).toBe('filesystem');
        expect(result.errors).toHaveLength(0);
      });

      it('should error when Claude Desktop format has multiple servers', () => {
        const input = JSON.stringify({
          mcpServers: {
            'server-1': { command: 'npx', args: ['server1'] },
            'server-2': { command: 'npx', args: ['server2'] }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('claude-desktop');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Multiple servers found. Paste a single server config.');
      });

      it('should error when Claude Desktop mcpServers is empty', () => {
        const input = JSON.stringify({
          mcpServers: {}
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('claude-desktop');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('No servers found in container');
      });

      it('should warn when Claude Desktop config has both command and url', () => {
        const input = JSON.stringify({
          mcpServers: {
            hybrid: {
              command: 'npx',
              url: 'https://example.com'
            }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('claude-desktop');
        expect(result.warnings).toContain(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      });
    });

    describe('wrapper formats', () => {
      it('should detect mcp_servers wrapper format', () => {
        const input = JSON.stringify({
          mcp_servers: {
            'my-server': {
              command: 'python',
              args: ['server.py']
            }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('wrapper');
        expect(result.extractedName).toBe('my-server');
        expect(result.config?.command).toBe('python');
      });

      it('should detect servers wrapper format', () => {
        const input = JSON.stringify({
          servers: {
            test: {
              url: 'https://test.example.com'
            }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('wrapper');
        expect(result.extractedName).toBe('test');
      });

      it('should detect upstreamServers wrapper format', () => {
        const input = JSON.stringify({
          upstreamServers: {
            upstream: {
              command: 'node',
              args: ['upstream.js']
            }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('wrapper');
        expect(result.extractedName).toBe('upstream');
      });

      it('should error when wrapper has multiple servers', () => {
        const input = JSON.stringify({
          mcp_servers: {
            one: { command: 'a' },
            two: { command: 'b' }
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('wrapper');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Multiple servers found. Paste a single server config.');
      });
    });

    describe('array format', () => {
      it('should detect array format with name field', () => {
        const input = JSON.stringify([
          {
            name: 'array-server',
            command: 'npx',
            args: ['-y', '@test/server']
          }
        ]);

        const result = extractServerConfig(input);

        expect(result.format).toBe('array');
        expect(result.config).toEqual({
          name: 'array-server',
          command: 'npx',
          args: ['-y', '@test/server']
        });
        expect(result.extractedName).toBe('array-server');
        expect(result.errors).toHaveLength(0);
      });

      it('should detect array format without name field', () => {
        const input = JSON.stringify([
          {
            command: 'npx',
            args: ['-y', '@test/server']
          }
        ]);

        const result = extractServerConfig(input);

        expect(result.format).toBe('array');
        expect(result.config?.command).toBe('npx');
        expect(result.extractedName).toBeNull();
      });

      it('should error on empty array', () => {
        const result = extractServerConfig('[]');

        expect(result.format).toBe('array');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Empty array');
      });

      it('should error when array has multiple items', () => {
        const input = JSON.stringify([
          { command: 'npx', args: ['server1'] },
          { command: 'npx', args: ['server2'] }
        ]);

        const result = extractServerConfig(input);

        expect(result.format).toBe('array');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Multiple servers found. Paste a single server config.');
      });

      it('should error when array item is not an object', () => {
        const result = extractServerConfig('["not an object"]');

        expect(result.format).toBe('array');
        expect(result.config).toBeNull();
        expect(result.errors).toContain('Array item must be an object');
      });

      it('should error when array item has no command/url', () => {
        const input = JSON.stringify([{ name: 'test', description: 'missing command' }]);

        const result = extractServerConfig(input);

        expect(result.format).toBe('array');
        expect(result.config).toBeNull();
        expect(result.errors).toContain(
          "Could not detect config format. Expected 'command' for local servers or 'url' for remote."
        );
      });

      it('should warn when array item has both command and url', () => {
        const input = JSON.stringify([
          {
            name: 'hybrid',
            command: 'npx',
            url: 'https://example.com'
          }
        ]);

        const result = extractServerConfig(input);

        expect(result.format).toBe('array');
        expect(result.warnings).toContain(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      });
    });

    describe('unknown format', () => {
      it('should return unknown when no command or url present', () => {
        const input = JSON.stringify({
          name: 'incomplete-server',
          description: 'Missing command and url'
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
        expect(result.errors).toContain(
          "Could not detect config format. Expected 'command' for local servers or 'url' for remote."
        );
      });

      it('should return unknown for object with multiple non-server keys', () => {
        const input = JSON.stringify({
          key1: { foo: 'bar' },
          key2: { baz: 'qux' }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
      });

      it('should return unknown when single key value is not a server config', () => {
        const input = JSON.stringify({
          'some-key': {
            notCommand: 'npx',
            notUrl: 'https://example.com'
          }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should handle empty command string as invalid', () => {
        const input = JSON.stringify({
          command: '',
          args: ['test']
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
      });

      it('should handle empty url string as invalid', () => {
        const input = JSON.stringify({
          url: ''
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
      });

      it('should handle whitespace-only strings', () => {
        const result = extractServerConfig('   ');

        expect(result.format).toBe('unknown');
        expect(result.errors[0]).toMatch(/^Invalid JSON:/);
      });

      it('should handle numeric values in wrong places', () => {
        const input = JSON.stringify({
          command: 123 // number instead of string
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('unknown');
        expect(result.config).toBeNull();
      });

      it('should preserve extra fields in extracted config', () => {
        const input = JSON.stringify({
          command: 'npx',
          args: ['-y', '@test/server'],
          customField: 'preserved',
          nested: { data: 'also preserved' }
        });

        const result = extractServerConfig(input);

        expect(result.format).toBe('standard');
        expect(result.config?.customField).toBe('preserved');
        expect((result.config?.nested as Record<string, unknown>)?.data).toBe('also preserved');
      });
    });
  });
});
