/**
 * Unit tests for the "no production imports from __tests__/" guard.
 *
 * Proves the kill-by-construction guard (PLAN Stage 10):
 *   - a prod file importing from `__tests__/`  -> violation (guard fails)
 *   - a clean prod file                         -> no violation
 *   - a TEST file importing from `__tests__/`   -> allowed (isTestFile true)
 * across relative / aliased / dynamic / re-export import forms.
 *
 * @see scripts/check-no-prod-test-imports.ts
 * @see docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md (Stage 10)
 */
import { describe, it, expect } from 'vitest';
import {
  findTestImportViolations,
  isTestFile,
  type TestImportViolation,
} from '../check-no-prod-test-imports';

const PROD_FILE = 'src/main/ipc/registerHandler.ts';

function specifiers(violations: TestImportViolation[]): string[] {
  return violations.map((v) => v.specifier);
}

describe('findTestImportViolations', () => {
  // ---- Detections (the Stage-2 bug class) ----

  it('detects the exact Stage-2 defect: aliased import from @.../__tests__/', () => {
    const source = `import { registerContractHandler } from '@main/ipc/__tests__/harness/registerContractHandler';`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
    expect(specifiers(violations)).toContain('@main/ipc/__tests__/harness/registerContractHandler');
  });

  it('detects relative import reaching into ../__tests__/', () => {
    const source = `import { fixture } from '../__tests__/fixtures/sample';`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
    expect(specifiers(violations)).toContain('../__tests__/fixtures/sample');
  });

  it('detects deeper relative import ../../__tests__/', () => {
    const source = `import x from '../../__tests__/util';`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
  });

  it('detects re-export from __tests__/ (export ... from)', () => {
    const source = `export { harness } from '@core/__tests__/harness';`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
    expect(specifiers(violations)).toContain('@core/__tests__/harness');
  });

  it('detects dynamic import() from __tests__/', () => {
    const source = `const h = await import('../__tests__/harness');`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
  });

  it('detects require() from __tests__/', () => {
    const source = `const h = require('@main/__tests__/harness');`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
  });

  it('detects bare side-effect import from __tests__/', () => {
    const source = `import '@main/__tests__/sideEffect';`;
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
  });

  it('reports the correct line number', () => {
    const source = [
      `import { ok } from '@core/logger';`,
      '',
      `import { bad } from '@main/ipc/__tests__/harness';`,
    ].join('\n');
    const violations = findTestImportViolations(source, PROD_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
    expect(violations[0].file).toBe(PROD_FILE);
  });

  // ---- Allowed patterns ----

  it('allows a clean prod file (no __tests__ specifier)', () => {
    const source = [
      `import { z } from 'zod';`,
      `import type { Handler } from '@shared/ipc/types';`,
      `import { registerHandler } from './registry';`,
      '',
      'export function register() { return 1; }',
    ].join('\n');
    expect(findTestImportViolations(source, PROD_FILE)).toHaveLength(0);
  });

  it('does NOT flag a "__tests__" substring that is not a path segment', () => {
    // e.g. a string constant, not an import specifier path segment
    const source = `import { thing } from '@main/services/my__tests__helper';`;
    expect(findTestImportViolations(source, PROD_FILE)).toHaveLength(0);
  });

  it('ignores a __tests__ import inside a line comment', () => {
    const source = `// import { x } from '../__tests__/harness';`;
    expect(findTestImportViolations(source, PROD_FILE)).toHaveLength(0);
  });

  it('ignores a __tests__ import inside a block comment', () => {
    const source = ['/*', `import { x } from '../__tests__/harness';`, '*/'].join('\n');
    expect(findTestImportViolations(source, PROD_FILE)).toHaveLength(0);
  });
});

describe('isTestFile', () => {
  it('treats __tests__ files as test files (allowed to import from __tests__/)', () => {
    expect(isTestFile('src/main/ipc/__tests__/registerHandler.test.ts')).toBe(true);
    expect(isTestFile('src/main/ipc/__tests__/harness/registerContractHandler.ts')).toBe(true);
  });

  it('treats *.test.* and *.spec.* as test files', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(isTestFile('src/foo.integration.test.ts')).toBe(true);
  });

  it('treats test-utils/** scaffolding as test files', () => {
    expect(isTestFile('src/test-utils/cloudHarness/bootstrapDesktopPlatform.ts')).toBe(true);
    expect(isTestFile('src/renderer/test-utils/render.tsx')).toBe(true);
  });

  it('treats ordinary production source as NOT a test file', () => {
    expect(isTestFile('src/main/ipc/registerHandler.ts')).toBe(false);
    expect(isTestFile('src/core/services/foo.ts')).toBe(false);
  });

  it('end-to-end: a TEST file importing from __tests__/ is allowed because isTestFile is true', () => {
    const file = 'src/main/ipc/__tests__/registerHandler.test.ts';
    const source = `import { harness } from '../__tests__/harness';`;
    // The guard never feeds test files to findTestImportViolations; this asserts
    // the gate that excludes them.
    expect(isTestFile(file)).toBe(true);
    // (For completeness: the detector would flag the specifier — but the file is
    //  filtered out upstream by isTestFile, so the import is permitted.)
    expect(findTestImportViolations(source, file).length).toBeGreaterThan(0);
  });
});
