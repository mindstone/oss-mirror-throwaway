/**
 * Shared inbox quality patterns used by both main (inboxStore) and renderer (Coach filtering).
 *
 * These are pure regex arrays with no platform dependencies.
 */

/**
 * Patterns for tasks that belong to another person, not the current user.
 * Used to reject inbox items at write time, during retroactive cleanup,
 * and to filter coaching insights in the Coach section.
 */
// Common non-person words that start with a capital letter at the beginning of a title.
// Used as a negative lookahead to avoid false positives like "My assistant fixing..." or "The team will fix...".
const NOT_A_PERSON = '(?!My|The|Our|Your|Their|This|That|Each|Every|Some|Any|No|All)';

// Extended exclusion for the "[Name]: [topic]" attribution pattern.
// Includes NOT_A_PERSON words plus common non-person title prefixes that could
// match `^[A-Z][a-z]+:` without being a person's name.
const NOT_A_PERSON_OR_TITLE_PREFIX = '(?!My|The|Our|Your|Their|This|That|Each|Every|Some|Any|No|All|Meeting|Schedule|Action|Task|Follow|Draft|Review|Bug|Fix|Note|Reminder|Alert|Status|Update|Summary|Step|Question|Warning|Report|Email|Call|Send|Check|Create|Prepare|Today|Tomorrow|Weekly|Daily|Monthly|Sprint|Phase|Urgent|Priority|Due|Ready|Done|Pending|New|Open|Final|Quick|Important|Blocked|Resolved|Confirmed|Shipped|Insight|Context|Decision|Option|Idea|Observation|Recap|Reflection|Learning|Suggestion|Highlight|Win|Consider)';

export const OTHER_PERSON_TASK_PATTERNS: RegExp[] = [
  /^follow\s*up:?\s+\w+\s+(is|will be|needs to)\s+(fix|handle|review|resolv|updat|work on|address|investigat)/i,
  /^follow\s*up:?\s+\w+\s+(fixing|handling|reviewing|resolving|updating|working on|addressing)/i,
  /^(?!today's|tomorrow's|this\s+week's|next\s+week's)\w+'s\s+(task|action|responsibility|follow-up|follow up):/i,
  // "[Name] [verb-ing] [something] for [Name]" — another person doing work for someone
  new RegExp(`^${NOT_A_PERSON}[A-Z][a-z]+\\s+(fixing|handling|reviewing|resolving|updating|working on|addressing|investigating|preparing|setting up|configuring|deploying|testing|debugging|migrating|implementing|building|creating|writing|drafting|scheduling|organizing|coordinating)\\b.+\\bfor\\s+[A-Z]`, 'i'),
  // "[Name] will/should/needs to [verb]" — assignment to another person
  new RegExp(`^${NOT_A_PERSON}[A-Z][a-z]+\\s+(will|should|needs?\\s+to|has\\s+to|agreed\\s+to|is\\s+going\\s+to)\\s+(fix|handle|review|resolv|updat|work on|address|investigat|prepar|set up|configur|deploy|test|debug|migrat|implement|build|creat|writ|draft|schedul|organiz|coordinat)`, 'i'),
  // "[Name] to [verb] [something]" — short delegation form
  new RegExp(`^${NOT_A_PERSON}[A-Z][a-z]+\\s+to\\s+(fix|handle|review|resolve|update|address|investigate|prepare|set up|configure|deploy|test|debug|send|share|follow up|check|confirm|schedule)\\b`, 'i'),
  // Customer support / helpdesk delegation
  /^(customer\s+support|support\s+team|cs\s+team|helpdesk)\s+(to|will|should|needs?\s+to)\s/i,
  // Third-party / external delegation
  /^(vendor|partner|client|contractor|external\s+team)\s+(will|should|needs?\s+to)\s/i,
  // Role/department delegation — "[Department] (team) will/should/to [verb]"
  /^(engineering|sales|marketing|design|ops|finance|legal|hr)\s+(team\s+)?(to|will|should|needs?\s+to)\s/i,
  // "[Name]'s deliverable/responsibility/action item/task"
  new RegExp(`^${NOT_A_PERSON}[A-Z][a-z]+('s)?\\s+(deliverable|responsibility|action\\s+item|task)\\b`, 'i'),
  // "[PersonName]: [topic]" — content attributed to another meeting participant
  // e.g., "Greg: Rethinking personal work habits", "Sarah: Proposed new pricing model"
  new RegExp(`^${NOT_A_PERSON_OR_TITLE_PREFIX}[A-Z][a-z]{2,15}:\\s+`, ''),
];

