/**
 * OAuth Connector Setup Metadata + Structured "not configured" result
 *
 * Single source of truth for the per-connector setup guidance an operator needs when a
 * connector is broken-by-default (no OAuth client credentials resolvable). This module is
 * intentionally SEPARATE from `oauthCredentials.ts`: the resolver table there
 * (`oauthCredentialEnvVars`) must stay byte-compatible for `scripts/check-commercial-capability-parity.ts`
 * and the existing resolver contract, so we add richer descriptors here instead of promoting it.
 *
 * Scope = the connectors that can actually hit the null path and need user-facing setup
 * guidance: slack, google, hubspot, github, microsoft, plaud, digitalocean, salesforce.
 * `discourse` is deliberately EXCLUDED: it self-generates its client_id (see
 * `src/main/services/discourseAuthService.ts`) and never reaches the null path.
 *
 * Like `oauthCredentials.ts`, this module never imports `@private/mindstone` (cross-surface safe)
 * and never logs or returns secret VALUES — only env var NAMES and public developer-console URLs.
 */

import {
  getOAuthRedirectUri,
  type OAuthRedirectConnector,
} from './oauthRedirectUri';
import {
  microsoftCredentialSource,
  oauthCredentialEnvVars,
  resolveMicrosoftClientId,
  resolveOAuthCredentials,
  resolveSalesforceCredentials,
  salesforceCredentialSource,
} from './oauthCredentials';

/**
 * Connectors in scope for setup guidance. A strict subset of `OAuthProvider`
 * (`oauthCredentials.ts`) extended with `microsoft` (PKCE public client), minus `discourse`.
 */
export type SetupConnector =
  | 'slack'
  | 'google'
  | 'hubspot'
  | 'github'
  | 'microsoft'
  | 'plaud'
  | 'digitalocean'
  | 'salesforce';

/**
 * Redirect topology for a connector. The shape differs per provider because the values an
 * operator must register in their OAuth app differ materially (verified against the live auth
 * flows — NOT a single generic callback):
 * - `worker`: the provider redirects to the hosted worker callback
 *   (`https://rebel-auth.mindstone.com/<provider>/callback`, env-overridable via
 *   `getOAuthRedirectUri`). One URI to register.
 * - `loopback-desktop`: a localhost loopback on a port assigned at connect time
 *   (`http://127.0.0.1:<port>/callback`). Google uses this — register the OAuth client as a
 *   "Desktop app", which permits loopback redirects without pre-registering a specific port.
 *   (`src/main/services/googleWorkspaceAuthService.ts`.)
 * - `loopback-fixed`: localhost loopback on a fixed set of ports; ALL must be registered as
 *   redirect URLs. HubSpot uses 8081–8084 (`src/main/services/hubspotAuthService.ts`).
 */
export type RedirectSpec =
  | { kind: 'worker' }
  | { kind: 'loopback-desktop'; note: string }
  | { kind: 'loopback-fixed'; uris: string[]; note: string };

export interface OAuthConnectorSetupDescriptor {
  provider: SetupConnector;
  displayName: string;
  /** Whether a client SECRET (not just a client ID) is required. Microsoft = false (PKCE). */
  requiresSecret: boolean;
  /**
   * Whether an operator can self-register an OAuth app today. `false` ⇒ access is limited
   * (e.g. waitlist/beta); the UI shows honest "not generally self-serve" copy rather than
   * promising a register-an-app flow. Plaud = false (OAuth API is early-beta/waitlist).
   */
  selfServe: boolean;
  /** Env var name carrying the OAuth client ID. */
  envClientId: string;
  /** Env var name carrying the OAuth client secret. Absent for PKCE public clients (Microsoft). */
  envClientSecret?: string;
  /**
   * Where the operator sets up the OAuth app. A real management/registration entrypoint where one
   * exists; otherwise the provider's setup guide (Salesforce/Plaud have no universal console URL).
   */
  setupUrl: string;
  /** How the redirect is registered — provider-accurate (see {@link RedirectSpec}). */
  redirect: RedirectSpec;
  /** Kebab anchor into `docs/connectors/CONNECTOR_SETUP.md` (e.g. `#slack`). */
  docsAnchor: string;
}

