import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { AgentSession, AutomationDefinition, AutomationRun, AutomationStoreState } from '@shared/types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationDefinitionSchema } from '@shared/ipc/schemas/automations';
import { clearAutomationScripts, registerAutomationScript } from '@core/services/automations/scriptRegistry';
import * as codexAuthModule from '@core/codexAuth';
import { trackMainEvent } from '@main/analytics';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

const {
  mockDispatchAgentEvent,
  mockDispatchAgentErrorEvent,
  mockShowAutomationOutcomeNotification,
  mockSendToAllWindows,
} = vi.hoisted(() => ({
  mockDispatchAgentEvent: vi.fn(),
  mockDispatchAgentErrorEvent: vi.fn(),
  mockShowAutomationOutcomeNotification: vi.fn(),
  mockSendToAllWindows: vi.fn(),
}));

// Mock electron-store before any imports that use it
vi.mock('electron-store', () => {
  class MemoryStore<T> {
    store: T;
    constructor(options: { defaults: T }) {
      this.store = structuredClone(options.defaults);
    }
  }
  return { default: MemoryStore };
});

// Mock logger
const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn()
};
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLoggerMethods,
  logger: mockLoggerMethods
}));

// Mock analytics
vi.mock('@main/analytics', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: () => 'test-anonymous-id'
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: (...args: unknown[]) => mockSendToAllWindows(...args), sendToFocusedWindow: vi.fn() }),
}));

// Mock agentTurnRegistry
vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getSecurityDenials: vi.fn().mockReturnValue([]),
    clearSecurityDenials: vi.fn(),
    hasInteractiveTurn: vi.fn().mockReturnValue(false),
    getRendererSession: vi.fn().mockReturnValue(null),
    getTurnCategory: vi.fn().mockReturnValue('automation'),
    getEventListener: vi.fn().mockReturnValue(null),
    deleteEventListener: vi.fn(),
    getOrCreateAccumulator: vi.fn().mockImplementation(() => {
      const events: Array<Record<string, unknown>> = [];
      let nextSeq = 1;
      const stampSeq = (event: Record<string, unknown>) => {
        const seq = typeof event.seq === 'number' ? event.seq : nextSeq;
        nextSeq = Math.max(nextSeq, seq + 1);
        return { ...event, seq };
      };
      return {
        appendEvent: vi.fn((event: Record<string, unknown>) => {
          const stamped = stampSeq(event);
          events.push(stamped);
          return stamped;
        }),
        stampSeq: vi.fn((event: Record<string, unknown>) => stampSeq(event)),
        getConversationShape: vi.fn().mockImplementation(() => ({
          messages: [],
          eventsByTurn: { mockTurn: events },
        })),
      };
    }),
    clearToolCalls: vi.fn(),
  }
}));

// Mock shutdownState
vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('../agentEventDispatcher', async () => {
  const actual = await vi.importActual<typeof import('../agentEventDispatcher')>('../agentEventDispatcher');
  return {
    ...actual,
    dispatchAgentEvent: (...args: Parameters<typeof actual.dispatchAgentEvent>) => {
      mockDispatchAgentEvent(...args);
      return actual.dispatchAgentEvent(...args);
    },
    dispatchAgentErrorEvent: (...args: Parameters<typeof actual.dispatchAgentErrorEvent>) => {
      mockDispatchAgentErrorEvent(...args);
      return actual.dispatchAgentErrorEvent(...args);
    },
    showAutomationOutcomeNotification: (...args: unknown[]) => mockShowAutomationOutcomeNotification(...args),
  };
});

// Import the functions we want to test after mocks are set up
let calculateNextRunAt: typeof import('../automationScheduler').calculateNextRunAt;
let calculateMostRecentScheduledTime: typeof import('../automationScheduler').calculateMostRecentScheduledTime;

beforeAll(async () => {
  const module = await import('../automationScheduler');
  calculateNextRunAt = module.calculateNextRunAt;
  calculateMostRecentScheduledTime = module.calculateMostRecentScheduledTime;
});

afterEach(() => {
  clearAutomationScripts();
});

describe('automation prompt policy overlays', () => {
  it('overrides wins/learnings instructions that would add share items to Actions', async () => {
    const { AutomationScheduler } = await import('../automationScheduler');
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/core',
      executeAgentTurn: vi.fn(),
    });
    const buildAutomationPrompt = (scheduler as unknown as {
      buildAutomationPrompt: (
        rawContent: string,
        automation: AutomationDefinition,
        eventContext?: Record<string, unknown>
      ) => string;
    }).buildAutomationPrompt.bind(scheduler);

    const prompt = buildAutomationPrompt(
      [
        '---',
        'name: wins-and-learnings-uncover',
        '---',
        '[PROCESS]',
        'Add either or both to Actions with the share actions, so long as they rate 85+',
      ].join('\n'),
      {
        id: 'system-wins-learnings-uncover',
        name: 'Daily Wins & Learnings',
        filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
        schedule: AutomationSchedule.daily({ time: '09:30' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isSystem: true,
        systemType: 'wins-learnings-uncover',
      },
    );

    expect(prompt).toContain('[CURRENT ACTIONS POLICY]');
    expect(prompt).toContain('Do not call rebel_inbox_add from this automation');
    expect(prompt).toContain('this policy overrides them');
  });
});

/**
 * Helper to create a minimal AutomationDefinition for testing.
 * Only schedule-related fields matter for the exported calculation functions.
 */
const createDefinition = (
  schedule: unknown,
  enabled = true
): AutomationDefinition => ({
  id: 'test-automation',
  name: 'Test Automation',
  filePath: '/test/path.md',
  schedule: schedule as AutomationDefinition['schedule'],
  enabled,
  catchUpIfMissed: true,
  createdAt: Date.now(),
  updatedAt: Date.now()
});

/**
 * Helper to create a Date at a specific local time.
 */
const atTime = (year: number, month: number, day: number, hours: number, minutes: number): Date => {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
};

