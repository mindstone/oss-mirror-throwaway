import { describe, expect, it, vi } from 'vitest';
import type {
  FrontmatterShape,
  MeetingSourceInput,
  SaveMeetingSourceDeps,
  UpgradeAndEmitInput,
} from '../types';
import { saveMeetingSource, upgradeAndEmit } from '../saveMeetingSource';

const FIXED_NOW = new Date('2026-05-19T12:00:00.000Z');

type RecallInputOverride =
  Omit<Partial<Extract<MeetingSourceInput, { kind: 'recall' }>>, 'transcript'>
  & {
    transcript?: Partial<Extract<MeetingSourceInput, { kind: 'recall' }>['transcript']>;
  };

type ExternalInputOverride =
  Omit<Partial<Extract<MeetingSourceInput, { kind: 'external' }>>, 'transcript'>
  & {
    transcript?: Partial<Extract<MeetingSourceInput, { kind: 'external' }>['transcript']>;
  };

type DesktopInputOverride =
  Omit<Partial<Extract<MeetingSourceInput, { kind: 'desktop_sdk' }>>, 'transcript'>
  & {
    transcript?: Partial<Extract<MeetingSourceInput, { kind: 'desktop_sdk' }>['transcript']>;
  };

function makeLogger(): SaveMeetingSourceDeps['logger'] {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  } as unknown as SaveMeetingSourceDeps['logger'];
}

function makeFrontmatter(sourceSystem: FrontmatterShape['source_system'] = 'recall'): FrontmatterShape {
  return {
    source_type: 'meeting',
    source_system: sourceSystem,
    source_uid: 'stable-id',
    source_url: `urn:${sourceSystem}:fixture:stable-id`,
    source_account: 'test@example.com',
    description: 'Fixture meeting',
    occurred_at: '2026-05-19',
    stored_at: '2026-05-19',
    truncated: false,
    review_status: 'pending',
  };
}

function makeRecallInput(
  overrides: RecallInputOverride = {},
): MeetingSourceInput {
  const { transcript: transcriptOverrides, ...rest } = overrides;
  const transcript: Extract<MeetingSourceInput, { kind: 'recall' }>['transcript'] = {
    botId: 'recall-bot-1',
    meetingTitle: 'Recall Fixture Meeting',
    meetingUrl: 'https://meet.google.com/recall-fixture',
    participants: ['Alice', 'Bob'],
    durationMs: 30 * 60 * 1000,
    startTime: '2026-05-19T10:00:00.000Z',
    rawTranscript: 'Hello from Recall transcript.',
    transcriptQuality: 'captions' as const,
    ...(transcriptOverrides ?? {}),
  };

  return {
    kind: 'recall',
    provider: 'recall',
    transcript,
    ...rest,
  };
}

function makeExternalInput(
  provider: 'fireflies' | 'fathom' = 'fireflies',
  overrides: ExternalInputOverride = {},
): MeetingSourceInput {
  const { transcript: transcriptOverrides, ...rest } = overrides;
  const transcript: Extract<MeetingSourceInput, { kind: 'external' }>['transcript'] = {
    externalId: 'external-1',
    meetingTitle: 'External Fixture Meeting',
    meetingUrl: 'https://zoom.us/j/external-fixture',
    participants: ['Casey', 'Jordan'],
    durationMs: 25 * 60 * 1000,
    startTime: '2026-05-19T11:00:00.000Z',
    rawTranscript: 'External transcript text.',
    ...(transcriptOverrides ?? {}),
  };

  return {
    kind: 'external',
    provider,
    meetingUrl: transcript.meetingUrl ?? null,
    calendarEventId: 'cal-external-1',
    transcript,
    ...rest,
  };
}

function makeDesktopInput(
  overrides: DesktopInputOverride = {},
): MeetingSourceInput {
  const { transcript: transcriptOverrides, ...rest } = overrides;
  const transcript: Extract<MeetingSourceInput, { kind: 'desktop_sdk' }>['transcript'] = {
    sessionId: 'desktop-session-1',
    meetingTitle: 'Desktop SDK Fixture Meeting',
    meetingUrl: 'https://teams.microsoft.com/l/desktop-fixture',
    participants: ['Riley'],
    durationMs: 20 * 60 * 1000,
    startTime: '2026-05-19T09:30:00.000Z',
    rawTranscript: 'Desktop transcript text.',
    ...(transcriptOverrides ?? {}),
  };

  return {
    kind: 'desktop_sdk',
    transcript,
    fallbackTitleStrategy: () => 'Desktop Fallback',
    ...rest,
  };
}

