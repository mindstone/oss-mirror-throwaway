import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileLocation } from '@rebel/shared';
const { mockWarn, mockSendToAllWindows } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockSendToAllWindows: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

import {
  __resetNormalizeMemoryApprovalDedupForTests,
  normalizeMemoryApproval,
  CLOUD_PUSH_ALLOWLIST,
  cloudEventChannel,
} from '../cloudEventChannel';

// ---------------------------------------------------------------------------
// normalizeMemoryApproval
// ---------------------------------------------------------------------------
describe('normalizeMemoryApproval', () => {
  beforeEach(() => {
    mockWarn.mockReset();
    mockSendToAllWindows.mockReset();
    __resetNormalizeMemoryApprovalDedupForTests();
  });

  it('converts flat filePath/spaceName/spacePath/sharing to nested destination', () => {
    const flat = {
      toolUseId: 'tool-123',
      sessionId: 'session-abc',
      filePath: '/workspace/notes/meeting.md',
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff/memory',
      sharing: 'private',
    };

    const result = normalizeMemoryApproval(flat);

    expect(result.destination).toMatchObject({
      path: '/workspace/notes/meeting.md',
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff/memory',
      sharing: 'private',
      isNew: false,
    });
    // FileLocation falls back to legacy-missing-location when location is absent —
    // normalizeMemoryApproval is the one main-side producer permitted to do this
    // (Invariant #14). Legacy fields are still populated.
    const dest = result.destination as Record<string, unknown>;
    const location = dest.location as FileLocation;
    expect(location.kind).toBe('legacy-missing-location');
    expect(location.fileName).toBe('meeting.md');
    // Original properties preserved
    expect(result.toolUseId).toBe('tool-123');
    expect(result.sessionId).toBe('session-abc');
  });

  it('carries a valid pre-resolved FileLocation through unchanged (Invariant #14 happy path)', () => {
    const validLocation: FileLocation = {
      kind: 'in-space',
      spaceName: 'Chief-of-Staff',
      spaceWorkspacePath: 'Chief-of-Staff',
      spaceRelativePath: 'memory/meeting.md',
      workspaceRelativePath: 'Chief-of-Staff/memory/meeting.md',
      fileName: 'meeting.md',
    };

    const flat = {
      toolUseId: 'tool-789',
      filePath: '/workspace/Chief-of-Staff/memory/meeting.md',
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff/memory',
      sharing: 'private',
      location: validLocation,
    };

    const result = normalizeMemoryApproval(flat);

    const dest = result.destination as Record<string, unknown>;
    expect(dest.location).toEqual(validLocation);
  });

  it('falls back to legacy-missing-location when pre-resolved location fails schema validation', () => {
    const flat = {
      id: 'approval-invalid-001',
      filePath: '/workspace/x.md',
      spaceName: 'Work',
      spacePath: 'work',
      sharing: 'private',
      // spaceName intentionally empty in `location` makes this invalid per
      // FileLocationSchema (in-space variant requires non-empty spaceName).
      location: {
        kind: 'in-space',
        spaceName: '',
        spaceWorkspacePath: 'work',
        spaceRelativePath: 'x.md',
        workspaceRelativePath: 'work/x.md',
        fileName: 'x.md',
      },
    };

    const result = normalizeMemoryApproval(flat);

    const dest = result.destination as Record<string, unknown>;
    const location = dest.location as FileLocation;
    expect(location.kind).toBe('legacy-missing-location');
    expect(location.fileName).toBe('x.md');
  });

  it('emits legacy-missing-location with non-empty fileName when BOTH filePath and spacePath are missing (Invariant #15)', () => {
    const flat = {
      id: 'approval-malformed-001',
      spaceName: 'Mystery Space',
    };

    const result = normalizeMemoryApproval(flat);

    const dest = result.destination as Record<string, unknown>;
    const location = dest.location as FileLocation;
    expect(location.kind).toBe('legacy-missing-location');
    // legacyMissingLocation cascade: fileName -> basename(legacyPath) ->
    // spaceName -> 'Unknown file'. With no path info, spaceName wins.
    expect(location.fileName).toBe('Mystery Space');
  });

  it('is idempotent — already nested object passes through unchanged (dupe removed)', () => {
    const alreadyNested = {
      toolUseId: 'tool-456',
      destination: {
        path: '/workspace/readme.md',
        spaceName: 'Work',
        spacePath: 'work/Acme',
        sharing: 'company-wide',
        isNew: true,
      },
    };

    const result = normalizeMemoryApproval(alreadyNested);

    expect(result).toBe(alreadyNested); // Same reference — no transformation
    expect(result.destination).toEqual(alreadyNested.destination);
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = {
      toolUseId: 'tool-789',
      // No filePath, spaceName, spacePath, or sharing
    };

    const result = normalizeMemoryApproval(minimal);

    expect(result.destination).toMatchObject({
      path: '',
      spaceName: '',
      spacePath: '',
      sharing: undefined,
      isNew: false,
    });
    // Location is still emitted (legacy-missing-location fallback) with a
    // non-empty fileName per Invariant #15.
    const dest = result.destination as Record<string, unknown>;
    const location = dest.location as FileLocation;
    expect(location.kind).toBe('legacy-missing-location');
    expect(typeof location.fileName).toBe('string');
    expect(location.fileName.length).toBeGreaterThan(0);
  });

  it('warn-dedup — repeated invalid-location inputs with same approvalId produce one log.warn', () => {
    const flat = {
      id: 'approval-invalid-dedup',
      filePath: '/workspace/x.md',
      spaceName: 'Work',
      spacePath: 'work',
      location: {
        kind: 'in-space',
        spaceName: '',
        spaceWorkspacePath: 'work',
        spaceRelativePath: 'x.md',
        workspaceRelativePath: 'work/x.md',
        fileName: 'x.md',
      },
    };

    normalizeMemoryApproval(flat);
    normalizeMemoryApproval(flat);

    const fallbackWarnings = mockWarn.mock.calls.filter(
      ([, message]) => message === 'normalizeMemoryApproval fell back to legacy-missing-location',
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0]?.[0]).toMatchObject({
      approvalId: 'approval-invalid-dedup',
      reason: 'invalid-location-field',
    });
  });

  it('warn-dedup — repeated missing-location inputs with same filePath|spacePath composite produce one log.warn', () => {
    const flat = {
      filePath: '/workspace/reports/q1.md',
      spaceName: 'Reports',
      spacePath: 'Reports/q1.md',
    };

    normalizeMemoryApproval(flat);
    normalizeMemoryApproval(flat);

    const fallbackWarnings = mockWarn.mock.calls.filter(
      ([, message]) => message === 'normalizeMemoryApproval fell back to legacy-missing-location',
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0]?.[0]).toMatchObject({
      approvalId: undefined,
      reason: 'missing-location-field',
    });
  });
});

