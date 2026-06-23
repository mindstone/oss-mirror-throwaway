import { describe, expect, expectTypeOf, it } from 'vitest';
import type { useUnifiedConnections } from '../useUnifiedConnections';

type HookReturn = ReturnType<typeof useUnifiedConnections>;

describe('useUnifiedConnections type surface', () => {
  it('compiles without accountTabs/accountFilter on the hook return type', () => {
    // @ts-expect-error - accountTabs should have been removed from the hook return shape
    expectTypeOf<HookReturn['accountTabs']>();
    // @ts-expect-error - accountFilter should have been removed from the hook return shape
    expectTypeOf<HookReturn['accountFilter']>();
    expect(true).toBe(true);
  });
});
