import { describe, expect, it } from 'vitest';
import { findVitestImports } from '../check-mobile-test-runner';

describe('findVitestImports', () => {
  it('detects imports from the vitest package', () => {
    const source = `import { describe, expect, it } from 'vitest';`;

    expect(findVitestImports(source)).toEqual(['vitest']);
  });

  it('detects imports from vitest subpaths', () => {
    const source = `import { defineConfig } from 'vitest/config';`;

    expect(findVitestImports(source)).toEqual(['vitest/config']);
  });

  it('detects require calls for the vitest package', () => {
    const source = `const { describe, expect, it } = require('vitest');`;

    expect(findVitestImports(source)).toEqual(['vitest']);
  });

  it('does not flag clean Jest-globals tests', () => {
    const source = `
      describe('queue copy', () => {
        it('uses Jest globals without importing a runner', () => {
          expect(formatQueueCopy()).toBe('Queue full');
        });
      });
    `;

    expect(findVitestImports(source)).toEqual([]);
  });

  it('does not flag local paths that merely contain the substring vitest', () => {
    const source = `import { helper } from './myvitestHelper';`;

    expect(findVitestImports(source)).toEqual([]);
  });
});
