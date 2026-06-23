import { describe, expect, it } from 'vitest';

import { classifyEventForSession } from '../index';

describe('classifyEventForSession (cross-surface SSOT)', () => {
  it('classifies a matching sessionId as own', () => {
    expect(classifyEventForSession({ sessionId: 'A' }, 'A')).toEqual({ kind: 'own' });
  });

  it('classifies a different non-empty sessionId as rejected-foreign', () => {
    expect(classifyEventForSession({ sessionId: 'B' }, 'A')).toEqual({
      kind: 'rejected-foreign',
      eventSessionId: 'B',
    });
  });

  it('classifies a missing sessionId as accepted-legacy', () => {
    expect(classifyEventForSession({}, 'A')).toEqual({ kind: 'accepted-legacy' });
  });

  it('treats empty-string / non-string sessionId as accepted-legacy (missing)', () => {
    expect(classifyEventForSession({ sessionId: '' }, 'A')).toEqual({ kind: 'accepted-legacy' });
    expect(classifyEventForSession({ sessionId: 123 }, 'A')).toEqual({ kind: 'accepted-legacy' });
    expect(classifyEventForSession({ sessionId: null }, 'A')).toEqual({ kind: 'accepted-legacy' });
  });

  it('lets an explicit non-empty eventSessionId override event.sessionId', () => {
    // envelope provenance wins over the on-event field
    expect(
      classifyEventForSession({ sessionId: 'A' }, 'A', { eventSessionId: 'B' }),
    ).toEqual({ kind: 'rejected-foreign', eventSessionId: 'B' });
    expect(
      classifyEventForSession({ sessionId: 'B' }, 'A', { eventSessionId: 'A' }),
    ).toEqual({ kind: 'own' });
  });

  it('falls back to event.sessionId when the explicit override is empty', () => {
    expect(
      classifyEventForSession({ sessionId: 'A' }, 'A', { eventSessionId: '' }),
    ).toEqual({ kind: 'own' });
  });

  it('tolerates null/undefined event input as accepted-legacy', () => {
    expect(classifyEventForSession(undefined, 'A')).toEqual({ kind: 'accepted-legacy' });
    expect(classifyEventForSession(null, 'A')).toEqual({ kind: 'accepted-legacy' });
  });
});
