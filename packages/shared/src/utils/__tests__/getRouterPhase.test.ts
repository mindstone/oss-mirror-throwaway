import { describe, expect, it } from 'vitest';
import { getRouterPhase } from '../getRouterPhase';

describe('getRouterPhase', () => {
  it('returns "default" for undefined headline', () => {
    expect(getRouterPhase(undefined)).toBe('default');
  });

  it('returns "default" for empty headline', () => {
    expect(getRouterPhase('')).toBe('default');
  });

  it('returns "evaluating" when headline contains "evaluating"', () => {
    expect(getRouterPhase('Evaluating your request')).toBe('evaluating');
  });

  it('returns "evaluating" case-insensitively', () => {
    expect(getRouterPhase('EVALUATING the situation')).toBe('evaluating');
  });

  it('returns "direct" when headline contains "got it"', () => {
    expect(getRouterPhase('Got it — answering now')).toBe('direct');
  });

  it('returns "direct" when headline contains "answering from"', () => {
    expect(getRouterPhase('Answering from context')).toBe('direct');
  });

  it('returns "research" when headline contains "deeper research"', () => {
    expect(getRouterPhase('This needs deeper research')).toBe('research');
  });

  it('returns "research" when headline contains "needs research"', () => {
    expect(getRouterPhase('This needs research to answer properly')).toBe('research');
  });

  it('returns "found" when headline contains "found" and "file"', () => {
    expect(getRouterPhase('Found the file you mentioned')).toBe('found');
  });

  it('returns "default" when headline contains "found" without "file"', () => {
    expect(getRouterPhase('Found some results')).toBe('default');
  });

  it('returns "default" for unrecognized headline', () => {
    expect(getRouterPhase('Working on your request')).toBe('default');
  });
});
