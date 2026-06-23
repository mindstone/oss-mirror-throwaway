/**
 * Trigger / stop / discard pattern generation for the meeting trigger detector.
 *
 * Pure helpers extracted from `src/main/services/meetingBot/botQAService.ts` for
 * cross-surface reuse (cloud-side detector, desktop-local recording, future
 * surfaces). Logic must remain byte-equivalent with the bot's prior
 * implementation; the Stage 2a characterisation corpus is the byte-equivalence
 * contract.
 *
 * Regex special characters in user-configurable trigger phrases (`?`, `*`,
 * `[`, `\`, etc.) MUST be escaped before composing patterns. See
 * `escapeRegex` below; this guarantees Failure-Mode #19.
 */

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape a string so it can be used as a literal inside a `RegExp` source.
 * Mirrors the inline escape pattern previously embedded throughout
 * `botQAService.ts`.
 */
export function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, '\\$&');
}

/**
 * Levenshtein distance between two strings.
 * Used by fuzzy-trigger matching to catch transcription errors
 * (e.g. "Spark" mis-transcribed as "Mark").
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Conservative fuzzy-match threshold by trigger length.
 * Shorter triggers get tighter thresholds to avoid false positives.
 */
export function getFuzzyThreshold(word: string): number {
  if (word.length <= 4) return 1;
  if (word.length <= 6) return 2;
  return 3;
}

/**
 * Optional logger contract for the detector module.
 * Mirrors the subset of pino's API the bot used inline; injected to keep
 * `src/core/` free of pino imports.
 */
export interface DetectorLogger {
  debug?(meta?: unknown, msg?: string): void;
  info?(meta?: unknown, msg?: string): void;
  warn?(meta?: unknown, msg?: string): void;
  error?(meta?: unknown, msg?: string): void;
}

/**
 * Build the trigger phrase regex patterns.
 * Requires a `hey`/`hi` greeting prefix so the trigger doesn't fire during
 * descriptive speech ("So, Spark is actually...").
 */
export function getTriggerPatterns(ownerName: string, triggerPhrase: string | null): RegExp[] {
  if (triggerPhrase?.trim()) {
    const escaped = escapeRegex(triggerPhrase.trim());
    return [new RegExp(`\\b(?:hey|hi)[,\\s]+${escaped}\\b`, 'i')];
  }

  const firstName = ownerName.split(/\s+/)[0];
  const escapedName = escapeRegex(firstName);

  return [new RegExp(`\\b(?:hey|hi)[,\\s]+${escapedName}\\b('?s)?\\s*rebel\\b`, 'i')];
}

/**
 * Fuzzy match the trigger phrase against a transcribed segment.
 * Returns the matched candidate word, or null when no fuzzy match applies.
 * Only runs against custom trigger phrases (the default `{name}'s Rebel`
 * pattern is too positional for fuzzy matching).
 */
export function fuzzyMatchTrigger(
  text: string,
  triggerPhrase: string | null,
  logger?: DetectorLogger,
): string | null {
  if (!triggerPhrase?.trim()) return null;

  const trigger = triggerPhrase.trim().toLowerCase();
  const threshold = getFuzzyThreshold(trigger);

  const standardPattern = /\b(?:hey|hi)[,\s]+(\w+)\b/i;
  const match = text.match(standardPattern);

  if (!match) {
    const garbledGreetingPattern = /^[^.!?]*?\b([a-z]|ah|uh|eh)\s+(\w+)[,\s]/i;
    const garbledMatch = text.match(garbledGreetingPattern);
    if (garbledMatch) {
      const candidateWord = garbledMatch[2].toLowerCase();
      const distance = levenshteinDistance(trigger, candidateWord);
      if (distance <= 1) {
        logger?.info?.({
          trigger,
          candidateWord,
          distance,
          garbledGreeting: garbledMatch[1],
        }, 'Fuzzy trigger match (garbled greeting)');
        return candidateWord;
      }
    }
  }

  if (!match) return null;

  const candidateWord = match[1].toLowerCase();
  const distance = levenshteinDistance(trigger, candidateWord);

  if (distance <= threshold && distance > 0) {
    logger?.info?.({
      trigger,
      candidateWord,
      distance,
      threshold,
    }, 'Fuzzy trigger match');
    return candidateWord;
  }

  return null;
}

/**
 * True when the segment matches the trigger phrase (exact or fuzzy).
 */
