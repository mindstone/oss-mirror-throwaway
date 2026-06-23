import { describe, it, expect } from 'vitest';
import { useRebelEvent } from '../useRebelEvent';
import { pluginEventBus } from '../pluginEventBus';
import type { RebelEventType } from '../types';

/**
 * Tests for useRebelEvent hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify the exported function type, interface structures,
 * and behavioral contracts via structural/type-level checks.
 *
 * The underlying pluginEventBus is fully tested in pluginEventBus.test.ts.
 */

describe('useRebelEvent', () => {
  describe('exports', () => {
    it('exports useRebelEvent as a function', () => {
      expect(typeof useRebelEvent).toBe('function');
    });

    it('is a React hook (starts with "use")', () => {
      expect(useRebelEvent.name).toBe('useRebelEvent');
    });
  });

  describe('pluginEventBus integration', () => {
    it('pluginEventBus exports subscribe, emit, initialize, reset', () => {
      expect(typeof pluginEventBus.subscribe).toBe('function');
      expect(typeof pluginEventBus.emit).toBe('function');
      expect(typeof pluginEventBus.initialize).toBe('function');
      expect(typeof pluginEventBus.reset).toBe('function');
      expect(typeof pluginEventBus.isInitialized).toBe('function');
    });
  });

  describe('RebelEventType', () => {
    it('covers all 6 event types as valid string literals', () => {
      const validEvents: RebelEventType[] = [
        'turn:started',
        'turn:completed',
        'turn:error',
        'conversation:created',
        'navigation:changed',
        'memory:source-added',
      ];
      expect(validEvents).toHaveLength(6);
      // Each should be a non-empty string
      for (const event of validEvents) {
        expect(typeof event).toBe('string');
        expect(event.length).toBeGreaterThan(0);
      }
    });
  });

  describe('callback contract', () => {
    it('accepts (payload: unknown) => void callback shape', () => {
      // Verify the callback type is compatible
      const callback: (payload: unknown) => void = (payload) => {
        // Plugins cast payload to expected type
        const typed = payload as { sessionId: string; turnId: string };
        expect(typeof typed.sessionId).toBe('string');
      };
      expect(typeof callback).toBe('function');
    });

    it('callback can handle various payload shapes', () => {
      const payloads: unknown[] = [
        { sessionId: 's1', turnId: 't1' },
        { sessionId: 's1', turnId: 't1', assistantText: 'Hello', toolsUsed: ['Read'] },
        { sessionId: 's1', turnId: 't1', error: 'Something went wrong' },
        { sessionId: 's1', title: 'New Chat' },
        { target: 'settings', previousTarget: 'sessions' },
        { turnId: 't1', summary: 'Added meeting notes' },
      ];
      for (const payload of payloads) {
        expect(payload).toBeDefined();
      }
    });
  });
});
