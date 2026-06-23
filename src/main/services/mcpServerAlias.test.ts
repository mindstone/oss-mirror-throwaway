import { describe, it, expect } from 'vitest';
import { aliasMcpServersForClaudeSdk } from './mcpServerAlias';

describe('aliasMcpServersForClaudeSdk', () => {
  it('returns original object when no aliasing is needed', () => {
    const servers = {
      Slack: { type: 'stdio', command: 'node', args: ['server.js'] },
      GoogleWorkspace: { type: 'stdio', command: 'node', args: ['server.js'] },
    } as any;

    const result = aliasMcpServersForClaudeSdk(servers);
    expect(result.aliasMap).toEqual({});
    expect(result.servers).toBe(servers);
  });

  it('aliases long server IDs deterministically and within the limit', () => {
    const longId = `GoogleWorkspace-${'a'.repeat(200)}`;
    const servers = {
      [longId]: { type: 'stdio', command: 'node', args: ['server.js'] },
    } as any;

    const result1 = aliasMcpServersForClaudeSdk(servers);
    const result2 = aliasMcpServersForClaudeSdk(servers);

    expect(Object.keys(result1.servers ?? {})).toHaveLength(1);
    const aliasedId = Object.keys(result1.servers ?? {})[0];

    expect(aliasedId).not.toEqual(longId);
    expect(aliasedId.length).toBeLessThanOrEqual(64);
    expect(result1.aliasMap[longId]).toEqual(aliasedId);
    expect(result2.aliasMap[longId]).toEqual(aliasedId);
  });

  it('avoids key collisions when aliasing multiple long IDs', () => {
    const base = `GoogleWorkspace-${'b'.repeat(200)}`;
    const longId1 = `${base}-1`;
    const longId2 = `${base}-2`;

    const servers = {
      [longId1]: { type: 'stdio', command: 'node', args: ['server.js'] },
      [longId2]: { type: 'stdio', command: 'node', args: ['server.js'] },
    } as any;

    const result = aliasMcpServersForClaudeSdk(servers);
    const keys = Object.keys(result.servers ?? {});

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(result.aliasMap[longId1]).toBeDefined();
    expect(result.aliasMap[longId2]).toBeDefined();
    expect(result.aliasMap[longId1]).not.toEqual(result.aliasMap[longId2]);
  });
});
