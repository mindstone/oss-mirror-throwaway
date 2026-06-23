/**
 * Cloud Event Channel
 *
 * Maintains a persistent WebSocket connection to the cloud service's event
 * endpoint (/api/events). Receives push events (approval requests, staged
 * call notifications, etc.) and dispatches them to the local renderer via
 * webContents.send() — the renderer doesn't know the event came from cloud.
 *
 * On connect, fetches all pending approvals via HTTP for catch-up (handles
 * events that arrived while the desktop was offline or the WS was disconnected).
 *
 * Reconnects automatically with exponential backoff on disconnection.
 */

import WebSocket from 'ws';
import { getBroadcastService } from '@core/broadcastService';
import { mergeEntries } from '@core/safetyActivityLogStore';
import type { ActivityLogEntry } from '@core/safetyActivityLogTypes';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from '@core/safetyActivityLogTypes';
import { isContractEnforcementOn } from '@shared/ipc/contractEnforcement';
import { BROADCAST_SCHEMAS } from '@shared/ipc/broadcasts';
import { createScopedLogger, type Logger } from '@core/logger';
import { getTokenSyncCoordinator } from '@core/setTokenSyncCoordinator';
import type { AppSettings, CloudAutomationDelta } from '@shared/types';
import { z } from 'zod';
import {
  ActivityLogEntrySchema,
  type SafetyActivityLogCloudSyncState,
} from '@shared/ipc/channels/safetyActivityLog';
import { getSettings, updateSettings } from '../../settingsStore';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
  SlackWorkspaceChangedSchema,
  SlackWorkspaceDisconnectedSchema,
} from '@shared/ipc/channels/slack';
import {
  backfillToolBlockSource,
  FileLocationSchema,
  legacyMissingLocation,
  ToolBlockSourceSchema,
  type FileLocation,
} from '@rebel/shared';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { detectPeerInstanceCount } from './multiRebelWorkspaceDetector';

const log = createScopedLogger({ service: 'cloudEventChannel' });

/**
 * Dedup `normalizeMemoryApproval` fallback warnings for the lifetime of this
 * process. Key = approvalId when available, else `filePath|spacePath` composite.
 * Per Invariant #14, `normalizeMemoryApproval` is the ONE main-side producer
 * permitted to emit `kind: 'legacy-missing-location'` — because it sits at a
 * cloud/desktop protocol boundary and acts as a consumer-equivalent shim.
 */
const normalizeMemoryApprovalFallbackWarned = new Map<string, boolean>();

function warnNormalizeMemoryApprovalFallbackOnce(params: {
  approvalId: string | undefined;
  filePath: string | undefined;
  spacePath: string | undefined;
  reason: string;
}): void {
  const key = params.approvalId && params.approvalId.length > 0
    ? `id:${params.approvalId}`
    : `compound:${params.filePath ?? ''}|${params.spacePath ?? ''}`;
  if (normalizeMemoryApprovalFallbackWarned.has(key)) {
    return;
  }
  normalizeMemoryApprovalFallbackWarned.set(key, true);
  log.warn(
    {
      approvalId: params.approvalId,
      reason: params.reason,
    },
    'normalizeMemoryApproval fell back to legacy-missing-location',
  );
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const TOKEN_PROVIDER_CHANGED_MAX_BYTES = 256;
const SAFETY_ACTIVITY_LOG_CLOUD_FETCH_TIMEOUT_MS = 15_000;

const TokenProviderChangedSchema = z.object({
  provider: z.string().min(1),
  accountKey: z.string().min(1),
  expiryEpochMs: z.number().finite(),
  mtimeMs: z.number().finite(),
  surfaceWrote: z.enum(['desktop', 'cloud']),
}).strict();

const SafetyActivityLogFetchResponseSchema = z.object({
  entries: z.array(z.unknown()),
});

// Outer-shape-only schema for the array-returning catch-up sources
// (`tool-safety:pending`, `tool-safety:staged-get-all`,
// `memory:get-pending-approvals`). Per-item validation is intentionally NOT
// done here — the existing per-item handling (status filter, normalize) stays
// unchanged; this only guards the response is an array at all.
const CatchUpArraySchema = z.array(z.unknown());

function hasTokenNamedField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasTokenNamedField(item));
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().includes('token')) {
      return true;
    }
    if (nestedValue && typeof nestedValue === 'object' && hasTokenNamedField(nestedValue)) {
      return true;
    }
  }
  return false;
}

interface SlackWorkspaceSettingsMirrorDeps {
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  log: Logger;
}

let slackWorkspaceSettingsMirrorDepsOverride: SlackWorkspaceSettingsMirrorDeps | null = null;

function slackWorkspaceSettingsMirrorDeps(): SlackWorkspaceSettingsMirrorDeps {
  return slackWorkspaceSettingsMirrorDepsOverride ?? {
    getSettings,
    updateSettings,
    log,
  };
}

export function __setSlackWorkspaceSettingsMirrorDepsForTesting(
  deps: SlackWorkspaceSettingsMirrorDeps | null,
): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    slackWorkspaceSettingsMirrorDepsOverride = deps;
  }
}

/**
 * ALLOWLIST of channels the cloud is permitted to push to the desktop renderer
 * via WebSocket events. Any channel NOT in this set is silently dropped —
 * desktop is authoritative by default.
 *
 * This is safer than a denylist: new channels default to blocked, so a forgotten
 * entry can't silently corrupt local state. Only channels that are known-safe
 * (approvals, notifications, staging events) should be listed here.
 *
 * Note: `cloud:session-changed` is intercepted BEFORE this check (handled by
 * sessionChangeInterceptor in the main process, never forwarded to renderer).
 *
 * Related: CLOUD_CHANNEL_POLICIES in @shared/cloudChannelPolicies.ts governs
 * the opposite direction (desktop → cloud routing). Both must be maintained.
 *
 * @see docs/plans/partway/260224_cloud_sync_safety_hardening.md
 * @internal
 */
