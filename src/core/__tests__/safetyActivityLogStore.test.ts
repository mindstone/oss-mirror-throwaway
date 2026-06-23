import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityLogEntry,
  EvaluationEntry,
  VersionChangeEntry,
} from '@core/safetyActivityLogTypes';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from '@core/safetyActivityLogTypes';
import { VersionChangeEntrySchema } from '@shared/ipc/channels/safetyActivityLog';
import { initTestPlatformConfig } from './testHelpers';

const makeEvaluationEntry = (overrides: Partial<EvaluationEntry> = {}): EvaluationEntry => ({
  id: 'evaluation-1',
  timestamp: 1_000,
  type: 'evaluation',
  toolDisplayName: 'Send Slack message',
  toolId: 'slack_send_message',
  actionSummary: 'Sent message to #general',
  decision: 'allowed',
  reason: 'User permitted Slack messages',
  sessionType: 'interactive',
  source: 'safety-prompt',
  flagged: false,
  ...overrides,
});

const makeVersionChangeEntry = (
  overrides: Partial<VersionChangeEntry> = {},
): VersionChangeEntry => ({
  id: 'version-change-1',
  timestamp: 1_000,
  type: 'version-change',
  fromVersion: 1,
  toVersion: 2,
  source: 'system',
  ...overrides,
});

