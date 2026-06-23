// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  markSessionSanitised,
  wasSessionSanitised,
  clearSanitisationState,
  _resetSanitisationStateForTests,
} from '../draftSanitisationState';

describe('draftSanitisationState', () => {
  beforeEach(() => {
    _resetSanitisationStateForTests();
  });

  it('returns false for unmarked sessions', () => {
    expect(wasSessionSanitised('session-X')).toBe(false);
  });

  it('marks a session and reports it sanitised', () => {
    markSessionSanitised('session-A');
    expect(wasSessionSanitised('session-A')).toBe(true);
  });

  it('isolates marks across distinct session ids', () => {
    markSessionSanitised('session-A');
    expect(wasSessionSanitised('session-A')).toBe(true);
    expect(wasSessionSanitised('session-B')).toBe(false);
  });

  it('clearSanitisationState removes the mark for the given session only', () => {
    markSessionSanitised('session-A');
    markSessionSanitised('session-B');
    clearSanitisationState('session-A');
    expect(wasSessionSanitised('session-A')).toBe(false);
    expect(wasSessionSanitised('session-B')).toBe(true);
  });

  it('_resetSanitisationStateForTests clears every marker', () => {
    markSessionSanitised('session-A');
    markSessionSanitised('session-B');
    _resetSanitisationStateForTests();
    expect(wasSessionSanitised('session-A')).toBe(false);
    expect(wasSessionSanitised('session-B')).toBe(false);
  });
});
