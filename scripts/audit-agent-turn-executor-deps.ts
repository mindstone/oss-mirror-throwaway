#!/usr/bin/env npx tsx
/**
 * Stage 2.E.0.a — agentTurnExecutor dependency-closure audit.
 *
 * Walks the runtime import graph (direct + transitive) for
 * `src/main/services/agentTurnExecutor.ts`, classifies closure leaves, and
 * writes:
 *   - machine-readable JSON summary
 *   - human-readable markdown report
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type LeafClassification = 'pure' | 'needs_new_boundary' | 'genuinely_electron_bound';

export interface RuntimeReference {
  specifier: string;
  kind: 'import' | 'export' | 'dynamic-import' | 'require';
  isTypeOnly: boolean;
}

export interface ModuleAuditNode {
  file: string;
  runtimeReferences: RuntimeReference[];
  internalDependencies: string[];
  runtimeElectronReferences: RuntimeReference[];
  isLeaf: boolean;
  classification: LeafClassification;
  boundaryHint: string | null;
}

export interface DependencyAuditReport {
  generatedAt: string;
  entrypoint: string;
  moduleCount: number;
  leafCount: number;
  leafClassificationCounts: Record<LeafClassification, number>;
  closureClassificationCounts: Record<LeafClassification, number>;
  electronTouchingModuleCount: number;
  nodes: ModuleAuditNode[];
  electronTouchingModules: Array<{
    file: string;
    classification: LeafClassification;
    boundaryHint: string | null;
    viaPath: string[];
    references: RuntimeReference[];
  }>;
}

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_ENTRYPOINT = 'src/main/services/agentTurnExecutor.ts';
const DEFAULT_JSON_OUTPUT = 'docs/plans/260516_agent_turn_executor_dependency_closure.json';
const DEFAULT_MARKDOWN_OUTPUT = 'docs/plans/260516_agent_turn_executor_dependency_closure.md';

/**
 * Initial boundary hints for Stage 2.E.0.
 * Additional leaves discovered by the audit can be reclassified in follow-up.
 */
const BOUNDARY_HINTS = new Map<string, string>([
  ['src/main/services/powerSaveBlockerService.ts', 'PowerSaveBlocker'],
  ['src/main/services/preTurnWorkerService.ts', 'PreTurnWorker'],
  ['src/main/services/desktopNotificationService.ts', 'DesktopNotificationSink'],
  ['src/main/services/dockBadgeService.ts', 'DockBadgeSink'],
  ['src/main/services/authService.ts', 'CurrentUserProvider'],
  ['src/main/services/embeddingService.ts', 'EmbeddingGenerator'],
  ['src/main/services/gpuEmbeddingBackend.ts', 'EmbeddingGenerator'],
]);

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function makeTsProgram(repoRoot: string): {
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  resolutionCache: ts.ModuleResolutionCache;
} {
  const tsconfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) {
    throw new Error('Could not find tsconfig.json');
  }

  const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (tsconfig.error) {
    throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(
    tsconfig.config,
    ts.sys,
    repoRoot,
    undefined,
    tsconfigPath,
  );

  const host = ts.createCompilerHost(parsed.options, true);
  const resolutionCache = ts.createModuleResolutionCache(
    repoRoot,
    (fileName) => normalisePath(fileName),
    parsed.options,
  );

  return { options: parsed.options, host, resolutionCache };
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
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  resolutionCache: ts.ModuleResolutionCache;
  repoRoot: string;
}): string | null {
  const { specifier, containingFile, options, host, resolutionCache, repoRoot } = params;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    resolutionCache,
  ).resolvedModule;

  if (!resolved) return null;
  if (resolved.isExternalLibraryImport) return null;

  const absolute = path.normalize(resolved.resolvedFileName);
  const repoRootNormalised = path.normalize(repoRoot);
  if (!absolute.startsWith(repoRootNormalised)) return null;
  if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return null;

  return absolute;
}

