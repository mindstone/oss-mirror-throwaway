import { describe, it, expect } from 'vitest';

import { classifyHighSignalUtterance } from '../highSignalClassifier';

describe('classifyHighSignalUtterance', () => {
  describe('decision', () => {
    it.each([
      "Let's go with option B",
      "Let's move forward with that.",
      'I think we should do this',
      "We've decided on the timeline.",
      'The decision is final.',
      "I'm going with the second option.",
    ])('matches decision phrase: "%s"', (text) => {
      expect(classifyHighSignalUtterance(text)).toEqual({ type: 'decision' });
    });
  });

  describe('tension', () => {
    it.each([
      'I disagree with that',
      'But actually we should reconsider',
      "I'm not sure about that approach",
      'The problem is the deadline',
      "That won't work",
      'I have concerns about this',
    ])('matches tension phrase: "%s"', (text) => {
      expect(classifyHighSignalUtterance(text)).toEqual({ type: 'tension' });
    });
  });

  describe('question', () => {
    it('matches questions of 5+ words with a question word and trailing ?', () => {
      expect(classifyHighSignalUtterance('What do you think about this?'))
        .toEqual({ type: 'question' });
    });

    it('rejects short questions (< 5 words)', () => {
      expect(classifyHighSignalUtterance('Why?')).toBeNull();
      expect(classifyHighSignalUtterance('How so?')).toBeNull();
    });

    it('rejects long statements without question marks', () => {
      expect(classifyHighSignalUtterance('What I think about this overall is good'))
        .toBeNull();
    });

    it('rejects questions without a question word', () => {
      expect(classifyHighSignalUtterance('Are we on track for next week?')).toBeNull();
    });
  });

  it('returns null for innocuous statements', () => {
    expect(classifyHighSignalUtterance('Hello everyone, nice to meet you.')).toBeNull();
  });
});
