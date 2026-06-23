import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentTurnRegistry } from '../agentTurnRegistry';
import type { AgentEvent, TurnFallback } from '@shared/types';

describe('agentTurnRegistry per-turn usage tracking', () => {
  const turnId = 'test-turn-123';

  beforeEach(() => {
    agentTurnRegistry.clearUserQuestionPending(turnId);
    agentTurnRegistry.clearUserQuestionProvenance(turnId);
    agentTurnRegistry.cleanupTurn(turnId);
  });

  describe('thinkingEffort', () => {
    it('should store and retrieve thinking effort', () => {
      agentTurnRegistry.setTurnThinkingEffort(turnId, 'high');
      expect(agentTurnRegistry.getTurnThinkingEffort(turnId)).toBe('high');
    });

    it('should return undefined for unknown turn', () => {
      expect(agentTurnRegistry.getTurnThinkingEffort('unknown')).toBeUndefined();
    });

    it('should overwrite on re-set', () => {
      agentTurnRegistry.setTurnThinkingEffort(turnId, 'high');
      agentTurnRegistry.setTurnThinkingEffort(turnId, 'low');
      expect(agentTurnRegistry.getTurnThinkingEffort(turnId)).toBe('low');
    });
  });

  describe('authMethod', () => {
    it('should store and retrieve auth method', () => {
      agentTurnRegistry.setTurnAuthMethod(turnId, 'oauth-token');
      expect(agentTurnRegistry.getTurnAuthMethod(turnId)).toBe('oauth-token');
    });

    it('should return undefined for unknown turn', () => {
      expect(agentTurnRegistry.getTurnAuthMethod('unknown')).toBeUndefined();
    });

    it('should allow updating auth method (fallback scenario)', () => {
      agentTurnRegistry.setTurnAuthMethod(turnId, 'oauth-token');
      agentTurnRegistry.setTurnAuthMethod(turnId, 'api-key');
      expect(agentTurnRegistry.getTurnAuthMethod(turnId)).toBe('api-key');
    });
  });

  describe('fallbacks', () => {
    it('should return empty array for unknown turn', () => {
      expect(agentTurnRegistry.getTurnFallbacks('unknown')).toEqual([]);
    });

    it('should accumulate multiple fallbacks', () => {
      const fb1: TurnFallback = { type: 'auth', from: 'oauth-token', to: 'api-key', reason: 'rate-limit' };
      const fb2: TurnFallback = { type: 'model', from: 'claude-opus-4-7', to: 'claude-opus-4-5', reason: 'model-unavailable' };

      agentTurnRegistry.addTurnFallback(turnId, fb1);
      agentTurnRegistry.addTurnFallback(turnId, fb2);

      const result = agentTurnRegistry.getTurnFallbacks(turnId);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(fb1);
      expect(result[1]).toEqual(fb2);
    });

    it('should handle context fallback', () => {
      const fb: TurnFallback = { type: 'context', from: '1M', to: '200K', reason: 'extended-context-unavailable' };
      agentTurnRegistry.addTurnFallback(turnId, fb);
      expect(agentTurnRegistry.getTurnFallbacks(turnId)).toEqual([fb]);
    });
  });

  describe('cleanupTurn', () => {
    it('should clear all per-turn usage data', () => {
      agentTurnRegistry.setTurnThinkingEffort(turnId, 'high');
      agentTurnRegistry.setTurnAuthMethod(turnId, 'api-key');
      agentTurnRegistry.addTurnFallback(turnId, { type: 'auth', from: 'oauth-token', to: 'api-key', reason: 'rate-limit' });

      agentTurnRegistry.cleanupTurn(turnId);

      expect(agentTurnRegistry.getTurnThinkingEffort(turnId)).toBeUndefined();
      expect(agentTurnRegistry.getTurnAuthMethod(turnId)).toBeUndefined();
      expect(agentTurnRegistry.getTurnFallbacks(turnId)).toEqual([]);
    });
  });

  describe('hasInteractiveTurn', () => {
    it('should return false when no turns are active', () => {
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(false);
    });

    it('should return false when only automation category turns are active', () => {
      agentTurnRegistry.setTurnCategory(turnId, 'automation' as any);
      agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(false);
    });

    it('should return true when a conversation category turn is active', () => {
      agentTurnRegistry.setTurnCategory(turnId, 'conversation' as any);
      agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(true);
    });

    it('should return false after conversation turn is cleaned up', () => {
      agentTurnRegistry.setTurnCategory(turnId, 'conversation' as any);
      agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(true);

      agentTurnRegistry.cleanupTurn(turnId);
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(false);
    });

    it('should return false when conversation category exists but no controller (stale entry)', () => {
      agentTurnRegistry.setTurnCategory(turnId, 'conversation' as any);
      // No controller set — simulates a stale category entry
      expect(agentTurnRegistry.hasInteractiveTurn()).toBe(false);
    });
  });

  describe('upstreamActivity', () => {
    it('should store a timestamp via markUpstreamActivity', () => {
      const before = Date.now();
      agentTurnRegistry.markUpstreamActivity(turnId);
      const after = Date.now();
      const ts = agentTurnRegistry.getUpstreamActivity(turnId);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('should return undefined for unknown turns', () => {
      expect(agentTurnRegistry.getUpstreamActivity('unknown-turn')).toBeUndefined();
    });

    it('should be cleared by cleanupTurn', () => {
      agentTurnRegistry.markUpstreamActivity(turnId);
      expect(agentTurnRegistry.getUpstreamActivity(turnId)).toBeDefined();
      agentTurnRegistry.cleanupTurn(turnId);
      expect(agentTurnRegistry.getUpstreamActivity(turnId)).toBeUndefined();
    });

    it('should be cleared by cleanupForRetry', () => {
      agentTurnRegistry.markUpstreamActivity(turnId);
      expect(agentTurnRegistry.getUpstreamActivity(turnId)).toBeDefined();
      agentTurnRegistry.cleanupForRetry(turnId);
      expect(agentTurnRegistry.getUpstreamActivity(turnId)).toBeUndefined();
    });
  });

  describe('turn progress timestamps', () => {
    it('tracks per-turn lastProgressAt across message/tool/upstream progress signals', () => {
      vi.useFakeTimers();
      try {
        const turnA = 'progress-turn-a';
        const turnB = 'progress-turn-b';
        agentTurnRegistry.cleanupTurn(turnA);
        agentTurnRegistry.cleanupTurn(turnB);
        agentTurnRegistry.setActiveTurnController(turnA, new AbortController());
        agentTurnRegistry.setActiveTurnController(turnB, new AbortController());

        expect(agentTurnRegistry.getLastProgressAt(turnA)).toBeNull();
        expect(agentTurnRegistry.getLastProgressAt(turnB)).toBeNull();
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([
          { turnId: turnA, lastProgressAt: null },
          { turnId: turnB, lastProgressAt: null },
        ]);

        vi.advanceTimersByTime(1_000);
        agentTurnRegistry.markTurnProgress(turnA); // e.g. assistant/message event
        const turnAFirstProgress = agentTurnRegistry.getLastProgressAt(turnA);
        expect(turnAFirstProgress).toBeTypeOf('number');
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([
          { turnId: turnA, lastProgressAt: turnAFirstProgress },
          { turnId: turnB, lastProgressAt: null },
        ]);

        vi.advanceTimersByTime(1_000);
        agentTurnRegistry.recordToolCall(turnB, 'Read', { filePath: '/tmp/a.txt' });
        const turnBToolProgress = agentTurnRegistry.getLastProgressAt(turnB);
        expect(turnBToolProgress).toBeTypeOf('number');
        expect(turnBToolProgress).toBeGreaterThan(turnAFirstProgress as number);
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([
          { turnId: turnA, lastProgressAt: turnAFirstProgress },
          { turnId: turnB, lastProgressAt: turnBToolProgress },
        ]);

        vi.advanceTimersByTime(1_000);
        agentTurnRegistry.markUpstreamActivity(turnA);
        const turnAUpstreamProgress = agentTurnRegistry.getLastProgressAt(turnA);
        expect(turnAUpstreamProgress).toBeTypeOf('number');
        expect(turnAUpstreamProgress).toBeGreaterThan(turnAFirstProgress as number);
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([
          { turnId: turnA, lastProgressAt: turnAUpstreamProgress },
          { turnId: turnB, lastProgressAt: turnBToolProgress },
        ]);

        agentTurnRegistry.cleanupTurn(turnB);
        expect(agentTurnRegistry.getLastProgressAt(turnB)).toBeNull();
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([
          { turnId: turnA, lastProgressAt: turnAUpstreamProgress },
        ]);

        agentTurnRegistry.cleanupTurn(turnA);
        expect(agentTurnRegistry.getLastProgressAt(turnA)).toBeNull();
        expect(agentTurnRegistry.getActiveTurnProgressSnapshot()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears lastProgressAt on cleanupForRetry', () => {
      const retryTurnId = 'progress-retry-turn';
      agentTurnRegistry.cleanupTurn(retryTurnId);
      agentTurnRegistry.markTurnProgress(retryTurnId);
      expect(agentTurnRegistry.getLastProgressAt(retryTurnId)).toBeTypeOf('number');
      agentTurnRegistry.cleanupForRetry(retryTurnId);
      expect(agentTurnRegistry.getLastProgressAt(retryTurnId)).toBeNull();
    });
  });

  describe('cleanupForRetry', () => {
    it('should clear thinkingEffort and authMethod but preserve fallbacks', () => {
      agentTurnRegistry.setTurnThinkingEffort(turnId, 'high');
      agentTurnRegistry.setTurnAuthMethod(turnId, 'oauth-token');
      const fb: TurnFallback = { type: 'auth', from: 'oauth-token', to: 'api-key', reason: 'rate-limit' };
      agentTurnRegistry.addTurnFallback(turnId, fb);

      agentTurnRegistry.cleanupForRetry(turnId);

      expect(agentTurnRegistry.getTurnThinkingEffort(turnId)).toBeUndefined();
      expect(agentTurnRegistry.getTurnAuthMethod(turnId)).toBeUndefined();
      expect(agentTurnRegistry.getTurnFallbacks(turnId)).toEqual([fb]);
    });
  });

  describe('userQuestionProvenance', () => {
    const event: Extract<AgentEvent, { type: 'user_question' }> = {
      type: 'user_question',
      batchId: 'batch-123',
      toolUseId: 'tool-123',
      questions: [{
        id: 'q0',
        question: 'Which one?',
        header: 'Choose',
        options: [{ id: 'q0-opt0', label: 'A', description: 'Option A' }],
        multiSelect: false,
      }],
      sessionId: 'session-123',
      timestamp: 1,
    };

    it('stores and retrieves user question provenance by turn and batch', () => {
      agentTurnRegistry.recordUserQuestionProvenance(turnId, event);

      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'batch-123')).toEqual(event);
      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'missing')).toBeUndefined();
    });

    it('preserves provenance through cleanupTurn while the user question is pending', () => {
      agentTurnRegistry.recordUserQuestionProvenance(turnId, event);
      agentTurnRegistry.markUserQuestionPending(turnId);

      agentTurnRegistry.cleanupTurn(turnId);

      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'batch-123')).toEqual(event);
      expect(agentTurnRegistry.hasUserQuestionPending(turnId)).toBe(true);
    });

    it('preserves provenance through cleanupForRetry while the user question is pending', () => {
      agentTurnRegistry.recordUserQuestionProvenance(turnId, event);
      agentTurnRegistry.markUserQuestionPending(turnId);

      agentTurnRegistry.cleanupForRetry(turnId);

      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'batch-123')).toEqual(event);
      expect(agentTurnRegistry.hasUserQuestionPending(turnId)).toBe(true);
    });

    it('clears provenance through cleanupForRetry when no user question is pending', () => {
      agentTurnRegistry.recordUserQuestionProvenance(turnId, event);

      agentTurnRegistry.cleanupForRetry(turnId);

      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'batch-123')).toBeUndefined();
      expect(agentTurnRegistry.hasUserQuestionPending(turnId)).toBe(false);
    });

    it('clears provenance explicitly after response processing', () => {
      agentTurnRegistry.recordUserQuestionProvenance(turnId, event);

      agentTurnRegistry.clearUserQuestionProvenance(turnId, 'batch-123');

      expect(agentTurnRegistry.getUserQuestionProvenance(turnId, 'batch-123')).toBeUndefined();
    });
  });

  describe('turnCloseCallbacks (FOX-2815 force-kill)', () => {
    it('should store and retrieve close callback', () => {
      const cb = () => {};
      agentTurnRegistry.setTurnCloseCallback(turnId, cb);
      expect(agentTurnRegistry.getTurnCloseCallback(turnId)).toBe(cb);
    });

    it('should return undefined for unknown turn', () => {
      expect(agentTurnRegistry.getTurnCloseCallback('nonexistent')).toBeUndefined();
    });

    it('should overwrite close callback when fallback query replaces iterator', () => {
      const cb1 = () => {};
      const cb2 = () => {};
      agentTurnRegistry.setTurnCloseCallback(turnId, cb1);
      agentTurnRegistry.setTurnCloseCallback(turnId, cb2);
      expect(agentTurnRegistry.getTurnCloseCallback(turnId)).toBe(cb2);
    });

    it('should be cleaned up by cleanupTurn', () => {
      agentTurnRegistry.setTurnCloseCallback(turnId, () => {});
      agentTurnRegistry.cleanupTurn(turnId);
      expect(agentTurnRegistry.getTurnCloseCallback(turnId)).toBeUndefined();
    });

    it('should be cleaned up by cleanupForRetry', () => {
      agentTurnRegistry.setTurnCloseCallback(turnId, () => {});
      agentTurnRegistry.cleanupForRetry(turnId);
      expect(agentTurnRegistry.getTurnCloseCallback(turnId)).toBeUndefined();
    });
  });
});