function classifyNode(params: {
  relativePath: string;
  runtimeElectronReferences: RuntimeReference[];
  isLeaf: boolean;
}): { classification: LeafClassification; boundaryHint: string | null } {
  const { relativePath, runtimeElectronReferences } = params;
  if (runtimeElectronReferences.length === 0) {
    return { classification: 'pure', boundaryHint: null };
  }

  const boundaryHint = BOUNDARY_HINTS.get(relativePath) ?? null;
  if (boundaryHint) {
    return { classification: 'needs_new_boundary', boundaryHint };
  }

  return { classification: 'genuinely_electron_bound', boundaryHint: null };
}

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildDependencyAuditReport(params: {
  repoRoot: string;
  entrypoint: string;
}): DependencyAuditReport {
  const { repoRoot } = params;
  const entrypoint = normalisePath(params.entrypoint);
  const entryAbs = path.resolve(repoRoot, entrypoint);

  if (!fs.existsSync(entryAbs)) {
    throw new Error(`Entrypoint does not exist: ${entrypoint}`);
  }

  const { options, host, resolutionCache } = makeTsProgram(repoRoot);

  const queue: string[] = [entryAbs];
  const seen = new Set<string>();
  const parent = new Map<string, string | null>([[entryAbs, null]]);
  const refsByFile = new Map<string, RuntimeReference[]>();
  const depsByFile = new Map<string, string[]>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current)) continue;
    seen.add(current);

    const sourceFile = readSourceFile(current);
    if (!sourceFile) {
      refsByFile.set(current, []);
      depsByFile.set(current, []);
      continue;
    }

    const refs = collectRuntimeReferences(sourceFile);
    refsByFile.set(current, refs);

    const internalDeps: string[] = [];
    for (const ref of refs) {
      const resolved = resolveInternalDependency({
        specifier: ref.specifier,
        containingFile: current,
        options,
        host,
        resolutionCache,
        repoRoot,
      });
      if (!resolved) continue;
      internalDeps.push(resolved);
      if (!parent.has(resolved)) {
        parent.set(resolved, current);
      }
      if (!seen.has(resolved)) {
        queue.push(resolved);
      }
    }
    depsByFile.set(current, internalDeps);
  }

  const leafClassificationCounts: Record<LeafClassification, number> = {
    pure: 0,
    needs_new_boundary: 0,
    genuinely_electron_bound: 0,
  };
  const closureClassificationCounts: Record<LeafClassification, number> = {
    pure: 0,
    needs_new_boundary: 0,
    genuinely_electron_bound: 0,
  };

  const nodes: ModuleAuditNode[] = [];
  const electronTouchingModules: DependencyAuditReport['electronTouchingModules'] = [];

  const sortedFiles = [...seen].sort((a, b) => a.localeCompare(b));
  for (const file of sortedFiles) {
    const rel = normalisePath(path.relative(repoRoot, file));
    const runtimeReferences = refsByFile.get(file) ?? [];
    const internalDependencies = (depsByFile.get(file) ?? []).map((dep) =>
      normalisePath(path.relative(repoRoot, dep)),
    );
    const runtimeElectronReferences = runtimeReferences.filter(
      (ref) => ref.specifier === 'electron' || ref.specifier === 'electron-store',
    );
    const isLeaf = internalDependencies.length === 0;
    const { classification, boundaryHint } = classifyNode({
      relativePath: rel,
      runtimeElectronReferences,
      isLeaf,
    });

    const node: ModuleAuditNode = {
      file: rel,
      runtimeReferences,
      internalDependencies,
      runtimeElectronReferences,
      isLeaf,
      classification,
      boundaryHint,
    };

    nodes.push(node);
    increment(closureClassificationCounts, classification);
    if (isLeaf) {
      increment(leafClassificationCounts, classification);
    }

    if (runtimeElectronReferences.length > 0) {
      const pathChain: string[] = [];
      let cursor: string | null | undefined = file;
      while (cursor) {
        pathChain.push(normalisePath(path.relative(repoRoot, cursor)));
        cursor = parent.get(cursor) ?? null;
      }
      pathChain.reverse();

      electronTouchingModules.push({
        file: rel,
        classification,
        boundaryHint,
        viaPath: pathChain,
        references: runtimeElectronReferences,
      });
    }
  }

  const leafCount = nodes.filter((node) => node.isLeaf).length;

  return {
    generatedAt: new Date().toISOString(),
    entrypoint,
    moduleCount: nodes.length,
    leafCount,
    leafClassificationCounts,
    closureClassificationCounts,
    electronTouchingModuleCount: electronTouchingModules.length,
    nodes,
    electronTouchingModules,
  };
}

