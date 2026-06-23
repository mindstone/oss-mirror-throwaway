import type { PrivateMindstoneBootstrap } from '@core/services/privateMindstoneBootstrap';
import type { CurrentUserProviderFactory } from '@core/currentUserProvider';
import { OSS_NULL_AUTH_PROVIDER } from '@core/services/ossNullAuthProvider';
import { registerAuthHandlers } from './ipc/authHandlers';
import { LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER } from './services/meetingBotBackendConfigProvider';
import { LIVE_OAUTH_CREDENTIALS_PROVIDER } from './services/oauthCredentialsProvider';
// Single source of truth for the build-mode signal — imported from the pure
// `@private/mindstone/mode` module (zero auth/store imports) and re-exported here so
// `ensureAppIdentity`/`bootstrap.ts` can read it before electron-store without pulling
// in auth. (B6 Stage 1; merged with the B3 stage6 bootstrap expansion.)
import { PRIVATE_MINDSTONE_BOOTSTRAP_MODE } from './mode';

export { PRIVATE_MINDSTONE_BOOTSTRAP_MODE };
export const PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER = 'private-mindstone-stub-stage6';

export const LIVE_AUTH_PROVIDER = OSS_NULL_AUTH_PROVIDER;
export const LIVE_CURRENT_USER_PROVIDER_FACTORY: CurrentUserProviderFactory = () => ({
  getCurrentUser: () => ({
    id: 'oss-user',
    name: 'You',
    email: '',
    image: null,
  }),
});
export const forceAuthConfigRefresh = async (): Promise<void> => {};

export { LIVE_OAUTH_CREDENTIALS_PROVIDER };
export { LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER };

export const privateMindstoneBootstrap = {
  LIVE_AUTH_PROVIDER,
  LIVE_CURRENT_USER_PROVIDER_FACTORY,
  LIVE_OAUTH_CREDENTIALS_PROVIDER,
  LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER,
  PRIVATE_MINDSTONE_BOOTSTRAP_MODE,
  PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER,
  forceAuthConfigRefresh,
  registerPrivateMindstoneHandlers: (_registry) => {
    registerAuthHandlers();
  },
  registerPrivateMindstoneHealthCheck: (registry) => {
    registry.registerAuthHealthCheck(() => ({
      id: 'authHealth',
      name: 'Authentication',
      status: 'pass',
      message: 'OSS build - authentication not configured',
    }));
  },
} satisfies PrivateMindstoneBootstrap;

export const {
  registerPrivateMindstoneHandlers,
  registerPrivateMindstoneHealthCheck,
} = privateMindstoneBootstrap;
