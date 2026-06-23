import type { AppSettings, ModelProfile } from '@shared/types';
import { getProfileProviderDisplayName } from './providerDisplay';
import { resolveCredentialsForProfile, type ConnectionCredentials } from './credentialResolution';
import type { AgentErrorKind } from './agentErrorCatalog';

// `ConnectionCredentials` now lives in credentialResolution.ts (the canonical credential
// module); re-exported here so existing `@shared/utils/connectionCredentials` importers are
// unaffected. The one-directional dependency avoids a circular import.
export type { ConnectionCredentials };

/**
 * Optional, structured detail a `ConnectionNotConfiguredError` can carry so the
 * renderer can offer a model-aware, actionable recovery WITHOUT changing the
 * error class. FOX-3494: a native-Claude (`claude-*`) model selected for a
 * PRIMARY user turn under a connected ChatGPT Pro subscription with no Anthropic
 * key dead-ends; keeping the `ConnectionNotConfiguredError` class preserves every
 * existing `instanceof ConnectionNotConfiguredError` recoverable-terminal gate
 * (adaptive routing, alt-model / thinking-downgrade fallback rebuilds) by
 * construction, while these fields let `classifyErrorUx` lead with "switch to a
 * GPT model" for exactly this case.
 */
export interface ConnectionNotConfiguredDetail {
  /** The route-decision `invalidReason` that produced this terminal. */
  invalidReason?: string;
  /** Wire model id that could not be served (e.g. the `claude-*` id). */
  wireModel?: string;
  /**
   * The route role the failure originated from. Lets the switch-model recovery
   * repair the correct settings slot (`planning`→thinking, else working) so a
   * planning-role failure does not loop back into the same terminal.
   */
  failedRole?: 'execution' | 'planning' | 'bts' | 'subagent';
}

export class ConnectionNotConfiguredError extends Error {
  readonly kind = 'auth';
  readonly status = 401;
  readonly statusCode = 401;
  readonly provider?: string;
  readonly isTransient = false;
  readonly isAbort = false;
  readonly __agentErrorKind: AgentErrorKind = 'connection-not-configured';
  readonly __rawMessage: string;
  /** FOX-3494: optional structured detail for model-aware actionable recovery. */
  readonly invalidReason?: string;
  readonly wireModel?: string;
  readonly failedRole?: ConnectionNotConfiguredDetail['failedRole'];

  constructor(message: string, provider?: string, detail?: ConnectionNotConfiguredDetail) {
    super(message);
    this.name = 'ConnectionNotConfiguredError';
    this.provider = provider;
    this.__rawMessage = message;
    this.invalidReason = detail?.invalidReason;
    this.wireModel = detail?.wireModel;
    this.failedRole = detail?.failedRole;
  }
}

export class UnsupportedModelError extends Error {
  readonly kind = 'unsupported_model';
  readonly status = 400;
  readonly statusCode = 400;
  readonly provider?: string;
  readonly isTransient = false;
  readonly isAbort = false;
  readonly __agentErrorKind: AgentErrorKind = 'unsupported_model';
  readonly __rawMessage: string;
  readonly wireModel: string;

  constructor(message: string, wireModel: string, provider?: string) {
    super(message);
    this.name = 'UnsupportedModelError';
    this.provider = provider;
    this.__rawMessage = message;
    this.wireModel = wireModel;
  }
}

function isManagedConnectionProfile(profile: ModelProfile | null | undefined): boolean {
  return profile?.profileSource === 'connection' || profile?.profileSource === 'auto';
}

/**
 * Resolve the concrete connection credential material for a profile.
 *
 * Thin projection over the canonical `resolveCredentialsForProfile` chokepoint
 * (credentialResolution.ts): for a reachable verdict return the dispatch material; for an
 * unreachable verdict preserve the historical throw-vs-empty contract — managed (connection/
 * auto) profiles throw `ConnectionNotConfiguredError`, non-managed profiles return `{}`. The
 * `providerRouting.profileCredentialMatrix` test's SSOT cross-check exercises this projection
 * and proves it is behaviour-identical to the pre-extraction resolver.
 */
export function resolveConnectionCredentials(
  profile: ModelProfile,
  settings: AppSettings,
  codexMode?: unknown,
): ConnectionCredentials {
  const resolution = resolveCredentialsForProfile(profile, settings, codexMode);
  if (resolution.kind === 'reachable') {
    return resolution.credentials;
  }

  if (isManagedConnectionProfile(profile)) {
    const providerName = getProfileProviderDisplayName(profile);
    throw new ConnectionNotConfiguredError(`Reconnect ${providerName} to use this model`, providerName);
  }

  return {};
}
