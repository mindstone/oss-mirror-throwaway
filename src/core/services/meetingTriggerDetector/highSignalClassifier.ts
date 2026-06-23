/**
 * High-signal utterance classifier — detects "decision" / "tension" /
 * "question" moments worth surfacing to the bot's proactive layer.
 *
 * Pure function extracted from `botQAService.ts`. Behaviour must remain
 * byte-equivalent — covered by the Stage 2a characterisation corpus.
 */

const QUESTION_WORD_RE = /\b(what|how|why|when|where|who|which|should|could|would)\b/i;
const QUESTION_RE = /\?\s*$/;
const DECISION_RE = /\b(let'?s\s+(?:go\s+with|move\s+forward|do)\b|i\s+think\s+we\s+should\b|we'?ve\s+decided\b|the\s+decision\s+is\b|i'?m\s+going\s+with\b)/i;
const TENSION_RE = /\b(i\s+disagree\b|but\s+actually\b|i'?m\s+not\s+sure\s+about\s+that\b|the\s+problem\s+is\b|that\s+won'?t\s+work\b|i\s+have\s+concerns\b)/i;

export type HighSignalType = 'decision' | 'tension' | 'question';

export interface HighSignalClassification {
  type: HighSignalType;
}

export function classifyHighSignalUtterance(text: string): HighSignalClassification | null {
  if (DECISION_RE.test(text)) {
    return { type: 'decision' };
  }

  if (TENSION_RE.test(text)) {
    return { type: 'tension' };
  }

  const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
  if (wordCount >= 5 && QUESTION_WORD_RE.test(text) && QUESTION_RE.test(text)) {
    return { type: 'question' };
  }

  return null;
}
