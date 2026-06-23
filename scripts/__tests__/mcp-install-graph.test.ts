import { describe, expect, it } from 'vitest';
import { hasDependencyProblems } from '../mcp-test-harness';

describe('hasDependencyProblems', () => {
  it('returns false for a clean npm ls tree', () => {
    const cleanTree = {
      name: 'mcp-community-install',
      version: '1.0.0',
      dependencies: {
        '@example/server': {
          version: '1.2.3',
          resolved: 'https://registry.npmjs.org/@example/server/-/server-1.2.3.tgz',
          dependencies: {
            '@example/transitive': {
              version: '4.5.6',
            },
          },
        },
      },
    };

    expect(hasDependencyProblems(cleanTree)).toBe(false);
  });

  it('returns true when npm reports missing or invalid dependencies', () => {
    const brokenTree = {
      name: 'mcp-community-install',
      problems: [
        'missing: @hono/node-server@^1.19.9, required by @modelcontextprotocol/sdk@1.29.0',
      ],
      dependencies: {
        '@modelcontextprotocol/sdk': {
          version: '1.29.0',
          dependencies: {
            '@hono/node-server': {
              missing: true,
            },
          },
        },
        '@example/invalid': {
          invalid: true,
        },
      },
    };

    expect(hasDependencyProblems(brokenTree)).toBe(true);
  });

  it('returns true for legacy unmet-dependency markers in problem strings', () => {
    expect(hasDependencyProblems('UNMET DEPENDENCY @example/missing@1.0.0')).toBe(true);
  });
});
