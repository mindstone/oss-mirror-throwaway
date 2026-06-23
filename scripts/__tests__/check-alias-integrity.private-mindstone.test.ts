import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPrivateMindstoneAliasParity } from '../check-alias-integrity';

const ROOT = '/virtual/repo';

function repoPath(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

const passingTsconfig = JSON.stringify({
  compilerOptions: {
    paths: {
      '@private/mindstone/*': [
        './private/mindstone/src/*',
        './src/main/oss/private-mindstone-stub/*',
      ],
    },
  },
});

function privateMindstoneConfig(options: {
  includeAlias?: boolean;
  reverseOrder?: boolean;
  pathApi?: 'resolve' | 'path.resolve';
} = {}): string {
  const includeAlias = options.includeAlias ?? true;
  const pathApi = options.pathApi ?? 'resolve';
  const privateTarget = `${pathApi}(__dirname, 'private/mindstone/src')`;
  const stubTarget = `${pathApi}(__dirname, 'src/main/oss/private-mindstone-stub')`;
  const truthy = options.reverseOrder ? stubTarget : privateTarget;
  const falsy = options.reverseOrder ? privateTarget : stubTarget;

  return `
    const privateMindstoneBootstrapPath = ${pathApi}(__dirname, 'private/mindstone/src/bootstrap.ts');
    const privateMindstoneAliasTarget = existsSync(privateMindstoneBootstrapPath)
      ? ${truthy}
      : ${falsy};

    export default defineConfig({
      resolve: {
        alias: {
          ${includeAlias ? "'@private/mindstone': privateMindstoneAliasTarget," : ''}
        },
      },
    });
  `;
}

function electronViteConfig(options: {
  includeAlias?: boolean;
  reverseOrder?: boolean;
  includeOssDefine?: boolean;
  defineOutsideRenderer?: boolean;
} = {}): string {
  const includeAlias = options.includeAlias ?? true;
  const includeOssDefine = options.includeOssDefine ?? true;
  const privateTarget = "resolve(__dirname, 'private/mindstone/src')";
  const stubTarget = "resolve(__dirname, 'src/main/oss/private-mindstone-stub')";
  const truthy = options.reverseOrder ? stubTarget : privateTarget;
  const falsy = options.reverseOrder ? privateTarget : stubTarget;
  const rendererDefine = includeOssDefine && !options.defineOutsideRenderer
    ? 'define: { __REBEL_IS_OSS__: JSON.stringify(isOssBuild) },'
    : '';
  const topLevelDefine = includeOssDefine && options.defineOutsideRenderer
    ? 'define: { __REBEL_IS_OSS__: JSON.stringify(isOssBuild) },'
    : '';

  return `
    const privateMindstoneBootstrapPath = resolve(__dirname, 'private/mindstone/src/bootstrap.ts');
    const privateMindstoneAliasTarget = existsSync(privateMindstoneBootstrapPath)
      ? ${truthy}
      : ${falsy};
    const isOssBuild = !existsSync(privateMindstoneBootstrapPath);

    export default defineConfig({
      ${topLevelDefine}
      main: {
        resolve: {
          alias: {
            ${includeAlias ? "'@private/mindstone': privateMindstoneAliasTarget," : ''}
          },
        },
      },
      preload: {},
      renderer: {
        ${rendererDefine}
      },
    });
  `;
}

// Renderer configs (vite.renderer.config.mjs) are only checked for the
// __REBEL_IS_OSS__ define parity, not the alias ternary — they don't alias
// @private/mindstone (renderer never imports the main-only module).
function rendererConfig(options: { includeOssDefine?: boolean } = {}): string {
  const includeOssDefine = options.includeOssDefine ?? true;
  return `
    const privateMindstoneBootstrapPath = resolve(projectRoot, 'private/mindstone/src/bootstrap.ts');
    ${includeOssDefine ? 'const isOssBuild = !existsSync(privateMindstoneBootstrapPath);' : ''}

    export default defineConfig({
      ${includeOssDefine ? 'define: { __REBEL_IS_OSS__: JSON.stringify(isOssBuild) },' : ''}
    });
  `;
}

function readFileWith(overrides: Record<string, string>): (filePath: string) => string {
  const files: Record<string, string> = {
    [repoPath('vite.main.config.mjs')]: privateMindstoneConfig(),
    [repoPath('electron.vite.config.ts')]: electronViteConfig(),
    [repoPath('vitest.config.ts')]: privateMindstoneConfig({ pathApi: 'path.resolve' }),
    [repoPath('vite.renderer.config.mjs')]: rendererConfig(),
    [repoPath('tsconfig.json')]: passingTsconfig,
    [repoPath('tsconfig.node.json')]: passingTsconfig,
    ...overrides,
  };

  return (filePath: string) => {
    const file = files[filePath];
    if (file === undefined) {
      throw new Error(`Unexpected read: ${filePath}`);
    }
    return file;
  };
}

describe('checkPrivateMindstoneAliasParity', () => {
  it('passes when Vite, electron-vite, and Vitest configs use private-then-stub fall-through', () => {
    const errors = checkPrivateMindstoneAliasParity(ROOT, readFileWith({}));

    expect(errors).toEqual([]);
  });

  it('fails when a Vite config reverses the private/stub ternary order', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('electron.vite.config.ts')]: electronViteConfig({ reverseOrder: true }),
      }),
    );

    expect(errors).toEqual([
      expect.stringContaining('electron.vite.config.ts: privateMindstoneAliasTarget fall-through order is wrong'),
    ]);
  });

  it('fails when a Vite config is missing the @private/mindstone alias entry', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('vite.main.config.mjs')]: privateMindstoneConfig({ includeAlias: false }),
      }),
    );

    expect(errors).toEqual([
      expect.stringContaining('vite.main.config.mjs: does not expose @private/mindstone through privateMindstoneAliasTarget'),
    ]);
  });

  it('applies the same private-then-stub order check to vitest.config.ts', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('vitest.config.ts')]: privateMindstoneConfig({
          pathApi: 'path.resolve',
          reverseOrder: true,
        }),
      }),
    );

    expect(errors).toEqual([
      expect.stringContaining('vitest.config.ts: privateMindstoneAliasTarget fall-through order is wrong'),
    ]);
  });

  it('passes when both renderer configs define __REBEL_IS_OSS__ from the existsSync check', () => {
    const errors = checkPrivateMindstoneAliasParity(ROOT, readFileWith({}));
    expect(errors).toEqual([]);
  });

  it('fails when vite.renderer.config.mjs is missing the __REBEL_IS_OSS__ define', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('vite.renderer.config.mjs')]: rendererConfig({ includeOssDefine: false }),
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        'vite.renderer.config.mjs: does not compute `const isOssBuild = !existsSync(privateMindstoneBootstrapPath)`',
      ),
      expect.stringContaining(
        'vite.renderer.config.mjs: does not expose `__REBEL_IS_OSS__: JSON.stringify(isOssBuild)`',
      ),
    ]);
  });

  it('fails when electron.vite.config.ts is missing the __REBEL_IS_OSS__ define', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('electron.vite.config.ts')]: electronViteConfig({ includeOssDefine: false }),
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        'electron.vite.config.ts: does not expose `__REBEL_IS_OSS__: JSON.stringify(isOssBuild)` inside the renderer config block',
      ),
    ]);
  });

  it('fails when electron.vite.config.ts defines __REBEL_IS_OSS__ outside the renderer block only', () => {
    const errors = checkPrivateMindstoneAliasParity(
      ROOT,
      readFileWith({
        [repoPath('electron.vite.config.ts')]: electronViteConfig({ defineOutsideRenderer: true }),
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        'electron.vite.config.ts: does not expose `__REBEL_IS_OSS__: JSON.stringify(isOssBuild)` inside the renderer config block',
      ),
    ]);
  });
});
