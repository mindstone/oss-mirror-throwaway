// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionToolEvent } from '@rebel/cloud-client';
import { TurnToolActivity } from '../TurnToolActivity';

vi.mock('@rebel/cloud-client', () => {
  class MockCloudClientError extends Error {
    code?: string;

    constructor(message: string, code?: string) {
      super(message);
      this.name = 'CloudClientError';
      this.code = code;
    }
  }

  return {
    CloudClientError: MockCloudClientError,
    buildToolLabel: (toolName: string, _detail?: string) => ({
      label: toolName,
      shortDetail: undefined,
    }),
    mapImageRef: (
      ref: { assetId: string },
      sessionId: string,
      options: { thumb?: boolean } = {},
    ) => {
      const base =
        `https://cloud.example.com/api/sessions/${encodeURIComponent(sessionId)}` +
        `/assets/${encodeURIComponent(ref.assetId)}`;
      const url = options.thumb ? `${base}?thumb=1` : base;
      return {
        url,
        rnSource: { uri: url },
        ref,
      };
    },
  };
});

const makeRef = (
  assetId: string,
  uploadStatus?: 'pending' | 'uploaded' | 'missing',
): NonNullable<SessionToolEvent['imageRef']>[number] => ({
  assetId,
  mimeType: 'image/png',
  byteSize: 1024,
  ...(uploadStatus ? { uploadStatus } : {}),
});

const makeEvent = (overrides: Partial<SessionToolEvent> = {}): SessionToolEvent => ({
  type: 'tool',
  toolName: 'Screenshot',
  detail: 'Captured screenshot',
  stage: 'end',
  timestamp: 1_700_000_000_000,
  ...overrides,
});

function renderExpandedActivity(events: SessionToolEvent[]): void {
  render(
    <TurnToolActivity
      turnId="turn-1"
      events={events}
      owningSessionId="sess-abc"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Used 1 tool/i }));
}

describe('TurnToolActivity image refs', () => {
  it('renders ref-only events as cloud asset thumbnail URLs', () => {
    renderExpandedActivity([
      makeEvent({
        imageRef: [makeRef('asset-ref-only')],
      }),
    ]);

    const gallery = screen.getByTestId('tool-result-images');
    const image = within(gallery).getByRole('img', { name: 'Tool result 1' });
    expect(image.getAttribute('src')).toBe(
      'https://cloud.example.com/api/sessions/sess-abc/assets/asset-ref-only?thumb=1',
    );
  });

  it('renders mixed ref/legacy events with positional mapping preserved', () => {
    renderExpandedActivity([
      makeEvent({
        imageContent: [
          { type: 'image', data: 'legacy-covered-by-ref', mimeType: 'image/png' },
          { type: 'image', data: 'legacy-fallback', mimeType: 'image/png' },
        ],
        imageRef: [makeRef('asset-ref-mixed'), null],
      }),
    ]);

    const gallery = screen.getByTestId('tool-result-images');
    const images = within(gallery).getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toBe(
      'https://cloud.example.com/api/sessions/sess-abc/assets/asset-ref-mixed?thumb=1',
    );
    expect(images[1].getAttribute('src')).toBe('data:image/png;base64,legacy-fallback');
  });

  it('shows a loading tile for pending refs', () => {
    renderExpandedActivity([
      makeEvent({
        imageRef: [makeRef('asset-pending', 'pending')],
      }),
    ]);

    expect(screen.getByTestId('tool-result-image-loading')).toBeTruthy();
    expect(screen.getByText('Syncing image…')).toBeTruthy();
  });

  it('shows a failure tile for missing refs', () => {
    renderExpandedActivity([
      makeEvent({
        imageRef: [makeRef('asset-missing', 'missing')],
      }),
    ]);

    expect(screen.getByTestId('tool-result-image-failed')).toBeTruthy();
    expect(screen.getByText('Image unavailable')).toBeTruthy();
  });
});
