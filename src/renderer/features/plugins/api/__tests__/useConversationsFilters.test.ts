// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@renderer/test-utils/hookTestHarness';

// Mock sonner (required by pluginApiFactory)
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

// Controllable mock store state
let mockSessionSummaries: Array<{
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  isBusy: boolean;
  messageCount: number;
  preview: string;
  doneAt: number | null;
  starredAt: number | null;
  origin: string;
  deletedAt: number | null;
  resolvedAt: number | null;
  privateMode?: boolean;
}>;

let storeSubscribers: Set<() => void>;

vi.mock('@renderer/features/agent-session/store/sessionStore', () => {
  storeSubscribers = new Set();
  return {
    getSessionStoreState: () => ({
      sessionSummaries: mockSessionSummaries,
    }),
    subscribeToSessionStore: (cb: () => void) => {
      storeSubscribers.add(cb);
      return () => storeSubscribers.delete(cb);
    },
  };
});

// Mock PluginContext so usePluginId() returns a test plugin ID
vi.mock('../PluginContext', () => ({
  usePluginId: () => 'test-filter-plugin',
}));

// Mock permission guard to always allow (tests focus on filter logic, not permissions)
vi.mock('../pluginPermissions', () => ({
  createPermissionGuard: vi.fn(),
  checkPermission: () => true,
  getEffectivePermissions: () => ['conversations:read'],
  STANDARD_READ_PERMISSIONS: ['conversations:read'],
  ELEVATED_PERMISSIONS: [],
  EXTERNAL_PERMISSIONS: [],
}));

// Must import after mock setup
const { createPluginApiModule } = await import('../pluginApiFactory');

function makeSummary(overrides: Partial<typeof mockSessionSummaries[0]> = {}) {
  return {
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Chat',
    createdAt: 1000,
    updatedAt: 2000,
    isBusy: false,
    messageCount: 5,
    preview: 'Hello world',
    doneAt: null,
    starredAt: null,
    origin: 'manual',
    deletedAt: null,
    resolvedAt: null,
    privateMode: false,
    ...overrides,
  };
}

const navigateFn = vi.fn();
const openSessionFn = vi.fn();

