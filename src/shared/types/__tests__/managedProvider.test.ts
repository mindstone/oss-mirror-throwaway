import { describe, expect, it } from 'vitest';
import {
  diffDefaultModels,
  getManagedAllowListState,
  getManagedAllowedModelIds,
  isManagedRouteUsable,
  type ManagedDefaultModels,
} from '../managedProvider';
import type { ActiveProvider } from '../settings';

describe('getManagedAllowedModelIds', () => {
  it('returns empty array when defaultModels is undefined', () => {
    expect(getManagedAllowedModelIds(undefined)).toEqual([]);
    expect(getManagedAllowedModelIds(null)).toEqual([]);
    expect(getManagedAllowedModelIds({ defaultModels: undefined })).toEqual([]);
  });

  it('returns populated entries only', () => {
    expect(
      getManagedAllowedModelIds({
        defaultModels: { working: 'm-a', thinking: 'm-b', bts: 'm-c' },
      }),
    ).toEqual(['m-a', 'm-b', 'm-c']);
  });

  it('dedupes when multiple roles share a model', () => {
    expect(
      getManagedAllowedModelIds({
        defaultModels: { working: 'm-a', thinking: 'm-a', bts: 'm-c' },
      }),
    ).toEqual(['m-a', 'm-c']);
  });
});

describe('getManagedAllowListState', () => {
  it('returns unavailable when managed provider payload is missing', () => {
    expect(getManagedAllowListState(undefined)).toEqual({ kind: 'unavailable' });
    expect(getManagedAllowListState(null)).toEqual({ kind: 'unavailable' });
  });

  it('returns empty when payload is present but no model ids are populated', () => {
    expect(
      getManagedAllowListState({ defaultModels: undefined }),
    ).toEqual({ kind: 'empty' });
    expect(
      getManagedAllowListState({ defaultModels: {} }),
    ).toEqual({ kind: 'empty' });
  });

  it('returns ready with unique allow-list ids when defaults are populated', () => {
    expect(
      getManagedAllowListState({
        defaultModels: { working: 'm-a', thinking: 'm-a', bts: 'm-b' },
      }),
    ).toEqual({ kind: 'ready', allowed: ['m-a', 'm-b'] });
  });
});

describe('diffDefaultModels', () => {
  it('returns empty added/removed when both inputs are undefined', () => {
    expect(diffDefaultModels(undefined, undefined)).toEqual({ added: [], removed: [] });
  });

  it('treats prev undefined as initial population (everything is added)', () => {
    const next: ManagedDefaultModels = { working: 'm-a', thinking: 'm-b' };
    expect(diffDefaultModels(undefined, next)).toEqual({
      added: ['m-a', 'm-b'],
      removed: [],
    });
  });

  it('treats next undefined as full removal', () => {
    const prev: ManagedDefaultModels = { working: 'm-a', bts: 'm-c' };
    expect(diffDefaultModels(prev, undefined)).toEqual({
      added: [],
      removed: ['m-a', 'm-c'],
    });
  });

  it('returns empty diff when prev and next are identical', () => {
    const snapshot: ManagedDefaultModels = { working: 'm-a', thinking: 'm-b', bts: 'm-c' };
    expect(diffDefaultModels(snapshot, snapshot)).toEqual({ added: [], removed: [] });
  });

  it('detects added entries only', () => {
    expect(
      diffDefaultModels(
        { working: 'm-a' },
        { working: 'm-a', thinking: 'm-b' },
      ),
    ).toEqual({ added: ['m-b'], removed: [] });
  });

  it('detects removed entries only', () => {
    expect(
      diffDefaultModels(
        { working: 'm-a', thinking: 'm-b' },
        { working: 'm-a' },
      ),
    ).toEqual({ added: [], removed: ['m-b'] });
  });

  it('detects swap as added+removed', () => {
    expect(
      diffDefaultModels(
        { working: 'm-a', thinking: 'm-b' },
        { working: 'm-x', thinking: 'm-b' },
      ),
    ).toEqual({ added: ['m-x'], removed: ['m-a'] });
  });

  it('treats role-swap of identical model as no-op', () => {
    // Model id "m-a" still appears in the dedupe'd set even when its role moves.
    expect(
      diffDefaultModels(
        { working: 'm-a', thinking: 'm-b' },
        { working: 'm-b', thinking: 'm-a' },
      ),
    ).toEqual({ added: [], removed: [] });
  });

  it('dedupes shared model IDs across roles in added and removed', () => {
    expect(
      diffDefaultModels(
        { working: 'm-a', thinking: 'm-a', bts: 'm-b' },
        { working: 'm-c', thinking: 'm-c', bts: 'm-b' },
      ),
    ).toEqual({ added: ['m-c'], removed: ['m-a'] });
  });

  it('treats empty defaults as undefined-equivalent', () => {
    expect(diffDefaultModels({}, {})).toEqual({ added: [], removed: [] });
    expect(diffDefaultModels({}, { working: 'm-a' })).toEqual({
      added: ['m-a'],
      removed: [],
    });
    expect(diffDefaultModels({ working: 'm-a' }, {})).toEqual({
      added: [],
      removed: ['m-a'],
    });
  });
});

// Stage 4 (DECISION A): the shared managed-AVAILABILITY predicate is the single
// swap-point the smart-model-routing plan's Stage 1 will widen to per-managed-key.
// TODAY it MUST be byte-identical to the inlined literal `activeProvider === 'mindstone'`.
describe('isManagedRouteUsable (managed-availability predicate)', () => {
  it('is true ONLY for activeProvider mindstone (byte-identical to the inlined literal)', () => {
    expect(isManagedRouteUsable({ activeProvider: 'mindstone' })).toBe(true);
  });

  it('is false for every other ActiveProvider and undefined', () => {
    const others: (ActiveProvider | undefined)[] = [
      'anthropic',
      'openrouter',
      'codex',
      undefined,
    ];
    for (const activeProvider of others) {
      expect(isManagedRouteUsable({ activeProvider })).toBe(false);
    }
  });
});
