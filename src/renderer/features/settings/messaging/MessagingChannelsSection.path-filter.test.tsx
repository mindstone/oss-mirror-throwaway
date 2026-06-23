// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { MessagingChannelsSection } from '../components/messaging/MessagingChannelsSection';
import type { UseSlackCloudConnectionResult } from '../hooks/useSlackCloudConnection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function connection(): UseSlackCloudConnectionResult {
  return {
    status: 'disconnected',
    workspace: null,
    error: null,
    connect: vi.fn().mockResolvedValue(undefined),
    connectByok: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe('settings/messaging path-filter smoke', () => {
  it('renders the Messaging section for the acceptance command path filter', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MessagingChannelsSection
          connectSlackCardProps={{
            connection: connection(),
            localFallback: { enabled: false, onToggle: vi.fn() },
            cloudStatus: 'running',
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Messaging');
    expect(container.textContent).toContain('Who can message Rebel');
    expect(container.querySelector('[data-section="who-can-message-rebel"]')).not.toBeNull();
    expect(container.querySelector('[data-section="recent-message-attempts"]')).not.toBeNull();
    expect(container.textContent).toContain('Telegram');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
