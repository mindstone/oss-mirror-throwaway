export type {
  IntentKind,
  TabContextPayload,
  PageContextPayload,
  IntentConversationCreate,
  IntentConversationMessage,
  IntentConversationCreateResult,
  IntentConversationMessageResult,
  IntentConversationStateResult,
  IntentMessageWire,
  IntentConversationHistoryResult,
  IntentConversationFocusResult,
  StreamEvent,
} from './types';

export type { ChatErrorCode } from './errors';
export {
  ALL_CHAT_ERROR_CODES,
  mapErrorResponse,
  mapFetchException,
} from './errors';

export type { SSEFrame } from './sse';
export { parseSSEChunk, toStreamEvent } from './sse';

export type {
  TransportSurface,
  TransportKind,
  TransportDescriptor,
  HeaderBuildInit,
  IntentTransportAdapter,
} from './intentTransportAdapter';

export type {
  IntentOp,
  FetchExceptionShape,
  StreamCloseReason,
  DiagnosticEvent,
  DiagnosticSink,
} from './diagnostics';
export { NO_OP_SINK } from './diagnostics';
export type {
  InMemoryDiagnosticBuffer,
  InMemoryDiagnosticBufferOptions,
} from './diagnosticBuffer';
export {
  composeDiagnosticSinks,
  createInMemoryDiagnosticBuffer,
} from './diagnosticBuffer';

export type { PersistedChatState, ChatStatePersistence } from './persistence';

export type {
  CreateConversationInput,
  CreateConversationResult,
  SendMessageInput,
  SendMessageResult,
  GetHistoryInput,
  GetHistoryResult,
  FocusInRebelInput,
  FocusInRebelResult,
  ConnectStreamInput,
  ConnectStreamEvent,
  ResponseError,
  ConnectStreamError,
  IntentClientError,
  ConnectStreamHandlers,
} from './clientTypes';

export type { IntentClient } from './client';
export { createIntentClient, isResponseError } from './client';
