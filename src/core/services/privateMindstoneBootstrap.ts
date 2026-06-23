import type { HandlerRegistry } from '@core/handlerRegistry';
import type { CurrentUserProviderFactory } from '@core/currentUserProvider';
import type { RebelAuthProvider } from '@core/rebelAuth';
import type { CheckResult } from '@core/services/health/types';
import type { MeetingBotBackendConfigProvider } from '@core/services/meetingBotBackendConfig';
import type { OAuthCredentialsProvider } from '@core/services/oauthCredentials';

export type PrivateMindstoneBootstrapMode = 'real' | 'stub';

export type PrivateMindstoneHealthCheck = () => CheckResult | Promise<CheckResult>;

export interface PrivateMindstoneHealthRegistry {
  registerAuthHealthCheck(check: PrivateMindstoneHealthCheck): void;
}

export interface PrivateMindstoneBootstrap {
  LIVE_AUTH_PROVIDER: RebelAuthProvider;
  LIVE_CURRENT_USER_PROVIDER_FACTORY: CurrentUserProviderFactory;
  /**
   * Fallback OAuth client-credentials provider, injected into the env-only core
   * resolver at desktop bootstrap. Commercial build → real creds; OSS stub → empty.
   */
  LIVE_OAUTH_CREDENTIALS_PROVIDER: OAuthCredentialsProvider;
  /**
   * Fallback meeting-bot backend config provider, injected into the env-first
   * core resolver at desktop bootstrap. Commercial build -> real URL + env key;
   * OSS stub -> empty.
   */
  LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER: MeetingBotBackendConfigProvider;
  PRIVATE_MINDSTONE_BOOTSTRAP_MODE: PrivateMindstoneBootstrapMode;
  PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER: string;
  forceAuthConfigRefresh: () => Promise<void>;
  registerPrivateMindstoneHandlers(registry: HandlerRegistry): void;
  registerPrivateMindstoneHealthCheck(registry: PrivateMindstoneHealthRegistry): void;
}
