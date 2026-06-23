import type { OAuthCredentialsProvider } from '@core/services/oauthCredentials';

/**
 * OSS-build OAuth credentials provider — intentionally empty.
 *
 * OSS builds are broken-by-default: every OAuth connector requires the operator to
 * register their own OAuth app and supply the matching env vars (see `.env.example` and
 * `260520_oss_release_strategy.md` Q6). Returning `null` here means the env-only resolver
 * has no fallback, preserving that contract by construction. The commercial build swaps in
 * a real provider via the `@private/mindstone` alias.
 */
export const LIVE_OAUTH_CREDENTIALS_PROVIDER: OAuthCredentialsProvider = {
  get(): null {
    return null;
  },
};
