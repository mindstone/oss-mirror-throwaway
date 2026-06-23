import { describe, expect, it } from 'vitest';

import { buildCompanionTurnPrompt } from '../buildCompanionTurnPrompt';

describe('buildCompanionTurnPrompt', () => {
  it('uses the extracted voice-trigger question as the prompt and metadata', () => {
    expect(buildCompanionTurnPrompt({
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 1_778_617_200_000,
      triggerExtracted: 'Summarise what we have covered so far.',
    })).toMatchInlineSnapshot(`
      {
        "meta": {
          "triggerExtracted": "Summarise what we have covered so far.",
          "triggerSource": "voice-trigger",
          "triggerSourceSpeaker": "unknown",
          "triggeredAt": 1778617200000,
        },
        "prompt": "Summarise what we have covered so far.",
      }
    `);
  });

  it('uses the quick-ask fallback prompt without inventing extracted text', () => {
    expect(buildCompanionTurnPrompt({
      triggerSource: 'quick-ask-button',
      triggerSourceSpeaker: 'user',
      triggeredAt: 1_778_617_201_000,
    })).toMatchInlineSnapshot(`
      {
        "meta": {
          "triggerSource": "quick-ask-button",
          "triggerSourceSpeaker": "user",
          "triggeredAt": 1778617201000,
        },
        "prompt": "Ask Spark about this meeting",
      }
    `);
  });
});
