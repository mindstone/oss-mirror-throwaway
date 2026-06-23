export const OFFICE_MCP_PACKAGE_NAME = '@mindstone/mcp-server-office';
export const OFFICE_MCP_PACKAGE_VERSION = '0.2.0';
export const OFFICE_MCP_PACKAGE_SPEC = `${OFFICE_MCP_PACKAGE_NAME}@${OFFICE_MCP_PACKAGE_VERSION}`;

/**
 * FOX-3319 scope migration tolerance.
 *
 * During the `@mindstone-engineering/*` → `@mindstone/*` rollout, a Rebel
 * deploy can lag the catalog flip by one window. To avoid a broken sidecar
 * on either side of the cutover, the Office sidecar tries each spec in
 * order and uses whichever managed install actually exists on disk.
 *
 * After Stage 8 flipped the canonical constants to `@mindstone`, the legacy
 * `@mindstone-engineering/mcp-server-office@0.1.3` entry stays in this list
 * so users whose managed install was already on the old scope can still be
 * looked up by the sidecar resolver until `managedMcpAutoUpgrade` rewrites
 * them to the new managed path on next launch.
 *
 * Disposal plan: once adoption telemetry (Stage 9 counter) shows <0.1% of
 * weekly-active installs report legacy-scope entries for 4 weeks, drop the
 * legacy entry from this list as part of Stage 10 (deprecate legacy scope).
 *
 * Path segments are intentionally NOT carried here — they are derived at
 * lookup time from `InstallMetadata.packageName` so a single source of
 * truth (the install metadata on disk) drives both the spec match and the
 * subsequent path construction.
 */
export const OFFICE_MCP_PACKAGE_SPECS_TO_TRY: readonly string[] = [
  OFFICE_MCP_PACKAGE_SPEC,
  '@mindstone-engineering/mcp-server-office@0.1.3',
] as const;

/**
 * Filename `npm pack` produces for the Office package. npm canonicalizes
 * scoped names by replacing `@` and `/` so `@mindstone/mcp-server-office@0.2.0`
 * becomes `mindstone-mcp-server-office-0.2.0.tgz`.
 *
 * Built and shipped by `scripts/build-managed-install-seeds.mjs` and resolved
 * at install time by `managedMcpInstallService` (see seed lookup) and at
 * packaging time by `forge.config.cjs::packageAfterCopy`. Treat this as the
 * single source of truth — drift here will silently disable the seed fast path.
 */
export const OFFICE_MCP_SEED_TARBALL_FILENAME = `${OFFICE_MCP_PACKAGE_NAME.replace(/^@/, '').replace(/\//g, '-')}-${OFFICE_MCP_PACKAGE_VERSION}.tgz`;

/**
 * Subdirectory (relative to packaged `resources/` or repo `dist/`) where
 * managed-install seed tarballs live.
 */
export const MANAGED_INSTALL_SEEDS_SUBDIR = 'managed-install-seeds';
