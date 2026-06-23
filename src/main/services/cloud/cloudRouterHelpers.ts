/**
 * Pure helper functions extracted from cloudRouter.ts.
 *
 * State-free computation that doesn't depend on CloudRouter class state,
 * mutexes, timers, or listeners. Only the stateful coordinator remains
 * in cloudRouter.ts.
 */

import type { AgentEvent, AgentSession } from '@shared/types';
import { getKnownTurnIds, hasTerminalEvent, mergePerTurnMap, unionPerTurnMap, mergeMemoryStatusByTurn, deduplicateMessages, mergeEventsForDesktopPull } from '@core/services/sessionMergeUtils';
import { deriveSessionUpdatedAt } from '@shared/utils/conversationState';
import { isValidSeq } from '@shared/utils/eventIdentity';
import { isDefaultOrFallbackTitle, resolveAutoTitleMetadata } from '@core/services/conversationTitleService';
import { createScopedLogger } from '@core/logger';
import { deriveTurnLiveness, toPersistedBusyScalars } from '@core/services/conversationState';

const log = createScopedLogger({ service: 'cloudRouterHelpers' });

/**
 * Type guard for CloudServiceError.
 * Uses duck typing (name + code property) instead of instanceof, which is
 * fragile across module boundaries and in test environments with vi.mock.
 */
export function isCloudServiceError(err: unknown): err is { code: string; message: string; name: string } {
  if (!(err instanceof Error)) {
    return false;
  }

  const maybeCode = (err as Error & { code?: unknown }).code;
  return typeof maybeCode === 'string' && err.name === 'CloudServiceError';
}

/**
 * Returns true if the local session has turn IDs not present in the cloud session.
 * Derives known turns from both eventsByTurn keys and messages[].turnId for resilience
 * against partial persistence or migration edge cases.
 */
export function hasLocalOnlyTurns(local: AgentSession, cloud: AgentSession): boolean {
  const cloudTurnIds = getKnownTurnIds(cloud);
  const localTurnIds = getKnownTurnIds(local);

  if (localTurnIds.size === 0) return false;

  for (const turnId of localTurnIds) {
    if (!cloudTurnIds.has(turnId)) return true;
  }
  return false;
}

/** Highest valid (positive integer) event seq within a single turn's event array, or 0. */
function maxValidSeqForTurn(events: AgentEvent[] | undefined): number {
  let max = 0;
  for (const event of events ?? []) {
    if (isValidSeq(event.seq) && event.seq > max) {
      max = event.seq;
    }
  }
  return max;
}

/**
 * Returns true when the local session has content the cloud snapshot lacks —
 * either because local has a turn cloud doesn't know about (supersedes
 * `hasLocalOnlyTurns`), OR because for any shared turn local has more
 * non-user messages, OR a higher max valid event seq than cloud.
 *
 * This broadened predicate routes the destructive "else" branch in
 * `syncSessionFromCloud` through the additive `mergeSessionTurns` path
 * whenever local would lose content in a full-replace — e.g. when a
 * chronologically-newer-but-semantically-older cloud snapshot (updatedAt
 * bumped by a memory/activity push) has only the preamble while local holds
 * the completed final answer on the same turn.
 *
 * Precision rules:
 *  - Only "non-user" messages are counted per turn (role !== 'user'). Counting
 *    user messages would misfire because the user message is always shared.
 *  - The robust signal is per-turn MAX VALID EVENT SEQ, not array length. The
 *    bug is COUNT-STABLE: `mergeResultMessage` promotes an assistant message to
 *    `result` IN-PLACE (same id, same count), and a terminal/result event can be
 *    appended that raises the turn's max seq while the array length stays equal
 *    to cloud's. Comparing array lengths (or message counts) alone would miss
 *    that case and let the destructive full-replace drop the final answer. Max
 *    valid seq is monotonic per session, so local's having a higher per-turn max
 *    seq for a shared turn reliably means local has newer content cloud lacks.
 *  - Cloud-superset case (cloud has more) returns false — the safe (additive)
 *    merge is already sufficient for that direction.
 *
 * Fixes REBEL-6C0 / REBEL-6BZ. See
 * docs/plans/260622_fix-message-render-drop/PLAN.md Stage 1.
 */
