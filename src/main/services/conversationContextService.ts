/**
 * Conversation Context Service
 *
 * Provides relevant conversation context for agent turns by performing semantic search
 * on indexed conversation history and formatting results for inclusion in the prompt.
 *
 * Keyword-triggered search: Only runs when user explicitly requests via @conversations.
 * Uses bookend truncation to fit long conversations within context limits.
 */

import type { AgentSession, AgentTurnMessage } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { searchConversations } from './conversationIndexService';
import { getIncrementalSessionStore } from './incrementalSessionStore';

const log = createScopedLogger({ service: 'conversationContext' });

// Context limits to prevent overflow
const MAX_CONVERSATION_RESULTS = 3;
const MAX_CHARS_PER_CONVERSATION = 5000;
const MAX_TOTAL_CONVERSATION_CHARS = 15000;

// Search threshold - lower than files since conversation content is more varied
const DEFAULT_SEARCH_THRESHOLD = 0.25;

// Auto-injection search threshold — raised from 0.55 based on log analysis of 37 interactive
// sessions: 70% of injected conversations had top-match scores below 0.70, contributing
// ~6,100 chars/turn of marginal context to both planner (Opus) and executor (Sonnet).
// Keep in sync with AUTO_CONVERSATION_THRESHOLD in preTurnWorker.ts
export const AUTO_CONVERSATION_THRESHOLD = 0.70;

// Threshold for high-confidence conversation matches that get larger excerpts.
export const HIGH_CONFIDENCE_CONVERSATION_THRESHOLD = 0.80;

// Auto-injection limits (stricter than explicit @conversations)
export const MAX_AUTO_CONVERSATION_CHARS = 8000;
export const MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION = 3500;
// High-confidence conversations get a larger excerpt budget
export const MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH = 5000;

/**
 * Keywords that trigger conversation search.
 * Must be matched with word boundaries to avoid false positives.
 */
const CONVERSATION_SEARCH_KEYWORDS = ['@conversations'] as const;

export interface ParsedConversationKeyword {
  /** Whether an explicit conversation search keyword was found */
  hasConversationSearch: boolean;
  /** The prompt with keywords stripped (for sending to agent) */
  sanitizedPrompt: string;
  /** Which keyword was matched, if any */
  matchedKeyword?: string;
}

/**
 * Parse a prompt for explicit conversation search keyword (@conversations).
 * Uses boundary-aware matching to avoid false positives.
 *
 * Valid matches:
 * - Start of message: "@conversations find the pricing discussion"
 * - Isolated token: "please @conversations for meeting notes"
 * - With punctuation: "@conversations, what about..."
 *
 * @param prompt - The user's original prompt
 * @returns Parsing result with hasConversationSearch flag and sanitized prompt
 */
export function parseConversationSearchKeyword(prompt: string): ParsedConversationKeyword {
  const trimmedPrompt = prompt.trim();

  for (const keyword of CONVERSATION_SEARCH_KEYWORDS) {
    // Build regex that matches keyword at word boundary
    // - Start of string OR preceded by whitespace
    // - The keyword itself (case-insensitive)
    // - End of string OR followed by whitespace/punctuation (not alphanumeric or underscore)
    const pattern = new RegExp(
      `(^|\\s)(${keyword.replace('@', '@')})(?=$|[\\s,.:;!?\\n\\r])`,
      'i'
    );

    const match = trimmedPrompt.match(pattern);
    if (match) {
      // Remove the keyword from prompt, preserving surrounding structure
      // Important: Preserve newlines and formatting - only normalize multiple spaces on same line
      const sanitizedPrompt = trimmedPrompt
        .replace(pattern, '$1') // Keep the leading whitespace if any
        .trim()
        .replace(/^[,.:;!?\s]+/, '') // Strip leading punctuation left after keyword removal
        .replace(/ {2,}/g, ' '); // Normalize only multiple consecutive spaces (preserve newlines)

      log.debug(
        { keyword, originalLength: prompt.length, sanitizedLength: sanitizedPrompt.length },
        'Conversation search keyword detected'
      );

      return {
        hasConversationSearch: true,
        sanitizedPrompt,
        matchedKeyword: keyword,
      };
    }
  }

  return {
    hasConversationSearch: false,
    sanitizedPrompt: trimmedPrompt,
  };
}

export interface ConversationContextResult {
  sessionId: string;
  title: string;
  score: number;
  excerpt: string;
  messageRange: string; // e.g., "messages 1-4, 47"
  totalMessages: number;
}

