/**
 * OAuth Credential Resolution
 *
 * Shared helper for resolving OAuth client credentials. Resolution order is
 * env vars first, then an optional injected provider (see `setOAuthCredentialsProvider`).
 * The commercial desktop build registers a real provider via `@private/mindstone`;
 * OSS / cloud-service / mobile register nothing (or the empty stub), so they remain
 * broken-by-default until an operator registers their own OAuth app and supplies the
 * matching env vars. This module never imports `@private/mindstone` (cross-surface safe).
 */

import { getSettings } from '@core/services/settingsStore';

export type OAuthProvider =
  | 'google'
  | 'slack'
  | 'hubspot'
  | 'github'
  | 'digitalocean'
  | 'salesforce'
  | 'plaud'
  | 'discourse';

export interface OAuthCredentialSource {
  provider: OAuthProvider;
  envClientId: string;
  envClientSecret: string;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export const oauthCredentialEnvVars = {
  google: {
    provider: 'google',
    envClientId: 'GOOGLE_CLIENT_ID',
    envClientSecret: 'GOOGLE_CLIENT_SECRET',
  },
  slack: {
    provider: 'slack',
    envClientId: 'SLACK_CLIENT_ID',
    envClientSecret: 'SLACK_CLIENT_SECRET',
  },
  hubspot: {
    provider: 'hubspot',
    envClientId: 'HUBSPOT_CLIENT_ID',
    envClientSecret: 'HUBSPOT_CLIENT_SECRET',
  },
  github: {
    provider: 'github',
    envClientId: 'GITHUB_CLIENT_ID',
    envClientSecret: 'GITHUB_CLIENT_SECRET',
  },
  digitalocean: {
    provider: 'digitalocean',
    envClientId: 'DIGITAL_OCEAN_CLIENT_ID',
    envClientSecret: 'DIGITAL_OCEAN_CLIENT_SECRET',
  },
  salesforce: {
    provider: 'salesforce',
    envClientId: 'SALESFORCE_CLIENT_ID',
    envClientSecret: 'SALESFORCE_CLIENT_SECRET',
  },
  plaud: {
    provider: 'plaud',
    envClientId: 'PLAUD_CLIENT_ID',
    envClientSecret: 'PLAUD_CLIENT_SECRET',
  },
  discourse: {
    provider: 'discourse',
    envClientId: 'DISCOURSE_CLIENT_ID',
    envClientSecret: 'DISCOURSE_CLIENT_SECRET',
  },
} as const satisfies Record<OAuthProvider, OAuthCredentialSource>;

const readEnv = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

/**
 * Injected fallback for OAuth client credentials.
 *
 * Environment variables ALWAYS take precedence (per-operator / CI override + the
 * documented local-dev path). The provider is consulted only when the env pair is
 * incomplete. The commercial desktop build registers a real provider (via the
 * `@private/mindstone` alias — see `private/mindstone/src/services/oauthCredentialsProvider.ts`);
 * OSS builds register the empty stub provider and cloud-service / mobile register
 * nothing at all, so resolution stays env-only / broken-by-default for them by
 * construction. `src/core` MUST NOT import `@private/mindstone` directly (that alias
 * resolves only in the desktop main bundle) — the provider is injected at desktop
 * bootstrap via `setOAuthCredentialsProvider`.
 *
 * Restores the zero-config behaviour that the OSS-scrub Stage 7 (`1d563956e`) removed
 * with the `EMBEDDED_CREDENTIALS` table, without re-embedding secrets in shared source.
 */
export type OAuthCredentialsProviderKey = OAuthProvider | 'microsoft';

export interface ProvidedOAuthCredentials {
  clientId: string;
  /** Omitted for PKCE public clients (e.g. Microsoft). */
  clientSecret?: string;
}

export interface OAuthCredentialsProvider {
  get(provider: OAuthCredentialsProviderKey): ProvidedOAuthCredentials | null;
}

let credentialsProvider: OAuthCredentialsProvider | null = null;

/**
 * Register the fallback credentials provider. Called once at desktop bootstrap with
 * the value from `@private/mindstone/bootstrap`. Pass `null` to clear (tests).
 */
export function setOAuthCredentialsProvider(
  provider: OAuthCredentialsProvider | null
): void {
  credentialsProvider = provider;
}

export function resolveOAuthCredentials(
  source: OAuthCredentialSource
): OAuthCredentials | null {
  const clientId = readEnv(source.envClientId);
  const clientSecret = readEnv(source.envClientSecret);
  if (clientId && clientSecret) return { clientId, clientSecret };

  const provided = credentialsProvider?.get(source.provider);
  if (provided?.clientId && provided.clientSecret) {
    return { clientId: provided.clientId, clientSecret: provided.clientSecret };
  }
  return null;
}

// Pre-configured sources for each provider
export const googleCredentialSource: OAuthCredentialSource = oauthCredentialEnvVars.google;
export const slackCredentialSource: OAuthCredentialSource = oauthCredentialEnvVars.slack;
export const hubspotCredentialSource: OAuthCredentialSource = oauthCredentialEnvVars.hubspot;
export const githubCredentialSource: OAuthCredentialSource = oauthCredentialEnvVars.github;

/**
 * Salesforce credential source.
 * Users must create their own Connected App.
 * This is because Salesforce Connected Apps are tied to specific orgs.
 */
export type SalesforceCredentialSource = OAuthCredentialSource;

/**
 * Resolve Salesforce Connected App credentials.
 *
 * Salesforce is bring-your-own-key (no embedded/provider credentials by design — each
 * org has its own Connected App), so for end users the credentials come from the
 * connector setup UI, which persists them to settings under `salesforce.clientId` /
 * `salesforce.clientSecret`. Resolution precedence:
 *   1. env vars  (dev/CI override + documented local-dev path — keeps the 260608 contract)
 *   2. user-provided settings  (the primary path for end users)
 *   3. injected provider  (empty for Salesforce — present only for completeness)
 *
 * `getSettings` is a core boundary accessor (no electron import), so this stays
 * cross-surface safe. Without this step the UI-entered creds are persisted but never
 * read, and start-auth fails with "Salesforce OAuth credentials not configured".
 */
export function resolveSalesforceCredentials(
  source: SalesforceCredentialSource
): OAuthCredentials | null {
  // 1. env vars — dev/CI override + documented local-dev path (keeps 260608 contract).
  const envClientId = readEnv(source.envClientId);
  const envClientSecret = readEnv(source.envClientSecret);
  if (envClientId && envClientSecret) return { clientId: envClientId, clientSecret: envClientSecret };

  // 2. user-provided settings — the PRIMARY path for end users. Salesforce is BYOK, so the
  //    user's Connected App key/secret (entered in the setup UI) must win over any provider.
  const salesforceSettings = getSettings().salesforce;
  const clientId = salesforceSettings?.clientId?.trim();
  const clientSecret = salesforceSettings?.clientSecret?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };

