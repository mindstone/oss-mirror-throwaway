export type LibraryFilter = 'spaces' | 'plugins' | 'skills' | 'memory' | 'everything';
export type LibraryView = 'folders' | 'cards' | 'atlas';
export type LibrarySortOption =
  | 'name'
  | 'modified'
  | 'created'
  | 'recent'
  | 'skill-suggested'
  | 'skill-most-used'
  | 'skill-most-polished'
  | 'memory-relevance'
  | 'space-last-active'
  // Plugins lens default sort: Hero plugins first, then last-updated.
  // See docs/plans/260521_plugin_publishing_org_distribution.md (Stage A1).
  | 'plugin-hero-first';

export interface LibraryLens {
  filter: LibraryFilter;
  view: LibraryView;
  /** Optional per-filter facet. Undefined means "All". */
  facet?: string;
}

export const DEFAULT_LENS: LibraryLens = { filter: 'spaces', view: 'folders' };

interface FilterSpec {
  id: LibraryFilter;
  label: string;
  iconName: 'FolderOpen' | 'Puzzle' | 'ScrollText' | 'Brain' | 'Files';
}

interface ViewSpec {
  id: LibraryView;
  label: string;
  iconName: 'FolderTree' | 'LayoutGrid' | 'Map';
}

export const FILTER_SPECS = {
  spaces: { id: 'spaces', label: 'Spaces', iconName: 'FolderOpen' },
  plugins: { id: 'plugins', label: 'Plugins', iconName: 'Puzzle' },
  skills: { id: 'skills', label: 'Skills', iconName: 'ScrollText' },
  memory: { id: 'memory', label: 'Memory', iconName: 'Brain' },
  everything: { id: 'everything', label: 'Everything', iconName: 'Files' },
} as const satisfies Record<LibraryFilter, FilterSpec>;

export const VIEW_SPECS = {
  folders: { id: 'folders', label: 'Folders', iconName: 'FolderTree' },
  cards: { id: 'cards', label: 'Cards', iconName: 'LayoutGrid' },
  atlas: { id: 'atlas', label: 'Atlas', iconName: 'Map' },
} as const satisfies Record<LibraryView, ViewSpec>;

const FILTER_KEYS: ReadonlySet<string> = new Set(Object.keys(FILTER_SPECS));
const VIEW_KEYS: ReadonlySet<string> = new Set(Object.keys(VIEW_SPECS));

export function isLibraryFilter(value: unknown): value is LibraryFilter {
  return typeof value === 'string' && FILTER_KEYS.has(value);
}

export function isLibraryView(value: unknown): value is LibraryView {
  return typeof value === 'string' && VIEW_KEYS.has(value);
}