export function matchesTrigger(
  text: string,
  ownerName: string,
  triggerPhrase: string | null,
  logger?: DetectorLogger,
): boolean {
  const patterns = getTriggerPatterns(ownerName, triggerPhrase);
  if (patterns.some(p => p.test(text))) {
    return true;
  }

  if (triggerPhrase?.trim()) {
    if (fuzzyMatchTrigger(text, triggerPhrase, logger)) {
      return true;
    }
  }

  return false;
}

/**
 * Stop trigger patterns — `stop/cancel + phrase` OR `phrase + stop/cancel`.
 * Bug 7 (reverse-order) and Bug 14 (works even when diarisation labels the
 * owner as "Unknown" while the bot is speaking) inform the dual patterns.
 */
export function getStopTriggerPatterns(ownerName: string, triggerPhrase: string | null): RegExp[] {
  if (triggerPhrase?.trim()) {
    const escaped = escapeRegex(triggerPhrase.trim());
    return [
      new RegExp(`\\b(?:stop|cancel)[,\\s]+${escaped}\\b`, 'i'),
      new RegExp(`\\b${escaped}[,\\s]+(?:stop|cancel)\\b`, 'i'),
    ];
  }

  const firstName = ownerName.split(/\s+/)[0];
  const escapedName = escapeRegex(firstName);

  return [
    new RegExp(`\\b(?:stop|cancel)[,\\s]+${escapedName}\\b('?s)?\\s*rebel\\b`, 'i'),
    new RegExp(`\\b${escapedName}\\b('?s)?\\s*rebel[,\\s]+(?:stop|cancel)\\b`, 'i'),
  ];
}

/**
 * Fuzzy stop-trigger match against custom trigger phrases.
 */
export function fuzzyMatchStopTrigger(text: string, triggerPhrase: string | null): boolean {
  if (!triggerPhrase?.trim()) return false;

  const trigger = triggerPhrase.trim().toLowerCase();
  const threshold = getFuzzyThreshold(trigger);

  const forwardPattern = /\b(?:stop|cancel)[,\s]+(\w+)\b/i;
  const forwardMatch = text.match(forwardPattern);

  if (forwardMatch) {
    const candidateWord = forwardMatch[1].toLowerCase();
    const distance = levenshteinDistance(trigger, candidateWord);
    if (distance <= threshold && distance > 0) return true;
  }

  const reversePattern = /\b(\w+)[,\s]+(?:stop|cancel)\b/i;
  const reverseMatch = text.match(reversePattern);

  if (reverseMatch) {
    const candidateWord = reverseMatch[1].toLowerCase();
    const distance = levenshteinDistance(trigger, candidateWord);
    if (distance <= threshold && distance > 0) return true;
  }

  return false;
}

/**
 * True when the segment matches a stop trigger (exact or fuzzy).
 */
export function matchesStopTrigger(text: string, ownerName: string, triggerPhrase: string | null): boolean {
  const patterns = getStopTriggerPatterns(ownerName, triggerPhrase);
  if (patterns.some(p => p.test(text))) {
    return true;
  }

  if (triggerPhrase?.trim()) {
    return fuzzyMatchStopTrigger(text, triggerPhrase);
  }

  return false;
}

/**
 * Discard trigger patterns — "never mind" / "discard" forms.
 * "cancel" is intentionally NOT included here; that's the stop trigger's
 * keyword and collisions would make the stop path ambiguous.
 */
export function getDiscardTriggerPatterns(ownerName: string, triggerPhrase: string | null): RegExp[] {
  if (triggerPhrase?.trim()) {
    const escaped = escapeRegex(triggerPhrase.trim());
    return [
      new RegExp(`(?:hey|hi)?[,\\s]*${escaped}[,:\\s]+(?:never\\s*mind|discard)\\b`, 'i'),
      new RegExp(`(?:never\\s*mind|discard)[,\\s]+${escaped}\\b`, 'i'),
    ];
  }

  const firstName = ownerName.split(/\s+/)[0];
  const escapedName = escapeRegex(firstName);
  return [
    new RegExp(`\\b${escapedName}\\b('?s)?\\s*rebel[,:\\s]+(?:never\\s*mind|discard)\\b`, 'i'),
    new RegExp(`(?:never\\s*mind|discard)[,\\s]+${escapedName}\\b('?s)?\\s*rebel\\b`, 'i'),
  ];
}

/**
 * True when the segment matches a discard trigger.
 */
export function matchesDiscardTrigger(text: string, ownerName: string, triggerPhrase: string | null): boolean {
  const patterns = getDiscardTriggerPatterns(ownerName, triggerPhrase);
  return patterns.some(p => p.test(text));
}
