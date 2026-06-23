/**
 * Unit tests for the core import discipline checker.
 *
 * Tests the pure `findCoreImportViolations()` detection function against
 * various import patterns to ensure the CI rule correctly catches violations
 * while allowing legitimate patterns (type-only imports, typeof queries).
 *
 * @see scripts/check-core-imports.ts
 * @see docs/plans/260330_strengthen_de_electronification.md (Stage 3)
 */
import { describe, it, expect } from 'vitest';
import { findCoreImportViolations, type Violation } from '../check-core-imports';

const FILE = 'src/core/services/example.ts';

/** Helper: extract just the rule names from violations. */
function rules(violations: Violation[]): string[] {
  return violations.map((v) => v.rule);
}

describe('findCoreImportViolations', () => {
  // ---- Detections ----

  it('detects static import from @main/', () => {
    const source = `import { foo } from '@main/services/bar';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-import-main');
  });

  it('detects relative import reaching into ../../main/', () => {
    const source = `import { migrate } from '../../main/utils/storeMigration';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-relative-main');
  });

  it('detects deeper relative imports like ../../../main/', () => {
    const source = `import { x } from '../../../main/services/deep';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-relative-main');
  });

  it('detects runtime import from electron', () => {
    const source = `import { app } from 'electron';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-import-electron');
  });

  it('detects dynamic import("electron")', () => {
    const source = `const electron = await import('electron');`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-dynamic-import-electron');
  });

  it('detects dynamic import("@main/...")', () => {
    const source = `const sentry = await import('@main/sentry');`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-dynamic-import-main');
  });

  it('detects require("electron")', () => {
    const source = `const electron = require('electron');`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-require-electron');
  });

  it('detects require("@main/...")', () => {
    const source = `const sentry = require('@main/sentry');`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-require-main');
  });

  it('detects export * from @main/', () => {
    const source = `export * from '@main/services/foo';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-export-main');
  });

  it('detects export { x } from electron (runtime re-export)', () => {
    const source = `export { app } from 'electron';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-export-electron');
  });

  it('allows export type from electron', () => {
    const source = `export type { BrowserWindow } from 'electron';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  // ---- Allowed patterns ----

  it('allows import type from electron (no runtime dependency)', () => {
    const source = `import type { BrowserWindow } from 'electron';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('allows typeof import("electron") type queries', () => {
    const source = `type ElectronApp = typeof import('electron').app;`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('returns empty array for clean files with only @core and @shared imports', () => {
    const source = [
      `import { createStore } from '@core/storeFactory';`,
      `import type { AgentSession } from '@shared/types';`,
      `import path from 'node:path';`,
      `import { z } from 'zod';`,
      '',
      'export function doStuff() { return 42; }',
    ].join('\n');
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  // ---- Comment handling ----

  it('ignores violations inside line comments', () => {
    const source = `// import { foo } from '@main/bar';`;
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('ignores violations inside block comments', () => {
    const source = [
      '/*',
      `import { foo } from '@main/bar';`,
      '*/',
    ].join('\n');
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(0);
  });

  // ---- Line number reporting ----

  it('reports correct line numbers for violations', () => {
    const source = [
      `import { ok } from '@core/logger';`,
      '',
      `import { bad } from '@main/sentry';`,
    ].join('\n');
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
    expect(violations[0].file).toBe(FILE);
  });

  // ---- Multiple violations in one file ----

  it('detects multiple violations in a single file', () => {
    const source = [
      `import { app } from 'electron';`,
      `import { foo } from '@main/bar';`,
      `const x = await import('@main/sentry');`,
    ].join('\n');
    const violations = findCoreImportViolations(source, FILE);
    expect(violations).toHaveLength(3);
    expect(rules(violations)).toEqual(
      expect.arrayContaining(['no-import-electron', 'no-import-main', 'no-dynamic-import-main']),
    );
  });
});