export interface ConversationContext {
  conversations: ConversationContextResult[];
  formattedContext: string;
  totalConversations: number;
}

/**
 * Extract a "bookend" excerpt from conversation messages.
 * Returns first 2 user/assistant exchanges + last assistant message.
 * Truncates to fit within character limit.
 */
export function extractBookendExcerpt(
  messages: AgentTurnMessage[],
  maxChars: number
): { excerpt: string; messageRange: string } {
  // Filter to user and assistant/result messages ('result' = Rebel's final consolidated response)
  const relevantMessages = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'result') && !m.isHidden
  );

  if (relevantMessages.length === 0) {
    return { excerpt: '', messageRange: 'no messages' };
  }

  // For short conversations, include everything
  if (relevantMessages.length <= 5) {
    const excerpt = formatMessages(relevantMessages, maxChars);
    const range = `messages 1-${relevantMessages.length}`;
    return { excerpt, messageRange: range };
  }

  // Bookend strategy: first 4 messages (2 exchanges) + last assistant/result message
  const firstFour = relevantMessages.slice(0, 4);
  const lastAssistant = relevantMessages
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant' || m.role === 'result');

  // Check if last assistant is already in first four
  const lastAssistantInFirstFour = lastAssistant
    ? firstFour.some((m) => m.id === lastAssistant.id)
    : false;

  const selectedMessages = lastAssistantInFirstFour || !lastAssistant
    ? firstFour
    : [...firstFour, lastAssistant];

  // Build message range string
  const lastMsgIndex = lastAssistant
    ? relevantMessages.findIndex((m) => m.id === lastAssistant.id) + 1
    : relevantMessages.length;
  const rangeStr = lastAssistantInFirstFour || !lastAssistant
    ? `messages 1-${Math.min(4, relevantMessages.length)}`
    : `messages 1-4, ${lastMsgIndex}`;

  // Format with ellipsis indicator if we're skipping messages
  let excerpt = '';
  for (let i = 0; i < selectedMessages.length; i++) {
    const msg = selectedMessages[i];

    // Add ellipsis before last message if there's a gap
    if (i === firstFour.length && !lastAssistantInFirstFour) {
      excerpt += '\n[...]\n\n';
    }

    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const text = msg.text ?? '';
    excerpt += `**${role}:** ${text}\n\n`;
  }

  // Truncate if needed
  if (excerpt.length > maxChars) {
    excerpt = excerpt.slice(0, maxChars - 3) + '...';
  }

  return { excerpt: excerpt.trim(), messageRange: rangeStr };
}

/**
 * Format messages into readable text, respecting character limit.
 * Maps both 'assistant' and 'result' roles to 'Assistant' label.
 */
function formatMessages(messages: AgentTurnMessage[], maxChars: number): string {
  let result = '';

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const text = msg.text ?? '';
    const line = `**${role}:** ${text}\n\n`;

    if (result.length + line.length > maxChars) {
      // Truncate remaining content
      const remaining = maxChars - result.length - 3;
      if (remaining > 50) {
        result += line.slice(0, remaining) + '...';
      }
      break;
    }
    result += line;
  }

  return result.trim();
}

/**
 * Get conversation context by searching conversation history.
 *
 * @param query - The search query (user's prompt with keyword stripped)
 * @param sessions - All agent sessions to search (passed to avoid import issues)
 * @param options - Search options
 * @returns Conversation context with formatted excerpts
 */
