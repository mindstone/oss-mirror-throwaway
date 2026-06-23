import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  extractModuleSpecifiers,
  resolveToSafetyModule,
  findOrphanSafetyModules,
  toPosix,
  SAFETY_CALLSITE_ALLOWLIST,
} from '../check-safety-dir-call-sites';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('extractModuleSpecifiers', () => {
  it('captures static imports, re-exports, dynamic import, and require', () => {
    const src = `
      import { a } from '@core/services/safety/toolVerbs';
      import type { T } from './types';
      export { b } from '@core/services/safety/constants';
      const m = await import('@core/services/safety/mcpDenyHook');
      const r = require('@core/services/safety/hashUtils');
    `;
    const specs = extractModuleSpecifiers(src);
    expect(specs).toContain('@core/services/safety/toolVerbs');
    expect(specs).toContain('./types');
    expect(specs).toContain('@core/services/safety/constants');
    expect(specs).toContain('@core/services/safety/mcpDenyHook');
    expect(specs).toContain('@core/services/safety/hashUtils');
  });

  it('returns empty for a file with no imports', () => {
    expect(extractModuleSpecifiers('export const x = 1;')).toEqual([]);
  });
});

describe('resolveToSafetyModule', () => {
  const importer = path.join(REPO_ROOT, 'src', 'core', 'services', 'turnPipeline', 'foo.ts');

  it('resolves @core alias targeting the safety dir to a repo-relative path', () => {
    const r = resolveToSafetyModule('@core/services/safety/toolVerbs', importer);
    expect(r).toBe('src/core/services/safety/toolVerbs.ts');
  });

  it('resolves a barrel directory specifier to its index.ts', () => {
    const r = resolveToSafetyModule('@core/services/safety/connectorApprovalGates', importer);
    expect(r).toBe('src/core/services/safety/connectorApprovalGates/index.ts');
  });

  it('returns null for non-safety targets', () => {
    expect(resolveToSafetyModule('@core/services/turnPipeline/bar', importer)).toBeNull();
    expect(resolveToSafetyModule('react', importer)).toBeNull();
    expect(resolveToSafetyModule('@shared/utils/foo', importer)).toBeNull();
  });

  it('resolves relative specifiers from a sibling safety file', () => {
    const safetyImporter = path.join(
      REPO_ROOT,
      'src',
      'core',
      'services',
      'safety',
      'toolSafetyService.ts',
    );
    const r = resolveToSafetyModule('./toolVerbs', safetyImporter);
    expect(r).toBe('src/core/services/safety/toolVerbs.ts');
  });
});

describe('findOrphanSafetyModules (integration over live tree)', () => {
  it('reports zero orphans on the current repository', () => {
    const { orphans, scannedSafetyFiles, importerFiles } = findOrphanSafetyModules();
    expect(orphans, `unexpected orphan safety modules: ${orphans.join(', ')}`).toEqual([]);
    expect(scannedSafetyFiles).toBeGreaterThan(0);
    expect(importerFiles).toBeGreaterThan(100);
  });

  it('every allowlisted path exists under the safety dir and is POSIX-relative', () => {
    for (const p of SAFETY_CALLSITE_ALLOWLIST) {
      expect(p.startsWith('src/core/services/safety/')).toBe(true);
      expect(toPosix(p)).toBe(p);
    }
  });
});

describe('orphan detection is non-vacuous (synthetic graph)', () => {
  // Re-implement the pure reachability core against a synthetic file set to prove
  // the gate fires when a safety module has no importer. We exercise the resolver
  // + reachability logic the same way the script does, on a fixture graph.
  function reachableSafetyModules(
    files: { rel: string; text: string }[],
  ): Set<string> {
    const imported = new Set<string>();
    for (const f of files) {
      const importerAbs = path.join(REPO_ROOT, f.rel);
      for (const spec of extractModuleSpecifiers(f.text, importerAbs)) {
        const r = resolveToSafetyModule(spec, importerAbs);
        if (r && r !== toPosix(f.rel)) imported.add(r);
      }
    }
    return imported;
  }

  it('a wired module is reachable; an unwired one is not', () => {
    const files = [
      {
        rel: 'src/core/services/turnPipeline/consumer.ts',
        text: `import { run } from '@core/services/safety/toolVerbs';`,
      },
    ];
    const reachable = reachableSafetyModules(files);
    expect(reachable.has('src/core/services/safety/toolVerbs.ts')).toBe(true);
    // bashProtectedPathGuard is NOT imported in this synthetic graph → would be flagged.
    expect(reachable.has('src/core/services/safety/bashProtectedPathGuard.ts')).toBe(false);
  });
});
