export function getCompanyNameFromPath(spacePath: string): string | undefined {
  const match = spacePath.match(/^work\/([^/]+)/);
  return match?.[1];
}

export function canonicalOrganisationKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  return trimmed
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export const suggestOrganisationFromPath = getCompanyNameFromPath;

export interface OrganisationGroup<T> {
  key: string;
  displayName: string;
  items: T[];
}

export interface OrganisationGrouping<T> {
  groups: OrganisationGroup<T>[];
  unorganisedItems: T[];
  shouldShowHeadings: boolean;
}

interface GroupItemsByOrganisationOptions<T> {
  sortItems?: (a: T, b: T) => number;
}

export function groupItemsByOrganisation<T>(
  items: T[],
  getOrganisationName: (item: T) => string | null | undefined,
  options: GroupItemsByOrganisationOptions<T> = {}
): OrganisationGrouping<T> {
  const groupsByKey = new Map<string, OrganisationGroup<T>>();
  const unorganisedItems: T[] = [];

  for (const item of items) {
    const rawOrganisationName = getOrganisationName(item)?.trim() ?? '';
    const key = canonicalOrganisationKey(rawOrganisationName);

    if (!key) {
      unorganisedItems.push(item);
      continue;
    }

    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        displayName: rawOrganisationName,
        items: [],
      };
      groupsByKey.set(key, group);
    }
    group.items.push(item);
  }

  const groups = Array.from(groupsByKey.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );

  if (options.sortItems) {
    for (const group of groups) {
      group.items.sort(options.sortItems);
    }
    unorganisedItems.sort(options.sortItems);
  }

  const visibleGroupCount = groups.length + (unorganisedItems.length > 0 ? 1 : 0);
  const hasSharedOrganisation = groups.some(group => group.items.length >= 2);

  return {
    groups,
    unorganisedItems,
    shouldShowHeadings: hasSharedOrganisation || visibleGroupCount > 1,
  };
}
