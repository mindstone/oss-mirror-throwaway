 
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fm from 'front-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { settingsState, mockWarn } = vi.hoisted(() => ({
  settingsState: { coreDirectory: '' },
  mockWarn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: mockWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/featureGating', () => ({
  isFeatureEnabled: vi.fn(() => true),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      refreshLicenseTier: vi.fn(() => Promise.resolve()),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: settingsState.coreDirectory,
    mcpConfigFile: null,
    onboardingCompleted: true,
  })),
  updateSettings: vi.fn(),
}));

vi.mock('../inboxStore', () => ({
  addInboxItem: vi.fn(() => ({ accepted: true, itemId: 'mock-item-id', state: { version: 1, items: [], history: [] } })),
  updateInboxItem: vi.fn(() => ({ version: 1, items: [], history: [] })),
  removeInboxItem: vi.fn(() => ({ version: 1, items: [], history: [] })),
  getInboxState: vi.fn(() => ({ version: 1, items: [], history: [] })),
  setInboxItemArchived: vi.fn(),
  setInboxItemQuadrant: vi.fn(),
}));

vi.mock('../spaceService', () => ({
  validateSpacePath: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  scanSpaces: vi.fn(() => Promise.resolve([])),
  createSpace: vi.fn(),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(() => Promise.resolve(null)),
    listSessions: vi.fn(() => Promise.resolve([])),
  })),
}));

vi.mock('../meetingHistoryStore', () => ({
  getMeetingsInRange: vi.fn(() => []),
  getMissedMeetings: vi.fn(() => []),
}));

vi.mock('../conversationSummaryService', () => ({
  generateConversationSummary: vi.fn(),
}));

vi.mock('../../utils/logRedaction', () => ({
  redactObjectDeep: vi.fn((obj: unknown) => obj),
}));

vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => null),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(() => Promise.resolve()),
  reloadSuperMcpNowForChatPackageMaterialization: vi.fn(() => Promise.resolve()),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

import { startBundledInboxBridge, stopBundledInboxBridge } from '../bundledInboxBridge';

const toIsoString = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

async function writePrepDoc(
  relativePath: string,
  frontmatter: string,
  body = '## Prep\n\n- Agenda item',
): Promise<string> {
  const absolutePath = path.join(settingsState.coreDirectory, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `---\n${frontmatter.trim()}\n---\n\n${body}\n`, 'utf8');
  return absolutePath;
}

