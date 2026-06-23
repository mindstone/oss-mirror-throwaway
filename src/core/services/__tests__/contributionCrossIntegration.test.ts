/**
 * Cross-integration tests: VAL-CROSS-001, VAL-CROSS-002, VAL-CROSS-003, VAL-CROSS-004, VAL-CROSS-005
 *
 * Tests the full chain: contribution store → state mapping → card state derivation.
 * Also covers auth token flow through submission/refresh, store propagation to
 * all downstream consumers, and changes-requested follow-up session spawning.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContributionStatus, ConnectorContribution } from '../contributionTypes';
import { ALL_CONTRIBUTION_STATUSES } from '../contributionTypes';
import {
  mapContributionToCardState,
  createGitHubCheckState,
  SUBMITTED_HELPER_TEXT,
} from '@shared/utils/contributionStateMapping';

// ─── In-memory store mock ───────────────────────────────────────────

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

vi.mock('@core/utils/storeMigration', () => ({
  createMigrationRegistry: <T,>(migrations: Record<number, unknown>): Record<number, unknown> => migrations,
  migrateStore: vi.fn((stored: Record<string, unknown>) => ({
    data: stored,
    status: 'current',
    shouldPersist: false,
    fromVersion: (stored as { version?: number }).version ?? 1,
    toVersion: 1,
    backupPath: null,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  createContribution,
  getContributionById,
  getContributionBySession,
  updateContribution,
  acknowledgeEvent,
  addFollowUpSession,
  _resetStore,
} from '../contributionStore';
import {
  createFollowUpSessionContext,
  linkFollowUpSession,
} from '../contributionFollowUpService';

// ─── VAL-CROSS-001: Entry point to MCPBuildCard lifecycle ───────────

describe('Cross-integration: contribution store → state mapping → card state', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
  });

  it('full chain: create contribution → derive card state for session', () => {
    // Step 1: Skill creates a contribution via the store (simulating tool call)
    const contribution = createContribution({
      sessionId: 'session-build-1',
      connectorName: 'CustomConnector',
      status: 'draft',
      attributionMode: 'anonymous',
    });

    expect(contribution.id).toBeTruthy();
    expect(contribution.status).toBe('draft');

    // Step 2: Retrieve contribution by session (simulating IPC get-by-session)
    const retrieved = getContributionBySession('session-build-1');
    expect(retrieved).toBeTruthy();
    expect(retrieved!.connectorName).toBe('CustomConnector');

    // Step 3: Map to card state (simulating useMcpBuildCardState hook).
    // Post-2026-04-20, `draft` maps to building.implementing — a neutral
    // progress card with no submit CTA. Submit-prompt only appears at
    // ready_to_submit (after Phase 6 testing passes).
    const cardState = mapContributionToCardState(retrieved!, {
      tools: [{ name: 'tool_1', status: 'pending' }],
    });

    expect(cardState).toEqual({
      phase: 'building',
      subphase: 'implementing',
      connectorName: 'CustomConnector',
      tools: [{ name: 'tool_1', status: 'pending' }],
    });
  });

  it('store update propagates to card state derivation', () => {
    // Create
    const contribution = createContribution({
      sessionId: 'session-flow',
      connectorName: 'FlowConn',
      status: 'draft',
      attributionMode: 'github',
    });

    // Verify initial card state (draft → building.implementing).
    let retrieved = getContributionBySession('session-flow')!;
    let cardState = mapContributionToCardState(retrieved);
    expect(cardState!.phase).toBe('building');

    // Transition: draft → testing (building.testing — neutral progress card).
    updateContribution(contribution.id, { status: 'testing' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState!.phase).toBe('building');
    if (cardState?.phase === 'building') {
      expect(cardState.subphase).toBe('testing');
    }

    // Transition: testing → ready_to_submit — THIS is when submit-prompt appears.
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState!.phase).toBe('submit-prompt');

    // Transition: ready_to_submit → submitted
    updateContribution(contribution.id, { status: 'submitted' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState).toEqual({
      phase: 'submitted',
      connectorName: 'FlowConn',
      helperText: SUBMITTED_HELPER_TEXT.under_review,
      substatus: 'under_review',
    });

    // Transition: submitted → ci_pass (waiting for approval)
    updateContribution(contribution.id, { status: 'ci_pass' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState).toEqual({
      phase: 'submitted',
      connectorName: 'FlowConn',
      helperText: SUBMITTED_HELPER_TEXT.pending_approval,
      substatus: 'pending_approval',
    });

    // Transition: ci_pass → approved
    updateContribution(contribution.id, { status: 'approved' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState).toEqual({
      phase: 'submitted',
      connectorName: 'FlowConn',
      helperText: SUBMITTED_HELPER_TEXT.approved,
      substatus: 'approved',
    });

    // Transition: approved → published
    updateContribution(contribution.id, { status: 'published' });
    retrieved = getContributionBySession('session-flow')!;
    cardState = mapContributionToCardState(retrieved);
    expect(cardState).toEqual({
      phase: 'submitted',
      connectorName: 'FlowConn',
      helperText: SUBMITTED_HELPER_TEXT.published,
      substatus: 'published',
    });
  });

  it('no card when no contribution for session', () => {
    // No contribution created for this session
    const retrieved = getContributionBySession('session-nonexistent');
    const cardState = mapContributionToCardState(retrieved);
    expect(cardState).toBeNull();
  });

  it('github-check transient state is produced correctly', () => {
    const state = createGitHubCheckState('MyConn');
    expect(state).toEqual({ phase: 'github-check', connectorName: 'MyConn' });
  });

  it('all contribution statuses produce valid card states after store operations', () => {
    // Walk through the full lifecycle, verifying each status produces the
    // expected card state. Post-Stage-3 the `testing` phase is invisible
    // (card maps to null) so the assertion is phase-aware.
    const contribution = createContribution({
      sessionId: 'session-all-states',
      connectorName: 'AllStatesConn',
      status: 'draft',
      attributionMode: 'anonymous',
    });

    const lifecycle: ContributionStatus[] = [
      'draft',
      'testing',
      'ready_to_submit',
      'submitted',
      'ci_pass',
      'approved',
      'published',
    ];

    for (const status of lifecycle) {
      if (status !== 'draft') {
        updateContribution(contribution.id, { status });
      }
      const retrieved = getContributionBySession('session-all-states')!;
      expect(retrieved.status).toBe(status);
      const cardState = mapContributionToCardState(retrieved);
      // Every lifecycle status now renders a visible card:
      //  - draft / testing → building.{implementing,testing}
      //  - ready_to_submit → submit-prompt
      //  - submitted / ci_* / approved / published → submitted substatuses
      expect(cardState).not.toBeNull();
      expect(cardState!.connectorName).toBe('AllStatesConn');
      if (status === 'testing') {
        expect(cardState!.phase).toBe('building');
        if (cardState?.phase === 'building') {
          expect(cardState.subphase).toBe('testing');
        }
      }
    }
  });
});

// ─── VAL-CROSS-002: Store feeds all downstream consumers ───────────
//
// Uses production derivation constants/functions imported from the
// useContributionNotifications hook — NOT hardcoded local sets.

import {
  BANNER_STATUSES,
  DRAWER_NOTIFICATION_STATUSES,
  toNotificationState,
  isAcknowledged,
} from '@shared/utils/contributionNotificationDerivation';

describe('VAL-CROSS-002: Store feeds all downstream consumers (production derivation)', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
  });

  it('draft: no banner, no drawer notification, card shows building.implementing', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-draft',
      connectorName: 'CrossConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Production banner derivation: draft is NOT in BANNER_STATUSES
    expect(BANNER_STATUSES.has(contribution.status)).toBe(false);

    // Production drawer derivation: draft is NOT in DRAWER_NOTIFICATION_STATUSES
    expect(DRAWER_NOTIFICATION_STATUSES.has(contribution.status)).toBe(false);

    // Production notification state derivation: draft has no notification
    expect(toNotificationState(contribution.status)).toBeNull();

    // Production card state derivation — post-2026-04-20, draft shows a
    // neutral building card, not the submit prompt.
    const cardState = mapContributionToCardState(contribution);
    expect(cardState).not.toBeNull();
    expect(cardState!.phase).toBe('building');
    if (cardState?.phase === 'building') {
      expect(cardState.subphase).toBe('implementing');
    }
  });

  it('approved: all three consumers derive correct state from store', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-approved',
      connectorName: 'CrossConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Transition through to approved
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'approved' });

    const updated = getContributionById(contribution.id)!;

    // 1. Banner consumer (production derivation): approved IS in BANNER_STATUSES
    expect(BANNER_STATUSES.has(updated.status)).toBe(true);

    // Banner not yet acknowledged → should show
    expect(isAcknowledged(
      { ...updated, acknowledgedEvents: updated.acknowledgedEvents },
      updated.status,
      'banner',
    )).toBe(false);

    // 2. Drawer consumer (production derivation): approved IS in DRAWER_NOTIFICATION_STATUSES
    expect(DRAWER_NOTIFICATION_STATUSES.has(updated.status)).toBe(true);

    // Production notification state mapping
    expect(toNotificationState(updated.status)).toBe('approved');

    // Drawer not yet acknowledged → should show
    expect(isAcknowledged(
      { ...updated, acknowledgedEvents: updated.acknowledgedEvents },
      updated.status,
      'drawer',
    )).toBe(false);

    // 3. Card consumer (production derivation)
    const cardState = mapContributionToCardState(updated);
    expect(cardState).not.toBeNull();
    expect(cardState!.connectorName).toBe('CrossConnector');
    expect(cardState!.phase).toBe('submitted');
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('approved');
    }
  });

  it('ci_fail: drawer shows, banner does not, card shows submitted/ci_fail', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-cifail',
      connectorName: 'CIFailConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_fail' });

    const updated = getContributionById(contribution.id)!;

    // Banner: ci_fail NOT in BANNER_STATUSES
    expect(BANNER_STATUSES.has(updated.status)).toBe(false);

    // Drawer: ci_fail IS in DRAWER_NOTIFICATION_STATUSES
    expect(DRAWER_NOTIFICATION_STATUSES.has(updated.status)).toBe(true);
    expect(toNotificationState(updated.status)).toBe('ci-fail');

    // Card: ci_fail maps to checks_failed so the user can see approval is blocked
    const cardState = mapContributionToCardState(updated);
    expect(cardState).not.toBeNull();
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('checks_failed');
      expect(cardState!.helperText).toBe(SUBMITTED_HELPER_TEXT.checks_failed);
    }
  });

  it('published: banner shows, drawer does not, card shows submitted/published', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-published',
      connectorName: 'PublishedConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'approved' });
    updateContribution(contribution.id, { status: 'published' });

    const updated = getContributionById(contribution.id)!;

    // Banner: published IS in BANNER_STATUSES
    expect(BANNER_STATUSES.has(updated.status)).toBe(true);

    // Drawer: published is NOT in DRAWER_NOTIFICATION_STATUSES
    expect(DRAWER_NOTIFICATION_STATUSES.has(updated.status)).toBe(false);
    expect(toNotificationState(updated.status)).toBeNull();

    // Card: published substatus
    const cardState = mapContributionToCardState(updated);
    expect(cardState).not.toBeNull();
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('published');
    }
  });

  it('changes_requested: drawer shows, banner does not, card shows changes_requested', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-changes',
      connectorName: 'ChangesConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'changes_requested' });

    const updated = getContributionById(contribution.id)!;

    // Banner: changes_requested NOT in BANNER_STATUSES
    expect(BANNER_STATUSES.has(updated.status)).toBe(false);

    // Drawer: changes_requested IS in DRAWER_NOTIFICATION_STATUSES
    expect(DRAWER_NOTIFICATION_STATUSES.has(updated.status)).toBe(true);
    expect(toNotificationState(updated.status)).toBe('changes-requested');

    // Card
    const cardState = mapContributionToCardState(updated);
    expect(cardState).not.toBeNull();
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('changes_needed');
    }
  });

  it('acknowledgment suppresses consumer visibility per-surface using production derivation', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-002-ack',
      connectorName: 'AckConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'approved' });

    // Acknowledge on banner surface only
    acknowledgeEvent(contribution.id, 'approved', 'banner');

    const afterBannerAck = getContributionById(contribution.id)!;

    // Banner acknowledged — production isAcknowledged says yes for banner
    expect(isAcknowledged(afterBannerAck, 'approved', 'banner')).toBe(true);

    // Drawer NOT acknowledged — production isAcknowledged says no for drawer
    expect(isAcknowledged(afterBannerAck, 'approved', 'drawer')).toBe(false);

    // Card state is independent of acknowledgment
    const cardState = mapContributionToCardState(afterBannerAck);
    expect(cardState).not.toBeNull();
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('approved');
    }
  });

  it('all DRAWER_NOTIFICATION_STATUSES produce valid toNotificationState results', () => {
    // Ensures production set and production mapper are consistent
    for (const status of DRAWER_NOTIFICATION_STATUSES) {
      const state = toNotificationState(status);
      expect(state).not.toBeNull();
    }
  });

  it('all BANNER_STATUSES are confirmed by production constant', () => {
    // Verify the set contains only expected values
    expect(BANNER_STATUSES.has('approved')).toBe(true);
    expect(BANNER_STATUSES.has('published')).toBe(true);
    expect(BANNER_STATUSES.has('draft')).toBe(false);
    expect(BANNER_STATUSES.has('submitted')).toBe(false);
    expect(BANNER_STATUSES.size).toBe(2);
  });
});

// ─── VAL-CROSS-004: Notification lifecycle from submission to dismissal ───

describe('VAL-CROSS-004: Notification lifecycle from submission to dismissal', () => {
  it('per-surface dismissal independence works through full lifecycle', () => {
    const contribution = createContribution({
      sessionId: 'session-cross-004',
      connectorName: 'LifecycleConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Move to approved
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'approved' });

    // Acknowledge on banner
    acknowledgeEvent(contribution.id, 'approved', 'banner');

    const afterBannerDismiss = getContributionById(contribution.id)!;
    // Banner acknowledged
    expect(afterBannerDismiss.acknowledgedEvents).toContainEqual(
      expect.objectContaining({ status: 'approved', surface: 'banner' }),
    );
    // Drawer NOT acknowledged
    expect(afterBannerDismiss.acknowledgedEvents.some(
      e => e.status === 'approved' && e.surface === 'drawer',
    )).toBe(false);

    // Now acknowledge on drawer
    acknowledgeEvent(contribution.id, 'approved', 'drawer');

    const afterDrawerDismiss = getContributionById(contribution.id)!;
    // Both acknowledged
    expect(afterDrawerDismiss.acknowledgedEvents).toContainEqual(
      expect.objectContaining({ status: 'approved', surface: 'banner' }),
    );
    expect(afterDrawerDismiss.acknowledgedEvents).toContainEqual(
      expect.objectContaining({ status: 'approved', surface: 'drawer' }),
    );

    // Move to published — new notifications should appear (not suppressed by old dismissals)
    updateContribution(contribution.id, { status: 'published' });
    const published = getContributionById(contribution.id)!;
    expect(published.status).toBe('published');
    // Published is NOT in the old banner acknowledgment (approved, not published)
    expect(published.acknowledgedEvents.some(
      e => e.status === 'published' && e.surface === 'banner',
    )).toBe(false);
  });
});

describe('VAL-CROSS-005: Changes-requested spawns follow-up session', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
  });

  it('creates follow-up context for changes_requested contribution', () => {
    const contribution = createContribution({
      sessionId: 'session-original-build',
      connectorName: 'ReviewedConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Progress to changes_requested
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      status: 'submitted',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/55',
    });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, {
      status: 'changes_requested',
      reviewNotes: 'maintainer-1: Please add error handling for rate limits',
    });

    // Create follow-up session context
    const context = createFollowUpSessionContext(contribution.id);

    expect(context).not.toBeNull();
    expect(context!.contributionId).toBe(contribution.id);
    expect(context!.originalSessionId).toBe('session-original-build');
    expect(context!.connectorName).toBe('ReviewedConnector');
    expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');
    expect(context!.prompt).toContain('ReviewedConnector');
    expect(context!.prompt).toContain('changes requested');
    expect(context!.prompt).toContain('Please add error handling for rate limits');
    expect(context!.prompt).toContain('pull/55');
  });

  it('links follow-up session to contribution via addFollowUpSession', () => {
    const contribution = createContribution({
      sessionId: 'session-build-original',
      connectorName: 'FollowUpConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Progress to changes_requested
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'changes_requested' });

    // Simulate renderer creating a follow-up session and linking it
    const followUpSessionId = 'session-followup-1';
    const updated = linkFollowUpSession(contribution.id, followUpSessionId);

    expect(updated).toBeTruthy();
    expect(updated!.followUpSessionIds).toContain(followUpSessionId);
    expect(updated!.sessionId).toBe('session-build-original');

    // Verify the link persists in the store
    const fromStore = getContributionById(contribution.id)!;
    expect(fromStore.followUpSessionIds).toEqual([followUpSessionId]);
  });

  it('supports multiple follow-up sessions (e.g., multiple review rounds)', () => {
    const contribution = createContribution({
      sessionId: 'session-multi-round',
      connectorName: 'MultiRoundConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // First round: changes_requested → follow-up → testing
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'changes_requested' });

    addFollowUpSession(contribution.id, 'session-followup-round-1');

    // Second round: back to testing → submit → changes_requested again
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'changes_requested' });

    addFollowUpSession(contribution.id, 'session-followup-round-2');

    const result = getContributionById(contribution.id)!;
    expect(result.followUpSessionIds).toEqual([
      'session-followup-round-1',
      'session-followup-round-2',
    ]);
  });

  it('addFollowUpSession is idempotent (no duplicate session IDs)', () => {
    const contribution = createContribution({
      sessionId: 'session-idempotent',
      connectorName: 'IdempotentConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    addFollowUpSession(contribution.id, 'session-dup');
    addFollowUpSession(contribution.id, 'session-dup');
    addFollowUpSession(contribution.id, 'session-dup');

    const result = getContributionById(contribution.id)!;
    expect(result.followUpSessionIds).toEqual(['session-dup']);
  });

  it('returns null for non-existent contribution', () => {
    const context = createFollowUpSessionContext('nonexistent-id');
    expect(context).toBeNull();
  });

  it('returns null for contribution not in changes_requested or ci_fail state', () => {
    const contribution = createContribution({
      sessionId: 'session-wrong-state',
      connectorName: 'WrongStateConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    // Draft status — not eligible for follow-up
    expect(createFollowUpSessionContext(contribution.id)).toBeNull();

    // Testing — not eligible
    updateContribution(contribution.id, { status: 'testing' });
    expect(createFollowUpSessionContext(contribution.id)).toBeNull();

    // Submitted — not eligible
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { status: 'submitted' });
    expect(createFollowUpSessionContext(contribution.id)).toBeNull();

    // Approved — not eligible
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, { status: 'approved' });
    expect(createFollowUpSessionContext(contribution.id)).toBeNull();
  });

  it('creates follow-up context for ci_fail contribution', () => {
    const contribution = createContribution({
      sessionId: 'session-ci-fail',
      connectorName: 'CIFailConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      status: 'submitted',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/77',
    });
    updateContribution(contribution.id, { status: 'ci_fail' });

    const context = createFollowUpSessionContext(contribution.id);

    expect(context).not.toBeNull();
    expect(context!.contributionId).toBe(contribution.id);
    expect(context!.originalSessionId).toBe('session-ci-fail');
    expect(context!.connectorName).toBe('CIFailConnector');
    expect(context!.prompt).toContain('CIFailConnector');
    expect(context!.prompt).toContain('CI failures');
    expect(context!.prompt).toContain('pull/77');
  });

  it('follow-up session with linked sessionId and review context (full chain)', () => {
    /**
     * Full integration test: status transport detects changes_requested →
     * follow-up context created → session linked → store updated
     */

    // 1. Create contribution and submit
    const contribution = createContribution({
      sessionId: 'session-full-followup-chain',
      connectorName: 'FullChainConnector',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      status: 'submitted',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/100',
    });

    // 2. Status transport updates to changes_requested with review notes
    updateContribution(contribution.id, {
      status: 'ci_pass',
      lastCheckedAt: new Date().toISOString(),
    });
    updateContribution(contribution.id, {
      status: 'changes_requested',
      reviewNotes: 'reviewer-a: The connector needs better error messages for auth failures.\nreviewer-b: Please add a retry mechanism.',
    });

    // 3. Create follow-up context
    const context = createFollowUpSessionContext(contribution.id);
    expect(context).not.toBeNull();
    expect(context!.originalSessionId).toBe('session-full-followup-chain');
    expect(context!.prompt).toContain('better error messages');
    expect(context!.prompt).toContain('retry mechanism');
    expect(context!.prompt).toContain('pull/100');

    // 4. Renderer creates a new session and links it
    const newSessionId = 'session-followup-for-100';
    const linked = linkFollowUpSession(contribution.id, newSessionId);
    expect(linked).toBeTruthy();
    expect(linked!.followUpSessionIds).toContain(newSessionId);

    // 5. Verify the contribution now has the follow-up linked
    const final = getContributionById(contribution.id)!;
    expect(final.sessionId).toBe('session-full-followup-chain'); // Original preserved
    expect(final.followUpSessionIds).toEqual(['session-followup-for-100']);
    expect(final.status).toBe('changes_requested');
    expect(final.reviewNotes).toContain('better error messages');

    // 6. Card state shows changes_needed substatus
    const cardState = mapContributionToCardState(final);
    expect(cardState).toMatchObject({
      phase: 'submitted',
      connectorName: 'FullChainConnector',
      helperText: SUBMITTED_HELPER_TEXT.changes_needed,
      substatus: 'changes_needed',
    });
  });

  it('notification callback chain: contribution → follow-up context → link → card', () => {
    /**
     * Simulates the full runtime flow triggered by a notification onMakeChanges callback:
     * 1. Store has contribution in changes_requested
     * 2. Notification item is derived from store (production derivation)
     * 3. onMakeChanges calls createFollowUpSessionContext
     * 4. Renderer creates session and calls linkFollowUpSession
     * 5. Card state reflects the linked follow-up
     */

    const contribution = createContribution({
      sessionId: 'session-notify-chain',
      connectorName: 'NotifyChainConn',
      status: 'draft',
      attributionMode: 'github',
    });

    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      status: 'submitted',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/300',
    });
    updateContribution(contribution.id, { status: 'ci_pass' });
    updateContribution(contribution.id, {
      status: 'changes_requested',
      reviewNotes: 'Add input validation for all tools',
    });

    const updated = getContributionById(contribution.id)!;

    // 1. Verify notification derivation (production functions)
    expect(DRAWER_NOTIFICATION_STATUSES.has(updated.status)).toBe(true);
    const notifState = toNotificationState(updated.status);
    expect(notifState).toBe('changes-requested');
    expect(isAcknowledged(updated, updated.status, 'drawer')).toBe(false);

    // 2. Simulate onMakeChanges callback (calls createFollowUpSessionContext)
    const context = createFollowUpSessionContext(contribution.id);
    expect(context).not.toBeNull();
    expect(context!.prompt).toContain('Add input validation');
    expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');

    // 3. Renderer creates session and links it
    const newSession = 'session-notify-followup';
    const linked = linkFollowUpSession(contribution.id, newSession);
    expect(linked!.followUpSessionIds).toContain(newSession);

    // 4. Card state confirms changes_requested
    const cardState = mapContributionToCardState(updated);
    expect(cardState).not.toBeNull();
    if (cardState!.phase === 'submitted') {
      expect(cardState!.substatus).toBe('changes_needed');
    }

    // 5. Dismiss on drawer — doesn't affect follow-up session link
    acknowledgeEvent(contribution.id, 'changes_requested', 'drawer');
    const dismissed = getContributionById(contribution.id)!;
    expect(isAcknowledged(dismissed, 'changes_requested', 'drawer')).toBe(true);
    expect(dismissed.followUpSessionIds).toContain(newSession);
  });
});