describe('safetyActivityLogStore', () => {
  let storeModule: typeof import('@core/safetyActivityLogStore');

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
    storeModule = await import('@core/safetyActivityLogStore');
    storeModule.resetStoreForTesting();
  });

  it('getActivityLog returns empty array on fresh store', () => {
    expect(storeModule.getActivityLog()).toEqual([]);
  });

  it('addEvaluationEntry adds an entry and getActivityLog returns it', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Send Slack message',
      toolId: 'slack_send_message',
      actionSummary: 'Sent message to #general',
      decision: 'allowed',
      reason: 'User permitted Slack messages',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'evaluation',
      toolDisplayName: 'Send Slack message',
      toolId: 'slack_send_message',
      decision: 'allowed',
      source: 'safety-prompt',
      flagged: false,
    });
    expect(entries[0].id).toBeTruthy();
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it('addVersionChangeEntry adds a version-change entry', () => {
    storeModule.addVersionChangeEntry(5, 6, 'chat-intent');

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'version-change',
      fromVersion: 5,
      toVersion: 6,
      source: 'chat-intent',
    });
  });

  it('getActivityLog returns entries newest-first', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Tool A',
      toolId: 'tool_a',
      actionSummary: 'First action',
      decision: 'allowed',
      reason: 'reason',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });
    storeModule.addVersionChangeEntry(1, 2);
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Tool B',
      toolId: 'tool_b',
      actionSummary: 'Third action',
      decision: 'blocked',
      reason: 'blocked reason',
      sessionType: 'automation',
      automationName: 'Daily digest',
      source: 'safety-prompt',
      flagged: false,
    });

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(3);
    // Newest first — the last added entry should be first
    expect(entries[0].type).toBe('evaluation');
    if (entries[0].type === 'evaluation') {
      expect(entries[0].toolId).toBe('tool_b');
    }
    expect(entries[1].type).toBe('version-change');
    expect(entries[2].type).toBe('evaluation');
    if (entries[2].type === 'evaluation') {
      expect(entries[2].toolId).toBe('tool_a');
    }
  });

  it('flagEntry flags an evaluation entry and returns true', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Tool A',
      toolId: 'tool_a',
      actionSummary: 'Action',
      decision: 'allowed',
      reason: 'reason',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });

    const entries = storeModule.getActivityLog();
    const entryId = entries[0].id;
    const result = storeModule.flagEntry(entryId);

    expect(result).toBe(true);
    const updated = storeModule.getActivityLog();
    if (updated[0].type === 'evaluation') {
      expect(updated[0].flagged).toBe(true);
    }
  });

  it('flagEntry returns false for unknown entry ID', () => {
    expect(storeModule.flagEntry('nonexistent-id')).toBe(false);
  });

  it('flagEntry returns false for version-change entries', () => {
    storeModule.addVersionChangeEntry(1, 2);
    const entries = storeModule.getActivityLog();
    expect(storeModule.flagEntry(entries[0].id)).toBe(false);
  });

  it('flagEntry returns false for blocked evaluation entries', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Export CSV',
      toolId: 'export_csv',
      actionSummary: 'Exported customer data',
      decision: 'blocked',
      reason: 'Not allowed',
      sessionType: 'automation',
      source: 'safety-prompt',
      flagged: false,
    });
    const entries = storeModule.getActivityLog();
    expect(storeModule.flagEntry(entries[0].id)).toBe(false);
  });

  it('ring buffer drops oldest entries when exceeding max capacity', () => {
    // Add 505 entries (max is 500)
    for (let i = 0; i < 505; i++) {
      storeModule.addEvaluationEntry({
        toolDisplayName: `Tool ${i}`,
        toolId: `tool_${i}`,
        actionSummary: `Action ${i}`,
        decision: 'allowed',
        reason: 'reason',
        sessionType: 'interactive',
        source: 'safety-prompt',
        flagged: false,
      });
    }

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(500);

    // Newest first — entry 504 should be first, entry 5 should be last
    if (entries[0].type === 'evaluation') {
      expect(entries[0].toolId).toBe('tool_504');
    }
    if (entries[499].type === 'evaluation') {
      expect(entries[499].toolId).toBe('tool_5');
    }
  });

  it('mergeEntries is idempotent for repeated cloud fetches', () => {
    const incoming = [
      makeEvaluationEntry({ id: 'cloud-evaluation-1', timestamp: 1_000 }),
      makeVersionChangeEntry({ id: 'cloud-version-1', timestamp: 2_000 }),
    ];

    expect(storeModule.mergeEntries(incoming)).toEqual({ added: 2 });
    expect(storeModule.mergeEntries(incoming)).toEqual({ added: 0 });

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  });

  it('mergeEntries dedups by id across desktop and cloud streams', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Local tool',
      toolId: 'local_tool',
      actionSummary: 'Local action',
      decision: 'allowed',
      reason: 'Local audit text',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });
    const localEntry = storeModule.getActivityLog()[0];
    const incoming = [
      makeEvaluationEntry({
        id: localEntry.id,
        timestamp: localEntry.timestamp,
        toolDisplayName: 'Cloud rewrite attempt',
        reason: 'Cloud rewrite text',
      }),
      makeEvaluationEntry({ id: 'cloud-only-entry', timestamp: localEntry.timestamp + 1 }),
    ];

    expect(storeModule.mergeEntries(incoming)).toEqual({ added: 1 });

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.id === localEntry.id)).toHaveLength(1);
    const preservedLocalEntry = entries.find((entry) => entry.id === localEntry.id);
    expect(preservedLocalEntry).toMatchObject({
      type: 'evaluation',
      toolDisplayName: 'Local tool',
      reason: 'Local audit text',
    });
    expect(preservedLocalEntry?.executionSurface).toBeUndefined();
  });

  it('mergeEntries re-caps to the 500 newest with deterministic same-timestamp order', () => {
    const incoming: ActivityLogEntry[] = Array.from(
      { length: SAFETY_ACTIVITY_LOG_MAX_ENTRIES + 5 },
      (_, index) =>
        makeEvaluationEntry({
          id: `entry-${String(index).padStart(3, '0')}`,
          timestamp: index < 5 ? 999 : 1_000,
          toolId: `tool_${index}`,
        }),
    );

    expect(storeModule.mergeEntries(incoming)).toEqual({
      added: SAFETY_ACTIVITY_LOG_MAX_ENTRIES + 5,
    });

    const entries = storeModule.getActivityLog();
    expect(entries).toHaveLength(SAFETY_ACTIVITY_LOG_MAX_ENTRIES);
    expect(entries[0].id).toBe('entry-504');
    expect(entries[entries.length - 1].id).toBe('entry-005');
    expect(entries.map((entry) => entry.id)).not.toContain('entry-004');
  });

  it('mergeEntries preserves a locally flagged existing entry on re-merge', () => {
    const original = makeEvaluationEntry({
      id: 'flagged-cloud-entry',
      decision: 'allowed',
      flagged: false,
    });
    storeModule.mergeEntries([original]);
    expect(storeModule.flagEntry(original.id)).toBe(true);

    storeModule.mergeEntries([
      makeEvaluationEntry({
        ...original,
        flagged: false,
        reason: 'Re-fetched unflagged copy',
      }),
    ]);

    const entry = storeModule.getActivityLog().find((candidate) => candidate.id === original.id);
    expect(entry).toMatchObject({ type: 'evaluation', flagged: true, reason: original.reason });
  });

  it('mergeEntries keeps existing audit fields immutable for same-id entries', () => {
    const original = makeEvaluationEntry({
      id: 'immutable-audit-entry',
      actionSummary: 'Original action summary',
      reason: 'Original reason',
    });
    storeModule.mergeEntries([original]);

    storeModule.mergeEntries([
      makeEvaluationEntry({
        ...original,
        actionSummary: 'Rewritten action summary',
        reason: 'Rewritten reason',
      }),
    ]);

    const entry = storeModule.getActivityLog().find((candidate) => candidate.id === original.id);
    expect(entry).toMatchObject({
      type: 'evaluation',
      actionSummary: 'Original action summary',
      reason: 'Original reason',
    });
  });

  it('mergeEntries stamps incoming entries as cloud execution surface', () => {
    storeModule.mergeEntries([
      makeEvaluationEntry({
        id: 'cloud-stamped-entry',
        executionSurface: 'desktop',
      }),
    ]);

    expect(storeModule.getActivityLog()[0]).toMatchObject({
      id: 'cloud-stamped-entry',
      executionSurface: 'cloud',
    });
  });

  it('preserves VersionChangeEntry source after schema parse and merge', () => {
    const parsed = VersionChangeEntrySchema.parse(
      makeVersionChangeEntry({
        id: 'version-change-with-source',
        source: 'settings-editor',
      }),
    );

    expect(storeModule.mergeEntries([parsed])).toEqual({ added: 1 });

    expect(storeModule.getActivityLog()[0]).toMatchObject({
      type: 'version-change',
      source: 'settings-editor',
      executionSurface: 'cloud',
    });
  });

  it('mergeEntries reads current entries at write time and preserves a desktop append', () => {
    const incoming = [
      makeEvaluationEntry({ id: 'cloud-after-local-append', timestamp: Date.now() + 1 }),
    ];
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Desktop append',
      toolId: 'desktop_append',
      actionSummary: 'Desktop action before cloud merge',
      decision: 'allowed',
      reason: 'Local append should survive',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });
    const desktopEntry = storeModule.getActivityLog()[0];

    expect(storeModule.mergeEntries(incoming)).toEqual({ added: 1 });

    const ids = storeModule.getActivityLog().map((entry) => entry.id);
    expect(ids).toContain(desktopEntry.id);
    expect(ids).toContain('cloud-after-local-append');
  });

  it('clearActivityLog removes all entries', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Tool',
      toolId: 'tool',
      actionSummary: 'Action',
      decision: 'allowed',
      reason: 'reason',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });
    storeModule.addVersionChangeEntry(1, 2);

    expect(storeModule.getActivityLog()).toHaveLength(2);
    storeModule.clearActivityLog();
    expect(storeModule.getActivityLog()).toHaveLength(0);
  });

  it('addEvaluationEntry with automation session type includes automationName', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Export CSV',
      toolId: 'export_csv',
      actionSummary: 'Exported customer data',
      decision: 'blocked',
      reason: 'External data export not allowed',
      sessionType: 'automation',
      automationName: 'Daily digest',
      source: 'safety-prompt',
      flagged: false,
    });

    const entries = storeModule.getActivityLog();
    expect(entries[0]).toMatchObject({
      type: 'evaluation',
      sessionType: 'automation',
      automationName: 'Daily digest',
    });
  });

  it('resetStoreForTesting allows re-initialization', () => {
    storeModule.addEvaluationEntry({
      toolDisplayName: 'Tool',
      toolId: 'tool',
      actionSummary: 'Action',
      decision: 'allowed',
      reason: 'reason',
      sessionType: 'interactive',
      source: 'safety-prompt',
      flagged: false,
    });

    expect(storeModule.getActivityLog()).toHaveLength(1);

    storeModule.resetStoreForTesting();

    // After reset, store is re-initialized with defaults on next access
    expect(storeModule.getActivityLog()).toHaveLength(0);
  });
});