// ---------------------------------------------------------------------------
// CLOUD_PUSH_ALLOWLIST
// ---------------------------------------------------------------------------
describe('CLOUD_PUSH_ALLOWLIST', () => {
  it('is a Set', () => {
    expect(CLOUD_PUSH_ALLOWLIST).toBeInstanceOf(Set);
  });

  it('contains expected safety channels', () => {
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:approval-request')).toBe(true);
    // Added in 33d8cf3c0: broadcast on approval cleared so cloud/mobile
    // Notification drawers drop stale entries after turn-end.
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:approval-resolved')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:staged-call')).toBe(true);
    // cloud-sync-latent-gaps (260620, Amendment A2): staged-call status update — sibling of
    // tool-safety:staged-call; cloud-routable staged-execute/-reject IPC fires it on cloud.
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:staged-call-updated')).toBe(true);
    // Added in 483461a82: safety-eval progress signals so desktop/cloud/mobile
    // clients render the "Checking this is safe…" subline; transient UI-only.
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:evaluating')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('tool-safety:evaluating-complete')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('memory:file-staged')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('memory:write-approval-request')).toBe(true);
    // cloud-sync-latent-gaps (260620, Amendment A2): memory-write approval resolution — sibling of
    // tool-safety:approval-resolved; cloud-wired memoryWriteHook supersede cleanup fires it on cloud.
    expect(CLOUD_PUSH_ALLOWLIST.has('memory:write-approval-resolved')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('memory:staged-files-changed')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('memory:update-status')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('error-recovery:state')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('cloud:session-conflict')).toBe(true);
    // Stage 0 of docs/plans/260416_centralize_approval_and_diff_viewing_ux.md
    expect(CLOUD_PUSH_ALLOWLIST.has('safety-prompt:updated')).toBe(true);
    // Stage 5 P0 follow-up of docs/plans/260504_unified_provider_model_presentation.md
    expect(CLOUD_PUSH_ALLOWLIST.has('agent:route-plan-resolved')).toBe(true);
    expect(CLOUD_PUSH_ALLOWLIST.has('tokens:provider-changed')).toBe(true);
    // Cloud-generated conversation title live-swap (260618 fix-autotitle-cloud-livesync).
    expect(CLOUD_PUSH_ALLOWLIST.has('session:title-generated')).toBe(true);
  });

  it('does not contain dangerous channels that should be desktop-only', () => {
    // Session management channels should not be pushable from cloud
    expect(CLOUD_PUSH_ALLOWLIST.has('sessions:save-sync')).toBe(false);
    // Settings channels should not be pushable from cloud
    expect(CLOUD_PUSH_ALLOWLIST.has('settings:get')).toBe(false);
    expect(CLOUD_PUSH_ALLOWLIST.has('settings:set')).toBe(false);
    // Agent turn channels should not be pushable from cloud
    expect(CLOUD_PUSH_ALLOWLIST.has('agent:turn')).toBe(false);
    expect(CLOUD_PUSH_ALLOWLIST.has('agent:stop')).toBe(false);
    // Cloud Slack webhooks may request conversation starts, but they must never
    // be allowed to execute turns directly.
    expect(CLOUD_PUSH_ALLOWLIST.has('conversations:start-requested')).toBe(true);
    // Cloud session-changed is intercepted before the allowlist check
    expect(CLOUD_PUSH_ALLOWLIST.has('cloud:session-changed')).toBe(false);
    // Inbox-changed is intercepted before the allowlist check
    expect(CLOUD_PUSH_ALLOWLIST.has('inbox:changed')).toBe(false);
    // Automation cloud-delta is intercepted before the allowlist check —
    // the main-process automation scheduler merges the delta and re-broadcasts
    // via `automation:state`. See BUG 1+11 in docs-private/investigations/260515_cloud_automation_bugs.md.
    expect(CLOUD_PUSH_ALLOWLIST.has('automation:cloud-delta')).toBe(false);
  });

  it('has a small, fixed size (defense against accidental additions)', () => {
    // The allowlist should be restrictive. If this test fails because a new
    // channel was added, the developer must explicitly update this assertion
    // after reviewing the security implications.
    //
    // Last bumped: merge of two concurrent additions into `dev`:
    //   - Stage 0 of docs/plans/260416_centralize_approval_and_diff_viewing_ux.md
    //     added `safety-prompt:updated` for cross-surface safety-prompt
    //     invalidation (no secrets in payload — only {version, lastUpdatedAt,
    //     lastUpdatedBy}).
    //   - Commit 33d8cf3c0 (docs-private/investigations/260416_stale_pending_approvals...)
    //     added `tool-safety:approval-resolved` for cross-surface notification-
    //     drawer cleanup on turn-end (no secrets — only the resolved toolUseID).
    //   - Commit 483461a82 (fix(safety): Broadcast safety-eval progress...)
    //     added `tool-safety:evaluating` and `tool-safety:evaluating-complete`
    //     for cross-surface "Checking this is safe…" UI (transient UI-only,
    //     no secrets — only {toolUseId, sessionId, attempt, outcome?}).
    // Stage 6 external conversation architecture added `external-delivery:failed`
    // for surfacing webhook delivery failures to the UI.
    // This brought the allowlist from 12 -> 13.
    // Slack cloud webhook polish (docs/plans/260503_slack_cloud_webhook_polish.md
    // Stages 1+2) added `slack:workspace-changed` and `slack:workspace-disconnected`
    // so that cloud workspace-store mutations (managed OAuth callback, cloud-side
    // tokens_revoked) can flip the desktop ConnectSlackCard state in real time.
    // Workspace-lifecycle payloads carry no session provenance by design — only
    // {teamId, teamName?, reason?}, never tokens. This brings the allowlist to 15.
    // Stage 5 P0 follow-up (docs/plans/260504_unified_provider_model_presentation.md)
    // added `agent:route-plan-resolved` so cloud-executed turns update the desktop
    // renderer's route-label cache. Schema-validated via BROADCAST_SCHEMAS in
    // src/shared/ipc/broadcasts.ts. This brings the allowlist to 16.
    // Chat-intent safety-rule persistence added `safety-prompt:rule-persisted`
    // for a desktop toast after a rule is saved; payload is metadata-only
    // ({version, lastUpdatedAt, source, summary, proposedPrinciple}).
    // Commit 22ca6d90c (fix(bts): Stop silent Haiku fallback...) added
    // `bts:structured-output-bypassed` so the cross-surface toast can fire
    // when a sticky JSON-incompatible flag pins the user's chosen profile.
    // Payload is metadata-only ({sessionId, profileName, reason}); no
    // user content or tokens. This brings the allowlist to 18.
    // Slack messaging Stage 6 added four external-conversation intent channels
    // so cloud-side Slack webhooks can reach the desktop renderer through the
    // existing preload subscriptions. Payloads are sanitized prompt/context
    // envelopes; direct agent execution channels remain blocked above. This
    // brought the allowlist to 22.
    // Token-sync Stage 2 added metadata-only `tokens:provider-changed` relay,
    // bringing the allowlist to 23.
    // show-more-activity added `session:activity-summary-generated` so a
    // cloud-generated per-turn activity summary live-swaps into the desktop
    // renderer (metadata-only: {sessionId, turnId, summary}). This brings the
    // allowlist to 24.
    // fix-autotitle-cloud-livesync (260618) added `session:title-generated` so a
    // cloud-generated conversation title live-swaps into the desktop sidebar
    // (metadata-only: {sessionId, title, autoTitleGeneratedAt?, autoTitleTurnCount?}).
    // This brings the allowlist to 25.
    // cloud-sync-latent-gaps (260620, Amendment A2) added two transient resolution
    // notifications surfaced once the coverage gate began scanning broadcastTypedPayload
    // call sites: `tool-safety:staged-call-updated` (cloud-routable staged-execute/-reject
    // IPC fires it; {id, sessionId, status, result?}) and `memory:write-approval-resolved`
    // (cloud-wired memoryWriteHook supersede cleanup; {toolUseId, originalSessionId, approved}).
    // Both are transient renderer-UI-only "drop/update a stale card" signals (siblings of the
    // already-allowlisted tool-safety:staged-call / tool-safety:approval-resolved) — no
    // persisted session field, so allowlist-only. This brings the allowlist to 27.
    expect(CLOUD_PUSH_ALLOWLIST.size).toBe(27);
  });
});

