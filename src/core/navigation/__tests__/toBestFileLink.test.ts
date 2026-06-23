/**
 * Tests for `toBestFileLink` — the rebel-URL chooser used by MessageMarkdown's
 * regex preprocessors and the `remarkLibraryLinks` plugin.
 *
 * Covers the 7-step algorithm:
 *   1. URL-decode → 2. Empty guard → 3. matchPathToSpace → 4. fail-closed
 *   5. derive absolute/match-root/both relative paths → 6. shareability gate
 *   7. emit space:// or library:// URL with escape-guards.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1.
 */

import { describe, expect, it } from 'vitest';
import type { SpaceInfo, SpaceType } from '@shared/ipc/schemas/library';
import { toBestFileLink, type BestFileLinkContext } from '../toBestFileLink';

const CORE = '/Users/me/core';

function space(overrides: Partial<SpaceInfo> & { name: string; absolutePath: string; type: SpaceType }): SpaceInfo {
  return {
    name: overrides.name,
    path: overrides.path ?? overrides.name,
    absolutePath: overrides.absolutePath,
    type: overrides.type,
    isSymlink: overrides.isSymlink ?? false,
    hasReadme: overrides.hasReadme ?? true,
    sourcePath: overrides.sourcePath,
    description: overrides.description,
    displayName: overrides.displayName,
    sharing: overrides.sharing,
    memoryTrust: overrides.memoryTrust,
    status: overrides.status ?? 'ok',
    statusMessage: overrides.statusMessage,
    goalsLastReviewed: overrides.goalsLastReviewed,
    valuesLastReviewed: overrides.valuesLastReviewed,
    emails: overrides.emails,
    writable: overrides.writable,
  } as SpaceInfo;
}

function ctx(spaces: SpaceInfo[], spacesReady = true): BestFileLinkContext {
  return { coreDirectory: CORE, spaces, spacesReady };
}

