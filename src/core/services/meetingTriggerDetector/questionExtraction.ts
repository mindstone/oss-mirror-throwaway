/**
 * Question extraction / prefix-strip / confirmation-phrase helpers.
 *
 * Pure helpers extracted from `botQAService.ts`. Behaviour must remain
 * byte-equivalent — covered by the Stage 2a characterisation corpus.
 */

import { escapeRegex } from './triggerPatterns';

/**
 * Strip leading punctuation/whitespace that leaks from transcription
 * artefacts ("`. Go ahead.` → `Go ahead.`", "`— continue` → `continue`").
 */
export function stripLeadingPunctuation(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/**
 * Broad confirmation phrase regex — recognises many natural ways to say
 * "speak now" after Spark raises its hand.
 */
const CONFIRMATION_PHRASE_RE = /^(?:go\s+ahead|go\s+on|continue|proceed|carry\s+on|speak|answer|respond|tell\s+(?:me|us)|yes|yeah|yep|yup|sure|please|do\s+it|ok(?:ay)?|right|alright|fire\s+away)(?:[,.\s]+(?:please|thanks|thank\s+you))?[.!?]*$/i;

/**
 * True when the (already-trimmed/cleaned) text is a confirmation phrase.
 */
export function isConfirmationPhrase(text: string): boolean {
  return CONFIRMATION_PHRASE_RE.test(stripLeadingPunctuation(text));
}

/**
 * Compound `confirmation + question` extractor.
 * "go ahead, and what about X?" → "and what about X?"
 * Returns the follow-up portion, or null if the text isn't a compound
 * "confirmation + ..." form.
 */
const CONFIRMATION_PREFIX_RE = /^(?:go\s+ahead|go\s+on|continue|proceed|carry\s+on|sure|ok(?:ay)?|yes|yeah|also)[,.\s]+(.+)$/i;

export function extractFollowUpAfterConfirmation(text: string): string | null {
  const cleaned = stripLeadingPunctuation(text);
  const match = cleaned.match(CONFIRMATION_PREFIX_RE);
  return match ? match[1].trim() : null;
}

/**
 * Word-boundary detection for "go ahead" synonyms anywhere in the segment.
 * Used by the bot to decide whether a trigger detected mid-speech is a
 * "keep going" cue versus an interrupt.
 */
export const GO_AHEAD_IN_TEXT_RE = /\b(?:go\s+ahead|go\s+on|continue|proceed)\b/i;

/**
 * Strip a leading trigger phrase (with optional greeting) from text and
 * return the remainder. Returns null if the trigger phrase isn't at the
 * start of the text.
 *
 * Handles: "Spark, go ahead", "hey Spark go ahead", "Hi Spark, continue" etc.
 */
export function stripTriggerPrefix(text: string, ownerName: string, triggerPhrase: string | null): string | null {
  if (triggerPhrase?.trim()) {
    const escaped = escapeRegex(triggerPhrase.trim());
    const re = new RegExp(`^(?:(?:hey|hi)[,\\s]+)?${escaped}[,.:;!?\\s]+(.+)$`, 'i');
    const match = text.match(re);
    return match ? stripLeadingPunctuation(match[1]) : null;
  }

  const firstName = ownerName.split(/\s+/)[0];
  const escapedName = escapeRegex(firstName);
  const re = new RegExp(`^(?:(?:hey|hi)[,\\s]+)?${escapedName}(?:'?s)?\\s*rebel[,.:;!?\\s]+(.+)$`, 'i');
  const match = text.match(re);
  return match ? stripLeadingPunctuation(match[1]) : null;
}

/**
 * Extract the question portion after the trigger pattern.
 *
 * "hey Spark, do you know X" → "do you know X"
 *
 * Separator class is intentionally broad — transcription inserts periods,
 * dashes and ellipses freely. Falls back to fuzzy-match extraction (for when
 * "Spark" was transcribed as "Mark" etc.), then to the raw stripped text.
 */
export function extractQuestion(text: string, ownerName: string, triggerPhrase: string | null): string {
  if (triggerPhrase?.trim()) {
    const escaped = escapeRegex(triggerPhrase.trim());
    const exactMatch = text.match(new RegExp(`(?:hey|hi)[,\\s]+${escaped}[,.:;!?\\s]*(.*)`, 'i'));
    if (exactMatch) {
      return stripLeadingPunctuation(exactMatch[1]);
    }

    const fuzzyPattern = /\b(?:hey|hi)[,\s]+\w+[,.:;!?\s]*(.*)/i;
    const fuzzyMatch = text.match(fuzzyPattern);
    if (fuzzyMatch) {
      return stripLeadingPunctuation(fuzzyMatch[1]);
    }

    return stripLeadingPunctuation(text);
  }

  const firstName = ownerName.split(/\s+/)[0];
  const escapedName = escapeRegex(firstName);
  const match = text.match(new RegExp(`(?:hey|hi)[,\\s]+${escapedName}('?s)?\\s*rebel[,.:;!?\\s]*(.*)`, 'i'));
  return match ? stripLeadingPunctuation(match[2]) : stripLeadingPunctuation(text);
}
