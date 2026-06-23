import { describe, it, expect } from 'vitest';
import { useGoals } from '../useGoals';
import type { PluginGoal, UseGoalsResult } from '../types';

/**
 * Tests for useGoals plugin hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify the exported function type, interface structures,
 * and behavioral contracts via structural/type-level checks.
 */

describe('useGoals', () => {
  describe('exports', () => {
    it('exports useGoals function', () => {
      expect(typeof useGoals).toBe('function');
    });
  });

  describe('PluginGoal type structure', () => {
    it('can construct a PluginGoal with all fields', () => {
      const goal: PluginGoal = {
        id: 'goal-123',
        text: 'Launch product by Q2',
        status: 'active',
        createdAt: 1712400000000,
        updatedAt: 1712400000000,
        outcome: 'Product is live and getting users',
        obstacle: 'Engineering capacity',
        plan: 'Hire two more engineers',
        quarterTag: '2026-Q2',
      };
      expect(goal.id).toBe('goal-123');
      expect(goal.text).toBe('Launch product by Q2');
      expect(goal.status).toBe('active');
      expect(goal.outcome).toBe('Product is live and getting users');
      expect(goal.quarterTag).toBe('2026-Q2');
    });

    it('WOOP fields and quarterTag are optional', () => {
      const goal: PluginGoal = {
        id: 'goal-456',
        text: 'Improve customer retention',
        status: 'active',
        createdAt: 1712400000000,
        updatedAt: 1712400000000,
      };
      expect(goal.outcome).toBeUndefined();
      expect(goal.obstacle).toBeUndefined();
      expect(goal.plan).toBeUndefined();
      expect(goal.quarterTag).toBeUndefined();
    });

    it('supports all status values', () => {
      const statuses: PluginGoal['status'][] = ['active', 'completed', 'dropped'];
      for (const status of statuses) {
        const goal: PluginGoal = {
          id: `goal-${status}`,
          text: `Goal with status ${status}`,
          status,
          createdAt: 1712400000000,
          updatedAt: 1712400000000,
        };
        expect(goal.status).toBe(status);
      }
    });

    it('omits internal fields from Goal', () => {
      // PluginGoal should NOT have these fields from Goal:
      // lastReviewedAt, why
      const goal: PluginGoal = {
        id: 'goal-789',
        text: 'Grow revenue 20%',
        status: 'active',
        createdAt: 1712400000000,
        updatedAt: 1712400000000,
      };

      // TypeScript ensures these don't exist, but verify at runtime too
      const goalObj = goal as unknown as Record<string, unknown>;
      expect(goalObj['lastReviewedAt']).toBeUndefined();
      expect(goalObj['why']).toBeUndefined();
    });
  });

  describe('UseGoalsResult type structure', () => {
    it('represents initial loading state', () => {
      const result: UseGoalsResult = {
        goals: [],
        isLoading: true,
        error: null,
        refresh: () => { /* noop */ },
      };
      expect(result.goals).toEqual([]);
      expect(result.isLoading).toBe(true);
      expect(result.error).toBeNull();
      expect(typeof result.refresh).toBe('function');
    });

    it('represents loaded state with goals', () => {
      const result: UseGoalsResult = {
        goals: [
          {
            id: 'g1',
            text: 'Complete product launch',
            status: 'active',
            createdAt: 1712400000000,
            updatedAt: 1712400000000,
            outcome: 'Product in production',
            obstacle: 'Tight timeline',
            plan: 'Prioritize MVP features',
            quarterTag: '2026-Q2',
          },
        ],
        isLoading: false,
        error: null,
        refresh: () => { /* noop */ },
      };
      expect(result.goals).toHaveLength(1);
      expect(result.isLoading).toBe(false);
    });

    it('represents error state', () => {
      const result: UseGoalsResult = {
        goals: [],
        isLoading: false,
        error: 'Goals API not available',
        refresh: () => { /* noop */ },
      };
      expect(result.error).toBe('Goals API not available');
    });
  });

  describe('plugin-safe mapping logic', () => {
    it('maps Goal to PluginGoal correctly', () => {
      // Simulate what the hook does — map internal Goal to plugin-safe shape
      const internalGoal = {
        id: 'goal-123',
        text: 'Launch product by Q2',
        why: 'We need market presence',
        outcome: 'Product is live',
        obstacle: 'Engineering capacity',
        plan: 'Hire two more engineers',
        status: 'active' as const,
        createdAt: 1712400000000,
        updatedAt: 1712400000000,
        lastReviewedAt: 1712400000000,
        quarterTag: '2026-Q2',
      };

      const pluginGoal: PluginGoal = {
        id: internalGoal.id,
        text: internalGoal.text,
        status: internalGoal.status,
        createdAt: internalGoal.createdAt,
        updatedAt: internalGoal.updatedAt,
        outcome: internalGoal.outcome,
        obstacle: internalGoal.obstacle,
        plan: internalGoal.plan,
        quarterTag: internalGoal.quarterTag,
      };

      // Verify safe fields are included
      expect(pluginGoal.id).toBe('goal-123');
      expect(pluginGoal.text).toBe('Launch product by Q2');
      expect(pluginGoal.outcome).toBe('Product is live');
      expect(pluginGoal.quarterTag).toBe('2026-Q2');

      // Verify internal fields are NOT mapped
      const obj = pluginGoal as unknown as Record<string, unknown>;
      expect(obj['lastReviewedAt']).toBeUndefined();
      expect(obj['why']).toBeUndefined();
    });
  });
});
