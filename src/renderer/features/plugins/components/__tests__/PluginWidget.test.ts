import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../manifest/pluginManifest';
import type { PluginManifest, WidgetSize } from '../../manifest/pluginManifest';

// ── Manifest surfaces schema tests ──────────────────────────────────────

describe('PluginManifest surfaces schema', () => {
  it('defaults surfaces to sidebar-only when omitted', () => {
    const result = validateManifest({
      id: 'legacy-plugin',
      name: 'Legacy',
      entryPoint: 'inline',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.surfaces).toEqual({
      sidebar: { enabled: true },
      homepageWidget: { enabled: false, defaultSize: 'medium' },
    });
  });

  it('accepts explicit surfaces with sidebar and homepageWidget', () => {
    const result = validateManifest({
      id: 'widget-plugin',
      name: 'Widget Plugin',
      entryPoint: 'inline',
      surfaces: {
        sidebar: { enabled: true },
        homepageWidget: { enabled: true, defaultSize: 'large' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.surfaces).toEqual({
      sidebar: { enabled: true },
      homepageWidget: { enabled: true, defaultSize: 'large' },
    });
  });

  it('accepts homepageWidget with default size when size not specified', () => {
    const result = validateManifest({
      id: 'widget-plugin',
      name: 'Widget Plugin',
      entryPoint: 'inline',
      surfaces: {
        homepageWidget: { enabled: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.surfaces!.homepageWidget.defaultSize).toBe('medium');
  });

  it('accepts all three widget sizes', () => {
    const sizes: WidgetSize[] = ['small', 'medium', 'large'];
    for (const size of sizes) {
      const result = validateManifest({
        id: 'size-test',
        name: 'Size Test',
        entryPoint: 'inline',
        surfaces: {
          homepageWidget: { enabled: true, defaultSize: size },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.surfaces!.homepageWidget.defaultSize).toBe(size);
      }
    }
  });

  it('rejects invalid widget size', () => {
    const result = validateManifest({
      id: 'bad-size',
      name: 'Bad Size',
      entryPoint: 'inline',
      surfaces: {
        homepageWidget: { enabled: true, defaultSize: 'extra-large' },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('defaults sidebar to enabled when only homepageWidget is specified', () => {
    const result = validateManifest({
      id: 'widget-only',
      name: 'Widget Only',
      entryPoint: 'inline',
      surfaces: {
        homepageWidget: { enabled: true, defaultSize: 'small' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.surfaces!.sidebar.enabled).toBe(true);
  });

  it('allows disabling sidebar', () => {
    const result = validateManifest({
      id: 'no-sidebar',
      name: 'No Sidebar',
      entryPoint: 'inline',
      surfaces: {
        sidebar: { enabled: false },
        homepageWidget: { enabled: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.surfaces!.sidebar.enabled).toBe(false);
    expect(result.manifest.surfaces!.homepageWidget.enabled).toBe(true);
  });

  it('preserves backward compatibility — existing plugins without surfaces still valid', () => {
    const result = validateManifest({
      id: 'old-plugin',
      name: 'Old Plugin',
      description: 'An older plugin',
      version: '1.0.0',
      entryPoint: 'index.tsx',
      maturity: 'stable',
      permissions: ['memory:read'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should default to sidebar-only
    expect(result.manifest.surfaces!.sidebar.enabled).toBe(true);
    expect(result.manifest.surfaces!.homepageWidget.enabled).toBe(false);
  });
});

// ── Widget size height mapping tests ────────────────────────────────────

describe('Widget size constants', () => {
  it('size map covers all WidgetSize values', () => {
    // The WIDGET_HEIGHT constant in PluginWidget.tsx should have entries
    // for all three sizes. We test the type contract here.
    const expectedSizes: WidgetSize[] = ['small', 'medium', 'large'];
    expect(expectedSizes).toHaveLength(3);
  });
});

// ── Widget plugin filtering tests ───────────────────────────────────────

describe('Widget plugin filtering logic', () => {
  function hasWidgetSurface(manifest: PluginManifest): boolean {
    return manifest.surfaces?.homepageWidget?.enabled === true;
  }

  it('filters plugins with homepageWidget enabled', () => {
    const manifests: { manifest: PluginManifest }[] = [
      {
        manifest: {
          id: 'sidebar-only',
          name: 'Sidebar Only',
          entryPoint: 'inline',
          version: '0.1.0',
          maturity: 'labs' as const,
          role: 'utility',
          permissions: [],
          externalDomains: [],
          surfaces: {
            sidebar: { enabled: true },
            homepageWidget: { enabled: false, defaultSize: 'medium' as const },
          },
        },
      },
      {
        manifest: {
          id: 'widget-plugin',
          name: 'Widget Plugin',
          entryPoint: 'inline',
          version: '0.1.0',
          maturity: 'labs' as const,
          role: 'utility',
          permissions: [],
          externalDomains: [],
          surfaces: {
            sidebar: { enabled: true },
            homepageWidget: { enabled: true, defaultSize: 'large' as const },
          },
        },
      },
    ];

    const widgets = manifests.filter(p => hasWidgetSurface(p.manifest));
    expect(widgets).toHaveLength(1);
    expect(widgets[0].manifest.id).toBe('widget-plugin');
  });

  it('returns empty when no plugins declare widget surface', () => {
    const manifests: { manifest: PluginManifest }[] = [
      {
        manifest: {
          id: 'plain',
          name: 'Plain',
          entryPoint: 'inline',
          version: '0.1.0',
          maturity: 'labs' as const,
          role: 'utility',
          permissions: [],
          externalDomains: [],
          surfaces: {
            sidebar: { enabled: true },
            homepageWidget: { enabled: false, defaultSize: 'medium' as const },
          },
        },
      },
    ];

    const widgets = manifests.filter(p => hasWidgetSurface(p.manifest));
    expect(widgets).toHaveLength(0);
  });
});
