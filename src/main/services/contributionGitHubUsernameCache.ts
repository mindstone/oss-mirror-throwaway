/**
 * Singleton in-memory cache for the authenticated GitHub username used by
 * contribution flows. Extracted to its own module so that
 * `contributionGitHubAuthService` can clear the cache on token revocation
 * without creating an import cycle with `contributionGitHubService`.
 */

let cachedUsername: string | null = null;

export function getCachedContributionGitHubUsername(): string | null {
  return cachedUsername;
}

export function setCachedContributionGitHubUsername(username: string): void {
  cachedUsername = username;
}

export function clearCachedUsername(): void {
  cachedUsername = null;
}

/** Reset internal state for testing. */
export function _resetUsernameCacheForTesting(): void {
  cachedUsername = null;
}