export async function getConversationContext(
  query: string,
  sessions: AgentSession[],
  options: { limit?: number; threshold?: number } = {}
): Promise<ConversationContext> {
  const { limit = MAX_CONVERSATION_RESULTS, threshold = DEFAULT_SEARCH_THRESHOLD } = options;

  if (!query || query.trim().length === 0) {
    return { conversations: [], formattedContext: '', totalConversations: 0 };
  }

  try {
    // Perform semantic search on indexed conversations
    const searchResults = await searchConversations(query, { limit, threshold });

    if (searchResults.length === 0) {
      log.debug({ query: query.slice(0, 100) }, 'No relevant conversations found');
      return { conversations: [], formattedContext: '', totalConversations: 0 };
    }

    // Build session lookup map for quick access
    const sessionMap = new Map<string, AgentSession>();
    for (const session of sessions) {
      sessionMap.set(session.id, session);
    }

    // Process results with privacy filtering and excerpt extraction
    const contextResults: ConversationContextResult[] = [];
    let totalChars = 0;

    for (const result of searchResults) {
      const session = sessionMap.get(result.sessionId);

      // Skip if session not found (might have been deleted after indexing)
      if (!session) {
        log.debug({ sessionId: result.sessionId }, 'Session not found for search result');
        continue;
      }

      // Skip private mode sessions
      if (session.privateMode) {
        log.debug({ sessionId: result.sessionId }, 'Skipping private mode session');
        continue;
      }

      // Skip if we'd exceed total character limit
      if (totalChars >= MAX_TOTAL_CONVERSATION_CHARS) {
        log.debug(
          { totalChars, max: MAX_TOTAL_CONVERSATION_CHARS },
          'Stopping - total character limit reached'
        );
        break;
      }

      // Calculate remaining budget for this conversation
      const remainingBudget = Math.min(
        MAX_CHARS_PER_CONVERSATION,
        MAX_TOTAL_CONVERSATION_CHARS - totalChars
      );

      // Extract bookend excerpt
      const { excerpt, messageRange } = extractBookendExcerpt(
        session.messages,
        remainingBudget
      );

      if (!excerpt) {
        continue;
      }

      contextResults.push({
        sessionId: session.id,
        title: session.title,
        score: result.score,
        excerpt,
        messageRange,
        totalMessages: session.messages.filter(
          (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'result'
        ).length,
      });

      totalChars += excerpt.length;
    }

    if (contextResults.length === 0) {
      return { conversations: [], formattedContext: '', totalConversations: 0 };
    }

    // Format context for prompt
    const formattedContext = formatConversationContextForPrompt(contextResults);

    log.info(
      {
        query: query.slice(0, 50),
        conversationCount: contextResults.length,
        totalChars,
        topScore: contextResults[0]?.score,
      },
      'Found relevant conversations for context'
    );

    return {
      conversations: contextResults,
      formattedContext,
      totalConversations: contextResults.length,
    };
  } catch (error) {
    log.warn({ err: error }, 'Failed to get conversation context');
    return { conversations: [], formattedContext: '', totalConversations: 0 };
  }
}

/**
 * Format conversation search results for inclusion in the agent prompt.
 * Includes metadata about which messages are included and clickable rebel:// links.
 */
export function formatConversationContextForPrompt(
  conversations: ConversationContextResult[]
): string {
  if (conversations.length === 0) {
    return '';
  }

  const sections = conversations.map((conv, index) => {
    // Include rebel:// link so agent can reference the conversation with a clickable URL
    // Escape special markdown characters in title to avoid broken links
    const escapedTitle = conv.title
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\n/g, ' ');
    const link = formatNavigationUrl({ type: 'sessions', sessionId: conv.sessionId });
    const metadata = `From conversation [${escapedTitle}](${link}) (${conv.messageRange} of ${conv.totalMessages})`;
    return `### [${index + 1}] ${metadata}\n\n${conv.excerpt}`;
  });

  const preamble = `The following excerpts from past conversations may be relevant to this request.
When referencing these, use the provided markdown links (e.g., "[conversation title](rebel://conversation/...)") so users can click through.`;

  return `${preamble}\n\n${sections.join('\n\n---\n\n')}`;
}

export interface AutoConversationContextResult {
  sessionId: string;
  title: string;
  score: number;
  excerpt: string;
  messageRange: string;
  totalMessages: number;
}

/**
 * Format auto-injected conversation context with clear scope boundaries.
 * This path is silent/automatic, so each excerpt is labelled as a past
 * conversation (separate thread from the current one) and the preamble
 * tells the model to use them when genuinely relevant while attributing
 * clearly. Voice: cooperative, not prohibitive — referencing prior
 * conversations is a core Rebel capability we do not want to suppress.
 */
