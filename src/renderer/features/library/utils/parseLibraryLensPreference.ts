import { z } from 'zod';
import { type LibraryLens, isLibraryFilter, isLibraryView } from '../types/lens';

const STORED_SCHEMA = z.object({
  filter: z.string(),
  view: z.string(),
  facet: z.string().optional().nullable(),
});

export type ParseLibraryLensReason =
  | 'empty'
  | 'invalid-json'
  | 'shape-mismatch'
  | 'invalid-filter'
  | 'invalid-view';

export type ParseLibraryLensResult =
  | { ok: true; lens: LibraryLens; migratedFromView?: 'list' }
  | { ok: false; reason: ParseLibraryLensReason };

export function parseLibraryLensPreference(
  raw: string | null | undefined,
): ParseLibraryLensResult {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  const checked = STORED_SCHEMA.safeParse(parsed);
  if (!checked.success) {
    return { ok: false, reason: 'shape-mismatch' };
  }

  if (!isLibraryFilter(checked.data.filter)) {
    return { ok: false, reason: 'invalid-filter' };
  }

  const migratedFromListView = checked.data.view === 'list';
  const normalizedView = migratedFromListView ? 'cards' : checked.data.view;
  const normalizedFacet = checked.data.facet?.trim() || undefined;

  if (!isLibraryView(normalizedView)) {
    return { ok: false, reason: 'invalid-view' };
  }

  return {
    ok: true,
    lens: {
      filter: checked.data.filter,
      view: normalizedView,
      ...(normalizedFacet ? { facet: normalizedFacet } : {}),
    },
    ...(migratedFromListView ? { migratedFromView: 'list' } : {}),
  };
}
