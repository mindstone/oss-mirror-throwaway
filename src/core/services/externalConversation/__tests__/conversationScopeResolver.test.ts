import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationScopeResolver } from '../conversationScopeResolver';
import type {
  BrowserTabContext,
  OfficeDocumentContext,
  SlackThreadContext,
  SlackMentionPollContext
} from '../externalContext';

/**
 * Stage 2 conversationScopeResolver tests
 * Note on Spec Reader invariant: Stage 2 introduces NO new broadcasts
 * so the cross-session routed broadcast provenance invariant is trivially preserved
 * (no new broadcast = no new provenance leak risk).
 */
describe('ConversationScopeResolver', () => {
  let resolver: ConversationScopeResolver;

  beforeEach(() => {
    resolver = new ConversationScopeResolver();
  });

  const tabA1: BrowserTabContext = {
    kind: 'browser-tab',
    identity: { tabId: 1, origin: 'https://example.com', pathname: '/doc1' },
    metadata: { url: 'https://example.com/doc1' }
  };
  const tabA2: BrowserTabContext = {
    kind: 'browser-tab',
    identity: { tabId: 1, origin: 'https://example.com', pathname: '/doc1' },
    metadata: { url: 'https://example.com/doc1?query=1#section' }
  };
  const tabB: BrowserTabContext = {
    kind: 'browser-tab',
    identity: { tabId: 2, origin: 'https://example.com', pathname: '/doc2' },
    metadata: { url: 'https://example.com/doc2' }
  };
  
  const officeDocA: OfficeDocumentContext = {
    kind: 'office-document',
    identity: { host: 'word', docId: 'doc-123' },
    metadata: {}
  };
  
  const officeDocB: OfficeDocumentContext = {
    kind: 'office-document',
    identity: { host: 'excel', docId: 'doc-456' },
    metadata: {}
  };

  const slackThreadA: SlackThreadContext = {
    kind: 'slack-thread',
    identity: { teamId: 'T1', channelId: 'C1', threadTs: '1000' },
    metadata: {}
  };

  const slackMentionA: SlackMentionPollContext = {
    kind: 'slack-mention-poll',
    identity: { teamId: 'T1', channelId: 'C1', threadTs: '1000', mentionEventId: 'M1' },
    metadata: { userId: 'U1' }
  };
  const slackMentionB: SlackMentionPollContext = {
    kind: 'slack-mention-poll',
    identity: { teamId: 'T1', channelId: 'C2', threadTs: '1001', mentionEventId: 'M1' }, // same mentionEventId
    metadata: { userId: 'U2' }
  };

  describe('(a) Per-kind scope match', () => {
    it('matches browser-tab scopes correctly', () => {
      expect(resolver.matchesScope(tabA1, tabA2)).toBe(true);
      expect(resolver.matchesScope(tabA1, tabB)).toBe(false);
    });

    it('matches office-document scopes correctly', () => {
      expect(resolver.matchesScope(officeDocA, { ...officeDocA })).toBe(true);
      expect(resolver.matchesScope(officeDocA, officeDocB)).toBe(false);
    });

    it('matches slack-thread scopes correctly', () => {
      expect(resolver.matchesScope(slackThreadA, { ...slackThreadA, metadata: { userId: 'U99' } })).toBe(true);
    });

    it('matches slack-mention-poll scopes correctly (by mentionEventId)', () => {
      expect(resolver.matchesScope(slackMentionA, slackMentionB)).toBe(true);
    });
  });

  describe('(b) Cross-kind never matches', () => {
    it('does not match different kinds even with similar IDs', () => {
      const officeWord: OfficeDocumentContext = { kind: 'office-document', identity: { host: 'slack-thread', docId: 'T1:C1:1000' }, metadata: {} };
      // Even if we contrived the IDs to be somewhat similar strings, the kinds differ.
      // @ts-ignore - explicitly testing mismatched kinds where TS would allow it
      expect(resolver.matchesScope(slackThreadA, officeWord)).toBe(false);
      // @ts-ignore
      expect(resolver.matchesScope(tabA1, slackThreadA)).toBe(false);
    });
  });

  describe('(c) matchesFingerprint', () => {
    it('uses strict tabContextsMateriallyMatch for browser-tab', () => {
      // Loose scope matches
      expect(resolver.matchesScope(tabA1, tabA2)).toBe(true);
      // But strict fingerprint DOES NOT because URL hash/query differ
      expect(resolver.matchesFingerprint(tabA1, tabA2)).toBe(false);
      // Identical fingerprints match
      expect(resolver.matchesFingerprint(tabA1, { ...tabA1 })).toBe(true);
    });

    it('falls back to matchesScope for other kinds', () => {
      expect(resolver.matchesFingerprint(officeDocA, { ...officeDocA })).toBe(true);
      expect(resolver.matchesFingerprint(slackThreadA, { ...slackThreadA })).toBe(true);
      expect(resolver.matchesFingerprint(slackMentionA, slackMentionB)).toBe(true);
    });
  });

  describe('(d) Resolver capacity bound', () => {
    it('evicts oldest bindings when exceeding capacity', () => {
      const smallResolver = new ConversationScopeResolver(3);
      smallResolver.bindConversation('c1', tabA1);
      smallResolver.bindConversation('c2', tabA2);
      smallResolver.bindConversation('c3', tabB);
      smallResolver.bindConversation('c4', officeDocA);
      
      expect(smallResolver.getBinding('c1')).toBeUndefined(); // evicted
      expect(smallResolver.getBinding('c2')).toBeDefined();
      expect(smallResolver.getBinding('c3')).toBeDefined();
      expect(smallResolver.getBinding('c4')).toBeDefined();
    });
  });

  describe('(e) releaseBinding', () => {
    it('removes the binding', () => {
      resolver.bindConversation('c1', tabA1);
      expect(resolver.getBinding('c1')).toBeDefined();
      resolver.releaseBinding('c1');
      expect(resolver.getBinding('c1')).toBeUndefined();
    });
  });

  describe('(f) resolve returns isNewConversation correctly', () => {
    it('returns isNewConversation: true on first call, false on second', () => {
      const result1 = resolver.resolve(officeDocA);
      expect(result1.isNewConversation).toBe(true);
      expect(result1.conversationId).toBeDefined();

      const result2 = resolver.resolve(officeDocA);
      expect(result2.isNewConversation).toBe(false);
      expect(result2.conversationId).toBe(result1.conversationId);
    });
  });

  describe('(f2) lookup is read-only', () => {
    it('returns an existing binding without resolving a new conversation', () => {
      resolver.bindConversation('existing-conversation', slackThreadA);

      expect(resolver.lookup({ ...slackThreadA, metadata: { userId: 'U99' } })).toEqual({
        conversationId: 'existing-conversation',
      });
    });

    it('returns null when no binding exists', () => {
      expect(resolver.lookup(officeDocA)).toBeNull();
    });

    it('does not mutate bindings or capacity state for a missing lookup', () => {
      const smallResolver = new ConversationScopeResolver(1);
      smallResolver.bindConversation('c1', officeDocA);

      expect(smallResolver.lookup(officeDocB)).toBeNull();
      expect(smallResolver.getBinding('c1')).toBeDefined();

      const resolved = smallResolver.resolve(officeDocB);
      expect(resolved.isNewConversation).toBe(true);
      expect(smallResolver.getBinding('c1')).toBeUndefined();
    });
  });

  describe('(g) slack-mention-poll resolve', () => {
    it('resolves to same conversationId based purely on mentionEventId', () => {
      const res1 = resolver.resolve(slackMentionA);
      const res2 = resolver.resolve(slackMentionB); // same mentionEventId, different channel/user
      expect(res1.conversationId).toBe(res2.conversationId);
      expect(res2.isNewConversation).toBe(false);
    });
  });

  describe('(h) forceConversationId override (Stage 3 readiness)', () => {
    it('uses forceConversationId when no matching scope is found', () => {
      const res = resolver.resolve(officeDocA, 'pre-existing-conv-123');
      expect(res.conversationId).toBe('pre-existing-conv-123');
      expect(res.isNewConversation).toBe(true);
    });

    it('returns existing conversationId even if forceConversationId is provided (existing scope wins)', () => {
      const res1 = resolver.resolve(officeDocA);
      const res2 = resolver.resolve(officeDocA, 'should-be-ignored');
      expect(res2.conversationId).toBe(res1.conversationId);
      expect(res2.isNewConversation).toBe(false);
    });
  });

  describe('(i) O(1) scope-key index correctness', () => {
    it('rebinding the same conversationId to a new context updates the index', () => {
      resolver.bindConversation('c1', officeDocA);
      const res1 = resolver.resolve(officeDocA);
      expect(res1.conversationId).toBe('c1');

      resolver.bindConversation('c1', officeDocB);
      const res2 = resolver.resolve(officeDocB);
      expect(res2.conversationId).toBe('c1');
      expect(res2.isNewConversation).toBe(false);
      // Old binding key is gone — resolving the original context mints a new conversation.
      const res3 = resolver.resolve(officeDocA);
      expect(res3.isNewConversation).toBe(true);
      expect(res3.conversationId).not.toBe('c1');
    });

    it('releaseBinding removes the index entry', () => {
      resolver.bindConversation('c1', officeDocA);
      resolver.releaseBinding('c1');
      const res = resolver.resolve(officeDocA);
      expect(res.isNewConversation).toBe(true);
      expect(res.conversationId).not.toBe('c1');
    });

    it('LRU eviction also evicts the index entry', () => {
      const smallResolver = new ConversationScopeResolver(2);
      smallResolver.bindConversation('c1', officeDocA);
      smallResolver.bindConversation('c2', tabA1);
      smallResolver.bindConversation('c3', slackThreadA); // evicts c1
      // c1's office-document scope-key entry must be cleared from the index
      const res = smallResolver.resolve(officeDocA);
      expect(res.isNewConversation).toBe(true);
      expect(res.conversationId).not.toBe('c1');
    });
  });
});
