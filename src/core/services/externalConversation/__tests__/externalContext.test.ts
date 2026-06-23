/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Tests for ExternalContext schemas and deriveScopeKey projector.
 * Verifies invariants around Zod parsing, kind narrowing, identity projection,
 * and strict fingerprint matching.
 *
 * @see docs/plans/260502_unified_external_conversation_architecture.md
 */

import { describe, expect, it } from 'vitest';
import {
  ExternalContext,
  BrowserTabContext,
  OfficeDocumentContext,
  SlackThreadContext,
  SlackMentionPollContext,
  deriveScopeKey,
  tabContextsMateriallyMatch,
} from '../externalContext';
import type { TabContext } from '@core/appBridge/shared/protocol';

describe('ExternalContext Schemas', () => {
  describe('Zod-parses valid payloads', () => {
    it('parses browser-tab', () => {
      const payload = {
        kind: 'browser-tab',
        identity: { tabId: 42, origin: 'https://example.com', pathname: '/page' },
        metadata: { url: 'https://example.com/page?query=1#hash', title: 'Example Page' },
      };
      const parsed = BrowserTabContext.parse(payload);
      expect(parsed).toEqual(payload);
    });

    it('parses office-document', () => {
      const payload = {
        kind: 'office-document',
        identity: { host: 'Word', docId: 'doc-123' },
        metadata: { title: 'My Document.docx' },
      };
      const parsed = OfficeDocumentContext.parse(payload);
      expect(parsed).toEqual(payload);
    });

    it('parses slack-thread', () => {
      const payload = {
        kind: 'slack-thread',
        identity: { teamId: 'T123', channelId: 'C123', threadTs: '1234.56' },
        metadata: { userId: 'U123', userDisplayName: 'Alice', digestFilteredCount: 2 },
      };
      const parsed = SlackThreadContext.parse(payload);
      expect(parsed).toEqual(payload);
    });

    it('parses slack-mention-poll', () => {
      const payload = {
        kind: 'slack-mention-poll',
        identity: { teamId: 'T123', channelId: 'C123', threadTs: '1234.56', mentionEventId: 'evt-456' },
        metadata: { userId: 'U123' },
      };
      const parsed = SlackMentionPollContext.parse(payload);
      expect(parsed).toEqual(payload);
    });
  });

  describe('Discriminator narrows correctly per kind', () => {
    it('narrows to SlackThreadContext', () => {
      const payload: ExternalContext = {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: 'ts1' },
        metadata: {},
      };
      
      if (payload.kind === 'slack-thread') {
        // Typescript narrowing assert
        expect(payload.identity.teamId).toBe('T1');
      } else {
        expect.fail('Should have narrowed to slack-thread');
      }
    });

    it('narrows to BrowserTabContext', () => {
      const payload: ExternalContext = {
        kind: 'browser-tab',
        identity: { tabId: 1, origin: 'http://localhost', pathname: '/' },
        metadata: { url: 'http://localhost/' },
      };

      if (payload.kind === 'browser-tab') {
        expect(payload.identity.tabId).toBe(1);
      } else {
        expect.fail('Should have narrowed to browser-tab');
      }
    });
  });

  describe('Malformed payloads rejected with structured errors', () => {
    it('rejects missing identity fields', () => {
      const payload = {
        kind: 'office-document',
        identity: { host: 'Word' }, // missing docId
        metadata: {},
      };
      
      const result = OfficeDocumentContext.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('docId');
      }
    });

    it('rejects completely invalid kind', () => {
      const payload = { kind: 'unknown', identity: {}, metadata: {} };
      const result = ExternalContext.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe('deriveScopeKey', () => {
    it('is deterministic and produces distinct keys across kinds', () => {
      const browserCtx: ExternalContext = {
        kind: 'browser-tab',
        identity: { tabId: 1, origin: 'o', pathname: 'p' },
        metadata: { url: 'u' },
      };
      const officeCtx: ExternalContext = {
        kind: 'office-document',
        identity: { host: 'h', docId: 'd' },
        metadata: {},
      };
      const slackThreadCtx: ExternalContext = {
        kind: 'slack-thread',
        identity: { teamId: 't', channelId: 'c', threadTs: 'ts' },
        metadata: {},
      };
      
      const browserKey = deriveScopeKey(browserCtx);
      const officeKey = deriveScopeKey(officeCtx);
      const slackKey = deriveScopeKey(slackThreadCtx);

      expect(browserKey).toBe('browser-tab:1:o:p');
      expect(officeKey).toBe('office-document:h:d');
      expect(slackKey).toBe('slack-thread:t:c:ts');
      
      expect(browserKey).not.toEqual(officeKey);
      expect(officeKey).not.toEqual(slackKey);
    });

    it('slack-mention-poll scope key uses ONLY mentionEventId (D2/D8)', () => {
      const a: ExternalContext = {
        kind: 'slack-mention-poll',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: 'ts1', mentionEventId: 'evt-abc' },
        metadata: {},
      };
      const b: ExternalContext = {
        kind: 'slack-mention-poll',
        identity: { teamId: 'T2', channelId: 'C2', threadTs: 'ts2', mentionEventId: 'evt-abc' },
        metadata: {},
      };
      expect(deriveScopeKey(a)).toBe('slack-mention-poll:evt-abc');
      // Different team/channel/threadTs but same mentionEventId → same scope key.
      // This preserves the existing `inbound-slack-mention--{uuid}` semantics from 260213.
      expect(deriveScopeKey(a)).toEqual(deriveScopeKey(b));
    });

    it('Identity vs metadata: changing metadata-only fields does NOT change deriveScopeKey output', () => {
      const baseCtx: ExternalContext = {
        kind: 'browser-tab',
        identity: { tabId: 42, origin: 'https://app.factory.ai', pathname: '/dashboard' },
        metadata: { url: 'https://app.factory.ai/dashboard', title: 'Dashboard' },
      };
      
      const changedMetadataCtx: ExternalContext = {
        kind: 'browser-tab',
        identity: { tabId: 42, origin: 'https://app.factory.ai', pathname: '/dashboard' },
        metadata: { url: 'https://app.factory.ai/dashboard?q=123', title: 'Dashboard Updated' },
      };

      expect(deriveScopeKey(baseCtx)).toEqual(deriveScopeKey(changedMetadataCtx));
    });

    it('preserves slack digestFilteredCount across JSON serialization round-trips', () => {
      const context: ExternalContext = {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '1700000000.000001' },
        metadata: {
          userId: 'U1',
          digestFilteredCount: 3,
        },
      };

      const serialized = JSON.stringify(context);
      const parsedJson = JSON.parse(serialized);
      const parsed = SlackThreadContext.parse(parsedJson);

      expect(parsed.metadata.digestFilteredCount).toBe(3);
    });
  });

  describe('tabContextsMateriallyMatch parity', () => {
    it('returns true for identical inputs', () => {
      const a: TabContext = { tabId: 1, url: 'https://a.com/b?c=d#e' };
      const b: TabContext = { tabId: 1, url: 'https://a.com/b?c=d#e' };
      expect(tabContextsMateriallyMatch(a, b)).toBe(true);
    });

    it('returns false for different tabId', () => {
      const a: TabContext = { tabId: 1, url: 'https://a.com/b' };
      const b: TabContext = { tabId: 2, url: 'https://a.com/b' };
      expect(tabContextsMateriallyMatch(a, b)).toBe(false);
    });

    it('returns false for different urls', () => {
      const a: TabContext = { tabId: 1, url: 'https://a.com/b' };
      const b: TabContext = { tabId: 1, url: 'https://a.com/c' };
      expect(tabContextsMateriallyMatch(a, b)).toBe(false);
    });

    it('returns true when one tabId is missing', () => {
      const a: TabContext = { tabId: 1, url: 'https://a.com/b' };
      const b: TabContext = { url: 'https://a.com/b' };
      expect(tabContextsMateriallyMatch(a, b)).toBe(true);
    });

    it('handles mixed cases and missing urls', () => {
      const a: TabContext = { tabId: 1 };
      const b: TabContext = { tabId: 1 };
      expect(tabContextsMateriallyMatch(a, b)).toBe(true);
    });
  });
});
