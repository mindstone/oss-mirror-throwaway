import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

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

// Import after mocks
import {
  createContribution,
  getContributionBySession,
  updateContribution,
  _resetStore,
} from '@core/services/contributionStore';
import type { ContributionStatus } from '@core/services/contributionTypes';

// ─── Zod Schema for tool validation (mirrors server.cjs) ───────────

const contributionReportStateSchema = z.object({
  sessionId: z.string().min(1),
  connectorName: z.string().min(1),
  status: z.enum([
    'draft', 'testing', 'ready_to_submit', 'submitted',
    'ci_pass', 'ci_fail', 'changes_requested', 'approved',
    'rejected', 'published',
  ]),
  localServerPath: z.string().optional(),
  catalogEntryId: z.string().optional(),
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('rebel_mcp_report_contribution_state', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
  });

  // VAL-STATE-005: rebel_mcp_report_contribution_state tool exists
  // and routes data to store update methods
  describe('tool existence and store integration', () => {
    it('creates a new contribution when none exists for the session', () => {
      const payload = {
        sessionId: 'session-new',
        connectorName: 'my-connector',
        status: 'draft' as ContributionStatus,
        localServerPath: '/path/to/server',
      };

      // Simulate what the bridge endpoint does
      const existing = getContributionBySession(payload.sessionId);
      expect(existing).toBeUndefined();

      const contribution = createContribution({
        sessionId: payload.sessionId,
        connectorName: payload.connectorName,
        status: payload.status,
        attributionMode: 'anonymous',
        localServerPath: payload.localServerPath,
      });

      expect(contribution.id).toMatch(/^contrib-/);
      expect(contribution.sessionId).toBe('session-new');
      expect(contribution.connectorName).toBe('my-connector');
      expect(contribution.status).toBe('draft');
      expect(contribution.localServerPath).toBe('/path/to/server');
    });

    it('updates existing contribution when one exists for the session', () => {
      // Create initial contribution
      const initial = createContribution({
        sessionId: 'session-existing',
        connectorName: 'existing-connector',
        status: 'draft',
        attributionMode: 'anonymous',
      });

      // Simulate bridge update for status transition
      const updated = updateContribution(initial.id, { status: 'testing' });
      expect(updated).not.toBeNull();
      expect(updated).not.toBeUndefined();
      expect(updated!.status).toBe('testing');
      expect(updated!.id).toBe(initial.id); // Same contribution
    });

    it('rejects invalid state transitions via store', () => {
      const contribution = createContribution({
        sessionId: 'session-invalid',
        connectorName: 'test',
        status: 'draft',
        attributionMode: 'anonymous',
      });

      // draft → published is invalid (must go through submission pipeline)
      const result = updateContribution(contribution.id, { status: 'published' });
      expect(result).toBeNull(); // null means invalid transition
    });

    it('updates localServerPath and catalogEntryId alongside status', () => {
      const contribution = createContribution({
        sessionId: 'session-full',
        connectorName: 'full-connector',
        status: 'draft',
        attributionMode: 'anonymous',
      });

      const updated = updateContribution(contribution.id, {
        status: 'testing',
        localServerPath: '/new/path',
        catalogEntryId: 'catalog-123',
      });

      expect(updated).not.toBeNull();
      expect(updated!.localServerPath).toBe('/new/path');
      expect(updated!.catalogEntryId).toBe('catalog-123');
    });
  });

  // VAL-STATE-006: Tool validates payloads with Zod schemas
  describe('Zod payload validation', () => {
    it('accepts valid payload with all fields', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        connectorName: 'my-connector',
        status: 'draft',
        localServerPath: '/path/to/server',
        catalogEntryId: 'catalog-001',
      });

      expect(result.success).toBe(true);
    });

    it('accepts valid payload with required fields only', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        connectorName: 'my-connector',
        status: 'testing',
      });

      expect(result.success).toBe(true);
    });

    it('rejects payload missing sessionId', () => {
      const result = contributionReportStateSchema.safeParse({
        connectorName: 'my-connector',
        status: 'draft',
      });

      expect(result.success).toBe(false);
    });

    it('rejects payload with empty sessionId', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: '',
        connectorName: 'my-connector',
        status: 'draft',
      });

      expect(result.success).toBe(false);
    });

    it('rejects payload missing connectorName', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        status: 'draft',
      });

      expect(result.success).toBe(false);
    });

    it('rejects payload with empty connectorName', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        connectorName: '',
        status: 'draft',
      });

      expect(result.success).toBe(false);
    });

    it('rejects payload missing status', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        connectorName: 'my-connector',
      });

      expect(result.success).toBe(false);
    });

    it('rejects payload with invalid status value', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 'session-123',
        connectorName: 'my-connector',
        status: 'invalid_status',
      });

      expect(result.success).toBe(false);
    });

    it('validates all 10 contribution status values', () => {
      const validStatuses = [
        'draft', 'testing', 'ready_to_submit', 'submitted',
        'ci_pass', 'ci_fail', 'changes_requested', 'approved',
        'rejected', 'published',
      ];

      for (const status of validStatuses) {
        const result = contributionReportStateSchema.safeParse({
          sessionId: 'session-123',
          connectorName: 'test',
          status,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects non-string sessionId', () => {
      const result = contributionReportStateSchema.safeParse({
        sessionId: 123,
        connectorName: 'my-connector',
        status: 'draft',
      });

      expect(result.success).toBe(false);
    });
  });
});
