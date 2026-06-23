import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRendererSingletonDedupe,
  loadRendererSingletonDeps,
} from '../check-alias-integrity';

const REPO_ROOT = path.resolve(__dirname, '../..');

function configPath(rel: string): string {
  return path.join(REPO_ROOT, rel);
}

/**
 * Fake `readFile` that returns an explicit fixture when one is provided and
 * otherwise returns a benign passing-config default. This lets individual
 * tests focus on ONE or TWO target files while ignoring the rest of
 * `RENDERER_DEDUPE_TARGETS` (storybook, web-companion, vitest) without
 * having to enumerate passing mocks for them.
 *
 * The default fixture must:
 *   - include a `dedupe: [...RENDERER_SINGLETON_DEPS]` spread so the target
 *     passes regardless of which scope it declares;
 *   - include every anchor token used by RENDERER_DEDUPE_TARGETS so anchored
 *     targets (storybook's `viteFinal(`, vitest's `name: 'desktop'`) still
 *     find a valid slice.
 */
const PASSING_DEFAULT_FIXTURE = `
  // Default passing fixture used by check-alias-integrity.dedupe tests when
  // a specific RENDERER_DEDUPE_TARGETS entry is not the focus of the test.
  viteFinal() {
    return {
      resolve: {
        name: 'desktop',
        renderer: {
          dedupe: [...RENDERER_SINGLETON_DEPS],
        },
        dedupe: [...RENDERER_SINGLETON_DEPS],
      },
    };
  }
`;

function createReadFile(files: Record<string, string>): (filePath: string) => string {
  return (filePath: string) => {
    const file = files[filePath];
    if (file === undefined) {
      return PASSING_DEFAULT_FIXTURE;
    }
    return file;
  };
}

function renderLiteralDedupe(singletonDeps: readonly string[]): string {
  return singletonDeps.map((dep) => `'${dep}'`).join(', ');
}

