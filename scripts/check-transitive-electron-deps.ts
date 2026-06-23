#!/usr/bin/env npx tsx
/**
 * CI Validation: transitive Electron dependency guard.
 *
 * Scans arbitrary entrypoints and fails if any runtime import graph path
 * (direct or transitive) pulls in `electron` or `electron-store`, except for
 * explicit per-entrypoint exemptions.
 */

import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

export interface EntrypointConfig {
  entrypoint: string;
  exemptFiles?: string[];
}

export interface RuntimeReference {
  specifier: string;
  kind: 'import' | 'export' | 'dynamic-import' | 'require';
  isTypeOnly: boolean;
}

export interface TransitiveElectronViolation {
  entrypoint: string;
  file: string;
  specifier: 'electron' | 'electron-store';
  kind: RuntimeReference['kind'];
  viaPath: string[];
}

export interface ScanResult {
  scannedEntrypoints: string[];
  violations: TransitiveElectronViolation[];
}

const REPO_ROOT = path.join(__dirname, '..');

const HEADLESS_RUNTIME_DEFERRED_ELECTRON_DEPS = [
  'src/main/services/appBridgeInstallerService.ts',
  'src/main/services/spaceMaintenanceAdapter.ts',
  'src/core/services/settingsStore/index.ts',
  'src/main/services/slackAuthService.ts',
  'src/main/services/microsoftAuthService.ts',
  'src/main/services/salesforceAuthService.ts',
  'src/main/services/authService.ts',
  'src/main/services/meetingBot/meetingBotService.ts',
  'src/main/services/googleWorkspaceAuthService.ts',
  'src/main/services/hubspotAuthService.ts',
  'src/main/services/hubspotCredentialLock.ts',
  'src/main/services/hubspotTelemetry.ts',
  'src/main/services/embeddingService.ts',
  'src/main/services/meetingBot/desktopSdkService.ts',
  'src/main/services/gpuEmbeddingBackend.ts',
];

const AGENT_TURN_EXECUTOR_DEFERRED_ELECTRON_DEPS = [
  'src/core/services/settingsStore/index.ts',
  'src/main/services/authService.ts',
  'src/main/services/hubspotAuthService.ts',
  'src/main/services/hubspotCredentialLock.ts',
  'src/main/services/hubspotTelemetry.ts',
];

export const DEFAULT_ENTRYPOINTS: ReadonlyArray<EntrypointConfig> = [
  {
    entrypoint: 'src/core/services/headlessRuntime.ts',
    exemptFiles: [
      'src/core/lazyElectron.ts',
      // Existing runtime-detachment debt surfaced once eval direct-tsx support
      // added root path aliases. Keep this explicit and entrypoint-scoped so
      // new transitive Electron imports still fail the gate.
      ...HEADLESS_RUNTIME_DEFERRED_ELECTRON_DEPS,
    ],
  },
  {
    entrypoint: 'src/core/services/agentTurnService.ts',
    exemptFiles: ['src/core/lazyElectron.ts'],
  },
  {
    entrypoint: 'src/main/services/agentTurnExecutor.ts',
    exemptFiles: AGENT_TURN_EXECUTOR_DEFERRED_ELECTRON_DEPS,
  },
];

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function makeTsProgram(repoRoot: string): {
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  cache: ts.ModuleResolutionCache;
} {
  const tsconfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) {
    throw new Error('Could not find tsconfig.json');
  }
  const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (tsconfig.error) {
    throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, repoRoot, undefined, tsconfigPath);
  const host = ts.createCompilerHost(parsed.options, true);
  const cache = ts.createModuleResolutionCache(
    repoRoot,
    (fileName) => normalisePath(fileName),
    parsed.options,
  );
  return { options: parsed.options, host, cache };
}

function readSourceFile(filePath: string): ts.SourceFile | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
}

export function collectRuntimeReferences(sourceFile: ts.SourceFile): RuntimeReference[] {
  const refs: RuntimeReference[] = [];
  const addRef = (ref: RuntimeReference): void => {
    refs.push(ref);
  };

  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addRef({
        specifier: node.moduleSpecifier.text,
        kind: 'import',
        isTypeOnly: Boolean(node.importClause?.isTypeOnly),
      });
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addRef({
        specifier: node.moduleSpecifier.text,
        kind: 'export',
        isTypeOnly: Boolean(node.isTypeOnly),
      });
    }
  });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          addRef({
            specifier: arg.text,
            kind: 'dynamic-import',
            isTypeOnly: false,
          });
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          addRef({
            specifier: arg.text,
            kind: 'require',
            isTypeOnly: false,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return refs.filter((ref) => !ref.isTypeOnly);
}

function resolveInternalDependency(params: {
  specifier: string;
  containingFile: string;
  repoRoot: string;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  cache: ts.ModuleResolutionCache;
}): string | null {
  const { specifier, containingFile, repoRoot, options, host, cache } = params;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    cache,
  ).resolvedModule;

  if (!resolved) return null;
  if (resolved.isExternalLibraryImport) return null;

  const absolute = path.normalize(resolved.resolvedFileName);
  if (!absolute.startsWith(path.normalize(repoRoot))) return null;
  if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return null;
  return absolute;
}

