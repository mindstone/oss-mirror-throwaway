import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSettings,
  buildSession,
  resetSessionCounter,
  buildAgentEvent,
  buildStatusEvent,
  buildAssistantEvent,
  buildResultEvent,
  buildToolEvent,
  buildErrorEvent,
} from '../index';

describe('Test Data Builders', () => {
  describe('buildSettings', () => {
    it('returns a valid AppSettings object with all required fields', () => {
      const settings = buildSettings();

      // Required fields exist
      expect(settings).toHaveProperty('coreDirectory');
      expect(settings).toHaveProperty('mcpConfigFile');
      expect(settings).toHaveProperty('onboardingCompleted');
      expect(settings).toHaveProperty('userEmail');
      expect(settings).toHaveProperty('onboardingFirstCompletedAt');
      expect(settings).toHaveProperty('voice');
      expect(settings).toHaveProperty('claude');
      expect(settings).toHaveProperty('diagnostics');

      // Nested objects are populated
      expect(settings.voice).toHaveProperty('provider');
      expect(settings.claude).toHaveProperty('model');
      expect(settings.claude).toHaveProperty('authMethod');
      expect(settings.diagnostics).toHaveProperty('debugBreadcrumbsUntil');
    });

    it('applies overrides via shallow merge', () => {
      const settings = buildSettings({
        onboardingCompleted: true,
        userEmail: 'test@example.com',
      });

      expect(settings.onboardingCompleted).toBe(true);
      expect(settings.userEmail).toBe('test@example.com');
      // Other defaults preserved
      expect(settings.theme).toBe('dark');
    });

    it('replaces nested objects entirely when overridden', () => {
      const customClaude = {
        apiKey: 'test-key',
        oauthToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        authMethod: 'api-key' as const,
        model: 'claude-sonnet-4-5',
        permissionMode: 'bypassPermissions' as const,
        executablePath: null,
        planMode: true,
        extendedContext: false,
        thinkingEffort: 'medium' as const,
      };
      const settings = buildSettings({ claude: customClaude });

      expect(settings.models.model).toBe('claude-sonnet-4-5');
      expect(settings.models.planMode).toBe(true);
    });

    it('returns independent instances (no shared references)', () => {
      const a = buildSettings();
      const b = buildSettings();
      a.onboardingCompleted = true;
      expect(b.onboardingCompleted).toBe(false);
    });
  });

  describe('buildSession', () => {
    beforeEach(() => {
      resetSessionCounter();
    });

    it('returns a valid AgentSession with all required fields', () => {
      const session = buildSession();

      expect(session.id).toBeDefined();
      expect(session.title).toBe('Test Session');
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThan(0);
      expect(session.messages).toEqual([]);
      expect(session.eventsByTurn).toEqual({});
      expect(session.activeTurnId).toBeNull();
      expect(session.isBusy).toBe(false);
      expect(session.lastError).toBeNull();
      expect(session.resolvedAt).toBeNull();
    });

    it('generates unique IDs across calls', () => {
      const a = buildSession();
      const b = buildSession();
      expect(a.id).not.toBe(b.id);
    });

    it('applies overrides', () => {
      const session = buildSession({
        title: 'Custom Title',
        isBusy: true,
        origin: 'automation',
      });

      expect(session.title).toBe('Custom Title');
      expect(session.isBusy).toBe(true);
      expect(session.origin).toBe('automation');
    });

    it('allows overriding the id', () => {
      const session = buildSession({ id: 'fixed-id' });
      expect(session.id).toBe('fixed-id');
    });

    it('resetSessionCounter resets the counter', () => {
      const first = buildSession();
      resetSessionCounter();
      const afterReset = buildSession();
      // Both should have counter = 1
      expect(first.id).toBe(afterReset.id);
    });
  });

  describe('buildAgentEvent', () => {
    it('defaults to a status event', () => {
      const event = buildAgentEvent();
      expect(event.type).toBe('status');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('builds different event types via type override', () => {
      expect(buildAgentEvent({ type: 'status' }).type).toBe('status');
      expect(buildAgentEvent({ type: 'assistant' }).type).toBe('assistant');
      expect(buildAgentEvent({ type: 'result' }).type).toBe('result');
      expect(buildAgentEvent({ type: 'tool' }).type).toBe('tool');
      expect(buildAgentEvent({ type: 'error' }).type).toBe('error');
    });
  });

  describe('buildStatusEvent', () => {
    it('returns a valid status event', () => {
      const event = buildStatusEvent();
      expect(event.type).toBe('status');
      expect(event.message).toBe('Processing');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('applies overrides', () => {
      const event = buildStatusEvent({ message: 'Loading workspace' });
      expect(event.message).toBe('Loading workspace');
    });
  });

  describe('buildAssistantEvent', () => {
    it('returns a valid assistant event', () => {
      const event = buildAssistantEvent();
      expect(event.type).toBe('assistant');
      expect(event.text).toBe('Test assistant response');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('applies overrides', () => {
      const event = buildAssistantEvent({ text: 'Custom response' });
      expect(event.text).toBe('Custom response');
    });
  });

  describe('buildResultEvent', () => {
    it('returns a valid result event', () => {
      const event = buildResultEvent();
      expect(event.type).toBe('result');
      expect(event.text).toBe('Test result');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('applies overrides including optional fields', () => {
      const event = buildResultEvent({
        model: 'claude-opus-4-7',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      });
      expect(event.model).toBe('claude-opus-4-7');
      expect(event.usage?.inputTokens).toBe(100);
    });
  });

  describe('buildToolEvent', () => {
    it('returns a valid tool event', () => {
      const event = buildToolEvent();
      expect(event.type).toBe('tool');
      expect(event.toolName).toBe('test_tool');
      expect(event.detail).toBe('Test tool detail');
      expect(event.stage).toBe('start');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('applies overrides', () => {
      const event = buildToolEvent({
        toolName: 'read_file',
        stage: 'end',
        isError: true,
      });
      expect(event.toolName).toBe('read_file');
      expect(event.stage).toBe('end');
      expect(event.isError).toBe(true);
    });
  });

  describe('buildErrorEvent', () => {
    it('returns a valid error event', () => {
      const event = buildErrorEvent();
      expect(event.type).toBe('error');
      expect(event.error).toBe('Test error');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('applies overrides including optional fields', () => {
      const event = buildErrorEvent({
        error: 'Rate limited',
        isTransient: true,
        errorKind: 'rate_limit',
      });
      expect(event.error).toBe('Rate limited');
      expect(event.isTransient).toBe(true);
      expect(event.errorKind).toBe('rate_limit');
    });
  });
});