export function localHasContentCloudLacks(local: AgentSession, cloud: AgentSession): boolean {
  // Case 1: local has a turn cloud doesn't know about (existing hasLocalOnlyTurns behavior)
  const cloudTurnIds = getKnownTurnIds(cloud);
  const localTurnIds = getKnownTurnIds(local);

  for (const turnId of localTurnIds) {
    if (!cloudTurnIds.has(turnId)) return true;
  }

  if (localTurnIds.size === 0) return false;

  // Case 2: for any shared turn, local has more non-user messages than cloud
  // (defense in depth — the count signal is NOT robust to the count-stable
  // in-place result promotion, so Case 3 is the primary signal).
  const localNonUserByTurn = new Map<string, number>();
  for (const msg of local.messages ?? []) {
    if (msg.role !== 'user') {
      localNonUserByTurn.set(msg.turnId, (localNonUserByTurn.get(msg.turnId) ?? 0) + 1);
    }
  }
  const cloudNonUserByTurn = new Map<string, number>();
  for (const msg of cloud.messages ?? []) {
    if (msg.role !== 'user') {
      cloudNonUserByTurn.set(msg.turnId, (cloudNonUserByTurn.get(msg.turnId) ?? 0) + 1);
    }
  }

  for (const turnId of localTurnIds) {
    if (!cloudTurnIds.has(turnId)) continue; // already handled above (local-only turn)
    const localCount = localNonUserByTurn.get(turnId) ?? 0;
    const cloudCount = cloudNonUserByTurn.get(turnId) ?? 0;
    if (localCount > cloudCount) return true;
  }

  // Case 3 (PRIMARY — catches the count-stable case): for any shared turn, local
  // has a higher max valid event seq than cloud. seq is monotonic per session, so
  // a higher local per-turn max seq means local has newer events cloud lacks even
  // when the event-array lengths are equal (e.g. cloud's stale streaming event vs
  // local's higher-seq terminal/result event).
  const localEvents = local.eventsByTurn ?? {};
  const cloudEvents = cloud.eventsByTurn ?? {};

  for (const turnId of localTurnIds) {
    if (!cloudTurnIds.has(turnId)) continue; // already handled above
    const localMaxSeq = maxValidSeqForTurn(localEvents[turnId]);
    const cloudMaxSeq = maxValidSeqForTurn(cloudEvents[turnId]);
    if (localMaxSeq > cloudMaxSeq) return true;
  }

  return false;
}

/** Strip desktop-renderer-only pending conversation annotations before cloud/mobile forwarding. */
export function stripConversationAnnotations(session: AgentSession): AgentSession {
  if (!('annotations' in session)) return session;
  if (session.annotations && session.annotations.length > 0) {
    log.warn(
      { sessionId: session.id, annotationCount: session.annotations.length },
      'stripConversationAnnotations: cloud-bound session unexpectedly carried annotations; stripping (this indicates a non-stripping client or contract violation)',
    );
  }
  const { annotations: _annotations, ...rest } = session;
  return rest;
}

/**
 * Resolve the title (and its paired auto-title metadata) for a desktop PULL of a
 * cloud session.
 *
 * Single source of truth for "is the local title safely auto-overwritable" on the
 * pull side, shared by both pull branches (the full-replacement branch in
 * cloudRouter.ts and — via the same `isDefaultOrFallbackTitle` predicate — the
 * turn-level `mergeSessionTurns` below). Keeps the local (desktop) title when it
 * is a real, manually-meaningful title; otherwise adopts the cloud's
 * auto-generated title and its paired metadata. The auto-title metadata always
 * travels WITH the winning title.
 *
 * Uses the broad `isDefaultOrFallbackTitle` predicate (matches auto-title
 * GENERATION eligibility), not the narrow exact-string default set, so a stale
 * local 'New Agent Run' / 'Conversation N' / first-message fallback can't pin a
 * placeholder over the cloud's real title.
 */
export function resolvePulledTitle(
  local: Pick<AgentSession, 'title' | 'messages' | 'autoTitleGeneratedAt' | 'autoTitleTurnCount'>,
  cloud: Pick<AgentSession, 'title' | 'messages' | 'autoTitleGeneratedAt' | 'autoTitleTurnCount'>,
): { title: AgentSession['title']; autoTitleGeneratedAt?: number; autoTitleTurnCount?: number } {
  const localTitleAutoOverwritable = isDefaultOrFallbackTitle(local.title ?? '', local.messages ?? []);
  // The winning title side is cloud when the local title is auto-overwritable,
  // otherwise local (a real / manual local title wins). The auto-title metadata
  // travels with the winning title as ONE unit; `resolveAutoTitleMetadata`
  // additionally repairs the equal-title case — both sides carry the same title
  // string but only one has the metadata (e.g. the renderer applied the cloud
  // title locally without the metadata) — by adopting whichever side has it.
  const winning = localTitleAutoOverwritable ? cloud : local;
  const losing = localTitleAutoOverwritable ? local : cloud;
  return {
    title: winning.title,
    ...resolveAutoTitleMetadata(winning, losing),
  };
}