export const CLOUD_PUSH_ALLOWLIST = new Set([
  'tool-safety:approval-request',
  // Resolution notifications: cleared by approvalReEvalService AND by
  // cleanupPendingApprovals on turn-end. Desktop clients listening to a cloud
  // session need these so the Notifications drawer drops stale entries after
  // the cloud-side turn moves on.
  // See: docs-private/investigations/260416_stale_pending_approvals_when_conversation_moves_on.md
  'tool-safety:approval-resolved',
  'tool-safety:staged-call',
  // Staged-call status update (executed / failed / rejected / expired). Emitted by
  // safetyHandlers (tool-safety:staged-execute / -execute-batch / -reject — all
  // cloud-routable IPC, registerSafetyHandlers runs on cloud) and by approvalReEvalService.
  // A cloud-connected surface (mobile/web) that executes or rejects a staged call fires this
  // on the cloud; without this entry the desktop drops it and the staged-call card never
  // leaves its 'pending' status until a reload. Sibling of the allowlisted
  // tool-safety:staged-call above; transient renderer-UI-only signal ({id, sessionId, status,
  // result?}) — no persisted session field, so allowlist-only (no merge predicate). Desktop
  // consumers: useStagedToolCalls / usePendingApprovals. See
  // docs/plans/260620_cloud-sync-latent-gaps/ (Stage 4 / Amendment A2).
  'tool-safety:staged-call-updated',
  // Safety-eval progress signal: desktop clients attached to a cloud session
  // need these to render the "Checking this is safe…" subline on running tool
  // rows. Transient-UI-only, paired and cleared on `-complete`.
  'tool-safety:evaluating',
  'tool-safety:evaluating-complete',
  'memory:file-staged',
  'memory:write-approval-request',
  // Memory-write approval resolution notification. Emitted by the cloud-wired memoryWriteHook
  // (createMemoryWriteHook is wired into cloud turns in cloud-service/src/bootstrap.ts) when a
  // superseded approval is cleaned up, and by memoryHandlers / approvalReEvalService. Desktop
  // clients listening to a cloud session need these so the pending-memory-approval card drops
  // after the cloud-side turn supersedes/moves on (same "drop a stale card" reason as the
  // allowlisted tool-safety:approval-resolved sibling). Transient renderer-UI-only signal
  // ({toolUseId, originalSessionId, approved}) — no persisted session field, so allowlist-only
  // (no merge predicate). Desktop consumers: useMemoryApproval / usePendingApprovals /
  // usePendingMemoryApprovals / useAutomationApprovals. See
  // docs/plans/260620_cloud-sync-latent-gaps/ (Stage 4 / Amendment A2).
  'memory:write-approval-resolved',
  'memory:staged-files-changed',
  'memory:update-status',
  'error-recovery:state',
  // Session conflict signal for non-blocking conflict badges in renderer headers.
  'cloud:session-conflict',
  // Cross-surface safety-prompt invalidation (Stage 0 of
  // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md).
  // Emitted by safetyPromptHandlers on every write; allows every connected
  // surface to invalidate stale in-memory copies.
  'safety-prompt:updated',
  'safety-prompt:rule-persisted',
  // Behind-the-scenes structured-output bypass notice. Surfaces a one-time
  // toast when the resolver silently swaps the user's chosen profile for the
  // default auxiliary model because of a stored `jsonCompatibility:
  // 'incompatible'` flag. See src/shared/ipc/channels/bts.ts.
  'bts:structured-output-bypassed',
  // Stage 6: unified external conversation adapter webhook delivery failure
  'external-delivery:failed',
  // Slack workspace-level lifecycle events (no session provenance by design).
  'slack:workspace-changed',
  'slack:workspace-disconnected',
  // External conversation intents emitted by cloud-side Slack webhooks. These
  // payloads are schema-owned by the existing preload subscriptions and only
  // carry the conversation id, prompt text, and sanitized external context.
  'conversations:start-requested',
  'intent:external-context-arrived',
  'intent:buffered-message',
  'intent:buffer-drained',
  // Route-plan resolution: cloud-executed turns must update the desktop
  // renderer's route label cache so the Settings → Models route status line
  // stays in sync. Payload is validated against AgentRoutePlanResolvedEventSchema
  // (see src/shared/agentEvents.ts and BROADCAST_SCHEMAS in
  // src/shared/ipc/broadcasts.ts).
  'agent:route-plan-resolved',
  // Per-turn AI activity summary live swap-in (260618 show-more-activity).
  // A cloud-executed turn generates the one-sentence summary in the shared core
  // dispatcher (agentEventDispatcher.ts → session:activity-summary-generated)
  // and emits via the cloud broadcaster. Without this entry the cloud-originated
  // broadcast is dropped here and the collapsed-disclosure label never swaps from
  // the deterministic count-line to the AI sentence until a reload. Transient,
  // renderer-UI-only signal (sessionId/turnId/summary). See
  // docs/plans/260618_show-more-activity/.
  'session:activity-summary-generated',
  // Cloud-generated conversation title live swap-in (260618
  // fix-autotitle-cloud-livesync). A cloud-executed turn generates the title in
  // the shared core dispatcher (agentEventDispatcher.ts →
  // session:title-generated) and emits via the cloud broadcaster. Without this
  // entry the cloud-originated broadcast is dropped here and the desktop sidebar
  // keeps showing the placeholder/fallback title until a reload. Sibling of
  // session:activity-summary-generated above; both have the same metadata-only,
  // renderer-UI-only risk profile. Payload is metadata-only
  // ({sessionId, title, autoTitleGeneratedAt?, autoTitleTurnCount?}) — no user
  // content, no tokens. See docs/plans/260618_fix-autotitle-cloud-livesync/.
  'session:title-generated',
  // OAuth token-sync metadata signal. Never forwarded to renderer — consumed
  // only by main-process token sync coordinator.
  'tokens:provider-changed',
]);

// Note: `automation:cloud-delta` is INTENTIONALLY not in the allowlist. It is
// intercepted before the allowlist check (same pattern as `cloud:session-changed`
// and `inbox:changed`) — the main-process automation scheduler merges the delta
// into its state and re-broadcasts via `automation:state` so the renderer never
// needs the raw delta event. See docs-private/investigations/260515_cloud_automation_bugs.md § BUG 1+11.

