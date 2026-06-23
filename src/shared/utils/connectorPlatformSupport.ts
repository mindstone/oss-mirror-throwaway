/**
 * Utilities for gating connector visibility by host OS platform.
 *
 * Some MCP connectors depend on platform-specific runtimes or CLIs (e.g.
 * Apple Shortcuts uses the macOS `shortcuts` CLI — no meaningful Windows
 * or Linux behaviour). Their catalog entries set `platforms: [...]` to
 * declare which platforms they support; the "Available" connectors list
 * filters out entries unsupported on the current host.
 *
 * @see BaseConnectorEntry['platforms'] in src/shared/types/mcp.ts
 */

/** `process.platform`-style identifier for the host OS. */
export type ConnectorPlatform = 'darwin' | 'win32' | 'linux';

/**
 * Returns true when an entry is supported on the given platform.
 *
 * - `platforms` omitted or empty → cross-platform (supported everywhere).
 * - `platforms` set → supported only if it includes `currentPlatform`.
 * - `currentPlatform` unknown → be permissive (return true). We never want
 *   to hide connectors based on a missing platform signal.
 */
export function isConnectorSupportedOnPlatform(
  platforms: readonly ConnectorPlatform[] | undefined,
  currentPlatform: ConnectorPlatform | null | undefined,
): boolean {
  if (!platforms || platforms.length === 0) return true;
  if (!currentPlatform) return true;
  return platforms.includes(currentPlatform);
}

/**
 * Human-readable platform label for UI pills.
 *
 * Returns `null` when the label should not be shown — either because the
 * connector is cross-platform (no `platforms` set) or because we can't
 * meaningfully summarise a multi-platform subset beyond "macOS only" etc.
 */
export function platformSupportLabel(
  platforms: readonly ConnectorPlatform[] | undefined,
): string | null {
  if (!platforms || platforms.length === 0) return null;
  if (platforms.length === 1) {
    switch (platforms[0]) {
      case 'darwin':
        return 'macOS only';
      case 'win32':
        return 'Windows only';
      case 'linux':
        return 'Linux only';
      default:
        return null;
    }
  }
  // Multi-platform but not all three: render the explicit list.
  const names = platforms.map((p) =>
    p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : 'Linux',
  );
  return `${names.join(' + ')} only`;
}
