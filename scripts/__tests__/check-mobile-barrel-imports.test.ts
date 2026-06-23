/**
 * Unit tests for the mobile barrel value-import boundary checker.
 *
 * Tests the pure `findMobileBarrelViolations()` AST detector. The gate must
 * flag VALUE imports of a broad `@shared` barrel while allowing type-only
 * imports — including the MULTI-LINE `import type { ... }` form that a
 * line-based regex would false-positive (mobile/src/components/UserQuestionCard.tsx).
 *
 * @see scripts/check-mobile-barrel-imports.ts
 * @see docs/plans/260612_recs-static-gates/PLAN.md (Stage 1, item #38)
 */
import { describe, it, expect } from 'vitest';
import {
  findMobileBarrelViolations,
  BROAD_BARREL_SPECIFIERS,
  ALLOWLIST,
  type MobileBarrelViolation,
} from '../check-mobile-barrel-imports';

const MOBILE_FILE = 'mobile/src/components/Example.tsx';

function specifiers(violations: MobileBarrelViolation[]): string[] {
  return violations.map((v) => v.specifier);
}

describe('findMobileBarrelViolations — positive (value imports flag)', () => {
  it('flags a named value import of @shared/ipc/schemas', () => {
    const source = `import { AutomationSchema } from '@shared/ipc/schemas';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('@shared/ipc/schemas');
    expect(violations[0].kind).toBe('static');
  });

  it('flags a default import', () => {
    const source = `import schemas from '@shared/ipc/schemas';`;
    expect(specifiers(findMobileBarrelViolations(source, MOBILE_FILE))).toEqual([
      '@shared/ipc/schemas',
    ]);
  });

  it('flags a namespace import', () => {
    const source = `import * as schemas from '@shared/types';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/types']);
    expect(violations[0].kind).toBe('static');
  });

  it('flags a dynamic import()', () => {
    const source = `const m = await import('@shared/ipc/channels');`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/channels']);
    expect(violations[0].kind).toBe('dynamic-import');
  });

  it('flags a require()', () => {
    const source = `const schemas = require('@shared/ipc/schemas');`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/schemas']);
    expect(violations[0].kind).toBe('require');
  });

  it('flags a bare side-effect import (runtime pull, no clause)', () => {
    const source = `import '@shared/ipc/schemas';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/schemas']);
    expect(violations[0].kind).toBe('side-effect');
  });

  it('flags a mixed import where at least one binding is a value (type + value)', () => {
    const source = `import { type Foo, bar } from '@shared/ipc/schemas';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/schemas']);
  });
});

describe('findMobileBarrelViolations — negative (allowed, no flag)', () => {
  it('allows a whole-statement type-only import', () => {
    const source = `import type { Foo } from '@shared/types';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows the MULTI-LINE type-only import form (UserQuestionCard.tsx)', () => {
    const source = [
      `import type {`,
      `  UserQuestion,`,
      `  UserQuestionAnswer,`,
      `  UserQuestionBatch,`,
      `} from '@shared/types';`,
    ].join('\n');
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a pure inline-type named import (every binding is `type`)', () => {
    const source = `import { type A, type B } from '@shared/ipc/schemas';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a leaf import @shared/ipc/schemas/feedback (not the barrel)', () => {
    const source = `import { ConversationFeedbackSchema } from '@shared/ipc/schemas/feedback';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a leaf import @shared/types/userQuestion (not the barrel)', () => {
    const source = `import { isApprovalClarificationBatch } from '@shared/types/userQuestion';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a non-barrel @shared/utils/* value import', () => {
    const source = `import { clamp } from '@shared/utils/math';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('does not report on the detector based on file location (detector is path-agnostic; the walker scopes to mobile)', () => {
    // The pure detector flags by specifier regardless of path — file-scoping is
    // the walker's job (SCAN_ROOTS = the whole mobile/ tree). A value barrel
    // import in a desktop file is simply never fed to the detector by the CLI.
    const source = `import type { Foo } from '@shared/types';`;
    expect(findMobileBarrelViolations(source, 'src/renderer/App.tsx')).toHaveLength(0);
  });
});

describe('findMobileBarrelViolations — re-exports', () => {
  it('flags a named value re-export `export { X } from \'@shared/types\'`', () => {
    const source = `export { UserQuestion } from '@shared/types';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/types']);
    expect(violations[0].kind).toBe('re-export');
  });

  it('flags a star re-export `export * from \'@shared/ipc/schemas\'`', () => {
    const source = `export * from '@shared/ipc/schemas';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/schemas']);
    expect(violations[0].kind).toBe('re-export-star');
  });

  it('allows a whole-statement type-only re-export `export type { X } from \'@shared/types\'`', () => {
    const source = `export type { UserQuestion } from '@shared/types';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a type-only star re-export `export type * from \'@shared/types\'`', () => {
    const source = `export type * from '@shared/types';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('allows a leaf re-export `export { X } from \'@shared/types/userQuestion\'` (not the barrel)', () => {
    const source = `export { isApprovalClarificationBatch } from '@shared/types/userQuestion';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });

  it('flags a mixed re-export where at least one element is a value', () => {
    const source = `export { type Foo, bar } from '@shared/ipc/schemas';`;
    const violations = findMobileBarrelViolations(source, MOBILE_FILE);
    expect(specifiers(violations)).toEqual(['@shared/ipc/schemas']);
    expect(violations[0].kind).toBe('re-export');
  });

  it('allows a re-export where every element is individually type-only', () => {
    const source = `export { type A, type B } from '@shared/ipc/schemas';`;
    expect(findMobileBarrelViolations(source, MOBILE_FILE)).toHaveLength(0);
  });
});

describe('barrel list + allowlist semantics', () => {
  it('matches the exact set of broad export-* barrels', () => {
    expect(BROAD_BARREL_SPECIFIERS).toEqual([
      '@shared/ipc/schemas',
      '@shared/ipc/channels',
      '@shared/types',
    ]);
  });

  it('ships with an empty allowlist (zero violations today)', () => {
    expect(ALLOWLIST).toHaveLength(0);
  });
});
