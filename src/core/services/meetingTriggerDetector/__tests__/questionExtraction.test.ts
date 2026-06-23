import { describe, it, expect } from 'vitest';

import {
  stripLeadingPunctuation,
  extractQuestion,
  stripTriggerPrefix,
  isConfirmationPhrase,
  extractFollowUpAfterConfirmation,
  GO_AHEAD_IN_TEXT_RE,
} from '../questionExtraction';

describe('stripLeadingPunctuation', () => {
  it('strips leading periods, dashes, ellipses', () => {
    expect(stripLeadingPunctuation('. Go ahead')).toBe('Go ahead');
    expect(stripLeadingPunctuation('— continue')).toBe('continue');
    expect(stripLeadingPunctuation('...what?')).toBe('what?');
  });

  it('keeps already-clean text unchanged', () => {
    expect(stripLeadingPunctuation('summarise so far.')).toBe('summarise so far.');
  });
});

describe('extractQuestion', () => {
  it('extracts after "Hey Spark," prefix', () => {
    expect(extractQuestion('Hey Spark, summarise so far.', 'Alice', 'Spark'))
      .toBe('summarise so far.');
  });

  it('extracts after "Hi Spark" prefix', () => {
    expect(extractQuestion('Hi Spark what is next?', 'Alice', 'Spark'))
      .toBe('what is next?');
  });

  it('handles fuzzy-extraction when trigger phrase was mis-transcribed', () => {
    expect(extractQuestion('Hey Mark, do this.', 'Alice', 'Spark'))
      .toBe('do this.');
  });

  it('extracts after default-trigger "Hey {name}\'s Rebel"', () => {
    expect(extractQuestion("Hey Alice's Rebel, summarise.", 'Alice Smith', null))
      .toBe('summarise.');
  });

  it('falls back to stripped text when no greeting pattern matches', () => {
    expect(extractQuestion('Spark this is unusual', 'Alice', 'Spark'))
      .toBe('Spark this is unusual');
  });

  it('handles trigger phrase with regex special chars', () => {
    expect(extractQuestion('Hey Spark?, please summarise.', 'Alice', 'Spark?'))
      .toBe('please summarise.');
  });
});

describe('stripTriggerPrefix', () => {
  it('extracts content after "Spark, "', () => {
    expect(stripTriggerPrefix('Spark, go ahead.', 'Alice', 'Spark')).toBe('go ahead.');
  });

  it('extracts content after "Hey Spark, "', () => {
    expect(stripTriggerPrefix('Hey Spark, continue', 'Alice', 'Spark')).toBe('continue');
  });

  it('returns null when text does not start with the trigger', () => {
    expect(stripTriggerPrefix('continue please', 'Alice', 'Spark')).toBeNull();
  });

  it('handles default trigger', () => {
    expect(stripTriggerPrefix("Alice's Rebel, go ahead.", 'Alice', null)).toBe('go ahead.');
  });
});

describe('isConfirmationPhrase', () => {
  it.each([
    'go ahead', 'go on', 'continue', 'proceed', 'carry on',
    'speak', 'answer', 'yes', 'yeah', 'sure', 'okay', 'fire away',
    'go ahead, please', 'continue, thanks',
  ])('recognises "%s"', (phrase) => {
    expect(isConfirmationPhrase(phrase)).toBe(true);
  });

  it.each(['what about X', 'no thanks', 'summarise this', 'goodbye'])(
    'rejects "%s"',
    (phrase) => {
      expect(isConfirmationPhrase(phrase)).toBe(false);
    },
  );
});

describe('extractFollowUpAfterConfirmation', () => {
  it('extracts follow-up question after "go ahead,"', () => {
    expect(extractFollowUpAfterConfirmation('go ahead, and what about X?'))
      .toBe('and what about X?');
  });

  it('extracts follow-up after "yes"', () => {
    expect(extractFollowUpAfterConfirmation('yes, summarise instead'))
      .toBe('summarise instead');
  });

  it('returns null when text is just a confirmation', () => {
    expect(extractFollowUpAfterConfirmation('go ahead')).toBeNull();
  });

  it('returns null when text does not start with confirmation', () => {
    expect(extractFollowUpAfterConfirmation('what about X?')).toBeNull();
  });
});

describe('GO_AHEAD_IN_TEXT_RE', () => {
  it('matches "go ahead" anywhere in text', () => {
    expect(GO_AHEAD_IN_TEXT_RE.test('alright then go ahead with that')).toBe(true);
  });

  it('matches "continue" anywhere in text', () => {
    expect(GO_AHEAD_IN_TEXT_RE.test('please continue thanks')).toBe(true);
  });

  it('does not match without a synonym present', () => {
    expect(GO_AHEAD_IN_TEXT_RE.test('please summarise')).toBe(false);
  });
});