// ─── Explicitly NOT cloud-pushed (the companion of CLOUD_PUSH_ALLOWLIST) ───
// The channel-named `not-cloud-pushed:` exemptions below classify every cloud→desktop broadcast
// emit-site — `broadcastToAllWindows`, `getBroadcastService().sendToAllWindows`, and the cloud-side
// `cloudEventBroadcaster.broadcast(...)` (core + main + cloud-service) — and are read by the audit
// tool (scripts/check-cloud-push-allowlist-coverage.ts, PM 260618_autotitle_cloud_livesync_allowlist_merge_gap
// rec 2): a channel is either in CLOUD_PUSH_ALLOWLIST above OR carries a channel-named exemption.
// MOST channels are exempt because a CLOUD-EXECUTED turn cannot produce them — their producing
// service runs ONLY in the Electron main process (not wired in cloud-service/src/bootstrap.ts,
// not on the shared core turn-execution path), so an allowlist entry would be dead config
// implying a capability that doesn't exist (the reasoning the `time-saved:status` exemption
// documents in detail at its emit-site). A few are exempt for OTHER reasons — intercepted before
// the allowlist check, delivered via an alternative path, or (the three labelled "KNOWN cloud→desktop
// DATA-SYNC GAP" below) cloud-reachable but only emitting a payload-less refresh of a desktop-local
// store, so allowlisting would be a moot/false-confidence fix; those carry a tracked follow-up.
// Each comment states its specific reason. Verified 260620 (3 cross-family research agents + Chief
// cross-check; see docs/plans/260620_cloud-sync-latent-gaps/).
// not-cloud-pushed: plugins:navigate — Electron plugin-system navigation IPC; no cloud plugin runtime.
// not-cloud-pushed: plugins:unregister — Electron plugin-system lifecycle IPC; main-process only.
// not-cloud-pushed: safe-mode:state — desktop-process safe-mode context; not a cloud concept.
// not-cloud-pushed: inbox:state — a cloud turn CAN emit inbox:state, but it is intentionally NOT allowlisted: `inbox:changed` is the cloud→desktop carrier (intercepted above → main scheduler pulls/merges → onInboxStateChange re-broadcasts inbox:state to the renderer LOCALLY), so a direct inbox:state push would be redundant. (Verified 260620 by both cross-family reviewers.)
// not-cloud-pushed: user-tasks:state — onUserTasksStateChange is not wired in cloud-service/src/bootstrap.ts; desktop-only.
// not-cloud-pushed: coaching:reflection — sessionCoachingScheduler runs only in the Electron main process (local session-analysis scheduler), not on cloud.
// not-cloud-pushed: library:skill-improvement-complete — produced via TimeSavedService, which no-ops on cloud (not initialized in cloud-service/src/bootstrap.ts; cf. time-saved:status).
// not-cloud-pushed: community:share-eligible — produced via TimeSavedService (desktop-only); same reasoning as library:skill-improvement-complete.
// not-cloud-pushed: community:state — CommunityHighlightsService is explicitly unavailable on cloud (cloud-service/src/bootstrap.ts throws getCommunityHighlightsService).
// not-cloud-pushed: hero-choice:updated — HeroChoiceScheduler is not wired in cloud-service/src/bootstrap.ts; desktop-only.
// not-cloud-pushed: daily-spark:updated — DailySparkScheduler is initialized only in the Electron main process; desktop-only.
// not-cloud-pushed: conflict-cleanup:available — desktop-local cloud-drive FS conflict-cleanup recovery; main-process only.
// not-cloud-pushed: system:resource-warning — Electron app resource detection (main-process diagnostics); not cloud-producible.
// not-cloud-pushed: diagnostics:update — main-process diagnostics, requires app.isReady(); desktop-only.
// not-cloud-pushed: bug-report:status — Electron bug-report/Sentry submission status; main-process only.
// not-cloud-pushed: library:changed — LibraryBroadcaster subscribes to workspaceWatcherService, which is not wired on cloud; desktop-only.
// not-cloud-pushed: shared-drive:health-warning — local shared-drive FS health checks (main-process); desktop-only.
// not-cloud-pushed: library:shared-space-created — SharedDriveService is a desktop-main-only service (not wired in cloud-service/src/bootstrap.ts).
//
// ─── INTERCEPTED before the allowlist check (handled in main, never forwarded to the renderer) ───
// dispatchToRenderer routes these to a main-process interceptor BEFORE CLOUD_PUSH_ALLOWLIST, so they
// are DECLARED (handled), not gaps. Precedent: the inbox:state exemption above documents the sibling
// re-broadcast side of this pattern. (slack:workspace-changed / slack:workspace-disconnected are also
// intercepted — mirrored into settings — but they ARE allowlisted, so they need no exemption here.)
// not-cloud-pushed: cloud:session-changed — intercepted in dispatchToRenderer → sessionChangeInterceptor merges the cloud session delta into the local store and re-broadcasts cloud:sessions-synced LOCALLY; never forwarded to the renderer.
// not-cloud-pushed: inbox:changed — intercepted in dispatchToRenderer → inboxChangedInterceptor triggers a main-process inbox pull/merge that re-broadcasts inbox:state LOCALLY; never forwarded to the renderer (sibling of the inbox:state exemption above).
// not-cloud-pushed: automation:cloud-delta — intercepted in dispatchToRenderer → cloudAutomationDeltaBridge merges the delta into the scheduler state and re-broadcasts automation:state LOCALLY; never forwarded to the renderer. See docs-private/investigations/260515_cloud_automation_bugs.md § BUG 1+11.
//
// ─── Desktop cloud-sync coordinator status (cloud:* family) — desktop→desktop, never cloud-turn output ───
// cloudRouter / cloudFailureCooldown / cloudWorkspaceSync / cloudStagingBridge / cloudUpdateScheduler /
// cloudHandlers all live in src/main (0 cloud-service/src/bootstrap.ts imports); they report the
// DESKTOP's own view of its cloud-sync to its own renderer. Structurally impossible for a cloud turn
// to produce. (Research: infra/coordinator subset, conf 90-97.)
// not-cloud-pushed: cloud:circuit-state — cloudFailureCooldown is the desktop's cloud-sync circuit breaker (src/main only); desktop→desktop status, never produced by a cloud turn.
// not-cloud-pushed: cloud:continuity-changed — emitted by cloudHandlers/cloudRouter (desktop cloud-sync coordinator, src/main only); reports the desktop's own continuity state, not cloud-turn output.
// not-cloud-pushed: cloud:folders-restored — cloudRouter (desktop cloud-sync coordinator, src/main only) reports its own folder-restore result; not cloud-producible.
// not-cloud-pushed: cloud:machine-health — cloudRouter (src/main only) reports the desktop's view of cloud-machine health; not emitted by a cloud-executed turn.
// not-cloud-pushed: cloud:outbox-changed — cloudOutbox/cloudRouter (src/main only) report the desktop's local push-outbox status; the outbox is a desktop construct, not cloud-producible.
// not-cloud-pushed: cloud:repair-machine-progress — cloudHandlers (src/main only) reports desktop-initiated machine-repair progress; not cloud-producible.
// not-cloud-pushed: cloud:update-status — cloudUpdateScheduler is initialized only in the Electron main process; reports the desktop's view of the cloud-machine update, not a cloud-turn signal.
// not-cloud-pushed: cloud:workspace-conflicts — cloudWorkspaceSync/cloudStagingBridge (src/main only) detect local workspace↔cloud file conflicts on the desktop; not cloud-producible.
// not-cloud-pushed: cloud:workspace-pending-updates — cloudWorkspaceSync (src/main only) reports the desktop's pending local workspace updates; not cloud-producible.
// not-cloud-pushed: cloud:sessions-synced — emitted LOCALLY by cloudRouter (src/main only) after the cloud:session-changed interceptor merges into the local store (and on local pull-sync); the cloud→desktop carrier is the intercepted cloud:session-changed, so a direct push would be redundant.
// not-cloud-pushed: cloud:session-tombstoned — emitted by cloud-service alongside cloud:session-changed (action:'deleted') after a tombstone; cloud:session-changed is the intercepted cloud→desktop carrier and this channel has NO desktop renderer consumer (no preload subscription), so forwarding it would have nowhere to go. (260620: surfaced by extending the scan to cloud-service/src.)
// NOTE (cloud:session-event): a 4th member of the closed CloudBroadcast union (cloudSessionMergeService, per incoming turn-event) reaches the cloud→desktop fan-out ONLY via the cloud-service/src/routes/sessions.ts event.channel forwarder — there is no literal emit-site for it (so it gets no channel-keyed not-cloud-pushed: exemption, which would read as perpetually "stale"). It is NOT allowlisted, NOT intercepted, and has NO desktop receive path: the desktop converges cloud session deltas via the intercepted cloud:session-changed → sessionChangeInterceptor → local store merge/pull (cloudRouter onSessionChanged), NOT per-event streaming, so an un-allowlisted cloud:session-event is dropped at the receive end by design. Documented + reviewed at the sessions.ts forwarder (dynamic-broadcast-reviewed). (260620, Stage 3.)
//
// ─── Desktop-local runtimes / services not wired on cloud ───
// not-cloud-pushed: local-inference:download-progress — ollamaModelManager/ollamaRuntimeManager are desktop-local Ollama runtimes (src/main only, spawn a local binary); cloud has no local-inference runtime.
// not-cloud-pushed: local-inference:status-changed — ollamaService is a desktop-local Ollama runtime (src/main only); not wired in cloud-service/src/bootstrap.ts.
// not-cloud-pushed: skill-notifications:changed — skillChangeNotificationService.attachManagedWriteObserver() is wired only via libraryHandlers (src/main, not in cloud-service/src/bootstrap.ts); without the observer the emit cannot fire on cloud.
// not-cloud-pushed: super-mcp:restart-deferred — superMcpHttpManager CAN run on cloud, but this is a UX-only signal scoped to a LOCAL desktop-initiated connector operation: the renderer (UnifiedConnectionsPanel) only acts when its locally-tracked deferredOp matches the event context, and the cloud emit contexts ('cloud-auth-relay'/'cloud-oauth-mcp-config-change') never match a desktop operation. A cloud-originated deferral has no desktop operation to update.
// not-cloud-pushed: app-bridge:pending-approval-updated — appBridgeManager (desktop device-pairing bridge) is not wired in cloud-service/src/bootstrap.ts. Unrelated to the tool-safety approval flow (that uses tool-safety:approval-request, already allowlisted).
// not-cloud-pushed: dashboard:use-cases-ready — emitted by dashboard:generate-use-cases / dashboard:parse-use-cases; those channels are NOT cloud-routable (absent from CLOUD_CHANNEL_POLICIES and the cloud IPC allowlist), so the handler is unreachable on cloud despite registerDashboardHandlers running there.
//
// ─── Achievements: core store, but every recording caller is Electron-main (not the cloud turn dispatcher) ───
// achievementsStore is core, but the broadcasts are triggered ONLY by Electron-main callers
// (achievementsEvaluator, agentMessageHandler, IPC handlers); none are wired/invoked on the cloud
// turn path (cloud uses dispatchAgentEvent, not agentMessageHandler's completion hooks). One shared reason.
// not-cloud-pushed: achievements:streak-updated — core achievementsStore broadcast triggered only by Electron-main callers (achievementsEvaluator/agentMessageHandler/IPC handlers); not on the cloud turn path.
// not-cloud-pushed: achievements:streak-milestone — same as achievements:streak-updated (desktop achievement completion hooks, not the cloud turn dispatcher).
// not-cloud-pushed: achievements:journey-day-completed — same as achievements:streak-updated (desktop achievement/UI IPC path, not cloud-turn output).
// not-cloud-pushed: achievements:badge-unlocked — same as achievements:streak-updated (desktop achievementsEvaluator, not cloud-turn output).
// not-cloud-pushed: achievements:tier-unlocked — same as achievements:streak-updated (desktop achievement evaluation, not cloud-turn output).
//
// ─── Cloud-reachable producer but exempt on a non-producer criterion ───
// not-cloud-pushed: agent:event — cloud turn events stream to the desktop over the dedicated per-turn /api/agent/turn WS (cloudServiceClient.runTurn → onEvent → dispatchAgentEvent), which re-broadcasts agent:event LOCALLY; cloudEventBroadcaster intentionally excludes this channel, so the broadcaster path is not the delivery vehicle.
// not-cloud-pushed: conversations:send-requested — emitted from the bundled inbox-bridge HTTP server (src/main/services/bundledInboxBridge.ts) and desktop-only plugin/MCP-App handlers; the bundled bridge is not wired in cloud-service/src/bootstrap.ts. (Contrast conversations:start-requested, which IS allowlisted because cloud-side Slack webhooks emit it.)
// not-cloud-pushed: memory:checkpoint-integrity-violation — the cloud-wired memoryWriteHook CAN emit this audit signal, but it has NO desktop consumer (no preload subscription, no renderer listener), so allowlisting would forward an event with nowhere to go. (If a consumer is later added, revisit.)
// not-cloud-pushed: meeting:coaching-card — emitted only by the deprecated cloud meeting-coaching shim (cloud-service/src/services/meetingCoachingEngine.ts); the desktop never wires broadcastCoachingCard to this channel and has NO preload subscription for it (the SessionCoachingCard surface reads coaching:reflection / misc:get-coaching-for-session), so forwarding it would have nowhere to go. (260620: surfaced by extending the scan to cloud-service/src.)
//
// ─── Resolved-constant channels: desktop-only (260620 named-constant resolution surfaced these) ───
// not-cloud-pushed: mcp:permission-changed — mcpAppsHandlers (src/main IPC) emits this on permission grant/revoke; not wired on the cloud turn path.
// not-cloud-pushed: connector:status-changed — appBridgeManager (desktop device-pairing bridge, src/main) emits connector status; not wired in cloud-service/src/bootstrap.ts.
// not-cloud-pushed: cloud:drive-aware-sync-deferred — cloudWorkspaceSync (desktop cloud-sync coordinator, src/main only) reports a deferred local drive-aware sync; not cloud-producible.
// not-cloud-pushed: meeting:trigger-detected — botQAService/meetingBot is a desktop microphone feature (src/main); not wired on cloud.
// not-cloud-pushed: cloud:status-changed — cloudConnectionReconciler is wired only in src/main; reports the desktop's own cloud-connection status, not cloud-turn output.
// not-cloud-pushed: cloud:pressure-state — cloudConnectionReconciler (src/main only) reports the desktop's own cloud-connection backpressure state; not cloud-producible.
//
// ─── KNOWN cloud→desktop DATA-SYNC GAPs — cloud-reachable, but NOT allowlist-fixable ───────────────
// These three channels CAN be emitted by a cloud-executed turn AND have a desktop renderer consumer,
// but the broadcast is a PAYLOAD-LESS refresh signal whose backing store is desktop-local with NO
// cloud→desktop data sync. Allowlisting the bare refresh would make the desktop re-read its OWN store
// (which lacks the cloud-side write) — a MOOT / false-confidence "fix" (the exact anti-pattern the
// origin postmortem warns about). The real fix is a cloud→desktop DATA-sync path for each store,
// tracked as a follow-up in docs/plans/260620_cloud-sync-latent-gaps/PLAN.md § Discovered Improvements.
// Do NOT "fix" these by adding them to CLOUD_PUSH_ALLOWLIST.
// not-cloud-pushed: safety-activity-log:updated — STILL intentionally not allowlisted, but the
// cloud→desktop gap this once flagged is now CLOSED via an explicit catch-up (FU-1, SHIPPED — see
// docs/plans/260621_safety-log-cloud-sync/PLAN.md). The desktop PULLS cloud-turn safety entries
// through safety-activity-log:get (server-side CLOUD_IPC_ALLOWLIST only — NOT renderer-routable, which
// would mis-route the desktop's own read) on reconnect + panel open and merges them into the local
// store; a LOCAL safety-activity-log:updated then fires to refresh the open panel. Forwarding the
// CLOUD's payload-less :updated push would still be moot (it carries no data — the catch-up :get is
// what carries the entries), so it stays off the allowlist by design.
// Cloud producers covered by the catch-up: tool-safety evaluations (toolSafetyService) and
// memory-write checkpoints (memoryWriteHook) write EvaluationEntry rows; safety-prompt version
// changes (registerSafetyPromptHandlers, cloud-wired, reached by mobile/web) write VersionChangeEntry
// rows — all flow to the desktop via the :get catch-up + mergeEntries.
// not-cloud-pushed: settings:external-update — KNOWN cloud→desktop DATA-SYNC GAP, not allowlist-fixable. learnedProfileWriter on a cloud turn CAN emit this, but cloudRouter.pullSettings() is an intentional no-op (no cloud→desktop settings/profile data sync); forwarding the payload-less refresh would re-read local settings that lack the cloud-side write (moot). See docs/plans/260620_cloud-sync-latent-gaps/PLAN.md § Discovered Improvements FU-2.
// not-cloud-pushed: cooldown:status-changed — KNOWN cloud→desktop DATA-SYNC GAP, not allowlist-fixable. A cloud turn's rate-limit/success (apiRateLimitCooldown on the turn path) CAN emit this, but the desktop's apiRateLimitCooldown is a SEPARATE per-surface singleton with no cloud→desktop cooldown sync; forwarding would surface the CLOUD's cooldown state in the desktop's global cooldown UI (a cross-surface design question, not a clean refresh). See docs/plans/260620_cloud-sync-latent-gaps/PLAN.md § Discovered Improvements FU-3.