export function formatAutoConversationContext(results: AutoConversationContextResult[]): string {
  if (results.length === 0) return '';

  const sections = results.map((r) => {
    const safeTitle = r.title
      .replace(/\\/g, '\\\\')
      .replace(/[[\]()]/g, '\\$&')
      .replace(/\n/g, ' ');
    const link = formatNavigationUrl({ type: 'sessions', sessionId: r.sessionId });
    return `### Past conversation — [${safeTitle}](${link}) (separate thread from the current one)
Messages ${r.messageRange} of ${r.totalMessages} total (relevance: ${(r.score * 100).toFixed(0)}%)

${r.excerpt}`;
  });

  return `The following excerpts come from your other past conversations — separate threads, not continuations of the one we are in right now. Draw on them when they are genuinely relevant to the current request (for example, to answer a question about a past project or surface a past decision), and make it clear when you are referencing a past thread so the user can tell what is from where. If the current request does not connect to these excerpts, simply ignore them.\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Enhance a prompt with conversation context based on @conversations keyword.
 * Called after file context enhancement in the turn execution pipeline.
 *
 * @param prompt - The prompt (may already have file context prepended)
 * @param sessions - All agent sessions (for search and privacy filtering)
 * @returns Enhanced prompt with conversation context if @conversations was used
 */
export async function enhancePromptWithConversationContext(
  prompt: string,
  sessions: AgentSession[]
): Promise<{
  enhancedPrompt: string;
  contextAdded: boolean;
  conversationCount: number;
  formattedContext?: string;
  sanitizedPrompt: string;
}> {
  // Check for explicit @conversations keyword
  const { hasConversationSearch, sanitizedPrompt } = parseConversationSearchKeyword(prompt);

  if (!hasConversationSearch) {
    return {
      enhancedPrompt: prompt,
      contextAdded: false,
      conversationCount: 0,
      sanitizedPrompt: prompt,
    };
  }

  // Get conversation context using semantic search
  const context = await getConversationContext(sanitizedPrompt, sessions);

  if (!context.formattedContext) {
    return {
      enhancedPrompt: sanitizedPrompt,
      contextAdded: false,
      conversationCount: 0,
      sanitizedPrompt,
    };
  }

  return {
    enhancedPrompt: sanitizedPrompt,
    contextAdded: true,
    conversationCount: context.totalConversations,
    formattedContext: context.formattedContext,
    sanitizedPrompt,
  };
}

/**
 * Shared helper for auto-injecting conversation context.
 * Used by both worker and main-process fallback paths to eliminate duplication.
 * Loads sessions individually via getSession(), applies runtime privacy filter,
 * extracts bookend excerpts, and formats the context.
 */
export async function loadFilterAndFormatConversations(
  candidates: Array<{ sessionId: string; title: string; score: number }>,
  currentSessionId: string | undefined,
  logger: { debug: (obj: unknown, msg?: string) => void },
): Promise<{ formattedContext: string; count: number; totalChars: number; topScore: number } | null> {
  // Filter out current session
  const filtered = candidates.filter(c => c.sessionId !== currentSessionId);
  if (filtered.length === 0) return null;

  // Load sessions individually using targeted async lookup (not bulk loadSessions)
  const store = getIncrementalSessionStore();
  const loadResults = await Promise.allSettled(
    filtered.map(c => store.getSession(c.sessionId))
  );

  // Runtime privacy/validity filter
  const validCandidates: Array<{ candidate: typeof filtered[0]; session: AgentSession }> = [];
  for (let i = 0; i < filtered.length; i++) {
    const result = loadResults[i];
    if (result.status === 'rejected') continue;
    const session = result.value;
    if (!session) continue;
    if (session.privateMode || session.deletedAt || session.isCorrupted) {
      logger.debug({ sessionId: filtered[i].sessionId }, 'Auto-inject: session filtered by privacy/validity');
      continue;
    }
    validCandidates.push({ candidate: filtered[i], session });
  }

  // Take top 2 by score (already sorted from search)
  const topCandidates = validCandidates.slice(0, 2);
  if (topCandidates.length === 0) return null;

  let totalCharsUsed = 0;
  const autoResults: AutoConversationContextResult[] = [];

  for (const { candidate, session } of topCandidates) {
    const perConversationBudget = candidate.score >= HIGH_CONFIDENCE_CONVERSATION_THRESHOLD
      ? MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH
      : MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION;

    const charBudget = Math.min(
      perConversationBudget,
      MAX_AUTO_CONVERSATION_CHARS - totalCharsUsed,
    );
    if (charBudget <= 0) break;

    const { excerpt, messageRange } = extractBookendExcerpt(session.messages, charBudget);
    if (!excerpt) continue;

    const totalMessages = session.messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'result'
    ).length;

    autoResults.push({
      sessionId: session.id,
      title: session.title,
      score: candidate.score,
      excerpt,
      messageRange,
      totalMessages,
    });
    totalCharsUsed += excerpt.length;
  }

  if (autoResults.length === 0) return null;

  return {
    formattedContext: formatAutoConversationContext(autoResults),
    count: autoResults.length,
    totalChars: totalCharsUsed,
    topScore: autoResults[0].score,
  };
}
