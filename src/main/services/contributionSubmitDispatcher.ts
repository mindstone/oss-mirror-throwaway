/**
 * Contribution Submit Dispatcher
 *
 * Single entry point for submitting a connector contribution, regardless
 * of attribution mode. Called by the unified IPC handler
 * `contribution:submit-unified`, and — as part of the Stage 2 migration —
 * also by the two legacy handlers (`contribution:submit`,
 * `contribution:submit-from-store`) so they all share one code path.
 *
 * Branching logic:
 *   - `attributionMode === 'github'` → disabled for the OSS scrub because
 *     the contribution-specific OAuth service was removed.
 *   - `attributionMode === 'rebel-name' | 'anonymous'` → relay path via
 *     the private contribution relay extension when registered.
 *
 * Hard invariants (tested in `__tests__/contributionSubmitDispatcher.test.ts`):
 *   - Errors from either transport surface as a typed failure body
 *     `{ success: false, error: { code, message } }` — never a thrown
 *     exception. This keeps the IPC contract narrow and avoids the
 *     "silent success with null contribution" anti-pattern.
 *   - The same-status short-circuit in `updateContribution` is still
 *     honoured; the dispatcher never forces a `submitted` transition
 *     on a record already in a terminal state.
 *   - `relayContributionId` is persisted via a *second* store write
 *     after the status transition so a transition rejection (which
 *     can happen if the UI promoted the record out-of-band) still
 *     preserves the relay id for debugging.
 *
 * @see docs/plans/260420_oss_mcp_backend_relay.md (Stage 2)
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import {
  classifyBuildPlanShape,
  computePayloadFingerprintExcludingAppendix,
  type BuildContext,
  ContributionPrFormatterValidationError,
} from '@core/services/contributionPrFormatter';
import { getSettings } from '@core/services/settingsStore';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { AgentEvent, AgentSession } from '@shared/types';
import { safeParseDetailRecord } from '@shared/utils/safeParseDetail';
import { getContributionRelayExtension } from '@core/services/contributionRelayExtension';
import type { RelaySubmitRequest } from '@shared/schemas/contributionRelay';
import {
  getContributionById,
  updateContribution,
} from '@core/services/contributionStore';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import { getCurrentModel } from '@core/rebelCore/settingsAccessors';
import {
  readConnectorFilesForSubmission,
  ContributionFileReadError,
  type ConnectorFile,
} from './contributionFileReader';

const log = createScopedLogger({ service: 'contribution-submit-dispatcher' });

// ─── Result Shape ───────────────────────────────────────────────────

export type SubmitContributionResult =
  | {
      success: true;
      prUrl: string;
      prNumber: number;
      duplicate?: boolean;
      degraded?: 'persistence-failed' | 'record-deleted';
      skippedDenylisted?: string[];
    }
  | {
      success: false;
      error: {
        /** One of the relay's `RelayErrorCode` values, plus `NOT_FOUND` and `REAUTH_REQUIRED` for desktop-specific failures. */
        code: string;
        message: string;
      };
      /** Set only for GitHub-path auth expiry; renderer opens the re-auth flow. */
      reAuthRequired?: boolean;
    };

type AttributionMode = ConnectorContribution['attributionMode'];

export interface SubmitContributionRequest {
  desiredAttributionMode?: AttributionMode;
  desiredAttributionName?: string | null;
}

function failure(
  code: string,
  message: string,
  extras: Partial<Extract<SubmitContributionResult, { success: false }>> = {},
): Extract<SubmitContributionResult, { success: false }> {
  return { success: false, error: { code, message }, ...extras };
}

/** Per-contribution single-flight map to deduplicate concurrent submits. */
const inFlightSubmissions = new Map<string, Promise<SubmitContributionResult>>();

type ContributionWithStage1Fields = ConnectorContribution & {
  lastSubmittedFingerprintExcludingAppendix?: string;
  lastSoftwareEngineerTaskCompletedAt?: string;
};

type RelayDuplicateDetails = {
  relayContributionId: string;
  prUrl: string;
  prNumber: number;
};

type DuplicateResponseIdentity = {
  relayContributionId: string;
};

export type DuplicateResolution =
  | { kind: 'idempotent_success' }
  | {
      kind: 'real_error';
      reason: DuplicateRealErrorReason;
    };

type DuplicateRealErrorReason =
  | 'content_changed_but_id_reused'
  | 'cross_contribution_id_collision';

function normalizeUnknownText(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? 'unknown' : trimmed;
}

