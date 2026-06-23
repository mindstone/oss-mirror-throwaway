import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('./analytics', () => ({
  analytics: {
    track: mocks.track,
  },
}));

vi.mock('./sentry', () => ({
  captureRendererMessage: vi.fn(),
}));

import { tracking } from './tracking';

function getLensChangedCalls() {
  return mocks.track.mock.calls.filter(([eventName]) => eventName === 'Library Lens Changed');
}

describe('tracking.library lens axis resolution', () => {
  it('emits axis=filter payloads for filter-only lens changes', () => {
    mocks.track.mockClear();

    tracking.library.lensChanged({ filter: 'skills', view: 'folders', axis: 'filter' });

    expect(getLensChangedCalls()).toEqual([
      [
        'Library Lens Changed',
        expect.objectContaining({
          filter: 'skills',
          view: 'folders',
          axis: 'filter',
        }),
      ],
    ]);
  });

  it('emits axis=view payloads for view-only lens changes', () => {
    mocks.track.mockClear();

    tracking.library.lensChanged({ filter: 'spaces', view: 'atlas', axis: 'view' });

    expect(getLensChangedCalls()).toEqual([
      [
        'Library Lens Changed',
        expect.objectContaining({
          filter: 'spaces',
          view: 'atlas',
          axis: 'view',
        }),
      ],
    ]);
  });

  it('accepts axis=both for multi-axis transitions', () => {
    mocks.track.mockClear();

    tracking.library.lensChanged({ filter: 'memory', view: 'cards', axis: 'both' });

    expect(getLensChangedCalls()).toEqual([
      [
        'Library Lens Changed',
        expect.objectContaining({
          filter: 'memory',
          view: 'cards',
          axis: 'both',
        }),
      ],
    ]);
  });
});