/**
 * Test whether a title matches any other-person task pattern.
 */
export function isOtherPersonTask(title: string): boolean {
  return OTHER_PERSON_TASK_PATTERNS.some(p => p.test(title));
}

/**
 * Action verbs that signal the inbox item requires action from the user.
 * Used to derive `important` when the upstream agent doesn't set it explicitly.
 * Titles starting with these verbs (or "Meeting:") are assumed actionable.
 */
const ACTION_VERB_PREFIXES: RegExp[] = [
  /^(review|follow\s*up|follow\s+through|send|draft|prepare|prep|schedule|check|reply|respond|forward|share|update|discuss|decide|confirm|complete|approve|set\s*up|create|write|book|contact|arrange|submit|request|finali[sz]e|investigate|research|prioriti[sz]e|plan|assign|deliver|publish|launch|test|validate|cancel|renegotiate|escalate|re-?schedule|call|email|ask|remind|notify|reach\s+out|organize|coordinate|sign|address|resolve|close|attend|register|order|buy|pay|gather|collect|compile|transfer|clean\s+up|onboard|migrate|add|remove|implement|document|configure|deploy|fix|handle)\b/i,
  /^meeting:/i,
];

/**
 * Mid-title phrases that signal the user needs to act on something,
 * even if the title doesn't start with an action verb.
 * e.g., "Q1 pricing — needs your sign-off"
 */
const ACTION_SIGNAL_PHRASES: RegExp[] = [
  /\bneed(s?)\s+(to|your|a)\b/i,
  /\bshould\s+(review|check|decide|respond|follow|send|prepare|schedule)\b/i,
  /\baction\s+required\b/i,
  /\bdeadline\b/i,
  /\bbefore\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|eow|end\s+of)\b/i,
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|eow|end\s+of)\b/i,
  /\bwaiting\s+on\s+you\b/i,
  /\byour\s+(turn|input|approval|sign.?off|review|decision|feedback)\b/i,
  /\brequires?\s+(your|approval|review|decision|input|sign.?off)\b/i,
];

/**
 * Signals that work is already in progress or completed.
 * These negate action verbs — the item is about monitoring/verifying,
 * not initiating. "Fix the login bugs — already started this" has an
 * action verb ("Fix") but the work is already underway.
 */
const ALREADY_IN_PROGRESS_SIGNALS: RegExp[] = [
  /\balready\s+(started|begun|in\s+progress|being\s+(worked|handled|addressed|fixed|done)|underway|kicked\s+off)\b/i,
  /\b(work|progress)\s+(is\s+)?(underway|in\s+progress|started|begun)\b/i,
  /\bcurrently\s+(being|working\s+on|addressing|fixing|handling)\b/i,
  /\bin\s+progress\b/i,
  /\balready\s+(fixed|done|completed|resolved|shipped|handled|addressed|merged|deployed)\b/i,
  /\bhas\s+been\s+(started|initiated|kicked\s+off)\b/i,
];

/**
 * Whether an inbox item title contains a signal that the user needs to act on it.
 *
 * Used to derive `important` at write time when the upstream agent doesn't set
 * it explicitly. Items without action signals get `important: false` —
 * they remain in the full inbox but don't compete for homepage real estate.
 *
 * Items about work already in progress ("Fix X — already started") get false
 * even if the title starts with an action verb, because the action is about
 * monitoring/verifying, not initiating new work.
 */
// Word-boundary-aware exclusion for body text. Unlike NOT_A_PERSON (prefix match),
// this uses \b so "Theo" is allowed even though "The" is excluded.
const NOT_A_PERSON_BODY = '(?!My\\b|The\\b|Our\\b|Your\\b|Their\\b|This\\b|That\\b|Each\\b|Every\\b|Some\\b|Any\\b|No\\b|All\\b)';

