import { beforeEach, describe, expect, it } from 'vitest';
import { clearPluginRegistry, registerPlugin } from '../../manifest/pluginRegistry';
import type { PluginManifest } from '../../manifest/pluginManifest';
import {
  checkPermission,
  createPermissionGuard,
  getEffectivePermissions,
  STANDARD_READ_PERMISSIONS,
} from '../pluginPermissions';

function makeTestManifest(
  overrides: Pick<PluginManifest, 'id' | 'name' | 'entryPoint'> & Partial<Omit<PluginManifest, 'id' | 'name' | 'entryPoint'>>,
): PluginManifest {
  return {
    version: '0.1.0',
    maturity: 'labs',
    role: 'utility',
    permissions: [],
    externalDomains: [],
    surfaces: {
      sidebar: { enabled: true },
      homepageWidget: { enabled: false, defaultSize: 'medium' },
    },
    ...overrides,
  };
}

describe('pluginPermissions', () => {
  beforeEach(() => {
    clearPluginRegistry();
  });

  it('returns false when plugin is not registered', () => {
    expect(checkPermission('missing-plugin', 'memory:read')).toBe(false);
  });

  it('uses legacy read-only defaults when permissions are missing/empty', () => {
    const result = registerPlugin(
      makeTestManifest({
        id: 'legacy-plugin',
        name: 'Legacy Plugin',
        entryPoint: 'inline',
      }),
      'export default function LegacyPlugin() { return null; }',
    );
    expect(result.ok).toBe(true);

    for (const permission of STANDARD_READ_PERMISSIONS) {
      expect(checkPermission('legacy-plugin', permission)).toBe(true);
    }

    expect(checkPermission('legacy-plugin', 'conversations:write')).toBe(false);
    expect(checkPermission('legacy-plugin', 'skills:write')).toBe(false);
    expect(checkPermission('legacy-plugin', 'external-fetch')).toBe(false);
  });

  it('allows only explicitly declared permissions when permissions are present', () => {
    const result = registerPlugin(
      makeTestManifest({
        id: 'scoped-plugin',
        name: 'Scoped Plugin',
        entryPoint: 'inline',
        permissions: ['skills:read'],
      }),
      'export default function ScopedPlugin() { return null; }',
    );
    expect(result.ok).toBe(true);

    expect(checkPermission('scoped-plugin', 'skills:read')).toBe(true);
    expect(checkPermission('scoped-plugin', 'memory:read')).toBe(false);
    expect(checkPermission('scoped-plugin', 'conversations:read')).toBe(false);
  });

  it('createPermissionGuard does not throw when permission is allowed', () => {
    const result = registerPlugin(
      makeTestManifest({
        id: 'allowed-plugin',
        name: 'Allowed Plugin',
        entryPoint: 'inline',
        permissions: ['memory:read'],
      }),
      'export default function AllowedPlugin() { return null; }',
    );
    expect(result.ok).toBe(true);

    expect(() => createPermissionGuard('allowed-plugin', 'memory:read')).not.toThrow();
  });

  it('createPermissionGuard throws a descriptive error when permission is denied', () => {
    const result = registerPlugin(
      makeTestManifest({
        id: 'denied-plugin',
        name: 'Denied Plugin',
        entryPoint: 'inline',
        permissions: ['skills:read'],
      }),
      'export default function DeniedPlugin() { return null; }',
    );
    expect(result.ok).toBe(true);

    expect(() => createPermissionGuard('denied-plugin', 'memory:read')).toThrow(
      'Plugin "Denied Plugin" is not authorized for "memory:read"',
    );
  });

  it('getEffectivePermissions falls back to legacy defaults', () => {
    expect(getEffectivePermissions()).toEqual([...STANDARD_READ_PERMISSIONS]);
    expect(getEffectivePermissions([])).toEqual([...STANDARD_READ_PERMISSIONS]);
    expect(getEffectivePermissions(['external-fetch'])).toEqual(['external-fetch']);
  });
});
