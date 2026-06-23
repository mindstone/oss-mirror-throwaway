import { describe, expect, it } from 'vitest';
import { parseLibraryLensPreference } from '../parseLibraryLensPreference';

describe('parseLibraryLensPreference', () => {
  it('reports empty for null, undefined, or empty string', () => {
    expect(parseLibraryLensPreference(null)).toEqual({ ok: false, reason: 'empty' });
    expect(parseLibraryLensPreference(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(parseLibraryLensPreference('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports invalid-json for corrupt JSON', () => {
    expect(parseLibraryLensPreference('{')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(parseLibraryLensPreference('not-json')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('reports shape-mismatch when required fields are missing', () => {
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'spaces' }))).toEqual({
      ok: false,
      reason: 'shape-mismatch',
    });
    expect(parseLibraryLensPreference(JSON.stringify({ view: 'folders' }))).toEqual({
      ok: false,
      reason: 'shape-mismatch',
    });
    expect(parseLibraryLensPreference(JSON.stringify('not-object'))).toEqual({
      ok: false,
      reason: 'shape-mismatch',
    });
  });

  it('rejects prototype-derived enum values (e.g. "toString")', () => {
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'toString', view: 'folders' }))).toEqual(
      { ok: false, reason: 'invalid-filter' },
    );
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'spaces', view: 'hasOwnProperty' }))).toEqual(
      { ok: false, reason: 'invalid-view' },
    );
  });

  it('reports invalid-filter / invalid-view for unknown enum values', () => {
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'bogus', view: 'folders' }))).toEqual(
      { ok: false, reason: 'invalid-filter' },
    );
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'spaces', view: 'bogus' }))).toEqual(
      { ok: false, reason: 'invalid-view' },
    );
  });

  it('returns parsed lens for valid stored payload', () => {
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'memory', view: 'cards' }))).toEqual({
      ok: true,
      lens: { filter: 'memory', view: 'cards' },
    });
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'everything', view: 'atlas' }))).toEqual({
      ok: true,
      lens: { filter: 'everything', view: 'atlas' },
    });
    expect(
      parseLibraryLensPreference(
        JSON.stringify({ filter: 'skills', view: 'cards', facet: 'communication' }),
      ),
    ).toEqual({
      ok: true,
      lens: { filter: 'skills', view: 'cards', facet: 'communication' },
    });
  });

  it('normalizes empty facet strings to undefined', () => {
    expect(
      parseLibraryLensPreference(
        JSON.stringify({ filter: 'skills', view: 'cards', facet: '   ' }),
      ),
    ).toEqual({
      ok: true,
      lens: { filter: 'skills', view: 'cards' },
    });
    expect(
      parseLibraryLensPreference(
        JSON.stringify({ filter: 'skills', view: 'cards', facet: null }),
      ),
    ).toEqual({
      ok: true,
      lens: { filter: 'skills', view: 'cards' },
    });
  });

  it('migrates persisted list view to cards', () => {
    expect(parseLibraryLensPreference(JSON.stringify({ filter: 'skills', view: 'list' }))).toEqual({
      ok: true,
      lens: { filter: 'skills', view: 'cards' },
      migratedFromView: 'list',
    });
  });
});