/**
 * Body-text patterns that signal a third party (not the current user) owns the action.
 * Used as a safety net for meeting-action and follow-up items where the LLM prompt
 * failed to filter out someone else's initiative.
 */
export const THIRD_PARTY_INITIATIVE_PATTERNS: RegExp[] = [
  // "[Name] flagged/raised/proposed/suggested/mentioned/highlighted/brought up/pointed out"
  // No `i` flag: [A-Z] must be uppercase (person name), avoids "was flagged", "you suggested" false positives
  new RegExp(`${NOT_A_PERSON_BODY}[A-Z][a-z]{2,15}\\s+(flagged|raised|proposed|suggested|mentioned|highlighted|brought up|pointed out)\\b`),
  // "[Name] agreed to/that/both/they"
  new RegExp(`${NOT_A_PERSON_BODY}[A-Z][a-z]{2,15}\\s+agreed\\s+(to|that|both|they)\\b`),
  // "[Name] wants/plans to / will [schedule|handle|...] / is going to"
  new RegExp(`${NOT_A_PERSON_BODY}[A-Z][a-z]{2,15}\\s+(wants?\\s+to|plans?\\s+to|will\\s+(schedule|handle|take\\s+care\\s+of|follow\\s+up|address|organize|coordinate|arrange)|is\\s+going\\s+to)\\b`),
  // "assigned to [Name]" / "owned by [Name]" — `i` flag OK here, no name-prefix ambiguity
  /\b(assigned\s+to|owned\s+by)\s+[A-Z][a-z]+\b/,
  // "[Name]'s responsibility/task/action item/initiative/deliverable"
  new RegExp(`${NOT_A_PERSON_BODY}[A-Z][a-z]{2,15}'s\\s+(responsibility|task|action\\s+item|initiative|deliverable)\\b`),
];

/**
 * Body-text patterns that indicate the action IS directed at the user,
 * even though a third-party name appears. These bypass THIRD_PARTY_INITIATIVE_PATTERNS.
 */
export const USER_DIRECTED_EXCLUSION_PATTERNS: RegExp[] = [
  // "[Name] asked/assigned/needs/wants/requested/told/instructed you/me to"
  /\b[A-Z][a-z]+\s+(asked|assigned|needs?|wants?|requested|told|instructed)\s+(you|me)\s+to\b/i,
  // "assigned/delegated to you/me"
  /\b(assigned|delegated)\s+to\s+(you|me)\b/i,
  // "[Name] flagged/raised (for) you/me to"
  /\b[A-Z][a-z]+\s+(flagged|raised)\s+(for\s+)?(you|me)\s+to\b/i,
  // "your action/task/responsibility/deliverable/follow-up"
  /\byour\s+(action|task|responsibility|deliverable|follow.?up)\b/i,
  // "requested that you/I"
  /\brequested\s+that\s+(you|I)\b/i,
];

type InboxQualitySourceLike = {
  kind?: string;
  label?: string;
  automationId?: string;
  automationName?: string;
} | null | undefined;

const normalizeSourceText = (value: string | undefined): string => (
  value
    ?.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  ?? ''
);

function mentionsWinsAndLearnings(value: string | undefined): boolean {
  const normalized = normalizeSourceText(value);
  return /\bwins?\b.*\blearnings?\b/.test(normalized);
}

export function isWinsLearningsSource(source: InboxQualitySourceLike): boolean {
  if (!source) return false;
  return mentionsWinsAndLearnings(source.automationId)
    || mentionsWinsAndLearnings(source.automationName)
    || mentionsWinsAndLearnings(source.label);
}

export function isThirdPartyInitiative(text: string): boolean {
  return THIRD_PARTY_INITIATIVE_PATTERNS.some(p => p.test(text));
}

export function isUserDirectedByThirdParty(text: string): boolean {
  return USER_DIRECTED_EXCLUSION_PATTERNS.some(p => p.test(text));
}

export function hasUserActionSignal(title: string): boolean {
  const trimmed = title
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '')
    .trim();
  if (ALREADY_IN_PROGRESS_SIGNALS.some(p => p.test(trimmed))) return false;
  if (ACTION_VERB_PREFIXES.some(p => p.test(trimmed))) return true;
  if (ACTION_SIGNAL_PHRASES.some(p => p.test(trimmed))) return true;
  return false;
}
