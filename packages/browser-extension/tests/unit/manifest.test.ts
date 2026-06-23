import { describe, expect, it } from 'vitest';
import { manifestConfig as manifest } from '../../src/manifest.config';

describe('browser extension manifest', () => {
  it('exports a parseable MV3 manifest object', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Rebel');
    expect(Array.isArray(manifest.web_accessible_resources)).toBe(true);
  });

  it('declares optional host permissions for runtime origin grants', () => {
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
  });

  it('declares favicon permission for per-origin permission cards', () => {
    expect(manifest.permissions).toContain('favicon');
  });

  it('does not declare raw .ts files in web-accessible resources', () => {
    const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources) ?? [];
    expect(resources.some((resource) => resource.endsWith('.ts'))).toBe(false);
  });

  it('does not expose the boot-token file as a web-accessible resource', () => {
    const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources) ?? [];
    expect(resources).not.toContain('rebel-boot-token.json');
  });
});