export function buildMarkdownReport(report: DependencyAuditReport): string {
  const lines: string[] = [];

  lines.push('# Agent Turn Executor dependency closure audit');
  lines.push('');
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- Entrypoint: \`${report.entrypoint}\``);
  lines.push(`- Runtime dependency closure size: **${report.moduleCount}** modules`);
  lines.push(`- Runtime leaves: **${report.leafCount}**`);
  lines.push(`- Runtime electron/electron-store modules: **${report.electronTouchingModuleCount}**`);
  lines.push('');
  lines.push('## Leaf classification');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|---|---:|');
  lines.push(`| pure | ${report.leafClassificationCounts.pure} |`);
  lines.push(`| needs_new_boundary | ${report.leafClassificationCounts.needs_new_boundary} |`);
  lines.push(`| genuinely_electron_bound | ${report.leafClassificationCounts.genuinely_electron_bound} |`);
  lines.push('');
  lines.push('## Closure classification');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|---|---:|');
  lines.push(`| pure | ${report.closureClassificationCounts.pure} |`);
  lines.push(`| needs_new_boundary | ${report.closureClassificationCounts.needs_new_boundary} |`);
  lines.push(`| genuinely_electron_bound | ${report.closureClassificationCounts.genuinely_electron_bound} |`);
  lines.push('');
  lines.push('## Runtime electron/electron-store modules');
  lines.push('');

  if (report.electronTouchingModules.length === 0) {
    lines.push('_No runtime electron/electron-store imports remain in the closure._');
  } else {
    lines.push('| Module | Classification | Boundary hint | Via path |');
    lines.push('|---|---|---|---|');
    for (const item of report.electronTouchingModules) {
      const hint = item.boundaryHint ?? '—';
      lines.push(
        `| \`${item.file}\` | \`${item.classification}\` | ${hint} | \`${item.viaPath.join(' -> ')}\` |`,
      );
    }
  }

  lines.push('');
  lines.push('## Leaf modules');
  lines.push('');
  lines.push('| Leaf module | Classification | Boundary hint |');
  lines.push('|---|---|---|');
  for (const node of report.nodes.filter((n) => n.isLeaf)) {
    lines.push(
      `| \`${node.file}\` | \`${node.classification}\` | ${node.boundaryHint ?? '—'} |`,
    );
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseArgs(args: readonly string[]): {
  entrypoint: string;
  jsonOut: string;
  markdownOut: string;
} {
  const readArg = (flag: string, fallback: string): string => {
    const inline = args.find((arg) => arg.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return fallback;
  };

  return {
    entrypoint: readArg('--entry', DEFAULT_ENTRYPOINT),
    jsonOut: readArg('--json-out', DEFAULT_JSON_OUTPUT),
    markdownOut: readArg('--markdown-out', DEFAULT_MARKDOWN_OUTPUT),
  };
}

if (!process.env.VITEST) {
  const args = parseArgs(process.argv.slice(2));
  const report = buildDependencyAuditReport({
    repoRoot: REPO_ROOT,
    entrypoint: args.entrypoint,
  });
  const markdown = buildMarkdownReport(report);

  const jsonPath = path.resolve(REPO_ROOT, args.jsonOut);
  const markdownPath = path.resolve(REPO_ROOT, args.markdownOut);
  ensureParentDir(jsonPath);
  ensureParentDir(markdownPath);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, markdown, 'utf8');

  console.log(
    [
      'Agent turn executor dependency audit complete.',
      `  entrypoint: ${report.entrypoint}`,
      `  modules: ${report.moduleCount}`,
      `  leaves: ${report.leafCount}`,
      `  electron/electron-store modules: ${report.electronTouchingModuleCount}`,
      `  json: ${normalisePath(path.relative(REPO_ROOT, jsonPath))}`,
      `  markdown: ${normalisePath(path.relative(REPO_ROOT, markdownPath))}`,
    ].join('\n'),
  );
}