/**
 * Per-connector setup descriptors — the single source of truth for setup guidance.
 *
 * `envClientId` / `envClientSecret` are sourced from `oauthCredentialEnvVars`
 * (`microsoftCredentialSource` for Microsoft) so the names never drift from the resolvers.
 */
// HubSpot registers a fixed set of loopback callback ports (mirrors HUBSPOT_CALLBACK_PORTS in
// src/main/services/hubspotAuthService.ts); all must be added as redirect URLs in the HubSpot app.
const HUBSPOT_LOOPBACK_URIS = [
  'http://localhost:8081/callback',
  'http://localhost:8082/callback',
  'http://localhost:8083/callback',
  'http://localhost:8084/callback',
];

export const oauthConnectorSetupDescriptors = {
  slack: {
    provider: 'slack',
    displayName: 'Slack',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.slack.envClientId,
    envClientSecret: oauthCredentialEnvVars.slack.envClientSecret,
    setupUrl: 'https://api.slack.com/apps',
    redirect: { kind: 'worker' },
    docsAnchor: '#slack',
  },
  google: {
    provider: 'google',
    displayName: 'Google',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.google.envClientId,
    envClientSecret: oauthCredentialEnvVars.google.envClientSecret,
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
    redirect: {
      kind: 'loopback-desktop',
      note: 'Create the OAuth client as a "Desktop app" — Google permits a localhost loopback redirect (http://127.0.0.1:<port>/callback, port assigned at connect time) without registering a specific URI.',
    },
    docsAnchor: '#google',
  },
  hubspot: {
    provider: 'hubspot',
    displayName: 'HubSpot',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.hubspot.envClientId,
    envClientSecret: oauthCredentialEnvVars.hubspot.envClientSecret,
    setupUrl: 'https://app.hubspot.com/developer',
    redirect: {
      kind: 'loopback-fixed',
      uris: HUBSPOT_LOOPBACK_URIS,
      note: 'Add all four localhost callback URLs as redirect URLs in your HubSpot app (the app picks the first free port, 8081–8084).',
    },
    docsAnchor: '#hubspot',
  },
  github: {
    provider: 'github',
    displayName: 'GitHub',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.github.envClientId,
    envClientSecret: oauthCredentialEnvVars.github.envClientSecret,
    setupUrl: 'https://github.com/settings/developers',
    redirect: { kind: 'worker' },
    docsAnchor: '#github',
  },
  microsoft: {
    provider: 'microsoft',
    displayName: 'Microsoft',
    // Microsoft uses PKCE (public client) — client ID only, no secret.
    requiresSecret: false,
    selfServe: true,
    envClientId: microsoftCredentialSource.envClientId,
    // Entra admin center → App registrations.
    setupUrl: 'https://entra.microsoft.com/',
    redirect: { kind: 'worker' },
    docsAnchor: '#microsoft',
  },
  plaud: {
    provider: 'plaud',
    displayName: 'Plaud',
    requiresSecret: true,
    // Plaud's OAuth API is early-beta / waitlist — not generally self-serve. The UI shows honest
    // limited-access copy instead of a register-an-app flow.
    selfServe: false,
    envClientId: oauthCredentialEnvVars.plaud.envClientId,
    envClientSecret: oauthCredentialEnvVars.plaud.envClientSecret,
    setupUrl: 'https://plaud.mintlify.app/api_guide/api_intro/authorization',
    redirect: { kind: 'worker' },
    docsAnchor: '#plaud',
  },
  digitalocean: {
    provider: 'digitalocean',
    displayName: 'DigitalOcean',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.digitalocean.envClientId,
    envClientSecret: oauthCredentialEnvVars.digitalocean.envClientSecret,
    setupUrl: 'https://cloud.digitalocean.com/account/api/applications',
    redirect: { kind: 'worker' },
    docsAnchor: '#digitalocean',
  },
  salesforce: {
    provider: 'salesforce',
    displayName: 'Salesforce',
    requiresSecret: true,
    selfServe: true,
    envClientId: oauthCredentialEnvVars.salesforce.envClientId,
    envClientSecret: oauthCredentialEnvVars.salesforce.envClientSecret,
    // No universal console URL — a Connected App is created in your org's Setup → App Manager.
    setupUrl: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm&type=5',
    redirect: { kind: 'worker' },
    docsAnchor: '#salesforce',
  },
} as const satisfies Record<SetupConnector, OAuthConnectorSetupDescriptor>;

