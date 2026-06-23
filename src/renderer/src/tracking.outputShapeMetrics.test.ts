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

describe('tracking.chat.turnCompleted output shape metrics', () => {
  it('flattens content-free output shape metrics without raw text', () => {
    mocks.track.mockClear();

    tracking.chat.turnCompleted({
      turnId: 'turn-1',
      sessionId: 'session-1',
      durationMs: 250,
      outputShapeMetrics: {
        wordCount: 101,
        headingCount: 2,
        bulletCount: 4,
        numberedListCount: 1,
        codeBlockCount: 0,
        tableLineCount: 3,
        linkCount: 2,
        hasSourceSection: true,
        shapeBucket: 'structured_response',
      },
    });

    expect(mocks.track).toHaveBeenCalledWith(
      'Agent Turn Completed',
      expect.objectContaining({
        finalWordCount: 101,
        finalHeadingCount: 2,
        finalBulletCount: 4,
        finalNumberedListCount: 1,
        finalCodeBlockCount: 0,
        finalTableLineCount: 3,
        finalLinkCount: 2,
        finalHasSourceSection: true,
        finalShapeBucket: 'structured_response',
      }),
    );
    expect(mocks.track).not.toHaveBeenCalledWith(
      'Agent Turn Completed',
      expect.objectContaining({
        text: expect.any(String),
      }),
    );
  });
});

describe('tracking.workArtifacts.created', () => {
  it('uses canonical dashboard output categories for document-like artifacts', () => {
    mocks.track.mockClear();

    tracking.workArtifacts.created({
      artifactType: 'report',
      source: 'library_write_file',
      fileExtension: 'html',
    });

    expect(mocks.track).toHaveBeenCalledWith(
      'Work Output Created',
      expect.objectContaining({
        output_type: 'document',
        output_format: 'html',
        source_surface: 'library_write_file',
      }),
    );
  });
});
