export interface OpenRouterTokens {
  apiKey: string;
  userId?: string;
  email?: string;
}

export function saveOpenRouterTokens(_tokens: OpenRouterTokens): void {
  throw new Error('OpenRouter OAuth token storage is not available in the standalone CLI bundle.');
}

export function loadOpenRouterTokens(): OpenRouterTokens | null {
  return null;
}

export function clearOpenRouterTokens(): void {
  // no-op in standalone CLI
}

export function hasOpenRouterTokens(): boolean {
  return false;
}

export function saveManagedOpenRouterKey(_apiKey: string): void {
  throw new Error('Managed OpenRouter key storage is not available in the standalone CLI bundle.');
}

export function loadManagedOpenRouterKey(): string | null {
  return null;
}

export function clearManagedOpenRouterKey(): void {
  // no-op in standalone CLI
}

export function hasManagedOpenRouterKey(): boolean {
  return false;
}