describe('useConversations filters', () => {
  let mod: ReturnType<typeof createPluginApiModule>;

  beforeEach(() => {
    mockSessionSummaries = [];
    mod = createPluginApiModule(navigateFn, openSessionFn);
  });

  afterEach(() => {
    storeSubscribers.clear();
  });

  // ── includeDeleted ──────────────────────────────────────────────

  describe('includeDeleted', () => {
    it('excludes deleted sessions by default', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'active', deletedAt: null }),
        makeSummary({ id: 'deleted', deletedAt: 1700000000000 }),
      ];

      const { result, unmount } = renderHook(() => mod.useConversations());
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('active');
      expect(result.current.totalCount).toBe(1);
      unmount();
    });

    it('includes deleted sessions when includeDeleted is true', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'active', deletedAt: null }),
        makeSummary({ id: 'deleted', deletedAt: 1700000000000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ includeDeleted: true }),
      );
      expect(result.current.data).toHaveLength(2);
      expect(result.current.totalCount).toBe(2);
      unmount();
    });

    it('excludes deleted sessions when includeDeleted is false', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'active', deletedAt: null }),
        makeSummary({ id: 'deleted', deletedAt: 1700000000000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ includeDeleted: false }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('active');
      unmount();
    });
  });

  // ── origin ─────────────────────────────────────────────────────

  describe('origin filter', () => {
    it('filters by single origin string', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'manual-1', origin: 'manual' }),
        makeSummary({ id: 'auto-1', origin: 'automation' }),
        makeSummary({ id: 'plugin-1', origin: 'plugin' }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ origin: 'manual' }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('manual-1');
      expect(result.current.totalCount).toBe(1);
      unmount();
    });

    it('filters by array of origins', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'manual-1', origin: 'manual' }),
        makeSummary({ id: 'auto-1', origin: 'automation' }),
        makeSummary({ id: 'plugin-1', origin: 'plugin' }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ origin: ['manual', 'plugin'] }),
      );
      expect(result.current.data).toHaveLength(2);
      const ids = result.current.data.map(c => c.id);
      expect(ids).toContain('manual-1');
      expect(ids).toContain('plugin-1');
      expect(result.current.totalCount).toBe(2);
      unmount();
    });

    it('returns empty when no sessions match origin', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'manual-1', origin: 'manual' }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ origin: 'automation' }),
      );
      expect(result.current.data).toHaveLength(0);
      expect(result.current.totalCount).toBe(0);
      unmount();
    });
  });

  // ── isBusy ─────────────────────────────────────────────────────

  describe('isBusy filter', () => {
    it('filters to busy sessions only', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'busy', isBusy: true }),
        makeSummary({ id: 'idle', isBusy: false }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ isBusy: true }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('busy');
      expect(result.current.totalCount).toBe(1);
      unmount();
    });

    it('filters to idle sessions only', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'busy', isBusy: true }),
        makeSummary({ id: 'idle', isBusy: false }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ isBusy: false }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('idle');
      unmount();
    });

    it('does not filter by busy state when isBusy is undefined', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'busy', isBusy: true }),
        makeSummary({ id: 'idle', isBusy: false }),
      ];

      const { result, unmount } = renderHook(() => mod.useConversations());
      expect(result.current.data).toHaveLength(2);
      unmount();
    });
  });

  // ── dateRange ──────────────────────────────────────────────────

  describe('dateRange filter', () => {
    it('filters by after (createdAt by default)', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'old', createdAt: 1000, updatedAt: 5000 }),
        makeSummary({ id: 'new', createdAt: 3000, updatedAt: 4000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { after: 2000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('new');
      unmount();
    });

    it('filters by before (createdAt by default)', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'old', createdAt: 1000, updatedAt: 5000 }),
        makeSummary({ id: 'new', createdAt: 3000, updatedAt: 4000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { before: 2000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('old');
      unmount();
    });

    it('filters by both after and before', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'too-old', createdAt: 500, updatedAt: 5000 }),
        makeSummary({ id: 'in-range', createdAt: 1500, updatedAt: 4000 }),
        makeSummary({ id: 'too-new', createdAt: 3000, updatedAt: 6000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { after: 1000, before: 2000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('in-range');
      unmount();
    });

    it('uses updatedAt when dateField is updatedAt', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'old-created-new-updated', createdAt: 1000, updatedAt: 5000 }),
        makeSummary({ id: 'new-created-old-updated', createdAt: 3000, updatedAt: 2000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { after: 4000 }, dateField: 'updatedAt' }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('old-created-new-updated');
      unmount();
    });

    it('defaults to createdAt when dateField is not specified', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'old-created-new-updated', createdAt: 1000, updatedAt: 5000 }),
        makeSummary({ id: 'new-created-old-updated', createdAt: 3000, updatedAt: 2000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { after: 2000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('new-created-old-updated');
      unmount();
    });

    it('includes sessions at exact boundary timestamps', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'at-boundary', createdAt: 2000, updatedAt: 3000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ dateRange: { after: 2000, before: 2000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('at-boundary');
      unmount();
    });
  });

  // ── Combined filters ──────────────────────────────────────────

  describe('combined filters', () => {
    it('applies multiple filters together', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'match', origin: 'manual', isBusy: true, createdAt: 2000, deletedAt: null }),
        makeSummary({ id: 'wrong-origin', origin: 'automation', isBusy: true, createdAt: 2000, deletedAt: null }),
        makeSummary({ id: 'not-busy', origin: 'manual', isBusy: false, createdAt: 2000, deletedAt: null }),
        makeSummary({ id: 'too-old', origin: 'manual', isBusy: true, createdAt: 500, deletedAt: null }),
        makeSummary({ id: 'deleted', origin: 'manual', isBusy: true, createdAt: 2000, deletedAt: 9999 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({
          origin: 'manual',
          isBusy: true,
          dateRange: { after: 1000 },
        }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('match');
      expect(result.current.totalCount).toBe(1);
      unmount();
    });

    it('includeDeleted + origin together', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'active-manual', origin: 'manual', deletedAt: null }),
        makeSummary({ id: 'deleted-manual', origin: 'manual', deletedAt: 9999 }),
        makeSummary({ id: 'deleted-auto', origin: 'automation', deletedAt: 9999 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ includeDeleted: true, origin: 'manual' }),
      );
      expect(result.current.data).toHaveLength(2);
      const ids = result.current.data.map(c => c.id);
      expect(ids).toContain('active-manual');
      expect(ids).toContain('deleted-manual');
      unmount();
    });

    it('query + dateRange filters compose correctly', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'match', title: 'Meeting notes', createdAt: 2000 }),
        makeSummary({ id: 'wrong-title', title: 'Shopping list', createdAt: 2000 }),
        makeSummary({ id: 'wrong-date', title: 'Meeting prep', createdAt: 500 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ query: 'Meeting', dateRange: { after: 1000 } }),
      );
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('match');
      unmount();
    });
  });

  // ── totalCount reflects filters ───────────────────────────────

  describe('totalCount', () => {
    it('totalCount reflects post-filter count, not total sessions', () => {
      mockSessionSummaries = [
        makeSummary({ id: 's1', origin: 'manual' }),
        makeSummary({ id: 's2', origin: 'manual' }),
        makeSummary({ id: 's3', origin: 'automation' }),
        makeSummary({ id: 's4', origin: 'plugin' }),
        makeSummary({ id: 's5', origin: 'plugin', deletedAt: 9999 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ origin: 'manual' }),
      );
      expect(result.current.totalCount).toBe(2);
      expect(result.current.data).toHaveLength(2);
      unmount();
    });

    it('totalCount with pagination still reflects total filtered count', () => {
      mockSessionSummaries = [
        makeSummary({ id: 's1', origin: 'manual', updatedAt: 3000 }),
        makeSummary({ id: 's2', origin: 'manual', updatedAt: 2000 }),
        makeSummary({ id: 's3', origin: 'manual', updatedAt: 1000 }),
      ];

      const { result, unmount } = renderHook(() =>
        mod.useConversations({ origin: 'manual', limit: 1 }),
      );
      expect(result.current.totalCount).toBe(3);
      expect(result.current.data).toHaveLength(1);
      unmount();
    });
  });

  // ── Backward compatibility ────────────────────────────────────

  describe('backward compatibility', () => {
    it('no params returns all non-deleted sessions sorted by updatedAt desc', () => {
      mockSessionSummaries = [
        makeSummary({ id: 's1', updatedAt: 1000, deletedAt: null }),
        makeSummary({ id: 's2', updatedAt: 3000, deletedAt: null }),
        makeSummary({ id: 's3', updatedAt: 2000, deletedAt: null }),
        makeSummary({ id: 'deleted', updatedAt: 4000, deletedAt: 9999 }),
      ];

      const { result, unmount } = renderHook(() => mod.useConversations());
      expect(result.current.data).toHaveLength(3);
      expect(result.current.data[0].id).toBe('s2');
      expect(result.current.data[1].id).toBe('s3');
      expect(result.current.data[2].id).toBe('s1');
      expect(result.current.totalCount).toBe(3);
      unmount();
    });

    it('private sessions are always excluded regardless of filters', () => {
      mockSessionSummaries = [
        makeSummary({ id: 'public', privateMode: false }),
        makeSummary({ id: 'private', privateMode: true }),
      ];

      const { result, unmount } = renderHook(() => mod.useConversations());
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe('public');
      unmount();
    });
  });
});
