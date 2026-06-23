import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEPS } from '../run-validate-fast';

const TARGET_SCRIPT = 'validate:cross-surface-parity-gap';
const PRECEDING_SCRIPT = 'validate:cross-surface-imports';
const TARGET_COMMAND = 'tsx scripts/check-cross-surface-parity-gap.ts';

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const packageJsonPath = join(__dirname, '..', '..', 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

describe('cross-surface parity gap validate:fast wiring', () => {
  it('runs immediately after validate:cross-surface-imports', () => {
    const stepNames = STEPS.map((step) => step.name);
    const precedingIndex = stepNames.indexOf(PRECEDING_SCRIPT);
    const targetIndex = stepNames.indexOf(TARGET_SCRIPT);

    expect(precedingIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBe(precedingIndex + 1);
    expect(STEPS[targetIndex]?.command).toBe(`npm run ${TARGET_SCRIPT}`);
  });

  it('defines the corresponding package.json script', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts?.[TARGET_SCRIPT]).toBe(TARGET_COMMAND);
  });
});