async function callEnrichmentEndpoint(payload: {
  filePath: string;
  goalAlignment: Array<{ goal: string; space: string }>;
  meetingUtility: 'productive' | 'blocker' | 'noise' | 'travel';
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port, token } = await startBundledInboxBridge();
  const response = await fetch(`http://127.0.0.1:${port}/focus/enrich-prep-doc`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('POST /focus/enrich-prep-doc', () => {
  beforeEach(async () => {
    settingsState.coreDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-enrichment-endpoint-'));
    mockWarn.mockReset();
  });

  afterEach(async () => {
    await stopBundledInboxBridge();
    if (settingsState.coreDirectory) {
      await fs.rm(settingsState.coreDirectory, { recursive: true, force: true });
    }
    settingsState.coreDirectory = '';
  });

  it('successfully enriches a prep doc and keeps existing fields', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/14/260414_1400_meeting_board-strategy-prep.md';
    const absolutePath = await writePrepDoc(
      relativePath,
      `
type: meeting-prep
title: "Board Strategy Meeting"
meetingStartTime: 2026-04-14T14:00:00.000Z
meetingId: "google:abc123"
participants:
  - "Alice"
created: 2026-04-09T10:30:00.000Z
      `,
    );

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      meetingUtility: 'productive',
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });

    const updated = await fs.readFile(absolutePath, 'utf8');
    const parsed = fm<Record<string, unknown>>(updated);
    expect(parsed.attributes.type).toBe('meeting-prep');
    expect(parsed.attributes.title).toBe('Board Strategy Meeting');
    expect(parsed.attributes.goal_alignment).toEqual([{ goal: 'Launch Q2 strategy', space: 'Personal' }]);
    expect(parsed.attributes.meeting_utility).toBe('productive');
    expect(parsed.attributes.enriched_by).toBe('focus-automation');
    expect(new Date(String(parsed.attributes.enriched_at)).toString()).not.toBe('Invalid Date');
    expect(parsed.body.trim()).toBe('## Prep\n\n- Agenda item');
  });

  it('preserves full existing frontmatter on round-trip', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/15/260415_0900_meeting_exec-sync-prep.md';
    const absolutePath = await writePrepDoc(
      relativePath,
      `
type: meeting-prep
title: "Executive Sync"
meetingStartTime: 2026-04-15T09:00:00.000Z
meetingId: "google:exec123"
participants:
  - "Alice"
  - "Bob"
created: 2026-04-10T09:15:00.000Z
prep: "./260415_0900_meeting_exec-sync.md"
transcript: "./260415_0900_meeting_exec-sync.md"
      `,
      '# Executive Sync Prep',
    );

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment: [{ goal: 'Ship mobile app v1', space: 'Mindstone' }],
      meetingUtility: 'productive',
    });

    expect(result.status).toBe(200);

    const updated = await fs.readFile(absolutePath, 'utf8');
    const { attributes } = fm<Record<string, unknown>>(updated);
    expect(attributes.type).toBe('meeting-prep');
    expect(attributes.title).toBe('Executive Sync');
    expect(toIsoString(attributes.meetingStartTime)).toBe('2026-04-15T09:00:00.000Z');
    expect(attributes.meetingId).toBe('google:exec123');
    expect(attributes.participants).toEqual(['Alice', 'Bob']);
    expect(toIsoString(attributes.created)).toBe('2026-04-10T09:15:00.000Z');
    expect(attributes.prep).toBe('./260415_0900_meeting_exec-sync.md');
    expect(attributes.transcript).toBe('./260415_0900_meeting_exec-sync.md');
  });

  it('writes nested goal_alignment arrays correctly', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/16/260416_1000_meeting_product-roadmap-prep.md';
    const absolutePath = await writePrepDoc(
      relativePath,
      `
type: meeting-prep
title: "Product Roadmap"
meetingStartTime: 2026-04-16T10:00:00.000Z
created: 2026-04-10T09:15:00.000Z
      `,
    );

    const goalAlignment = [
      { goal: 'Launch Q2 strategy', space: 'Personal' },
      { goal: 'Ship mobile app v1', space: 'Mindstone' },
    ];

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment,
      meetingUtility: 'travel',
    });

    expect(result.status).toBe(200);

    const updated = await fs.readFile(absolutePath, 'utf8');
    const parsed = fm<Record<string, unknown>>(updated);
    expect(parsed.attributes.goal_alignment).toEqual(goalAlignment);
  });

  it('rejects files that are not meeting-prep docs', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/17/260417_1000_misc-note.md';
    await writePrepDoc(
      relativePath,
      `
type: note
title: "Regular note"
created: 2026-04-10T09:15:00.000Z
      `,
    );

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      meetingUtility: 'productive',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('File is not a meeting prep document.');
  });

  it('rejects path traversal payloads', async () => {
    const result = await callEnrichmentEndpoint({
      filePath: '../outside.md',
      goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      meetingUtility: 'productive',
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe('filePath must be within workspace.');
  });

  it('accepts empty goalAlignment arrays', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/18/260418_1100_meeting_timezone-prep.md';
    const absolutePath = await writePrepDoc(
      relativePath,
      `
type: meeting-prep
title: "Timezone blocker"
meetingStartTime: 2026-04-18T11:00:00.000Z
created: 2026-04-10T09:15:00.000Z
      `,
    );

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment: [],
      meetingUtility: 'blocker',
    });

    expect(result.status).toBe(200);

    const updated = await fs.readFile(absolutePath, 'utf8');
    const parsed = fm<Record<string, unknown>>(updated);
    expect(parsed.attributes.goal_alignment).toEqual([]);
    expect(parsed.attributes.meeting_utility).toBe('blocker');
  });

  it('overwrites existing enrichment on already-enriched docs', async () => {
    const relativePath = 'memory/sources/2026/04-Apr/19/260419_1200_meeting_existing-prep.md';
    const absolutePath = await writePrepDoc(
      relativePath,
      `
type: meeting-prep
title: "Existing enrichment"
meetingStartTime: 2026-04-19T12:00:00.000Z
goal_alignment:
  - goal: "Old goal"
    space: "Old space"
meeting_utility: noise
enriched_at: 2026-04-01T12:00:00.000Z
enriched_by: focus-weekly-prep
      `,
    );

    const result = await callEnrichmentEndpoint({
      filePath: relativePath,
      goalAlignment: [{ goal: 'Ship mobile app v1', space: 'Mindstone' }],
      meetingUtility: 'productive',
    });

    expect(result.status).toBe(200);

    const updated = await fs.readFile(absolutePath, 'utf8');
    const parsed = fm<Record<string, unknown>>(updated);
    expect(parsed.attributes.goal_alignment).toEqual([{ goal: 'Ship mobile app v1', space: 'Mindstone' }]);
    expect(parsed.attributes.meeting_utility).toBe('productive');
    expect(parsed.attributes.enriched_by).toBe('focus-automation');
  });
});
