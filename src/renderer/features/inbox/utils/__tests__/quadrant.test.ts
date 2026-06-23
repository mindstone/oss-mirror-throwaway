import { describe, expect, it } from 'vitest';
import { 
  getQuadrant, 
  quadrantToFlags, 
  QUADRANT_META, 
  QUADRANT_ORDER,
  INBOX_ZERO_MESSAGES,
  getInboxZeroMessage
} from '../quadrant';
import type { InboxItem } from '@shared/types';

const createMockItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-id',
  title: 'Test Item',
  text: 'Test description',
  addedAt: Date.now(),
  priority: 'p2',
  ...overrides,
} as unknown as InboxItem);

describe('quadrant utilities', () => {
  describe('getQuadrant', () => {
    it('returns "do-now" for urgent=true, important=true', () => {
      const item = createMockItem({ urgent: true, important: true });
      expect(getQuadrant(item)).toBe('do-now');
    });

    it('returns "schedule" for urgent=false, important=true', () => {
      const item = createMockItem({ urgent: false, important: true });
      expect(getQuadrant(item)).toBe('schedule');
    });

    it('returns "delegate" for urgent=true, important=false', () => {
      const item = createMockItem({ urgent: true, important: false });
      expect(getQuadrant(item)).toBe('delegate');
    });

    it('returns "consider" for urgent=false, important=false', () => {
      const item = createMockItem({ urgent: false, important: false });
      expect(getQuadrant(item)).toBe('consider');
    });

    it('defaults urgent to false when undefined', () => {
      const item = createMockItem({ urgent: undefined, important: true });
      expect(getQuadrant(item)).toBe('schedule'); // not urgent, important
    });

    it('defaults important to true when undefined', () => {
      const item = createMockItem({ urgent: undefined, important: undefined });
      expect(getQuadrant(item)).toBe('schedule'); // not urgent, important (default)
    });

    it('handles item with only urgent set', () => {
      const item = createMockItem({ urgent: true });
      // important defaults to true, so urgent+important = do-now
      expect(getQuadrant(item)).toBe('do-now');
    });

    it('handles item with only important=false set', () => {
      const item = createMockItem({ important: false });
      // urgent defaults to false, so not urgent + not important = consider
      expect(getQuadrant(item)).toBe('consider');
    });
  });

  describe('quadrantToFlags', () => {
    it('returns correct flags for do-now', () => {
      expect(quadrantToFlags('do-now')).toEqual({ urgent: true, important: true });
    });

    it('returns correct flags for schedule', () => {
      expect(quadrantToFlags('schedule')).toEqual({ urgent: false, important: true });
    });

    it('returns correct flags for delegate', () => {
      expect(quadrantToFlags('delegate')).toEqual({ urgent: true, important: false });
    });

    it('returns correct flags for consider', () => {
      expect(quadrantToFlags('consider')).toEqual({ urgent: false, important: false });
    });
  });

  describe('getQuadrant and quadrantToFlags roundtrip', () => {
    it('roundtrips do-now correctly', () => {
      const flags = quadrantToFlags('do-now');
      const item = createMockItem(flags);
      expect(getQuadrant(item)).toBe('do-now');
    });

    it('roundtrips schedule correctly', () => {
      const flags = quadrantToFlags('schedule');
      const item = createMockItem(flags);
      expect(getQuadrant(item)).toBe('schedule');
    });

    it('roundtrips delegate correctly', () => {
      const flags = quadrantToFlags('delegate');
      const item = createMockItem(flags);
      expect(getQuadrant(item)).toBe('delegate');
    });

    it('roundtrips consider correctly', () => {
      const flags = quadrantToFlags('consider');
      const item = createMockItem(flags);
      expect(getQuadrant(item)).toBe('consider');
    });
  });

  describe('QUADRANT_META', () => {
    it('has metadata for all quadrants', () => {
      expect(QUADRANT_META['do-now']).toBeDefined();
      expect(QUADRANT_META['schedule']).toBeDefined();
      expect(QUADRANT_META['delegate']).toBeDefined();
      expect(QUADRANT_META['consider']).toBeDefined();
    });

    it('has required fields for each quadrant', () => {
      for (const quadrant of QUADRANT_ORDER) {
        const meta = QUADRANT_META[quadrant];
        expect(meta.label).toBeTruthy();
        expect(meta.shortLabel).toBeTruthy();
        expect(meta.icon).toBeTruthy();
        expect(meta.colorClass).toBeTruthy();
        expect(meta.accentColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(meta.bgTint).toBeTruthy();
        expect(meta.description).toBeTruthy();
        expect(meta.emptyMessage).toBeTruthy();
      }
    });

    it('has distinct accent colors for each quadrant', () => {
      const colors = QUADRANT_ORDER.map(q => QUADRANT_META[q].accentColor);
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(4);
    });

    it('has correct labels', () => {
      expect(QUADRANT_META['do-now'].label).toBe('Do Now');
      expect(QUADRANT_META['schedule'].label).toBe('Schedule');
      expect(QUADRANT_META['delegate'].label).toBe('Delegate');
      expect(QUADRANT_META['consider'].label).toBe('Consider');
    });

    it('uses Lucide icon names', () => {
      expect(QUADRANT_META['do-now'].icon).toBe('flame');
      expect(QUADRANT_META['schedule'].icon).toBe('calendar-clock');
      expect(QUADRANT_META['delegate'].icon).toBe('forward');
      expect(QUADRANT_META['consider'].icon).toBe('circle-dashed');
    });
  });

  describe('QUADRANT_ORDER', () => {
    it('contains all four quadrants', () => {
      expect(QUADRANT_ORDER).toHaveLength(4);
      expect(QUADRANT_ORDER).toContain('do-now');
      expect(QUADRANT_ORDER).toContain('schedule');
      expect(QUADRANT_ORDER).toContain('delegate');
      expect(QUADRANT_ORDER).toContain('consider');
    });

    it('is in correct display order (top-left, top-right, bottom-left, bottom-right)', () => {
      // Grid layout: do-now | schedule
      //              delegate | consider
      expect(QUADRANT_ORDER[0]).toBe('do-now');
      expect(QUADRANT_ORDER[1]).toBe('schedule');
      expect(QUADRANT_ORDER[2]).toBe('delegate');
      expect(QUADRANT_ORDER[3]).toBe('consider');
    });
  });

  describe('INBOX_ZERO_MESSAGES', () => {
    it('has multiple celebration messages', () => {
      expect(INBOX_ZERO_MESSAGES.length).toBeGreaterThan(1);
    });

    it('all messages are non-empty strings', () => {
      for (const message of INBOX_ZERO_MESSAGES) {
        expect(typeof message).toBe('string');
        expect(message.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('getInboxZeroMessage', () => {
    it('returns a string from INBOX_ZERO_MESSAGES', () => {
      const message = getInboxZeroMessage();
      expect(INBOX_ZERO_MESSAGES).toContain(message);
    });

    it('returns different messages over multiple calls (probabilistic)', () => {
      // Call multiple times and check we get at least 2 different messages
      const messages = new Set<string>();
      for (let i = 0; i < 20; i++) {
        messages.add(getInboxZeroMessage());
      }
      // With 5 messages and 20 calls, extremely likely to get at least 2 different ones
      expect(messages.size).toBeGreaterThanOrEqual(2);
    });
  });
});