interface CloudPushEvent {
  channel: string;
  args?: unknown[];   // webContents.send() arguments (spread on receive)
  payload?: unknown;  // legacy: single-arg shorthand (backwards compat)
}

type ApprovalInterceptor = (approval: Record<string, unknown>) => Promise<void> | void;
type MemoryApprovalInterceptor = (approval: Record<string, unknown>) => Promise<void> | void;
type SessionChangeInterceptor = (event: { sessionId: string; action: 'upserted' | 'deleted' }) => Promise<void> | void;
type InboxChangedInterceptor = () => void;
type StagingBridgeCallback = () => void;

class CloudEventChannel {
  private ws: WebSocket | null = null;
  private cloudUrl: string | null = null;
  private token: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private intentionalClose = false;
  private hasConnectedOnce = false;
  private approvalInterceptor: ApprovalInterceptor | null = null;
  private memoryApprovalInterceptor: MemoryApprovalInterceptor | null = null;
  private sessionChangeInterceptor: SessionChangeInterceptor | null = null;
  private inboxChangedInterceptor: InboxChangedInterceptor | null = null;
  private stagingBridgeCallback: StagingBridgeCallback | null = null;
  private reconnectCallback: (() => void) | null = null;

  /** Register a callback to store tool approval metadata locally when cloud approvals arrive. */
  onApprovalReceived(fn: ApprovalInterceptor): void {
    this.approvalInterceptor = fn;
  }