function collectTaskSubagentTypesFromPersistedEvents(
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
): string[] {
  if (!eventsByTurn) return [];
  const types = new Set<string>();
  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type !== 'tool' || event.stage !== 'start' || event.toolName !== 'Task') {
        continue;
      }
      // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR non-object
      // valid JSON detail is skipped (best effort — must not block submit),
      // matching the pre-migration try/catch fallback.
      const result = safeParseDetailRecord(event.detail);
      if (result.ok) {
        const parsed = result.value;
        const candidate = parsed.subagent_type ?? parsed.agent;
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          types.add(candidate.trim());
        }
      }
    }
  }
  return Array.from(types);
}

async function collectTaskSubagentTypes(
  contribution: ConnectorContribution,
  persistedSession: AgentSession | null,
): Promise<string[]> {
  const taskSubagentTypes = new Set<string>();
  const activeTurnId = agentTurnRegistry.getActiveTurnForSession(contribution.sessionId);
  if (activeTurnId) {
    try {
      // Stage 1 seam: current source is tracking aggregator + persisted events.
      // Stage 2 formalizes source ordering and richer extraction.
      const { getTurnAggregator } = await import('../tracking');
      for (const subagentType of getTurnAggregator(activeTurnId).getSubAgentMetrics().subAgentTypes) {
        if (typeof subagentType === 'string' && subagentType.trim() !== '') {
          taskSubagentTypes.add(subagentType.trim());
        }
      }
    } catch (error) {
      log.warn(
        { contributionId: contribution.id, err: error instanceof Error ? error.message : String(error) },
        'Build Context: failed to read active-turn tracking aggregator; falling back to persisted events only',
      );
    }
  }

  for (const subagentType of collectTaskSubagentTypesFromPersistedEvents(persistedSession?.eventsByTurn)) {
    taskSubagentTypes.add(subagentType);
  }

  return Array.from(taskSubagentTypes).sort((a, b) => a.localeCompare(b));
}

async function readBuildPlanShape(localServerPath: string | undefined): Promise<BuildContext['buildPlanShape']> {
  if (!localServerPath || localServerPath.trim() === '') {
    return 'missing';
  }

  const buildPlanPath = path.join(localServerPath, 'docs', 'build-plan.md');
  try {
    const contents = await readFile(buildPlanPath, 'utf8');
    return classifyBuildPlanShape(contents);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException)?.code;
    if (errorCode === 'ENOENT') {
      return 'missing';
    }
    log.warn(
      {
        buildPlanPath,
        errorCode,
        err: error instanceof Error ? error.message : String(error),
      },
      'Build Context: failed to read docs/build-plan.md; defaulting to missing',
    );
    return 'missing';
  }
}

async function loadPersistedSession(sessionId: string): Promise<AgentSession | null> {
  try {
    return await getIncrementalSessionStore().getSession(sessionId);
  } catch (error) {
    log.warn(
      { sessionId, err: error instanceof Error ? error.message : String(error) },
      'Build Context: failed to load persisted session',
    );
    return null;
  }
}

async function collectBuildContext(contribution: ConnectorContribution): Promise<BuildContext> {
  const persistedSession = await loadPersistedSession(contribution.sessionId);
  const taskSubagentTypes = await collectTaskSubagentTypes(contribution, persistedSession);

  const contributionWithStage1 = contribution as ContributionWithStage1Fields;
  let fallbackModel = 'unknown';
  try {
    fallbackModel = normalizeUnknownText(getCurrentModel(getSettings()) ?? 'unknown');
  } catch {
    fallbackModel = 'unknown';
  }

  let appVersion = 'unknown';
  try {
    appVersion = normalizeUnknownText(getPlatformConfig().version);
  } catch {
    appVersion = 'unknown';
  }

  return {
    model: normalizeUnknownText(persistedSession?.sessionWorkingModel ?? fallbackModel),
    appVersion,
    sessionId: normalizeUnknownText(contribution.sessionId),
    appWorkflow: contributionWithStage1.lastSoftwareEngineerTaskCompletedAt !== undefined
      ? 'software-engineer'
      : 'direct',
    taskSubagentTypes,
    buildPlanShape: await readBuildPlanShape(contribution.localServerPath),
  };
}

function extractRelayDuplicateDetails(details: unknown): RelayDuplicateDetails | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const record = details as Record<string, unknown>;
  const relayContributionId = record.relayContributionId;
  const prUrl = record.prUrl;
  const prNumber = record.prNumber;
  if (
    typeof relayContributionId !== 'string'
    || typeof prUrl !== 'string'
    || typeof prNumber !== 'number'
  ) {
    return null;
  }
  return { relayContributionId, prUrl, prNumber };
}

