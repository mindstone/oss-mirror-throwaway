/**
 * Rebel App Bridge — barrel export.
 *
 * Public surface consumed by bridge hosts (Stage 2+), the RebelAppBridge MCP
 * server (Stage 4), and Office sidecar once Stage 8 consolidates on the
 * shared primitives.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

// Factory
export { createAppBridge } from './server/bridge';

// Classes (exported so tests and future consumers can new them up directly)
export { ConnectionManager } from './server/connectionManager';
export { CommandRouter } from './server/commandRouter';
export { CapabilityRegistry } from './server/capabilityRegistry';
export { PairingStore } from './server/pairingStore';
export { TokenStore } from './server/tokenStore';
export { assertAllowedHost, assertAllowedOrigin, DEV_EXTENSION_IDS_FILE } from './server/originGuard';
export { createHttpRelayRouter } from './server/httpRelay';
export { createIntentRouter } from './server/intentRouter';
export { createPairRoutes } from './server/pairRoutes';
export { createWsServer } from './server/wsServer';
export { PermissionGrantTracker } from './server/permissionGrantTracker';
export type {
  PermissionGrant,
  PermissionGrantTrackerOptions,
} from './server/permissionGrantTracker';
export {
  BrowserConversationScopeRegistry,
  browserConversationScopeRegistry,
  tabContextsMateriallyMatch,
} from './server/browserConversationScopeRegistry';

// Error surface
export {
  ErrorCode,
  createAppBridgeError,
  toHttpStatus,
  toMcpContent,
  toWsErrorMessage,
  toWsCloseCode,
  toWsCloseReason,
} from './shared/errors';

// Protocol helpers + constants
export {
  APP_BRIDGE_PORT_FALLBACKS,
  CAPABILITY_KEYS,
  DEFAULT_APP_BRIDGE_PORT,
  PROTOCOL_VERSION,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_IDLE_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_NORMAL,
  WS_CLOSE_PROTOCOL_VERSION_MISMATCH,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  isAppType,
  isCapabilityKey,
} from './shared/protocol';

export type { CapabilityKey } from './shared/protocol';

// Intent schema placeholders
export {
  IntentConversationCreateSchema,
  IntentConversationMessageSchema,
} from './shared/intentProtocol';

// Types (re-exported from ./types for convenience)
export type {
  AppBridgeError,
  AppBridgeHandle,
  AppBridgeOptions,
  AppConnection,
  AppToBridgeMessage,
  AppTokenClaims,
  AppType,
  AuthMessage,
  BridgeToAppMessage,
  CapabilityDescriptor,
  ClaimResult,
  CommandMessage,
  CommandResult,
  CommandRouterOptions,
  ConnectionManagerOptions,
  ConnectionRegisterArgs,
  DispatchArgs,
  ErrorMessage,
  EventMessage,
  HttpRelayOptions,
  IntentHandlers,
  IntentRouterOptions,
  KnownAppType,
  OriginGuardOptions,
  PairRoutesOptions,
  PairingBindings,
  PairingStoreOptions,
  PendingSession,
  PingMessage,
  PongMessage,
  RecentCommandLookup,
  RegisterMessage,
  RegisteredAck,
  ResponseErrorMessage,
  ResponseMessage,
  ResponseSuccessMessage,
  TokenKind,
  VerifyAppTokenOptions,
  WsServerHandle,
  WsServerOptions,
} from './types';

export type {
  IntentConversationCreate,
  IntentConversationCreateResult,
  IntentConversationMessage,
  IntentConversationMessageResult,
  IntentConversationStateResult,
} from './shared/intentProtocol';
