import { useCallback, useMemo } from 'react';
import type { AgentSession, AgentSessionSummary, TextFileAttachmentPayload } from '@shared/types';
import type { ConversationSummary } from '@shared/ipc/schemas/sessions';
import { searchSessionTitles, clearTitleFuseCache } from '@renderer/utils/conversationSearch';
import { isMessageHidden } from '@renderer/features/agent-session/store';
import { createId } from '@renderer/utils/stringUtils';
import type { ConversationMentionResult } from '../types';

/** Regex to extract rebel://conversation/{id} URLs (both in markdown links and standalone) */
const CONVERSATION_URL_REGEX = /rebel:\/\/conversation\/([a-zA-Z0-9_-]+)/g;

/** Maximum characters to include in conversation transcript attachment */
const MAX_TRANSCRIPT_CHARS = 2000;

/** Maximum messages to include in conversation transcript attachment */
const MAX_TRANSCRIPT_MESSAGES = 10;

/**
 * Format an AI-generated conversation summary into markdown for attachment.
 * Structured to help the receiving agent understand context quickly.
 */
const formatAISummary = (summary: ConversationSummary, title: string): string => {
  const lines: string[] = [];

  lines.push(`# Referenced Conversation: ${title}`);
  lines.push('');
  lines.push('## Overview');
  lines.push(summary.overview);
  lines.push('');

  if (summary.keyDecisions.length > 0) {
    lines.push('## Key Decisions & Intent');
    for (const decision of summary.keyDecisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }

  if (summary.gotchasAndInsights.length > 0) {
    lines.push('## Gotchas & Insights');
    for (const insight of summary.gotchasAndInsights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  if (summary.resourcesMentioned.length > 0) {
    lines.push('## Resources Referenced');
    for (const resource of summary.resourcesMentioned) {
      lines.push(`- ${resource}`);
    }
  }

  return lines.join('\n');
};

export type ConversationReference = {
  id: string;
  title: string;
};

export type UseConversationMentionsOptions = {
  /** Session summaries for title-only search (lazy loading Stage 7) */
  sessionSummaries: AgentSessionSummary[];
  currentSessionId: string;
};

export type UseConversationMentionsResult = {
  /** Search conversations by title for @-mention autocomplete */
  conversationResultsForQuery: (query: string) => ConversationMentionResult[];
  /** Extract conversation references from text */
  extractConversationReferences: (text: string) => ConversationReference[];
  /** Prepare conversation attachments for agent turn (async - lazy loads sessions) */
  prepareConversationAttachments: (text: string) => Promise<TextFileAttachmentPayload[]>;
  /** Clear the search cache (call when sessions change) */
  clearCache: () => void;
};

/**
 * Hook for conversation @-mention support.
 * 
 * Uses sessionSummaries for lightweight title-only search (lazy loading Stage 7).
 * When preparing attachments, it lazy-loads full sessions via IPC.
 */
export function useConversationMentions({
  sessionSummaries,
  currentSessionId
}: UseConversationMentionsOptions): UseConversationMentionsResult {
  // Memoize the summaries list to avoid unnecessary re-renders
  const summariesForSearch = useMemo(() => {
    // Include all sessions except deleted ones
    return sessionSummaries.filter((s) => s.deletedAt == null);
  }, [sessionSummaries]);

  // Convert summaries to AgentSession-like objects for searchSessionTitles
  // (searchSessionTitles expects messages.length, but we use messageCount from summary)
  const sessionsForSearch = useMemo(() => {
    return summariesForSearch.map((summary) => ({
      id: summary.id,
      title: summary.title ?? 'Untitled',
      messages: new Array(summary.messageCount ?? 0), // Dummy array for length check
      updatedAt: summary.updatedAt ?? summary.createdAt ?? Date.now(),
      createdAt: summary.createdAt ?? Date.now(),
      isCorrupted: false, // Summaries don't have this field - assume not corrupted
      origin: summary.origin
    })) as AgentSession[];
  }, [summariesForSearch]);

  const conversationResultsForQuery = useCallback(
    (query: string): ConversationMentionResult[] => {
      if (!query.trim()) {
        // For empty query, return recent conversations (exclude current session)
        return summariesForSearch
          .filter((s) => (s.messageCount ?? 0) > 0 && s.id !== currentSessionId)
          .slice(0, 4)
          .map((summary) => ({
            kind: 'conversation' as const,
            id: summary.id,
            title: summary.title ?? 'Untitled',
            updatedAt: summary.updatedAt ?? summary.createdAt ?? Date.now(),
            messageCount: summary.messageCount ?? 0,
            score: 0,
            matches: [],
            origin: summary.origin
          }));
      }

      const results = searchSessionTitles(query, sessionsForSearch, { limit: 8 });

      // Exclude current session - self-referencing isn't useful
      return results.filter((result) => result.id !== currentSessionId);
    },
    [summariesForSearch, sessionsForSearch, currentSessionId]
  );

  const clearCache = useCallback(() => {
    clearTitleFuseCache();
  }, []);

  /** Extract conversation references from text by finding rebel://conversation/{id} URLs */
  const extractConversationReferences = useCallback(
    (text: string): ConversationReference[] => {
      const refs: ConversationReference[] = [];
      const seen = new Set<string>();

      // Reset regex state
      CONVERSATION_URL_REGEX.lastIndex = 0;

      let match;
      while ((match = CONVERSATION_URL_REGEX.exec(text)) !== null) {
        const [, id] = match;
        if (!seen.has(id)) {
          seen.add(id);
          // Look up title from summaries if available
          const summary = summariesForSearch.find((s) => s.id === id);
          refs.push({ id, title: summary?.title || 'Untitled' });
        }
      }

      return refs;
    },
    [summariesForSearch]
  );

  /** Format a conversation as a text attachment for the agent */
  const formatConversationTranscript = useCallback(
    (session: AgentSession): string => {
      const lines: string[] = [];
      const timestamp = new Date(session.updatedAt ?? session.createdAt ?? Date.now());

      lines.push(`# Conversation: ${session.title}`);
      lines.push(`Date: ${timestamp.toLocaleDateString()} ${timestamp.toLocaleTimeString()}`);
      lines.push(`Messages: ${session.messages.length}`);
      lines.push('');
      lines.push('## Transcript');
      lines.push('');

      // Include user, assistant, and result messages ('result' = Rebel's final response after turn completes)
      const relevantMessages = session.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'result') && !isMessageHidden(m))
        .slice(-MAX_TRANSCRIPT_MESSAGES);

      let charCount = 0;
      for (const msg of relevantMessages) {
        const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
        const line = `**${roleLabel}:** ${msg.text}`;

        if (charCount + line.length > MAX_TRANSCRIPT_CHARS) {
          lines.push('...(transcript truncated)');
          break;
        }

        lines.push(line);
        lines.push('');
        charCount += line.length;
      }

      return lines.join('\n');
    },
    []
  );

  /** Prepare conversation attachments for agent turn (async - uses AI summaries via IPC) */
  const prepareConversationAttachments = useCallback(
    async (text: string): Promise<TextFileAttachmentPayload[]> => {
      const refs = extractConversationReferences(text);
      const attachments: TextFileAttachmentPayload[] = [];

      // Process mentions in parallel for reduced latency
      const results = await Promise.all(
        refs.map(async (ref) => {
          try {
            // Call IPC to generate AI summary (or fallback to truncation)
            const result = await window.sessionsApi.generateSummary({
              sessionId: ref.id,
            });

            if (result.error) {
              console.warn(`Summary generation error for ${ref.id}: ${result.error}`);
            }

            return { ref, result };
          } catch (err) {
            console.error(`Failed to generate summary for ${ref.id}:`, err);
            return { ref, result: null };
          }
        })
      );

      for (const { ref, result } of results) {
        let content: string;
        let title: string = ref.title;

        if (result?.summary && !result.fallbackUsed) {
          // Use AI-generated summary
          content = formatAISummary(result.summary, ref.title);
        } else {
          // Fallback to current truncation approach
          const session = await window.sessionsApi.get({ id: ref.id });
          if (!session) {
            // Session not found - skip (will show error when user clicks the link)
            continue;
          }
          content = formatConversationTranscript(session);
          title = session.title;
        }

        const contentBytes = new TextEncoder().encode(content).length;

        // Sanitize title for filename, fallback to session ID if empty after sanitization
        let safeName = title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().slice(0, 50);
        if (!safeName) {
          safeName = `conversation-${ref.id.slice(0, 8)}`;
        }

        attachments.push({
          type: 'textfile',
          id: createId(),
          name: `${safeName}.md`,
          mimeType: 'text/markdown',
          content,
          originalSizeBytes: contentBytes,
          contentSizeBytes: contentBytes,
        });
      }

      return attachments;
    },
    [extractConversationReferences, formatConversationTranscript]
  );

  return {
    conversationResultsForQuery,
    extractConversationReferences,
    prepareConversationAttachments,
    clearCache
  };
}