function createDeps(overrides: Partial<SaveMeetingSourceDeps> = {}): SaveMeetingSourceDeps {
  const logger = makeLogger();
  const frontmatter = makeFrontmatter();

  return {
    getCoreDirectory: vi.fn(() => '/workspace'),
    resolveTargetSpace: vi.fn(async () => ({
      spacePath: 'Chief-of-Staff',
      absolutePath: '/workspace/Chief-of-Staff',
      spaceName: 'Chief of Staff',
      sharing: 'private' as const,
    })),
    getAuthInfo: vi.fn(() => ({
      userName: 'Test User',
      userEmail: 'test@example.com',
    })),
    enrichWithCalendar: vi.fn(async () => ({ matched: false })),
    findTranscriptByStableId: vi.fn(async () => ({ found: false as const })),
    generateStableId: vi.fn(() => 'stable-id'),
    resolveFrontmatter: vi.fn(() => frontmatter),
    resolveTitle: vi.fn(async () => 'Resolved Meeting Title'),
    generateFilename: vi.fn(() => ({
      subfolder: '2026/05-May/19',
      filename: '260519_1200_meeting_fixture.md',
    })),
    formatMarkdownBody: vi.fn(() => '---\nsource_type: meeting\n---\n\n# Resolved Meeting Title\n'),
    evaluateGuard: vi.fn(async () => ({ decision: 'allow' as const })),
    mkdir: vi.fn(async () => undefined),
    uniqueFilePath: vi.fn(async () => '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/260519_1200_meeting_fixture.md'),
    writeFile: vi.fn(async () => undefined),
    writeToPending: vi.fn(async () => ({
      id: 'pending-1',
      destinationPath: '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/260519_1200_meeting_fixture.md',
    })),
    broadcastStaging: vi.fn(),
    linkTranscriptToExistingPrep: vi.fn(async () => undefined),
    emitTranscriptSaved: vi.fn(),
    deferTranscriptSaved: vi.fn(),
    emitTranscriptDistributionReady: vi.fn(),
    clock: () => FIXED_NOW,
    logger,
    ...overrides,
  };
}

