import { PREFERRED_PLANNING_MODEL } from '../../src/shared/utils/modelNormalization';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E test defaults sync', () => {
  it('CLAUDE_DEFAULTS model in test-utils matches PREFERRED_PLANNING_MODEL', () => {
    const testUtilsPath = path.join(__dirname, '..', '..', 'tests', 'e2e', 'test-utils.ts');
    const content = fs.readFileSync(testUtilsPath, 'utf8');
    expect(content).toContain(`model: '${PREFERRED_PLANNING_MODEL}'`);
  });
});
