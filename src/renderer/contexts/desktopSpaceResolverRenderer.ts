/**
 * Renderer-side SpaceResolver adapter.
 *
 * Wraps the `library:resolve-space-link` and `library:file-to-space-link` IPC
 * channels (exposed via `window.libraryApi`) in the `SpaceResolver` boundary
 * that `@core/navigation` expects. Lives in renderer-land because it depends
 * on `window.libraryApi`; the main-process companion is
 * `src/main/services/navigation/desktopSpaceResolver.ts`.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C / D.
 */

import type { SpaceResolver } from '@core/navigation';

export const rendererDesktopSpaceResolver: SpaceResolver = {
  async resolveSpaceLink(target) {
    const result = await window.libraryApi.resolveSpaceLink({
      spaceName: target.spaceName,
      filePath: target.filePath,
      folderPath: target.folderPath,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, workspaceRelativePath: result.workspaceRelativePath };
  },

  async filePathToSpaceLink(filePath) {
    return window.libraryApi.fileToSpaceLink({ filePath });
  },
};
