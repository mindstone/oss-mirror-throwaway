/**
 * Unit tests for the cross-surface alias integrity checker.
 *
 * Covers both tsconfig-style JSON configs and regex-based JS/TS configs,
 * plus the "required alias missing" surface. Stage 0 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` (F29).
 *
 * @see scripts/check-alias-integrity.ts
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  extractTsconfigAliases,
  extractRegexAliases,
  extractAllRegexAliases,
  runAliasCheck,
  extractBuildCalls,
  pluginsArrayHasAliasPlugin,
  checkWorkerBuildPluginAttachment,
  type ConfigCheck,
} from '../check-alias-integrity';

const ROOT = '/virtual/repo';

function configAt(rel: string, kind: 'tsconfig' | 'regex', required?: ConfigCheck['required']): ConfigCheck {
  return {
    file: path.join(ROOT, rel),
    kind,
    required,
  };
}

describe('extractTsconfigAliases', () => {
  it('extracts Stage-0 aliases with paths entries', () => {
    const json = JSON.stringify({
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/shared/src'],
          '@rebel/shared/*': ['./packages/shared/src/*'],
          '@rebel/cloud-client': ['./cloud-client/src'],
          '@shared/*': ['./src/shared/*'],
          '@core/*': ['./src/core/*'],
        },
      },
    });
    const result = extractTsconfigAliases(json);
    expect(result['@rebel/shared']).toBe('./packages/shared/src');
    expect(result['@rebel/cloud-client']).toBe('./cloud-client/src');
    expect(result['@shared']).toBe('./src/shared');
    expect(result['@core']).toBe('./src/core');
  });

  it('ignores unrelated aliases', () => {
    const json = JSON.stringify({
      compilerOptions: {
        paths: {
          '@/*': ['./src/renderer/*'],
          '@renderer/*': ['./src/renderer/*'],
        },
      },
    });
    const result = extractTsconfigAliases(json);
    expect(result['@rebel/shared']).toBeUndefined();
    expect(result['@core']).toBeUndefined();
  });

  it('tolerates // line comments inside the JSON (jsonc)', () => {
    const jsonc = `
// this is a tsconfig
{
  "compilerOptions": {
    "paths": {
      // canonical alias
      "@rebel/shared": ["./packages/shared/src"]
    }
  }
}
`;
    const result = extractTsconfigAliases(jsonc);
    expect(result['@rebel/shared']).toBe('./packages/shared/src');
  });
});

describe('extractRegexAliases', () => {
  it('extracts aliases from electron-vite style config', () => {
    const text = `
      export default defineConfig({
        renderer: {
          resolve: {
            alias: {
              '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
              '@rebel/cloud-client': resolve(__dirname, 'cloud-client/src'),
              '@renderer': resolve(__dirname, 'src/renderer'),
              '@shared': resolve(__dirname, 'src/shared')
            }
          }
        }
      });
    `;
    const result = extractRegexAliases(text);
    expect(result['@rebel/shared']).toBe('packages/shared/src');
    expect(result['@rebel/cloud-client']).toBe('cloud-client/src');
    expect(result['@shared']).toBe('src/shared');
  });

  it('extracts aliases from vitest path.resolve style config', () => {
    const text = `
      const sharedAliases = {
        '@core': path.resolve(__dirname, './src/core'),
        '@shared': path.resolve(__dirname, './src/shared'),
        '@rebel/shared': path.resolve(__dirname, './packages/shared/src'),
        '@rebel/cloud-client': path.resolve(__dirname, './cloud-client/src'),
      };
    `;
    const result = extractRegexAliases(text);
    expect(result['@rebel/shared']).toBe('./packages/shared/src');
    expect(result['@rebel/cloud-client']).toBe('./cloud-client/src');
    expect(result['@shared']).toBe('./src/shared');
    expect(result['@core']).toBe('./src/core');
  });

  it('extracts aliases from jest moduleNameMapper style config', () => {
    const text = `
      moduleNameMapper: {
        '^@rebel/cloud-client$': '<rootDir>/../cloud-client/src/index.ts',
        '^@rebel/shared$': '<rootDir>/../packages/shared/src/index.ts',
        '^@shared/(.*)$': '<rootDir>/../src/shared/$1',
        '^@core/(.*)$': '<rootDir>/../src/core/$1',
      }
    `;
    const result = extractRegexAliases(text);
    // Both `/index.ts` suffixes and `/$1` capture groups are stripped so the
    // normalised target is always the directory the alias resolves into.
    expect(result['@rebel/cloud-client']).toBe('<rootDir>/../cloud-client/src');
    expect(result['@rebel/shared']).toBe('<rootDir>/../packages/shared/src');
    expect(result['@shared']).toBe('<rootDir>/../src/shared');
    expect(result['@core']).toBe('<rootDir>/../src/core');
  });

  it('returns empty result when no relevant aliases are present', () => {
    const text = `
      export default defineConfig({
        resolve: {
          alias: {
            '@renderer': resolve(__dirname, 'src/renderer')
          }
        }
      });
    `;
    const result = extractRegexAliases(text);
    expect(result['@rebel/shared']).toBeUndefined();
    expect(result['@rebel/cloud-client']).toBeUndefined();
  });
});

describe('runAliasCheck — happy path', () => {
  it('returns no violations when every config is canonical', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/shared/src'],
          '@rebel/cloud-client': ['./cloud-client/src'],
          '@shared/*': ['./src/shared/*'],
          '@core/*': ['./src/core/*'],
        },
      },
    });
    const viteConfig = `
      '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
      '@rebel/cloud-client': resolve(__dirname, 'cloud-client/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    `;
    const files: Record<string, string> = {
      [path.join(ROOT, 'tsconfig.renderer.json')]: tsconfig,
      [path.join(ROOT, 'electron.vite.config.ts')]: viteConfig,
    };
    const result = runAliasCheck(
      ROOT,
      [
        configAt('tsconfig.renderer.json', 'tsconfig', [
          '@rebel/shared',
          '@rebel/cloud-client',
          '@shared',
          '@core',
        ]),
        configAt('electron.vite.config.ts', 'regex', [
          '@rebel/shared',
          '@rebel/cloud-client',
          '@shared',
          '@core',
        ]),
      ],
      (p) => files[p]!,
    );
    expect(result.violations).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe('runAliasCheck — violation detection', () => {
  it('flags an alias pointing to the wrong path', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/WRONG/src'],
        },
      },
    });
    const result = runAliasCheck(
      ROOT,
      [configAt('tsconfig.renderer.json', 'tsconfig')],
      () => tsconfig,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.alias).toBe('@rebel/shared');
    expect(result.violations[0]!.expected).toBe('packages/shared/src');
    expect(result.violations[0]!.found).toBe('packages/WRONG/src');
    expect(result.missing).toEqual([]);
  });

  it('reports missing required aliases', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { paths: {} },
    });
    const result = runAliasCheck(
      ROOT,
      [
        configAt('tsconfig.renderer.json', 'tsconfig', [
          '@rebel/shared',
          '@rebel/cloud-client',
        ]),
      ],
      () => tsconfig,
    );
    expect(result.missing).toHaveLength(2);
    expect(result.missing.map((m) => m.alias).sort()).toEqual([
      '@rebel/cloud-client',
      '@rebel/shared',
    ]);
  });

  it('handles nested configs with relative paths (cloud-service style)', () => {
    // cloud-service/tsconfig.json lives in a subdirectory; its `../src/core`
    // path must normalise back to `src/core` at the repo root.
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: {
          '@core/*': ['../src/core/*'],
          '@shared/*': ['../src/shared/*'],
          '@rebel/shared': ['../packages/shared/src'],
        },
      },
    });
    const result = runAliasCheck(
      ROOT,
      [configAt('cloud-service/tsconfig.json', 'tsconfig')],
      () => tsconfig,
    );
    expect(result.violations).toEqual([]);
  });

  it('handles jest moduleNameMapper paths (mobile style)', () => {
    // mobile/jest.config.js uses <rootDir>/../packages/shared/src/index.ts.
    // That normalises to `packages/shared/src/index.ts` — we strip the
    // trailing `/index.ts` so the alias resolves to `packages/shared/src`.
    const jest = `
      moduleNameMapper: {
        '^@rebel/shared$': '<rootDir>/../packages/shared/src',
        '^@rebel/cloud-client$': '<rootDir>/../cloud-client/src',
        '^@shared/(.*)$': '<rootDir>/../src/shared/$1',
        '^@core/(.*)$': '<rootDir>/../src/core/$1',
      }
    `.replace(/<rootDir>/g, path.join(ROOT, 'mobile'));
    const result = runAliasCheck(
      ROOT,
      [configAt('mobile/jest.config.js', 'regex')],
      () => jest,
    );
    // Note: `$1` capture-groups in the jest regex keep the alias pointing at
    // the directory once stripWildcard() removes the placeholder.
    const violations = result.violations.filter((v) => v.found !== v.expected);
    expect(violations).toEqual([]);
  });
});

describe('F-R2-3 — per-section drift detection (extractAllRegexAliases)', () => {
  it('collects all occurrences of an alias across sections', () => {
    const text = `
      main: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/shared/src') } }
      },
      preload: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/shared/src') } }
      },
      renderer: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/shared/src') } }
      },
    `;
    const result = extractAllRegexAliases(text);
    expect(result['@rebel/shared']).toHaveLength(3);
    expect(result['@rebel/shared']!.every((t) => t === 'packages/shared/src')).toBe(true);
  });

  it('detects per-section drift when one section differs', () => {
    const text = `
      main: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/shared/src') } }
      },
      renderer: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/WRONG/src') } }
      },
    `;
    const result = runAliasCheck(
      ROOT,
      [configAt('electron.vite.config.ts', 'regex')],
      () => text,
    );
    // Should have at least one violation for the drifted occurrence.
    const driftViolations = result.violations.filter(
      (v) => v.alias === '@rebel/shared' && v.message.includes('per-section drift'),
    );
    expect(driftViolations.length).toBeGreaterThanOrEqual(1);
  });

  it('reports missing alias in only one section (first-wins still valid)', () => {
    // Only one occurrence — no drift, but runAliasCheck validates first occurrence.
    const text = `
      renderer: {
        resolve: { alias: { '@rebel/shared': resolve(__dirname, 'packages/shared/src') } }
      },
    `;
    const result = runAliasCheck(
      ROOT,
      [configAt('electron.vite.config.ts', 'regex', ['@rebel/shared'])],
      () => text,
    );
    expect(result.violations).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe('F-R2-3 — tsconfig extends chain resolution', () => {
  it('accepts required aliases inherited through extends', () => {
    const child = JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        paths: {
          '@core/*': ['./src/core/*'],
        },
      },
    });
    const base = JSON.stringify({
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/shared/src'],
        },
      },
    });
    const files: Record<string, string> = {
      [path.join(ROOT, 'tsconfig.renderer.json')]: child,
      [path.join(ROOT, 'tsconfig.base.json')]: base,
    };
    const result = runAliasCheck(
      ROOT,
      [configAt('tsconfig.renderer.json', 'tsconfig', ['@rebel/shared'])],
      (p) => files[p]!,
    );
    expect(result.violations).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('reports missing required aliases across the full extends chain', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { paths: {} },
    });
    const result = runAliasCheck(
      ROOT,
      [configAt('tsconfig.renderer.json', 'tsconfig', ['@rebel/shared'])],
      () => tsconfig,
    );
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.reason).toContain('extends chain');
  });

  it('flags wrong alias path from a child override even when extends is present', () => {
    const child = JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/WRONG/src'],
        },
      },
    });
    const base = JSON.stringify({
      compilerOptions: {
        paths: {
          '@rebel/shared': ['./packages/shared/src'],
        },
      },
    });
    const files: Record<string, string> = {
      [path.join(ROOT, 'tsconfig.renderer.json')]: child,
      [path.join(ROOT, 'tsconfig.base.json')]: base,
    };
    const result = runAliasCheck(
      ROOT,
      [configAt('tsconfig.renderer.json', 'tsconfig')],
      (p) => files[p]!,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.alias).toBe('@rebel/shared');
  });
});

/**
 * D20 Stage 5 regression coverage: `sectionedRequirements` catches the case
 * where an alias is present in the electron-vite `main` section but missing
 * from the `renderer` (or `preload`) section. This is the silent-failure
 * mode that broke `build:legacy` for the `@core/navigation` import before
 * the renderer-section alias was added. The flat `required` list cannot
 * catch it because `firstParsed` finds the alias in any section.
 *
 * Uses `kind: 'regex'` + the `sectionedRequirements` field; each section
 * is sliced independently and checked against its own required list.
 */
