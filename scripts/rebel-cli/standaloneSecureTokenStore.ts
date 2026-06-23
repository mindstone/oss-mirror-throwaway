import { createScopedLogger } from '@core/logger';
import type {
  SecureTokenDeleteOptions,
  SecureTokenHasOptions,
  SecureTokenReadOptions,
  SecureTokenStore,
  SecureTokenWriteOptions,
} from '@core/secureTokenStore';

const log = createScopedLogger({ service: 'secure-token-store.standalone-cli' });

type EnvValueShape = 'string' | 'json_api_key';
type NamespaceKey = `${string}:${string}`;

interface EnvTokenMapping {
  envVar: string;
  shape: EnvValueShape;
}

const ENV_TOKEN_MAPPINGS: Record<NamespaceKey, EnvTokenMapping> = {
  'auth-tokens:encryptedSessionToken': { envVar: 'REBEL_AUTH_API_KEY', shape: 'string' },
  'fly-tokens:encryptedFlyApiToken': { envVar: 'REBEL_FLY_API_KEY', shape: 'string' },
  'fly-tokens:encryptedApiToken': { envVar: 'REBEL_FLY_API_KEY', shape: 'string' },
  'fly-tokens:encryptedOAuthTokens': { envVar: 'REBEL_FLY_OAUTH_TOKENS_JSON', shape: 'string' },
  'digitalocean-tokens:encryptedApiToken': { envVar: 'REBEL_DIGITALOCEAN_API_KEY', shape: 'string' },
  'digitalocean-tokens:encryptedOAuthTokens': { envVar: 'REBEL_DIGITALOCEAN_OAUTH_TOKENS_JSON', shape: 'string' },
  'hetzner-tokens:encryptedApiToken': { envVar: 'REBEL_HETZNER_API_KEY', shape: 'string' },
  'hetzner-tokens:encryptedOAuthTokens': { envVar: 'REBEL_HETZNER_OAUTH_TOKENS_JSON', shape: 'string' },
  'mindstone-tokens:encryptedApiToken': { envVar: 'REBEL_MINDSTONE_API_KEY', shape: 'string' },
  'mindstone-tokens:encryptedOAuthTokens': { envVar: 'REBEL_MINDSTONE_OAUTH_TOKENS_JSON', shape: 'string' },
  'openrouter-oauth-tokens:encryptedTokens': { envVar: 'REBEL_OPENROUTER_API_KEY', shape: 'json_api_key' },
  'codex-oauth-tokens:encryptedTokens': { envVar: 'REBEL_CODEX_TOKENS_JSON', shape: 'string' },
};

function getMapping(namespace: string, key: string): EnvTokenMapping | null {
  const mappingKey = `${namespace}:${key}` as NamespaceKey;
  const mapping = ENV_TOKEN_MAPPINGS[mappingKey];
  if (!mapping) {
    log.warn(
      { namespace, key },
      'Standalone CLI token store has no env mapping for namespace/key',
    );
    return null;
  }
  return mapping;
}

function transformEnvValue(raw: string, shape: EnvValueShape): string {
  switch (shape) {
    case 'string':
      return raw;
    case 'json_api_key':
      return JSON.stringify({ apiKey: raw });
  }
}

export class StandaloneSecureTokenStore implements SecureTokenStore {
  isEncryptionAvailable(): boolean {
    return false;
  }

  read(options: SecureTokenReadOptions): string | null {
    const mapping = getMapping(options.namespace, options.key);
    if (!mapping) return null;

    const raw = process.env[mapping.envVar];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const transformed = transformEnvValue(raw, mapping.shape);
    return options.validate(transformed) ? transformed : null;
  }

  write(options: SecureTokenWriteOptions): void {
    const mapping = getMapping(options.namespace, options.key);
    log.warn(
      { namespace: options.namespace, key: options.key, envVar: mapping?.envVar ?? null },
      'Standalone CLI token store is env-var-only; write rejected',
    );
    throw new Error('Standalone CLI secure token store is read-only (env-var-only)');
  }

  delete(options: SecureTokenDeleteOptions): void {
    log.warn(
      { key: options.key },
      'Standalone CLI token store is env-var-only; delete rejected',
    );
    throw new Error('Standalone CLI secure token store is read-only (env-var-only)');
  }

  has(options: SecureTokenHasOptions): boolean {
    const mapping = getMapping(options.namespace, options.key);
    if (!mapping) return false;
    const raw = process.env[mapping.envVar];
    return typeof raw === 'string' && raw.length > 0;
  }
}