describe('toBestFileLink — empty / readiness fail-closed', () => {
  it('returns empty string for empty input', () => {
    expect(toBestFileLink('', ctx([]))).toBe('');
    expect(toBestFileLink('   ', ctx([]))).toBe('');
  });

  it('emits library URL when spacesReady=false (even for matchable path)', () => {
    const spaces = [space({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' })];
    const url = toBestFileLink('Exec/Q1.md', { ...ctx(spaces), spacesReady: false });
    expect(url).toBe('rebel://library/Exec%2FQ1.md');
  });

  it('emits library URL when no spaces match', () => {
    const url = toBestFileLink('docs/file.md', ctx([]));
    expect(url).toBe('rebel://library/docs%2Ffile.md');
  });
});

describe('toBestFileLink — shareable spaces emit rebel://space/', () => {
  // Each type uses a folder name that matches the canonical-name default
  // for its type. `personal` → 'Personal' and `chief-of-staff` → 'Private Space'
  // are type-based overrides inside `getCanonicalSpaceName` (parity with
  // main-side `getSpaceDisplayName`). `chief-of-staff` is excluded here
  // because it's gated out by `isShareableSpace` — covered separately below.
  it.each<['team' | 'company' | 'project' | 'operator' | 'other']>([
    ['team'],
    ['company'],
    ['project'],
    ['operator'],
    ['other'],
  ])('emits rebel://space/ for type=%s (canonical name = folder name)', (type) => {
    const spaces = [space({ name: 'Shared', absolutePath: `${CORE}/Shared`, type })];
    const url = toBestFileLink('Shared/notes/Q1.md', ctx(spaces));
    expect(url).toBe('rebel://space/Shared/notes%2FQ1.md');
  });

  it('emits rebel://space/Personal/... for a personal space without displayName (canonical-name fallback)', () => {
    // Parity with main-side `getSpaceDisplayName`: personal spaces with
    // no explicit displayName default to 'Personal'. Renderer + main must
    // emit the same string (see plan Stage 1 Must-fix #4).
    const spaces = [space({ name: 'me-2024', absolutePath: `${CORE}/me-2024`, type: 'personal' })];
    const url = toBestFileLink('me-2024/notes/Q1.md', ctx(spaces));
    expect(url).toBe('rebel://space/Personal/notes%2FQ1.md');
  });

  it('emits rebel://space/{displayName}/... when frontmatter displayName is set', () => {
    const spaces = [space({
      name: 'folder-exec',
      absolutePath: `${CORE}/folder-exec`,
      type: 'team',
      displayName: 'Mindstone Exec',
    })];
    const url = toBestFileLink('folder-exec/notes/brief.md', ctx(spaces));
    expect(url).toBe('rebel://space/Mindstone%20Exec/notes%2Fbrief.md');
  });

  it('emits rebel://space/ for absolute paths inside a shareable space', () => {
    const spaces = [space({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' })];
    const url = toBestFileLink(`${CORE}/Exec/memory/Q1.md`, ctx(spaces));
    expect(url).toBe('rebel://space/Exec/memory%2FQ1.md');
  });

  it('emits folder form when kind=folder', () => {
    const spaces = [space({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' })];
    const url = toBestFileLink('Exec/memory', ctx(spaces), 'folder');
    expect(url).toBe('rebel://space/Exec/memory?type=folder');
  });
});

describe('toBestFileLink — private / unshareable spaces emit rebel://library/', () => {
  it('emits rebel://library/ for chief-of-staff space', () => {
    const spaces = [space({ name: 'Personal', absolutePath: `${CORE}/Personal`, type: 'chief-of-staff' })];
    const url = toBestFileLink('Personal/secret.md', ctx(spaces));
    expect(url).toBe('rebel://library/Personal%2Fsecret.md');
  });

  it('emits rebel://library/ when top-level sharing="private"', () => {
    const spaces = [space({
      name: 'PrivateExec',
      absolutePath: `${CORE}/PrivateExec`,
      type: 'team',
      sharing: 'private',
    })];
    const url = toBestFileLink('PrivateExec/notes.md', ctx(spaces));
    expect(url).toBe('rebel://library/PrivateExec%2Fnotes.md');
  });

  it('emits rebel://library/ when frontmatter.sharing="private" (nested, main-side SpaceInfo shape)', () => {
    // Mirrors the `frontmatter.sharing === 'private'` gate path — forced by
    // shaping the SpaceInfo like the main-side richer type. Parity fix per
    // plan Stage 1 (260418) ensures BOTH shapes are gated identically.
    const spaces = [{
      name: 'PrivateFM',
      path: 'PrivateFM',
      absolutePath: `${CORE}/PrivateFM`,
      type: 'team',
      isSymlink: false,
      hasReadme: true,
      status: 'ok',
      frontmatter: { sharing: 'private' },
    } as unknown as SpaceInfo];
    const url = toBestFileLink('PrivateFM/notes.md', ctx(spaces));
    expect(url).toBe('rebel://library/PrivateFM%2Fnotes.md');
  });

  it('emits workspace-relative rebel://library/ for an absolute path inside a private space', () => {
    // Ensures the private-space branch uses `libraryFallbackPath`
    // (workspace-relative) not the raw absolute path.
    const spaces = [space({
      name: 'Personal',
      absolutePath: `${CORE}/Personal`,
      type: 'chief-of-staff',
    })];
    const url = toBestFileLink(`${CORE}/Personal/diary.md`, ctx(spaces));
    expect(url).toBe('rebel://library/Personal%2Fdiary.md');
  });

  it('emits rebel://library/ for unknown space.type (runtime default fail-closed)', () => {
    // Force a SpaceType value that isn't in the exhaustive allowlist to
    // verify the runtime `default` branch in `isShareableSpace` fails
    // closed — protecting us if the schema adds a new type before the
    // renderer is updated.
    const spaces = [{
      name: 'Frontier',
      path: 'Frontier',
      absolutePath: `${CORE}/Frontier`,
      type: 'not-a-real-type',
      isSymlink: false,
      hasReadme: true,
      status: 'ok',
    } as unknown as SpaceInfo];
    const url = toBestFileLink('Frontier/notes.md', ctx(spaces));
    expect(url).toBe('rebel://library/Frontier%2Fnotes.md');
  });
});

describe('toBestFileLink — symlinked spaces (sourcePath rebasing)', () => {
  const spaces: SpaceInfo[] = [
    space({
      name: 'Drive',
      absolutePath: `${CORE}/Drive`,
      sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/personal',
      isSymlink: true,
      type: 'team',
    }),
  ];

  it('rebases space-relative paths from sourcePath when input is under it', () => {
    const url = toBestFileLink(
      '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/personal/Q1.md',
      ctx(spaces),
    );
    expect(url).toBe('rebel://space/Drive/Q1.md');
  });

  it('rebases space-relative paths from absolutePath when input is under it', () => {
    const url = toBestFileLink(`${CORE}/Drive/Q1.md`, ctx(spaces));
    expect(url).toBe('rebel://space/Drive/Q1.md');
  });

  it('falls back to library form for a symlink-source-path escape', () => {
    // A `..` segment that climbs OUT of the symlinked sourcePath should fall
    // back to library form with the original escape form preserved — no
    // silent normalization into a clean-looking URL.
    const input = '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/personal/../leak.md';
    const url = toBestFileLink(input, ctx(spaces));
    expect(url.startsWith('rebel://library/')).toBe(true);
    // Preserve the `..` form in the emitted URL (per Must-fix #2 escape guard).
    expect(url).toContain('..');
  });
});

describe('toBestFileLink — escape guards', () => {
  it('preserves the ORIGINAL escape form when path escapes the matched space', () => {
    const spaces = [space({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' })];
    // Plan Must-fix #2 (260418): previously this returned
    // `rebel://library/other.md` — silently normalizing `Exec/../other.md`
    // into a clean `other.md`, hiding the escape intent from downstream
    // readers. The fix is to emit the original input via
    // `formatLibraryUrl(toPortablePath(input))` so the `..` form is
    // preserved and a future reader can reject it.
    const input = `${CORE}/Exec/../other.md`;
    const url = toBestFileLink(input, ctx(spaces));
    expect(url).toBe(
      'rebel://library/%2FUsers%2Fme%2Fcore%2FExec%2F..%2Fother.md',
    );
    // Sanity: original escape form is preserved (as URL-encoded `..`), not
    // silently normalized into `other.md`.
    expect(url).toContain('..');
    expect(url).not.toBe('rebel://library/other.md');
  });

  it('decodes URL-encoded filenames before matching, then re-encodes once', () => {
    const spaces = [space({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' })];
    const url = toBestFileLink('Exec/My%20Doc.md', ctx(spaces));
    // decodeURIComponent("Exec/My%20Doc.md") = "Exec/My Doc.md"
    // matches space "Exec", relative = "My Doc.md"
    // formatNavigationUrl encodes via encodeURIComponent("My Doc.md") = "My%20Doc.md"
    // No double-percent.
    expect(url).toBe('rebel://space/Exec/My%20Doc.md');
  });
});

describe('toBestFileLink — outside any space', () => {
  it('emits workspace-relative library URL when path is under coreDirectory but no space matches', () => {
    const url = toBestFileLink('docs/readme.md', ctx([]));
    expect(url).toBe('rebel://library/docs%2Freadme.md');
  });

  it('emits original path library URL when absolute path is outside coreDirectory', () => {
    const url = toBestFileLink('/tmp/external.md', ctx([]));
    expect(url).toBe('rebel://library/%2Ftmp%2Fexternal.md');
  });
});
