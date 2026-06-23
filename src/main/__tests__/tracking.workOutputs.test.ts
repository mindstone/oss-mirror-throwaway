import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackMainEvent: vi.fn(),
  identifyMainUser: vi.fn(),
}));

vi.mock('../analytics', () => ({
  getOrGenerateAnonymousId: () => 'anon-test',
  trackMainEvent: mocks.trackMainEvent,
  identifyMainUser: mocks.identifyMainUser,
}));

vi.mock('../settingsStore', () => ({
  settingsStore: {
    store: {
      userEmail: null,
    },
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    version: '0.0.0-test',
  }),
}));

vi.mock('@main/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

import { cleanupTurnAggregator, getTurnAggregator, mainTracking } from '../tracking';

describe('work output tracking', () => {
  afterEach(() => {
    mocks.trackMainEvent.mockReset();
    cleanupTurnAggregator('turn-create');
    cleanupTurnAggregator('turn-update');
    cleanupTurnAggregator('turn-memory');
    cleanupTurnAggregator('turn-code');
    cleanupTurnAggregator('turn-presentation');
    cleanupTurnAggregator('turn-spreadsheet');
  });

  it('counts a successful first Write result as a created durable work output', () => {
    const aggregator = getTurnAggregator('turn-create');

    aggregator.recordToolStartWithDetail(
      'Write',
      'tool-write-1',
      null,
      JSON.stringify({ file_path: 'reports/q2-report.md', content: '# Q2' }),
    );
    aggregator.recordToolEndWithSize(
      'Write',
      49,
      false,
      'tool-write-1',
      'Created 4 characters to /workspace/reports/q2-report.md',
    );

    expect(aggregator.getToolMetrics()).toMatchObject({
      filesCreated: 1,
      filesEdited: 0,
      workArtifactsCreated: 1,
      workArtifactsCreatedByType: { report: 1 },
    });
    expect(aggregator.getCreatedWorkArtifacts()).toEqual([
      {
        filePath: '/workspace/reports/q2-report.md',
        artifactType: 'report',
        shared: false,
      },
    ]);
  });

  it('keeps an overwrite Write result as an edit, not a new work output', () => {
    const aggregator = getTurnAggregator('turn-update');

    aggregator.recordToolStartWithDetail(
      'Write',
      'tool-write-2',
      null,
      JSON.stringify({ file_path: 'reports/q2-report.md', content: '# Q2 revised' }),
    );
    aggregator.recordToolEndWithSize(
      'Write',
      57,
      false,
      'tool-write-2',
      'Updated 12 characters to /workspace/reports/q2-report.md',
    );

    expect(aggregator.getToolMetrics()).toMatchObject({
      filesCreated: 0,
      filesEdited: 1,
      workArtifactsCreated: 0,
      workArtifactsCreatedByType: {},
    });
  });

  it('excludes memory writes from work output counts while preserving memory diagnostics', () => {
    const aggregator = getTurnAggregator('turn-memory');

    aggregator.recordToolStartWithDetail(
      'Write',
      'tool-write-memory',
      null,
      JSON.stringify({ file_path: 'Chief-of-Staff/memory/topics/account.md', content: 'context' }),
    );
    aggregator.recordToolEndWithSize(
      'Write',
      65,
      false,
      'tool-write-memory',
      'Created 7 characters to /workspace/Chief-of-Staff/memory/topics/account.md',
    );

    expect(aggregator.getToolMetrics()).toMatchObject({
      filesCreated: 1,
      workArtifactsCreated: 0,
      workArtifactsCreatedByType: {},
      memoryFilesModified: 1,
    });
    expect(aggregator.getCreatedWorkArtifacts()).toEqual([]);
  });

  it('does not treat arbitrary code files as customer-facing work outputs', () => {
    const aggregator = getTurnAggregator('turn-code');

    aggregator.recordToolStartWithDetail(
      'Write',
      'tool-write-code',
      null,
      JSON.stringify({ file_path: 'src/reporting/draftReport.ts', content: 'export {};' }),
    );
    aggregator.recordToolEndWithSize(
      'Write',
      53,
      false,
      'tool-write-code',
      'Created 10 characters to /workspace/src/reporting/draftReport.ts',
    );

    expect(aggregator.getToolMetrics()).toMatchObject({
      filesCreated: 1,
      workArtifactsCreated: 0,
      workArtifactsCreatedByType: {},
    });
  });

  it('classifies presentation and spreadsheet deliverables by extension', () => {
    const presentation = getTurnAggregator('turn-presentation');
    presentation.recordToolStartWithDetail(
      'Write',
      'tool-write-presentation',
      null,
      JSON.stringify({ file_path: 'deck/customer-update.PPTX', content: 'deck' }),
    );
    presentation.recordToolEndWithSize(
      'Write',
      57,
      false,
      'tool-write-presentation',
      'Created 4 characters to /workspace/deck/customer-update.PPTX',
    );

    const spreadsheet = getTurnAggregator('turn-spreadsheet');
    spreadsheet.recordToolStartWithDetail(
      'Write',
      'tool-write-spreadsheet',
      null,
      JSON.stringify({ file_path: 'exports/forecast.csv', content: 'a,b' }),
    );
    spreadsheet.recordToolEndWithSize(
      'Write',
      53,
      false,
      'tool-write-spreadsheet',
      'Created 3 characters to /workspace/exports/forecast.csv',
    );

    expect(presentation.getToolMetrics()).toMatchObject({
      workArtifactsCreated: 1,
      workArtifactsCreatedByType: { presentation: 1 },
    });
    expect(spreadsheet.getToolMetrics()).toMatchObject({
      workArtifactsCreated: 1,
      workArtifactsCreatedByType: { spreadsheet: 1 },
    });
  });

  it('emits canonical Work Output Created metadata for durable HTML outputs', () => {
    mainTracking.workArtifactCreated({
      filePath: '/workspace/reports/customer-summary.html',
      source: 'agent_tool',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });

    expect(mocks.trackMainEvent).toHaveBeenCalledTimes(2);
    expect(mocks.trackMainEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'Work Output Created',
      properties: expect.objectContaining({
        output_type: 'document',
        output_format: 'html',
        source_surface: 'agent_tool',
        turnId: 'turn-1',
      }),
    }));
  });

  it('does not emit work output events for memory files', () => {
    mainTracking.workArtifactCreated({
      filePath: '/workspace/Chief-of-Staff/memory/topics/account.md',
      source: 'agent_tool',
    });

    expect(mocks.trackMainEvent).not.toHaveBeenCalled();
  });

  it('does not emit work output events for code files with output-like words', () => {
    mainTracking.workArtifactCreated({
      filePath: '/workspace/src/reporting/draftReport.ts',
      source: 'agent_tool',
    });

    expect(mocks.trackMainEvent).not.toHaveBeenCalled();
  });
});
