export { SHARED_CHAT_UI_COPY } from './copy';

export { normalizeText, escapeHtml } from './safeText';

export type {
  DateFormatter,
  TimestampViewModel,
  ContextChipViewModel,
  EmptyStateViewModel,
  ContextChipInput,
} from './format';
export {
  hostFromUrl,
  formatRelativeTime,
  formatTimestampTitle,
  buildTimestampViewModel,
  buildContextChipViewModel,
  buildEmptyStateViewModel,
} from './format';

export type {
  SharedConnectionHealth,
  SharedHeaderStatus,
  ConversationNoticeKind,
  MessageRoleViewModel,
  MessageEntryViewModel,
  StreamingEntryViewModel,
  ThinkingEntryViewModel,
  ConversationEntryViewModel,
  ConversationNoticeViewModel,
} from './viewModels';
export {
  mapMessageRole,
  mergeStreamingAssistantText,
  buildMessageViewModel,
  buildConversationEntries,
  resolveHeaderStatus,
  buildConversationNotice,
} from './viewModels';
