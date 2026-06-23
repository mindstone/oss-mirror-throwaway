import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { checkBoundaryRegistryPaths } from '../check-boundary-registry-paths';

describe('checkBoundaryRegistryPaths', () => {
  it('passes for the production boundary registry', async () => {
    const warnings = await checkBoundaryRegistryPaths();
    expect(warnings).toEqual([]);
  });

  it('reports dangling spec_doc paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'boundary-registry-paths-'));
    const registryPath = join(tempDir, 'registry.yaml');
    const trackedFile = join(tempDir, 'tracked.ts');
    writeFileSync(trackedFile, 'export const FIXTURE = true;\n', 'utf8');
    writeFileSync(
      registryPath,
      [
        'version: 1',
        'boundaries:',
        '  - id: dangling-spec',
        '    category: test',
        '    description: fixture',
        '    spec_doc: docs/project/does-not-exist-boundary-spec.md',
        '    match:',
        '      paths:',
        '        - tracked.ts',
        '      identifiers:',
        '        - FIXTURE',
        '    rationale: fixture',
        '    postmortems:',
        '      - fixture.md',
      ].join('\n'),
      'utf8',
    );

    try {
      const warnings = await checkBoundaryRegistryPaths(registryPath, tempDir);
      expect(warnings).toEqual([
        'dangling-spec: spec_doc missing at docs/project/does-not-exist-boundary-spec.md',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
