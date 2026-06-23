import { describe, it, expect } from 'vitest';
import { validateManifest } from '../pluginManifest';

describe('validateManifest', () => {
  it('validates a complete manifest', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      description: 'A test plugin',
      version: '1.0.0',
      entryPoint: 'index.tsx',
      maturity: 'labs',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('my-plugin');
    }
  });

  it('validates a minimal manifest (only required fields)', () => {
    const result = validateManifest({
      id: 'test',
      name: 'Test',
      entryPoint: 'inline',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.version).toBe('0.1.0');
      expect(result.manifest.maturity).toBe('labs');
      expect(result.manifest.permissions).toEqual([]);
      expect(result.manifest.externalDomains).toEqual([]);
    }
  });

  it('accepts permissions and external domain allowlist', () => {
    const result = validateManifest({
      id: 'permissions-plugin',
      name: 'Permissions Plugin',
      entryPoint: 'inline',
      permissions: ['memory:read', 'external-fetch'],
      externalDomains: ['api.linear.app', '*.github.com'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.permissions).toEqual(['memory:read', 'external-fetch']);
      expect(result.manifest.externalDomains).toEqual(['api.linear.app', '*.github.com']);
    }
  });

  it('accepts optional documentation markdown', () => {
    const result = validateManifest({
      id: 'doc-plugin',
      name: 'Doc Plugin',
      entryPoint: 'inline',
      documentation: '# Plugin Docs\n\nHow to use this plugin.',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.documentation).toBe('# Plugin Docs\n\nHow to use this plugin.');
    }
  });

  it('rejects invalid plugin ID (uppercase)', () => {
    const result = validateManifest({ id: 'MyPlugin', name: 'Test', entryPoint: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('lowercase');
  });

  it('rejects invalid plugin ID (spaces)', () => {
    const result = validateManifest({ id: 'my plugin', name: 'Test', entryPoint: 'x' });
    expect(result.ok).toBe(false);
  });

  it('allows underscore-prefixed internal plugin IDs', () => {
    const result = validateManifest({ id: '__demo', name: 'Demo', entryPoint: 'inline' });
    expect(result.ok).toBe(true);
  });

  it('rejects missing name', () => {
    const result = validateManifest({ id: 'test', entryPoint: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty entryPoint', () => {
    const result = validateManifest({ id: 'test', name: 'Test', entryPoint: '' });
    expect(result.ok).toBe(false);
  });

  it('accepts optional createdBy field', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      entryPoint: 'inline',
      createdBy: 'alice',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.createdBy).toBe('alice');
    }
  });

  it('accepts optional contributors array', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      entryPoint: 'inline',
      contributors: ['alice', 'bob'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributors).toEqual(['alice', 'bob']);
    }
  });

  it('accepts optional changelog array', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      entryPoint: 'inline',
      changelog: [
        { version: '0.2.0', date: '2026-03-24', author: 'Rebel', summary: 'Added filters' },
        { version: '0.1.0', date: '2026-03-23', author: 'Rebel', summary: 'Initial version' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.changelog).toHaveLength(2);
      expect(result.manifest.changelog![0].version).toBe('0.2.0');
      expect(result.manifest.changelog![1].summary).toBe('Initial version');
    }
  });

  it('validates manifest with all sharing metadata fields', () => {
    const result = validateManifest({
      id: 'meeting-prep',
      name: 'Meeting Prep',
      description: 'Summarize upcoming calls',
      version: '0.3.0',
      entryPoint: 'index.tsx',
      maturity: 'labs',
      createdBy: 'alice',
      contributors: ['alice', 'bob'],
      changelog: [
        { version: '0.3.0', date: '2026-03-24', author: 'bob', summary: 'Added agenda view' },
        { version: '0.2.0', date: '2026-03-23', author: 'alice', summary: 'Improved filtering' },
        { version: '0.1.0', date: '2026-03-22', author: 'alice', summary: 'Initial version' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.createdBy).toBe('alice');
      expect(result.manifest.contributors).toEqual(['alice', 'bob']);
      expect(result.manifest.changelog).toHaveLength(3);
    }
  });

  it('new sharing fields are optional — existing plugins unaffected', () => {
    const result = validateManifest({
      id: 'legacy-plugin',
      name: 'Legacy',
      entryPoint: 'inline',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.createdBy).toBeUndefined();
      expect(result.manifest.changelog).toBeUndefined();
      expect(result.manifest.contributors).toBeUndefined();
    }
  });

  it('rejects changelog with missing required fields', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      entryPoint: 'inline',
      changelog: [{ version: '0.1.0' }], // missing date, author, summary
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown permissions', () => {
    const result = validateManifest({
      id: 'invalid-permissions',
      name: 'Invalid Permissions',
      entryPoint: 'inline',
      permissions: ['memory:admin'],
    });

    expect(result.ok).toBe(false);
  });

  // role field — Stage A0 of 260521_plugin_publishing_org_distribution.md
  describe('role (hero / utility)', () => {
    it('defaults role to "utility" when omitted', () => {
      const result = validateManifest({
        id: 'my-plugin',
        name: 'My Plugin',
        entryPoint: 'inline',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.role).toBe('utility');
      }
    });

    it('accepts role: "hero"', () => {
      const result = validateManifest({
        id: 'my-plugin',
        name: 'My Plugin',
        entryPoint: 'inline',
        role: 'hero',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.role).toBe('hero');
      }
    });

    it('accepts role: "utility" explicitly', () => {
      const result = validateManifest({
        id: 'my-plugin',
        name: 'My Plugin',
        entryPoint: 'inline',
        role: 'utility',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.role).toBe('utility');
      }
    });

    it('rejects invalid role values', () => {
      const result = validateManifest({
        id: 'my-plugin',
        name: 'My Plugin',
        entryPoint: 'inline',
        role: 'featured',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('role');
      }
    });

    it('legacy plugins (no role field) parse cleanly with default "utility"', () => {
      const result = validateManifest({
        id: 'legacy-plugin',
        name: 'Legacy',
        entryPoint: 'inline',
        version: '1.0.0',
        maturity: 'stable',
        permissions: ['memory:read'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.role).toBe('utility');
      }
    });
  });
});