  /** Register a callback to store memory approval metadata locally when cloud memory approvals arrive. */
  onMemoryApprovalReceived(fn: MemoryApprovalInterceptor): void {
    this.memoryApprovalInterceptor = fn;
  }

  /** Register a callback to handle session-change events from the cloud (upserted/deleted). */
  onSessionChanged(fn: SessionChangeInterceptor): void {
    this.sessionChangeInterceptor = fn;
  }

  /** Register a callback to handle inbox-changed events from the cloud (triggers pull). */
  onInboxChanged(fn: InboxChangedInterceptor): void {
    this.inboxChangedInterceptor = fn;
  }

  /** Register a callback invoked after the WS reconnects and pending events are caught up. */
  onReconnect(fn: () => void): void {
    this.reconnectCallback = fn;
  }

  /**
   * Register a callback invoked when `memory:staged-files-changed` arrives from cloud.
   * The bridge callback runs async (fire-and-forget) to avoid blocking event dispatch.
   */
  onStagedFilesChanged(fn: StagingBridgeCallback): void {
    this.stagingBridgeCallback = fn;
  }

  connect(cloudUrl: string, token: string): void {
    this.teardownSocket();
    this.cloudUrl = cloudUrl.replace(/\/+$/, '');
    this.token = token;
    this.intentionalClose = false;
    this.hasConnectedOnce = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.openWebSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.teardownSocket();
    this.cloudUrl = null;
    this.token = null;
    this.sessionChangeInterceptor = null;
    this.inboxChangedInterceptor = null;
    this.stagingBridgeCallback = null;
    this.reconnectCallback = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async syncSafetyActivityLogFromCloud(): Promise<{
    cloudSyncState: SafetyActivityLogCloudSyncState;
  }> {
    if (!this.cloudUrl || !this.token) {
      return { cloudSyncState: 'not-configured' };
    }
    if (!this.isConnected) {
      return { cloudSyncState: 'offline' };
    }

    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    try {
      const result = await this.fetchIpc(
        'safety-activity-log:get',
        headers,
        [{ limit: SAFETY_ACTIVITY_LOG_MAX_ENTRIES }],
        SAFETY_ACTIVITY_LOG_CLOUD_FETCH_TIMEOUT_MS,
      );
      if (result === null) {
        return { cloudSyncState: 'failed' };
      }

      const response = SafetyActivityLogFetchResponseSchema.safeParse(result);
      if (!response.success) {
        log.warn(
          { error: response.error.flatten() },
          'Safety activity log cloud sync returned an invalid response shape',
        );
        return { cloudSyncState: 'failed' };
      }

      const validEntries: ActivityLogEntry[] = [];
      response.data.entries.forEach((entry, index) => {
        const parsed = ActivityLogEntrySchema.safeParse(entry);
        if (parsed.success) {
          validEntries.push(parsed.data);
          return;
        }
        log.warn(
          { index, error: parsed.error.flatten() },
          'Dropped malformed safety activity log entry from cloud sync',
        );
      });

      const fetched = response.data.entries.length;
      if (fetched > 0 && validEntries.length === 0) {
        // FU-D: every fetched row was dropped — a distinct schema-skew signal,
        // separate from the per-entry drop warns above. Contract is unchanged:
        // this still resolves `success`, merges `[]` (noop), and does NOT broadcast.
        log.warn(
          { fetched, channel: 'safety-activity-log:get' },
          'All cloud safety-activity-log entries dropped during catch-up — possible desktop/cloud schema skew',
        );
      }

      let added: number;
      try {
        ({ added } = mergeEntries(validEntries));
      } catch {
        return { cloudSyncState: 'failed' };
      }

      if (added > 0) {
        getBroadcastService().sendToAllWindows('safety-activity-log:updated', {
          timestamp: Date.now(),
        });
      }
      log.info(
        {
          fetched,
          valid: validEntries.length,
          added,
        },
        'Synced safety activity log entries from cloud',
      );
      return { cloudSyncState: 'success' };
    } catch (err) {
      log.warn({ err }, 'Failed to sync safety activity log from cloud');
      return { cloudSyncState: 'failed' };
    }
  }

  /**
   * Send an event payload to the cloud event-channel WebSocket.
   * Returns false when the socket is not currently open.
   */
  sendToCloud(event: CloudPushEvent): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'cloud_event_channel_send_to_cloud',
        reason: 'best-effort ws event send failures should not crash desktop sync',
      });
      log.warn({ err }, 'Failed to send cloud event-channel payload');
      return false;
    }
  }

  /** Force an immediate reconnect, clearing any pending backoff timer. */
  reconnectNow(): void {
    if (!this.cloudUrl || !this.token) return;
    this.teardownSocket();
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.intentionalClose = false;
    this.openWebSocket();
  }

  /**
   * Close the WebSocket and clear timers without clearing registered callbacks
   * or connection credentials. Used by connect() and reconnectNow() to tear down
   * the previous socket while preserving the callback registrations that the
   * cloudRouter set up before calling connect().
   */
  private teardownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.removeAllListeners();
      // Absorb errors emitted after listeners removed (e.g. closing a CONNECTING socket)
      oldWs.once('error', (error) => {
        log.debug(
          { err: error },
          'Ignored late websocket teardown error',
        );
      });
      try {
        if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
          oldWs.close(1000, 'Client disconnect');
        } else {
          oldWs.terminate();
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'cloud_event_channel_teardown_socket_close',
          reason: 'websocket may already be destroyed during teardown',
        });
      }
    }
  }

  private openWebSocket(): void {
    if (!this.cloudUrl || !this.token) return;

    const wsUrl = this.cloudUrl.replace(/^http/, 'ws') + '/api/events';
    log.info({ wsUrl }, 'Opening event channel WebSocket');

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10_000,
    });

    ws.on('open', () => {
      log.info({ isReconnect: this.hasConnectedOnce }, 'Event channel connected');
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Only fetch pending events on reconnect (not initial connect).
      // On initial connect the renderer loads its own state via IPC, which
      // already routes to cloud. Fetching here too would produce duplicates.
      if (this.hasConnectedOnce) {
        this.fetchPendingEvents().then(() => {
          this.reconnectCallback?.();
        }).catch(() => {
          // fetchPendingEvents handles its own errors; still invoke reconnect callback
          this.reconnectCallback?.();
        });
      }
      this.hasConnectedOnce = true;
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const event: CloudPushEvent = JSON.parse(data.toString('utf-8'));
        if (event.channel && event.args) {
          this.dispatchToRenderer(event.channel, event.args);
        } else if (event.channel && event.payload !== undefined) {
          // Backwards compat: single-arg payload
          this.dispatchToRenderer(event.channel, [event.payload]);
        } else {
          log.debug({ event }, 'Ignoring malformed event');
        }
      } catch (err) {
        log.warn({ err }, 'Failed to parse event channel message');
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const hostname = this.cloudUrl ? new URL(this.cloudUrl).hostname : 'unknown';
      log.info({ code, reason: reason?.toString(), hostname }, 'Event channel closed');
      this.ws = null;
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      const hostname = this.cloudUrl ? new URL(this.cloudUrl).hostname : 'unknown';
      log.warn({ err: err.message, hostname }, 'Event channel error');
    });

    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;

    const jitter = this.backoffMs * (0.75 + Math.random() * 0.5);
    log.info({ backoffMs: Math.round(jitter) }, 'Scheduling event channel reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, jitter);

    this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  /**
   * Fetch all pending approvals from cloud via HTTP on connect/reconnect.
   * This catches up on any events missed while the WS was disconnected.
   * Dispatches them as the same event types the renderer expects.
   */
  private async fetchPendingEvents(): Promise<void> {
    if (!this.cloudUrl || !this.token) return;

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    try {
      // The first three sources are array-returning channels validated at the
      // fetch seam by `fetchIpcParsed` + `CatchUpArraySchema` (a non-array
      // response is dropped loudly, returning null). The fourth,
      // `syncSafetyActivityLogFromCloud()`, is intentionally bespoke — it has its
      // own `{ entries }` object shape with per-entry `ActivityLogEntrySchema`
      // validation, `mergeEntries`-based delivery (not per-item renderer
      // dispatch), a 15s `AbortController` timeout, and a `cloudSyncState`
      // return. It already seam-validates its shape, so it is deliberately NOT
      // folded into the `fetchIpcParsed` array-source path.
      const [toolPending, stagedCalls, memoryPending, safetyLogSync] = await Promise.allSettled([
        this.fetchIpcParsed('tool-safety:pending', headers, CatchUpArraySchema),
        this.fetchIpcParsed('tool-safety:staged-get-all', headers, CatchUpArraySchema),
        this.fetchIpcParsed('memory:get-pending-approvals', headers, CatchUpArraySchema),
        this.syncSafetyActivityLogFromCloud(),
      ]);

      if (toolPending.status === 'fulfilled' && toolPending.value !== null) {
        for (const approval of toolPending.value) {
          this.dispatchToRenderer('tool-safety:approval-request', [approval]);
        }
        log.info({ count: toolPending.value.length }, 'Caught up on pending tool approvals');
      }

      if (stagedCalls.status === 'fulfilled' && stagedCalls.value !== null) {
        const pending = stagedCalls.value.filter((c) => (c as { status?: string }).status === 'pending');
        for (const call of pending) {
          this.dispatchToRenderer('tool-safety:staged-call', [call]);
        }
        log.info({ count: pending.length }, 'Caught up on pending staged calls');
      }

      if (memoryPending.status === 'fulfilled' && memoryPending.value !== null) {
        for (const approval of memoryPending.value) {
          this.dispatchToRenderer('memory:write-approval-request', [
            normalizeMemoryApproval(approval as Record<string, unknown>),
          ]);
        }
        log.info({ count: memoryPending.value.length }, 'Caught up on pending memory approvals');
      }

      if (safetyLogSync.status === 'rejected') {
        log.warn(
          { err: safetyLogSync.reason },
          'Safety activity log catch-up sync rejected',
        );
      }

      // Trigger staging bridge sync to pull any cloud-staged .pending.md files
      // that were created while the desktop was offline.
      this.stagingBridgeCallback?.();
    } catch (err) {
      log.warn({ err }, 'Failed to fetch pending events for catch-up');
    }
  }

  /**
   * Fetch a catch-up channel and validate its response shape against a required
   * schema. Returns the parsed value, or `null` when the fetch failed
   * (`fetchIpc` already logged) or the response shape was invalid. A wrong-shape
   * response is dropped LOUDLY (a deliberate observability strengthening over the
   * previous silent `Array.isArray` skip) so cloud/desktop response-shape drift
   * fails at the fetch seam instead of disappearing.
   */
  private async fetchIpcParsed<T>(
    channel: string,
    headers: Record<string, string>,
    schema: z.ZodType<T>,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<T | null> {
    const raw = await this.fetchIpc(channel, headers, params, timeoutMs);
    if (raw === null) return null;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ channel, error: parsed.error.flatten() }, 'IPC catch-up returned an invalid response shape');
      return null;
    }
    return parsed.data;
  }

  private async fetchIpc(
    channel: string,
    headers: Record<string, string>,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<unknown> {
    const url = `${this.cloudUrl}/api/ipc/${encodeURIComponent(channel)}`;
    const body = params === undefined ? '{}' : JSON.stringify({ params });
    const controller = timeoutMs === undefined ? null : new AbortController();
    const timeout =
      controller === null
        ? null
        : setTimeout(() => {
            controller.abort();
          }, timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller?.signal,
      });
      if (!resp.ok) {
        log.warn({ channel, status: resp.status }, 'IPC fetch failed during catch-up');
        return null;
      }
      return resp.json();
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }

  private dispatchToRenderer(channel: string, args: unknown[]): void {
    // For session-change events from cloud, route to the interceptor for local
    // cache sync. Do NOT dispatch to renderer — main process handles the sync
    // and sends `cloud:sessions-synced` once the local store is updated.
    if (channel === 'cloud:session-changed' && args[0] && typeof args[0] === 'object') {
      const event = args[0] as { sessionId?: string; action?: string };
      if (event.sessionId && (event.action === 'upserted' || event.action === 'deleted')) {
        fireAndForget(
          this.sessionChangeInterceptor?.(event as { sessionId: string; action: 'upserted' | 'deleted' }),
          'cloudEventChannel.sessionChangeInterceptor',
        );
      }
      return; // Handled by main process, not renderer
    }

    // For inbox-changed events from cloud, route to the interceptor for local
    // inbox pull sync. Do NOT dispatch to renderer — main process handles it.
    if (channel === 'inbox:changed') {
      this.inboxChangedInterceptor?.();
      return; // Handled by main process, not renderer
    }

    // For cloud-executed automation delta events, route to the automation
    // scheduler bridge so the desktop store mirrors lastRunAt/lastRunStatus/
    // nextRunAt and appends cloud run records into runs[]. Do NOT dispatch to
    // renderer — the scheduler re-broadcasts via `automation:state` after the
    // merge. See docs-private/investigations/260515_cloud_automation_bugs.md § BUG 1+11.
    if (channel === 'automation:cloud-delta' && args[0] && typeof args[0] === 'object') {
      void import('./cloudAutomationDeltaBridge')
        .then(({ applyAutomationCloudDelta }) => {
          applyAutomationCloudDelta(args[0] as CloudAutomationDelta);
        })
        .catch((err) => {
          log.warn({ err }, 'Failed to load cloud automation delta bridge');
        });
      return; // Handled by main process, not renderer
    }

    if (channel === 'tokens:provider-changed') {
      const payload = args[0];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        log.warn({ channel }, 'Dropped token sync signal with invalid payload shape');
        return;
      }

      if (hasTokenNamedField(payload)) {
        log.warn({ channel }, 'Dropped token sync signal containing token-like field names');
        return;
      }

      let payloadBytes = 0;
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'cloud_event_channel_token_signal_serialize',
          reason: 'drop malformed token signal payloads that cannot be serialized',
        });
        log.warn({ channel }, 'Dropped token sync signal with unserializable payload');
        return;
      }
      if (payloadBytes > TOKEN_PROVIDER_CHANGED_MAX_BYTES) {
        log.warn(
          { channel, payloadBytes, maxBytes: TOKEN_PROVIDER_CHANGED_MAX_BYTES },
          'Dropped oversized token sync signal payload',
        );
        return;
      }

      const parsed = TokenProviderChangedSchema.safeParse(payload);
      if (!parsed.success) {
        log.warn(
          { channel, error: parsed.error.flatten() },
          'Dropped token sync signal that failed schema validation',
        );
        return;
      }

      void getTokenSyncCoordinator().onPeerSignal({
        provider: parsed.data.provider,
        accountKey: parsed.data.accountKey,
        expiryEpochMs: parsed.data.expiryEpochMs,
        mtimeMs: parsed.data.mtimeMs,
        surfaceWrote: parsed.data.surfaceWrote,
      }).catch((err) => {
        log.warn({ err }, 'Token sync peer-signal handling failed');
      });
      return; // main-process only, never renderer
    }

    const slackWorkspaceMirrorResult = mirrorSlackWorkspaceEventIntoSettings(channel, args);
    if (slackWorkspaceMirrorResult === 'dropped-invalid') {
      return;
    }

    // ALLOWLIST: only forward channels that are known-safe for cloud to push.
    // Everything else is dropped — desktop is authoritative by default.
    if (!CLOUD_PUSH_ALLOWLIST.has(channel)) {
      log.debug({ channel }, 'Blocked cloud push event — channel not in allowlist');
      return;
    }

    // Suppress conflict events that originated from this desktop's own push.
    // The cloud broadcasts conflicts to ALL WS clients, but the pushing
    // desktop already has its local state — showing "Edited elsewhere" for
    // its own writes is a false positive. Conflicts from other surfaces
    // (mobile, other desktops) are still forwarded.
    if (channel === 'cloud:session-conflict' && args[0] && typeof args[0] === 'object') {
      const conflict = args[0] as Record<string, unknown>;
      if (conflict.source === 'desktop') {
        log.debug({ sessionId: conflict.sessionId }, 'Suppressed desktop-originated conflict event');
        return;
      }
    }

    // For tool approval requests from cloud, store metadata locally so that
    // handleApprovalResponse can find it when the user clicks approve.
    if (channel === 'tool-safety:approval-request' && args[0] && typeof args[0] === 'object') {
      const approval = args[0] as Record<string, unknown>;
      if (approval.toolUseID && typeof approval.toolUseID === 'string') {
        fireAndForget(this.approvalInterceptor?.(approval), 'cloudEventChannel.approvalInterceptor');
      }
    }

    // For memory approval requests from cloud, store metadata locally so that
    // handleMemoryWriteApprovalResponse can find it when the user clicks approve.
    if (channel === 'memory:write-approval-request' && args[0] && typeof args[0] === 'object') {
      const approval = args[0] as Record<string, unknown>;
      if (approval.toolUseId && typeof approval.toolUseId === 'string') {
        fireAndForget(this.memoryApprovalInterceptor?.(approval), 'cloudEventChannel.memoryApprovalInterceptor');
      }
    }

    // For staged-files-changed events from cloud, trigger the staging bridge
    // (fire-and-forget async) to sync .pending.md files to desktop.
    // The event is STILL forwarded to the renderer so useStagedFiles refreshes.
    if (channel === 'memory:staged-files-changed') {
      this.stagingBridgeCallback?.();
    }

    // SECURITY: cloud-pushed `conversations:start-requested` events must not
    // carry a `systemPromptPrefix`. Operator personalisation runs are
    // initiated and trusted only by the local main process (see
    // `pendingPersonalisationPrefixes`). Strip the field unconditionally on
    // forwarded events so a hostile cloud event can't seed the renderer with
    // an unvetted system-prompt prefix.
    const sanitisedArgs = stripSystemPromptPrefixForForwarding(channel, args);

    // Cloud-ingress contract parse (dev/test-gated). This is the single point
    // where `as`-cast HTTP/WS JSON (fetchIpc → resp.json()) enters the broadcast
    // bus — the 260405-class surface. The Stage-2 sink-seam is vi.mock'ed away in
    // cloudEventChannel.test.ts, so a parse HERE (downstream of
    // normalizeMemoryApproval) is the only thing that fires on that surface. The
    // shared gate keeps this OFF in deployed cloud (NODE_ENV=production) and
    // packaged desktop — CI/dev regression guard, NOT prod enforcement.
    if (isContractEnforcementOn()) {
      const schema = BROADCAST_SCHEMAS[channel as keyof typeof BROADCAST_SCHEMAS];
      if (schema) {
        // Mirror the sink-seam's one-arg invariant (broadcastContractSeam.ts):
        // cloudEventChannel.test.ts vi.mocks the sink, so this ingress is the
        // ONLY guard on the broadcast call SHAPE here — validating only
        // sanitisedArgs[0] would let `[validPayload, extra]` slip through.
        if (sanitisedArgs.length !== 1) {
          throw new Error(
            `Broadcast contract violation: cloud-forwarded channel '${channel}' is schema-backed and must emit exactly one payload arg, got ${sanitisedArgs.length}.`,
          );
        }
        // Validation only — throws ZodError on drift; we forward the ORIGINAL
        // sanitisedArgs below, never Zod's (key-stripped) parsed output.
        schema.parse(sanitisedArgs[0]);
      }
    }

    const forwardedArgs = backfillCloudToolSafetyBlockSource(channel, sanitisedArgs);

    // dynamic-broadcast-reviewed: this IS the cloud→desktop dispatch chokepoint — it forwards a
    // `channel` already gated by CLOUD_PUSH_ALLOWLIST a few lines above (un-allowlisted channels are
    // dropped before reaching here), so it cannot introduce an unclassified channel; it re-emits a
    // post-gate, already-declared one.
    getBroadcastService().sendToAllWindows(channel, ...forwardedArgs);
  }
}

