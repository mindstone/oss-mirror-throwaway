/**
 * Unit tests for the cross-surface import discipline checker.
 *
 * Tests the pure `findCrossSurfaceViolations()` detection function against
 * the four bypass classes the production-mode CI guard must catch:
 *   1. Non-allowlisted file gets a new `@main/*` import.
 *   2. Already-allowlisted file gets a NEW `@main/*` specifier (file-level bypass).
 *   3. Non-allowlisted file uses dynamic `import('@main/...')`.
 *   4. Any `@main/*` import in `mobile/**` (allowlist starts empty).
 *
 * And the positive case:
 *   5. All currently-allowlisted (file, specifier) pairs return zero violations.
 *
 * @see scripts/check-cross-surface-imports.ts
 * @see docs/plans/260514_surface_capabilities_and_quick_wins.md (Stage 3)
 */
import { describe, it, expect } from 'vitest';
import {
  findCrossSurfaceViolations,
  ALLOWLIST,
  type CrossSurfaceViolation,
} from '../check-cross-surface-imports';

function specifiers(violations: CrossSurfaceViolation[]): string[] {
  return violations.map((v) => v.specifier);
}

describe('findCrossSurfaceViolations', () => {
  it('flags a NEW @main/* static import in a non-allowlisted cloud file', () => {
    const source = `import { foo } from '@main/services/newService';`;
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/routes/brandNewRoute.ts',
      ALLOWLIST,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('@main/services/newService');
    expect(violations[0].isDynamic).toBe(false);
  });

  it('flags a NEW @main/* specifier in an ALREADY-allowlisted file (per-pair, not per-file)', () => {
    const customAllowlist = [
      {
        file: 'cloud-service/src/bootstrap.ts',
        specifier: '@main/services/alreadyAllowlisted',
        reason: 'test-fixture',
      },
    ] as const;
    const source = `import { freshSymbol } from '@main/services/somethingNotAllowlisted';`;
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/bootstrap.ts',
      customAllowlist,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('@main/services/somethingNotAllowlisted');
    expect(violations[0].isDynamic).toBe(false);
  });

  it('flags a dynamic import("@main/...") in a non-allowlisted cloud file', () => {
    const source = `const mod = await import('@main/services/freshDynamic');`;
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/routes/brandNewRoute.ts',
      ALLOWLIST,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('@main/services/freshDynamic');
    expect(violations[0].isDynamic).toBe(true);
  });

  it('flags any @main/* static import in mobile/** (mobile allowlist is empty)', () => {
    const source = `import { foo } from '@main/services/anything';`;
    const violations = findCrossSurfaceViolations(
      source,
      'mobile/src/App.ts',
      ALLOWLIST,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('@main/services/anything');
  });

  it('returns zero violations when all current allowlist pairs are present', () => {
    // Group allowlist entries by file so we can build a representative source per file.
    const byFile = new Map<string, string[]>();
    for (const entry of ALLOWLIST) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry.specifier);
      byFile.set(entry.file, list);
    }

    let totalChecked = 0;
    for (const [file, specs] of byFile) {
      const lines = specs.map((spec, i) => {
        // Mix of static and dynamic forms so both code paths are exercised.
        return i % 2 === 0
          ? `import { sym${i} } from '${spec}';`
          : `const mod${i} = await import('${spec}');`;
      });
      const source = lines.join('\n');
      const violations = findCrossSurfaceViolations(source, file, ALLOWLIST);
      expect(violations, `unexpected violations in ${file}`).toEqual([]);
      totalChecked += specs.length;
    }
    // Sanity: the suite covered every allowlist entry exactly once.
    expect(totalChecked).toBe(ALLOWLIST.length);
  });

  // ---- Comment-handling sanity ----

  it('ignores @main/* references inside line comments', () => {
    const source = `// import { foo } from '@main/services/bar';`;
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/routes/brandNewRoute.ts',
      ALLOWLIST,
    );
    expect(violations).toEqual([]);
  });

  it('ignores @main/* references inside block comments', () => {
    const source = ['/*', `import { foo } from '@main/services/bar';`, '*/'].join('\n');
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/routes/brandNewRoute.ts',
      ALLOWLIST,
    );
    expect(violations).toEqual([]);
  });

  it('reports correct line numbers for the violating import', () => {
    const source = [
      `import { ok } from '@core/services/whatever';`,
      '',
      `import { bad } from '@main/services/freshThing';`,
    ].join('\n');
    const violations = findCrossSurfaceViolations(
      source,
      'cloud-service/src/routes/brandNewRoute.ts',
      ALLOWLIST,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
    expect(specifiers(violations)).toEqual(['@main/services/freshThing']);
  });
});