/** All in-scope connectors (Discourse excluded by construction). */
export const setupConnectors = Object.keys(
  oauthConnectorSetupDescriptors,
) as SetupConnector[];

/**
 * Structured, machine-readable result describing a connector that cannot connect because no
 * OAuth client credentials are configured. The `code` discriminant lets every consumer
 * (handlers, IPC schemas, renderer) branch on the same canonical shape instead of parsing
 * ad-hoc error strings.
 *
 * Exported so Stage 2 (IPC/Zod schemas) and the renderer import the identical shape.
 */
export interface OAuthCredentialsNotConfigured {
  code: 'oauth-credentials-not-configured';
  provider: SetupConnector;
  displayName: string;
  /** Neutral, build-AGNOSTIC one-liner. The build-aware ".env.local" copy lives in the UI. */
  message: string;
  /** Whether the operator can self-register an OAuth app today (false ⇒ waitlist/beta copy). */
  selfServe: boolean;
  /** Setup entrypoint URL (management console where one exists, else the provider's setup guide). */
  setupUrl: string;
  /** Exact env var names to set (Microsoft → client ID only; secret providers → both). */
  envVars: string[];
  /**
   * Exact redirect URI(s) the operator must register in their OAuth app, honoring
   * `<PROVIDER>_REDIRECT_URI` env overrides (worker connectors → one; HubSpot → its four fixed
   * loopback ports). Empty for Google's Desktop-app loopback, where no specific URI is registered —
   * see {@link redirectNote}. Treat as exact values to register, NOT necessarily copy-one-field.
   */
  redirectUris: string[];
  /** Human-readable redirect caveat (dynamic port / Desktop-app loopback / register-all). */
  redirectNote?: string;
}

export const OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE =
  'oauth-credentials-not-configured' as const;

/**
 * The `microsoft` setup connector has no entry in `OAuthRedirectConnector`'s union for a
 * loopback flow; map setup connectors to the redirect-URI connector enum. Every worker-topology
 * connector here exists in `OAuthRedirectConnector`; loopback connectors (Google/HubSpot) have
 * no hosted callback so we synthesise a localhost-loopback note instead.
 */
function envVarsFor(descriptor: OAuthConnectorSetupDescriptor): string[] {
  if (descriptor.requiresSecret && descriptor.envClientSecret) {
    return [descriptor.envClientId, descriptor.envClientSecret];
  }
  return [descriptor.envClientId];
}

/**
 * Resolve the exact redirect URI(s) + caveat note for a connector, provider-accurately:
 * - worker → the effective hosted-worker callback (honors `<PROVIDER>_REDIRECT_URI` override).
 * - loopback-desktop (Google) → no specific URI to register; note explains the Desktop-app loopback.
 * - loopback-fixed (HubSpot) → the fixed port URIs, all of which must be registered.
 * Exhaustive over RedirectSpec.kind (a new kind is a compile error here).
 */
function redirectInfoFor(descriptor: OAuthConnectorSetupDescriptor): {
  redirectUris: string[];
  redirectNote?: string;
} {
  const { redirect } = descriptor;
  switch (redirect.kind) {
    case 'worker':
      // Worker connectors are all members of OAuthRedirectConnector.
      return { redirectUris: [getOAuthRedirectUri(descriptor.provider as OAuthRedirectConnector)] };
    case 'loopback-desktop':
      return { redirectUris: [], redirectNote: redirect.note };
    case 'loopback-fixed':
      return { redirectUris: redirect.uris, redirectNote: redirect.note };
    default: {
      const _exhaustive: never = redirect;
      return _exhaustive;
    }
  }
}

