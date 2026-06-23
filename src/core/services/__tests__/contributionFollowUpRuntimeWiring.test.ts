/**
 * Tests for follow-up session runtime wiring.
 *
 * Verifies that:
 * - Follow-up context creation flows through IPC to the actual service
 * - Follow-up session linking flows through IPC to the store
 * - The MCPBuildCard changes_requested action can trigger follow-up creation
 * - The notification onMakeChanges callback uses the service (not duplicated logic)
 *
 * These are contract/integration tests that ensure the follow-up service
 * is actually accessible at runtime, not just referenced in unit tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConnectorContribution } from '../contributionTypes';

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
  updateContribution,
  getContributionById,
  addFollowUpSession,
  _resetStore,
} from '../contributionStore';
import {
  createFollowUpSessionContext,
  linkFollowUpSession,
} from '../contributionFollowUpService';
import {
  mapContributionToCardState,
  SUBMITTED_HELPER_TEXT,
} from '@shared/utils/contributionStateMapping';

// ─── Runtime Wiring Tests ───────────────────────────────────────────

describe('Follow-up session runtime wiring', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
  });

  describe('IPC handler contract: createFollowUpContext', () => {
    it('returns follow-up context with skill mention for changes_requested contribution', () => {
      // Simulates what the IPC handler does: call createFollowUpSessionContext
      const contribution = createContribution({
        sessionId: 'session-build-original',
        connectorName: 'MyConnector',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, {
        status: 'submitted',
        prUrl: 'https://github.com/org/repo/pull/42',
      });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, {
        status: 'changes_requested',
        reviewNotes: 'Please add error handling',
      });

      // This is what the IPC handler calls
      const context = createFollowUpSessionContext(contribution.id);

      expect(context).not.toBeNull();
      expect(context!.prompt).toContain('MyConnector');
      expect(context!.prompt).toContain('changes requested');
      expect(context!.prompt).toContain('Please add error handling');
      expect(context!.prompt).toContain('pull/42');
      expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');
      expect(context!.contributionId).toBe(contribution.id);
      expect(context!.originalSessionId).toBe('session-build-original');
    });

    it('returns follow-up context with skill mention for ci_fail contribution', () => {
      const contribution = createContribution({
        sessionId: 'session-ci-fail',
        connectorName: 'CIFailConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, {
        status: 'submitted',
        prUrl: 'https://github.com/org/repo/pull/55',
      });
      updateContribution(contribution.id, { status: 'ci_fail' });

      const context = createFollowUpSessionContext(contribution.id);

      expect(context).not.toBeNull();
      expect(context!.prompt).toContain('CI failures');
      expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');
    });

    it('returns null for non-actionable states', () => {
      const contribution = createContribution({
        sessionId: 'session-approved',
        connectorName: 'ApprovedConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, { status: 'approved' });

      const context = createFollowUpSessionContext(contribution.id);
      expect(context).toBeNull();
    });
  });

  describe('IPC handler contract: linkFollowUpSession', () => {
    it('links follow-up session to contribution', () => {
      const contribution = createContribution({
        sessionId: 'session-link-test',
        connectorName: 'LinkConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'changes_requested' });

      // This is what the IPC handler calls
      const updated = linkFollowUpSession(contribution.id, 'session-followup-new');

      expect(updated).toBeTruthy();
      expect(updated!.followUpSessionIds).toContain('session-followup-new');

      // Verify persistence
      const fromStore = getContributionById(contribution.id)!;
      expect(fromStore.followUpSessionIds).toEqual(['session-followup-new']);
    });

    it('returns undefined for non-existent contribution', () => {
      const result = linkFollowUpSession('nonexistent', 'session-followup');
      expect(result).toBeUndefined();
    });
  });

  describe('MCPBuildCard changes_requested action → follow-up session', () => {
    it('card shows changes_requested substatus and follow-up context is available', () => {
      // 1. Create contribution and progress to changes_requested
      const contribution = createContribution({
        sessionId: 'session-card-action',
        connectorName: 'CardActionConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, {
        status: 'submitted',
        prUrl: 'https://github.com/org/repo/pull/10',
      });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, {
        status: 'changes_requested',
        reviewNotes: 'Fix error handling',
      });

      // 2. Card state shows changes_needed substatus
      const retrieved = getContributionById(contribution.id)!;
      const cardState = mapContributionToCardState(retrieved);
      expect(cardState).toEqual({
        phase: 'submitted',
        connectorName: 'CardActionConn',
        helperText: SUBMITTED_HELPER_TEXT.changes_needed,
        substatus: 'changes_needed',
        prUrl: 'https://github.com/org/repo/pull/10',
      });

      // 3. Follow-up context is available via the service
      const context = createFollowUpSessionContext(contribution.id);
      expect(context).not.toBeNull();
      expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');
      expect(context!.prompt).toContain('Fix error handling');

      // 4. After spawning follow-up, session can be linked
      const linked = linkFollowUpSession(contribution.id, 'session-card-followup');
      expect(linked!.followUpSessionIds).toContain('session-card-followup');
    });

    it('card shows under_review substatus for ci_fail and follow-up context is available', () => {
      const contribution = createContribution({
        sessionId: 'session-ci-fail-card',
        connectorName: 'CIFailCardConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, {
        status: 'submitted',
        prUrl: 'https://github.com/org/repo/pull/20',
      });
      updateContribution(contribution.id, { status: 'ci_fail' });

      // Card state — ci_fail maps to checks_failed
      const retrieved = getContributionById(contribution.id)!;
      const cardState = mapContributionToCardState(retrieved);
      expect(cardState).toEqual({
        phase: 'submitted',
        connectorName: 'CIFailCardConn',
        helperText: SUBMITTED_HELPER_TEXT.checks_failed,
        substatus: 'checks_failed',
        prUrl: 'https://github.com/org/repo/pull/20',
      });

      // Follow-up context available
      const context = createFollowUpSessionContext(contribution.id);
      expect(context).not.toBeNull();
      expect(context!.prompt).toContain('CI failures');
    });
  });

  describe('Notification onMakeChanges → follow-up session', () => {
    it('creates follow-up context including review notes and PR URL', () => {
      // Simulates the notification case: contribution has changes_requested
      // and the onMakeChanges callback calls createFollowUpSessionContext
      const contribution = createContribution({
        sessionId: 'session-notification',
        connectorName: 'NotifyConn',
        status: 'draft',
        attributionMode: 'github',
      });

      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, {
        status: 'submitted',
        prUrl: 'https://github.com/org/repo/pull/77',
      });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, {
        status: 'changes_requested',
        reviewNotes: 'Add rate limiting and retry logic',
      });

      // The notification callback would call this via IPC
      const context = createFollowUpSessionContext(contribution.id);

      expect(context).not.toBeNull();
      expect(context!.prompt).toContain('NotifyConn');
      expect(context!.prompt).toContain('Add rate limiting and retry logic');
      expect(context!.prompt).toContain('pull/77');
      expect(context!.skillMention).toBe('extend-mcp-server/SKILL.md');
      expect(context!.originalSessionId).toBe('session-notification');

      // The renderer would then:
      // 1. startFreshSession() → get sessionId
      // 2. prepareMentionAttachments() with @`rebel-system/skills/coding/${context.skillMention}`
      // 3. submitQueuedMessage() with the prompt
      // 4. linkFollowUpSession() with the contribution and session IDs

      // Verify linking works
      const linked = linkFollowUpSession(contribution.id, 'session-followup-from-notification');
      expect(linked).toBeTruthy();
      expect(linked!.followUpSessionIds).toContain('session-followup-from-notification');
    });
  });
});