export function scanTransitiveElectronDeps(params: {
  repoRoot: string;
  entrypoints: ReadonlyArray<EntrypointConfig>;
}): ScanResult {
  const { repoRoot, entrypoints } = params;
  const { options, host, cache } = makeTsProgram(repoRoot);

  const violations: TransitiveElectronViolation[] = [];
  const scannedEntrypoints: string[] = [];

  for (const entry of entrypoints) {
    const entryRel = normalisePath(entry.entrypoint);
    const entryAbs = path.resolve(repoRoot, entryRel);
    if (!fs.existsSync(entryAbs)) {
      throw new Error(`Entrypoint does not exist: ${entryRel}`);
    }

    scannedEntrypoints.push(entryRel);
    const exempt = new Set((entry.exemptFiles ?? []).map(normalisePath));

    const queue: string[] = [entryAbs];
    const seen = new Set<string>();
    const parent = new Map<string, string | null>([[entryAbs, null]]);
    const refsByFile = new Map<string, RuntimeReference[]>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (seen.has(current)) continue;
      seen.add(current);

      const sourceFile = readSourceFile(current);
      if (!sourceFile) {
        refsByFile.set(current, []);
        continue;
      }

      const refs = collectRuntimeReferences(sourceFile);
      refsByFile.set(current, refs);

      for (const ref of refs) {
        const resolved = resolveInternalDependency({
          specifier: ref.specifier,
          containingFile: current,
          repoRoot,
          options,
          host,
          cache,
        });
        if (!resolved) continue;
        if (!parent.has(resolved)) parent.set(resolved, current);
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }

    for (const [fileAbs, refs] of refsByFile.entries()) {
      const fileRel = normalisePath(path.relative(repoRoot, fileAbs));
      if (exempt.has(fileRel)) continue;

      for (const ref of refs) {
        if (ref.specifier !== 'electron' && ref.specifier !== 'electron-store') continue;

        const viaPath: string[] = [];
        let cursor: string | null | undefined = fileAbs;
        while (cursor) {
          viaPath.push(normalisePath(path.relative(repoRoot, cursor)));
          cursor = parent.get(cursor) ?? null;
        }
        viaPath.reverse();

        violations.push({
          entrypoint: entryRel,
          file: fileRel,
          specifier: ref.specifier,
          kind: ref.kind,
          viaPath,
        });
      }
    }
  }

  return { scannedEntrypoints, violations };
}

function parseArgs(args: readonly string[]): EntrypointConfig[] {
  const explicitEntries: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entry' && args[i + 1]) {
      explicitEntries.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--entry=')) {
      explicitEntries.push(arg.slice('--entry='.length));
      continue;
    }
    if (!arg.startsWith('--')) {
      explicitEntries.push(arg);
    }
  }

  if (explicitEntries.length === 0) {
    return [...DEFAULT_ENTRYPOINTS];
  }

  return explicitEntries.map((entrypoint) => ({ entrypoint, exemptFiles: [] }));
}

if (!process.env.VITEST) {
  const entrypoints = parseArgs(process.argv.slice(2));
  const result = scanTransitiveElectronDeps({
    repoRoot: REPO_ROOT,
    entrypoints,
  });

  if (result.violations.length > 0) {
    console.error(
      `✗ Found ${result.violations.length} transitive electron/electron-store dependency violation(s):\n`,
    );
    for (const v of result.violations) {
      console.error(
        `  entry: ${v.entrypoint}\n` +
          `  file:  ${v.file}\n` +
          `  ref:   ${v.kind}('${v.specifier}')\n` +
          `  path:  ${v.viaPath.join(' -> ')}\n`,
      );
    }
    console.error(
      'Entrypoints checked by this gate must be runtime-detached from Electron/electron-store.\n' +
        'If a dependency is intentionally deferred, add a narrow file exemption for that entrypoint.',
    );
    process.exit(1);
  }

  console.log(
    `✓ Checked ${result.scannedEntrypoints.length} entrypoint(s): no transitive electron/electron-store runtime dependencies found.`,
  );
}
