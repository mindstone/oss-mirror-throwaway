import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const outfile = path.join(__dirname, 'dist', 'rebel.js');
const outdir = path.dirname(outfile);
const cliPackageJsonPath = path.join(__dirname, 'package.json');
const cliPackageLockPath = path.join(__dirname, 'package-lock.json');
const superMcpPackageJson = require(path.join(projectRoot, 'super-mcp/package.json'));
const superMcpVersionGeneratedPath = path.join(projectRoot, 'src/core/services/superMcpVersion.generated.ts');

function readGeneratedSuperMcpRouterVersion() {
  const source = readFileSync(superMcpVersionGeneratedPath, 'utf8');
  const match = source.match(
    /export const GENERATED_SUPER_MCP_ROUTER_VERSION = ("(?:\\.|[^"\\])*") as const;/,
  );
  if (!match) {
    throw new Error(
      `Could not read GENERATED_SUPER_MCP_ROUTER_VERSION from ${path.relative(
        projectRoot,
        superMcpVersionGeneratedPath,
      )}. Run npm run generate:super-mcp-version.`,
    );
  }
  return JSON.parse(match[1]);
}

function getSuperMcpPinnedVersion() {
  if (superMcpPackageJson.name !== 'super-mcp-router') {
    throw new Error(`Expected super-mcp/package.json name to be "super-mcp-router", got ${JSON.stringify(superMcpPackageJson.name)}.`);
  }
  const generatedVersion = readGeneratedSuperMcpRouterVersion();
  if (superMcpPackageJson.version !== generatedVersion) {
    throw new Error(
      `super-mcp version drift: super-mcp/package.json has ${JSON.stringify(superMcpPackageJson.version)} ` +
        `but ${path.relative(projectRoot, superMcpVersionGeneratedPath)} has ${JSON.stringify(generatedVersion)}. ` +
        'Run npm run generate:super-mcp-version.',
    );
  }
  return generatedVersion;
}

function syncCliPackageVersion() {
  const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8'));
  if (cliPackageJson.version !== packageJson.version) {
    cliPackageJson.version = packageJson.version;
    writeFileSync(cliPackageJsonPath, `${JSON.stringify(cliPackageJson, null, 2)}\n`, 'utf8');
  }

  try {
    const cliPackageLock = JSON.parse(readFileSync(cliPackageLockPath, 'utf8'));
    let changed = false;
    if (cliPackageLock.version !== packageJson.version) {
      cliPackageLock.version = packageJson.version;
      changed = true;
    }
    if (cliPackageLock.packages?.['']?.version !== packageJson.version) {
      cliPackageLock.packages[''].version = packageJson.version;
      changed = true;
    }
    if (changed) {
      writeFileSync(cliPackageLockPath, `${JSON.stringify(cliPackageLock, null, 2)}\n`, 'utf8');
    }
  } catch {
    // package-lock.json is created in Stage 9 and validated separately. Keep the
    // build usable while the package is being bootstrapped.
  }
}

syncCliPackageVersion();

const metafileArgIndex = process.argv.indexOf('--metafile');
const metafilePath = metafileArgIndex >= 0 ? process.argv[metafileArgIndex + 1] : null;
const superMcpPinnedVersion = getSuperMcpPinnedVersion();

const electronImporters = new Set();
const guardElectronPlugin = {
  name: 'guard-electron',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, (args) => {
      electronImporters.add(args.importer);
      return { path: path.join(__dirname, 'electronStub.ts') };
    });
  },
};

const openRouterTokenStorageStubPath = path.join(__dirname, 'openRouterTokenStorageStub.ts');
const mainServicesDir = path.join(projectRoot, 'src/main/services');
const stubManagedTokenStoragePlugin = {
  name: 'stub-managed-token-storage',
  setup(buildApi) {
    buildApi.onResolve({ filter: /openRouterTokenStorage$/ }, (args) => {
      if (args.path === openRouterTokenStorageStubPath) return null;
      if (
        args.path === '@main/services/openRouterTokenStorage' ||
        args.path.endsWith('/src/main/services/openRouterTokenStorage')
      ) {
        return { path: openRouterTokenStorageStubPath };
      }
      if (args.path.startsWith('./') || args.path.startsWith('../')) {
        const resolved = path.resolve(path.dirname(args.importer), args.path);
        if (resolved === path.join(mainServicesDir, 'openRouterTokenStorage')) {
          return { path: openRouterTokenStorageStubPath };
        }
      }
      return null;
    });
  },
};

const result = await build({
  entryPoints: [path.join(__dirname, 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  metafile: Boolean(metafilePath),
  define: {
    '__REBEL_VERSION__': JSON.stringify(packageJson.version),
    'process.env.REBEL_SUPER_MCP_PINNED_VERSION': JSON.stringify(superMcpPinnedVersion),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      'const import_meta_url = import.meta.url;',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
      'const require = __createRequire(import.meta.url);',
      "if (process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') { try { require('graceful-fs').gracefulify(require('node:fs')); } catch {} }",
    ].join('\n'),
  },
  alias: {
    'electron-store': path.join(projectRoot, 'cloud-service/src/electronStoreShim.ts'),
    '@sentry/electron/main': path.join(projectRoot, 'cloud-service/src/sentryShim.ts'),
    '@sentry/electron': path.join(projectRoot, 'cloud-service/src/sentryShim.ts'),
    '@sentry/core': path.join(projectRoot, 'cloud-service/src/sentryShim.ts'),
    '@rebel/cloud-client/cloudClient': path.join(projectRoot, 'cloud-client/src/cloudClient.ts'),
    '@rebel/cloud-client': path.join(projectRoot, 'cloud-client/src/index.ts'),
    '@rebel/shared': path.join(projectRoot, 'packages/shared/src'),
    '@core': path.join(projectRoot, 'src/core'),
    '@shared': path.join(projectRoot, 'src/shared'),
    '@main': path.join(projectRoot, 'src/main'),
  },
  external: [
    '@sentry/node',
    'fsevents',
    '@lancedb/lancedb',
    '@huggingface/transformers',
    'onnxruntime-node',
    'apache-arrow',
    '@recallai/desktop-sdk',
    'win-ca',
    'electron-updater',
    'sherpa-onnx-node',
  ],
  plugins: [guardElectronPlugin, stubManagedTokenStoragePlugin],
  loader: {
    '.json': 'json',
  },
  logLevel: 'warning',
});

mkdirSync(outdir, { recursive: true });
writeFileSync(path.join(outdir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
chmodSync(outfile, 0o755);
if (metafilePath && result.metafile) {
  writeFileSync(path.resolve(projectRoot, metafilePath), JSON.stringify(result.metafile, null, 2), 'utf8');
}

if (electronImporters.size > 0) {
  console.warn(`Standalone CLI build stubbed ${electronImporters.size} electron importer(s).`);
}
console.log(`Standalone Rebel CLI built → ${path.relative(projectRoot, outfile)}`);
