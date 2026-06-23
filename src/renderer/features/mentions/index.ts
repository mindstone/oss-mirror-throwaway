/**
 * Mentions feature - unified @-mention system for files and conversations.
 *
 * @see docs/plans/finished/251219_conversation_references.md for design context
 */

export {
  type FileMentionResult,
  type ConversationMentionResult,
  type CommandMentionResult,
  type ModelMentionResult,
  type OperatorMentionResult,
  type UnifiedMentionResult,
  type MentionFilterType,
  type ParsedMentionQuery,
  isFileMentionResult,
  isConversationMentionResult,
  isCommandMentionResult,
  isModelMentionResult,
  isOperatorMentionResult,
  parseMentionQuery
} from './types';

export {
  useConversationMentions,
  type UseConversationMentionsOptions,
  type UseConversationMentionsResult,
  type ConversationReference
} from './hooks/useConversationMentions';