describe('checkRendererSingletonDedupe', () => {
  it('passes when global config uses literal entries and renderer config uses a spread + literal mix', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            dedupe: [${renderLiteralDedupe(singletonDeps)}],
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          renderer: {
            resolve: {
              dedupe: ['scheduler', ...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([]);
  });

  it('fails when a singleton dep is missing from one config', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const missingDep = singletonDeps[singletonDeps.length - 1]!;
    const remainingDeps = singletonDeps.filter((dep) => dep !== missingDep);
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            dedupe: [${renderLiteralDedupe(remainingDeps)}],
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          renderer: {
            resolve: {
              dedupe: [...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vite.renderer.config.mjs');
    expect(errors[0]).toContain(missingDep);
  });

  it('fails when the dedupe array is absent', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            alias: {
              '@shared': '${configPath('src/shared')}',
            },
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          renderer: {
            resolve: {
              dedupe: [...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([
      'vite.renderer.config.mjs is missing renderer resolve.dedupe: [...].',
    ]);
  });

  it('fails when the renderer scope is missing even if another section defines dedupe', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            dedupe: [...RENDERER_SINGLETON_DEPS],
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          main: {
            resolve: {
              dedupe: [...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([
      'electron.vite.config.ts is missing renderer resolve.dedupe: [...].',
    ]);
  });

  it('fails when the only dedupe array in scope is commented out (// line comment)', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            // dedupe: [${renderLiteralDedupe(singletonDeps)}],
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          renderer: {
            resolve: {
              dedupe: [...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vite.renderer.config.mjs');
    expect(errors[0]).toContain('missing renderer resolve.dedupe');
  });

  it('fails when the only dedupe array in scope is inside a /* block comment */', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            /*
              dedupe: [${renderLiteralDedupe(singletonDeps)}],
            */
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          renderer: {
            resolve: {
              dedupe: [...RENDERER_SINGLETON_DEPS],
            },
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vite.renderer.config.mjs');
    expect(errors[0]).toContain('missing renderer resolve.dedupe');
  });

  it('fails when only a commented-out renderer scope appears in electron.vite.config.ts', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vite.renderer.config.mjs')]: `
        export default defineConfig({
          resolve: {
            dedupe: [...RENDERER_SINGLETON_DEPS],
          },
        });
      `,
      [configPath('electron.vite.config.ts')]: `
        export default defineConfig({
          // renderer: {
          //   resolve: {
          //     dedupe: [${renderLiteralDedupe(singletonDeps)}],
          //   },
          // },
          main: {
            resolve: {},
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('electron.vite.config.ts');
    expect(errors[0]).toContain('missing renderer resolve.dedupe');
  });

  it('passes against the real repo configs using the actual singleton deps module', async () => {
    const singletonDeps = await loadRendererSingletonDeps();

    expect(singletonDeps).toContain('react');
    expect(singletonDeps).toContain('react-dom');
    expect(singletonDeps).toContain('react/jsx-runtime');
    expect(singletonDeps).toContain('react/jsx-dev-runtime');
    expect(singletonDeps).toContain('zustand');

    const errors = checkRendererSingletonDedupe(REPO_ROOT, singletonDeps);

    expect(errors).toEqual([]);
  });

  // ---- Stage 3 additions: anchored targets + extended config shapes ----

  it('passes when .storybook/main.ts uses ...RENDERER_SINGLETON_DEPS inside viteFinal', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('.storybook/main.ts')]: `
        const config = {
          async viteFinal(baseConfig) {
            return mergeConfig(baseConfig, {
              resolve: {
                dedupe: [...RENDERER_SINGLETON_DEPS],
              },
            });
          },
        };
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([]);
  });

  it('fails when .storybook/main.ts dedupe is missing a singleton dep', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const missingDep = singletonDeps[singletonDeps.length - 1]!;
    const remainingDeps = singletonDeps.filter((dep) => dep !== missingDep);
    const files = {
      [configPath('.storybook/main.ts')]: `
        const config = {
          async viteFinal(baseConfig) {
            return mergeConfig(baseConfig, {
              resolve: {
                dedupe: [${renderLiteralDedupe(remainingDeps)}],
              },
            });
          },
        };
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.storybook/main.ts');
    expect(errors[0]).toContain(missingDep);
  });

  it('ignores a decoy // viteFinal comment that appears BEFORE the real viteFinal( call in .storybook/main.ts', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    // Decoy comment mentions `viteFinal` but the real callback comes later
    // with a valid spread dedupe. The string-aware comment stripper removes
    // the comment before the anchor regex runs.
    const files = {
      [configPath('.storybook/main.ts')]: `
        // NOTE: we used to call viteFinal here without dedupe — see below.
        const config = {
          async viteFinal(baseConfig) {
            return mergeConfig(baseConfig, {
              resolve: {
                dedupe: [...RENDERER_SINGLETON_DEPS],
              },
            });
          },
        };
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([]);
  });

  it('passes when vitest.config.ts desktop project uses ...RENDERER_SINGLETON_DEPS (single-quoted)', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('vitest.config.ts')]: `
        export default defineConfig({
          test: {
            projects: [
              {
                test: { name: 'cloud-service' },
                resolve: { dedupe: ['react'] },
              },
              {
                test: { name: 'desktop' },
                resolve: {
                  dedupe: [...RENDERER_SINGLETON_DEPS],
                },
              },
            ],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([]);
  });

  it('fails when vitest.config.ts desktop project dedupe is missing a singleton dep', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const missingDep = singletonDeps[0]!;
    const remainingDeps = singletonDeps.filter((dep) => dep !== missingDep);
    const files = {
      [configPath('vitest.config.ts')]: `
        export default defineConfig({
          test: {
            projects: [
              {
                test: { name: 'desktop' },
                resolve: {
                  dedupe: [${renderLiteralDedupe(remainingDeps)}],
                },
              },
            ],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vitest.config.ts');
    expect(errors[0]).toContain(missingDep);
  });

  it('scope-isolates the vitest desktop project with a double-quoted name and a sibling project that looks fine', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    // cloud-service project has a complete dedupe but is ordered BEFORE the
    // desktop project. The anchor must skip past it to validate desktop.
    const files = {
      [configPath('vitest.config.ts')]: `
        export default defineConfig({
          test: {
            projects: [
              {
                test: { name: 'cloud-service' },
                resolve: { dedupe: [${renderLiteralDedupe(singletonDeps)}] },
              },
              {
                test: { name: "desktop" },
                resolve: {
                  dedupe: ['react', 'react-dom'],
                },
              },
            ],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vitest.config.ts');
    // Must cite a dep missing from the desktop slice, not the complete cloud-service slice.
    expect(errors[0]).toContain('zustand');
  });

  it('FAILS if the vitest desktop project LOSES its dedupe but a later project gains one (endAnchor bounding)', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    // Regression guard: a future edit drops `dedupe:` from the desktop
    // project, while a later project (e.g. mcp) accidentally gains a
    // complete one. Without endAnchor bounding, the validator would slice
    // from `name: 'desktop'` to EOF and incorrectly read the mcp project's
    // dedupe, false-passing. With endAnchor = /name:\s*['"][^'"]+['"]/,
    // the slice stops at `name: 'mcp'` and the validator must fail.
    const files = {
      [configPath('vitest.config.ts')]: `
        export default defineConfig({
          test: {
            projects: [
              {
                test: { name: 'desktop' },
                resolve: {
                  alias: {},
                  // no dedupe here — regression
                },
              },
              {
                test: { name: 'mcp' },
                resolve: {
                  dedupe: [${renderLiteralDedupe(singletonDeps)}],
                },
              },
            ],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vitest.config.ts');
    expect(errors[0]).toContain('missing renderer resolve.dedupe');
  });

  it('fails loudly when an anchored target file is missing the anchor token entirely', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    // vitest.config.ts with the desktop project renamed — anchor cannot be found.
    const files = {
      [configPath('vitest.config.ts')]: `
        export default defineConfig({
          test: {
            projects: [
              {
                test: { name: 'electron-renderer' },
                resolve: { dedupe: [...RENDERER_SINGLETON_DEPS] },
              },
            ],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vitest.config.ts');
    expect(errors[0]).toContain('renderer dedupe anchor not found');
  });

  it('passes when web-companion/vite.config.ts uses ...RENDERER_SINGLETON_DEPS', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const files = {
      [configPath('web-companion/vite.config.ts')]: `
        export default defineConfig({
          resolve: {
            alias: {},
            dedupe: [...RENDERER_SINGLETON_DEPS],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toEqual([]);
  });

  it('fails when web-companion/vite.config.ts dedupe is missing a singleton dep', async () => {
    const singletonDeps = await loadRendererSingletonDeps();
    const missingDep = singletonDeps[2]!;
    const remainingDeps = singletonDeps.filter((dep) => dep !== missingDep);
    const files = {
      [configPath('web-companion/vite.config.ts')]: `
        export default defineConfig({
          resolve: {
            dedupe: [${renderLiteralDedupe(remainingDeps)}],
          },
        });
      `,
    };

    const errors = checkRendererSingletonDedupe(
      REPO_ROOT,
      singletonDeps,
      createReadFile(files),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('web-companion/vite.config.ts');
    expect(errors[0]).toContain(missingDep);
  });
});
