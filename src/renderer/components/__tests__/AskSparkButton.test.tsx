// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AskSparkButton, ASK_SPARK_OPTIONS } from '../AskSparkButton';

describe('AskSparkButton', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
  });

  it('renders the button', async () => {
    await act(async () => {
      root?.render(
        <AskSparkButton
          isOnline={true}
          isPulsing={false}
          rateLimited={false}
          onSubmit={vi.fn()}
        />
      );
    });
    const btn = container?.querySelector('button');
    expect(btn?.textContent).toContain('Ask Spark');
  });

  it('opens the picker when clicked and allows selecting an option', async () => {
    const handleSubmit = vi.fn();
    await act(async () => {
      root?.render(
        <AskSparkButton
          isOnline={true}
          isPulsing={false}
          rateLimited={false}
          onSubmit={handleSubmit}
        />
      );
    });
    
    // Open picker
    const btn = container?.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    
    // Select the first option
    // Since floating-ui uses portals, it renders outside the container
    const portalOption = document.querySelector('.ask-spark-picker__option') as HTMLButtonElement;
    expect(portalOption).not.toBeNull();
    expect(portalOption.textContent).toContain(ASK_SPARK_OPTIONS[0].label);

    await act(async () => {
      portalOption.click();
    });

    // Verify callback
    expect(handleSubmit).toHaveBeenCalledWith(
      ASK_SPARK_OPTIONS[0].prompt,
      ASK_SPARK_OPTIONS[0].label
    );
  });

  it('displays the offline subtitle when offline', async () => {
    await act(async () => {
      root?.render(
        <AskSparkButton
          isOnline={false}
          isPulsing={false}
          rateLimited={false}
          onSubmit={vi.fn()}
        />
      );
    });
    
    const btn = container?.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    
    const subtitle = document.querySelector('.ask-spark-picker__subtitle');
    expect(subtitle?.textContent).toBe('Pick a question. Spark will answer when reconnected.');
  });
});
