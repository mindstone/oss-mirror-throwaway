/**
 * Rebel App Bridge — cross-module type re-exports.
 *
 * Convenience import surface so consumers can do:
 *   import type { AppType, ErrorCode, AppConnection } from '@core/appBridge/types';
 * without reaching into subdirectories.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

export type {
  AppToBridgeMessage,
  AppType,
  AuthMessage,
  BridgeToAppMessage,
  CapabilityDescriptor,
  CommandMessage,
  ErrorMessage,
  EventMessage,
  KnownAppType,
  PingMessage,
  PongMessage,
  RegisterMessage,
  RegisteredAck,
  ResponseErrorMessage,
  ResponseMessage,
  ResponseSuccessMessage,
} from './shared/protocol';

export type { AppBridgeError } from './shared/errors';

export type {
  AppConnection,
  ConnectionManagerOptions,
  ConnectionRegisterArgs,
} from './server/connectionManager';
export type {
  CommandResult,
  CommandRouterOptions,
  DispatchArgs,
  RecentCommandLookup,
} from './server/commandRouter';
export type {
  PendingSession,
  PairingBindings,
  ClaimResult,
  PairingStoreOptions,
} from './server/pairingStore';
export type {
  AppTokenClaims,
  TokenKind,
  VerifyAppTokenOptions,
} from './server/tokenStore';
export type { OriginGuardOptions } from './server/originGuard';
export type { HttpRelayOptions } from './server/httpRelay';
export type { IntentHandlers, IntentRouterOptions } from './server/intentRouter';
export type { PairRoutesOptions } from './server/pairRoutes';
export type { AppBridgeOptions, AppBridgeHandle } from './server/bridge';
export type { WsServerHandle, WsServerOptions } from './server/wsServer';
export type { BrowserConversationScopeBinding } from './server/browserConversationScopeRegistry';
