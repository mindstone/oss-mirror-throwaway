import { describe, it, beforeEach, expect } from 'vitest';
import fc from 'fast-check';

import type { AgentEvent } from '@shared/types';

import type { SequencedAgentEvent } from '../eventIdentity';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  validateEventForSession,
} from '../eventSessionValidation';

const FAST_CHECK_NUM_RUNS = 300;
const FAST_CHECK_SEED = 260530;

const sessionIdPool = ['session-A', 'session-B', 'session-C', 'alpha', 'beta'] as const;

const nonEmptySessionIdArbitrary = fc.constantFrom(...sessionIdPool);

const eventArbitrary: fc.Arbitrary<SequencedAgentEvent<AgentEvent>> = fc
  .record({
    type: fc.string({ maxLength: 32 }),
    message: fc.string({ maxLength: 64 }),
    timestamp: fc.integer(),
    seq: fc.integer(),
    sessionId: fc.option(fc.string({ maxLength: 48 }), { nil: undefined }),
  })
  .map((event) => event as unknown as SequencedAgentEvent<AgentEvent>);

const eventWithoutSessionArbitrary: fc.Arbitrary<SequencedAgentEvent<AgentEvent>> = fc
  .record({
    type: fc.string({ maxLength: 32 }),
    message: fc.string({ maxLength: 64 }),
    timestamp: fc.integer(),
    seq: fc.integer(),
    sessionId: fc.constantFrom(undefined, ''),
  })
  .map((event) => event as unknown as SequencedAgentEvent<AgentEvent>);

const getFastCheckConfig = () => ({ numRuns: FAST_CHECK_NUM_RUNS, seed: FAST_CHECK_SEED });

describe('eventSessionValidation property tests', () => {
  beforeEach(() => {
    __resetEventSessionValidationDiagnosticsForTest();
  });

  it('rejects as foreign when explicit non-empty eventSessionId differs from currentSessionId', () => {
    fc.assert(
      fc.property(
        eventArbitrary,
        nonEmptySessionIdArbitrary,
        nonEmptySessionIdArbitrary,
        (event, currentSessionId, eventSessionId) => {
          fc.pre(currentSessionId !== eventSessionId);

          const result = validateEventForSession(event, currentSessionId, {
            turnId: 'turn-test',
            source: 'test-only',
            eventSessionId,
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.outcome.kind).toBe('rejected-foreign');
            if (result.outcome.kind === 'rejected-foreign') {
              expect(result.outcome.eventSessionId).toBe(eventSessionId);
              expect(result.outcome.targetSessionId).toBe(currentSessionId);
            }
          }
        },
      ),
      getFastCheckConfig(),
    );
  });

  it('accepts when explicit non-empty eventSessionId equals currentSessionId', () => {
    fc.assert(
      fc.property(eventArbitrary, nonEmptySessionIdArbitrary, (event, sessionId) => {
        const result = validateEventForSession(event, sessionId, {
          turnId: 'turn-test',
          source: 'test-only',
          eventSessionId: sessionId,
        });

        expect(result.ok).toBe(true);
      }),
      getFastCheckConfig(),
    );
  });

  it('returns accepted-legacy when no provenance exists (no explicit eventSessionId and no event.sessionId or empty)', () => {
    fc.assert(
      fc.property(eventWithoutSessionArbitrary, nonEmptySessionIdArbitrary, (event, currentSessionId) => {
        const result = validateEventForSession(event, currentSessionId, {
          turnId: 'turn-test',
          source: 'test-only',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.outcome.kind).toBe('accepted-legacy');
          if (result.outcome.kind === 'accepted-legacy') {
            expect(result.outcome.targetSessionId).toBe(currentSessionId);
          }
        }
      }),
      getFastCheckConfig(),
    );
  });

  it('treats empty-string explicit provenance as missing and falls back to event.sessionId (precedence rule)', () => {
    fc.assert(
      fc.property(eventArbitrary, nonEmptySessionIdArbitrary, (event, currentSessionId) => {
        const resultWithEmptyExplicit = validateEventForSession(event, currentSessionId, {
          turnId: 'turn-test',
          source: 'test-only',
          eventSessionId: '',
        });
        const resultWithNoExplicit = validateEventForSession(event, currentSessionId, {
          turnId: 'turn-test',
          source: 'test-only',
        });

        expect(resultWithEmptyExplicit).toEqual(resultWithNoExplicit);
      }),
      getFastCheckConfig(),
    );
  });

  it('uses explicit provenance over event.sessionId when they conflict', () => {
    fc.assert(
      fc.property(eventArbitrary, nonEmptySessionIdArbitrary, nonEmptySessionIdArbitrary, (event, target, foreign) => {
        fc.pre(target !== foreign);

        const stampedEvent = {
          ...(event as unknown as Record<string, unknown>),
          sessionId: foreign,
        } as unknown as SequencedAgentEvent<AgentEvent>;

        const result = validateEventForSession(stampedEvent, target, {
          turnId: 'turn-test',
          source: 'test-only',
          eventSessionId: target,
        });

        expect(result.ok).toBe(true);
      }),
      getFastCheckConfig(),
    );
  });

  it('is deterministic and never throws for arbitrary string inputs', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.string({ unit: 'grapheme', maxLength: 64 }),
          message: fc.string({ unit: 'grapheme', maxLength: 128 }),
          timestamp: fc.integer(),
          seq: fc.integer(),
          sessionId: fc.option(fc.string({ unit: 'grapheme', maxLength: 128 }), { nil: undefined }),
        }),
        fc.string({ unit: 'grapheme', maxLength: 128 }),
        fc.option(fc.string({ unit: 'grapheme', maxLength: 128 }), { nil: undefined }),
        (eventLike, currentSessionId, explicitSessionId) => {
          const event = eventLike as unknown as SequencedAgentEvent<AgentEvent>;

          expect(() => {
            const first = validateEventForSession(event, currentSessionId, {
              turnId: 'turn-test',
              source: 'test-only',
              eventSessionId: explicitSessionId,
            });
            const second = validateEventForSession(event, currentSessionId, {
              turnId: 'turn-test',
              source: 'test-only',
              eventSessionId: explicitSessionId,
            });
            expect(first).toEqual(second);
          }).not.toThrow();
        },
      ),
      getFastCheckConfig(),
    );
  });
});
