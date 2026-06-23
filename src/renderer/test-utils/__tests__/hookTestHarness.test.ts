// @vitest-environment happy-dom
import React from 'react';
import { describe, expect, it } from 'vitest';

import { act, flushAsync, renderHook } from '../index';

describe('hookTestHarness', () => {
  it('renders hooks, updates via act, and flushes async work', async () => {
    const { result, unmount } = renderHook(() => React.useState(0));

    expect(result.current[0]).toBe(0);

    act(() => {
      result.current[1](1);
    });

    expect(result.current[0]).toBe(1);

    let resolved = false;
    Promise.resolve().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await flushAsync();
    expect(resolved).toBe(true);

    unmount();
  });
});
