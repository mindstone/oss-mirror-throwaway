// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { CommunitySharePreview } from '@shared/types';

vi.mock('../CommunityWinCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('lucide-react', () => ({
  X: (props: Record<string, unknown>) => React.createElement('svg', props),
  ExternalLink: (props: Record<string, unknown>) => React.createElement('svg', props),
  Copy: (props: Record<string, unknown>) => React.createElement('svg', props),
  ChevronRight: (props: Record<string, unknown>) => React.createElement('svg', props),
}));

vi.mock('@renderer/components/ui', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { CommunityWinCard } from '../CommunityWinCard';

function renderCard(onPreviewAndShare: () => Promise<CommunitySharePreview | null>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(CommunityWinCard, {
        eligibility: {
          sessionId: 'session-1',
          timeSavedMinutes: 360,
          timeSavedFormatted: '6.0h',
          impact: 'high',
          quip: 'Not bad.',
          evaluatedAt: Date.now(),
        },
        onPreviewAndShare,
        onOpenDiscourse: vi.fn(async () => undefined),
        onDismiss: vi.fn(),
        onOptOut: vi.fn(),
      }),
    );
  });

  return { container, root };
}

describe('CommunityWinCard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the humanized compose error instead of the generic fallback copy', async () => {
    const humanizedError =
      "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.";
    const { container } = renderCard(async () => {
      throw new Error(humanizedError);
    });

    const previewButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Preview & Share'),
    );

    await reactAct(async () => {
      previewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain(humanizedError);
    expect(container.textContent).not.toContain('Could not compose the post. Try again?');
  });
});
