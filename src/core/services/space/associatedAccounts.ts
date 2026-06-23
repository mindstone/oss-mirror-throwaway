/**
 * Resolve user-local associated accounts with shared README email/domain hints.
 *
 * `localAssociatedAccounts === undefined` preserves legacy behavior: use README
 * `emails` as-is. A defined local array, including [], is an explicit per-user
 * decision, so README exact emails are ignored while bare domain hints remain.
 */

export const normalizeAssociatedAccountEntry = (entry: string): string => {
  let normalized = entry.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.startsWith('*@')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('@') && normalized.indexOf('@', 1) === -1) {
    normalized = normalized.slice(1);
  }
  return normalized;
};

export const dedupeAssociatedAccountEntries = (entries: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeAssociatedAccountEntry(entry);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
};

export const isBareDomainAssociatedAccount = (entry: string): boolean => {
  const normalized = normalizeAssociatedAccountEntry(entry);
  return normalized.length > 0 && !normalized.includes('@');
};

export const resolveEffectiveAssociatedAccounts = (
  localAssociatedAccounts: string[] | undefined,
  readmeEmails: string[] | undefined,
): string[] | undefined => {
  const normalizedReadmeEmails = dedupeAssociatedAccountEntries(readmeEmails ?? []);
  if (localAssociatedAccounts === undefined) {
    return normalizedReadmeEmails.length > 0 ? normalizedReadmeEmails : undefined;
  }

  return dedupeAssociatedAccountEntries([
    ...localAssociatedAccounts,
    ...normalizedReadmeEmails.filter(isBareDomainAssociatedAccount),
  ]);
};
