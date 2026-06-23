import { describe, expect, it } from 'vitest';
import {
  PluginExportRequestSchema,
  PluginExportResultSchema,
  PluginImportResultSchema,
} from '../pluginExportImport';

describe('pluginExportImport schemas', () => {
  it('parses valid export payloads', () => {
    const request = PluginExportRequestSchema.parse({ pluginId: 'meeting-prep' });
    const result = PluginExportResultSchema.parse({
      ok: true,
      filePath: '/tmp/meeting-prep.rebel-plugin.json',
    });

    expect(request).toEqual({ pluginId: 'meeting-prep' });
    expect(result).toEqual({
      ok: true,
      filePath: '/tmp/meeting-prep.rebel-plugin.json',
    });
  });

  it('rejects missing required fields', () => {
    expect(PluginExportRequestSchema.safeParse({}).success).toBe(false);
    expect(
      PluginImportResultSchema.safeParse({
        ok: true,
        manifest: {
          id: 'meeting-prep',
        },
      }).success,
    ).toBe(false);
  });

  it('strips unknown fields', () => {
    const exportRequest = PluginExportRequestSchema.parse({
      pluginId: 'meeting-prep',
      unexpected: 'remove-me',
    });

    const importResult = PluginImportResultSchema.parse({
      ok: true,
      manifest: {
        id: 'meeting-prep',
        name: 'Meeting Prep',
        description: 'Plugin description',
        version: '1.0.0',
        extraManifestField: 'remove-me',
      },
      source: 'export default function Plugin() { return null; }',
      extraTopLevel: 'remove-me',
    });

    expect(exportRequest).toEqual({ pluginId: 'meeting-prep' });
    expect(importResult).toEqual({
      ok: true,
      manifest: {
        id: 'meeting-prep',
        name: 'Meeting Prep',
        description: 'Plugin description',
        version: '1.0.0',
      },
      source: 'export default function Plugin() { return null; }',
    });
  });
});