describe('sectionedRequirements — per-section alias drift detection', () => {
  const PATH = 'electron.vite.config.ts';
  const buildViteConfig = (opts: { coreInMain: boolean; coreInRenderer: boolean }) => `
    import { defineConfig } from 'electron-vite';
    export default defineConfig({
      main: {
        resolve: {
          alias: {
            ${opts.coreInMain ? "'@core': resolve(__dirname, 'src/core')," : ''}
            '@shared': resolve(__dirname, 'src/shared'),
            '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
          }
        }
      },
      preload: {
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
          }
        }
      },
      renderer: {
        resolve: {
          alias: {
            '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
            '@rebel/cloud-client': resolve(__dirname, 'cloud-client/src'),
            ${opts.coreInRenderer ? "'@core': resolve(__dirname, 'src/core')," : ''}
            '@shared': resolve(__dirname, 'src/shared'),
          }
        }
      }
    });
  `;

  const sectionedConfig: ConfigCheck = {
    file: path.join(ROOT, PATH),
    kind: 'regex',
    required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    sectionedRequirements: {
      main: ['@core', '@shared', '@rebel/shared'],
      preload: ['@shared', '@rebel/shared'],
      renderer: ['@core', '@shared', '@rebel/shared', '@rebel/cloud-client'],
    },
  };

  it('passes when @core is present in BOTH main and renderer sections (positive baseline)', () => {
    const text = buildViteConfig({ coreInMain: true, coreInRenderer: true });
    const result = runAliasCheck(ROOT, [sectionedConfig], () => text);
    expect(result.violations).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('FAILS with a renderer-specific missing-alias error when @core is absent from the renderer section', () => {
    // This is the exact pre-D20-Stage-5 regression: @core resolved in main (legacy build
    // traversed main first) but renderer-section imports of @core/navigation blew up at
    // Rollup resolve. The flat `required` list missed it because firstParsed['@core'] was
    // defined (from main). sectionedRequirements catches it.
    const text = buildViteConfig({ coreInMain: true, coreInRenderer: false });
    const result = runAliasCheck(ROOT, [sectionedConfig], () => text);
    expect(result.violations).toEqual([]);
    expect(result.missing.length).toBeGreaterThanOrEqual(1);
    const rendererCore = result.missing.find(
      (m) => m.alias === '@core' && /"renderer" section/.test(m.reason),
    );
    expect(rendererCore).toBeDefined();
    expect(rendererCore!.reason).toContain('electron.vite.config.ts');
    expect(rendererCore!.reason).toContain('D20 Stage 5');
  });

  it('also reports a main-section miss independently (symmetric coverage)', () => {
    const text = buildViteConfig({ coreInMain: false, coreInRenderer: true });
    const result = runAliasCheck(ROOT, [sectionedConfig], () => text);
    const mainCore = result.missing.find(
      (m) => m.alias === '@core' && /"main" section/.test(m.reason),
    );
    expect(mainCore).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Worker-build aliasPlugin attachment guard (prevention rec C31)
// 260529_build_worker_core_alias_missing had two facets: the @core alias was
// absent from the esbuild map AND aliasPlugin was attached only to the GPU
// builds, so Node worker builds silently resolved nothing. The alias-path
// checks above cover the map; these cover the plugin attachment.
// ---------------------------------------------------------------------------

describe('extractBuildCalls', () => {
  it('extracts each build({ ... }) object literal with an outfile label', () => {
    const text = `
      await build({ entryPoints: ['a.ts'], outfile: resolve(d, 'a.js'), plugins: [aliasPlugin] });
      await build({ entryPoints: ['b.ts'], outfile: resolve(d, 'b.js'), plugins: [aliasPlugin, other] });
    `;
    const calls = extractBuildCalls(text);
    expect(calls.map((c) => c.label)).toEqual(['a.js', 'b.js']);
    expect(calls.every((c) => /aliasPlugin/.test(c.body))).toBe(true);
  });

  it('does NOT match setup(build) { or build.onResolve({ ... }) inside the alias plugin', () => {
    // The alias plugin itself contains `setup(build) {` and `build.onResolve({...})`;
    // neither is a bundler build() call and must not be parsed as a target.
    const text = `
      const aliasPlugin = { name: 'alias', setup(build) { build.onResolve({ filter: /x/ }, () => ({})); } };
      await build({ outfile: resolve(d, 'real.js'), plugins: [aliasPlugin] });
    `;
    const calls = extractBuildCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.label).toBe('real.js');
  });
});

describe('checkWorkerBuildPluginAttachment', () => {
  const fakeFile = (text: string) => () => text;

  it('passes when every build target attaches aliasPlugin', () => {
    const text = `
      await build({ outfile: resolve(d, 'cpu.js'), plugins: [aliasPlugin] });
      await build({ outfile: resolve(d, 'gpu.js'), plugins: [aliasPlugin] });
    `;
    expect(checkWorkerBuildPluginAttachment(ROOT, fakeFile(text))).toEqual([]);
  });

  it('FAILS for a build target missing aliasPlugin (the original REBEL bug shape)', () => {
    // GPU builds keep the plugin; a Node worker build forgot it — exactly the
    // 260529_build_worker_core_alias_missing regression.
    const text = `
      await build({ outfile: resolve(d, 'embeddingWorker.js'), plugins: [] });
      await build({ outfile: resolve(d, 'gpuPreload.js'), plugins: [aliasPlugin] });
    `;
    const errors = checkWorkerBuildPluginAttachment(ROOT, fakeFile(text));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('embeddingWorker.js');
    expect(errors[0]).toContain('aliasPlugin');
  });

  it('flags parser drift when no build() calls are found', () => {
    const errors = checkWorkerBuildPluginAttachment(ROOT, fakeFile('// no build calls here'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no build\(/);
  });

  it('is fail-closed: a commented-out aliasPlugin does NOT satisfy the guard', () => {
    // Regression guard for the review finding: matching the bare token anywhere
    // in the body would let a plugin-less target pass on a stray comment.
    const text = `
      await build({ outfile: resolve(d, 'embeddingWorker.js'), plugins: [/* TODO: aliasPlugin */] });
    `;
    const errors = checkWorkerBuildPluginAttachment(ROOT, fakeFile(text));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('embeddingWorker.js');
  });

  it('passes against the real scripts/build-worker.mjs (integration baseline)', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    expect(checkWorkerBuildPluginAttachment(repoRoot)).toEqual([]);
  });
});

describe('pluginsArrayHasAliasPlugin (fail-closed plugins-array inspection)', () => {
  it('true when aliasPlugin is a member of the plugins array', () => {
    expect(pluginsArrayHasAliasPlugin("plugins: [aliasPlugin], minify: false")).toBe(true);
    expect(pluginsArrayHasAliasPlugin("plugins: [aliasPlugin, sentryPlugin]")).toBe(true);
  });

  it('false when there is no plugins array at all', () => {
    expect(pluginsArrayHasAliasPlugin("outfile: 'x.js', minify: false")).toBe(false);
  });

  it('false when the only aliasPlugin mention is a comment or string outside the array', () => {
    expect(pluginsArrayHasAliasPlugin("plugins: [], note: 'aliasPlugin' // aliasPlugin")).toBe(false);
    expect(pluginsArrayHasAliasPlugin("plugins: [ /* aliasPlugin */ ]")).toBe(false);
  });
});
