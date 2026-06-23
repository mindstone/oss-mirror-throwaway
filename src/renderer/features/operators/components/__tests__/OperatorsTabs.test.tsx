// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorsTabs } from '../OperatorsTabs';

describe('OperatorsTabs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('renders both tabs with counts and dispatches onValueChange', async () => {
    const onValueChange = vi.fn();
    await act(async () => {
      root.render(
        <OperatorsTabs
          value="operators"
          onValueChange={onValueChange}
          operatorsCount={4}
          liveCoachesCount={2}
        />,
      );
    });

    const operatorsTrigger = container.querySelector('[data-testid="operators-tab-trigger"]');
    const liveCoachesTrigger = container.querySelector('[data-testid="live-coaches-tab-trigger"]');
    expect(operatorsTrigger?.textContent).toContain('Operators');
    expect(operatorsTrigger?.textContent).toContain('4');
    expect(liveCoachesTrigger?.textContent).toContain('Live coaches');
    expect(liveCoachesTrigger?.textContent).toContain('2');

    await act(async () => {
      liveCoachesTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith('live-coaches');
  });
});