function backfillCloudToolSafetyBlockSource(channel: string, args: unknown[]): unknown[] {
  if (channel !== 'tool-safety:approval-request' && channel !== 'tool-safety:staged-call') {
    return args;
  }
  if (args.length === 0) return args;
  const first = args[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return args;

  const payload = first as Record<string, unknown>;
  const parsedBlockedBy = ToolBlockSourceSchema.safeParse(payload.blockedBy);
  const blockedBy = backfillToolBlockSource(
    parsedBlockedBy.success ? parsedBlockedBy.data : undefined,
    typeof payload.reason === 'string' ? payload.reason : undefined,
  );

  return [{ ...payload, blockedBy }, ...args.slice(1)];
}

function stripSystemPromptPrefixForForwarding(channel: string, args: unknown[]): unknown[] {
  if (channel !== 'conversations:start-requested') return args;
  if (!args.length) return args;
  const first = args[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return args;
  const payload = first as Record<string, unknown>;
  if (!('systemPromptPrefix' in payload)) return args;
  const { systemPromptPrefix: _drop, ...rest } = payload;
  log.warn(
    { channel, sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined },
    'Stripped systemPromptPrefix from cloud-pushed conversations:start-requested event',
  );
  return [rest, ...args.slice(1)];
}

function mirrorSlackWorkspaceEventIntoSettings(
  channel: string,
  args: unknown[],
): 'not-slack' | 'mirrored' | 'dropped-invalid' {
  const deps = slackWorkspaceSettingsMirrorDeps();
  if (channel === SLACK_WORKSPACE_CHANGED_CHANNEL) {
    const parsed = SlackWorkspaceChangedSchema.safeParse(args[0]);
    if (!parsed.success) {
      deps.log.warn({ error: parsed.error.flatten() }, 'Slack workspace changed push failed schema validation; settings not updated');
      return 'dropped-invalid';
    }
    const current = deps.getSettings();
    deps.updateSettings({
      experimental: {
        ...current.experimental,
        cloudSlackWorkspace: {
          teamId: parsed.data.teamId,
          teamName: parsed.data.teamName,
          status: parsed.data.status,
          peerInstanceCount: detectPeerInstanceCount(parsed.data),
          occurredAt: parsed.data.occurredAt,
        },
      },
    });
    return 'mirrored';
  }

  if (channel === SLACK_WORKSPACE_DISCONNECTED_CHANNEL) {
    const parsed = SlackWorkspaceDisconnectedSchema.safeParse(args[0]);
    if (!parsed.success) {
      deps.log.warn({ error: parsed.error.flatten() }, 'Slack workspace disconnected push failed schema validation; settings not updated');
      return 'dropped-invalid';
    }
    const current = deps.getSettings();
    const currentWorkspace = current.experimental?.cloudSlackWorkspace;
    deps.updateSettings({
      experimental: {
        ...current.experimental,
        cloudSlackWorkspace: {
          teamId: parsed.data.teamId,
          teamName: currentWorkspace?.teamId === parsed.data.teamId ? currentWorkspace.teamName : currentWorkspace?.teamName ?? '',
          status: 'disconnected',
          peerInstanceCount: currentWorkspace?.teamId === parsed.data.teamId
            ? detectPeerInstanceCount(currentWorkspace)
            : undefined,
          occurredAt: parsed.data.occurredAt,
        },
      },
    });
    return 'mirrored';
  }

  return 'not-slack';
}

/**
 * Normalize a flat persisted memory approval (from memory:get-pending-approvals)
 * into the nested destination shape expected by renderer consumers
 * (matching the live broadcast format from memoryWriteHook.ts).
 *
 * Idempotent: passes through already-nested shapes unchanged.
 *
 * FileLocation handling (Invariant #14):
 * - If the flat record has a valid `location` field, it is carried through
 *   into `destination.location` unchanged (common case — cloud producer
 *   already resolved it at the source).
 * - If the flat record has a `location` that fails FileLocationSchema
 *   validation, OR lacks `location` entirely, we fall back to
 *   `legacyMissingLocation({ fileName, spaceName, legacyPath: spacePath })`
 *   and emit a dedup'd `log.warn`. This function is the ONE main-side
 *   producer permitted to emit `kind: 'legacy-missing-location'` — it acts
 *   as a protocol-compatibility shim between cloud and renderer and is
 *   therefore consumer-equivalent.
 *
 * Main-side source-of-truth producers (`memoryHandlers`, `memoryWriteHook`,
 * `skillChangeNotificationService`, `cloudStagingBridge`) do NOT share this
 * allowance — they fail closed on malformed input rather than degrade.
 *
 * @internal
 */
export function normalizeMemoryApproval(flat: Record<string, unknown>): Record<string, unknown> {
  if (flat.destination && typeof flat.destination === 'object') {
    return flat;
  }

  const filePath = typeof flat.filePath === 'string' ? flat.filePath : '';
  const spacePath = typeof flat.spacePath === 'string' ? flat.spacePath : '';
  const spaceName = typeof flat.spaceName === 'string' ? flat.spaceName : '';
  const approvalIdRaw = flat.id ?? flat.approvalId ?? flat.toolUseId;
  const approvalId = typeof approvalIdRaw === 'string' ? approvalIdRaw : undefined;

  let location: FileLocation;
  const candidateLocation = flat.location;
  if (candidateLocation && typeof candidateLocation === 'object') {
    const parsed = FileLocationSchema.safeParse(candidateLocation);
    if (parsed.success) {
      location = parsed.data;
    } else {
      warnNormalizeMemoryApprovalFallbackOnce({
        approvalId,
        filePath,
        spacePath,
        reason: 'invalid-location-field',
      });
      location = legacyMissingLocation({
        fileName: deriveFileNameFromFlat(filePath, spacePath, flat),
        spaceName: spaceName.length > 0 ? spaceName : undefined,
        legacyPath: spacePath.length > 0 ? spacePath : (filePath.length > 0 ? filePath : undefined),
      });
    }
  } else {
    // No location field — classic compat path (cloud producer pre-dates
    // Stage 2 rollout, or the flat record was constructed without enrichment).
    warnNormalizeMemoryApprovalFallbackOnce({
      approvalId,
      filePath,
      spacePath,
      reason: filePath.length === 0 && spacePath.length === 0 ? 'malformed-flat-record' : 'missing-location-field',
    });
    location = legacyMissingLocation({
      fileName: deriveFileNameFromFlat(filePath, spacePath, flat),
      spaceName: spaceName.length > 0 ? spaceName : undefined,
      legacyPath: spacePath.length > 0 ? spacePath : (filePath.length > 0 ? filePath : undefined),
    });
  }

  return {
    ...flat,
    destination: {
      path: filePath,
      spaceName,
      spacePath,
      sharing: flat.sharing,
      isNew: false,
      location,
    },
  };
}

function deriveFileNameFromFlat(
  filePath: string,
  spacePath: string,
  flat: Record<string, unknown>,
): string | undefined {
  if (typeof flat.fileName === 'string' && flat.fileName.trim().length > 0) {
    return flat.fileName;
  }
  const source = filePath.length > 0 ? filePath : spacePath;
  if (source.length === 0) {
    return undefined;
  }
  const normalized = source.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  const candidate = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  return candidate.length > 0 ? candidate : undefined;
}

export function __resetNormalizeMemoryApprovalDedupForTests(): void {
  normalizeMemoryApprovalFallbackWarned.clear();
}

export const cloudEventChannel = new CloudEventChannel();
