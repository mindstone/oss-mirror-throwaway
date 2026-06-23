import { getRegisteredPlugin } from '../manifest/pluginRegistry';
import type { Permission } from './types';

export const STANDARD_READ_PERMISSIONS: readonly Permission[] = [
  'conversations:read',
  'memory:read',
  'skills:read',
  'entities:read',
];

export const ELEVATED_PERMISSIONS: readonly Permission[] = [
  'conversations:write',
  'conversations:transcript',
  'skills:write',
  'automations:create',
];

export const EXTERNAL_PERMISSIONS: readonly Permission[] = ['external-fetch'];

const LEGACY_DEFAULT_PERMISSION_SET = new Set<string>(STANDARD_READ_PERMISSIONS);

/**
 * Returns the effective permission set for a plugin manifest.
 * Legacy manifests (no permissions / empty permissions) get read-only defaults.
 */
export function getEffectivePermissions(permissions?: readonly Permission[] | null): Permission[] {
  if (!permissions || permissions.length === 0) {
    return [...STANDARD_READ_PERMISSIONS];
  }
  return [...permissions];
}

/**
 * Runtime permission check for plugin API access.
 *
 * Backward compatibility: if a plugin manifest has no permissions (or an empty
 * permissions array), it is treated as a legacy read-only plugin and only
 * standard read permissions are allowed.
 */
export function checkPermission(pluginId: string, requiredPermission: string): boolean {
  const plugin = getRegisteredPlugin(pluginId);
  if (!plugin) {
    return false;
  }

  const declaredPermissions = plugin.manifest.permissions;
  if (!declaredPermissions || declaredPermissions.length === 0) {
    return LEGACY_DEFAULT_PERMISSION_SET.has(requiredPermission);
  }

  return (declaredPermissions as readonly string[]).includes(requiredPermission);
}

/**
 * Throws if a plugin does not have the required permission.
 */
export function createPermissionGuard(pluginId: string, requiredPermission: Permission): void {
  if (checkPermission(pluginId, requiredPermission)) {
    return;
  }

  const plugin = getRegisteredPlugin(pluginId);
  const pluginName = plugin?.manifest.name ?? pluginId;
  const declaredPermissions = plugin?.manifest.permissions ?? [];
  const usesLegacyDefaults = declaredPermissions.length === 0;
  const declaredLabel = usesLegacyDefaults
    ? `legacy read-only defaults (${STANDARD_READ_PERMISSIONS.join(', ')})`
    : declaredPermissions.join(', ');
  const authorizationHelp = requiredPermission === 'conversations:write'
    ? ' Add "conversations:write" to the plugin manifest, then re-enable or re-import the plugin in Settings > Plugins. Legacy plugins are read-only until updated.'
    : '';

  throw new Error(
    `Plugin "${pluginName}" is not authorized for "${requiredPermission}". Declared permissions: ${declaredLabel}.${authorizationHelp}`,
  );
}
