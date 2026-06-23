/**
 * Connector-smoke setup: register the commercial OAuth credentials provider (TEST-ONLY).
 *
 * The live read-only connector-smoke validates the COMMERCIAL desktop build, which always
 * registers `LIVE_OAUTH_CREDENTIALS_PROVIDER` into the core resolver at bootstrap
 * (`src/main/index.ts` → `setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER)`). The
 * vitest process does NOT run that bootstrap, so without this module
 * `resolveOAuthCredentials(slackCredentialSource)` returns null, the OAuth connector cells'
 * client-cred prereq is "not met", and they skip-green — validating nothing. This mirrors the
 * desktop registration so the OAuth cells actually run live.
 *
 * IMPORTANT — ordering: `runConnectorSmoke(cell)` evaluates each cell's prereqs synchronously
 * at vitest *collection* time (top-level of the cell test files), which is BEFORE any
 * `beforeAll` would fire. So the provider MUST be registered as a module side-effect that runs
 * before the cells are collected. Every cell file imports the cells module, the cells module
 * imports this — so this side-effect runs first.
 *
 * Scope guard: register ONLY when the opt-in gate `RUN_CONNECTOR_SMOKE_TESTS` is set, so the
 * provider never leaks into other desktop-project test files sharing the same worker. Env-var
 * precedence is preserved by construction: `resolveOAuthCredentials` always checks env first
 * and only consults the provider when the env pair is incomplete (so SLACK_CLIENT_ID etc.
 * still win). The alias `@private/mindstone/bootstrap` resolves to the real commercial
 * provider in this (commercial) checkout, or the empty OSS stub in an OSS checkout — either
 * way the smoke does the right thing.
 */
import { LIVE_OAUTH_CREDENTIALS_PROVIDER } from '@private/mindstone/bootstrap';
import { setOAuthCredentialsProvider } from '@core/services/oauthCredentials';

if (process.env.RUN_CONNECTOR_SMOKE_TESTS?.trim()) {
  setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER);
}

/** Test-only teardown hook so a suite can restore the env-only resolver if it wants. */
export function clearCommercialOAuthProviderForConnectorSmoke(): void {
  setOAuthCredentialsProvider(null);
}