describe('saveMeetingSource kernel', () => {
  it('saves recall input and emits saved + distribution-ready with built markdown', async () => {
    const input = makeRecallInput();
    const frontmatter = makeFrontmatter('recall');
    const deps = createDeps({
      resolveFrontmatter: vi.fn(() => frontmatter),
      formatMarkdownBody: vi.fn(() => 'recall-markdown'),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toMatchObject({
      kind: 'saved',
      alreadyExists: false,
      filePath: '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/260519_1200_meeting_fixture.md',
    });
    expect(deps.resolveFrontmatter).toHaveBeenCalledWith(
      input,
      { matched: false },
      { userName: 'Test User', userEmail: 'test@example.com' },
    );
    expect(deps.formatMarkdownBody).toHaveBeenCalledWith(
      input,
      'Resolved Meeting Title',
      frontmatter,
      { userName: 'Test User', userEmail: 'test@example.com' },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/260519_1200_meeting_fixture.md',
      'recall-markdown',
    );
    expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'recall',
        sourceUid: 'stable-id',
        meetingTitle: 'Resolved Meeting Title',
        filePath: '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/260519_1200_meeting_fixture.md',
      }),
    );
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'recall',
        sourceUid: 'stable-id',
      }),
    );
  });

  it('saves external input and emits with provider source system', async () => {
    const input = makeExternalInput('fireflies');
    const deps = createDeps({
      resolveFrontmatter: vi.fn(() => makeFrontmatter('fireflies')),
      generateStableId: vi.fn(() => 'external-1'),
      resolveTitle: vi.fn(async () => 'External Resolved Title'),
      formatMarkdownBody: vi.fn(() => 'external-markdown'),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toMatchObject({ kind: 'saved', alreadyExists: false });
    expect(deps.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'fireflies',
        sourceUid: 'external-1',
        meetingTitle: 'External Resolved Title',
      }),
    );
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'fireflies',
        sourceUid: 'external-1',
      }),
    );
  });

  it('saves desktop_sdk input and emits same-tick distribution-ready', async () => {
    const input = makeDesktopInput();
    const deps = createDeps({
      resolveFrontmatter: vi.fn(() => makeFrontmatter('desktop_sdk')),
      generateStableId: vi.fn(() => 'desktop-session-1'),
      resolveTitle: vi.fn(async () => 'Desktop Resolved Title'),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toMatchObject({ kind: 'saved', alreadyExists: false });
    expect(deps.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'desktop_sdk',
        sourceUid: 'desktop-session-1',
      }),
    );
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'desktop_sdk',
        sourceUid: 'desktop-session-1',
      }),
    );
  });

  it('returns alreadyExists on dedup hit and emits transcript-saved only', async () => {
    const input = makeRecallInput();
    const deps = createDeps({
      findTranscriptByStableId: vi.fn(async () => ({
        found: true,
        filePath: '/workspace/existing.md',
      })),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'saved',
        alreadyExists: true,
        existingFilePath: '/workspace/existing.md',
      }),
    );
    expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'recall',
        sourceUid: 'stable-id',
        filePath: '/workspace/existing.md',
        alreadyExists: true,
      }),
    );
    expect(deps.emitTranscriptDistributionReady).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('returns dedup_lookup_error when dedup dependency returns error', async () => {
    const input = makeRecallInput();
    const deps = createDeps({
      findTranscriptByStableId: vi.fn(async () => ({
        error: new Error('dedup failed'),
      })),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'failed',
        reason: 'dedup_lookup_error',
      }),
    );
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('fails with no_target_space when target cannot be resolved', async () => {
    const deps = createDeps({
      resolveTargetSpace: vi.fn(async () => null),
    });

    const result = await saveMeetingSource(makeRecallInput(), deps);
    expect(result).toEqual({ kind: 'failed', reason: 'no_target_space' });
  });

  it('fails with no_workspace when auth is unavailable', async () => {
    const deps = createDeps({
      getAuthInfo: vi.fn(() => null as unknown as ReturnType<SaveMeetingSourceDeps['getAuthInfo']>),
    });

    const result = await saveMeetingSource(makeRecallInput(), deps);
    expect(result).toEqual({ kind: 'failed', reason: 'no_workspace' });
  });

  it('stages when guard returns stage and defers transcript saved event', async () => {
    const input = makeRecallInput();
    const deps = createDeps({
      evaluateGuard: vi.fn(async () => ({ decision: 'stage' as const, summary: 'Needs review' })),
    });

    const result = await saveMeetingSource(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'staged',
        pendingFileId: 'pending-1',
      }),
    );
    expect(deps.writeToPending).toHaveBeenCalledOnce();
    expect(deps.broadcastStaging).toHaveBeenCalledOnce();
    expect(deps.deferTranscriptSaved).toHaveBeenCalledOnce();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
    expect(deps.emitTranscriptDistributionReady).not.toHaveBeenCalled();
  });

  it('returns guard_error when guard throws', async () => {
    const deps = createDeps({
      evaluateGuard: vi.fn(async () => {
        throw new Error('guard exploded');
      }),
    });

    const result = await saveMeetingSource(makeRecallInput(), deps);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'failed',
        reason: 'guard_error',
      }),
    );
  });

  it('returns fs_error on file write failure', async () => {
    const deps = createDeps({
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    const result = await saveMeetingSource(makeRecallInput(), deps);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'failed',
        reason: 'fs_error',
      }),
    );
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
  });

  it('swallows prep-link errors, logs warning, and still emits', async () => {
    const logger = makeLogger();
    const deps = createDeps({
      logger,
      linkTranscriptToExistingPrep: vi.fn(async () => {
        throw new Error('prep link failed');
      }),
    });

    const result = await saveMeetingSource(makeRecallInput(), deps);
    await Promise.resolve();

    expect(result).toMatchObject({ kind: 'saved', alreadyExists: false });
    expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
      }),
      'meeting_source_prep_link_failed',
    );
  });

  it('does not emit distribution-ready for recall live transcript initial save', async () => {
    const input = makeRecallInput({
      transcript: {
        isLiveTranscriptInitial: true,
      },
    });
    const deps = createDeps();

    const result = await saveMeetingSource(input, deps);

    expect(result).toMatchObject({ kind: 'saved', alreadyExists: false });
    expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptDistributionReady).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['false', false],
  ])(
    'emits distribution-ready for recall when isLiveTranscriptInitial is %s',
    async (_label, isLiveTranscriptInitial) => {
      const input = makeRecallInput({
        transcript: {
          isLiveTranscriptInitial,
        },
      });
      const deps = createDeps();

      const result = await saveMeetingSource(input, deps);

      expect(result).toMatchObject({ kind: 'saved', alreadyExists: false });
      expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
      expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledOnce();
    },
  );
});