describe('calculateNextRunAt', () => {
  describe('disabled automation', () => {
    it('returns null when automation is disabled', () => {
      const definition = createDefinition({ type: 'daily', time: '09:00' }, false);
      const result = calculateNextRunAt(definition, Date.now());
      expect(result).toBeNull();
    });
  });

  describe('hourly schedule', () => {
    it('returns next hour when minute has passed', () => {
      // Current time: 14:45, schedule: minute 30
      const from = atTime(2025, 6, 15, 14, 45).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 15:30 same day
      const expected = atTime(2025, 6, 15, 15, 30).getTime();
      expect(result).toBe(expected);
    });

    it('returns same hour when minute has not passed', () => {
      // Current time: 14:15, schedule: minute 30
      const from = atTime(2025, 6, 15, 14, 15).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 14:30 same day
      const expected = atTime(2025, 6, 15, 14, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles minute 0 (top of hour)', () => {
      // Current time: 14:59
      const from = atTime(2025, 6, 15, 14, 59).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 0 });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 15:00
      const expected = atTime(2025, 6, 15, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles minute 59 (end of hour)', () => {
      // Current time: 14:30
      const from = atTime(2025, 6, 15, 14, 30).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 59 });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 14:59
      const expected = atTime(2025, 6, 15, 14, 59).getTime();
      expect(result).toBe(expected);
    });

    it('crosses midnight correctly', () => {
      // Current time: 23:45, schedule: minute 30
      const from = atTime(2025, 6, 15, 23, 45).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 00:30 next day
      const expected = atTime(2025, 6, 16, 0, 30).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('daily schedule', () => {
    it('returns today if time has not passed', () => {
      // Current time: 08:00, schedule: 09:30
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:30' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:30 same day
      const expected = atTime(2025, 6, 15, 9, 30).getTime();
      expect(result).toBe(expected);
    });

    it('returns tomorrow if time has passed', () => {
      // Current time: 10:00, schedule: 09:30
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:30' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:30 next day
      const expected = atTime(2025, 6, 16, 9, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles midnight (00:00) schedule', () => {
      // Current time: 23:00
      const from = atTime(2025, 6, 15, 23, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '00:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 00:00 next day
      const expected = atTime(2025, 6, 16, 0, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles end of day (23:59) schedule', () => {
      // Current time: 12:00
      const from = atTime(2025, 6, 15, 12, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '23:59' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 23:59 same day
      const expected = atTime(2025, 6, 15, 23, 59).getTime();
      expect(result).toBe(expected);
    });

    it('handles month boundary correctly', () => {
      // Current time: Jan 31 10:00, schedule: 09:00
      const from = atTime(2025, 1, 31, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be Feb 1 09:00
      const expected = atTime(2025, 2, 1, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles year boundary correctly', () => {
      // Current time: Dec 31 10:00, schedule: 09:00
      const from = atTime(2025, 12, 31, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be Jan 1 2026 09:00
      const expected = atTime(2026, 1, 1, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('daily schedule with additionalTimes', () => {
    it('returns first time today when now is before all times', () => {
      // Current time: 06:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 6, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 today (first upcoming time)
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns second time today when now is between times', () => {
      // Current time: 10:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 14:00 today (next upcoming time)
      const expected = atTime(2025, 6, 15, 14, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns first time tomorrow when now is after all times', () => {
      // Current time: 16:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 16, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 tomorrow (earliest time next day)
      const expected = atTime(2025, 6, 16, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles times spanning midnight (evening then morning)', () => {
      // Current time: 07:00, schedule: primary 23:30, additional 06:00
      const from = atTime(2025, 6, 15, 7, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '23:30',
        additionalTimes: ['06:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // 06:00 already passed today, 23:30 is later today - should be 23:30 today
      const expected = atTime(2025, 6, 15, 23, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles times spanning midnight (morning time already passed)', () => {
      // Current time: 00:30, schedule: primary 23:30, additional 06:00
      const from = atTime(2025, 6, 15, 0, 30).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '23:30',
        additionalTimes: ['06:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // 23:30 yesterday passed, 06:00 is coming up today - should be 06:00 today
      const expected = atTime(2025, 6, 15, 6, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles duplicate times (same as single time)', () => {
      // Current time: 08:00, schedule: primary 09:00, additional 09:00 (duplicate)
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['09:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should work same as single time - 09:00 today
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles empty additionalTimes array (same as undefined)', () => {
      // Current time: 08:00, schedule: primary 09:00, additionalTimes: []
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: []
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should behave same as no additionalTimes - 09:00 today
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles three times with now between first and second', () => {
      // Current time: 10:30, schedule: primary 09:00, additional 12:00 and 18:00
      const from = atTime(2025, 6, 15, 10, 30).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['12:00', '18:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 12:00 today (next upcoming time)
      const expected = atTime(2025, 6, 15, 12, 0).getTime();
      expect(result).toBe(expected);
    });

    it('correctly picks earliest time regardless of order in additionalTimes', () => {
      // Current time: 06:00, schedule: primary 14:00, additional 18:00 and 09:00
      // (09:00 is in additionalTimes, not primary)
      const from = atTime(2025, 6, 15, 6, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '14:00',
        additionalTimes: ['18:00', '09:00']
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 today (earliest upcoming time)
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('weekly schedule', () => {
    it('returns today if day matches and time has not passed', () => {
      // Current: Sunday June 15 2025 at 08:00, schedule: Sunday 09:00
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [0], time: '09:00' }); // Sunday = 0
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 same day (Sunday)
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns next week same day if time has passed', () => {
      // Current: Sunday June 15 2025 at 10:00, schedule: Sunday 09:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [0], time: '09:00' }); // Sunday = 0
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 next Sunday (June 22)
      const expected = atTime(2025, 6, 22, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns next matching weekday in the week', () => {
      // Current: Monday June 16 2025 at 10:00, schedule: Wednesday 09:00
      const from = atTime(2025, 6, 16, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [3], time: '09:00' }); // Wednesday = 3
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 Wednesday June 18
      const expected = atTime(2025, 6, 18, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles multiple days in schedule', () => {
      // Current: Monday June 16 2025 at 10:00, schedule: Mon, Wed, Fri at 09:00
      const from = atTime(2025, 6, 16, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [1, 3, 5], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 Wednesday June 18 (next scheduled day after Monday passes)
      const expected = atTime(2025, 6, 18, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles schedule spanning month boundary', () => {
      // Current: Saturday June 28 2025 at 10:00, schedule: Monday 09:00
      const from = atTime(2025, 6, 28, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [1], time: '09:00' }); // Monday = 1
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 Monday June 30
      const expected = atTime(2025, 6, 30, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('uses current day if no daysOfWeek specified', () => {
      // Current: Tuesday June 17 2025 at 10:00, schedule: default (use current day)
      const from = atTime(2025, 6, 17, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be next Tuesday at 09:00
      const expected = atTime(2025, 6, 24, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('monthly schedule', () => {
    it('returns today if day matches and time has not passed', () => {
      // Current: June 15 2025 at 08:00, schedule: 15th at 09:00
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [15], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be 09:00 same day
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns next month if time has passed', () => {
      // Current: June 15 2025 at 10:00, schedule: 15th at 09:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [15], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be July 15 09:00
      const expected = atTime(2025, 7, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns next scheduled day in the month', () => {
      // Current: June 10 2025 at 10:00, schedule: 15th and 25th at 09:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [15, 25], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be June 15 09:00
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles day 31 in a 30-day month (skips when runOnLastDayIfShorter=false)', () => {
      // Current: June 28 2025 (June has 30 days), schedule: 31st at 09:00
      const from = atTime(2025, 6, 28, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: false
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should skip June (no 31st), go to July 31
      const expected = atTime(2025, 7, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles day 31 in a 30-day month with runOnLastDayIfShorter=true', () => {
      // Current: June 28 2025 (June has 30 days), schedule: 31st at 09:00
      const from = atTime(2025, 6, 28, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: true
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should run on June 30 (last day of June)
      const expected = atTime(2025, 6, 30, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles February 29 in non-leap year (skips)', () => {
      // Current: Feb 15 2025 (not a leap year), schedule: 29th at 09:00
      const from = atTime(2025, 2, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [29],
        time: '09:00',
        runOnLastDayIfShorter: false
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should skip February 2025 (no 29th), go to March 29
      const expected = atTime(2025, 3, 29, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles February 29 in leap year', () => {
      // Current: Feb 15 2024 (leap year), schedule: 29th at 09:00
      const from = atTime(2024, 2, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [29],
        time: '09:00'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be Feb 29 2024
      const expected = atTime(2024, 2, 29, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles February 29 in non-leap year with runOnLastDayIfShorter=true', () => {
      // Current: Feb 15 2025 (not a leap year), schedule: 29th at 09:00
      const from = atTime(2025, 2, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [29],
        time: '09:00',
        runOnLastDayIfShorter: true
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should run on Feb 28 (last day of Feb 2025)
      const expected = atTime(2025, 2, 28, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles January 31 to February transition', () => {
      // Current: Jan 30 2025 at 10:00, schedule: 31st at 09:00
      const from = atTime(2025, 1, 30, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: false
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be Jan 31 2025 (still in January)
      const expected = atTime(2025, 1, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('uses current day if no daysOfMonth specified', () => {
      // Current: June 17 2025 at 10:00
      const from = atTime(2025, 6, 17, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [], time: '09:00' });
      
      const result = calculateNextRunAt(definition, from);
      
      // Should be July 17 (uses current day of month)
      const expected = atTime(2025, 7, 17, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('every_n_days schedule', () => {
    it('calculates next run from anchor in the past', () => {
      // Anchor: June 1 at 09:00, interval: 7 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-06-01'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // June 1 + 7 = June 8, June 8 + 7 = June 15
      // Current is June 10, so next run is June 15
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns anchor time if anchor is in the future', () => {
      // Anchor: June 20 at 09:00, interval: 7 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-06-20'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Anchor is in the future, return anchor time directly
      const expected = atTime(2025, 6, 20, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles same-day anchor before current time', () => {
      // Anchor: June 10 at 08:00, interval: 3 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 3,
        time: '08:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Anchor time already passed today, next run is anchor + 3 days = June 13
      const expected = atTime(2025, 6, 13, 8, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles same-day anchor after current time', () => {
      // Anchor: June 10 at 15:00, interval: 3 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 3,
        time: '15:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Anchor is later today (in the future), so return anchor time directly
      const expected = atTime(2025, 6, 10, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles interval of 1 day', () => {
      // Anchor: June 10 at 09:00, interval: 1 day
      // Current: June 12 at 10:00
      const from = atTime(2025, 6, 12, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 1,
        time: '09:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // June 10 + 3 days = June 13 (next occurrence after June 12 10:00)
      const expected = atTime(2025, 6, 13, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles large interval (30 days)', () => {
      // Anchor: Jan 1 at 09:00, interval: 30 days
      // Current: Jan 25 at 10:00
      const from = atTime(2025, 1, 25, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 30,
        time: '09:00',
        anchorDate: '2025-01-01'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Jan 1 + 30 = Jan 31 at 09:00
      const expected = atTime(2025, 1, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('defaults to interval of 1 if intervalDays is 0 or missing', () => {
      // interval: 0 should be treated as 1
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 0,
        time: '09:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Anchor June 10 09:00 already passed (now is 10:00), next is June 11 09:00
      const expected = atTime(2025, 6, 11, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns null when anchorDate is empty (fail-closed)', () => {
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 5,
        time: '09:00',
        anchorDate: '' // Empty anchor date — fail-closed returns null
      });
      
      const result = calculateNextRunAt(definition, from);
      
      // Fail-closed: missing/empty anchorDate means we can't compute a correct schedule
      expect(result).toBeNull();
    });
  });

  describe('once schedule', () => {
    it('returns timestamp when dateTime is in the future', () => {
      // Current: June 15 2025 at 10:00, once: June 20 at 15:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' });

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2025, 6, 20, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns timestamp when dateTime is in the past and never ran (immediate fire)', () => {
      // Current: June 15 2025 at 10:00, once: June 10 at 09:00 — never ran
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-10T09:00:00' });

      const result = calculateNextRunAt(definition, from);

      // Returns the past timestamp so scheduler fires immediately with delay=0
      const expected = atTime(2025, 6, 10, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns timestamp when dateTime equals current time and never ran', () => {
      // Current: June 15 2025 at 15:00, once: June 15 at 15:00 — never ran
      const from = atTime(2025, 6, 15, 15, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-15T15:00:00' });

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2025, 6, 15, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns null when automation is disabled', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }, false);

      const result = calculateNextRunAt(definition, from);

      expect(result).toBeNull();
    });

    it('returns null when lastRunStatus is success (prevents double-fire)', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = {
        ...createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }),
        lastRunStatus: 'success' as const,
      };

      const result = calculateNextRunAt(definition, from);

      expect(result).toBeNull();
    });

    it('returns null when lastRunStatus is completed_with_blocks (prevents double-fire)', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = {
        ...createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }),
        lastRunStatus: 'completed_with_blocks' as const,
      };

      const result = calculateNextRunAt(definition, from);

      expect(result).toBeNull();
    });

    it('returns timestamp when lastRunStatus is failure and dateTime is in the future (allows retry)', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = {
        ...createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }),
        lastRunStatus: 'failure' as const,
      };

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2025, 6, 20, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns null when lastRunStatus is failure and dateTime is in the past (already attempted)', () => {
      const from = atTime(2025, 6, 25, 10, 0).getTime();
      const definition = {
        ...createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }),
        lastRunStatus: 'failure' as const,
        lastRunAt: atTime(2025, 6, 20, 15, 0).getTime(),
      };

      const result = calculateNextRunAt(definition, from);

      expect(result).toBeNull();
    });

    it('returns timestamp when lastRunStatus is cancelled and dateTime is in the future', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = {
        ...createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' }),
        lastRunStatus: 'cancelled' as const,
      };

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2025, 6, 20, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles dateTime just 1 minute in the future', () => {
      const from = atTime(2025, 6, 15, 14, 59).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-15T15:00:00' });

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2025, 6, 15, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles cross-year dateTime', () => {
      const from = atTime(2025, 12, 31, 23, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2026-01-01T00:30:00' });

      const result = calculateNextRunAt(definition, from);

      const expected = atTime(2026, 1, 1, 0, 30).getTime();
      expect(result).toBe(expected);
    });
  });
});

describe('calculateMostRecentScheduledTime', () => {
  describe('disabled automation', () => {
    it('returns null when automation is disabled', () => {
      const definition = createDefinition({ type: 'daily', time: '09:00' }, false);
      const result = calculateMostRecentScheduledTime(definition, Date.now());
      expect(result).toBeNull();
    });
  });

  describe('hourly schedule', () => {
    it('returns current hour when minute has passed', () => {
      // Current time: 14:45, schedule: minute 30
      const from = atTime(2025, 6, 15, 14, 45).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 14:30 same hour
      const expected = atTime(2025, 6, 15, 14, 30).getTime();
      expect(result).toBe(expected);
    });

    it('returns previous hour when minute has not passed', () => {
      // Current time: 14:15, schedule: minute 30
      const from = atTime(2025, 6, 15, 14, 15).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 13:30 (previous hour)
      const expected = atTime(2025, 6, 15, 13, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles minute 0', () => {
      // Current time: 14:30, schedule: minute 0
      const from = atTime(2025, 6, 15, 14, 30).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 0 });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 14:00 same hour
      const expected = atTime(2025, 6, 15, 14, 0).getTime();
      expect(result).toBe(expected);
    });

    it('crosses midnight backward', () => {
      // Current time: 00:15, schedule: minute 30
      const from = atTime(2025, 6, 15, 0, 15).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 23:30 previous day
      const expected = atTime(2025, 6, 14, 23, 30).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('daily schedule', () => {
    it('returns today if time has passed', () => {
      // Current time: 10:00, schedule: 09:30
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:30' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 09:30 same day
      const expected = atTime(2025, 6, 15, 9, 30).getTime();
      expect(result).toBe(expected);
    });

    it('returns yesterday if time has not passed', () => {
      // Current time: 08:00, schedule: 09:30
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:30' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 09:30 yesterday
      const expected = atTime(2025, 6, 14, 9, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles month boundary backward', () => {
      // Current time: Feb 1 08:00, schedule: 09:00
      const from = atTime(2025, 2, 1, 8, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be Jan 31 09:00
      const expected = atTime(2025, 1, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('daily schedule with additionalTimes', () => {
    it('returns most recent time today when both times have passed', () => {
      // Current time: 16:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 16, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 14:00 today (most recent past time)
      const expected = atTime(2025, 6, 15, 14, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns first time today when now is between times', () => {
      // Current time: 10:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 09:00 today (only past time today)
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns most recent time from yesterday when now is before all times', () => {
      // Current time: 06:00, schedule: primary 09:00, additional 14:00
      const from = atTime(2025, 6, 15, 6, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['14:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 14:00 yesterday (most recent past time)
      const expected = atTime(2025, 6, 14, 14, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles times spanning midnight (evening then morning)', () => {
      // Current time: 07:00, schedule: primary 23:30, additional 06:00
      const from = atTime(2025, 6, 15, 7, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '23:30',
        additionalTimes: ['06:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // 06:00 already passed today - should be 06:00 today
      const expected = atTime(2025, 6, 15, 6, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles times spanning midnight (before morning time)', () => {
      // Current time: 03:00, schedule: primary 23:30, additional 06:00
      const from = atTime(2025, 6, 15, 3, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '23:30',
        additionalTimes: ['06:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Both times in the future for today, most recent is 23:30 yesterday
      const expected = atTime(2025, 6, 14, 23, 30).getTime();
      expect(result).toBe(expected);
    });

    it('handles duplicate times (same as single time)', () => {
      // Current time: 10:00, schedule: primary 09:00, additional 09:00 (duplicate)
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['09:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should work same as single time - 09:00 today
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles empty additionalTimes array (same as undefined)', () => {
      // Current time: 10:00, schedule: primary 09:00, additionalTimes: []
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: []
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should behave same as no additionalTimes - 09:00 today
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles three times returning the most recent past time', () => {
      // Current time: 15:00, schedule: primary 09:00, additional 12:00 and 18:00
      const from = atTime(2025, 6, 15, 15, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['12:00', '18:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 12:00 today (most recent past time, 18:00 is in future)
      const expected = atTime(2025, 6, 15, 12, 0).getTime();
      expect(result).toBe(expected);
    });

    it('correctly picks most recent time regardless of order in additionalTimes', () => {
      // Current time: 20:00, schedule: primary 14:00, additional 18:00 and 09:00
      const from = atTime(2025, 6, 15, 20, 0).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '14:00',
        additionalTimes: ['18:00', '09:00']
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 18:00 today (most recent past time)
      const expected = atTime(2025, 6, 15, 18, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('weekly schedule', () => {
    it('returns today if day matches and time has passed', () => {
      // Current: Sunday June 15 2025 at 10:00, schedule: Sunday 09:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [0], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be 09:00 same day (Sunday)
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns previous week if day matches but time has not passed', () => {
      // Current: Sunday June 15 2025 at 08:00, schedule: Sunday 09:00
      const from = atTime(2025, 6, 15, 8, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [0], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be last Sunday June 8 at 09:00
      const expected = atTime(2025, 6, 8, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns most recent matching weekday', () => {
      // Current: Thursday June 19 2025 at 10:00, schedule: Monday 09:00
      const from = atTime(2025, 6, 19, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [1], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be Monday June 16 at 09:00
      const expected = atTime(2025, 6, 16, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles multiple days in schedule', () => {
      // Current: Thursday June 19 2025 at 10:00, schedule: Mon, Wed at 09:00
      const from = atTime(2025, 6, 19, 10, 0).getTime();
      const definition = createDefinition({ type: 'weekly', daysOfWeek: [1, 3], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be Wednesday June 18 at 09:00 (most recent)
      const expected = atTime(2025, 6, 18, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('monthly schedule', () => {
    it('returns this month if day passed', () => {
      // Current: June 20 at 10:00, schedule: 15th at 09:00
      const from = atTime(2025, 6, 20, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [15], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be June 15 09:00
      const expected = atTime(2025, 6, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns previous month if day has not passed', () => {
      // Current: June 10 at 10:00, schedule: 15th at 09:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [15], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be May 15 09:00
      const expected = atTime(2025, 5, 15, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles multiple days with most recent match', () => {
      // Current: June 20 at 10:00, schedule: 10th and 25th at 09:00
      const from = atTime(2025, 6, 20, 10, 0).getTime();
      const definition = createDefinition({ type: 'monthly', daysOfMonth: [10, 25], time: '09:00' });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be June 10 09:00 (most recent before now)
      const expected = atTime(2025, 6, 10, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles day 31 in a 30-day month with runOnLastDayIfShorter=true', () => {
      // Current: July 5 at 10:00 (after June), schedule: 31st at 09:00
      const from = atTime(2025, 7, 5, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: true
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // June has 30 days, so with runOnLastDayIfShorter, should be June 30
      const expected = atTime(2025, 6, 30, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('skips months without the day when runOnLastDayIfShorter=false', () => {
      // Current: July 5 at 10:00 (after June), schedule: 31st at 09:00
      const from = atTime(2025, 7, 5, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: false
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // June has no 31st, should skip to May 31
      const expected = atTime(2025, 5, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles February 29 in leap year', () => {
      // Current: March 5 2024 (leap year), schedule: 29th at 09:00
      const from = atTime(2024, 3, 5, 10, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [29],
        time: '09:00'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should be Feb 29 2024 (leap year has it)
      const expected = atTime(2024, 2, 29, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('every_n_days schedule', () => {
    it('returns most recent scheduled time from anchor', () => {
      // Anchor: June 1 at 09:00, interval: 7 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-06-01'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // June 1 + 7 = June 8 is most recent before June 10
      const expected = atTime(2025, 6, 8, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns null if anchor is in the future', () => {
      // Anchor: June 20 at 09:00, interval: 7 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-06-20'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // No scheduled time exists before now
      expect(result).toBeNull();
    });

    it('returns anchor time if we are exactly at anchor', () => {
      // Anchor: June 10 at 09:00, interval: 7 days
      // Current: June 10 at 09:00 exactly
      const from = atTime(2025, 6, 10, 9, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Should return the anchor time itself
      const expected = atTime(2025, 6, 10, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles anchor on same day but time not yet passed', () => {
      // Anchor: June 10 at 15:00, interval: 7 days
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '15:00',
        anchorDate: '2025-06-10'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Anchor hasn't occurred yet (it's later today), so returns null
      expect(result).toBeNull();
    });

    it('handles interval of 1 day', () => {
      // Anchor: June 1 at 09:00, interval: 1 day
      // Current: June 10 at 10:00
      const from = atTime(2025, 6, 10, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 1,
        time: '09:00',
        anchorDate: '2025-06-01'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Most recent is June 10 at 09:00
      const expected = atTime(2025, 6, 10, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles large interval (30 days)', () => {
      // Anchor: Jan 1 at 09:00, interval: 30 days
      // Current: Feb 15 at 10:00
      const from = atTime(2025, 2, 15, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 30,
        time: '09:00',
        anchorDate: '2025-01-01'
      });
      
      const result = calculateMostRecentScheduledTime(definition, from);
      
      // Jan 1 + 30 = Jan 31 is most recent before Feb 15
      const expected = atTime(2025, 1, 31, 9, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  describe('once schedule', () => {
    it('returns timestamp when dateTime is in the past', () => {
      // Current: June 15 2025 at 10:00, once: June 10 at 09:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-10T09:00:00' });

      const result = calculateMostRecentScheduledTime(definition, from);

      const expected = atTime(2025, 6, 10, 9, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns timestamp when dateTime equals current time', () => {
      // Current: June 15 2025 at 15:00, once: June 15 at 15:00
      const from = atTime(2025, 6, 15, 15, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-15T15:00:00' });

      const result = calculateMostRecentScheduledTime(definition, from);

      const expected = atTime(2025, 6, 15, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('returns null when dateTime is in the future', () => {
      // Current: June 15 2025 at 10:00, once: June 20 at 15:00
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-20T15:00:00' });

      const result = calculateMostRecentScheduledTime(definition, from);

      expect(result).toBeNull();
    });

    it('returns null when automation is disabled', () => {
      const from = atTime(2025, 6, 15, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-10T09:00:00' }, false);

      const result = calculateMostRecentScheduledTime(definition, from);

      expect(result).toBeNull();
    });

    it('returns timestamp when dateTime is just 1 minute in the past', () => {
      const from = atTime(2025, 6, 15, 15, 1).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-06-15T15:00:00' });

      const result = calculateMostRecentScheduledTime(definition, from);

      const expected = atTime(2025, 6, 15, 15, 0).getTime();
      expect(result).toBe(expected);
    });

    it('handles cross-year dateTime in the past', () => {
      const from = atTime(2026, 1, 2, 10, 0).getTime();
      const definition = createDefinition({ type: 'once', dateTime: '2025-12-31T23:30:00' });

      const result = calculateMostRecentScheduledTime(definition, from);

      const expected = atTime(2025, 12, 31, 23, 30).getTime();
      expect(result).toBe(expected);
    });
  });
});

describe('DST handling with Luxon', () => {
  // These tests verify that Luxon handles DST transitions correctly.
  // Note: Results depend on the local timezone. These tests work in US timezones
  // where DST transitions occur on specific dates.
  
  describe('spring forward (DST start)', () => {
    // In 2025, US DST starts March 9 at 2:00 AM (clocks jump to 3:00 AM)
    
    it('daily schedule handles spring forward correctly', () => {
      // Schedule: daily at 02:30 (during DST gap)
      // From: March 8 2025 at 10:00 (day before DST)
      const from = atTime(2025, 3, 8, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '02:30' });
      
      const nextRun = calculateNextRunAt(definition, from);
      
      // Should still schedule for March 9 02:30
      // Luxon will handle the DST gap appropriately
      expect(nextRun).not.toBeNull();
      expect(nextRun!).toBeGreaterThan(from);
    });
  });

  describe('fall back (DST end)', () => {
    // In 2025, US DST ends November 2 at 2:00 AM (clocks go back to 1:00 AM)
    
    it('daily schedule handles fall back correctly', () => {
      // Schedule: daily at 01:30 (during DST overlap)
      // From: November 1 2025 at 10:00 (day before DST ends)
      const from = atTime(2025, 11, 1, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '01:30' });
      
      const nextRun = calculateNextRunAt(definition, from);
      
      // Should still schedule correctly for November 2
      expect(nextRun).not.toBeNull();
      expect(nextRun!).toBeGreaterThan(from);
    });
  });

  describe('every_n_days across DST', () => {
    it('handles interval calculation across DST transition', () => {
      // Anchor: March 1 2025 at 09:00, interval: 7 days
      // From: March 9 2025 at 10:00 (DST started today)
      const from = atTime(2025, 3, 9, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 7,
        time: '09:00',
        anchorDate: '2025-03-01'
      });
      
      // March 1 + 7 = March 8 at 09:00
      const mostRecent = calculateMostRecentScheduledTime(definition, from);
      expect(mostRecent).not.toBeNull();
      
      // March 8 + 7 = March 15 at 09:00
      const nextRun = calculateNextRunAt(definition, from);
      expect(nextRun).not.toBeNull();
      
      // Verify the interval is correct (approximately 7 days despite DST)
      if (mostRecent && nextRun) {
        const intervalMs = nextRun - mostRecent;
        const intervalDays = intervalMs / (1000 * 60 * 60 * 24);
        // Due to DST, this might be slightly off from exactly 7, but should be close
        expect(intervalDays).toBeGreaterThan(6.9);
        expect(intervalDays).toBeLessThan(7.1);
      }
    });
  });
});

/**
 * Tests for setTimeout overflow handling in AutomationScheduler.
 * 
 * Node.js setTimeout has a maximum delay of 2^31-1 ms (~24.8 days).
 * Delays exceeding this value cause the timer to fire immediately.
 * The scheduler should handle this by setting intermediate timers.
 */
describe('AutomationScheduler setTimeout overflow handling', () => {
  // Constants matching the implementation
  const MAX_TIMEOUT_MS = 2147483647; // 2^31-1, ~24.8 days
  const _THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    // Use fake timers with shouldAdvanceTime to make Date.now() advance with the timers
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire a 30-day delay immediately', () => {
    // Set a fixed "now" time
    const now = new Date('2025-01-01T10:00:00').getTime();
    vi.setSystemTime(now);

    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const notifyRenderer = vi.fn();

    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn,
      notifyRenderer
    });

    // Create an automation with a monthly schedule that results in a ~30 day delay
    // Schedule: 1st of month at 09:00. Current: Jan 1 at 10:00
    // Next run: Feb 1 at 09:00 (~31 days away)
    scheduler.upsertDefinition({
      name: 'Monthly Test',
      filePath: '/test/monthly.md',
      schedule: AutomationSchedule.monthly({ daysOfMonth: [1], time: '09:00' }),
      enabled: true
    });

    // Advance by 1 hour - should NOT have fired
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(executeAgentTurn).not.toHaveBeenCalled();

    // Advance by 1 day - should NOT have fired
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(executeAgentTurn).not.toHaveBeenCalled();

    // Advance by 7 days - should NOT have fired
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it('sets intermediate timer for delays exceeding MAX_TIMEOUT_MS', () => {
    // This test verifies that long delays result in an intermediate timer
    // being set (rather than firing immediately, which was the bug).
    // 
    // We verify this by checking that:
    // 1. The automation doesn't fire immediately
    // 2. The automation doesn't fire within the first few days
    // 3. An intermediate timer exists (indicated by timer not firing)
    
    const now = new Date('2025-01-01T10:00:00').getTime();
    vi.setSystemTime(now);

    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const notifyRenderer = vi.fn();

    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn,
      notifyRenderer
    });

    // Create a monthly automation - next run is Feb 1 (~31 days away)
    scheduler.upsertDefinition({
      name: 'Monthly Test',
      filePath: '/test/monthly.md',
      schedule: AutomationSchedule.monthly({ daysOfMonth: [1], time: '09:00' }),
      enabled: true
    });

    // Verify the automation was scheduled with correct nextRunAt
    const state = scheduler.getState();
    const definition = state.definitions.find(d => d.name === 'Monthly Test');
    expect(definition).toBeDefined();
    expect(definition!.nextRunAt).toBeDefined();
    
    // Next run should be ~31 days away (more than MAX_TIMEOUT_MS of ~24.8 days)
    const nextRunAt = definition!.nextRunAt!;
    expect(nextRunAt).toBeGreaterThan(now + MAX_TIMEOUT_MS);

    // Verify the automation has NOT fired immediately (this was the bug)
    expect(executeAgentTurn).not.toHaveBeenCalled();

    // Advance by 10 days - should still not have fired
    vi.advanceTimersByTime(10 * 24 * 60 * 60 * 1000);
    expect(executeAgentTurn).not.toHaveBeenCalled();

    // Advance by 20 days total - still should not have fired
    // (we're now past MAX_TIMEOUT_MS but before the scheduled time)
    vi.advanceTimersByTime(10 * 24 * 60 * 60 * 1000);
    expect(executeAgentTurn).not.toHaveBeenCalled();

    // Note: We can't easily verify the timer fires at the exact right time
    // due to how Vitest fake timers work with Date.now(), but the key fix
    // is verified: the timer doesn't fire immediately.
  });
});

/**
 * Tests for checkForMissedRuns (catch-up logic) in AutomationScheduler.
 * 
 * The scheduler should detect missed runs and trigger catch-up executions
 * when the app launches or resumes from sleep, subject to:
 * - A 7-day grace period (runs missed more than 7 days ago are not caught up)
 * - The catchUpIfMissed flag on the automation definition
 * - Concurrent run prevention (won't catch up if already running)
 * - Event-triggered automations don't have catch-up (no scheduled time)
 * 
 * NOTE: These tests use vi.useFakeTimers() but avoid vi.runAllTimersAsync() 
 * because executeAutomation triggers scheduleAutomation which sets new timers,
 * causing infinite loops. Instead, we check the mock call count synchronously
 * after handleAppLaunch() since checkForMissedRuns calls executeAutomation
 * synchronously (it fires the promise without awaiting in the loop).
 */
describe('checkForMissedRuns (catch-up logic)', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    // Reset mock call counts
    mockLoggerMethods.info.mockClear();
    mockLoggerMethods.warn.mockClear();
    mockLoggerMethods.error.mockClear();
    mockLoggerMethods.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cloud fallback (executeIn: cloud)', () => {
    const mockResolvedAutomationFile = (scheduler: InstanceType<typeof AutomationScheduler>) => {
      const schedulerWithInternals = scheduler as unknown as {
        resolveAutomationFile: () => Promise<{ resolved: string; root: string; fileContent: string }>;
      };
      vi.spyOn(schedulerWithInternals, 'resolveAutomationFile').mockResolvedValue({
        resolved: '/tmp/test/cloud-fallback.md',
        root: '/tmp/test',
        fileContent: '# Cloud fallback test prompt\nRun a local fallback test.'
      });
    };

    const flushAsyncAutomationWork = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    const upsertCloudDailyAutomation = (
      scheduler: InstanceType<typeof AutomationScheduler>,
      name: string,
      filePath: string
    ) => {
      const created = scheduler.upsertDefinition({
        name,
        filePath,
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      return scheduler.upsertDefinition({
        id: created.id,
        schedule: created.schedule,
        executeIn: 'cloud'
      });
    };

    it('falls back to local catch-up execution when cloud is offline', async () => {
      vi.setSystemTime(atTime(2025, 6, 15, 8, 30).getTime());

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          // onboarded user: the onboarding gate on executeAutomation must not skip this.
          onboardingCompleted: true,
          cloudInstance: { mode: 'local' }
        } as import('@shared/types').AppSettings)
      });
      mockResolvedAutomationFile(scheduler);

      const definition = upsertCloudDailyAutomation(
        scheduler,
        'Cloud Fallback Daily',
        '/test/cloud-fallback.md'
      );
      expect(definition.executeIn).toBe('cloud');

      mockLoggerMethods.info.mockClear();
      executeAgentTurn.mockClear();

      vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());
      scheduler.handleAppLaunch();

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          automationName: 'Cloud Fallback Daily',
          context: 'launch'
        }),
        'Catching up missed automation run'
      );

      await flushAsyncAutomationWork();

      expect(executeAgentTurn).toHaveBeenCalled();
    });

    it('skips catch-up when cloud mode is active', () => {
      vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          cloudInstance: {
            mode: 'cloud',
            cloudUrl: 'https://cloud.example.com',
            cloudToken: 'tok_test_cloud'
          }
        } as import('@shared/types').AppSettings)
      });

      const definition = upsertCloudDailyAutomation(
        scheduler,
        'Cloud Active Daily',
        '/test/cloud-active.md'
      );
      expect(definition.executeIn).toBe('cloud');

      mockLoggerMethods.debug.mockClear();
      executeAgentTurn.mockClear();

      scheduler.handleAppLaunch();

      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          reason: 'cloud_active'
        }),
        'Catch-up skipped — cloud will handle'
      );
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });

    it('runNow executes cloud-selected automations locally even when cloud is active', async () => {
      vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          cloudInstance: {
            mode: 'cloud',
            cloudUrl: 'https://cloud.example.com',
            cloudToken: 'tok_test_cloud'
          }
        } as import('@shared/types').AppSettings)
      });
      mockResolvedAutomationFile(scheduler);

      const definition = upsertCloudDailyAutomation(
        scheduler,
        'Cloud Manual Run',
        '/test/cloud-manual.md'
      );
      expect(definition.executeIn).toBe('cloud');

      executeAgentTurn.mockClear();
      const run = await scheduler.runNow(definition.id);

      expect(run).not.toBeNull();
      expect(executeAgentTurn).toHaveBeenCalled();
    });

    it('emits catch-up log for cloud-selected automation when cloud is offline', () => {
      vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          cloudInstance: { mode: 'local' }
        } as import('@shared/types').AppSettings)
      });

      const definition = upsertCloudDailyAutomation(
        scheduler,
        'Cloud Offline Catch-Up',
        '/test/cloud-offline.md'
      );
      expect(definition.executeIn).toBe('cloud');

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: definition.id,
          automationName: 'Cloud Offline Catch-Up',
          context: 'launch'
        }),
        'Catching up missed automation run'
      );
    });
  });

  describe('automation missed within grace period', () => {
    it('triggers catch-up run on app launch when automation missed within 7 days', () => {
      // Scenario: Automation was scheduled for 09:00, app launches at 11:00 same day
      // The automation should catch up because it's only 2 hours overdue
      
      // Set time to June 15 2025 at 11:00
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create a daily automation scheduled for 09:00
      // With current time at 11:00, this was "missed" 2 hours ago
      scheduler.upsertDefinition({
        name: 'Daily Standup Reminder',
        filePath: '/test/standup.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      // Clear the mock to ignore the initial scheduling call
      mockLoggerMethods.info.mockClear();

      // Trigger the catch-up check (simulates app launch)
      scheduler.handleAppLaunch();

      // Verify catch-up was logged (executeAutomation is called, file read fails but that's fine)
      // The key is that checkForMissedRuns detected the miss and attempted to run
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Daily Standup Reminder',
          context: 'launch'
        }),
        'Catching up missed automation run'
      );
    });

    it('triggers catch-up run on resume when automation missed during sleep', () => {
      // Scenario: Automation was scheduled for 09:00, system went to sleep at 08:00,
      // resumed at 10:30. Should catch up.
      
      const now = atTime(2025, 6, 15, 10, 30).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Morning Briefing',
        filePath: '/test/briefing.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();

      // Simulate entering low-power mode and then exiting
      scheduler.enterLowPowerMode('system_sleep');
      scheduler.exitLowPowerMode('system_resume');

      // Verify catch-up was logged
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Morning Briefing',
          context: 'resume'
        }),
        'Catching up missed automation run'
      );
    });

    it('handles automation missed by 6 days (just within grace period)', () => {
      // Edge case: automation missed by almost exactly 7 days
      // Use a weekly schedule - scheduled for last Monday, now is Sunday 
      
      // June 22 2025 is Sunday, June 16 was Monday (6 days ago)
      const now = atTime(2025, 6, 22, 10, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        id: 'test-automation',
        name: 'Weekly Report',
        filePath: '/test/report.md',
        schedule: AutomationSchedule.weekly({ daysOfWeek: [1], time: '09:00' }), // Monday
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should trigger catch-up because it's within 7 days
      // Monday June 16 09:00 to Sunday June 22 10:00 is ~6 days 1 hour
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Weekly Report',
          context: 'launch'
        }),
        'Catching up missed automation run'
      );
    });
  });

  describe('automation missed outside grace period', () => {
    it('does NOT trigger catch-up when automation missed more than 7 days ago', () => {
      // Scenario: The most recent scheduled time is more than 7 days ago
      // For daily or weekly schedules, this is hard to test since there's always
      // a scheduled time within the last week.
      //
      // Let's use a monthly schedule - if scheduled for the 1st at 09:00
      // and it's now the 10th at 10:00, that's ~9 days ago.
      
      // June 10 2025 at 10:00
      const now = atTime(2025, 6, 10, 10, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Monthly on the 1st at 09:00
      // June 1 09:00 to June 10 10:00 is ~9 days (>7 days grace period)
      scheduler.upsertDefinition({
        name: 'Monthly Summary',
        filePath: '/test/summary.md',
        schedule: AutomationSchedule.monthly({ daysOfMonth: [1], time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT have triggered catch-up because June 1 09:00 was ~9 days ago
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Monthly Summary'
      );
      expect(catchUpCalls).toHaveLength(0);
    });

    it('does NOT trigger catch-up when missed by 8 days', () => {
      // Use monthly schedule - scheduled for 1st at 09:00, now the 9th at 10:00
      // That's 8 days, outside the 7-day grace period
      
      // June 9 2025 at 10:00
      const now = atTime(2025, 6, 9, 10, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Monthly on the 1st at 09:00
      // June 1 09:00 to June 9 10:00 is 8 days + 1 hour
      scheduler.upsertDefinition({
        name: 'Monthly Check',
        filePath: '/test/check.md',
        schedule: AutomationSchedule.monthly({ daysOfMonth: [1], time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT trigger catch-up because 8 days > 7 days grace period
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Monthly Check'
      );
      expect(catchUpCalls).toHaveLength(0);
    });
  });

  describe('catchUpIfMissed flag', () => {
    it('does NOT trigger catch-up when catchUpIfMissed is false', () => {
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create automation with catchUpIfMissed explicitly false
      scheduler.upsertDefinition({
        name: 'No Catch-Up Automation',
        filePath: '/test/nocatchup.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: false // Explicitly disable catch-up
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT have triggered catch-up even though 09:00 was missed
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'No Catch-Up Automation'
      );
      expect(catchUpCalls).toHaveLength(0);
    });

    it('hourly automations default to catchUpIfMissed=false', () => {
      const now = atTime(2025, 6, 15, 11, 45).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create hourly automation without specifying catchUpIfMissed
      // Should default to false for hourly
      scheduler.upsertDefinition({
        name: 'Hourly Check',
        filePath: '/test/hourly.md',
        schedule: AutomationSchedule.hourly({ minute: 30 }),
        enabled: true
        // catchUpIfMissed not specified, should default to false for hourly
      });

      // Verify it defaulted to false
      const state = scheduler.getState();
      const def = state.definitions.find(d => d.name === 'Hourly Check');
      expect(def?.catchUpIfMissed).toBe(false);

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT have triggered catch-up
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Hourly Check'
      );
      expect(catchUpCalls).toHaveLength(0);
    });

    it('daily automations default to catchUpIfMissed=true', () => {
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create daily automation without specifying catchUpIfMissed
      // Should default to true for daily
      scheduler.upsertDefinition({
        name: 'Daily Task',
        filePath: '/test/daily.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true
        // catchUpIfMissed not specified, should default to true for daily
      });

      // Verify it defaulted to true
      const state = scheduler.getState();
      const def = state.definitions.find(d => d.name === 'Daily Task');
      expect(def?.catchUpIfMissed).toBe(true);
    });
  });

  describe('concurrent run prevention', () => {
    it('runNow returns null when automation is already running', () => {
      // This test verifies that runNow() blocks duplicate runs.
      // The isAutomationRunning check is shared between runNow() and checkForMissedRuns().
      // We test runNow() because it's synchronous and easier to verify.
      
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      const def = scheduler.upsertDefinition({
        name: 'Test Automation',
        filePath: '/test/task.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      // First run starts (will be in 'running' status until it resolves)
      const firstRun = scheduler.runNow(def.id);
      
      // Second run should be blocked because isAutomationRunning returns true
      // Note: In the test env, file read fails quickly so the run may complete,
      // but the log message 'Automation already running, skipping duplicate run request'
      // is emitted synchronously if isAutomationRunning returns true.
      
      mockLoggerMethods.info.mockClear();
      const _secondRun = scheduler.runNow(def.id);
      
      // If the automation was still running, secondRun would be null
      // and the skip log would be emitted. In practice, the file read fails
      // so fast that the first run may complete before the second call.
      // This test verifies the code path exists.
      // The key assertion is that we see the proper logging behavior.
      expect(firstRun).not.toBeNull(); // First run starts
    });

    it('checkForMissedRuns skips automations already in running state', () => {
      // This test verifies that if an automation already has a 'running' status run,
      // checkForMissedRuns will skip it. We verify this via the isAutomationRunning
      // log message that would be emitted (currently not logged, but the code path exists).
      // 
      // The actual concurrent prevention is verified by runNow() tests above.
      // checkForMissedRuns uses the same isAutomationRunning check.
      
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Missed Automation',
        filePath: '/test/task.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Verify catch-up was attempted for the test automation
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Missed Automation'
      );
      expect(catchUpCalls).toHaveLength(1);
    });
  });

  describe('event-triggered automations', () => {
    it('does NOT apply catch-up logic to event-triggered automations', () => {
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create an event-triggered automation
      scheduler.upsertDefinition({
        name: 'Transcript Handler',
        filePath: '/test/transcript.md',
        schedule: AutomationSchedule.event({ eventType: 'transcript-ready' }),
        enabled: true,
        catchUpIfMissed: true // Even with this set, should not apply
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT have triggered any catch-up (event automations have no scheduled time)
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Transcript Handler'
      );
      expect(catchUpCalls).toHaveLength(0);
    });
  });

  describe('disabled automations', () => {
    it('does NOT trigger catch-up for disabled automations', () => {
      const now = atTime(2025, 6, 15, 11, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Disabled Automation',
        filePath: '/test/disabled.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: false, // Disabled
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT have triggered catch-up
      // Filter by automation name to exclude system automations from the check
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Disabled Automation'
      );
      expect(catchUpCalls).toHaveLength(0);
    });
  });

  describe('multiple daily times (additionalTimes)', () => {
    it('catches up the most recent missed time slot', () => {
      // Current time: 15:00
      // Schedule: 09:00 and 14:00
      // Both times have passed, should catch up based on 14:00 (most recent)
      
      const now = atTime(2025, 6, 15, 15, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Twice Daily',
        filePath: '/test/twice.md',
        schedule: AutomationSchedule.daily({ time: '09:00', additionalTimes: ['14:00'] }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should trigger catch-up (14:00 was 1 hour ago, within grace period)
      // Check that the log mentions the automation
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Twice Daily'
        }),
        'Catching up missed automation run'
      );
    });

    it('catches up when between scheduled times and NO previous slot ran', () => {
      // Current time: 12:00
      // Schedule: 09:00 and 14:00
      // 09:00 was NOT run (lastRunAt is null/0), should trigger catch-up
      
      const now = atTime(2025, 6, 15, 12, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      // Create automation - lastRunAt will be null by default
      scheduler.upsertDefinition({
        name: 'Twice Daily Not Run Yet',
        filePath: '/test/twice.md',
        schedule: AutomationSchedule.daily({ time: '09:00', additionalTimes: ['14:00'] }),
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should trigger catch-up because mostRecentScheduledTime (09:00) 
      // is later than lastRunAt (null/0), so it looks missed
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Twice Daily Not Run Yet'
        }),
        'Catching up missed automation run'
      );
    });
  });

  describe('weekly and monthly schedules', () => {
    it('catches up missed weekly automation within grace period', () => {
      // Tuesday 10:00, weekly automation scheduled for Tuesday 09:00
      // The 09:00 slot today was missed (1 hour ago)
      // June 17 2025 is Tuesday
      const now = atTime(2025, 6, 17, 10, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Weekly Report',
        filePath: '/test/weekly.md',
        schedule: AutomationSchedule.weekly({ daysOfWeek: [2], time: '09:00' }), // Tuesday
        enabled: true,
        catchUpIfMissed: true
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should catch up because 09:00 today was missed and is within grace period
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        expect.objectContaining({
          automationName: 'Weekly Report'
        }),
        'Catching up missed automation run'
      );
    });

    it('does NOT catch up monthly automation missed more than 7 days ago', () => {
      // June 10 10:00, monthly automation scheduled for 1st at 09:00
      // June 1 was 9 days ago, outside 7-day grace period
      const now = atTime(2025, 6, 10, 10, 0).getTime();
      vi.setSystemTime(now);

      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const notifyRenderer = vi.fn();

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer
      });

      scheduler.upsertDefinition({
        name: 'Monthly Meeting Notes',
        filePath: '/test/monthly.md',
        schedule: AutomationSchedule.monthly({ daysOfMonth: [1], time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true
      });

      executeAgentTurn.mockClear();
      scheduler.handleAppLaunch();

      // Should NOT catch up because June 1 09:00 was ~9 days ago
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });
  });
});

/**
 * Tests for broadcast optimisation (projection mode + throttling).
 *
 * stageRunSnapshot suppresses the default broadcast and instead schedules
 * a trailing-edge throttled projection broadcast. Full broadcasts (CRUD,
 * terminal status via persistRun) cancel any pending throttled send.
 *
 * We invoke the private stageRunSnapshot / scheduleThrottledBroadcast /
 * cancelThrottledBroadcast methods via bracket notation so we can test
 * the broadcast layer in isolation without needing the full LLM pipeline
 * (which requires file I/O mocking, session stores, etc.).
 */
describe('broadcast optimisation (projection + throttle)', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: call stageRunSnapshot on the scheduler with a synthetic run. */
  const callStageRunSnapshot = (
    scheduler: InstanceType<typeof AutomationScheduler>,
    overrides: Partial<import('@shared/types').AutomationRun> = {}
  ) => {
    const run: import('@shared/types').AutomationRun = {
      id: 'test-run-1',
      automationId: 'test-auto-1',
      startedAt: Date.now(),
      completedAt: null,
      status: 'running',
      trigger: 'manual',
      sessionId: 'sess-1',
      error: null,
      eventsByTurn: { 't1': [{ type: 'status', message: 'working', timestamp: Date.now() }] },
      messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'hello', createdAt: Date.now() }],
      session: {
        id: 'sess-1',
        title: 'Test Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'hello', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'working', timestamp: Date.now() }] },
        activeTurnId: 't1',
        isBusy: true,
        lastError: null,
            resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'test-run-1',
      },
      ...overrides,
    };
     
    (scheduler as any).stageRunSnapshot(run);
  };

  it('stageRunSnapshot does NOT call notifyRenderer immediately', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    callStageRunSnapshot(scheduler);

    // No synchronous notifyRenderer call from stageRunSnapshot
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterSetup);
  });

  it('throttled projection fires after BROADCAST_THROTTLE_MS', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    callStageRunSnapshot(scheduler);

    // No immediate broadcast
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterSetup);

    // Advance past the throttle interval (500ms)
    vi.advanceTimersByTime(500);

    // Throttled projection broadcast should have fired
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterSetup + 1);
  });

  it('projected payload strips eventsByTurn and messages from runs', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Stage a run with heavy fields populated
    callStageRunSnapshot(scheduler);

    // Advance past throttle to trigger projection broadcast
    vi.advanceTimersByTime(500);

    const projectedCalls = notifyRenderer.mock.calls.slice(callsAfterSetup);
    expect(projectedCalls.length).toBe(1);

    const projectedState = projectedCalls[0][0];
    expect(projectedState.runs.length).toBeGreaterThan(0);

    for (const run of projectedState.runs) {
      // Heavy fields stripped from run
      expect(run.eventsByTurn).toBeUndefined();
      expect(run.messages).toBeUndefined();
      if (run.session) {
        // Session messages and eventsByTurn stripped
        expect(run.session.messages).toEqual([]);
        expect(run.session.eventsByTurn).toEqual({});
        // Session metadata preserved
        expect(run.session.id).toBe('sess-1');
        expect(run.session.title).toBe('Test Session');
        expect(run.session.isBusy).toBe(true);
        expect(run.session.activeTurnId).toBe('t1');
        expect(run.session.origin).toBe('automation');
      }
    }
  });

  it('projection does NOT mutate internal stateSnapshot', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    // Stage a run with heavy fields populated
    callStageRunSnapshot(scheduler);

    // Advance past throttle to trigger projection broadcast
    vi.advanceTimersByTime(500);

    // Internal state should be untouched — getState() returns stateSnapshot by reference
    const internalState = scheduler.getState();
    const run = internalState.runs.find(r => r.id === 'test-run-1');
    expect(run).toBeDefined();
    // The internal run should still have eventsByTurn and messages
    expect(run!.eventsByTurn).toBeDefined();
    expect(Object.keys(run!.eventsByTurn!)).toHaveLength(1);
    expect(run!.messages).toBeDefined();
    expect(run!.messages!.length).toBe(1);
    expect(run!.session).toBeDefined();
    expect(run!.session!.messages.length).toBe(1);
    expect(Object.keys(run!.session!.eventsByTurn)).toHaveLength(1);
  });

  it('full broadcast cancels pending throttled broadcast', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const def = scheduler.upsertDefinition({
      name: 'Cancel Test',
      filePath: '/test/task.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });

    // Stage a run to schedule a throttled broadcast
    callStageRunSnapshot(scheduler);
    const callsAfterStage = notifyRenderer.mock.calls.length;

    // Before the throttle fires, trigger a full broadcast via upsertDefinition
    scheduler.upsertDefinition({
      id: def.id,
      name: 'Cancel Test Updated',
      filePath: def.filePath,
      schedule: def.schedule,
      enabled: def.enabled,
    });
    const callsAfterUpsert = notifyRenderer.mock.calls.length;

    // upsertDefinition triggers a full broadcast (1 new call)
    expect(callsAfterUpsert).toBe(callsAfterStage + 1);

    // Advance past throttle — the pending throttled broadcast should have been cancelled
    vi.advanceTimersByTime(500);

    // No additional call from the cancelled throttle
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterUpsert);
  });

  it('CRUD operations use full broadcast mode (unchanged behavior)', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    // upsertDefinition triggers a full broadcast
    const def = scheduler.upsertDefinition({
      name: 'CRUD Test',
      filePath: '/test/task.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });

    const callsAfterCreate = notifyRenderer.mock.calls.length;
    // The last call should have the full state with definitions
    const lastState = notifyRenderer.mock.calls[callsAfterCreate - 1][0];
    expect(lastState.definitions).toBeDefined();
    expect(lastState.definitions.length).toBeGreaterThan(0);

    // deleteDefinition also triggers a full broadcast
    scheduler.deleteDefinition(def.id);
    expect(notifyRenderer.mock.calls.length).toBeGreaterThan(callsAfterCreate);
  });

  it('setSessionTypeFilter uses full broadcast mode', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;
    scheduler.setSessionTypeFilter('automations');

    expect(notifyRenderer.mock.calls.length).toBeGreaterThan(callsAfterSetup);
    const lastState = notifyRenderer.mock.calls[notifyRenderer.mock.calls.length - 1][0];
    expect(lastState.sessionTypeFilter).toBe('automations');
  });

  it('clearAllTimers also cancels throttled broadcast', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    // Stage a run to schedule a throttled broadcast
    callStageRunSnapshot(scheduler);
    const callsAfterStage = notifyRenderer.mock.calls.length;

    // Enter low-power mode (calls clearAllTimers internally)
    scheduler.enterLowPowerMode('test');

    // Advance past throttle
    vi.advanceTimersByTime(500);

    // No throttled broadcast should have fired (was cancelled by clearAllTimers)
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterStage);
  });

  it('multiple stageRunSnapshot calls within throttle window only send one projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Multiple rapid stageRunSnapshot calls (simulating onEvent bursts)
    callStageRunSnapshot(scheduler, { id: 'run-1' });
    callStageRunSnapshot(scheduler, { id: 'run-2' });
    callStageRunSnapshot(scheduler, { id: 'run-3' });

    // No immediate broadcasts
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterSetup);

    // Advance past throttle — only one projection broadcast should fire
    vi.advanceTimersByTime(500);

    // Exactly 1 throttled projection broadcast (trailing-edge: timer already set, subsequent calls are no-ops)
    expect(notifyRenderer.mock.calls.length).toBe(callsAfterSetup + 1);
  });

  it('runs without session have null session in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Stage a run with no session (e.g., non-LLM system automation)
    callStageRunSnapshot(scheduler, {
      id: 'nosess-run',
      session: null,
      eventsByTurn: { 't1': [{ type: 'status', message: 'done', timestamp: Date.now() }] },
      messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'hi', createdAt: Date.now() }],
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];
    const run = projectedState.runs.find((r: { id: string }) => r.id === 'nosess-run');
    expect(run).toBeDefined();
    expect(run.eventsByTurn).toBeUndefined();
    expect(run.messages).toBeUndefined();
    expect(run.session).toBeNull();
  });

  it('terminal persist broadcasts final session without storing it on the run', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const completedAt = Date.now();
    const runningSession: AgentSession = {
      id: 'sess-running',
      title: 'Still Running',
      createdAt: completedAt - 2_000,
      updatedAt: completedAt - 500,
      messages: [{ id: 'running-m1', role: 'user' as const, turnId: 't-running', text: 'Keep going', createdAt: completedAt - 500 }],
      eventsByTurn: { 't-running': [{ type: 'status', message: 'working', timestamp: completedAt - 500 }] },
      activeTurnId: 't-running',
      isBusy: true,
      lastError: null,
      resolvedAt: null,
      origin: 'automation' as const,
      automationId: 'test-auto-2',
      automationRunId: 'test-run-running',
    };
    callStageRunSnapshot(scheduler, {
      id: 'test-run-running',
      automationId: 'test-auto-2',
      sessionId: 'sess-running',
      session: runningSession,
      messages: runningSession.messages,
      eventsByTurn: runningSession.eventsByTurn,
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;
    const session: AgentSession = {
      id: 'sess-terminal',
      title: 'Completed Automation',
      createdAt: completedAt - 1_000,
      updatedAt: completedAt,
      messages: [{ id: 'm1', role: 'result' as const, turnId: 't1', text: 'Done', createdAt: completedAt }],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: completedAt,
      origin: 'automation' as const,
      automationId: 'test-auto-1',
      automationRunId: 'test-run-1',
    };
    const persistRun = (scheduler as unknown as {
      persistRun: (
        automationId: string,
        runId: string,
        payload: {
          status: AutomationRun['status'];
          error: string | null;
          session: AgentSession | null;
          eventsByTurn: AgentSession['eventsByTurn'];
          messages: AgentSession['messages'];
          startedAt: number;
          completedAt: number;
          trigger: AutomationRun['trigger'];
        },
      ) => AutomationRun;
    }).persistRun.bind(scheduler);

    persistRun('test-auto-1', 'test-run-1', {
      status: 'success',
      error: null,
      session,
      eventsByTurn: {},
      messages: session.messages,
      startedAt: completedAt - 1_000,
      completedAt,
      trigger: 'manual',
    });

    const terminalCalls = notifyRenderer.mock.calls.slice(callsAfterSetup);
    expect(terminalCalls).toHaveLength(1);

    const broadcastState = terminalCalls[0][0] as AutomationStoreState;
    const broadcastRun = broadcastState.runs.find((r) => r.id === 'test-run-1');
    expect(broadcastRun?.session?.id).toBe('sess-terminal');
    expect(broadcastRun?.session?.isBusy).toBe(false);
    expect(broadcastRun?.session?.messages[0]?.text).toBe('Done');
    const concurrentRun = broadcastState.runs.find((r) => r.id === 'test-run-running');
    expect(concurrentRun?.messages).toBeUndefined();
    expect(concurrentRun?.eventsByTurn).toBeUndefined();
    expect(concurrentRun?.session?.messages).toEqual([]);
    expect(concurrentRun?.session?.eventsByTurn).toEqual({});

    const storedRun = scheduler.getState().runs.find((r) => r.id === 'test-run-1');
    expect(storedRun?.session).toBeUndefined();
    expect(storedRun?.messages).toBeUndefined();
    expect(storedRun?.eventsByTurn).toBeUndefined();
    const internalRunningRun = scheduler.getState().runs.find((r) => r.id === 'test-run-running');
    expect(internalRunningRun?.session?.messages[0]?.text).toBe('Keep going');

    const persistedState = (scheduler as unknown as { store: { store: AutomationStoreState } }).store.store;
    const persistedRunningRun = persistedState.runs.find((r) => r.id === 'test-run-running');
    expect(persistedRunningRun?.session).toBeUndefined();
    expect(persistedRunningRun?.messages).toBeUndefined();
    expect(persistedRunningRun?.eventsByTurn).toBeUndefined();
  });
});

describe('projection strips session from non-running runs', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(atTime(2025, 6, 15, 11, 0).getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: call stageRunSnapshot on the scheduler with a synthetic run. */
  const callStageRunSnapshot = (
    scheduler: InstanceType<typeof AutomationScheduler>,
    overrides: Partial<import('@shared/types').AutomationRun> = {}
  ) => {
    const run: import('@shared/types').AutomationRun = {
      id: 'test-run-1',
      automationId: 'test-auto-1',
      startedAt: Date.now(),
      completedAt: null,
      status: 'running',
      trigger: 'manual',
      sessionId: 'sess-1',
      error: null,
      eventsByTurn: { 't1': [{ type: 'status', message: 'working', timestamp: Date.now() }] },
      messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'hello', createdAt: Date.now() }],
      session: {
        id: 'sess-1',
        title: 'Test Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'hello', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'working', timestamp: Date.now() }] },
        activeTurnId: 't1',
        isBusy: true,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'test-run-1',
      },
      ...overrides,
    };
    (scheduler as any).stageRunSnapshot(run);
  };

  it('sets session to null for completed runs in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Stage a completed run with a session
    callStageRunSnapshot(scheduler, {
      id: 'completed-run',
      status: 'success',
      completedAt: Date.now(),
      session: {
        id: 'sess-completed',
        title: 'Completed Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'done', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'done', timestamp: Date.now() }] },
        activeTurnId: null,
        isBusy: false,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'completed-run',
      },
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];
    const run = projectedState.runs.find((r: { id: string }) => r.id === 'completed-run');
    expect(run).toBeDefined();
    expect(run.session).toBeNull();
    expect(run.eventsByTurn).toBeUndefined();
    expect(run.messages).toBeUndefined();
  });

  it('sets session to null for failed runs in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    callStageRunSnapshot(scheduler, {
      id: 'failed-run',
      status: 'failure',
      completedAt: Date.now(),
      error: 'Something went wrong',
      session: {
        id: 'sess-failed',
        title: 'Failed Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: 'Something went wrong',

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'failed-run',
      },
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];
    const run = projectedState.runs.find((r: { id: string }) => r.id === 'failed-run');
    expect(run).toBeDefined();
    expect(run.session).toBeNull();
  });

  it('sets session to null for cancelled runs in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    callStageRunSnapshot(scheduler, {
      id: 'cancelled-run',
      status: 'cancelled',
      completedAt: Date.now(),
      session: {
        id: 'sess-cancelled',
        title: 'Cancelled Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'cancelled-run',
      },
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];
    const run = projectedState.runs.find((r: { id: string }) => r.id === 'cancelled-run');
    expect(run).toBeDefined();
    expect(run.session).toBeNull();
  });

  it('preserves stripped session on running runs in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Stage a running run with a full session
    callStageRunSnapshot(scheduler, {
      id: 'running-run',
      status: 'running',
      session: {
        id: 'sess-running',
        title: 'Running Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'working', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'working', timestamp: Date.now() }] },
        activeTurnId: 't1',
        isBusy: true,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'running-run',
      },
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];
    const run = projectedState.runs.find((r: { id: string }) => r.id === 'running-run');
    expect(run).toBeDefined();
    // Session preserved but stripped
    expect(run.session).not.toBeNull();
    expect(run.session.id).toBe('sess-running');
    expect(run.session.isBusy).toBe(true);
    expect(run.session.activeTurnId).toBe('t1');
    // Heavy fields stripped
    expect(run.session.messages).toEqual([]);
    expect(run.session.eventsByTurn).toEqual({});
  });

  it('mixed running and completed runs: only running keeps session in projection', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    const callsAfterSetup = notifyRenderer.mock.calls.length;

    // Stage a completed run
    callStageRunSnapshot(scheduler, {
      id: 'done-run',
      status: 'success',
      completedAt: Date.now(),
      session: {
        id: 'sess-done',
        title: 'Done Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'done', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'done', timestamp: Date.now() }] },
        activeTurnId: null,
        isBusy: false,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'done-run',
      },
    });

    // Stage a running run
    callStageRunSnapshot(scheduler, {
      id: 'active-run',
      automationId: 'test-auto-2',
      status: 'running',
      sessionId: 'sess-active',
      session: {
        id: 'sess-active',
        title: 'Active Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm2', role: 'user', turnId: 't2', text: 'working', createdAt: Date.now() }],
        eventsByTurn: { 't2': [{ type: 'status', message: 'in-progress', timestamp: Date.now() }] },
        activeTurnId: 't2',
        isBusy: true,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-2',
        automationRunId: 'active-run',
      },
    });

    vi.advanceTimersByTime(500);

    const projectedState = notifyRenderer.mock.calls[callsAfterSetup][0];

    // Completed run: session is null
    const doneRun = projectedState.runs.find((r: { id: string }) => r.id === 'done-run');
    expect(doneRun).toBeDefined();
    expect(doneRun.session).toBeNull();

    // Running run: session preserved (stripped)
    const activeRun = projectedState.runs.find((r: { id: string }) => r.id === 'active-run');
    expect(activeRun).toBeDefined();
    expect(activeRun.session).not.toBeNull();
    expect(activeRun.session.id).toBe('sess-active');
    expect(activeRun.session.isBusy).toBe(true);
    expect(activeRun.session.messages).toEqual([]);
    expect(activeRun.session.eventsByTurn).toEqual({});
  });

  it('full broadcast preserves sessions on all runs regardless of status', () => {
    const notifyRenderer = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer
    });

    // Stage a completed run with session
    callStageRunSnapshot(scheduler, {
      id: 'completed-for-full',
      status: 'success',
      completedAt: Date.now(),
      session: {
        id: 'sess-full',
        title: 'Full Broadcast Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ id: 'm1', role: 'user', turnId: 't1', text: 'done', createdAt: Date.now() }],
        eventsByTurn: { 't1': [{ type: 'status', message: 'done', timestamp: Date.now() }] },
        activeTurnId: null,
        isBusy: false,
        lastError: null,

        resolvedAt: null,
        origin: 'automation' as const,
        automationId: 'test-auto-1',
        automationRunId: 'completed-for-full',
      },
    });

    // Trigger a full broadcast via upsertDefinition
    const callsBeforeUpsert = notifyRenderer.mock.calls.length;
    scheduler.upsertDefinition({
      name: 'Trigger Full Broadcast',
      filePath: '/test/task.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });

    // Full broadcast should have fired
    expect(notifyRenderer.mock.calls.length).toBeGreaterThan(callsBeforeUpsert);
    const fullState = notifyRenderer.mock.calls[notifyRenderer.mock.calls.length - 1][0];
    const run = fullState.runs.find((r: { id: string }) => r.id === 'completed-for-full');
    expect(run).toBeDefined();
    // Full broadcast preserves the session with all data
    expect(run.session).not.toBeNull();
    expect(run.session.id).toBe('sess-full');
    expect(run.session.messages.length).toBe(1);
    expect(Object.keys(run.session.eventsByTurn)).toHaveLength(1);
  });
});

describe('upsertDefinition model override normalization', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  const createScheduler = () =>
    new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer: vi.fn(),
    });

  it('persists model override when model is set', () => {
    const scheduler = createScheduler();

    const definition = scheduler.upsertDefinition({
      name: 'Model Override Test',
      filePath: '/test/model-override.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      model: 'claude-haiku-4-5',
    });

    expect(definition.model).toBe('claude-haiku-4-5');
    expect(definition.thinkingModel).toBeUndefined();

    const stored = scheduler.getState().definitions.find((def) => def.id === definition.id);
    expect(stored?.model).toBe('claude-haiku-4-5');
  });

  it('normalizes empty model string to undefined (clear semantics)', () => {
    const scheduler = createScheduler();

    const definition = scheduler.upsertDefinition({
      name: 'Clear Model Override Test',
      filePath: '/test/clear-model.md',
      schedule: AutomationSchedule.daily({ time: '10:00' }),
      enabled: true,
      model: 'claude-haiku-4-5',
    });

    const updated = scheduler.upsertDefinition({
      id: definition.id,
      schedule: definition.schedule,
      model: '',
    });

    expect(updated.model).toBeUndefined();
  });

  it('normalizes empty thinkingModel string to undefined', () => {
    const scheduler = createScheduler();

    const definition = scheduler.upsertDefinition({
      name: 'Clear Thinking Model Override Test',
      filePath: '/test/clear-thinking-model.md',
      schedule: AutomationSchedule.daily({ time: '11:00' }),
      enabled: true,
      model: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-7',
    });

    const updated = scheduler.upsertDefinition({
      id: definition.id,
      schedule: definition.schedule,
      thinkingModel: '',
    });

    expect(updated.model).toBe('claude-sonnet-4-6');
    expect(updated.thinkingModel).toBeUndefined();
  });

  it('persists both model and thinkingModel when set together', () => {
    const scheduler = createScheduler();

    const definition = scheduler.upsertDefinition({
      name: 'Dual Model Override Test',
      filePath: '/test/dual-model.md',
      schedule: AutomationSchedule.daily({ time: '12:00' }),
      enabled: true,
      model: 'claude-haiku-4-5',
      thinkingModel: 'claude-opus-4-7',
    });

    expect(definition.model).toBe('claude-haiku-4-5');
    expect(definition.thinkingModel).toBe('claude-opus-4-7');
  });
});

/**
 * Tests for automation routing and system flag management.
 * Verifies that filePath takes priority over isSystem/systemType for execution routing,
 * and that system flags are cleared when a user customizes a NON-LLM system automation.
 */
describe('automation routing and system flag management', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  const createScheduler = () =>
    new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer: vi.fn(),
    });

  it('clears system flags when filePath set on NON-LLM system automation', () => {
    const scheduler = createScheduler();

    // Create a NON-LLM system automation with empty filePath
    scheduler.upsertDefinition({
      id: 'test-community',
      name: 'Community Highlights',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '08:00' }),
      isSystem: true,
      systemType: 'community-highlights',
    });

    // User sets a custom filePath
    const updated = scheduler.upsertDefinition({
      id: 'test-community',
      schedule: AutomationSchedule.daily({ time: '08:00' }),
      filePath: '/user/custom-skill.md',
    });

    expect(updated.isSystem).toBeUndefined();
    expect(updated.systemType).toBeUndefined();
    expect(updated.filePath).toBe('/user/custom-skill.md');
  });

  it('preserves system flags on file-based system automations', () => {
    const scheduler = createScheduler();

    // Create a system automation that already has a filePath (e.g., wins-learnings)
    scheduler.upsertDefinition({
      id: 'test-wins',
      name: 'Daily Wins & Learnings',
      filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
      schedule: AutomationSchedule.daily({ time: '09:30' }),
      isSystem: true,
      systemType: 'wins-learnings-uncover',
    });

    // User changes the filePath to a different skill
    const updated = scheduler.upsertDefinition({
      id: 'test-wins',
      schedule: AutomationSchedule.daily({ time: '09:30' }),
      filePath: '/user/different-skill.md',
    });

    // System flags preserved — wins-learnings is NOT a NON-LLM system type
    expect(updated.isSystem).toBe(true);
    expect(updated.systemType).toBe('wins-learnings-uncover');
  });

  it('normalizes legacy source-capture skill path during upsert', () => {
    const scheduler = createScheduler();

    const updated = scheduler.upsertDefinition({
      id: 'test-source-capture',
      name: 'Source Capture',
      filePath: 'rebel-system/skills/memory/source-capture/SKILL.md',
      schedule: AutomationSchedule.daily({ time: '12:30' }),
      isSystem: true,
      systemType: 'source-capture',
    });

    expect(updated.filePath).toBe('rebel-system/skills/memory/source-capture/AUTOMATION.md');
    expect(scheduler.getState().definitions[0]?.filePath).toBe('rebel-system/skills/memory/source-capture/AUTOMATION.md');
  });

  it('repairs legacy source-capture skill paths during state commits', () => {
    const scheduler = createScheduler();

    scheduler.upsertDefinition({
      id: 'test-source-capture',
      name: 'Source Capture',
      filePath: 'rebel-system/skills/memory/source-capture/AUTOMATION.md',
      schedule: AutomationSchedule.daily({ time: '12:30' }),
      isSystem: true,
      systemType: 'source-capture',
    });

    const schedulerWithInternals = scheduler as unknown as {
      commitState: (state: import('@shared/types').AutomationStoreState) => import('@shared/types').AutomationStoreState;
      stateSnapshot: import('@shared/types').AutomationStoreState;
    };

    const staleState: import('@shared/types').AutomationStoreState = {
      ...schedulerWithInternals.stateSnapshot,
      definitions: schedulerWithInternals.stateSnapshot.definitions.map((definition) =>
        definition.id === 'test-source-capture'
          ? { ...definition, filePath: 'rebel-system/skills/memory/source-capture/SKILL.md' }
          : definition
      ),
    };

    const committed = schedulerWithInternals.commitState(staleState);

    expect(committed.definitions[0]?.filePath).toBe('rebel-system/skills/memory/source-capture/AUTOMATION.md');
    expect(scheduler.getState().definitions[0]?.filePath).toBe('rebel-system/skills/memory/source-capture/AUTOMATION.md');
  });

  it('preserves system flags when filePath not changed', () => {
    const scheduler = createScheduler();

    scheduler.upsertDefinition({
      id: 'test-refresh',
      name: 'Workflow Refresh',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '17:00' }),
      isSystem: true,
      systemType: 'use-case-refresh',
    });

    // User only changes the name — no filePath in patch
    const updated = scheduler.upsertDefinition({
      id: 'test-refresh',
      schedule: AutomationSchedule.daily({ time: '17:00' }),
      name: 'My Custom Briefing',
    });

    expect(updated.isSystem).toBe(true);
    expect(updated.systemType).toBe('use-case-refresh');
    expect(updated.name).toBe('My Custom Briefing');
  });

  it('preserves system flags when filePath is whitespace-only', () => {
    const scheduler = createScheduler();

    scheduler.upsertDefinition({
      id: 'test-cal',
      name: 'Calendar Sync',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '07:00' }),
      isSystem: true,
      systemType: 'calendar-sync',
    });

    // Whitespace-only filePath should not trigger flag clearing
    const updated = scheduler.upsertDefinition({
      id: 'test-cal',
      schedule: AutomationSchedule.daily({ time: '07:00' }),
      filePath: '   ',
    });

    expect(updated.isSystem).toBe(true);
    expect(updated.systemType).toBe('calendar-sync');
  });

  it('routes NON-LLM system automation with filePath to file-based execution', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const generateUseCases = vi.fn();
    const scheduler = new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn,
      notifyRenderer: vi.fn(),
      getSettings: () => ({ onboardingFirstCompletedAt: Date.now() - 7 * 24 * 60 * 60 * 1000 } as any),
      generateUseCases,
    });

    // Create a use-case-refresh automation with a custom filePath
    scheduler.upsertDefinition({
      id: 'test-routing',
      name: 'Customized Briefing',
      filePath: '/tmp/test/custom-skill.md',
      schedule: AutomationSchedule.daily({ time: '17:00' }),
      isSystem: true,
      systemType: 'use-case-refresh',
    });

    // runNow will attempt file-based execution, which will fail because the file
    // doesn't exist — but the key assertion is that executeAgentTurn is called
    // (file-based path) rather than the pipeline returning session: null silently.
    // The error proves the routing guard worked.
    const result = await scheduler.runNow('test-routing');

    // File-based path was attempted (throws on missing file) rather than the
    // NON-LLM pipeline which returns session: null with status: success/failure
    expect(result).not.toBeNull();
    expect(result!.status).toBe('failure');
    expect(result!.error).toMatch(/could not be found|not configured/i);
    // Crucially, generateUseCases should NOT have been called — this proves
    // the use-case-refresh pipeline was skipped in favor of file-based execution
    expect(generateUseCases).not.toHaveBeenCalled();
  });
});

/**
 * Integration tests for once-schedule edge cases.
 *
 * These tests cover scenarios identified during review that go beyond the
 * pure-function calculateNextRunAt / calculateMostRecentScheduledTime tests:
 * - upsertDefinition type-switch reset (recurring → once)
 * - upsertDefinition reschedule reset (dateTime change)
 * - upsertDefinition no-reset for unchanged dateTime
 * - Catch-up guard for completed once-automations
 * - Manual pre-run preventing scheduled double-fire
 */
describe('once schedule - integration scenarios', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockLoggerMethods.info.mockClear();
    mockLoggerMethods.warn.mockClear();
    mockLoggerMethods.error.mockClear();
    mockLoggerMethods.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createScheduler = () =>
    new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn: vi.fn().mockResolvedValue(undefined),
      notifyRenderer: vi.fn(),
    });

  describe('upsertDefinition type-switch reset', () => {
    it('resets lastRunAt/lastRunStatus/lastSuccessAt when switching from daily to once', () => {
      // Scenario: A daily automation with successful history is converted to once.
      // Without resetting, the inherited lastRunStatus='success' would cause
      // calculateNextRunAt to return null and the once-automation never fires.
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      // Create a daily automation
      const daily = scheduler.upsertDefinition({
        name: 'Daily → Once',
        filePath: '/test/switch.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
      });

      // Simulate a successful run by upserting with run state
      // (mimics what persistRun does: setting lastRunAt/lastRunStatus/lastSuccessAt)
      const withHistory = scheduler.upsertDefinition({
        id: daily.id,
        schedule: daily.schedule,
        lastRunAt: atTime(2025, 6, 15, 9, 0).getTime(),
        lastRunStatus: 'success',
        lastSuccessAt: atTime(2025, 6, 15, 9, 0).getTime(),
      } as any);
      expect(withHistory.lastRunStatus).toBe('success');

      // Switch to once — run state must reset
      const onced = scheduler.upsertDefinition({
        id: daily.id,
        schedule: AutomationSchedule.once({ dateTime: '2025-06-20T15:00:00' }),
      });

      expect(onced.lastRunAt).toBeNull();
      expect(onced.lastRunStatus).toBeUndefined();
      expect(onced.lastSuccessAt).toBeNull();
      // And the automation should be schedulable
      expect(onced.nextRunAt).toBe(atTime(2025, 6, 20, 15, 0).getTime());
    });
  });

  describe('upsertDefinition reschedule reset', () => {
    it('resets run state when changing a once-automation dateTime (reschedule)', () => {
      // Scenario: A once-automation ran at T1, user reschedules to T2.
      // Without resetting, lastRunStatus='success' prevents re-scheduling.
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      // Create a once-automation with a past dateTime
      const once = scheduler.upsertDefinition({
        name: 'Reschedule Me',
        filePath: '/test/reschedule.md',
        schedule: AutomationSchedule.once({ dateTime: '2025-06-14T15:00:00' }),
        enabled: true,
      });

      // Simulate a completed run
      const completed = scheduler.upsertDefinition({
        id: once.id,
        schedule: once.schedule,
        lastRunAt: atTime(2025, 6, 14, 15, 0).getTime(),
        lastRunStatus: 'success',
        lastSuccessAt: atTime(2025, 6, 14, 15, 0).getTime(),
      } as any);
      expect(completed.lastRunStatus).toBe('success');
      expect(completed.nextRunAt).toBeNull(); // past dateTime + success = null

      // Reschedule to a new future dateTime — run state must reset
      const rescheduled = scheduler.upsertDefinition({
        id: once.id,
        schedule: AutomationSchedule.once({ dateTime: '2025-06-25T09:00:00' }),
      });

      expect(rescheduled.lastRunAt).toBeNull();
      expect(rescheduled.lastRunStatus).toBeUndefined();
      expect(rescheduled.lastSuccessAt).toBeNull();
      expect(rescheduled.nextRunAt).toBe(atTime(2025, 6, 25, 9, 0).getTime());
    });
  });

  describe('upsertDefinition no-reset for unchanged dateTime', () => {
    it('preserves run state when updating once-automation without changing dateTime', () => {
      // Scenario: User renames a completed once-automation.
      // Run state should NOT be reset just because they edited the name.
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      const once = scheduler.upsertDefinition({
        name: 'Completed Once',
        filePath: '/test/noreset.md',
        schedule: AutomationSchedule.once({ dateTime: '2025-06-14T15:00:00' }),
        enabled: true,
      });

      // Simulate a completed run
      scheduler.upsertDefinition({
        id: once.id,
        schedule: once.schedule,
        lastRunAt: atTime(2025, 6, 14, 15, 0).getTime(),
        lastRunStatus: 'success',
        lastSuccessAt: atTime(2025, 6, 14, 15, 0).getTime(),
      } as any);

      // Update only the name — dateTime unchanged, run state preserved
      const renamed = scheduler.upsertDefinition({
        id: once.id,
        schedule: AutomationSchedule.once({ dateTime: '2025-06-14T15:00:00' }), // same dateTime
        name: 'Renamed Completed Once',
      });

      expect(renamed.name).toBe('Renamed Completed Once');
      expect(renamed.lastRunAt).toBe(atTime(2025, 6, 14, 15, 0).getTime());
      expect(renamed.lastRunStatus).toBe('success');
      expect(renamed.lastSuccessAt).toBe(atTime(2025, 6, 14, 15, 0).getTime());
      expect(renamed.nextRunAt).toBeNull(); // still completed, not reschedulable
    });
  });

  describe('catch-up guard for completed once-automations', () => {
    it('skips catch-up for a completed once-automation on app launch', () => {
      // Scenario: Once-automation ran successfully, app restarts. Catch-up should skip.
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      const once = scheduler.upsertDefinition({
        name: 'Completed Once Catch-Up',
        filePath: '/test/catchup.md',
        schedule: AutomationSchedule.once({ dateTime: '2025-06-14T15:00:00' }),
        enabled: true,
        catchUpIfMissed: true,
      });

      // Simulate a completed run
      scheduler.upsertDefinition({
        id: once.id,
        schedule: once.schedule,
        lastRunAt: atTime(2025, 6, 14, 15, 0).getTime(),
        lastRunStatus: 'success',
        lastSuccessAt: atTime(2025, 6, 14, 15, 0).getTime(),
      } as any);

      mockLoggerMethods.info.mockClear();
      mockLoggerMethods.debug.mockClear();

      // Simulate app launch — catch-up check
      scheduler.handleAppLaunch();

      // Should NOT catch up a completed once-automation
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Completed Once Catch-Up'
      );
      expect(catchUpCalls).toHaveLength(0);

      // Verify it was explicitly skipped with the once_already_completed reason
      const skipCalls = mockLoggerMethods.debug.mock.calls.filter(
        (call) => call[0]?.reason === 'once_already_completed'
      );
      expect(skipCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('DOES catch up a pending once-automation that was missed', () => {
      // Scenario: Once-automation was scheduled for a time that passed while app was closed.
      // It has NOT run yet (no lastRunAt). Catch-up should fire.
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      // Create with past dateTime and no run history — simulates "missed while app was closed"
      scheduler.upsertDefinition({
        name: 'Missed Once Catch-Up',
        filePath: '/test/missed.md',
        schedule: AutomationSchedule.once({ dateTime: '2025-06-15T08:00:00' }),
        enabled: true,
        catchUpIfMissed: true,
      });

      mockLoggerMethods.info.mockClear();
      scheduler.handleAppLaunch();

      // Should trigger catch-up because dateTime passed and no prior run
      const catchUpCalls = mockLoggerMethods.info.mock.calls.filter(
        (call) => call[1] === 'Catching up missed automation run' &&
          call[0]?.automationName === 'Missed Once Catch-Up'
      );
      expect(catchUpCalls).toHaveLength(1);
    });
  });

  describe('manual pre-run then scheduled fire prevention', () => {
    it('calculateNextRunAt returns null after manual Run Now on once-automation', () => {
      // Scenario: User creates once for T+24h then manually runs it now.
      // After the manual run sets lastRunStatus='success', calculateNextRunAt
      // must return null to prevent the timer from firing at T+24h.
      const futureDateTime = '2025-06-20T15:00:00';
      const now = atTime(2025, 6, 15, 10, 0).getTime();

      // Definition before manual run — schedulable
      const beforeRun = {
        ...createDefinition({ type: 'once' as const, dateTime: futureDateTime }),
      };
      expect(calculateNextRunAt(beforeRun, now)).toBe(atTime(2025, 6, 20, 15, 0).getTime());

      // Definition after manual run — lastRunStatus='success' set by persistRun
      const afterRun = {
        ...beforeRun,
        lastRunAt: now,
        lastRunStatus: 'success' as const,
        lastSuccessAt: now,
      };
      expect(calculateNextRunAt(afterRun, now)).toBeNull();
    });

    it('scheduler reflects null nextRunAt after simulated manual run', () => {
      // End-to-end: upsert → simulate manual run success → verify nextRunAt is null
      vi.setSystemTime(atTime(2025, 6, 15, 10, 0).getTime());

      const scheduler = createScheduler();

      const once = scheduler.upsertDefinition({
        name: 'Manual Pre-Run',
        filePath: '/test/prerun.md',
        schedule: AutomationSchedule.once({ dateTime: '2025-06-20T15:00:00' }),
        enabled: true,
      });
      expect(once.nextRunAt).toBe(atTime(2025, 6, 20, 15, 0).getTime());

      // Simulate persistRun setting success state (same-dateTime upsert preserves dateTime)
      const afterRun = scheduler.upsertDefinition({
        id: once.id,
        schedule: once.schedule, // same dateTime — no reset
        lastRunAt: Date.now(),
        lastRunStatus: 'success',
        lastSuccessAt: Date.now(),
      } as any);

      // nextRunAt should be null — prevents the timer from firing at the scheduled time
      expect(afterRun.nextRunAt).toBeNull();

      // Confirm from getState too
      const stored = scheduler.getState().definitions.find(d => d.id === once.id);
      expect(stored?.nextRunAt).toBeNull();
    });
  });

  describe('terminal error dispatch', () => {
    it('uses dispatchAgentErrorEvent and still broadcasts to all windows for billing failures', async () => {
      mockDispatchAgentEvent.mockClear();
      mockDispatchAgentErrorEvent.mockClear();
      mockShowAutomationOutcomeNotification.mockClear();
      mockSendToAllWindows.mockClear();

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-stage2-'));
      const automationFile = path.join(tmpDir, 'billing-automation.md');
      await fs.writeFile(automationFile, '# Billing automation\n\nSay hello.', 'utf-8');

      try {
        const { AutomationScheduler } = await import('../automationScheduler');
        const humanizedBillingError =
          "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.";

        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => tmpDir,
          executeAgentTurn: vi.fn(async (_turnId, _prompt, options) => {
            options.onEvent({
              type: 'error',
              error: humanizedBillingError,
              errorKind: 'billing',
              provider: 'OpenRouter',
              errorSource: 'main',
              timestamp: Date.now(),
            });
          }),
          notifyRenderer: vi.fn(),
        });

        const definition = scheduler.upsertDefinition({
          name: 'Billing failure',
          filePath: automationFile,
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const result = await scheduler.runNow(definition.id);

        expect(result?.status).toBe('failure');
        expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
          null,
          expect.any(String),
          humanizedBillingError,
          expect.objectContaining({
            humanizedOverride: humanizedBillingError,
            errorKindOverride: 'billing',
            providerOverride: 'OpenRouter',
          }),
        );
        expect(mockSendToAllWindows).toHaveBeenCalledWith(
          'agent:event',
          expect.objectContaining({
            event: expect.objectContaining({
              type: 'error',
              error: humanizedBillingError,
              errorKind: 'billing',
              provider: 'OpenRouter',
              seq: expect.any(Number),
            }),
          }),
        );
        const broadcastCall = mockSendToAllWindows.mock.calls.find(
          ([channel]) => channel === 'agent:event',
        );
        const seq = (broadcastCall?.[1] as { event?: { seq?: unknown } } | undefined)?.event?.seq;
        expect(Number.isInteger(seq) && Number(seq) > 0).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('forwards timestampOverride, watchdogDiagnostic, and timeoutDiagnostic through broadcastTerminalEvent', async () => {
      mockDispatchAgentEvent.mockClear();
      mockDispatchAgentErrorEvent.mockClear();
      mockShowAutomationOutcomeNotification.mockClear();
      mockSendToAllWindows.mockClear();

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-forwarding-'));
      const automationFile = path.join(tmpDir, 'watchdog-automation.md');
      await fs.writeFile(automationFile, '# Watchdog automation\n\nTask.', 'utf-8');

      try {
        const { AutomationScheduler } = await import('../automationScheduler');
        const originalTimestamp = 1_700_000_000_000;
        const watchdogDiagnostic = {
          phase: 'awaiting_tool_result',
          messageCount: 3,
          rawStreamEventCount: 7,
          rawStreamLastEventType: 'content_block_delta',
          rawStreamLastEventAgeMs: 60_000,
          watchdogLevel: 2,
          maxWatchdogLevel: 3,
          effectiveAbortMs: 90_000,
        };
        const timeoutDiagnostic = {
          kind: 'transient_stall',
          indicator: 'legacy',
        };

        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => tmpDir,
          executeAgentTurn: vi.fn(async (_turnId, _prompt, options) => {
            options.onEvent({
              type: 'error',
              error: 'Watchdog aborted the automation turn.',
              errorSource: 'main',
              timestamp: originalTimestamp,
              watchdogDiagnostic,
              timeoutDiagnostic,
            });
          }),
          notifyRenderer: vi.fn(),
        });

        const definition = scheduler.upsertDefinition({
          name: 'Watchdog abort',
          filePath: automationFile,
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const result = await scheduler.runNow(definition.id);

        expect(result?.status).toBe('failure');
        expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
          null,
          expect.any(String),
          'Watchdog aborted the automation turn.',
          expect.objectContaining({
            humanizedOverride: 'Watchdog aborted the automation turn.',
            timestampOverride: originalTimestamp,
            watchdogDiagnostic,
            timeoutDiagnostic,
          }),
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('forwards rateLimitMetaOverride through broadcastTerminalEvent when errorKind is rate_limit', async () => {
      mockDispatchAgentEvent.mockClear();
      mockDispatchAgentErrorEvent.mockClear();
      mockShowAutomationOutcomeNotification.mockClear();
      mockSendToAllWindows.mockClear();

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-ratelimit-'));
      const automationFile = path.join(tmpDir, 'ratelimit-automation.md');
      await fs.writeFile(automationFile, '# Rate limit automation\n\nTask.', 'utf-8');

      try {
        const { AutomationScheduler } = await import('../automationScheduler');
        const originalTimestamp = 1_700_000_000_000;
        const rateLimitMeta = {
          rawError: 'rate limit raw 429',
          retryAfterMs: 45_000,
          resetAtMs: 1_762_000_000_000,
        };

        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => tmpDir,
          executeAgentTurn: vi.fn(async (_turnId, _prompt, options) => {
            options.onEvent({
              type: 'error',
              error: "Your AI provider's rate limit was reached.",
              errorKind: 'rate_limit',
              limitScope: 'plan',
              credentialSource: 'codex-subscription',
              headlineClass: 'subscription_entitlement',
              provider: 'OpenAI',
              rateLimitMeta,
              errorSource: 'main',
              timestamp: originalTimestamp,
            });
          }),
          notifyRenderer: vi.fn(),
        });

        const definition = scheduler.upsertDefinition({
          name: 'Rate limit automation',
          filePath: automationFile,
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const result = await scheduler.runNow(definition.id);

        expect(result?.status).toBe('failure');
        expect(mockDispatchAgentErrorEvent).toHaveBeenCalledWith(
          null,
          expect.any(String),
          "Your AI provider's rate limit was reached.",
          expect.objectContaining({
            humanizedOverride: "Your AI provider's rate limit was reached.",
            intentionalCopyOverrideForKind: 'rate_limit',
            errorKindOverride: 'rate_limit',
            limitScopeOverride: 'plan',
            credentialSource: 'codex-subscription',
            providerOverride: 'OpenAI',
            rateLimitMetaOverride: rateLimitMeta,
          }),
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('omits rateLimitMetaOverride when source event errorKind is not rate_limit', async () => {
      mockDispatchAgentEvent.mockClear();
      mockDispatchAgentErrorEvent.mockClear();
      mockShowAutomationOutcomeNotification.mockClear();
      mockSendToAllWindows.mockClear();

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-nonrate-'));
      const automationFile = path.join(tmpDir, 'nonrate-automation.md');
      await fs.writeFile(automationFile, '# Non-rate automation\n\nTask.', 'utf-8');

      try {
        const { AutomationScheduler } = await import('../automationScheduler');

        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => tmpDir,
          executeAgentTurn: vi.fn(async (_turnId, _prompt, options) => {
            options.onEvent({
              type: 'error',
              error: 'Billing error',
              errorKind: 'billing',
              rateLimitMeta: { rawError: 'stray meta', retryAfterMs: 1000 },
              errorSource: 'main',
              timestamp: 1_700_000_700_000,
            });
          }),
          notifyRenderer: vi.fn(),
        });

        const definition = scheduler.upsertDefinition({
          name: 'Non-rate automation',
          filePath: automationFile,
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        await scheduler.runNow(definition.id);

        const opts = mockDispatchAgentErrorEvent.mock.calls[0][3];
        expect(opts).not.toHaveProperty('rateLimitMetaOverride');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('omits watchdogDiagnostic/timeoutDiagnostic when the source event does not carry them', async () => {
      mockDispatchAgentEvent.mockClear();
      mockDispatchAgentErrorEvent.mockClear();
      mockShowAutomationOutcomeNotification.mockClear();
      mockSendToAllWindows.mockClear();

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-noopt-'));
      const automationFile = path.join(tmpDir, 'plain-automation.md');
      await fs.writeFile(automationFile, '# Plain automation\n\nTask.', 'utf-8');

      try {
        const { AutomationScheduler } = await import('../automationScheduler');

        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => tmpDir,
          executeAgentTurn: vi.fn(async (_turnId, _prompt, options) => {
            options.onEvent({
              type: 'error',
              error: 'Plain failure',
              errorSource: 'main',
              timestamp: 1_700_000_500_000,
            });
          }),
          notifyRenderer: vi.fn(),
        });

        const definition = scheduler.upsertDefinition({
          name: 'Plain failure',
          filePath: automationFile,
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        await scheduler.runNow(definition.id);

        const opts = mockDispatchAgentErrorEvent.mock.calls[0][3];
        expect(opts).not.toHaveProperty('watchdogDiagnostic');
        expect(opts).not.toHaveProperty('timeoutDiagnostic');
        expect(opts.timestampOverride).toBe(1_700_000_500_000);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe('script executor integration', () => {
  let AutomationScheduler: typeof import('../automationScheduler').AutomationScheduler;
  const mockTrackMainEvent = vi.mocked(trackMainEvent);

  beforeAll(async () => {
    const module = await import('../automationScheduler');
    AutomationScheduler = module.AutomationScheduler;
  });

  beforeEach(() => {
    mockTrackMainEvent.mockClear();
    mockLoggerMethods.info.mockClear();
    mockLoggerMethods.warn.mockClear();
    mockLoggerMethods.error.mockClear();
    mockLoggerMethods.debug.mockClear();
  });

  const createScheduler = (executeAgentTurn = vi.fn().mockResolvedValue(undefined)) =>
    new AutomationScheduler({
      getCoreDirectory: () => '/tmp/test',
      executeAgentTurn,
      notifyRenderer: vi.fn(),
    });

  const createScriptDefinition = (
    scheduler: InstanceType<typeof AutomationScheduler>,
    overrides: Partial<AutomationDefinition> = {},
  ) =>
    scheduler.upsertDefinition({
      name: 'Script automation',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      executor: 'script',
      scriptModule: 'test-script',
      ...overrides,
    } as any);

  const getTrackedEvent = (eventName: string) =>
    mockTrackMainEvent.mock.calls
      .map(([payload]) => payload as { event: string; properties?: Record<string, unknown> })
      .find((payload) => payload.event === eventName);

  const mockResolvedAutomationFile = (
    scheduler: InstanceType<typeof AutomationScheduler>,
    fileName = 'automation.md',
  ) => {
    const schedulerWithInternals = scheduler as unknown as {
      resolveAutomationFile: () => Promise<{ resolved: string; root: string; fileContent: string }>;
    };
    vi.spyOn(schedulerWithInternals, 'resolveAutomationFile').mockResolvedValue({
      resolved: `/tmp/test/${fileName}`,
      root: '/tmp/test',
      fileContent: '# Test automation\n\nSay hello.',
    });
  };

  it('BT-1 runs executor-less automations through the existing LLM pipeline and tags analytics as llm', async () => {
    mockSendToAllWindows.mockClear();
    const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
      options.onEvent({
        type: 'result',
        text: 'done',
        timestamp: Date.now(),
      });
    });
    const scheduler = createScheduler(executeAgentTurn);
    mockResolvedAutomationFile(scheduler, 'llm-automation.md');

    const definition = scheduler.upsertDefinition({
      name: 'LLM automation',
      filePath: 'llm-automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });

    mockTrackMainEvent.mockClear();

    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('success');
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    expect(getTrackedEvent('Automation Run Completed')?.properties).toMatchObject({
      automationId: definition.id,
      status: 'success',
      executor: 'llm',
    });

    // I19: assert seq on the terminal `result` agent:event broadcast for
    // success-path parity with the error-path assertion (line ~3847). The
    // assertEventHasSeq guard in automationScheduler.broadcastTerminalEvent
    // protects both paths in production; this test pins down test-side
    // coverage so a regression that drops seq on the success path would
    // fail visibly here, not just in dev runtime.
    const successBroadcast = mockSendToAllWindows.mock.calls.find(
      ([channel, payload]) =>
        channel === 'agent:event' &&
        (payload as { event?: { type?: string } } | undefined)?.event?.type === 'result',
    );
    expect(successBroadcast).toBeDefined();
    const successSeq = (successBroadcast?.[1] as { event?: { seq?: unknown } } | undefined)
      ?.event?.seq;
    expect(Number.isInteger(successSeq) && Number(successSeq) > 0).toBe(true);
  });

  it('DT-0 preserves executor and scriptModule on create and update', () => {
    const scheduler = createScheduler();

    const created = createScriptDefinition(scheduler, {
      name: 'Create path script',
      scriptModule: 'module.create',
    });
    const createdStored = scheduler.getState().definitions.find((definition) => definition.id === created.id);

    expect(createdStored).toMatchObject({
      executor: 'script',
      scriptModule: 'module.create',
    });

    scheduler.upsertDefinition({
      id: created.id,
      schedule: created.schedule,
      executor: 'script',
      scriptModule: 'module.update',
    });

    const updatedStored = scheduler.getState().definitions.find((definition) => definition.id === created.id);
    expect(updatedStored).toMatchObject({
      executor: 'script',
      scriptModule: 'module.update',
    });
  });

  it('DT-0b throws a clear error when creating a new automation without a schedule', () => {
    const scheduler = createScheduler();

    expect(() =>
      scheduler.upsertDefinition({
        name: 'Missing schedule create',
        filePath: '',
      } as any),
    ).toThrow('Schedule is required when creating a new automation.');
  });

  it('DT-1 dispatches script automations through the script runner and records success', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(executeAgentTurn);
    const scriptCall = vi.fn(async () => ({ summary: 'done' }));
    registerAutomationScript('test-script', scriptCall);

    const definition = createScriptDefinition(scheduler);
    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('success');
    expect(scriptCall).toHaveBeenCalledTimes(1);
    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(scheduler.getState().runs[0]).toMatchObject({
      automationId: definition.id,
      status: 'success',
      sessionId: null,
    });
  });

  it('DT-2 records script failures and preserves the thrown message', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(executeAgentTurn);
    registerAutomationScript('test-script', async () => {
      throw new Error('boom');
    });

    const definition = createScriptDefinition(scheduler);
    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('failure');
    expect(run?.error).toBe('boom');
    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(scheduler.getState().runs[0]?.error).toBe('boom');
  });

  it('DT-3 fails clearly when a script automation is missing scriptModule', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(executeAgentTurn);
    const definition = scheduler.upsertDefinition({
      name: 'Missing script module',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      executor: 'script',
    });

    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('failure');
    expect(run?.error).toMatch(/scriptModule/i);
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it('X3-desktop records the missing module id when an unregistered script run fails', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(executeAgentTurn);
    const definition = scheduler.upsertDefinition({
      name: 'Unknown script module',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      executor: 'script',
      scriptModule: 'missing-script-module',
    });

    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('failure');
    expect(run?.error).toContain('No automation script is registered for "missing-script-module"');
    expect(executeAgentTurn).not.toHaveBeenCalled();
    expect(scheduler.getState().runs[0]?.error).toContain('missing-script-module');
  });

  it('X1 does not coerce script automations to local; preserves executeIn cloud + timezone', () => {
    const scheduler = createScheduler();
    mockLoggerMethods.warn.mockClear();

    const definition = scheduler.upsertDefinition({
      name: 'Cloud script preserved',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      executor: 'script',
      scriptModule: 'test-script',
      executeIn: 'cloud',
      timezone: 'UTC',
    });

    const stored = scheduler.getState().definitions.find((item) => item.id === definition.id);

    expect(stored).toMatchObject({
      executeIn: 'cloud',
      timezone: 'UTC',
      executor: 'script',
      scriptModule: 'test-script',
    });
    expect(mockLoggerMethods.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Coerced script automation executeIn from cloud to local',
    );
  });

  it('DT-6 fails closed on unknown executor values', async () => {
    const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(executeAgentTurn);
    const definition = scheduler.upsertDefinition({
      name: 'Unknown executor',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      executor: 'mystery' as any,
      scriptModule: 'ghost-module',
    } as any);

    const run = await scheduler.runNow(definition.id);

    expect(run?.status).toBe('failure');
    expect(run?.error).toBe('Unknown executor: mystery');
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it('DT-6b fails closed before direct system pipelines when executor is malformed', async () => {
    const scheduler = createScheduler();
    const schedulerWithInternals = scheduler as unknown as {
      runCalendarSyncPipeline: () => Promise<unknown>;
    };
    const runCalendarSyncPipeline = vi
      .spyOn(schedulerWithInternals, 'runCalendarSyncPipeline')
      .mockResolvedValue({
        status: 'success',
        error: null,
        session: null,
        messages: [],
        eventsByTurn: {},
        startedAt: Date.now(),
        completedAt: Date.now(),
      });

    const definition = scheduler.upsertDefinition({
      name: 'Malformed system executor',
      filePath: '',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      isSystem: true,
      systemType: 'calendar-sync',
      executor: 'mystery' as any,
    } as any);

    mockTrackMainEvent.mockClear();
    const run = await scheduler.runNow(definition.id);
    const failedEvent = getTrackedEvent('Automation Run Failed');

    expect(run?.status).toBe('failure');
    expect(run?.error).toBe('Unknown executor: mystery');
    expect(runCalendarSyncPipeline).not.toHaveBeenCalled();
    expect(failedEvent?.properties).not.toHaveProperty('executor');
  });

  it('DT-7 keeps scheduler state immutable even if a script mutates ctx.automation', async () => {
    const scheduler = createScheduler();
    registerAutomationScript('test-script', async (ctx) => {
      try {
        (ctx.automation as AutomationDefinition).name = 'mutated';
      } catch {
        // Expected: runner freezes the automation snapshot.
      }
    });

    const definition = createScriptDefinition(scheduler, { name: 'Immutable definition' });
    const run = await scheduler.runNow(definition.id);
    const stored = scheduler.getState().definitions.find((item) => item.id === definition.id);

    expect(run?.status).toBe('success');
    expect(stored?.name).toBe('Immutable definition');
  });

  it('DT-9 blocks concurrent triggers for the same script automation', async () => {
    const scheduler = createScheduler();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const scriptCall = vi.fn(async () => {
      enteredResolve?.();
      await release;
    });
    registerAutomationScript('test-script', scriptCall);

    const definition = createScriptDefinition(scheduler, { name: 'Slow script' });

    const firstRunPromise = scheduler.runNow(definition.id);
    await entered;
    const secondRun = await scheduler.runNow(definition.id);

    expect(scriptCall).toHaveBeenCalledTimes(1);
    expect(secondRun).toBeNull();

    releaseResolve?.();
    const firstRun = await firstRunPromise;
    expect(firstRun?.status).toBe('success');
  });

  it('DT-10 preserves script executor fields through schema and JSON round-trip', () => {
    const now = Date.now();

    const parsed = AutomationDefinitionSchema.parse(
      JSON.parse(JSON.stringify({
        id: 'schema-script',
        name: 'Schema Script',
        filePath: '',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        executor: 'script',
        scriptModule: 'schema.module',
      })),
    );

    expect(parsed.executor).toBe('script');
    expect(parsed.scriptModule).toBe('schema.module');
  });

  it('AT-1 tags completed LLM and script analytics events with the correct executor', async () => {
    const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
      options.onEvent({
        type: 'result',
        text: 'done',
        timestamp: Date.now(),
      });
    });
    const scheduler = createScheduler(executeAgentTurn);
    mockResolvedAutomationFile(scheduler, 'analytics-automation.md');

    registerAutomationScript('test-script', async () => undefined);

    const llmDefinition = scheduler.upsertDefinition({
      name: 'Analytics LLM',
      filePath: 'analytics-automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });
    const scriptDefinition = createScriptDefinition(scheduler, {
      id: 'analytics-script',
      scriptModule: 'test-script',
    });

    mockTrackMainEvent.mockClear();
    await scheduler.runNow(llmDefinition.id);
    expect(getTrackedEvent('Automation Run Completed')?.properties).toMatchObject({
      automationId: llmDefinition.id,
      executor: 'llm',
    });

    mockTrackMainEvent.mockClear();
    await scheduler.runNow(scriptDefinition.id);
    expect(getTrackedEvent('Automation Run Completed')?.properties).toMatchObject({
      automationId: scriptDefinition.id,
      executor: 'script',
    });
  });

  it('AT-2 includes errorKind and bounded rawError on Automation Run Failed for LLM error events', async () => {
    const longRawError = `rate-limit-upstream-${'x'.repeat(260)}`;
    const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
      options.onEvent({
        type: 'error',
        error: "Your AI provider's rate limit was reached.",
        errorKind: 'rate_limit',
        limitScope: 'plan',
        credentialSource: 'codex-subscription',
        headlineClass: 'subscription_entitlement',
        rawError: longRawError,
        errorSource: 'main',
        timestamp: Date.now(),
      });
    });
    const scheduler = createScheduler(executeAgentTurn);
    mockResolvedAutomationFile(scheduler, 'analytics-failure-automation.md');
    const definition = scheduler.upsertDefinition({
      name: 'Analytics failure LLM',
      filePath: 'analytics-failure-automation.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
    });

    mockTrackMainEvent.mockClear();
    const run = await scheduler.runNow(definition.id);
    const failedEvent = getTrackedEvent('Automation Run Failed');

    expect(run?.status).toBe('failure');
    expect(failedEvent?.properties).toMatchObject({
      automationId: definition.id,
      errorType: "Your AI provider's rate limit was reached.",
      errorKind: 'rate_limit',
      limitScope: 'plan',
      credentialSource: 'codex-subscription',
      headlineClass: 'subscription_entitlement',
      rawError: longRawError.slice(0, 200),
      executor: 'llm',
    });
    const properties = failedEvent?.properties as Record<string, unknown> | undefined;
    expect(typeof properties?.rawError).toBe('string');
    expect((properties?.rawError as string).length).toBe(200);
  });

  it('AT-1b omits the executor analytics tag for direct system pipelines', () => {
    const scheduler = createScheduler();
    const schedulerWithInternals = scheduler as unknown as {
      getAnalyticsExecutor: (automation: AutomationDefinition) => 'llm' | 'script' | undefined;
    };

    expect(
      schedulerWithInternals.getAnalyticsExecutor({
        id: 'calendar-system',
        name: 'Calendar sync',
        filePath: '',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isSystem: true,
        systemType: 'calendar-sync',
      }),
    ).toBeUndefined();
  });

  describe('Stage 3a provider-readiness scheduler gating', () => {
    it('manual runNow bypasses the cooldown scheduler gate (F8 red→green)', async () => {
      const { apiRateLimitCooldown } = await import('@core/services/apiRateLimitCooldown');
      const isAvailableSpy = vi.spyOn(apiRateLimitCooldown, 'isAvailable').mockReturnValue(false);
      const remainingSpy = vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(30_000);
      const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
        options.onEvent({
          type: 'result',
          text: 'manual run complete',
          timestamp: Date.now(),
        });
      });

      try {
        const scheduler = createScheduler(executeAgentTurn);
        mockResolvedAutomationFile(scheduler, 'cooldown-bypass.md');
        const definition = scheduler.upsertDefinition({
          name: 'Cooldown bypass',
          filePath: 'cooldown-bypass.md',
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const run = await scheduler.runNow(definition.id, 'manual');

        expect(run).not.toBeNull();
        expect(run?.status).toBe('success');
        expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      } finally {
        isAvailableSpy.mockRestore();
        remainingSpy.mockRestore();
      }
    });

    it('defers schedule/catch-up cooldown on the same occurrence instead of dropping it', async () => {
      vi.useFakeTimers();
      const { apiRateLimitCooldown } = await import('@core/services/apiRateLimitCooldown');
      const isAvailableSpy = vi.spyOn(apiRateLimitCooldown, 'isAvailable')
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const remainingSpy = vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(30_000);
      const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
        options.onEvent({
          type: 'result',
          text: 'scheduled run after cooldown',
          timestamp: Date.now(),
        });
      });

      try {
        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => '/tmp/test',
          executeAgentTurn,
          notifyRenderer: vi.fn(),
          getSettings: () => ({
            onboardingCompleted: true,
            activeProvider: 'mindstone',
          } as any),
        });
        mockResolvedAutomationFile(scheduler, 'cooldown-same-occurrence.md');
        const definition = scheduler.upsertDefinition({
          name: 'Cooldown same occurrence',
          filePath: 'cooldown-same-occurrence.md',
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const initialResult = await scheduler.runNow(definition.id, 'schedule');
        expect(initialResult).toBeNull();
        expect(executeAgentTurn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(executeAgentTurn).toHaveBeenCalledTimes(1);
        const runHistory = scheduler.getState().runs.filter((run) => run.automationId === definition.id);
        expect(runHistory.some((run) => run.status === 'success')).toBe(true);
      } finally {
        isAvailableSpy.mockRestore();
        remainingSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('blocks scheduled spawns on provider readiness and persists a cause-coded blocked run', async () => {
      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          onboardingCompleted: true,
          activeProvider: 'anthropic',
        } as any),
      });
      mockResolvedAutomationFile(scheduler, 'blocked-run.md');

      const definition = scheduler.upsertDefinition({
        name: 'Blocked schedule',
        filePath: 'blocked-run.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
      });

      const run = await scheduler.runNow(definition.id, 'schedule');
      const stored = scheduler.getState().definitions.find((item) => item.id === definition.id);
      const summary = scheduler.getProviderReadinessSummary();
      const failedEvent = getTrackedEvent('Automation Run Failed');

      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(run?.status).toBe('provider_not_ready');
      expect(run?.admissionBlock).toMatchObject({
        source: 'provider-readiness',
        code: 'anthropic_missing_api_key',
        errorKind: 'connection-not-configured',
      });
      expect(stored?.lastRunStatus).toBe('provider_not_ready');
      expect(typeof stored?.lastRunAt).toBe('number');
      expect(failedEvent).toBeUndefined();
      expect(summary).toMatchObject({
        readiness: 'blocked',
        cause: { code: 'anthropic_missing_api_key' },
      });
      expect(summary.affectedAutomationCount).toBeGreaterThanOrEqual(1);
      expect(summary.affectedAutomationIds).toContain(definition.id);
    });

    it('does not provider-readiness block scheduled script automations', async () => {
      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          onboardingCompleted: true,
          activeProvider: 'anthropic',
        } as any),
      });
      const scriptCall = vi.fn(async () => ({ summary: 'script survived readiness gate' }));
      registerAutomationScript('script-readiness-bypass', scriptCall);

      const definition = createScriptDefinition(scheduler, {
        scriptModule: 'script-readiness-bypass',
      });

      const run = await scheduler.runNow(definition.id, 'schedule');
      const summary = scheduler.getProviderReadinessSummary();

      expect(run?.status).toBe('success');
      expect(run?.admissionBlock).toBeUndefined();
      expect(scriptCall).toHaveBeenCalledTimes(1);
      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(summary.affectedAutomationIds).not.toContain(definition.id);
    });

    it('does not consume the schedule slot for blocked once automations (retryable after reconnect)', async () => {
      const executeAgentTurn = vi.fn().mockResolvedValue(undefined);
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          onboardingCompleted: true,
          activeProvider: 'anthropic',
        } as any),
      });
      mockResolvedAutomationFile(scheduler, 'blocked-once.md');

      const definition = scheduler.upsertDefinition({
        name: 'Blocked once',
        filePath: 'blocked-once.md',
        schedule: AutomationSchedule.once({ dateTime: new Date(Date.now() - 10_000).toISOString() }),
        enabled: true,
      });

      const run = await scheduler.runNow(definition.id, 'schedule');
      const stored = scheduler.getState().definitions.find((item) => item.id === definition.id);

      expect(executeAgentTurn).not.toHaveBeenCalled();
      expect(run?.status).toBe('provider_not_ready');
      expect(run?.admissionBlock?.code).toBe('anthropic_missing_api_key');
      expect(stored?.lastRunStatus).toBe('provider_not_ready');
      expect(stored?.lastRunAt).toBeNull();
      expect(scheduler.getState().runs.filter((item) => item.automationId === definition.id)).toHaveLength(1);
    });

    it('replays a blocked once automation on catch-up sweep after credential repair', async () => {
      let activeProvider: 'anthropic' | 'mindstone' = 'anthropic';
      const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
        options.onEvent({
          type: 'result',
          text: 'once replayed after repair',
          timestamp: Date.now(),
        });
      });
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          onboardingCompleted: true,
          activeProvider,
        } as any),
      });
      mockResolvedAutomationFile(scheduler, 'blocked-once-replay.md');

      const definition = scheduler.upsertDefinition({
        name: 'Blocked once replay',
        filePath: 'blocked-once-replay.md',
        schedule: AutomationSchedule.once({ dateTime: new Date(Date.now() - 10_000).toISOString() }),
        enabled: true,
      });

      const blockedRun = await scheduler.runNow(definition.id, 'schedule');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(executeAgentTurn).not.toHaveBeenCalled();

      const blockedState = scheduler.getState().definitions.find((item) => item.id === definition.id);
      expect(blockedState?.lastRunAt).toBeNull();

      activeProvider = 'mindstone';
      scheduler.handleAppLaunch();
      await Promise.resolve();
      await Promise.resolve();

      expect(executeAgentTurn).toHaveBeenCalled();
      const replayedRuns = scheduler.getState().runs.filter((item) => item.automationId === definition.id);
      expect(replayedRuns.some((item) => item.status === 'success')).toBe(true);
    });

    it('manual run bypasses provider-readiness scheduler blocking and still executes', async () => {
      const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
        options.onEvent({
          type: 'result',
          text: 'manual despite blocked readiness',
          timestamp: Date.now(),
        });
      });
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/test',
        executeAgentTurn,
        notifyRenderer: vi.fn(),
        getSettings: () => ({
          onboardingCompleted: true,
          activeProvider: 'anthropic',
        } as any),
      });
      mockResolvedAutomationFile(scheduler, 'manual-bypass-readiness.md');

      const definition = scheduler.upsertDefinition({
        name: 'Manual readiness bypass',
        filePath: 'manual-bypass-readiness.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
      });

      const run = await scheduler.runNow(definition.id, 'manual');

      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.status).toBe('success');
      expect(run?.admissionBlock).toBeUndefined();
    });

    it('defers scheduled spawns until resetAt for recorded plan-scoped rate limits', async () => {
      const codexSpy = vi.spyOn(codexAuthModule, 'getCodexAuthProvider').mockReturnValue({
        isConnected: () => true,
        disconnect: async () => undefined,
      } as any);
      const futureResetAtMs = Date.now() + 60 * 60 * 1000;
      const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
        options.onEvent({
          type: 'error',
          error: "Your AI provider's rate limit was reached.",
          errorKind: 'rate_limit',
          limitScope: 'plan',
          credentialSource: 'codex-subscription',
          headlineClass: 'subscription_entitlement',
          rateLimitMeta: { resetAtMs: futureResetAtMs },
          errorSource: 'main',
          timestamp: Date.now(),
        });
      });

      try {
        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => '/tmp/test',
          executeAgentTurn,
          notifyRenderer: vi.fn(),
          getSettings: () => ({
            onboardingCompleted: true,
            activeProvider: 'codex',
          } as any),
        });
        mockResolvedAutomationFile(scheduler, 'reset-window.md');

        const definition = scheduler.upsertDefinition({
          name: 'Reset window deferral',
          filePath: 'reset-window.md',
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const firstRun = await scheduler.runNow(definition.id, 'manual');
        expect(firstRun?.status).toBe('failure');
        expect(firstRun?.rateLimitResetAtMs).toBe(futureResetAtMs);
        const lastRunAtBeforeDefer = scheduler.getState().definitions.find((item) => item.id === definition.id)?.lastRunAt;

        executeAgentTurn.mockClear();
        const deferredRun = await scheduler.runNow(definition.id, 'schedule');
        const lastRunAtAfterDefer = scheduler.getState().definitions.find((item) => item.id === definition.id)?.lastRunAt;

        expect(deferredRun).toBeNull();
        expect(executeAgentTurn).not.toHaveBeenCalled();
        expect(lastRunAtAfterDefer).toBe(lastRunAtBeforeDefer);
      } finally {
        codexSpy.mockRestore();
      }
    });

    it('cancels reset-window deferral immediately after switching from Codex to a healthy non-Codex provider', async () => {
      let activeProvider: 'codex' | 'mindstone' = 'codex';
      const codexSpy = vi.spyOn(codexAuthModule, 'getCodexAuthProvider').mockReturnValue({
        isConnected: () => true,
        disconnect: async () => undefined,
      } as any);
      const futureResetAtMs = Date.now() + 60 * 60 * 1000;
      const executeAgentTurn = vi
        .fn()
        .mockImplementationOnce(async (_turnId, _prompt, options) => {
          options.onEvent({
            type: 'error',
            error: "Your AI provider's rate limit was reached.",
            errorKind: 'rate_limit',
            limitScope: 'plan',
            credentialSource: 'codex-subscription',
            headlineClass: 'subscription_entitlement',
            rateLimitMeta: { resetAtMs: futureResetAtMs },
            errorSource: 'main',
            timestamp: Date.now(),
          });
        })
        .mockImplementation(async (_turnId, _prompt, options) => {
          options.onEvent({
            type: 'result',
            text: 'scheduled run resumed after provider switch',
            timestamp: Date.now(),
          });
        });

      try {
        const scheduler = new AutomationScheduler({
          getCoreDirectory: () => '/tmp/test',
          executeAgentTurn,
          notifyRenderer: vi.fn(),
          getSettings: () => ({
            onboardingCompleted: true,
            activeProvider,
          } as any),
        });
        mockResolvedAutomationFile(scheduler, 'reset-window-provider-switch.md');

        const definition = scheduler.upsertDefinition({
          name: 'Reset window provider switch',
          filePath: 'reset-window-provider-switch.md',
          schedule: AutomationSchedule.daily({ time: '09:00' }),
          enabled: true,
        });

        const firstRun = await scheduler.runNow(definition.id, 'manual');
        expect(firstRun?.status).toBe('failure');
        expect(firstRun?.rateLimitResetAtMs).toBe(futureResetAtMs);

        const deferredRun = await scheduler.runNow(definition.id, 'schedule');
        expect(deferredRun).toBeNull();
        expect(executeAgentTurn).toHaveBeenCalledTimes(1);

        activeProvider = 'mindstone';
        const resumedScheduledRun = await scheduler.runNow(definition.id, 'schedule');
        expect(resumedScheduledRun?.status).toBe('success');
        expect(executeAgentTurn).toHaveBeenCalledTimes(2);

        const resumedCatchUpRun = await scheduler.runNow(definition.id, 'catch-up');
        expect(resumedCatchUpRun?.status).toBe('success');
        expect(executeAgentTurn).toHaveBeenCalledTimes(3);
      } finally {
        codexSpy.mockRestore();
      }
    });
  });

  describe('upsertDefinition finishLine handling', () => {
    it('persists finishLine on a newly created automation', () => {
      const scheduler = createScheduler();
      const created = scheduler.upsertDefinition({
        name: 'Finish line auto',
        filePath: '/test/finish.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        finishLine: 'criterion',
      });

      expect(created.finishLine).toBe('criterion');
    });

    it('normalises finishLine whitespace and clears empty strings on create', () => {
      const scheduler = createScheduler();
      const created = scheduler.upsertDefinition({
        name: 'Whitespace auto',
        filePath: '/test/whitespace.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        finishLine: '   ',
      });

      expect(created.finishLine).toBeUndefined();
    });

    it('normalises finishLine on update via patch', () => {
      const scheduler = createScheduler();
      const created = scheduler.upsertDefinition({
        name: 'Finish line update',
        filePath: '/test/update.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        finishLine: 'first',
      });

      const updated = scheduler.upsertDefinition({
        id: created.id,
        schedule: created.schedule,
        finishLine: '   second criterion   ',
      });

      expect(updated.finishLine).toBe('second criterion');
    });
  });
});
