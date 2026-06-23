import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AuthInfo,
  DedupLookupResult,
  EnrichmentQuery,
  EnrichmentResult,
  MeetingSourceInput,
  MeetingSourceKernelFailureReason,
  MeetingSourceKernelResult,
  SaveMeetingSourceDeps,
  TargetSpace,
  UpgradeAndEmitInput,
  UpgradeAndEmitResult,
} from './types';
import type {
  TranscriptDistributionReadyEvent,
  TranscriptSavedEvent,
  TranscriptSourceSystem,
} from '@shared/types/transcript';
import { assertNever } from '@shared/utils/assertNever';

const DEFAULT_STAGE_SUMMARY = 'Meeting transcript staged for sensitivity review';

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getSourceSystem(input: MeetingSourceInput): TranscriptSourceSystem {
  switch (input.kind) {
    case 'external':
      return input.provider;
    case 'recall':
      return 'recall';
    case 'desktop_sdk':
      return 'desktop_sdk';
    case 'plaud':
      return 'plaud';
    case 'limitless':
      return 'limitless';
    case 'quick_capture':
      return 'quick_capture';
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function getTranscriptStartTime(input: MeetingSourceInput): string {
  switch (input.kind) {
    case 'plaud':
      return input.transcript.startAt;
    case 'recall':
    case 'external':
    case 'limitless':
    case 'desktop_sdk':
    case 'quick_capture':
      return input.transcript.startTime;
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function getTranscriptDurationMs(input: MeetingSourceInput): number {
  return input.transcript.durationMs;
}

function getTranscriptDurationSeconds(input: MeetingSourceInput): number {
  return Math.max(0, Math.round(getTranscriptDurationMs(input) / 1000));
}

function getTranscriptParticipants(input: MeetingSourceInput): string[] {
  switch (input.kind) {
    case 'recall':
    case 'external':
    case 'desktop_sdk':
      return input.transcript.participants;
    case 'plaud':
    case 'limitless':
    case 'quick_capture':
      return [];
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function getTranscriptMeetingUrl(input: MeetingSourceInput): string | undefined {
  switch (input.kind) {
    case 'recall':
      return input.transcript.meetingUrl;
    case 'external':
      return input.meetingUrl ?? input.transcript.meetingUrl ?? undefined;
    case 'desktop_sdk':
      return input.transcript.meetingUrl;
    case 'plaud':
    case 'limitless':
    case 'quick_capture':
      return undefined;
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function getTranscriptCalendarEventId(input: MeetingSourceInput): string | undefined {
  switch (input.kind) {
    case 'recall':
      return input.transcript.calendarEventId;
    case 'external':
      return input.calendarEventId ?? undefined;
    case 'desktop_sdk':
    case 'plaud':
    case 'limitless':
    case 'quick_capture':
      return undefined;
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function getRawTranscript(input: MeetingSourceInput): string {
  return input.transcript.rawTranscript;
}

function getRawMeetingTitle(input: MeetingSourceInput): string {
  switch (input.kind) {
    case 'recall':
    case 'external':
    case 'desktop_sdk':
      return input.transcript.meetingTitle;
    case 'limitless':
      return input.transcript.title;
    case 'quick_capture':
      return input.transcript.title;
    case 'plaud':
      return 'Plaud Recording';
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function toEnrichmentQuery(input: MeetingSourceInput): EnrichmentQuery {
  return {
    meetingUrl: getTranscriptMeetingUrl(input),
    participants: getTranscriptParticipants(input),
    startTime: getTranscriptStartTime(input),
    durationMs: getTranscriptDurationMs(input),
  };
}

function providerForDedup(input: MeetingSourceInput): string {
  switch (input.kind) {
    case 'external':
      return input.provider;
    case 'recall':
      return input.provider;
    case 'desktop_sdk':
      return 'desktop_sdk';
    case 'plaud':
      return 'plaud';
    case 'limitless':
      return 'limitless';
    case 'quick_capture':
      return 'quick_capture';
    default: {
      const _exhaustive: never = input;
      return assertNever(_exhaustive);
    }
  }
}

function shouldEmitDistributionReady(input: MeetingSourceInput): boolean {
  return !(input.kind === 'recall' && input.transcript.isLiveTranscriptInitial === true);
}

function createSavedEvent(args: {
  input: MeetingSourceInput;
  sourceUid: string;
  sourceSystem: TranscriptSourceSystem;
  filePath: string;
  spacePath?: string;
  meetingTitle: string;
  alreadyExists: boolean;
  enriched: EnrichmentResult;
  nowMs: number;
}): TranscriptSavedEvent {
  const {
    input,
    sourceUid,
    sourceSystem,
    filePath,
    spacePath,
    meetingTitle,
    alreadyExists,
    enriched,
    nowMs,
  } = args;

  return {
    sourceSystem,
    sourceUid,
    filePath,
    spacePath,
    meetingTitle,
    startTime: getTranscriptStartTime(input),
    participants: getTranscriptParticipants(input),
    duration: getTranscriptDurationSeconds(input),
    alreadyExists,
    timestamp: nowMs,
    meetingUrl: enriched.meetingUrl ?? getTranscriptMeetingUrl(input),
    calendarEventId: enriched.calendarEventId ?? getTranscriptCalendarEventId(input),
  };
}

function buildTranscriptMeta(event: TranscriptSavedEvent): string {
  return JSON.stringify({
    sourceSystem: event.sourceSystem,
    sourceUid: event.sourceUid,
    meetingTitle: event.meetingTitle,
    startTime: event.startTime,
    participants: event.participants,
    duration: event.duration,
    meetingUrl: event.meetingUrl,
    calendarEventId: event.calendarEventId,
    spacePath: event.spacePath,
  });
}

function failedResult(
  reason: MeetingSourceKernelFailureReason,
  error?: unknown,
): MeetingSourceKernelResult {
  if (error === undefined) {
    return { kind: 'failed', reason };
  }
  return { kind: 'failed', reason, error: toError(error) };
}

function getDestinationBasePath(
  spaceRoot: string,
  subfolder: string,
  filename: string,
): string {
  return path.join(spaceRoot, 'memory', 'sources', subfolder, filename);
}

export function notifyDistributionReady(
  event: TranscriptDistributionReadyEvent,
  deps: Pick<SaveMeetingSourceDeps, 'emitTranscriptDistributionReady' | 'logger'>,
): void {
  deps.logger.debug(
    {
      filePath: event.filePath,
      sourceSystem: event.sourceSystem,
      sourceUid: event.sourceUid,
    },
    'notify_distribution_ready',
  );
  deps.emitTranscriptDistributionReady(event);
}

export async function saveMeetingSource(
  input: MeetingSourceInput,
  deps: SaveMeetingSourceDeps,
): Promise<MeetingSourceKernelResult> {
  const coreDirectory = deps.getCoreDirectory();
  if (!coreDirectory) {
    return failedResult('no_workspace');
  }

  let target: TargetSpace | null;
  try {
    target = await deps.resolveTargetSpace(coreDirectory, input);
  } catch (error) {
    deps.logger.error({ err: error }, 'meeting_source_target_space_resolution_failed');
    return failedResult('no_target_space', error);
  }
  if (!target) {
    return failedResult('no_target_space');
  }

  const auth = deps.getAuthInfo() as AuthInfo | null;
  if (!auth) {
    return failedResult('no_workspace');
  }

  let enriched: EnrichmentResult = { matched: false };
  try {
    enriched = await deps.enrichWithCalendar(toEnrichmentQuery(input));
  } catch (error) {
    deps.logger.warn({ err: error }, 'meeting_source_calendar_enrichment_failed');
  }

  const sourceUid = deps.generateStableId(input);
  const sourceSystem = getSourceSystem(input);
  let dedup: DedupLookupResult;
  try {
    dedup = await deps.findTranscriptByStableId(
      target.absolutePath,
      sourceUid,
      providerForDedup(input),
      new Date(getTranscriptStartTime(input)),
    );
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        sourceUid,
        sourceSystem,
      },
      'meeting_source_dedup_lookup_threw',
    );
    return failedResult('dedup_lookup_error', error);
  }

  if ('error' in dedup) {
    deps.logger.warn(
      {
        err: dedup.error,
        sourceUid,
        sourceSystem,
      },
      'meeting_source_dedup_lookup_failed',
    );
    return failedResult('dedup_lookup_error', dedup.error);
  }

  if (dedup.found) {
    const nowMs = deps.clock().getTime();
    const emittedEvent = createSavedEvent({
      input,
      sourceUid,
      sourceSystem,
      filePath: dedup.filePath,
      spacePath: target.spacePath,
      meetingTitle: getRawMeetingTitle(input),
      alreadyExists: true,
      enriched,
      nowMs,
    });

    deps.emitTranscriptSaved(emittedEvent);

    return {
      kind: 'saved',
      filePath: dedup.filePath,
      emittedEvent,
      alreadyExists: true,
      existingFilePath: dedup.filePath,
    };
  }

  let title: string;
  let destinationPath: string;
  let body: string;
  try {
    title = await deps.resolveTitle(input, enriched);
    const frontmatter = deps.resolveFrontmatter(input, enriched, auth);
    const { subfolder, filename } = deps.generateFilename(input, title, auth, enriched);
    body = deps.formatMarkdownBody(input, title, frontmatter, auth);
    destinationPath = getDestinationBasePath(target.absolutePath, subfolder, filename);
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        sourceUid,
        sourceSystem,
      },
      'meeting_source_content_build_failed',
    );
    return failedResult('content_build_error', error);
  }

  let guardDecision: { decision: 'allow' } | { decision: 'stage'; summary?: string };
  try {
    guardDecision = await deps.evaluateGuard(getRawTranscript(input), target, coreDirectory);
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        sourceUid,
        sourceSystem,
      },
      'meeting_source_guard_failed',
    );
    return failedResult('guard_error', error);
  }

  const stagedEvent = createSavedEvent({
    input,
    sourceUid,
    sourceSystem,
    filePath: destinationPath,
    spacePath: target.spacePath,
    meetingTitle: title,
    alreadyExists: false,
    enriched,
    nowMs: deps.clock().getTime(),
  });

  if (guardDecision.decision === 'stage') {
    const summary = guardDecision.summary ?? DEFAULT_STAGE_SUMMARY;
    let pendingFile;
    try {
      pendingFile = await deps.writeToPending({
        destinationPath,
        content: body,
        sessionId: `transcript-guard-${sourceUid}`,
        summary,
        spaceName: target.spaceName ?? target.spacePath,
        sharing: target.sharing,
        transcriptMeta: buildTranscriptMeta(stagedEvent),
      });
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          destinationPath,
          sourceUid,
          sourceSystem,
        },
        'meeting_source_pending_write_failed',
      );
      return failedResult('cos_unavailable', error);
    }

    if (!pendingFile) {
      return failedResult('cos_unavailable');
    }

    deps.broadcastStaging(
      pendingFile,
      destinationPath,
      target.spaceName ?? target.spacePath,
      summary,
    );
    deps.deferTranscriptSaved(destinationPath, stagedEvent);

    return {
      kind: 'staged',
      pendingFileId: pendingFile.id,
      destinationPath: pendingFile.destinationPath,
    };
  }

  try {
    const parentFolder = path.dirname(destinationPath);
    await deps.mkdir(parentFolder);
    const uniquePath = await deps.uniqueFilePath(destinationPath);
    await deps.writeFile(uniquePath, body);

    void deps.linkTranscriptToExistingPrep(uniquePath).catch((error) => {
      deps.logger.warn(
        {
          err: error,
          filePath: uniquePath,
          sourceUid,
          sourceSystem,
        },
        'meeting_source_prep_link_failed',
      );
    });

    const emittedEvent = createSavedEvent({
      input,
      sourceUid,
      sourceSystem,
      filePath: uniquePath,
      spacePath: target.spacePath,
      meetingTitle: title,
      alreadyExists: false,
      enriched,
      nowMs: deps.clock().getTime(),
    });

    deps.emitTranscriptSaved(emittedEvent);

    if (shouldEmitDistributionReady(input)) {
      notifyDistributionReady({
        filePath: uniquePath,
        sourceSystem,
        sourceUid,
      }, deps);
    }

    return {
      kind: 'saved',
      filePath: uniquePath,
      emittedEvent,
      alreadyExists: false,
    };
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        sourceUid,
        sourceSystem,
      },
      'meeting_source_save_failed',
    );
    return failedResult('fs_error', error);
  }
}

export async function upgradeAndEmit(
  args: UpgradeAndEmitInput,
  deps: Pick<
    SaveMeetingSourceDeps,
    'writeFile' | 'emitTranscriptSaved' | 'emitTranscriptDistributionReady' | 'logger'
  > & { readFile?: (filePath: string) => Promise<string> },
): Promise<UpgradeAndEmitResult> {
  try {
    if (deps.readFile) {
      try {
        const existingContent = await deps.readFile(args.filePath);
        const existingHash = createHash('sha256').update(existingContent).digest('hex');
        const nextHash = createHash('sha256').update(args.newTranscript).digest('hex');

        if (existingHash === nextHash) {
          deps.logger.info(
            {
              filePath: args.filePath,
              sourceUid: args.sourceUid,
              sourceSystem: args.sourceSystem,
            },
            'kernel_upgrade_already_completed',
          );
          return {
            success: true,
            filePath: args.filePath,
            alreadyUpgraded: true,
          };
        }
      } catch (error) {
        deps.logger.debug(
          {
            err: error,
            filePath: args.filePath,
            sourceUid: args.sourceUid,
            sourceSystem: args.sourceSystem,
          },
          'meeting_source_upgrade_idempotency_precheck_failed',
        );
      }
    }

    await deps.writeFile(args.filePath, args.newTranscript);

    if (args.emitSavedFirst) {
      deps.emitTranscriptSaved(args.emitSavedFirst.event);
    }

    const emittedEvent = {
      filePath: args.filePath,
      sourceSystem: args.sourceSystem,
      sourceUid: args.sourceUid,
      transcriptQuality: args.newQuality,
    } as TranscriptDistributionReadyEvent;

    notifyDistributionReady(emittedEvent, deps);

    return {
      success: true,
      filePath: args.filePath,
      emittedEvent,
    };
  } catch (error) {
    const wrappedError = toError(error);
    deps.logger.error(
      {
        err: wrappedError,
        filePath: args.filePath,
        sourceUid: args.sourceUid,
        sourceSystem: args.sourceSystem,
      },
      'meeting_source_upgrade_failed',
    );
    return {
      success: false,
      filePath: args.filePath,
      error: wrappedError,
    };
  }
}

export interface UpgradeWithGuardAndEmitInput {
  upgrade: UpgradeAndEmitInput;
  rawTranscript: string;
  coreDirectory: string;
  target: TargetSpace;
  stageSessionId: string;
}

export type UpgradeWithGuardAndEmitResult =
  | {
      success: true;
      staged: true;
      filePath: string;
      pendingFileId: string;
      destinationPath: string;
    }
  | {
      success: true;
      staged: false;
      filePath: string;
      emittedEvent?: TranscriptDistributionReadyEvent;
      alreadyUpgraded?: boolean;
    }
  | {
      success: false;
      staged: false;
      filePath: string;
      reason: 'guard_error' | 'cos_unavailable' | 'fs_error';
      error?: Error;
    };

export async function upgradeWithGuardAndEmit(
  input: UpgradeWithGuardAndEmitInput,
  deps: Pick<
    SaveMeetingSourceDeps,
    | 'evaluateGuard'
    | 'writeToPending'
    | 'broadcastStaging'
    | 'deferTranscriptSaved'
    | 'writeFile'
    | 'emitTranscriptSaved'
    | 'emitTranscriptDistributionReady'
    | 'logger'
  > & { readFile?: (filePath: string) => Promise<string> },
): Promise<UpgradeWithGuardAndEmitResult> {
  let guardDecision: { decision: 'allow' } | { decision: 'stage'; summary?: string };
  try {
    guardDecision = await deps.evaluateGuard(
      input.rawTranscript,
      input.target,
      input.coreDirectory,
    );
  } catch (error) {
    const wrappedError = toError(error);
    deps.logger.warn(
      {
        err: wrappedError,
        filePath: input.upgrade.filePath,
        sourceUid: input.upgrade.sourceUid,
        sourceSystem: input.upgrade.sourceSystem,
      },
      'meeting_source_upgrade_guard_failed',
    );
    return {
      success: false,
      staged: false,
      filePath: input.upgrade.filePath,
      reason: 'guard_error',
      error: wrappedError,
    };
  }

  if (guardDecision.decision === 'stage') {
    const event = input.upgrade.emitSavedFirst?.event;
    if (!event) {
      const missingEventError = new Error(
        'upgradeWithGuardAndEmit requires emitSavedFirst.event for staged flow',
      );
      deps.logger.error(
        {
          err: missingEventError,
          filePath: input.upgrade.filePath,
          sourceUid: input.upgrade.sourceUid,
          sourceSystem: input.upgrade.sourceSystem,
        },
        'meeting_source_upgrade_stage_event_missing',
      );
      return {
        success: false,
        staged: false,
        filePath: input.upgrade.filePath,
        reason: 'fs_error',
        error: missingEventError,
      };
    }

    const summary = guardDecision.summary ?? DEFAULT_STAGE_SUMMARY;
    let pendingFile;
    try {
      pendingFile = await deps.writeToPending({
        destinationPath: input.upgrade.filePath,
        content: input.upgrade.newTranscript,
        sessionId: input.stageSessionId,
        summary,
        spaceName: input.target.spaceName ?? input.target.spacePath,
        sharing: input.target.sharing,
        transcriptMeta: buildTranscriptMeta(event),
      });
    } catch (error) {
      const wrappedError = toError(error);
      deps.logger.error(
        {
          err: wrappedError,
          filePath: input.upgrade.filePath,
          sourceUid: input.upgrade.sourceUid,
          sourceSystem: input.upgrade.sourceSystem,
        },
        'meeting_source_upgrade_pending_write_failed',
      );
      return {
        success: false,
        staged: false,
        filePath: input.upgrade.filePath,
        reason: 'cos_unavailable',
        error: wrappedError,
      };
    }

    if (!pendingFile) {
      return {
        success: false,
        staged: false,
        filePath: input.upgrade.filePath,
        reason: 'cos_unavailable',
      };
    }

    deps.broadcastStaging(
      pendingFile,
      input.upgrade.filePath,
      input.target.spaceName ?? input.target.spacePath,
      summary,
    );
    deps.deferTranscriptSaved(input.upgrade.filePath, event);

    return {
      success: true,
      staged: true,
      filePath: input.upgrade.filePath,
      pendingFileId: pendingFile.id,
      destinationPath: pendingFile.destinationPath,
    };
  }

  const upgraded = await upgradeAndEmit(input.upgrade, deps);
  if (!upgraded.success) {
    return {
      success: false,
      staged: false,
      filePath: input.upgrade.filePath,
      reason: 'fs_error',
      error: upgraded.error,
    };
  }

  return {
    success: true,
    staged: false,
    filePath: input.upgrade.filePath,
    emittedEvent: upgraded.emittedEvent,
    alreadyUpgraded: upgraded.alreadyUpgraded,
  };
}
