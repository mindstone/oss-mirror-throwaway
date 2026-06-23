/**
 * Core Navigation Boundaries
 *
 * Platform-specific adapters the core resolver depends on. Each surface
 * (desktop, mobile, cloud-service, web-companion) provides its own
 * implementation:
 *
 * - Desktop renderer: wraps `window.libraryApi.resolveSpaceLink` +
 *   `window.libraryApi.fileToSpaceLink` (IPC → main-process spaceService).
 * - Desktop main: wraps `resolveSpaceLink` + `filePathToSpaceLink` from
 *   `src/main/services/spaceService.ts` directly (no IPC hop).
 * - Cloud service: same as desktop-main but against the cloud-side
 *   core directory.
 * - Mobile: cloud-client call to a `/api/spaces/resolve` endpoint, or
 *   `NullSpaceResolver` (degraded) until that endpoint ships.
 *
 * Keeping this as a small boundary interface means `@core/navigation` can be
 * unit-tested with in-memory stubs and never has to know about Electron, IPC,
 * fetch, or the filesystem.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

/**
 * Result of a forward space-link resolution: space-name + sub-path →
 * workspace-relative path.
 */
export type SpaceResolveResult =
  | { ok: true; workspaceRelativePath: string }
  | { ok: false; error: 'space-not-found' | 'file-not-found' | 'path-invalid' };

/**
 * Platform-specific adapter for space-link resolution.
 *
 * Implementations own their own caching, permission checks, and
 * path-traversal validation. The core layer trusts the return value.
 */
export interface SpaceResolver {
  /**
   * Forward resolution: space name + optional sub-path → workspace-relative
   * path on the caller's filesystem.
   */
  resolveSpaceLink(target: {
    spaceName: string;
    filePath?: string;
    folderPath?: string;
  }): Promise<SpaceResolveResult>;

  /**
   * Reverse resolution: absolute path on disk → best-match space link.
   * Returns null if the path is not inside a shareable (non-private,
   * non-CoS) space. Used by `generateShareLink` to produce
   * `rebel://space/{space}/{path}` URLs from right-click-on-file context.
   */
  filePathToSpaceLink(filePath: string): Promise<{
    spaceName: string;
    relativePath: string;
  } | null>;
}

/**
 * No-op resolver for surfaces that can't (or haven't yet wired) space
 * resolution. Every forward call returns `space-not-found` so the dispatcher
 * surfaces the canonical error; reverse calls return null (no shareable form).
 *
 * Use only as a bootstrap. Callers should log a warning when constructing a
 * surface with `NullSpaceResolver` in production builds — it means space
 * links will never work on that surface.
 */
export const NullSpaceResolver: SpaceResolver = {
  resolveSpaceLink: async () => ({ ok: false, error: 'space-not-found' as const }),
  filePathToSpaceLink: async () => null,
};
