import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../analytics', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: vi.fn().mockReturnValue('anon-123'),
}));

vi.mock('../../../shared/utils/mcpInstanceUtils', () => ({
  parseMultiInstanceServer: (name: string) => {
    if (name.startsWith('GoogleWorkspace-')) {
      return { isInstance: true, baseName: 'GoogleWorkspace', emailSlug: name.slice(17), workspaceSlug: null, instanceType: 'email' };
    }
    if (name.startsWith('Slack-')) {
      return { isInstance: true, baseName: 'Slack', emailSlug: null, workspaceSlug: name.slice(6), instanceType: 'workspace' };
    }
    return { isInstance: false, baseName: null, emailSlug: null, workspaceSlug: null, instanceType: null };
  },
}));

import { trackMainEvent } from '../../analytics';
import {
  trackOAuthBrowserOpened,
  trackOAuthCallbackReceived,
  trackDeepLinkCallback,
  _testOnly,
} from '../oauthTelemetry';

const mockTrackMainEvent = vi.mocked(trackMainEvent);

beforeEach(() => {
  vi.clearAllMocks();
  _testOnly.activeOAuthFlows.clear();
});

describe('oauthTelemetry', () => {
  describe('trackOAuthBrowserOpened', () => {
    it('fires event with correct properties', () => {
      trackOAuthBrowserOpened({
        connectorName: 'Slack',
        connectorType: 'bundled',
        oauthUrl: 'https://slack.com/oauth/v2/authorize?client_id=xxx&state=yyy',
        callbackMethod: 'deep_link',
      });

      expect(mockTrackMainEvent).toHaveBeenCalledWith({
        anonymousId: 'anon-123',
        event: 'Connector OAuth Browser Opened',
        properties: {
          connectorName: 'Slack',
          connectorType: 'bundled',
          oauthMethod: 'browser_redirect',
          oauthUrl: 'slack.com',
          callbackMethod: 'deep_link',
        },
      });
    });

    it('stores flow state in activeOAuthFlows map', () => {
      trackOAuthBrowserOpened({
        connectorName: 'Microsoft',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      const state = _testOnly.activeOAuthFlows.get('microsoft');
      expect(state).toBeDefined();
      expect(state!.connectorName).toBe('Microsoft');
      expect(state!.openedAt).toBeGreaterThan(0);
    });

    it('strips PII from multi-instance connector names', () => {
      trackOAuthBrowserOpened({
        connectorName: 'GoogleWorkspace-greg-work-com',
        connectorType: 'bundled',
        oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        callbackMethod: 'localhost',
      });

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            connectorName: 'GoogleWorkspace',
          }),
        })
      );
    });

    it('never throws even if trackMainEvent fails', () => {
      mockTrackMainEvent.mockImplementation(() => { throw new Error('analytics down'); });
      expect(() => {
        trackOAuthBrowserOpened({
          connectorName: 'Slack',
          connectorType: 'bundled',
          callbackMethod: 'deep_link',
        });
      }).not.toThrow();
    });

    it('evicts stale entries on each call', () => {
      // Manually insert a stale entry
      _testOnly.activeOAuthFlows.set('stale', {
        openedAt: Date.now() - 15 * 60 * 1000, // 15 minutes old
        connectorName: 'Stale',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      trackOAuthBrowserOpened({
        connectorName: 'Fresh',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      expect(_testOnly.activeOAuthFlows.has('stale')).toBe(false);
      expect(_testOnly.activeOAuthFlows.has('fresh')).toBe(true);
    });
  });

  describe('trackOAuthCallbackReceived', () => {
    it('fires event with durationMs from stored flow state', () => {
      const openedAt = Date.now() - 5000;
      _testOnly.activeOAuthFlows.set('slack', {
        openedAt,
        connectorName: 'Slack',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      trackOAuthCallbackReceived({ connectorName: 'Slack', success: true });

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'Connector OAuth Callback Received',
          properties: expect.objectContaining({
            connectorName: 'Slack',
            connectorType: 'bundled',
            callbackMethod: 'deep_link',
            success: true,
          }),
        })
      );
      const props = mockTrackMainEvent.mock.calls[0][0].properties!;
      expect(props.durationMs).toBeGreaterThanOrEqual(4900);
    });

    it('removes flow state from map after tracking', () => {
      _testOnly.activeOAuthFlows.set('slack', {
        openedAt: Date.now(),
        connectorName: 'Slack',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      trackOAuthCallbackReceived({ connectorName: 'Slack', success: true });
      expect(_testOnly.activeOAuthFlows.has('slack')).toBe(false);
    });

    it('handles missing flow state gracefully (cold start)', () => {
      trackOAuthCallbackReceived({ connectorName: 'Microsoft', success: true });

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            connectorName: 'Microsoft',
            success: true,
          }),
        })
      );
      const props = mockTrackMainEvent.mock.calls[0][0].properties!;
      expect(props.durationMs).toBeUndefined();
    });

    it('includes sanitized error message on failure', () => {
      trackOAuthCallbackReceived({
        connectorName: 'Slack',
        success: false,
        errorMessage: 'Redirect to https://slack.com/oauth?code=secret&state=xxx failed for user@example.com',
      });

      const props = mockTrackMainEvent.mock.calls[0][0].properties!;
      expect(props.errorMessage).not.toContain('https://');
      expect(props.errorMessage).not.toContain('user@example.com');
      expect(props.errorMessage).toContain('[URL]');
      expect(props.errorMessage).toContain('[EMAIL]');
    });

    it('never throws even if trackMainEvent fails', () => {
      mockTrackMainEvent.mockImplementation(() => { throw new Error('analytics down'); });
      expect(() => {
        trackOAuthCallbackReceived({ connectorName: 'Slack', success: false });
      }).not.toThrow();
    });
  });

  describe('trackDeepLinkCallback', () => {
    it('parses connector name from deep link URL', () => {
      _testOnly.activeOAuthFlows.set('slack', {
        openedAt: Date.now() - 3000,
        connectorName: 'Slack',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      trackDeepLinkCallback('mindstone://slack/callback?code=abc&state=xyz');

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'Connector OAuth Callback Received',
          properties: expect.objectContaining({
            connectorName: 'Slack',
            success: true,
          }),
        })
      );
    });

    it('detects error in callback URL', () => {
      trackDeepLinkCallback('mindstone://slack/callback?error=access_denied');

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            success: false,
            errorMessage: 'access_denied',
          }),
        })
      );
    });

    it('ignores non-callback deep links', () => {
      trackDeepLinkCallback('mindstone://settings/connectors');
      expect(mockTrackMainEvent).not.toHaveBeenCalled();
    });

    it('ignores unknown provider callbacks', () => {
      trackDeepLinkCallback('mindstone://unknown/callback?code=abc');
      expect(mockTrackMainEvent).not.toHaveBeenCalled();
    });

    it('never throws on malformed URLs', () => {
      expect(() => trackDeepLinkCallback('not-a-url')).not.toThrow();
      expect(() => trackDeepLinkCallback('')).not.toThrow();
    });
  });

  describe('safeDomain', () => {
    it('extracts hostname from valid URL', () => {
      expect(_testOnly.safeDomain('https://slack.com/oauth?code=abc')).toBe('slack.com');
    });

    it('returns undefined for invalid URL', () => {
      expect(_testOnly.safeDomain('not-a-url')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(_testOnly.safeDomain(undefined)).toBeUndefined();
    });
  });

  describe('safeConnectorName', () => {
    it('returns base name for multi-instance servers', () => {
      expect(_testOnly.safeConnectorName('GoogleWorkspace-greg-work-com')).toBe('GoogleWorkspace');
      expect(_testOnly.safeConnectorName('Slack-mindstone')).toBe('Slack');
    });

    it('returns original name for non-instance servers', () => {
      expect(_testOnly.safeConnectorName('Notion')).toBe('Notion');
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('strips URLs', () => {
      expect(_testOnly.sanitizeErrorMessage('Failed at https://example.com/auth?code=abc')).toBe('Failed at [URL]');
    });

    it('strips email addresses', () => {
      expect(_testOnly.sanitizeErrorMessage('Error for user@example.com')).toBe('Error for [EMAIL]');
    });

    it('truncates long messages', () => {
      const long = 'x'.repeat(300);
      expect(_testOnly.sanitizeErrorMessage(long)!.length).toBe(200);
    });

    it('returns undefined for undefined input', () => {
      expect(_testOnly.sanitizeErrorMessage(undefined)).toBeUndefined();
    });

    it('redacts OAuth secret parameters', () => {
      const msg = 'Token exchange failed: code=abc123&client_secret=s3cret&state=xyz';
      const sanitized = _testOnly.sanitizeErrorMessage(msg)!;
      expect(sanitized).not.toContain('abc123');
      expect(sanitized).not.toContain('s3cret');
      expect(sanitized).not.toContain('xyz');
      expect(sanitized).toContain('code=[REDACTED]');
      expect(sanitized).toContain('client_secret=[REDACTED]');
      expect(sanitized).toContain('state=[REDACTED]');
    });
  });

  describe('trackDeepLinkCallback - Discourse payload', () => {
    it('detects success via payload param (Discourse uses payload not code)', () => {
      _testOnly.activeOAuthFlows.set('discourse', {
        openedAt: Date.now() - 2000,
        connectorName: 'Discourse',
        connectorType: 'bundled',
        callbackMethod: 'deep_link',
      });

      trackDeepLinkCallback('mindstone://discourse/callback?payload=encrypted_data');

      expect(mockTrackMainEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'Connector OAuth Callback Received',
          properties: expect.objectContaining({
            connectorName: 'Discourse',
            success: true,
          }),
        })
      );
    });
  });
});
