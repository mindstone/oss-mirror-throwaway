import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn()
};

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();
  
  // Create a fresh store data object for each test
  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      private data: T;
      constructor(options: { defaults: T }) {
        this.data = structuredClone(options.defaults);
      }
      get<K extends keyof T>(key: K): T[K] {
        return this.data[key];
      }
      set<K extends keyof T>(key: K, value: T[K]): void {
        this.data[key] = value;
      }
      get store(): T {
        return this.data;
      }
    }
    return { default: MemoryStore };
  });
  vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));
  vi.doMock('./demoModeService', () => ({
    isDemoModeActive: () => false,
    getDemoTaskQueue: () => ({ version: 1, items: [], history: [] }),
    setDemoTaskQueue: vi.fn(),
    getDemoInbox: () => ({ version: 1, items: [], history: [] }),
    setDemoInbox: vi.fn()
  }));
  return await import('../inboxStore');
};

describe('inboxStore', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
  });

  describe('basic operations', () => {
    it('adds an item to the inbox', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ title: 'Test Task', text: 'Body', category: 'user-request' });
      expect(result.state.items[0]?.title).toBe('Test Task');
      expect(result.state.items[0]?.text).toBe('Body');
    });

    it('removes an item by id', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To Remove', category: 'user-request' });
      const targetId = added.state.items[0]!.id;
      const afterRemoval = store.removeInboxItem(targetId);
      expect(afterRemoval.items.find((item) => item.id === targetId)).toBeUndefined();
    });

    // Note: These tests use the legacy path (migrationComplete=false in mock store)
    it('updates title via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Original Title', text: 'Original text', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const updated = store.updateInboxItem(itemId, { title: 'Updated Title' });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.title).toBe('Updated Title');
      expect(item.text).toBe('Original text'); // unchanged
    });

    it('updates urgent/important via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task', urgent: false, important: true, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      // Move to Do Now quadrant
      const updated = store.updateInboxItem(itemId, { urgent: true, important: true });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(true);
    });

    it('archives item via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task to archive', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const updated = store.updateInboxItem(itemId, { archived: true });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.archived).toBe(true);
      expect(item.archivedAt).toBeDefined();
    });

    it('unarchives item via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      store.updateInboxItem(itemId, { archived: true });
      const updated = store.updateInboxItem(itemId, { archived: false });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.archived).toBe(false);
      expect(item.archivedAt).toBeUndefined();
    });

    it('updates multiple fields at once via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Original', urgent: false, important: false, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const updated = store.updateInboxItem(itemId, { 
        title: 'Updated',
        text: 'New description',
        urgent: true,
        important: true
      });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.title).toBe('Updated');
      expect(item.text).toBe('New description');
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(true);
    });

    it('keeps reviewed items active unless execution is flagged for auto-completion', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Review me', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const executing = store.setInboxItemExecuting(itemId, 'session-1', { autoCompleteOnExecution: false });
      let item = executing.items.find(i => i.id === itemId)!;
      expect(item.status).toBe('executing');
      expect(item.autoCompleteOnExecution).toBe(false);

      const cleared = store.setInboxItemExecuting(itemId, null);
      item = cleared.items.find(i => i.id === itemId)!;
      expect(item.status).toBe('active');
      expect(item.executingSessionId).toBeUndefined();
      expect(item.autoCompleteOnExecution).toBeUndefined();
    });

    it('stores optional delete feedback on dismissed items', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Bad suggestion', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const dismissed = store.setInboxItemStatus(itemId, 'dismissed', undefined, {
        dismissedReasonCategory: 'not_an_action',
        dismissedReason: 'This was just a status update.',
      });
      const item = dismissed.items.find(i => i.id === itemId)!;

      expect(item.status).toBe('dismissed');
      expect(item.dismissedReasonCategory).toBe('not_an_action');
      expect(item.dismissedReason).toBe('This was just a status update.');
    });

    it('returns bounded dismissed feedback examples scoped by automation', async () => {
      const store = await setupModule();
      const source = {
        kind: 'automation' as const,
        automationId: 'system-source-capture',
        automationName: 'source-capture',
      };
      const matching = store.addInboxItem({
        title: 'Review captured Alex source confusion',
        text: 'This was a status update, not something to do.',
        category: 'automation',
        source,
      });
      const unrelated = store.addInboxItem({
        title: 'Review unrelated automation output',
        category: 'automation',
        source: {
          kind: 'automation' as const,
          automationId: 'other-automation',
          automationName: 'other',
        },
      });
      const noFeedback = store.addInboxItem({
        title: 'Dismissed without a reason',
        category: 'automation',
        source,
      });

      store.setInboxItemStatus(matching.state.items[0]!.id, 'dismissed', undefined, {
        dismissedReasonCategory: 'not_an_action',
        dismissedReason: 'This was just a status update.',
      });
      store.setInboxItemStatus(unrelated.state.items[0]!.id, 'dismissed', undefined, {
        dismissedReasonCategory: 'wrong_context',
      });
      store.setInboxItemStatus(noFeedback.state.items[0]!.id, 'dismissed');

      const examples = store.getInboxFeedbackExamples({
        automationId: 'system-source-capture',
        automationName: 'source-capture',
        limit: 5,
      });

      expect(examples).toHaveLength(1);
      expect(examples[0]).toMatchObject({
        title: 'Review captured Alex source confusion',
        dismissedReasonCategory: 'not_an_action',
        dismissedReason: 'This was just a status update.',
        sourceAutomationId: 'system-source-capture',
        sourceAutomationName: 'source-capture',
      });
    });
  });

  describe('normalizeTags', () => {
    it('trims, lowercases, deduplicates, and filters empty strings', async () => {
      const store = await setupModule();
      const result = store.normalizeTags(['  Finance ', 'MARKETING', 'finance', '', '  ', 'social']);
      expect(result).toEqual(['finance', 'marketing', 'social']);
    });

    it('returns undefined for empty arrays', async () => {
      const store = await setupModule();
      expect(store.normalizeTags([])).toBeUndefined();
      expect(store.normalizeTags(['', '  '])).toBeUndefined();
    });

    it('returns undefined for non-array values', async () => {
      const store = await setupModule();
      expect(store.normalizeTags(undefined)).toBeUndefined();
      expect(store.normalizeTags(null)).toBeUndefined();
      expect(store.normalizeTags('string')).toBeUndefined();
    });

    it('limits to 20 tags', async () => {
      const store = await setupModule();
      const manyTags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
      const result = store.normalizeTags(manyTags);
      expect(result).toHaveLength(20);
    });

    it('filters non-string values', async () => {
      const store = await setupModule();
      const result = store.normalizeTags(['valid', 42, null, true, 'also-valid']);
      expect(result).toEqual(['valid', 'also-valid']);
    });
  });

  describe('tags on inbox items', () => {
    it('adds an item with tags', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Tagged Task',
        category: 'user-request',
        tags: ['Finance', 'Q2'],
      });
      const item = result.state.items[0]!;
      expect(item.tags).toEqual(['finance', 'q2']);
    });

    it('adds an item without tags (undefined)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ title: 'No Tags', category: 'user-request' });
      const item = result.state.items[0]!;
      expect(item.tags).toBeUndefined();
    });

    it('updates tags via updateInboxItem', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To Tag', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const updated = store.updateInboxItem(itemId, { tags: ['social', 'marketing'] });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.tags).toEqual(['social', 'marketing']);
    });

    it('clears tags by setting empty array', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({
        title: 'Has Tags',
        category: 'user-request',
        tags: ['finance'],
      });
      const itemId = added.state.items[0]!.id;

      const updated = store.updateInboxItem(itemId, { tags: [] });
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.tags).toBeUndefined();
    });
  });

  describe('Eisenhower Matrix - urgent/important fields', () => {
    it('defaults to urgent=false, important=true (Schedule quadrant)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ title: 'Default Priority Task', category: 'user-request' });
      const item = result.state.items[0]!;
      
      expect(item.urgent).toBe(false);
      expect(item.important).toBe(true);
    });

    it('allows setting urgent=true, important=true (Do Now quadrant)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Urgent Important Task',
        urgent: true,
        important: true,
        category: 'user-request'
      });
      const item = result.state.items[0]!;
      
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(true);
    });

    it('allows setting urgent=true, important=false (Delegate quadrant)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Urgent Not Important Task',
        urgent: true,
        important: false,
        category: 'user-request'
      });
      const item = result.state.items[0]!;
      
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(false);
    });

    it('allows setting urgent=false, important=false (Consider quadrant)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Low Priority Task',
        urgent: false,
        important: false,
        category: 'user-request'
      });
      const item = result.state.items[0]!;
      
      expect(item.urgent).toBe(false);
      expect(item.important).toBe(false);
    });

    it('derives important=true for meeting-action items with action verb in title', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Follow up with Sarah about Q1 pricing',
        category: 'meeting-action',
      });
      const item = result.state.items[0]!;
      expect(item.important).toBe(true);
    });

    it('redirects meeting-action items without action signals', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Acme training platform overview',
        category: 'meeting-action',
      });
      expect(result.accepted).toBe(false);
      expect(result.redirected).toBe(true);
    });

    it('accepts meeting-action items with a draft even without action signal (draft bypass)', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Acme training platform overview',
        category: 'meeting-action',
        draft: 'Here is the draft email...',
      });
      expect(result.accepted).toBe(true);
      const item = result.state.items[0]!;
      expect(item.important).toBe(true);
    });

    it('derives important=true for automation items with clarifying question', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: '14 day journey completion update',
        category: 'automation',
        clarifyingQuestion: 'Should I archive this?',
      });
      const item = result.state.items[0]!;
      expect(item.important).toBe(true);
    });

    it('redirects follow-up items with topic-only title', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Q4 revenue numbers and team restructuring',
        category: 'follow-up',
      });
      expect(result.accepted).toBe(false);
      expect(result.redirected).toBe(true);
    });

    it('redirects meeting-action items about work already in progress', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Fix Acme bugs (14-day journey + others) — already started this morning',
        category: 'meeting-action',
      });
      expect(result.accepted).toBe(false);
      expect(result.redirected).toBe(true);
    });

    it('redirects follow-up items about work currently being addressed', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Update pricing page — currently being addressed by the team',
        category: 'follow-up',
      });
      expect(result.accepted).toBe(false);
      expect(result.redirected).toBe(true);
    });

    it('redirects meeting-action items even with explicit important=true when no action signal', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({
        title: 'Acme training platform',
        category: 'meeting-action',
        important: true,
      });
      expect(result.accepted).toBe(false);
      expect(result.redirected).toBe(true);
    });
  });

  describe('setInboxItemQuadrant', () => {
    it('moves item to Do Now quadrant (urgent=true, important=true)', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task to Move', urgent: false, important: false, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const result = store.setInboxItemQuadrant(itemId, true, true);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(true);
    });

    it('moves item to Schedule quadrant (urgent=false, important=true)', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task to Move', urgent: true, important: true, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const result = store.setInboxItemQuadrant(itemId, false, true);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.urgent).toBe(false);
      expect(item.important).toBe(true);
    });

    it('moves item to Delegate quadrant (urgent=true, important=false)', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task to Move', urgent: false, important: true, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const result = store.setInboxItemQuadrant(itemId, true, false);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.urgent).toBe(true);
      expect(item.important).toBe(false);
    });

    it('moves item to Consider quadrant (urgent=false, important=false)', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Task to Move', urgent: true, important: true, category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const result = store.setInboxItemQuadrant(itemId, false, false);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.urgent).toBe(false);
      expect(item.important).toBe(false);
    });

    it('returns unchanged state for non-existent item', async () => {
      const store = await setupModule();
      store.addInboxItem({ title: 'Existing Task', category: 'user-request' });
      
      const result = store.setInboxItemQuadrant('non-existent-id', true, true);
      // Should not throw, just return current state
      expect(result.items.length).toBe(1);
    });
  });

  describe('clarifyingQuestion field', () => {
    it('stores clarifyingQuestion when provided', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Task with question',
        clarifyingQuestion: 'What tone should I use?',
        category: 'user-request'
      });
      
      expect(result.state.items[0]?.clarifyingQuestion).toBe('What tone should I use?');
    });

    it('handles missing clarifyingQuestion', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ title: 'Task without question', category: 'user-request' });
      
      expect(result.state.items[0]?.clarifyingQuestion).toBeUndefined();
    });

    it('trims whitespace from clarifyingQuestion', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Task',
        clarifyingQuestion: '  What is the deadline?  ',
        category: 'user-request'
      });
      
      expect(result.state.items[0]?.clarifyingQuestion).toBe('What is the deadline?');
    });
  });

  describe('actions field', () => {
    it('stores execute action', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Actionable Task',
        actions: [{ type: 'execute' }],
        category: 'user-request'
      });
      
      expect(result.state.items[0]?.actions).toHaveLength(1);
      expect(result.state.items[0]?.actions?.[0]?.type).toBe('execute');
    });

    it('stores shareToSocial action with platforms', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Social Post',
        actions: [{ 
          type: 'shareToSocial', 
          text: 'Check out this post!',
          platforms: ['twitter', 'linkedin']
        }],
        category: 'user-request'
      });
      
      const action = result.state.items[0]?.actions?.[0];
      expect(action?.type).toBe('shareToSocial');
      if (action?.type === 'shareToSocial') {
        expect(action.text).toBe('Check out this post!');
        expect(action.platforms).toEqual(['twitter', 'linkedin']);
      }
    });

    it('stores multiple actions', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Multi-action Task',
        actions: [
          { type: 'execute' },
          { type: 'shareToSocial', text: 'Share me!', platforms: ['twitter'] }
        ],
        category: 'user-request'
      });
      
      expect(result.state.items[0]?.actions).toHaveLength(2);
    });
  });

  describe('toIndexEntry', () => {
    it('includes urgent and important in index entry', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ 
        title: 'Indexed Task',
        urgent: true,
        important: false,
        category: 'user-request'
      });
      const item = added.state.items[0]!;
      
      const indexEntry = store.toIndexEntry(item);
      
      expect(indexEntry.urgent).toBe(true);
      expect(indexEntry.important).toBe(false);
    });

    it('includes all required index fields', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ 
        title: 'Full Index Test',
        text: 'Description',
        priority: 'p1',
        urgent: true,
        important: true,
        category: 'user-request'
      });
      const item = added.state.items[0]!;
      
      const indexEntry = store.toIndexEntry(item);
      
      expect(indexEntry.id).toBe(item.id);
      expect(indexEntry.title).toBe('Full Index Test');
      expect(indexEntry.addedAt).toBe(item.addedAt);
      expect(indexEntry.priority).toBe('p1');
      expect(indexEntry.urgent).toBe(true);
      expect(indexEntry.important).toBe(true);
    });
  });

  describe('archive operations', () => {
    it('archives an item', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To Archive', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      const result = store.setInboxItemArchived(itemId, true);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.archived).toBe(true);
      expect(item.archivedAt).toBeDefined();
    });

    it('unarchives an item', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To Unarchive', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      
      store.setInboxItemArchived(itemId, true);
      const result = store.setInboxItemArchived(itemId, false);
      const item = result.items.find(i => i.id === itemId)!;
      
      expect(item.archived).toBe(false);
      expect(item.archivedAt).toBeUndefined();
    });
  });

  describe('source and references', () => {
    it('stores workspace source', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Task from file',
        source: { kind: 'workspace', path: '/docs/meeting.md', label: 'Meeting Notes' },
        category: 'user-request'
      });
      
      const source = result.state.items[0]?.source;
      expect(source?.kind).toBe('workspace');
      if (source?.kind === 'workspace') {
        expect(source.path).toBe('/docs/meeting.md');
        expect(source.label).toBe('Meeting Notes');
      }
    });

    it('stores text source', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Task from conversation',
        source: { kind: 'text', label: 'Chat with Sarah' },
        category: 'user-request'
      });
      
      const source = result.state.items[0]?.source;
      expect(source?.kind).toBe('text');
      if (source?.kind === 'text') {
        expect(source.label).toBe('Chat with Sarah');
      }
    });

    it('stores multiple references', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ 
        title: 'Task with refs',
        references: [
          { kind: 'workspace', path: '/docs/spec.md' },
          { kind: 'url', url: 'https://example.com/brief' }
        ],
        category: 'user-request'
      });
      
      const refs = result.state.items[0]?.references;
      expect(refs).toHaveLength(2);
      expect(refs?.[0]?.kind).toBe('workspace');
      expect(refs?.[1]?.kind).toBe('url');
    });
  });

  describe('execution recording', () => {
    it('records execution entry and adds to history', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ 
        title: 'Task to Execute',
        text: 'Do this thing',
        urgent: true,
        important: true,
        category: 'user-request'
      });
      const item = added.state.items[0]!;
      
      // recordInboxExecutionEntry(itemId, sessionId, mode, executedAt?)
      const sessionId = 'session-123';
      const result = store.recordInboxExecutionEntry(item.id, sessionId, 'execute');
      
      // Should have history entry
      expect(result.history).toHaveLength(1);
      expect(result.history[0]?.title).toBe('Task to Execute');
      // Session ID should match what we passed
      expect(result.history[0]?.sessionId).toBe(sessionId);
      expect(result.history[0]?.mode).toBe('execute');
      // Item should be removed from active items (in index)
      expect(result.items.find(i => i.id === item.id)).toBeUndefined();
    });
  });

  describe('validateItemId', () => {
    it('accepts valid UUIDs', async () => {
      const store = await setupModule();
      expect(store.validateItemId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(store.validateItemId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    });

    it('rejects invalid IDs', async () => {
      const store = await setupModule();
      expect(store.validateItemId('')).toBe(false);
      expect(store.validateItemId('not-a-uuid')).toBe(false);
      expect(store.validateItemId('../../../etc/passwd')).toBe(false);
      expect(store.validateItemId('550e8400-e29b-41d4-a716')).toBe(false); // truncated
    });

    it('rejects null/undefined', async () => {
      const store = await setupModule();
      expect(store.validateItemId(null as any)).toBe(false);
      expect(store.validateItemId(undefined as any)).toBe(false);
    });
  });

  describe('Stage 9A: expanded observation patterns', () => {
    it('redirects Jira-style status confirmations', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'FOX-2666 confirmed: notetaker bot in office hour, not a system breach' },
        [], [],
      );
      expect(result.outcome).toBe('redirected');
      expect(result.redirectTarget).toBe('coach');
    });

    it('redirects "has been resolved" patterns', async () => {
      const store = await setupModule();
      const cases = [
        'The login issue has been resolved by the infra team',
        'Billing discrepancy was handled by finance',
        'The connector is now confirmed and working',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('redirected');
      }
    });

    it('redirects "already done" patterns', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'This task has already been completed by the ops team' },
        [], [],
      );
      expect(result.outcome).toBe('redirected');
    });

    it('redirects FYI / no-action-needed signals', async () => {
      const store = await setupModule();
      const cases = [
        'For your information: quarterly review dates published',
        'Just FYI the deployment went smoothly',
        'No action needed on the security audit',
        'No follow-up required for this ticket',
        'FYI: new office hours schedule starting Monday',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('redirected');
      }
    });

    it('redirects confirmed/resolved/shipped insight prefixes', async () => {
      const store = await setupModule();
      const cases = [
        'Confirmed: notetaker bot is working correctly now',
        'Resolved: the API timeout issue from last week',
        'Shipped: new dashboard analytics feature',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('redirected');
      }
    });

    it('does NOT redirect genuinely actionable items', async () => {
      const store = await setupModule();
      const cases = [
        'Review Q3 proposal — deadline Friday',
        'Update CRM with Q3 data before sync',
        'Schedule meeting with product team for roadmap review',
        'Prepare presentation slides for Monday standup',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });

    it('always accepts user-request category regardless of patterns', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'FOX-2666 confirmed: notetaker bot', category: 'user-request' },
        [], [],
      );
      expect(result.outcome).toBe('accepted');
    });
  });

  describe('body-text FYI pattern filtering', () => {
    it('redirects items with innocuous title but FYI body text', async () => {
      const store = await setupModule();
      const cases = [
        { title: 'Community events: Manchester, Newcastle, Leeds', text: 'Alex secured locations. FYI only — no action for you.', category: 'meeting-action' as const },
        { title: 'Partnership update: UK AI reseller agreement', text: 'This is purely informational, no deliverables on your side.', category: 'meeting-action' as const },
        { title: 'Team standup recap summary', text: 'Hannah offered help. Nothing for you to do here.', category: 'meeting-action' as const },
        { title: 'Quarterly review dates published', text: 'Dates are set. No action needed from you.', category: 'follow-up' as const },
        { title: 'Vendor contract status update', text: 'Contract signed. No follow-up needed on your end.', category: 'meeting-action' as const },
        { title: 'Budget allocation update report', text: 'For your information only — finance handled this.', category: 'meeting-action' as const },
      ];
      for (const { title, text, category } of cases) {
        const result = store.validateInboxItem({ title, text, category }, [], []);
        expect(result.outcome).toBe('redirected');
        expect(result.redirectTarget).toBe('coach');
      }
    });

    it('does NOT redirect action items that mention context without FYI signals', async () => {
      const store = await setupModule();
      const cases = [
        { title: 'Follow up with Sarah about Q3 pricing', text: 'Sarah asked for updated projections. She needs your sign-off by Friday.' },
        { title: 'Review contract terms before Thursday', text: 'Legal sent the revised terms. Key changes on page 3.' },
        { title: 'Draft email to James about projections', text: 'James requested Q3 numbers. Deck is ready for your review.' },
      ];
      for (const { title, text } of cases) {
        const result = store.validateInboxItem({ title, text }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });

    it('does NOT redirect items with partial FYI matches (no false positives)', async () => {
      const store = await setupModule();
      const cases = [
        { title: 'Send FYI report to stakeholders', text: 'Compile the monthly FYI report and distribute.' },
        { title: 'Update the information page', text: 'The information section needs new content.' },
      ];
      for (const { title, text } of cases) {
        const result = store.validateInboxItem({ title, text }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });

    it('always accepts user-request category even with FYI body text', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'My personal note', text: 'FYI only — just saving this for later.', category: 'user-request' },
        [], [],
      );
      expect(result.outcome).toBe('accepted');
    });
  });

  describe('Stage 9A: OTHER_PERSON_TASK_PATTERNS', () => {
    it('rejects "Follow up: Name is fixing" pattern', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'Follow up: Harry fixing connectors for Dan Smith' },
        [], [],
      );
      expect(result.outcome).toBe('rejected');
      expect(result.reason).toContain("another person's task");
    });

    it('rejects "Follow up: Name needs to fix" pattern', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'Follow up: Sarah needs to review the proposal before Friday' },
        [], [],
      );
      expect(result.outcome).toBe('rejected');
    });

    it('rejects "Name\'s task:" pattern', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: "Harry's task: fix the connector for Dan" },
        [], [],
      );
      expect(result.outcome).toBe('rejected');
    });

    it('does NOT redirect user\'s own tasks that mention names mid-sentence', async () => {
      const store = await setupModule();
      const cases = [
        'Follow up with Sarah about Q3 planning',
        'Review the connector that Harry mentioned',
        'Send meeting notes to the product team',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });

    it('exports OTHER_PERSON_TASK_PATTERNS', async () => {
      const store = await setupModule();
      expect(store.OTHER_PERSON_TASK_PATTERNS).toBeDefined();
      expect(Array.isArray(store.OTHER_PERSON_TASK_PATTERNS)).toBe(true);
      expect(store.OTHER_PERSON_TASK_PATTERNS.length).toBeGreaterThan(0);
    });

    it('rejects "[PersonName]: [topic]" attribution pattern', async () => {
      const store = await setupModule();
      const cases = [
        'Greg: Rethinking personal work habits — less reactive, more strategic',
        'Sarah: Proposed new pricing model for enterprise tier',
        'Mike: Wants to restructure the marketing team',
        'Emily: Concerned about Q3 timeline slipping',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('rejected');
        expect(result.reason).toContain("another person's task");
      }
    });

    it('does NOT reject common title prefixes that match [Word]: format', async () => {
      const store = await setupModule();
      const cases = [
        'Meeting: Follow up on Q1 pricing with stakeholders',
        'Schedule: Team sync for Friday afternoon',
        'Action: Send updated proposal to client by EOD',
        'Review: Contract terms before Thursday deadline',
        'Update: CRM data before the quarterly sync',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });
  });

  describe('mid-title recap/idea observation patterns', () => {
    it('redirects titles with mid-title "recap:" to coach', async () => {
      const store = await setupModule();
      const cases = [
        'CTOcraft workshop recap: 30 CTOs impressed, no disbelief',
        'Team standup recap: key decisions from this morning',
        'Product strategy recap: alignment on Q3 priorities',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title, category: 'meeting-action' }, [], []);
        expect(result.outcome).toBe('redirected');
        expect(result.redirectTarget).toBe('coach');
      }
    });

    it('redirects meeting-action titles with mid-title "idea:" (no action signal)', async () => {
      const store = await setupModule();
      const cases = [
        'ROI surfacing idea: salary → hourly rate → dollar value of time saved',
        'Product idea: customer self-service portal for onboarding',
        'Marketing idea: launch community ambassador program',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title, category: 'meeting-action' }, [], []);
        expect(result.outcome).toBe('redirected');
      }
    });

    it('redirects meeting-action titles starting with "idea:" (no action signal)', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        { title: 'Idea: new approach to user onboarding', category: 'meeting-action' },
        [], [],
      );
      expect(result.outcome).toBe('redirected');
    });

    it('accepts actionable items that mention ideas', async () => {
      const store = await setupModule();
      const cases = [
        'Draft proposal for the customer portal idea Sarah raised',
        'Follow up with Mike about his pricing model suggestions',
        'Schedule brainstorm session for Q3 feature ideas',
      ];
      for (const title of cases) {
        const result = store.validateInboxItem({ title }, [], []);
        expect(result.outcome).toBe('accepted');
      }
    });
  });

  describe('Stage 9D: computeRelevanceScore', () => {
    it('scores user-request with draft + references highest (~90)', async () => {
      const store = await setupModule();
      const score = store.computeRelevanceScore({
        ageMs: 1 * 24 * 60 * 60 * 1000,
        hasReferences: true,
        hasDraft: true,
        hasClarifyingQuestion: false,
        category: 'user-request',
        wordCount: 10,
      });
      // 50 + 30 (user-request) + 15 (draft) + 10 (references) + 5 (wordCount>=8) = 110 → clamped to 100
      expect(score).toBeGreaterThanOrEqual(85);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('scores old automation item low (~25)', async () => {
      const store = await setupModule();
      const score = store.computeRelevanceScore({
        ageMs: 10 * 24 * 60 * 60 * 1000,
        hasReferences: false,
        hasDraft: false,
        hasClarifyingQuestion: false,
        category: 'automation',
        wordCount: 4,
      });
      // 50 - 5 (automation) - 15 (>7d) - 5 (wordCount<=5) = 25
      expect(score).toBe(25);
    });

    it('scores meeting-action with clarifying question (~75)', async () => {
      const store = await setupModule();
      const score = store.computeRelevanceScore({
        ageMs: 1 * 24 * 60 * 60 * 1000,
        hasReferences: false,
        hasDraft: false,
        hasClarifyingQuestion: true,
        category: 'meeting-action',
        wordCount: 8,
      });
      // 50 + 15 (meeting-action) + 5 (clarifying) + 5 (wordCount>=8) = 75
      expect(score).toBe(75);
    });

    it('clamps to [0, 100] range', async () => {
      const store = await setupModule();
      const extremeHigh = store.computeRelevanceScore({
        ageMs: 0,
        hasReferences: true,
        hasDraft: true,
        hasClarifyingQuestion: true,
        category: 'user-request',
        wordCount: 20,
      });
      expect(extremeHigh).toBeLessThanOrEqual(100);

      const extremeLow = store.computeRelevanceScore({
        ageMs: 30 * 24 * 60 * 60 * 1000,
        hasReferences: false,
        hasDraft: false,
        hasClarifyingQuestion: false,
        category: 'automation',
        wordCount: 2,
      });
      expect(extremeLow).toBeGreaterThanOrEqual(0);
    });
  });

  describe('periodicFreshnessCheck', () => {
    it('archives item with expired relevantDate (after grace period)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      // Add item with a relevantDate 1 hour in the future (passes write-time validation).
      // Uses 'automation' category since 'user-request' is exempt from freshness checks.
      // Explicit important=false so the 7-day signal grace period doesn't apply.
      store.addInboxItem({
        title: 'Review budget proposal before the deadline passes',
        text: 'Budget review',
        category: 'automation',
        relevantDate: baseTime + 60 * 60 * 1000,
        important: false,
      });

      // Advance time by 4 days — relevantDate expired ~4 days ago, past the 72h grace period
      dateNowSpy.mockReturnValue(baseTime + 4 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('relevantDate expired');
      dateNowSpy.mockRestore();
    });

    it('archives item with "today" in title that is > 24h old', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Send the report to client today for final review',
        text: 'Report send',
        category: 'automation',
      });

      // Advance time by 36 hours
      dateNowSpy.mockReturnValue(baseTime + 36 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('same-day temporal reference');
      dateNowSpy.mockRestore();
    });

    it('archives "Prep for" item older than 48h without relevantDate', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Prep for quarterly business review with leadership team',
        text: 'Meeting prep',
        category: 'automation',
      });

      // Advance time by 3 days
      dateNowSpy.mockReturnValue(baseTime + 3 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('meeting prep');
      dateNowSpy.mockRestore();
    });

    it('archives meeting-action "Prep for" item 5h after relevantDate (4h grace)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Prep for team standup with engineering leads',
        text: 'Standup prep',
        category: 'meeting-action',
        relevantDate: baseTime + 60 * 60 * 1000,
        important: false,
      });

      // Advance 6h — relevantDate expired 5h ago, past the 4h meeting prep grace
      dateNowSpy.mockReturnValue(baseTime + 6 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('meeting prep expired');
      dateNowSpy.mockRestore();
    });

    it('does NOT archive meeting-action "Prep for" item within 4h of relevantDate', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Prepare individual update for Look Ahead meeting',
        text: 'Look Ahead prep',
        category: 'meeting-action',
        relevantDate: baseTime + 60 * 60 * 1000,
        important: false,
      });

      // Advance 4h — relevantDate expired 3h ago, within the 4h grace
      dateNowSpy.mockReturnValue(baseTime + 4 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('does NOT apply 4h meeting prep grace to non-prep meeting-action items', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Follow up with Sarah about Q1 pricing from meeting',
        text: 'Post-meeting follow-up',
        category: 'meeting-action',
        relevantDate: baseTime + 60 * 60 * 1000,
        important: false,
      });

      // Advance 6h — relevantDate expired 5h ago, but title does NOT match prep pattern
      dateNowSpy.mockReturnValue(baseTime + 6 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('rate-limits: second call within 1 hour returns no-op', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      // First call triggers migration + sets lastFreshnessCheck
      store.addInboxItem({ title: 'Dummy item to trigger migration complete', category: 'user-request' });
      const first = store.periodicFreshnessCheck();
      expect(first.archived).toBe(0);

      // Advance 30 minutes — still within rate limit
      dateNowSpy.mockReturnValue(baseTime + 30 * 60 * 1000);
      const second = store.periodicFreshnessCheck();
      expect(second.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('does NOT archive fresh "today" item (< 24h old)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Review the draft proposal today before end of day',
        text: 'Fresh today item',
        category: 'user-request',
      });

      // Only 6 hours later — "today" reference is still fresh
      dateNowSpy.mockReturnValue(baseTime + 6 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('archives RSVP item older than 48h', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'RSVP to the product launch event next week',
        text: 'Event invitation',
        category: 'automation',
      });

      dateNowSpy.mockReturnValue(baseTime + 3 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('RSVP');
      dateNowSpy.mockRestore();
    });

    it('archives "Meeting:" summary item older than 24h', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Meeting: Check-In and Demos with the full team',
        text: 'Meeting summary',
        category: 'meeting-action',
      });

      dateNowSpy.mockReturnValue(baseTime + 2 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('meeting summary');
      dateNowSpy.mockRestore();
    });

    it('does NOT archive fresh "Meeting:" item (< 24h old)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Meeting: Team standup with engineering leads',
        text: 'Meeting summary',
        category: 'meeting-action',
      });

      dateNowSpy.mockReturnValue(baseTime + 12 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('does NOT archive "Meeting with ..." items (no colon = user task, not summary)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      // Action-verb meeting items are user tasks — NOT auto-generated summaries.
      // They must NOT be auto-archived by the meeting summary heuristic.
      store.addInboxItem({
        title: 'Discuss Q2 roadmap with Sarah',
        text: 'Prep needed',
        category: 'meeting-action',
      });

      dateNowSpy.mockReturnValue(baseTime + 3 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('does NOT archive meeting-sourced ACTION items based on age (needs evidence)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Add flight details to Notion for next week event',
        text: 'Logistics from meeting',
        category: 'meeting-action',
        source: { kind: 'meeting', meetingTitle: 'Look Ahead meeting' },
      });

      // Even after 7 days, action items from meetings should NOT be
      // auto-archived — LLM freshness check handles evidence-based archival.
      dateNowSpy.mockReturnValue(baseTime + 7 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('archives "this morning" item that is > 24h old', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Fix Acme bugs — already started this morning',
        text: 'Bug fixes',
        category: 'automation',
      });

      dateNowSpy.mockReturnValue(baseTime + 36 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('same-day temporal reference');
      dateNowSpy.mockRestore();
    });

    it('archives "tonight" item that is > 24h old', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Send draft proposal to client tonight',
        text: 'Deadline tonight',
        category: 'automation',
      });

      dateNowSpy.mockReturnValue(baseTime + 30 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('same-day temporal reference');
      dateNowSpy.mockRestore();
    });

    it('archives "already started" item that is > 48h old', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Fix Acme bugs (14-day journey + others) — already started this morning',
        text: 'Bug tracking',
        category: 'automation',
      });

      dateNowSpy.mockReturnValue(baseTime + 3 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(1);
      dateNowSpy.mockRestore();
    });

    it('does NOT archive "already started" item that is < 48h old', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Deploy new landing page — already started the rollout',
        text: 'Deployment',
        category: 'automation',
      });

      dateNowSpy.mockReturnValue(baseTime + 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });
  });

  describe('third-party initiative body-text ownership filtering', () => {
    it('redirects meeting-action item with third-party initiative body', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        {
          title: 'Schedule exec discussion: ROI measurement',
          text: 'Liam flagged need for a proper discussion with Josh about ROI measurement and open source strategy',
          category: 'meeting-action',
        },
        [], [],
      );
      expect(result.outcome).toBe('redirected');
      expect(result.redirectTarget).toBe('coach');
    });

    it('accepts meeting-action item when third-party delegates to user', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        {
          title: 'Prepare the investor deck for next week',
          text: 'Liam asked you to prepare the deck before the board meeting on Thursday',
          category: 'meeting-action',
        },
        [], [],
      );
      expect(result.outcome).toBe('accepted');
    });

    it('redirects follow-up item with third-party initiative body', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        {
          title: 'Follow up on pricing discussion',
          text: 'Sarah proposed a new pricing model during the strategy meeting',
          category: 'follow-up',
        },
        [], [],
      );
      expect(result.outcome).toBe('redirected');
      expect(result.redirectTarget).toBe('coach');
    });

    it('redirects prepared meeting items when ownership belongs to someone else', async () => {
      const store = await setupModule();
      const cases = [
        {
          title: 'Ask Angus for lost-deal learnings',
          text: 'Angus plans to call the lost prospect to understand whether they used Mindstone for leverage with their existing training provider.',
          clarifyingQuestion: 'Draft a Slack nudge to Angus?',
        },
        {
          title: 'Clarify transformation partner positioning',
          text: 'Hannah flagged that EY and others are adopting “forward deployed” language, while Mindstone uses “transformation partner”.',
          clarifyingQuestion: 'Draft positioning bullets for Hannah/Greg?',
        },
      ];

      for (const item of cases) {
        const result = store.validateInboxItem(
          { ...item, category: 'meeting-action' },
          [], [],
        );
        expect(result.outcome).toBe('redirected');
        expect(result.redirectTarget).toBe('coach');
      }
    });

    it('accepts meeting-action item with clean body text', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        {
          title: 'Follow up with Sarah about Q1 pricing',
          text: 'During the meeting, you agreed to send updated projections by Friday',
          category: 'meeting-action',
        },
        [], [],
      );
      expect(result.outcome).toBe('accepted');
    });

    it('redirects wins/learnings sources even when title is action-oriented', async () => {
      const store = await setupModule();
      const result = store.validateInboxItem(
        {
          title: 'Share ROI alpha customer-comms leverage win',
          text: 'Score: 86/100. The win is leverage.',
          category: 'automation',
          source: {
            kind: 'automation',
            automationId: 'automation-wins-learnings-uncover',
            automationName: 'Wins & Learnings Coach',
            label: 'Exec coach scan — 2026-05-18',
          },
        },
        [], [],
      );

      expect(result.outcome).toBe('redirected');
      expect(result.redirectTarget).toBe('coach');
    });
  });

  describe('retroactiveInboxCleanup', () => {
    it('respects BYPASS_CATEGORIES — does not archive user-request items', async () => {
      const store = await setupModule();
      store.addInboxItem({ title: 'Fix it but this is user-requested', text: 'Short title', category: 'user-request' });
      store.addInboxItem({ title: 'Already been resolved in staging environment', text: 'Matches observation pattern', category: 'meeting-action' });
      const result = store.retroactiveInboxCleanup();
      expect(result.archived).toBe(0);
      expect(result.redirectedToCoach).toBe(0);
    });

    it('validates patterns catch items at write-time (before reaching cleanup)', async () => {
      const store = await setupModule();
      const fyi = store.addInboxItem({ title: 'FOX-2666 confirmed: notetaker bot in office hour, not a system breach', text: 'Status confirmation' });
      expect(fyi.accepted).toBe(false);
      expect(fyi.redirected).toBe(true);

      const other = store.addInboxItem({ title: "Follow up: Harry is fixing the connectors for Dan Smith", text: 'Other person task' });
      expect(other.accepted).toBe(false);
      expect(other.redirected).toBeUndefined();
      expect(other.rejectedReason).toContain("another person's task");
    });

    it('archives "Meeting:" summary items older than 24h', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Meeting: Weekly sync with the product team',
        text: 'Summary of discussed topics',
        category: 'meeting-action',
      });

      dateNowSpy.mockReturnValue(baseTime + 2 * 24 * 60 * 60 * 1000);
      const result = store.retroactiveInboxCleanup();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('meeting summary');
      dateNowSpy.mockRestore();
    });

    it('does NOT archive actionable meeting items (no "Meeting:" prefix = not a meeting summary)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Prepare for meeting with John about Q1 goals',
        text: 'User task — not a meeting summary',
        category: 'meeting-action',
      });

      dateNowSpy.mockReturnValue(baseTime + 3 * 24 * 60 * 60 * 1000);
      const result = store.retroactiveInboxCleanup();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });

    it('archives meeting-action "Prep for" item with expired relevantDate (4h grace)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Prep for weekly all-hands with the full team',
        text: 'All-hands prep',
        category: 'meeting-action',
        relevantDate: baseTime + 60 * 60 * 1000,
      });

      // Advance 6h — relevantDate expired 5h ago, past the 4h meeting prep grace
      dateNowSpy.mockReturnValue(baseTime + 6 * 60 * 60 * 1000);
      const result = store.retroactiveInboxCleanup();
      expect(result.archived).toBe(1);
      expect(result.details[0]).toContain('meeting prep expired');
      dateNowSpy.mockRestore();
    });

    it('redirects existing wins/learnings source items to Coach', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({
        title: 'Share ROI alpha customer-comms leverage win',
        text: 'User-added first so this test can simulate an older item created before source filtering.',
        category: 'user-request',
      });
      const itemId = added.state.items[0]!.id;

      store.updateInboxItem(itemId, {
        category: 'automation',
        source: {
          kind: 'automation',
          automationId: 'automation-wins-learnings-uncover',
          automationName: 'Wins & Learnings Coach',
          label: 'Exec coach scan — 2026-05-18',
        },
      } as any);

      const result = store.retroactiveInboxCleanup();
      expect(result.redirectedToCoach).toBe(1);
      expect(result.details[0]).toContain('wins-and-learnings source');
    });
  });

  describe('sanitizeTaskReference — email kind', () => {
    it('accepts email reference with threadId only', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({ kind: 'email', threadId: 'abc123' });
      expect(result).toEqual({ kind: 'email', threadId: 'abc123', messageId: undefined, provider: undefined, label: undefined });
    });

    it('rejects email reference with empty threadId', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({ kind: 'email', threadId: '' });
      expect(result).toBeNull();
    });

    it('rejects email reference with whitespace-only threadId', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({ kind: 'email', threadId: '   ' });
      expect(result).toBeNull();
    });

    it('accepts email reference with all fields populated', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({
        kind: 'email',
        threadId: 'abc123',
        messageId: 'msg456',
        provider: 'gmail',
        label: 'Thread: Q1 report',
      });
      expect(result).toEqual({
        kind: 'email',
        threadId: 'abc123',
        messageId: 'msg456',
        provider: 'gmail',
        label: 'Thread: Q1 report',
      });
    });

    it('accepts email reference with outlook provider', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({
        kind: 'email',
        threadId: 'thread-xyz',
        provider: 'outlook',
      });
      expect(result).toEqual({ kind: 'email', threadId: 'thread-xyz', messageId: undefined, provider: 'outlook', label: undefined });
    });

    it('strips invalid provider value', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({
        kind: 'email',
        threadId: 'abc',
        provider: 'invalid',
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('email');
      expect((result as any).provider).toBeUndefined();
    });

    it('trims threadId and messageId whitespace', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({
        kind: 'email',
        threadId: '  abc123  ',
        messageId: '  msg456  ',
      });
      expect(result).toEqual({ kind: 'email', threadId: 'abc123', messageId: 'msg456', provider: undefined, label: undefined });
    });

    it('strips empty messageId', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({
        kind: 'email',
        threadId: 'abc123',
        messageId: '',
      });
      expect(result).not.toBeNull();
      expect((result as any).messageId).toBeUndefined();
    });

    it('still handles workspace references', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({ kind: 'workspace', path: '/foo/bar' });
      expect(result).toEqual({ kind: 'workspace', path: '/foo/bar', label: undefined });
    });

    it('still handles url references', async () => {
      const store = await setupModule();
      const result = store.sanitizeTaskReference({ kind: 'url', url: 'https://example.com' });
      expect(result).toEqual({ kind: 'url', url: 'https://example.com', label: undefined });
    });
  });

  describe('periodicFreshnessCheck — reply/respond items', () => {
    it('does NOT auto-archive "Reply to" items based on age alone (user may be on holiday)', async () => {
      const store = await setupModule();
      const baseTime = 1700000000000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(baseTime);

      store.addInboxItem({
        title: 'Reply to Taberna Vicentina — confirm restaurant location for Tue 3 Mar dinner',
        text: 'Email response',
        category: 'automation',
      });

      // Even after 7 days, these should NOT be auto-archived — LLM freshness
      // check (Stage 10B) handles evidence-based archival via Gmail/Slack.
      dateNowSpy.mockReturnValue(baseTime + 7 * 24 * 60 * 60 * 1000);
      const result = store.periodicFreshnessCheck();
      expect(result.archived).toBe(0);
      dateNowSpy.mockRestore();
    });
  });

  describe('normalizeStatusFields', () => {
    it('derives status from archived when status is absent', async () => {
      const store = await setupModule();
      const archivedItem: any = store.normalizeStatusFields({ archived: true } as any);
      expect(archivedItem.status).toBe('completed');
      expect(archivedItem.archivedAt).toBeDefined();

      const activeItem: any = store.normalizeStatusFields({ archived: false } as any);
      expect(activeItem.status).toBe('active');
      expect(activeItem.archivedAt).toBeUndefined();
    });

    it('status takes precedence over archived', async () => {
      const store = await setupModule();
      const item: any = store.normalizeStatusFields({ status: 'completed', archived: false } as any);
      expect(item.archived).toBe(true);
      expect(item.completedAt).toBeDefined();
      expect(item.archivedAt).toBeDefined();
    });

    it('completed status sets completedAt', async () => {
      const store = await setupModule();
      const item: any = store.normalizeStatusFields({ status: 'completed' } as any);
      expect(item.archived).toBe(true);
      expect(item.completedAt).toBeDefined();
      expect(item.dismissedAt).toBeUndefined();
    });

    it('dismissed status sets dismissedAt', async () => {
      const store = await setupModule();
      const item: any = store.normalizeStatusFields({ status: 'dismissed' } as any);
      expect(item.archived).toBe(true);
      expect(item.dismissedAt).toBeDefined();
      expect(item.completedAt).toBeUndefined();
    });

    it('active status clears all terminal timestamps', async () => {
      const store = await setupModule();
      const item: any = store.normalizeStatusFields({
        status: 'active',
        archived: true,
        archivedAt: 1000,
        completedAt: 1000,
        dismissedAt: 1000,
      } as any);
      expect(item.archived).toBe(false);
      expect(item.archivedAt).toBeUndefined();
      expect(item.completedAt).toBeUndefined();
      expect(item.dismissedAt).toBeUndefined();
    });

    it('preserves existing completedAt when status is already completed', async () => {
      const store = await setupModule();
      const item = store.normalizeStatusFields({ status: 'completed', completedAt: 42 });
      expect(item.completedAt).toBe(42);
    });
  });

  describe('setInboxItemStatus', () => {
    it('transitions active → completed', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To complete', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const updated = store.setInboxItemStatus(itemId, 'completed', 'user');
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.status).toBe('completed');
      expect(item.completedBy).toBe('user');
      expect(item.completedAt).toBeDefined();
      expect(item.archived).toBe(true);
      expect(item.archivedAt).toBeDefined();
      expect(item.executingSessionId).toBeUndefined();
    });

    it('transitions active → dismissed', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To dismiss', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const updated = store.setInboxItemStatus(itemId, 'dismissed');
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.status).toBe('dismissed');
      expect(item.dismissedAt).toBeDefined();
      expect(item.archived).toBe(true);
      expect(item.completedBy).toBeUndefined();
    });

    it('clears executingSessionId when completing', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Executing task', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      store.setInboxItemExecuting(itemId, 'session-123');
      const updated = store.setInboxItemStatus(itemId, 'completed', 'rebel');
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.executingSessionId).toBeUndefined();
      expect(item.status).toBe('completed');
      expect(item.completedBy).toBe('rebel');
    });
  });

  describe('setInboxItemExecuting (status sync)', () => {
    it('sets status to executing and sessionId', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To execute', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const updated = store.setInboxItemExecuting(itemId, 'session-abc');
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.executingSessionId).toBe('session-abc');
      expect(item.status).toBe('executing');
      expect(item.archived).toBe(false);
    });

    it('clears status to active when sessionId is null', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Running', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      store.setInboxItemExecuting(itemId, 'session-xyz');
      const updated = store.setInboxItemExecuting(itemId, null);
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.executingSessionId).toBeUndefined();
      expect(item.status).toBe('active');
    });
  });

  describe('setInboxItemArchived (backward compat with status)', () => {
    it('archiving sets status to completed (legacy archive = done)', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Archive me', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      const updated = store.setInboxItemArchived(itemId, true);
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.archived).toBe(true);
      expect(item.status).toBe('completed');
    });

    it('unarchiving sets status to active', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Restore me', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      store.setInboxItemArchived(itemId, true);
      const updated = store.setInboxItemArchived(itemId, false);
      const item = updated.items.find(i => i.id === itemId)!;
      expect(item.archived).toBe(false);
      expect(item.status).toBe('active');
    });
  });

  // =========================================================================
  // Sync reconciliation (Stage 6)
  // =========================================================================

  describe('updatedAt tracking', () => {
    it('addInboxItem sets updatedAt', async () => {
      const store = await setupModule();
      const result = store.addInboxItem({ title: 'Test Task', text: 'Body', category: 'user-request' });
      const item = result.state.items[0]!;
      expect(item.updatedAt).toBeDefined();
      expect(typeof item.updatedAt).toBe('number');
      expect(Math.abs(item.updatedAt! - Date.now())).toBeLessThan(1000);
    });

    it('setInboxItemArchived updates updatedAt', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(1000);

      const added = store.addInboxItem({ title: 'Archive Test', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      const initialUpdatedAt = added.state.items[0]!.updatedAt;

      dateNowSpy.mockReturnValue(2000);
      const result = store.setInboxItemArchived(itemId, true);
      const item = result.items.find(i => i.id === itemId)!;
      expect(item.updatedAt).toBe(2000);
      expect(item.updatedAt).toBeGreaterThan(initialUpdatedAt!);
      dateNowSpy.mockRestore();
    });

    it('setInboxItemQuadrant updates updatedAt', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(1000);

      const added = store.addInboxItem({ title: 'Quadrant Test', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      dateNowSpy.mockReturnValue(2000);
      const result = store.setInboxItemQuadrant(itemId, true, true);
      const item = result.items.find(i => i.id === itemId)!;
      expect(item.updatedAt).toBe(2000);
      dateNowSpy.mockRestore();
    });

    it('updateInboxItem updates updatedAt', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(1000);

      const added = store.addInboxItem({ title: 'Update Test', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      dateNowSpy.mockReturnValue(2000);
      const result = store.updateInboxItem(itemId, { title: 'Updated Title' });
      const item = result.items.find(i => i.id === itemId)!;
      expect(item.updatedAt).toBe(2000);
      dateNowSpy.mockRestore();
    });
  });

  describe('toIndexEntry includes updatedAt', () => {
    it('toIndexEntry includes updatedAt from item', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'Index Entry Test', category: 'user-request' });
      const item = added.state.items[0]!;
      const indexEntry = store.toIndexEntry(item);
      expect(indexEntry.updatedAt).toBe(item.updatedAt);
    });
  });

  describe('delete tombstones', () => {
    it('removeInboxItem records a tombstone', async () => {
      const store = await setupModule();
      const added = store.addInboxItem({ title: 'To Delete', category: 'user-request' });
      const itemId = added.state.items[0]!.id;

      store.removeInboxItem(itemId);
      const tombstones = store.getDeletedIds();
      expect(tombstones.some(t => t.id === itemId)).toBe(true);
    });

    it('cleanupTombstones removes expired entries', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');

      // Add item and delete at time=1000
      dateNowSpy.mockReturnValue(1000);
      const added = store.addInboxItem({ title: 'Old Delete', category: 'user-request' });
      const itemId = added.state.items[0]!.id;
      store.removeInboxItem(itemId);

      // Verify tombstone exists
      expect(store.getDeletedIds().some(t => t.id === itemId)).toBe(true);

      // Advance time by 31 days (past 30-day tombstone max age)
      dateNowSpy.mockReturnValue(1000 + 31 * 24 * 60 * 60 * 1000);
      const removed = store.cleanupTombstones();
      expect(removed).toBe(1);
      expect(store.getDeletedIds().some(t => t.id === itemId)).toBe(false);
      dateNowSpy.mockRestore();
    });

    it('tombstones are capped at MAX_TOMBSTONES (500)', async () => {
      const store = await setupModule();

      // Add and immediately delete 501 items (keeps index small for performance)
      for (let i = 0; i < 501; i++) {
        const added = store.addInboxItem({ title: `Item ${i}`, category: 'user-request' });
        store.removeInboxItem(added.state.items[0]!.id);
      }

      const tombstones = store.getDeletedIds();
      expect(tombstones.length).toBe(500);
    });
  });

  describe('computeInboxSyncPlan', () => {
    it('returns toFetchFromCloud for items missing locally', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [],
        [{ id: 'a', addedAt: 100 }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).toContain('a');
    });

    it('returns toFetchFromCloud when cloud is newer', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, updatedAt: 100 }],
        [{ id: 'a', addedAt: 100, updatedAt: 200 }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).toContain('a');
    });

    it('skips fetch when local is newer or equal', async () => {
      const store = await setupModule();

      // Local newer
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, updatedAt: 200 }],
        [{ id: 'a', addedAt: 100, updatedAt: 100 }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');

      // Equal (desktop wins ties)
      const planEqual = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, updatedAt: 200 }],
        [{ id: 'a', addedAt: 100, updatedAt: 200 }],
        [], [],
        new Set(),
      );
      expect(planEqual.toFetchFromCloud).not.toContain('a');
    });

    it('skips locally tombstoned items', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [],
        [{ id: 'a', addedAt: 100 }],
        [{ id: 'a', deletedAt: 200 }],
        [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('skips items in local history', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [],
        [{ id: 'a', addedAt: 100 }],
        [], [],
        new Set(['a']),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('never overwrites items with status executing (non-terminal cloud update)', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, updatedAt: 100, status: 'executing' }],
        [{ id: 'a', addedAt: 100, updatedAt: 200 }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('returns toPushToCloud for items missing on cloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'b', addedAt: 100 }],
        [],
        [], [],
        new Set(),
      );
      expect(plan.toPushToCloud).toContain('b');
    });

    it('returns toPushToCloud when local is newer', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'b', addedAt: 100, updatedAt: 200 }],
        [{ id: 'b', addedAt: 100, updatedAt: 100 }],
        [], [],
        new Set(),
      );
      expect(plan.toPushToCloud).toContain('b');
    });

    it('returns toDeleteLocally when cloud tombstoned and newer', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'c', addedAt: 100, updatedAt: 100 }],
        [],
        [],
        [{ id: 'c', deletedAt: 200 }],
        new Set(),
      );
      expect(plan.toDeleteLocally).toContain('c');
    });

    it('does NOT delete locally when local is newer than cloud tombstone', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'c', addedAt: 100, updatedAt: 300 }],
        [],
        [],
        [{ id: 'c', deletedAt: 200 }],
        new Set(),
      );
      expect(plan.toDeleteLocally).not.toContain('c');
    });

    it('returns toDeleteOnCloud for locally tombstoned items still on cloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [],
        [{ id: 'd', addedAt: 100 }],
        [{ id: 'd', deletedAt: 200 }],
        [],
        new Set(),
      );
      expect(plan.toDeleteOnCloud).toContain('d');
    });

    it('uses addedAt as fallback when updatedAt is missing', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100 }],
        [{ id: 'a', addedAt: 200 }],
        [], [],
        new Set(),
      );
      // Cloud addedAt=200 > local addedAt=100 → fetch from cloud
      expect(plan.toFetchFromCloud).toContain('a');
    });

    it('pushes to cloud when archived state diverges without updatedAt', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, archived: true }],
        [{ id: 'a', addedAt: 100, archived: false }],
        [], [],
        new Set(),
      );
      // Same addedAt, no updatedAt, but archived differs → push desktop's state
      expect(plan.toPushToCloud).toContain('a');
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('does not push when archived state matches without updatedAt', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 100, archived: true }],
        [{ id: 'a', addedAt: 100, archived: true }],
        [], [],
        new Set(),
      );
      expect(plan.toPushToCloud).not.toContain('a');
      expect(plan.toFetchFromCloud).not.toContain('a');
    });
  });

  describe('computeInboxSyncPlan — executing guard', () => {
    // Regression guard for REBEL-1C6 / Sentry 7416504405.
    // Mirrors the applier's canClobberLocalExecuting policy so the planner
    // never strands terminal cloud handoffs behind locally-executing items.

    it('local executing + cloud terminal + cloud strictly newer → ID in toFetchFromCloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 50, updatedAt: 100, status: 'executing' }],
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'completed' }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).toContain('a');
    });

    it('local executing + cloud terminal (dismissed) + cloud strictly newer → ID in toFetchFromCloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 50, updatedAt: 100, status: 'executing' }],
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'dismissed' }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).toContain('a');
    });

    it('local executing + cloud non-terminal + cloud strictly newer → ID NOT in toFetchFromCloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 50, updatedAt: 100, status: 'executing' }],
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'active' }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('local executing + cloud terminal + cloud OLDER → ID NOT in toFetchFromCloud', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'executing' }],
        [{ id: 'a', addedAt: 50, updatedAt: 100, status: 'completed' }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });

    it('local executing + cloud terminal + cloud same updatedAt → ID NOT in toFetchFromCloud (strictly newer)', async () => {
      const store = await setupModule();
      const plan = store.computeInboxSyncPlan(
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'executing' }],
        [{ id: 'a', addedAt: 50, updatedAt: 200, status: 'completed' }],
        [], [],
        new Set(),
      );
      expect(plan.toFetchFromCloud).not.toContain('a');
    });
  });

  describe('canClobberLocalExecuting', () => {
    it('returns true when local is not executing (normal merge rules apply elsewhere)', async () => {
      const store = await setupModule();
      expect(store.canClobberLocalExecuting(
        { status: 'active', addedAt: 100, updatedAt: 100 },
        { status: 'completed', addedAt: 100, updatedAt: 50 },
      )).toBe(true);
      expect(store.canClobberLocalExecuting(
        { addedAt: 100, updatedAt: 100 },
        { status: 'active', addedAt: 100, updatedAt: 200 },
      )).toBe(true);
    });

    it('returns true when local executing + incoming completed/dismissed + strictly newer', async () => {
      const store = await setupModule();
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 100 },
        { status: 'completed', addedAt: 50, updatedAt: 200 },
      )).toBe(true);
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 100 },
        { status: 'dismissed', addedAt: 50, updatedAt: 200 },
      )).toBe(true);
    });

    it('returns false when local executing + incoming non-terminal', async () => {
      const store = await setupModule();
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 100 },
        { status: 'active', addedAt: 50, updatedAt: 200 },
      )).toBe(false);
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 100 },
        { addedAt: 50, updatedAt: 200 },
      )).toBe(false);
    });

    it('returns false when local executing + incoming terminal but older or equal', async () => {
      const store = await setupModule();
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 200 },
        { status: 'completed', addedAt: 50, updatedAt: 100 },
      )).toBe(false);
      expect(store.canClobberLocalExecuting(
        { status: 'executing', addedAt: 50, updatedAt: 200 },
        { status: 'completed', addedAt: 50, updatedAt: 200 },
      )).toBe(false);
    });
  });

  describe('upsertInboxItemFromCloud with updatedAt', () => {
    it('replaces existing item when cloud is newer', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Local Version', text: 'Original', category: 'user-request' });
      const localItem = added.state.items[0]!;

      // Cloud item with newer updatedAt
      const cloudItem = {
        ...localItem,
        title: 'Cloud Version',
        text: 'From Cloud',
        updatedAt: 200,
      };

      dateNowSpy.mockReturnValue(200);
      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(true);

      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.title).toBe('Cloud Version');
      expect(item.text).toBe('From Cloud');
      dateNowSpy.mockRestore();
    });

    it('skips when local is newer', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(200);

      const added = store.addInboxItem({ title: 'Local Version', text: 'Original', category: 'user-request' });
      const localItem = added.state.items[0]!;

      // Cloud item with older updatedAt
      const cloudItem = {
        ...localItem,
        title: 'Cloud Version',
        updatedAt: 100,
      };

      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(false);

      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.title).toBe('Local Version');
      dateNowSpy.mockRestore();
    });

    it('skips non-terminal items when local is executing', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Local Version', category: 'user-request' });
      const localItem = added.state.items[0]!;

      dateNowSpy.mockReturnValue(150);
      store.setInboxItemExecuting(localItem.id, 'session-123');

      // Cloud item with newer updatedAt but non-terminal status
      const cloudItem = {
        ...localItem,
        title: 'Cloud Version',
        updatedAt: 200,
      };

      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(false);

      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.title).toBe('Local Version');
      expect(item.status).toBe('executing');
      dateNowSpy.mockRestore();
    });

    it('allows completed upsert over executing item when newer', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Ask Greg for benchmark', category: 'meeting-action' });
      const localItem = added.state.items[0]!;

      dateNowSpy.mockReturnValue(150);
      store.setInboxItemExecuting(localItem.id, 'session-456');

      // Incoming completed item from the executor, strictly newer
      const cloudItem = {
        ...localItem,
        status: 'completed' as const,
        archived: true,
        archivedAt: 300,
        completedAt: 300,
        completedBy: 'rebel' as const,
        updatedAt: 300,
      };

      dateNowSpy.mockReturnValue(300);
      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(true);

      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.status).toBe('completed');
      expect(item.archived).toBe(true);
      dateNowSpy.mockRestore();
    });

    it('blocks completed upsert over executing item when older', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Stale completion', category: 'user-request' });
      const localItem = added.state.items[0]!;

      dateNowSpy.mockReturnValue(200);
      store.setInboxItemExecuting(localItem.id, 'session-789');

      // Incoming completed item but with OLDER updatedAt
      const cloudItem = {
        ...localItem,
        status: 'completed' as const,
        archived: true,
        updatedAt: 150,
      };

      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(false);

      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.status).toBe('executing');
      dateNowSpy.mockRestore();
    });

    it('falls back to archive-only merge when neither has updatedAt', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Compat Test', category: 'user-request' });
      const localItem = added.state.items[0]!;

      // Overwrite the entry file without updatedAt to simulate a legacy item
      const legacyItem = { ...localItem };
      delete legacyItem.updatedAt;
      store.writeEntryFile(localItem.id, legacyItem);

      // Cloud item: no updatedAt, but archived
      const cloudItem = {
        ...legacyItem,
        archived: true,
        archivedAt: 100,
      };

      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(true);

      // Only archive state should change
      const state = store.getInboxState();
      const item = state.items.find(i => i.id === localItem.id)!;
      expect(item.archived).toBe(true);
      dateNowSpy.mockRestore();
    });

    it('skips tombstoned items', async () => {
      const store = await setupModule();
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(100);

      const added = store.addInboxItem({ title: 'Will Delete', category: 'user-request' });
      const localItem = added.state.items[0]!;

      // Delete the item (creates tombstone)
      store.removeInboxItem(localItem.id);

      // Try to upsert from cloud — should be skipped
      const cloudItem = {
        ...localItem,
        updatedAt: 200,
      };

      const result = store.upsertInboxItemFromCloud(cloudItem);
      expect(result).toBe(false);

      // Item should not be re-added
      const state = store.getInboxState();
      expect(state.items.find(i => i.id === localItem.id)).toBeUndefined();
      dateNowSpy.mockRestore();
    });
  });
});
