import { EventEmitter } from 'node:events';

export interface CodexTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  accountEmail?: string;
}

export interface OpenRouterTokens {
  apiKey: string;
}

export interface ProviderOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export const codexTokenEvents = new EventEmitter();
export const CodexTokensSchema = { parse: (value: unknown) => value };

export const loadCodexTokens = (): CodexTokens | null => null;
export const saveCodexTokens = (): void => {};
export const clearCodexTokens = (): void => {};
export const hasCodexTokens = (): boolean => false;

export const loadOpenRouterTokens = (): OpenRouterTokens | null => {
  const apiKey = process.env.REBEL_OPENROUTER_API_KEY;
  return apiKey ? { apiKey } : null;
};
export const saveOpenRouterTokens = (): void => {};
export const clearOpenRouterTokens = (): void => {};
export const hasOpenRouterTokens = (): boolean => Boolean(process.env.REBEL_OPENROUTER_API_KEY);

export const loadSessionToken = (): string | null => null;
export const saveSessionToken = (): void => {};
export const clearSessionToken = (): void => {};
export const hasSessionToken = (): boolean => false;
export const loadCachedUser = (): null => null;
export const saveCachedUser = (): void => {};
export const clearCachedUser = (): void => {};
export const clearAllAuthData = (): void => {};
export const isEncryptionAvailable = (): boolean => false;

export const loadProviderToken = (): string | null => null;
export const saveProviderToken = (): void => {};
export const clearProviderToken = (): void => {};
export const hasProviderToken = (): boolean => false;
export const loadProviderOAuthTokens = (): ProviderOAuthTokens | null => null;
export const saveProviderOAuthTokens = (): void => {};
export const clearProviderOAuthTokens = (): void => {};
export const hasProviderOAuthTokens = (): boolean => false;

export const loadFlyApiToken = (): string | null => null;
export const saveFlyApiToken = (): void => {};
export const clearFlyApiToken = (): void => {};
export const hasFlyApiToken = (): boolean => false;