/**
 * Describe what's missing for a connector that can't resolve OAuth client credentials.
 * Returns a discriminated-union value; never reads or returns secret values.
 */
export function describeMissingOAuthCredentials(
  provider: SetupConnector,
): OAuthCredentialsNotConfigured {
  const descriptor = oauthConnectorSetupDescriptors[provider];
  // Defence-in-depth: this value is meant to cross the Zod/IPC boundary (Stage 2), where a raw
  // connector id could arrive. Fail loud rather than throwing an opaque "undefined.displayName".
  if (!descriptor) {
    throw new Error(
      `describeMissingOAuthCredentials: unknown setup connector "${String(provider)}"`,
    );
  }
  const { redirectUris, redirectNote } = redirectInfoFor(descriptor);
  return {
    code: OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE,
    provider,
    displayName: descriptor.displayName,
    message: `${descriptor.displayName} needs OAuth client credentials before anyone can connect.`,
    selfServe: descriptor.selfServe,
    setupUrl: descriptor.setupUrl,
    envVars: envVarsFor(descriptor),
    redirectUris,
    redirectNote,
  };
}

export interface ConnectorConfigState {
  provider: SetupConnector;
  configured: boolean;
}

/**
 * Whether a connector's credentials currently resolve (env OR injected provider). Mirrors the
 * resolver each handler uses; never returns or logs the secret values themselves.
 */
function isConfigured(provider: SetupConnector): boolean {
  if (provider === 'microsoft') {
    return resolveMicrosoftClientId(microsoftCredentialSource) !== null;
  }
  // Salesforce is BYOK: creds may come from settings (user-entered Connected App), not just
  // env/provider — use the same resolver the start-auth handlers use so the status/log
  // diagnostic doesn't report a stale "unconfigured" after the user has saved them.
  if (provider === 'salesforce') {
    return resolveSalesforceCredentials(salesforceCredentialSource) !== null;
  }
  return resolveOAuthCredentials(oauthCredentialEnvVars[provider]) !== null;
}

/**
 * Current config state for every in-scope connector — for the startup-log enumeration and
 * the renderer empty/pre-warn state. Booleans only; no secret values.
 */
export function getConnectorConfigState(): ConnectorConfigState[] {
  return setupConnectors.map((provider) => ({
    provider,
    configured: isConfigured(provider),
  }));
}

/**
 * Public, OSS-facing connector setup guide (created by Stage 6). Used as the `setupDocs` pointer
 * in the OSS startup log line so source/CLI users have a self-diagnosing breadcrumb. A repo-relative
 * path (not a secret, not an internal URL) kept in lockstep with the Stage 6 doc location.
 */
export const CONNECTOR_SETUP_DOCS_PATH = 'docs/connectors/CONNECTOR_SETUP.md';

/** Per-connector credential status string for the OSS startup-log payload. */
export type ConnectorConfigStatus = 'configured' | 'unconfigured';

/**
 * Structured, secret-free payload for the OSS startup log line. `connectors` maps every in-scope
 * provider to a `'configured' | 'unconfigured'` status (NEVER any credential value), and
 * `setupDocs` points at the OSS setup guide. Pure function of its input — extracted so it can be
 * unit-tested without driving the Electron main bootstrap.
 */
export interface ConnectorConfigLogPayload {
  kind: 'oss-connector-credential-status';
  connectors: Record<SetupConnector, ConnectorConfigStatus>;
  setupDocs: string;
}

/**
 * Map `getConnectorConfigState()` output to the secret-free OSS startup-log payload. Booleans are
 * projected to `'configured' | 'unconfigured'` status strings; no credential values are ever read.
 */
export function buildConnectorConfigLogPayload(
  state: ConnectorConfigState[],
): ConnectorConfigLogPayload {
  const connectors = {} as Record<SetupConnector, ConnectorConfigStatus>;
  for (const { provider, configured } of state) {
    connectors[provider] = configured ? 'configured' : 'unconfigured';
  }
  return {
    kind: 'oss-connector-credential-status',
    connectors,
    setupDocs: CONNECTOR_SETUP_DOCS_PATH,
  };
}
