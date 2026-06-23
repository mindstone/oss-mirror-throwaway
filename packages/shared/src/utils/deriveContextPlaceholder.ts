export interface DeriveContextPlaceholderItem {
  title: string;
  draft?: string | null;
  clarifyingQuestion?: string | null;
  source?: { kind?: string } | null;
  references?: Array<{ kind: string }>;
  category?: string;
}

const MAX_TOPIC_LENGTH = 28;

/**
 * Extracts a short topic reference from an inbox item title.
 *
 * Strips common prefixes ("Meeting:", "Follow up:", etc.), splits on natural
 * separators (colon, em-dash), and truncates at a word boundary.
 */
export function extractShortTopic(title: string): string {
  let cleaned = title
    .replace(/^(Meeting|Follow[- ]?up|Review|Action|Draft|Reply)\s*[:\u2014\u2013\u2015—–-]\s*/i, '')
    .trim();

  const sepMatch = cleaned.match(/^(.+?)(?:\s*[:\u2014\u2013\u2015—]\s)/);
  if (sepMatch && sepMatch[1].length >= 3) {
    cleaned = sepMatch[1].trim();
  }

  if (cleaned.length > MAX_TOPIC_LENGTH) {
    const truncated = cleaned.slice(0, MAX_TOPIC_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 8) {
      cleaned = truncated.slice(0, lastSpace).trim();
    } else {
      cleaned = truncated.trim();
    }
  }

  return cleaned;
}

/**
 * Derives a contextual placeholder for the inbox item's context input.
 *
 * Priority:
 *   1. `clarifyingQuestion` (AI-generated, fully personalized)
 *   2. Draft items → fixed "Any changes?"
 *   3. Topic-based question extracted from title (falls back to generic prompt)
 */
export function deriveContextPlaceholder(item: DeriveContextPlaceholderItem): string {
  if (item.clarifyingQuestion?.trim()) return item.clarifyingQuestion.trim();
  if (item.draft?.trim()) return 'Any changes?';

  const topic = extractShortTopic(item.title);

  if (!topic) return 'Anything Rebel should know?';

  return `Anything to add about \u201c${topic}\u201d?`;
}