describe('CLOUD_PUSH_ALLOWLIST forwarding for slack conversation intent channels', () => {
  beforeEach(() => {
    mockSendToAllWindows.mockReset();
  });

  function dispatchToRenderer(channel: string, args: unknown[]): void {
    (cloudEventChannel as unknown as {
      dispatchToRenderer: (eventChannel: string, eventArgs: unknown[]) => void;
    }).dispatchToRenderer(channel, args);
  }

  it.each([
    // shape: ConversationsStartRequestedEvent (broadcasts.ts) — the REAL producer
    // (externalConversationService.createConversation:231) emits the broadcast
    // shape, NOT the service-call arg shape {conversationId,userText,context}.
    // Slack context rides the OPTIONAL `externalContext` field, never a top-level
    // `context`. `conversations:start-requested` is the only schema-backed row
    // here, so it must satisfy BROADCAST_SCHEMAS at the cloud-ingress parse.
    ['conversations:start-requested', { sessionId: 'conv-1', text: 'hello from slack', sendMessage: true, switchToConversation: true, externalContext: { kind: 'slack-thread', identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }, metadata: { userName: null, channelName: null, teamName: null, permalink: null } } }],
    ['intent:external-context-arrived', { conversationId: 'conv-1', context: { kind: 'slack-thread', identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' } } }],
    ['intent:buffered-message', { conversationId: 'conv-1', text: 'buffered inbound text' }],
    ['intent:buffer-drained', { conversationId: 'conv-1', drainedCount: 1 }],
  ] as const)(
    'allowlists and forwards %s',
    (channel, payload) => {
      expect(CLOUD_PUSH_ALLOWLIST.has(channel)).toBe(true);

      dispatchToRenderer(channel, [payload]);

      expect(mockSendToAllWindows).toHaveBeenCalledWith(channel, payload);
    },
  );
});

describe('CloudEventChannel interceptor dispatch contracts', () => {
  beforeEach(() => {
    mockSendToAllWindows.mockReset();
    cloudEventChannel.disconnect();
    cloudEventChannel.onApprovalReceived(() => {});
    cloudEventChannel.onMemoryApprovalReceived(() => {});
  });

  function dispatchToRenderer(channel: string, args: unknown[]): void {
    (cloudEventChannel as unknown as {
      dispatchToRenderer: (eventChannel: string, eventArgs: unknown[]) => void;
    }).dispatchToRenderer(channel, args);
  }

  it('observes async session-change interceptor rejections without forwarding to the renderer', async () => {
    const rejection = new Error('session sync failed');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const interceptor = vi.fn(async () => {
      throw rejection;
    });
    cloudEventChannel.onSessionChanged(interceptor);

    dispatchToRenderer('cloud:session-changed', [{ sessionId: 'session-1', action: 'upserted' }]);

    expect(interceptor).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'upserted' });
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[fireAndForget:cloudEventChannel.sessionChangeInterceptor]',
        rejection,
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it('fires approval and memory-approval interceptors for valid cloud payloads before forwarding', () => {
    const approvalInterceptor = vi.fn();
    const memoryApprovalInterceptor = vi.fn();
    // shape: ToolSafetyApprovalRequestBroadcast (approvalBroadcasts.ts) — the real
    // producer emits the full PersistedToolApprovalRequest DTO; turnId/input/timestamp
    // are schema-required, so the cloud-ingress parse rejects the partial shape.
    const toolApproval = { toolUseID: 'tool-1', turnId: 'turn-1', toolName: 'Bash', input: {}, timestamp: Date.now() };
    // shape: MemoryWriteApprovalRequestBroadcast — dispatched DIRECTLY here (NOT via
    // the catch-up route), so normalizeMemoryApproval never runs on this path; the
    // fixture must already carry the nested `destination` + required fields.
    const memoryApproval = {
      toolUseId: 'mem-1',
      originalTurnId: 'turn-1',
      originalSessionId: 'session-1',
      destination: { path: '/workspace/work/note.md', spaceName: 'work', isNew: false },
      summary: 'Save this note',
      timestamp: Date.now(),
    };
    cloudEventChannel.onApprovalReceived(approvalInterceptor);
    cloudEventChannel.onMemoryApprovalReceived(memoryApprovalInterceptor);

    dispatchToRenderer('tool-safety:approval-request', [toolApproval]);
    dispatchToRenderer('memory:write-approval-request', [memoryApproval]);

    expect(approvalInterceptor).toHaveBeenCalledWith(toolApproval);
    expect(memoryApprovalInterceptor).toHaveBeenCalledWith(memoryApproval);
    expect(mockSendToAllWindows).toHaveBeenCalledWith('tool-safety:approval-request', toolApproval);
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:write-approval-request', memoryApproval);
  });

  it.each([
    [
      'tool-safety:approval-request',
      {
        toolUseID: 'tool-safety-prefixed',
        turnId: 'turn-1',
        toolName: 'Bash',
        input: { command: 'rm -rf tmp' },
        timestamp: Date.now(),
      },
    ],
    [
      'tool-safety:staged-call',
      {
        id: 'staged-safety-prefixed',
        sessionId: 'session-1',
        displayName: 'Bash',
        packageId: 'system',
        toolId: 'bash',
        timestamp: Date.now(),
      },
    ],
  ] as const)(
    'backfills %s forwarded payloads from legacy Safety Rules reasons',
    (channel, basePayload) => {
      dispatchToRenderer(channel, [
        {
          ...basePayload,
          reason: 'Safety Rules blocked: command can delete files',
        },
      ]);

      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        channel,
        expect.objectContaining({
          reason: 'Safety Rules blocked: command can delete files',
          blockedBy: 'safety_prompt',
        }),
      );
    },
  );

  it.each([
    [
      'tool-safety:approval-request',
      {
        toolUseID: 'tool-non-safety',
        turnId: 'turn-1',
        toolName: 'Bash',
        input: { command: 'echo ok' },
        timestamp: Date.now(),
      },
    ],
    [
      'tool-safety:staged-call',
      {
        id: 'staged-non-safety',
        sessionId: 'session-1',
        displayName: 'Bash',
        packageId: 'system',
        toolId: 'bash',
        timestamp: Date.now(),
      },
    ],
  ] as const)(
    'does not backfill %s forwarded payloads from non-safety reasons',
    (channel, basePayload) => {
      dispatchToRenderer(channel, [
        {
          ...basePayload,
          reason: 'Generic approval required',
        },
      ]);

      const forwardedPayload = mockSendToAllWindows.mock.calls.at(-1)?.[1] as { blockedBy?: unknown };
      expect(forwardedPayload.blockedBy).toBeUndefined();
    },
  );

  it.each([
    [
      'tool-safety:approval-request',
      {
        toolUseID: 'tool-eval-error',
        turnId: 'turn-1',
        toolName: 'Bash',
        input: { command: 'rm -rf tmp' },
        timestamp: Date.now(),
      },
    ],
    [
      'tool-safety:staged-call',
      {
        id: 'staged-eval-error',
        sessionId: 'session-1',
        displayName: 'Bash',
        packageId: 'system',
        toolId: 'bash',
        timestamp: Date.now(),
      },
    ],
  ] as const)(
    'preserves existing %s blockedBy values on forwarded payloads',
    (channel, basePayload) => {
      dispatchToRenderer(channel, [
        {
          ...basePayload,
          reason: 'Safety Rules blocked: command can delete files',
          blockedBy: 'eval_error',
        },
      ]);

      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        channel,
        expect.objectContaining({
          reason: 'Safety Rules blocked: command can delete files',
          blockedBy: 'eval_error',
        }),
      );
    },
  );
});