/**
 * Merge cloud session into local session at the turn level.
 * - Messages: deduplicate by id (local wins on collision), sort by createdAt
 * - EventsByTurn: local wins for shared turns, cloud only for cloud-only turns
 * - Per-turn metadata maps: same strategy (local wins, cloud fills gaps)
 * - Desktop wins for: isBusy, activeTurnId, lastError, draft, all metadata
 * - CompactionBoundaries: desktop always wins (indices are relative to local message array)
 *
 * Returns null if no changes were needed (local already has everything cloud has).
 */
export function mergeSessionTurns(
  local: AgentSession,
  cloud: AgentSession,
  isTurnActive?: (turnId: string) => boolean,
): AgentSession | null {
  const localTurnIds = getKnownTurnIds(local);

  const mergedMessages = deduplicateMessages(local.messages ?? [], cloud.messages ?? [], 'authoritative-wins');
  const hasNewMessages = mergedMessages.length > (local.messages?.length ?? 0);

  const { merged: mergedEvents, hasNewEvents } = mergeEventsForDesktopPull(
    local.eventsByTurn ?? {},
    cloud.eventsByTurn ?? {},
  );

  // Memory-update status (260619): produced on cloud-executed turns too, so it
  // is an ASYNC/SPARSE artifact like the activity summary below and must survive
  // the catch-up pull — but its values are STATEFUL objects (running → terminal),
  // so it uses the union-with-terminal-beats-running resolver, not the
  // authoritative-absence mergePerTurnMap (which dropped a cloud terminal status
  // for a turn the desktop already knew). See mergeMemoryStatusByTurn.
  const mergedMemoryStatus = mergeMemoryStatusByTurn(
    local.memoryUpdateStatusByTurn,
    cloud.memoryUpdateStatusByTurn,
  );
  // Time-saved status stays primary-authoritative: it is produced ONLY on the
  // desktop surface (timeSavedService is not wired in cloud-service), so the
  // cloud never holds a value the desktop lacks for a shared turn — there is
  // nothing to drop. See src/main/index.ts broadcastTimeSavedStatus not-cloud-pushed note.
  const mergedTimeSavedStatus = mergePerTurnMap(
    local.timeSavedStatusByTurn,
    cloud.timeSavedStatusByTurn,
    localTurnIds,
  );
  // Per-turn AI activity summaries (260618 show-more-activity) are an ASYNC,
  // SPARSE artifact — unlike the sibling status maps above, "local knows the
  // turn but lacks this key" means "summary not generated/seen locally yet",
  // NOT "no summary". Renderer snapshots always include
  // `activitySummaryByTurn: { ... }`, so a shared turn where cloud has the
  // summary and local's map lacks that key is the common shape; the
  // authoritative-absence semantic of mergePerTurnMap would drop the
  // cloud-generated sentence (Failure Mode F2). Union by key instead: a turn's
  // summary survives if either side has it; local wins same-turn conflicts.
  const mergedActivitySummary = unionPerTurnMap(
    local.activitySummaryByTurn,
    cloud.activitySummaryByTurn,
  );

  // Whether the union pulled in a cloud-generated summary the local store
  // lacked. The live broadcast (session:activity-summary-generated) updates only
  // the renderer's in-memory store; the PERSISTED local store is updated solely
  // via this pull-merge write-back. So a metadata-only reconciliation — cloud
  // generated a summary for a turn the desktop already fully synced (no new
  // messages/events), while the desktop was offline and missed the live
  // broadcast — must still apply, or the summary is lost on disk and never
  // surfaces on a later session reload (F2 early-return gap). Scoped to this
  // async/sparse artifact only: the sibling status maps keep the prior
  // "no new messages/events ⇒ no update" semantic.
  const hasNewActivitySummary = mergedActivitySummary
    ? Object.keys(mergedActivitySummary).some(
        (turnId) => !(turnId in (local.activitySummaryByTurn ?? {})),
      )
    : false;

  // Whether the memory-status merge produced anything the local store lacks: a
  // turn whose merged status differs (by reference) from local's. Same F2
  // early-return reasoning as the activity summary above — a cloud-produced
  // memory status (or a running→terminal upgrade) for an already-synced turn
  // must persist through this pull write-back, since the live broadcast
  // (memory:update-status) can be missed offline. Reference inequality is exact
  // here: mergeMemoryStatusByTurn keeps local's object for unchanged turns and
  // adopts cloud's object only for new/changed turns.
  const hasNewMemoryStatus = mergedMemoryStatus
    ? Object.keys(mergedMemoryStatus).some(
        (turnId) => mergedMemoryStatus[turnId] !== local.memoryUpdateStatusByTurn?.[turnId],
      )
    : false;

  // Whether the resolved pull title/metadata differs from what the local store
  // already holds — a title-only (or equal-title metadata-only) reconciliation.
  // Like activity summaries (F2), the title live broadcast
  // (session:title-generated) updates only the renderer's in-memory store; the
  // PERSISTED local store is updated solely via this pull-merge write-back. So a
  // title-only reconciliation — cloud generated a real title for a turn the
  // desktop already fully synced (no new messages/events) while the desktop
  // missed the live broadcast — must still apply, or the title (or its metadata)
  // is lost on disk and never surfaces on a later session reload (F2 early-return
  // gap). Derived from the SAME shared `resolvePulledTitle` primitive used for the
  // actual write-back below, so the early-return condition can't drift from the
  // applied policy. This covers both the title-string change AND the equal-title
  // metadata-only repair (F1 metadata coherence). The sibling status maps keep the
  // prior "no new messages/events ⇒ no update" semantic.
  const resolvedPullTitle = resolvePulledTitle(local, cloud);
  const hasNewCloudTitle =
    resolvedPullTitle.title !== local.title ||
    resolvedPullTitle.autoTitleGeneratedAt !== local.autoTitleGeneratedAt ||
    resolvedPullTitle.autoTitleTurnCount !== local.autoTitleTurnCount;

  if (!hasNewMessages && !hasNewEvents && !hasNewActivitySummary && !hasNewMemoryStatus && !hasNewCloudTitle) return null;

  const mergedLiveness = deriveTurnLiveness(mergedEvents, Date.now(), {
    declaredActiveTurnId: local.activeTurnId ?? cloud.activeTurnId ?? null,
  });
  const controllerTurnActive = local.activeTurnId && isTurnActive
    ? isTurnActive(local.activeTurnId)
    : undefined;
  // If no controller signal is available (reloaded/crashed/cross-surface), the
  // projection stale timeout is the fallback heartbeat.
  let mergedScalars = toPersistedBusyScalars(mergedLiveness);
  const canSuppressStaleInterruptedWithController = controllerTurnActive === true &&
    local.activeTurnId != null &&
    !hasTerminalEvent(mergedEvents[local.activeTurnId]);
  if (canSuppressStaleInterruptedWithController && local.activeTurnId) {
    mergedScalars = {
      isBusy: true,
      activeTurnId: local.activeTurnId,
    };
  }

  return {
    ...local,
    messages: mergedMessages,
    eventsByTurn: mergedEvents,
    compactionBoundaries: local.compactionBoundaries,
    ...(mergedMemoryStatus && { memoryUpdateStatusByTurn: mergedMemoryStatus }),
    ...(mergedTimeSavedStatus && { timeSavedStatusByTurn: mergedTimeSavedStatus }),
    ...(mergedActivitySummary && { activitySummaryByTurn: mergedActivitySummary }),
    isBusy: mergedScalars.isBusy,
    activeTurnId: mergedScalars.activeTurnId,
    lastError: local.lastError,
    draft: local.draft,
    ...(local.interruptedTurnId && hasTerminalEvent(mergedEvents[local.interruptedTurnId]) && { interruptedTurnId: null }),
    // Canonical lifecycle field (non-null = Done).
    doneAt: local.doneAt,
    starredAt: local.starredAt,
    deletedAt: local.deletedAt,
    resolvedAt: local.resolvedAt,
    // Title + paired auto-title metadata via the shared `resolvePulledTitle`
    // primitive (same `isDefaultOrFallbackTitle` predicate as the full-replacement
    // branch in cloudRouter.ts) — local wins unless auto-overwritable, in which
    // case the cloud's real title and its metadata are adopted together; an
    // equal-title merge adopts whichever side has the metadata (F1 coherence).
    // This is the single source of truth for pull-side title policy; it can't
    // drift from the full-replacement branch OR from the `hasNewCloudTitle`
    // early-return gate above (both derive from the same `resolvedPullTitle`).
    title: resolvedPullTitle.title,
    autoTitleGeneratedAt: resolvedPullTitle.autoTitleGeneratedAt,
    autoTitleTurnCount: resolvedPullTitle.autoTitleTurnCount,
    updatedAt: deriveSessionUpdatedAt({
      messages: mergedMessages,
      createdAt: local.createdAt,
      draft: local.draft,
      annotations: local.annotations,
      isBusy: mergedScalars.isBusy,
      updatedAt: Math.max(local.updatedAt, cloud.updatedAt),
    }),
  };
}