export function resolveDuplicate(
  response: DuplicateResponseIdentity,
  localRecord: ContributionWithStage1Fields,
  currentPayload: Record<string, unknown>,
): DuplicateResolution {
  const hasStoredRelayId =
    typeof localRecord.relayContributionId === 'string' && localRecord.relayContributionId.length > 0;

  if (hasStoredRelayId && response.relayContributionId !== localRecord.relayContributionId) {
    return { kind: 'real_error', reason: 'cross_contribution_id_collision' };
  }

  const currentFingerprint = computePayloadFingerprintExcludingAppendix(currentPayload);
  if (currentFingerprint !== localRecord.lastSubmittedFingerprintExcludingAppendix) {
    return { kind: 'real_error', reason: 'content_changed_but_id_reused' };
  }

  return { kind: 'idempotent_success' };
}

function duplicateRealErrorMessage(reason: DuplicateRealErrorReason): string {
  if (reason === 'cross_contribution_id_collision') {
    return 'A different contribution was found for this duplicate response. Please open a fresh submission.';
  }
  return 'This submission content changed after the previous attempt. Please open a fresh submission.';
}

// ─── GitHub path ────────────────────────────────────────────────────

async function submitViaGitHub(
  contribution: ConnectorContribution,
  _effectiveAttributionMode: 'github',
  _buildContext: BuildContext,
): Promise<SubmitContributionResult> {
  log.info(
    { contributionId: contribution.id, connectorName: contribution.connectorName },
    'Contribution GitHub submission path disabled by OSS content scrub',
  );
  return failure(
    'GITHUB_SUBMISSION_UNAVAILABLE',
    'GitHub account submission is not available in this build. Use Rebel-name or anonymous sharing instead.',
  );
}

// ─── Relay path ─────────────────────────────────────────────────────

function buildRelaySubmitSuccessResult(
  relayData: RelayDuplicateDetails & { duplicate?: boolean },
  skippedDenylisted: string[],
): Extract<SubmitContributionResult, { success: true }> {
  return {
    success: true,
    prUrl: relayData.prUrl,
    prNumber: relayData.prNumber,
    ...(relayData.duplicate ? { duplicate: true } : {}),
    ...(skippedDenylisted.length > 0 ? { skippedDenylisted } : {}),
  };
}

function persistRelaySubmitSuccess(
  contribution: ConnectorContribution,
  effectiveAttributionMode: Extract<AttributionMode, 'rebel-name' | 'anonymous'>,
  request: SubmitContributionRequest,
  relayData: RelayDuplicateDetails & { duplicate?: boolean },
  skippedDenylisted: string[],
  payloadFingerprint: string,
): SubmitContributionResult {
  const successResult = buildRelaySubmitSuccessResult(relayData, skippedDenylisted);
  const latest = getContributionById(contribution.id) as ContributionWithStage1Fields | undefined;
  if (
    latest?.relayContributionId === relayData.relayContributionId
    && latest.lastSubmittedFingerprintExcludingAppendix === payloadFingerprint
    && latest.status === 'submitted'
  ) {
    log.info(
      {
        contributionId: contribution.id,
        relayContributionId: relayData.relayContributionId,
      },
      'Relay submit persistence skipped because relayContributionId and fingerprint are already recorded',
    );
    return successResult;
  }

  try {
    const relayWrite = {
      prUrl: relayData.prUrl,
      status: 'submitted',
      relayContributionId: relayData.relayContributionId,
      attributionMode: effectiveAttributionMode,
      attributionName:
        effectiveAttributionMode === 'rebel-name'
          ? (request.desiredAttributionName ?? contribution.attributionName)
          : null,
      lastSubmittedFingerprintExcludingAppendix: payloadFingerprint,
    } as Parameters<typeof updateContribution>[1];
    const updated = updateContribution(contribution.id, relayWrite);

    if (updated === undefined) {
      log.error(
        {
          contributionId: contribution.id,
          relayContributionId: relayData.relayContributionId,
          prUrl: relayData.prUrl,
        },
        'Failed to persist relay submit result: contribution missing after relay success',
      );
      return { ...successResult, degraded: 'record-deleted' };
    }

    if (updated === null) {
      log.warn(
        {
          contributionId: contribution.id,
          relayContributionId: relayData.relayContributionId,
          prUrl: relayData.prUrl,
        },
        'PR created via relay but contribution status transition to submitted was rejected',
      );
      const persistedWithoutTransition = updateContribution(contribution.id, {
        prUrl: relayData.prUrl,
        relayContributionId: relayData.relayContributionId,
        attributionMode: effectiveAttributionMode,
        attributionName:
          effectiveAttributionMode === 'rebel-name'
            ? (request.desiredAttributionName ?? contribution.attributionName)
            : null,
        lastSubmittedFingerprintExcludingAppendix: payloadFingerprint,
      } as Parameters<typeof updateContribution>[1]);
      if (persistedWithoutTransition === undefined) {
        log.error(
          {
            contributionId: contribution.id,
            relayContributionId: relayData.relayContributionId,
            prUrl: relayData.prUrl,
          },
          'Failed to persist relay metadata after transition rejection: contribution missing',
        );
        return { ...successResult, degraded: 'record-deleted' };
      }
    }
  } catch (err) {
    log.error(
      {
        err,
        contributionId: contribution.id,
        relayContributionId: relayData.relayContributionId,
        prUrl: relayData.prUrl,
      },
      'Failed to persist relay submit result',
    );
    return { ...successResult, degraded: 'persistence-failed' };
  }

  return successResult;
}

