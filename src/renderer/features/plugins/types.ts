/**
 * Plugin Surface Types
 *
 * Branded types for plugin surfaces, type guards, and factory functions.
 * Plugins register surfaces (main-pane tabs) via `PluginSurfaceId`, a branded string
 * that coexists with built-in `BuiltInFlowSurface` values in the union `FlowSurface`.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 */

import { FLOW_SURFACES } from '@renderer/features/flow-panels/constants';

// ── Built-in surface type ──────────────────────────────────────────────
// Re-derive from the canonical FLOW_SURFACES array so there's a single source of truth.

export type BuiltInFlowSurface = (typeof FLOW_SURFACES)[number];

/**
 * Set for O(1) membership checks.
 */
export const BUILT_IN_FLOW_SURFACES = new Set<string>(FLOW_SURFACES);

// ── Plugin surface branded type ────────────────────────────────────────

/**
 * A branded string type representing a plugin-contributed surface.
 * Format: `plugin:{pluginId}` or `plugin:{pluginId}:{tabId}`
 *
 * Created exclusively via `createPluginSurfaceId()` to guarantee validity.
 */
export type PluginSurfaceId = string & { readonly __brand: 'PluginSurfaceId' };

/** Regex for valid plugin/tab ID segments: lowercase alphanumeric + hyphens, optional __ prefix for built-ins */
const VALID_ID_SEGMENT = /^(?:__)?[a-z0-9-]+$/;

/**
 * Create a branded plugin surface ID.
 *
 * @param pluginId - Lowercase alphanumeric + hyphens (e.g., "my-plugin")
 * @param tabId    - Optional tab within the plugin (same charset)
 * @returns Branded `PluginSurfaceId` string
 * @throws If pluginId or tabId contain invalid characters
 */
export function createPluginSurfaceId(pluginId: string, tabId?: string): PluginSurfaceId {
  if (!VALID_ID_SEGMENT.test(pluginId)) {
    throw new Error(`Invalid plugin ID: ${pluginId}`);
  }
  if (tabId !== undefined && !VALID_ID_SEGMENT.test(tabId)) {
    throw new Error(`Invalid tab ID: ${tabId}`);
  }
  return `plugin:${pluginId}${tabId ? `:${tabId}` : ''}` as PluginSurfaceId;
}

// ── Type guards ────────────────────────────────────────────────────────

/**
 * Check if a FlowSurface value is a built-in surface (home, sessions, etc.).
 */
export function isBuiltInSurface(s: string): s is BuiltInFlowSurface {
  return BUILT_IN_FLOW_SURFACES.has(s);
}

/**
 * Check if a FlowSurface value is a plugin-contributed surface.
 */
export function isPluginSurface(s: string): s is PluginSurfaceId {
  return typeof s === 'string' && s.startsWith('plugin:');
}

/**
 * Extract the pluginId from a PluginSurfaceId.
 * Returns undefined if the value isn't a valid plugin surface.
 */
export function getPluginIdFromSurface(s: string): string | undefined {
  if (!isPluginSurface(s)) return undefined;
  // "plugin:my-plugin" → "my-plugin"
  // "plugin:my-plugin:tab" → "my-plugin"
  const parts = s.slice('plugin:'.length).split(':');
  return parts[0];
}
