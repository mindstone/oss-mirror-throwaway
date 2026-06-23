/**
 * Parity tests — `toBestFileLink` (renderer-side, sync) must agree with
 * `filePathToSpaceLink` (main-side, async) byte-for-byte on the identifiers
 * they emit into URLs: same space name AND same relative path. Drift
 * between the two would break idempotent sharing (same file → two URLs).
 *
 * Both helpers route through the shared `isShareableSpace`, `resolveMatchRoot`,
 * and `getCanonicalSpaceName` helpers in `@core/services/spacePathMatcher`
 * as of plan 260418 Stage 1 Must-fix #4. This test pins that parity: 5
 * representative inputs run through BOTH functions and we assert the emitted
 * URL components match exactly.
 *
 * Lives in `src/main/services/__tests__/` rather than `src/core/navigation/`
 * because it imports the main-side `filePathToSpaceLink`. The `@main/*`
 * alias is only available under `tsconfig.node.json`, which covers
 * `src/main/**` and `src/core/**`. `src/core/navigation/**` is also
 * included by the renderer tsconfig which does NOT have `@main/*`.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo as SharedSpaceInfo, SpaceType } from '@shared/ipc/schemas/library';
import { toBestFileLink } from '@core/navigation/toBestFileLink';
import {
  isShareableSpace,
  getCanonicalSpaceName,
} from '@core/services/spacePathMatcher';

// Stub electron-store so importing `@main/services/spaceService` doesn't
// try to spin up Electron's persistent store in the test environment.
 
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => { this.store[key] = value; });
    delete = vi.fn((key: string) => { delete this.store[key]; });
    has = vi.fn((key: string) => key in this.store);
  },
}));

const CORE = '/Users/me/core';

function mkSpace(overrides: Partial<SharedSpaceInfo> & { name: string; absolutePath: string; type: SpaceType }): SharedSpaceInfo {
  return {
    name: overrides.name,
    path: overrides.path ?? overrides.name,
    absolutePath: overrides.absolutePath,
    type: overrides.type,
    isSymlink: overrides.isSymlink ?? false,
    hasReadme: overrides.hasReadme ?? true,
    sourcePath: overrides.sourcePath,
    displayName: overrides.displayName,
    sharing: overrides.sharing,
    status: overrides.status ?? 'ok',
  } as SharedSpaceInfo;
}

describe('toBestFileLink / filePathToSpaceLink shareability classification parity', () => {
  const cases: Array<{ label: string; space: SharedSpaceInfo; expectSpaceUrl: boolean }> = [
    {
      label: 'team space — shareable',
      space: mkSpace({ name: 'Team', absolutePath: `${CORE}/Team`, type: 'team' }),
      expectSpaceUrl: true,
    },
    {
      label: 'chief-of-staff — never shareable',
      space: mkSpace({ name: 'COS', absolutePath: `${CORE}/COS`, type: 'chief-of-staff' }),
      expectSpaceUrl: false,
    },
    {
      label: 'company space with sharing=private — not shareable',
      space: mkSpace({ name: 'Co', absolutePath: `${CORE}/Co`, type: 'company', sharing: 'private' }),
      expectSpaceUrl: false,
    },
    {
      label: 'personal space — shareable',
      space: mkSpace({ name: 'Me', absolutePath: `${CORE}/Me`, type: 'personal' }),
      expectSpaceUrl: true,
    },
    {
      label: 'operator space — shareable',
      space: mkSpace({ name: 'Ops', absolutePath: `${CORE}/Ops`, type: 'operator' }),
      expectSpaceUrl: true,
    },
  ];

  it.each(cases)('$label agrees across both surfaces', ({ space, expectSpaceUrl }) => {
    // 1. Shared helper directly classifies.
    expect(isShareableSpace(space)).toBe(expectSpaceUrl);

    // 2. Renderer-side `toBestFileLink` emits space:// ⇔ shareable.
    const url = toBestFileLink(
      `${space.absolutePath}/notes/demo.md`,
      { coreDirectory: CORE, spaces: [space], spacesReady: true },
    );
    if (expectSpaceUrl) {
      expect(url.startsWith('rebel://space/')).toBe(true);
    } else {
      expect(url.startsWith('rebel://library/')).toBe(true);
    }
  });
});

describe('toBestFileLink ⇌ filePathToSpaceLink — byte-for-byte URL component parity', () => {
  // Wide set of fixtures covering the ways renderer + main can drift: folder
  // name vs display name, symlink source-path rebasing, personal-type naming,
  // frontmatter display_name, and plain vanilla teams.
  interface ParityFixture {
    label: string;
    space: SharedSpaceInfo;
    /** Absolute file path on disk — same shape the main-side receives. */
    absolutePath: string;
    /** Expected canonical space name — used by BOTH surfaces. */
    expectSpaceName: string;
    /** Expected relative path — used by BOTH surfaces. */
    expectRelativePath: string;
  }

  const fixtures: ParityFixture[] = [
    {
      label: 'plain team space, nested file',
      space: mkSpace({ name: 'Exec', absolutePath: `${CORE}/Exec`, type: 'team' }),
      absolutePath: `${CORE}/Exec/memory/Q1.md`,
      expectSpaceName: 'Exec',
      expectRelativePath: 'memory/Q1.md',
    },
    {
      label: 'display name differs from folder name',
      space: mkSpace({
        name: 'folder-exec',
        absolutePath: `${CORE}/folder-exec`,
        type: 'team',
        displayName: 'Mindstone Exec',
      }),
      absolutePath: `${CORE}/folder-exec/notes/brief.md`,
      expectSpaceName: 'Mindstone Exec',
      expectRelativePath: 'notes/brief.md',
    },
    {
      label: 'personal space defaults to "Personal" canonical name',
      space: mkSpace({ name: 'me-2024', absolutePath: `${CORE}/me-2024`, type: 'personal' }),
      absolutePath: `${CORE}/me-2024/journal.md`,
      expectSpaceName: 'Personal',
      expectRelativePath: 'journal.md',
    },
    {
      label: 'symlinked team space rebases from sourcePath',
      space: mkSpace({
        name: 'Drive',
        absolutePath: `${CORE}/Drive`,
        type: 'team',
        isSymlink: true,
        sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team',
      }),
      absolutePath: '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team/Q1.md',
      expectSpaceName: 'Drive',
      expectRelativePath: 'Q1.md',
    },
    {
      label: 'project space with display name and nested folder path',
      space: mkSpace({
        name: 'proj-alpha',
        absolutePath: `${CORE}/proj-alpha`,
        type: 'project',
        displayName: 'Alpha Project',
      }),
      absolutePath: `${CORE}/proj-alpha/docs/2026/spec.md`,
      expectSpaceName: 'Alpha Project',
      expectRelativePath: 'docs/2026/spec.md',
    },
  ];

  // Dynamic import inside beforeAll so the `vi.mock('electron-store')` hoist
  // applies before the module graph loads.
  type FilePathToSpaceLink = typeof import('@main/services/spaceService').filePathToSpaceLink;
  type MainSpaceInfo = import('@main/services/spaceService').SpaceInfo;
  let filePathToSpaceLink: FilePathToSpaceLink;

  beforeAll(async () => {
    const mod = await import('@main/services/spaceService');
    filePathToSpaceLink = mod.filePathToSpaceLink;
  });

  it.each(fixtures)(
    '$label — both surfaces emit identical spaceName + relativePath',
    async ({ space, absolutePath, expectSpaceName, expectRelativePath }) => {
      // Shared helpers classify identically.
      expect(getCanonicalSpaceName(space)).toBe(expectSpaceName);
      expect(isShareableSpace(space)).toBe(true);

      // Renderer-side: `toBestFileLink` -> `rebel://space/{spaceName}/{filePath}`
      // Decode back to compare component-by-component.
      const rendererUrl = toBestFileLink(
        absolutePath,
        { coreDirectory: CORE, spaces: [space], spacesReady: true },
      );
      expect(rendererUrl.startsWith('rebel://space/')).toBe(true);
      const rendererTail = rendererUrl.slice('rebel://space/'.length);
      const segments = rendererTail.split('/');
      const rendererSpaceName = decodeURIComponent(segments[0]);
      const rendererRelativePath = segments.slice(1).map(decodeURIComponent).join('/');
      expect(rendererSpaceName).toBe(expectSpaceName);
      expect(rendererRelativePath).toBe(expectRelativePath);

      // Main-side: `filePathToSpaceLink` returns `{ spaceName, relativePath }`.
      // Pass `preloadedSpaces` to bypass the real `scanSpaces` IPC.
      const mainResult = await filePathToSpaceLink(absolutePath, CORE, [
        space as unknown as MainSpaceInfo,
      ]);
      expect(mainResult).not.toBeNull();
      const mainRelativePath = mainResult!.relativePath.replace(/\\/g, '/');
      expect(mainResult!.spaceName).toBe(expectSpaceName);
      expect(mainRelativePath).toBe(expectRelativePath);

      // Parity: BOTH surfaces must agree on the strings that go into the URL.
      expect(rendererSpaceName).toBe(mainResult!.spaceName);
      expect(rendererRelativePath).toBe(mainRelativePath);
    },
  );
});