  // 3. injected provider — empty for Salesforce by design (BYOK); present only for completeness.
  const provided = credentialsProvider?.get(source.provider);
  if (provided?.clientId && provided.clientSecret) {
    return { clientId: provided.clientId, clientSecret: provided.clientSecret };
  }

  return null;
}

export const salesforceCredentialSource: SalesforceCredentialSource = oauthCredentialEnvVars.salesforce;

/**
 * Microsoft uses PKCE (public client flow), so we only need a client ID.
 * The client secret is optional and not required for desktop apps.
 */
export interface MicrosoftCredentialSource {
  provider: 'microsoft';
  envClientId: string;
}

export function resolveMicrosoftClientId(
  source: MicrosoftCredentialSource
): string | null {
  return readEnv(source.envClientId) ?? credentialsProvider?.get(source.provider)?.clientId ?? null;
}

export const microsoftCredentialSource: MicrosoftCredentialSource = {
  provider: 'microsoft',
  envClientId: 'MICROSOFT_CLIENT_ID',
};

/**
 * Plaud credential resolver.
 * Plaud doesn't support user-configured credentials.
 */
export function resolvePlaudCredentials(): OAuthCredentials | null {
  return resolveOAuthCredentials(oauthCredentialEnvVars.plaud);
}

/**
 * DigitalOcean credential resolver.
 * DigitalOcean doesn't support user-configured credentials.
 */
export function resolveDigitalOceanCredentials(): OAuthCredentials | null {
  return resolveOAuthCredentials(oauthCredentialEnvVars.digitalocean);
}