describe('upgradeAndEmit', () => {
  function makeUpgradeDeps() {
    return {
      readFile: vi.fn(async () => '# previous transcript markdown'),
      writeFile: vi.fn(async () => undefined),
      emitTranscriptSaved: vi.fn(),
      emitTranscriptDistributionReady: vi.fn(),
      logger: makeLogger(),
    };
  }

  function makeUpgradeInput(
    overrides: Partial<UpgradeAndEmitInput> = {},
  ): UpgradeAndEmitInput {
    return {
      filePath: '/workspace/meeting.md',
      newTranscript: '# upgraded transcript markdown',
      newQuality: 'recallai_async',
      sourceUid: 'recall-bot-1',
      sourceSystem: 'recall',
      spacePath: 'Chief-of-Staff',
      meetingTitle: 'Fixture',
      ...overrides,
    };
  }

  it('writes content and emits distribution-ready on success', async () => {
    const deps = makeUpgradeDeps();
    const input = makeUpgradeInput();

    const result = await upgradeAndEmit(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        filePath: '/workspace/meeting.md',
      }),
    );
    expect(deps.readFile).toHaveBeenCalledWith('/workspace/meeting.md');
    expect(deps.writeFile).toHaveBeenCalledWith('/workspace/meeting.md', '# upgraded transcript markdown');
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/workspace/meeting.md',
        sourceUid: 'recall-bot-1',
        sourceSystem: 'recall',
      }),
    );
  });

  it('returns failure and does not emit when write fails', async () => {
    const deps = makeUpgradeDeps();
    deps.readFile = vi.fn(async () => '# old content');
    deps.writeFile = vi.fn(async () => {
      throw new Error('write failed');
    });
    const input = makeUpgradeInput();

    const result = await upgradeAndEmit(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        filePath: '/workspace/meeting.md',
        error: expect.any(Error),
      }),
    );
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
    expect(deps.emitTranscriptDistributionReady).not.toHaveBeenCalled();
  });

  it('emits saved event before distribution-ready when emitSavedFirst is provided', async () => {
    const deps = makeUpgradeDeps();
    deps.readFile = vi.fn(async () => '# old transcript markdown');
    const input = makeUpgradeInput({
      emitSavedFirst: {
        event: {
          sourceSystem: 'recall',
          sourceUid: 'recall-bot-1',
          filePath: '/workspace/meeting.md',
          meetingTitle: 'Fixture',
          startTime: '2026-05-19T10:00:00.000Z',
          participants: ['Alice'],
          duration: 1200,
          alreadyExists: false,
          timestamp: FIXED_NOW.getTime(),
        },
      },
    });

    const result = await upgradeAndEmit(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        filePath: '/workspace/meeting.md',
      }),
    );
    expect(deps.emitTranscriptSaved).toHaveBeenCalledOnce();
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledOnce();
    const savedOrder = deps.emitTranscriptSaved.mock.invocationCallOrder[0];
    const distributionOrder = deps.emitTranscriptDistributionReady.mock.invocationCallOrder[0];
    expect(savedOrder).toBeLessThan(distributionOrder);
  });

  it('emits only distribution-ready when emitSavedFirst is omitted', async () => {
    const deps = makeUpgradeDeps();
    deps.readFile = vi.fn(async () => '# old transcript markdown');
    const input = makeUpgradeInput();

    const result = await upgradeAndEmit(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        filePath: '/workspace/meeting.md',
      }),
    );
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
    expect(deps.emitTranscriptDistributionReady).toHaveBeenCalledOnce();
  });

  it('is idempotent when existing content already matches', async () => {
    const deps = makeUpgradeDeps();
    deps.readFile = vi.fn(async () => '# upgraded transcript markdown');
    const input = makeUpgradeInput();

    const result = await upgradeAndEmit(input, deps);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        filePath: '/workspace/meeting.md',
        alreadyUpgraded: true,
      }),
    );
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.emitTranscriptSaved).not.toHaveBeenCalled();
    expect(deps.emitTranscriptDistributionReady).not.toHaveBeenCalled();
  });
});
