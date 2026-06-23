import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../types';

type RegistryModule = typeof import('../pluginContextRegistry');

let registerPluginContext: RegistryModule['registerPluginContext'];
let getPluginContexts: RegistryModule['getPluginContexts'];

beforeEach(async () => {
  vi.resetModules();
  const registry = await import('../pluginContextRegistry');
  registerPluginContext = registry.registerPluginContext;
  getPluginContexts = registry.getPluginContexts;
});

describe('pluginContextRegistry', () => {
  it('returns an empty list when nothing is registered', () => {
    expect(getPluginContexts()).toEqual([]);
  });

  it('registers and unregisters plugin context providers', () => {
    const unregister = registerPluginContext(
      'meeting-prep',
      'Meeting Prep',
      () => 'Bring up attendee notes and open tasks.',
      0,
    );

    expect(getPluginContexts()).toEqual<PluginContext[]>([
      {
        pluginId: 'meeting-prep',
        pluginName: 'Meeting Prep',
        content: 'Bring up attendee notes and open tasks.',
        priority: 0,
      },
    ]);

    unregister();
    expect(getPluginContexts()).toEqual([]);
  });

  it('ignores null/blank/throwing providers', () => {
    registerPluginContext('null-provider', 'Null Provider', () => null, 0);
    registerPluginContext('blank-provider', 'Blank Provider', () => '   ', 0);
    registerPluginContext('throws-provider', 'Throws Provider', () => {
      throw new Error('boom');
    }, 0);

    expect(getPluginContexts()).toEqual([]);
  });

  it('sorts contexts by priority (higher priority appears later)', () => {
    registerPluginContext('high', 'High', () => 'high', 10);
    registerPluginContext('low', 'Low', () => 'low', -5);
    registerPluginContext('mid', 'Mid', () => 'mid', 0);

    const contexts = getPluginContexts();
    expect(contexts.map((context) => context.pluginId)).toEqual(['low', 'mid', 'high']);
  });

  it('caps each plugin context at 2000 characters', () => {
    registerPluginContext('long', 'Long Context', () => 'x'.repeat(2_500), 0);

    const [context] = getPluginContexts();
    expect(context.content).toHaveLength(2_000);
  });

  it('caps total context at 5000 characters by trimming lowest priority first', () => {
    registerPluginContext('low', 'Low Priority', () => 'a'.repeat(2_000), -10);
    registerPluginContext('mid', 'Mid Priority', () => 'b'.repeat(2_000), 0);
    registerPluginContext('high', 'High Priority', () => 'c'.repeat(2_000), 10);

    const contexts = getPluginContexts();
    const totalLength = contexts.reduce((sum, context) => sum + context.content.length, 0);

    expect(totalLength).toBe(5_000);
    expect(contexts.map((context) => [context.pluginId, context.content.length])).toEqual([
      ['low', 1_000],
      ['mid', 2_000],
      ['high', 2_000],
    ]);
  });
});