async function submitViaRegisteredRelayPath(
  contribution: ConnectorContribution,
  effectiveAttributionMode: Extract<AttributionMode, 'rebel-name' | 'anonymous'>,
  request: SubmitContributionRequest,
  buildContext: BuildContext,
): Promise<SubmitContributionResult> {
  const relayExtension = getContributionRelayExtension();
  if (!relayExtension) {
    return failure(
      'RELAY_UNAVAILABLE_OSS_BUILD',
      'Contribution sharing through Rebel is not available in this build.',
    );
  }

  if (!contribution.localServerPath) {
    return failure('VALIDATION', 'No local server path set on this contribution');
  }

  let files: ConnectorFile[];
  let skippedDenylisted: string[];
  try {
    const readResult = await readConnectorFilesForSubmission(
      contribution.localServerPath,
      contribution.connectorName,
    );
    files = readResult.files;
    skippedDenylisted = readResult.skippedDenylisted;
  } catch (error) {
    if (error instanceof ContributionFileReadError) {
      log.warn(
        { contributionId: contribution.id, code: error.code, message: error.message },
        'Relay submit aborted: file read failed',
      );
      return failure('VALIDATION', error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      { contributionId: contribution.id, err: message },
      'Relay submit aborted: unexpected file read error',
    );
    return failure('INTERNAL', message);
  }

  if (skippedDenylisted.length > 0) {
    log.info(
      {
        contributionId: contribution.id,
        skippedDenylisted,
        skippedCount: skippedDenylisted.length,
      },
      'Relay submit: excluded denylisted files from contribution',
    );
  }

  const relayAttributionName = effectiveAttributionMode === 'rebel-name'
    ? (request.desiredAttributionName ?? contribution.attributionName)
    : undefined;
  const relayContribution: ConnectorContribution = {
    ...contribution,
    attributionMode: effectiveAttributionMode,
    ...(relayAttributionName !== undefined ? { attributionName: relayAttributionName } : {}),
  };
  if (effectiveAttributionMode === 'anonymous') {
    delete relayContribution.attributionName;
  }

  let relayRequestBody: RelaySubmitRequest | null = null;
  let payloadFingerprint: string | null = null;
  let priorFingerprintExcludingAppendix: string | undefined;
  try {
    const relaySubmitResult = await relayExtension.submit({
      contribution: relayContribution,
      files,
      buildContext,
      beforeSubmit: (requestBody) => {
        relayRequestBody = requestBody;
        payloadFingerprint = computePayloadFingerprintExcludingAppendix(requestBody);
        priorFingerprintExcludingAppendix =
          ((getContributionById(contribution.id) ?? contribution) as ContributionWithStage1Fields)
            .lastSubmittedFingerprintExcludingAppendix;
        try {
          const prewrite = updateContribution(contribution.id, {
            lastSubmittedFingerprintExcludingAppendix: payloadFingerprint,
          } as Parameters<typeof updateContribution>[1]);
          if (prewrite === undefined) {
            log.warn(
              { contributionId: contribution.id },
              'Relay submit prewrite skipped because contribution is missing before network submit',
            );
          }
        } catch (error) {
          log.warn(
            {
              contributionId: contribution.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Relay submit prewrite failed: fingerprint-only duplicate verification may degrade',
          );
        }
      },
    });
    relayRequestBody = relaySubmitResult.requestBody;
    const requestBodyForDuplicate = relayRequestBody;
    const submitPayloadFingerprint =
      payloadFingerprint ?? computePayloadFingerprintExcludingAppendix(relaySubmitResult.requestBody);
    payloadFingerprint = submitPayloadFingerprint;
    priorFingerprintExcludingAppendix ??=
      ((getContributionById(contribution.id) ?? contribution) as ContributionWithStage1Fields)
        .lastSubmittedFingerprintExcludingAppendix;

    const relayResponse = relaySubmitResult.response;
    if (!relayResponse.success) {
      if (relayResponse.error.code === 'DUPLICATE') {
        const duplicateDetails = extractRelayDuplicateDetails(relayResponse.error.details);
        if (duplicateDetails) {
          const localRecord = (getContributionById(contribution.id) ?? contribution) as ContributionWithStage1Fields;
          const resolution = resolveDuplicate(
            { relayContributionId: duplicateDetails.relayContributionId },
            {
              ...localRecord,
              lastSubmittedFingerprintExcludingAppendix: priorFingerprintExcludingAppendix,
            },
            requestBodyForDuplicate,
          );

          if (resolution.kind === 'idempotent_success') {
            const hasStoredRelayId =
              typeof localRecord.relayContributionId === 'string'
              && localRecord.relayContributionId.length > 0;
            if (!hasStoredRelayId) {
              log.warn(
                {
                  contributionId: contribution.id,
                  scenario: 'first_submit_retry_fingerprint_match',
                  relayContributionId: duplicateDetails.relayContributionId,
                },
                'Relay duplicate accepted via fingerprint-only first-submit retry path',
              );
            }

            return persistRelaySubmitSuccess(
              contribution,
              effectiveAttributionMode,
              request,
              { ...duplicateDetails, duplicate: true },
              skippedDenylisted,
              submitPayloadFingerprint,
            );
          }

          return failure('DUPLICATE', duplicateRealErrorMessage(resolution.reason));
        }

        if (typeof contribution.prUrl === 'string' && contribution.prUrl !== '') {
          return failure(
            'DUPLICATE',
            `This contribution has already been submitted — see ${contribution.prUrl}. Edits to an in-flight submission are not supported.`,
          );
        }
      }

      return failure(relayResponse.error.code, relayResponse.error.message);
    }

    const relayData = relayResponse.data;
    return persistRelaySubmitSuccess(
      contribution,
      effectiveAttributionMode,
      request,
      relayData,
      skippedDenylisted,
      submitPayloadFingerprint,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ContributionPrFormatterValidationError) {
      return failure('VALIDATION', message);
    }
    return failure('INTERNAL', message);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Route the contribution to the correct submit transport based on the
 * record's `attributionMode`. Never throws; always returns a typed
 * success/failure body.
 */
async function submitContributionInner(
  contributionId: string,
  request: SubmitContributionRequest,
): Promise<SubmitContributionResult> {
  const contribution = getContributionById(contributionId);
  if (!contribution) {
    log.warn({ contributionId }, 'submitContribution: contribution not found');
    return failure('NOT_FOUND', 'Contribution not found');
  }

  const effectiveAttributionMode =
    request.desiredAttributionMode ?? contribution.attributionMode;

  log.info(
    {
      contributionId,
      attributionMode: contribution.attributionMode,
      desiredAttributionMode: request.desiredAttributionMode,
      effectiveAttributionMode,
    },
    'Dispatching contribution submit',
  );

  if (
    effectiveAttributionMode === 'github' &&
    contribution.relayContributionId &&
    contribution.prUrl
  ) {
    return failure(
      'DUPLICATE',
      `This contribution was already submitted via Mindstone — see ${contribution.prUrl}. To open a separate GitHub PR, discard this contribution and start over.`,
    );
  }

  const buildContext = await collectBuildContext(contribution);

  if (effectiveAttributionMode === 'github') {
    return submitViaGitHub(contribution, effectiveAttributionMode, buildContext);
  }
  return submitViaRegisteredRelayPath(contribution, effectiveAttributionMode, request, buildContext);
}

export async function submitContribution(
  contributionId: string,
  request: SubmitContributionRequest = {},
): Promise<SubmitContributionResult> {
  const existingSubmission = inFlightSubmissions.get(contributionId);
  if (existingSubmission) {
    return existingSubmission;
  }

  const submissionPromise = submitContributionInner(contributionId, request)
    .finally(() => {
      inFlightSubmissions.delete(contributionId);
    });
  inFlightSubmissions.set(contributionId, submissionPromise);
  return submissionPromise;
}

// ─── Testing ────────────────────────────────────────────────────────

export function _getInFlightSubmissionCountForTesting(): number {
  return inFlightSubmissions.size;
}

export function _resetForTesting(): void {
  inFlightSubmissions.clear();
}
