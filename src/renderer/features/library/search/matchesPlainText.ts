export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesPlainText(haystack: string | undefined | null, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(normalizedQuery);
}
