import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanTransitiveElectronDeps } from '../check-transitive-electron-deps';

const tmpDirs: string[] = [];

function makeTempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transitive-electron-check-'));
  tmpDirs.push(root);

  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'node',
        allowSyntheticDefaultImports: true,
      },
      include: ['src/**/*'],
    }),
    'utf8',
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }

  return root;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('scanTransitiveElectronDeps', () => {
  it('fails when an entrypoint transitively imports electron', () => {
    const repoRoot = makeTempRepo({
      'src/entry.ts': `import './a';\n`,
      'src/a.ts': `import { app } from 'electron';\nexport const x = app;\n`,
    });

    const result = scanTransitiveElectronDeps({
      repoRoot,
      entrypoints: [{ entrypoint: 'src/entry.ts' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.file).toBe('src/a.ts');
    expect(result.violations[0]?.specifier).toBe('electron');
  });

  it('passes when no transitive electron/electron-store import exists', () => {
    const repoRoot = makeTempRepo({
      'src/entry.ts': `import { x } from './a';\nexport const value = x;\n`,
      'src/a.ts': `import { y } from './b';\nexport const x = y;\n`,
      'src/b.ts': `export const y = 42;\n`,
    });

    const result = scanTransitiveElectronDeps({
      repoRoot,
      entrypoints: [{ entrypoint: 'src/entry.ts' }],
    });

    expect(result.violations).toEqual([]);
  });

  it('supports per-entrypoint exemption files', () => {
    const repoRoot = makeTempRepo({
      'src/entry.ts': `import './a';\n`,
      'src/a.ts': `import Store from 'electron-store';\nexport default Store;\n`,
    });

    const result = scanTransitiveElectronDeps({
      repoRoot,
      entrypoints: [{ entrypoint: 'src/entry.ts', exemptFiles: ['src/a.ts'] }],
    });

    expect(result.violations).toEqual([]);
  });
});
