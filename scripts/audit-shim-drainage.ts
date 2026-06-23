#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type RefKind = 'import' | 'export' | 'dynamic-import' | 'require' | 'import-type';

interface ModuleReference {
  specifier: string;
  line: number;
  kind: RefKind;
}

interface ShimTargetResult {
  path: string;
  exists: boolean;
  classification: 'missing' | 'pure-reexport-shim' | 'shim-with-runtime-wiring' | 'core-wrapper' | 'non-shim';
  retainHeaderReason: string | null;
  consumerCount: number;
  consumers: ModuleConsumer[];
}

interface ModuleConsumer {
  file: string;
  line: number;
  kind: RefKind;
  specifier: string;
}

const REPO_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.factory',
  'docs',
  'rebel-system',
  'coding-agent-instructions',
  'tmp',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TARGET_FILES_BASE = [
  'src/main/services/authTokenStorage.ts',
  'src/main/services/providerTokenStorage.ts',
  'src/main/services/flyTokenStorage.ts',
  'src/main/services/openRouterTokenStorage.ts',
  'src/main/services/codexTokenStorage.ts',
  'src/main/services/fileTreeService.ts',
  'src/main/startup/installGracefulFs.ts',
  'src/main/settingsStore.ts',
  'src/main/services/mcpService.ts',
  'src/main/services/toolSafetyService.ts',
  'src/main/services/agentTurnSubmissionService.ts',
  'src/main/services/agentTurnExecutor.ts',
  'src/main/services/turnPipeline/agentTurnEvents.ts',
  'src/main/services/turnPipeline/agentTurnExecute.ts',
  'src/main/services/turnPipeline/agentTurnInit.ts',
  'src/main/services/turnPipeline/agentTurnPersistence.ts',
  'src/main/services/turnPipeline/agentTurnPolling.ts',
  'src/main/services/turnPipeline/agentTurnRecovery.ts',
  'src/main/services/turnPipeline/cleanupTypes.ts',
  'src/main/services/turnPipeline/index.ts',
  'src/main/services/turnPipeline/runPhase.ts',
  'src/main/services/turnPipeline/turnAdmission.ts',
  'src/main/services/turnPipeline/turnCompletion.ts',
  'src/main/services/turnPipeline/types.ts',
  'src/main/services/bundledInboxBridge.ts',
  'src/main/services/meetingBot/meetingAnalysisService.ts',
  'src/main/services/spaceService.ts',
  'src/main/services/perfCounters.ts',
  'src/main/services/spaceWriteSafety.ts',
  'src/main/services/systemSettingsSync.ts',
  'src/main/services/watchdogTracker.ts',
  'src/main/services/headlessTurnRunner.ts',
  'src/main/services/cliSessionSnapshot.ts',
  'src/main/services/persistSessionFromCli.ts',
  'cloud-service/src/services/cloudMeetingAnalysis.ts',
  'cloud-service/src/services/agentTurnSubmissionService.ts',
  'cloud-service/src/mapHandlerRegistry.ts',
];

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getRelativePath(filePath: string): string {
  return normalisePath(path.relative(REPO_ROOT, filePath));
}

function parseTsConfigOptions(): {
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  cache: ts.ModuleResolutionCache;
} {
  const tsconfigPath = path.join(REPO_ROOT, 'tsconfig.node.json');
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT, undefined, tsconfigPath);
  const host = ts.createCompilerHost(parsed.options, true);
  const cache = ts.createModuleResolutionCache(
    REPO_ROOT,
    (fileName) => normalisePath(fileName),
    parsed.options,
  );

  return { options: parsed.options, host, cache };
}

function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(extension)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function collectTurnPipelineTargets(): string[] {
  const folder = path.join(REPO_ROOT, 'src/main/services/turnPipeline');
  if (!fs.existsSync(folder)) return [];

  return fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/main/services/turnPipeline/${name}`)
    .sort();
}

function collectCloudMeetingTargets(): string[] {
  const folder = path.join(REPO_ROOT, 'cloud-service/src/services');
  if (!fs.existsSync(folder)) return [];

  return fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('meeting') && name.endsWith('.ts'))
    .map((name) => `cloud-service/src/services/${name}`)
    .sort();
}

function getShimTargets(): string[] {
  const targets = new Set<string>([
    ...TARGET_FILES_BASE,
    ...collectTurnPipelineTargets(),
    ...collectCloudMeetingTargets(),
  ]);

  return [...targets].sort((a, b) => a.localeCompare(b));
}

function readSourceFile(filePath: string): ts.SourceFile {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
}

function extractRetainHeaderReason(sourceText: string): string | null {
  const lines = sourceText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\/\/\s*SHIM-RETAINED:\s*(.+)$/);
    return match ? match[1].trim() : null;
  }
  return null;
}

function collectModuleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const refs: ModuleReference[] = [];

  const addRef = (specifier: string, line: number, kind: RefKind): void => {
    refs.push({ specifier, line, kind });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const line = sourceFile.getLineAndCharacterOfPosition(statement.moduleSpecifier.getStart(sourceFile)).line + 1;
      addRef(statement.moduleSpecifier.text, line, 'import');
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const line = sourceFile.getLineAndCharacterOfPosition(statement.moduleSpecifier.getStart(sourceFile)).line + 1;
      addRef(statement.moduleSpecifier.text, line, 'export');
      continue;
    }
    if (ts.isImportTypeNode(statement) && ts.isLiteralTypeNode(statement.argument) && ts.isStringLiteral(statement.argument.literal)) {
      const line = sourceFile.getLineAndCharacterOfPosition(statement.argument.literal.getStart(sourceFile)).line + 1;
      addRef(statement.argument.literal.text, line, 'import-type');
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          const line = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile)).line + 1;
          addRef(firstArg.text, line, 'dynamic-import');
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          const line = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile)).line + 1;
          addRef(firstArg.text, line, 'require');
        }
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.argument.literal.getStart(sourceFile)).line + 1;
      addRef(node.argument.literal.text, line, 'import-type');
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return refs;
}

function probeLocalModule(basePath: string): string | null {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.mjs'),
    path.join(basePath, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.normalize(candidate);
    }
  }

  return null;
}

function resolveModulePath(params: {
  specifier: string;
  containingFile: string;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  cache: ts.ModuleResolutionCache;
}): string | null {
  const { specifier, containingFile, options, host, cache } = params;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    cache,
  ).resolvedModule;

  if (resolved && !resolved.isExternalLibraryImport) {
    return path.normalize(resolved.resolvedFileName);
  }

  if (specifier.startsWith('.')) {
    return probeLocalModule(path.resolve(path.dirname(containingFile), specifier));
  }

  if (specifier.startsWith('@main/')) {
    return probeLocalModule(path.join(REPO_ROOT, 'src/main', specifier.slice('@main/'.length)));
  }

  if (specifier.startsWith('@core/')) {
    return probeLocalModule(path.join(REPO_ROOT, 'src/core', specifier.slice('@core/'.length)));
  }

  if (specifier.startsWith('@shared/')) {
    return probeLocalModule(path.join(REPO_ROOT, 'src/shared', specifier.slice('@shared/'.length)));
  }

  return null;
}

function classifyTarget(absPath: string): {
  classification: ShimTargetResult['classification'];
  retainHeaderReason: string | null;
} {
  if (!fs.existsSync(absPath)) {
    return { classification: 'missing', retainHeaderReason: null };
  }

  const sourceText = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true);
  const statements = sourceFile.statements;
  const retainHeaderReason = extractRetainHeaderReason(sourceText);
  const hasShimMarker = /(CORE-MOVE-EXEMPT|@deprecated|compatibility shim|Re-export shim|SHIM-RETAINED)/i.test(sourceText);

  const hasCoreReExport = statements.some(
    (statement) => ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('@core/'),
  );

  const hasOnlyExportDeclarations = statements.length > 0 && statements.every(
    (statement) => ts.isExportDeclaration(statement)
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier),
  );

  if (hasCoreReExport && hasOnlyExportDeclarations) {
    return { classification: 'pure-reexport-shim', retainHeaderReason };
  }

  if (hasCoreReExport && hasShimMarker) {
    return { classification: 'shim-with-runtime-wiring', retainHeaderReason };
  }

  const hasOnlyCoreImportsAndExpressions = statements.length > 0 && statements.every((statement) => {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('@core/')
    ) {
      return true;
    }
    return ts.isExpressionStatement(statement);
  });

  if (hasOnlyCoreImportsAndExpressions) {
    return { classification: 'core-wrapper', retainHeaderReason };
  }

  return { classification: 'non-shim', retainHeaderReason };
}

function buildAuditResults(): ShimTargetResult[] {
  const targets = getShimTargets();
  const targetAbsByPath = new Map<string, string>();
  const targetPathByAbs = new Map<string, string>();

  for (const target of targets) {
    const absPath = path.normalize(path.join(REPO_ROOT, target));
    targetAbsByPath.set(target, absPath);
    targetPathByAbs.set(absPath, target);
  }

  const consumerMap = new Map<string, ModuleConsumer[]>();
  for (const target of targets) {
    consumerMap.set(target, []);
  }

  const sourceFiles = collectSourceFiles(REPO_ROOT);
  const { options, host, cache } = parseTsConfigOptions();

  for (const sourceFilePath of sourceFiles) {
    const sourceFile = readSourceFile(sourceFilePath);
    const references = collectModuleReferences(sourceFile);
    if (references.length === 0) continue;

    const sourceRelative = getRelativePath(sourceFilePath);

    for (const ref of references) {
      const resolvedPath = resolveModulePath({
        specifier: ref.specifier,
        containingFile: sourceFilePath,
        options,
        host,
        cache,
      });
      if (!resolvedPath) continue;

      const targetPath = targetPathByAbs.get(resolvedPath);
      if (!targetPath) continue;
      if (targetPath === sourceRelative) continue;

      const consumers = consumerMap.get(targetPath);
      if (!consumers) continue;

      consumers.push({
        file: sourceRelative,
        line: ref.line,
        kind: ref.kind,
        specifier: ref.specifier,
      });
    }
  }

  return targets.map((targetPath) => {
    const absPath = targetAbsByPath.get(targetPath) ?? path.join(REPO_ROOT, targetPath);
    const { classification, retainHeaderReason } = classifyTarget(absPath);
    const consumers = consumerMap.get(targetPath) ?? [];
    const dedupedConsumers = [...new Map(
      consumers.map((consumer) => [
        `${consumer.file}:${consumer.line}:${consumer.kind}:${consumer.specifier}`,
        consumer,
      ]),
    ).values()].sort((a, b) => (
      a.file.localeCompare(b.file) || a.line - b.line || a.specifier.localeCompare(b.specifier)
    ));

    return {
      path: targetPath,
      exists: fs.existsSync(absPath),
      classification,
      retainHeaderReason,
      consumerCount: dedupedConsumers.length,
      consumers: dedupedConsumers,
    };
  });
}

function toMarkdown(results: ShimTargetResult[]): string {
  const existingCount = results.filter((result) => result.exists).length;
  const missingCount = results.length - existingCount;
  const shimResults = results.filter(
    (result) => result.classification === 'pure-reexport-shim'
      || result.classification === 'shim-with-runtime-wiring',
  );
  const retainedShims = shimResults.filter(
    (result) => !(result.classification === 'pure-reexport-shim' && result.consumerCount === 0),
  );
  const retainedShimsMissingHeader = retainedShims.filter((result) => !result.retainHeaderReason).length;
  const activeShimCount = shimResults.filter((result) => result.consumerCount > 0).length;
  const zeroConsumerShimCount = shimResults.filter((result) => result.consumerCount === 0).length;
  const deleteCandidateCount = results.filter(
    (result) => result.classification === 'pure-reexport-shim' && result.consumerCount === 0,
  ).length;
  const retainedCandidateCount = results.filter(
    (result) => result.classification !== 'missing'
      && !(result.classification === 'pure-reexport-shim' && result.consumerCount === 0),
  ).length;
  const generatedAt = new Date().toISOString();

  const lines: string[] = [];
  lines.push('# Stage 4.B Shim Drainage Audit');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('Source: `scripts/audit-shim-drainage.ts`');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Targets audited: ${results.length}`);
  lines.push(`- Existing files: ${existingCount}`);
  lines.push(`- Missing files: ${missingCount}`);
  lines.push(`- Shim files (pure + runtime wiring): ${shimResults.length}`);
  lines.push(`- Shim files with remaining consumers: ${activeShimCount}`);
  lines.push(`- Shim files with zero consumers: ${zeroConsumerShimCount}`);
  lines.push(`- Delete candidates (pure shims with zero consumers): ${deleteCandidateCount}`);
  lines.push(`- Retain candidates: ${retainedCandidateCount}`);
  lines.push(`- Retained shims missing \`SHIM-RETAINED\` header: ${retainedShimsMissingHeader}`);
  lines.push('');
  lines.push('## Target Table');
  lines.push('');
  lines.push('| Target | Classification | Consumers | Header | Suggested action |');
  lines.push('|---|---:|---:|---|---|');
  for (const result of results) {
    const suggestedAction = !result.exists
      ? 'n/a (missing)'
      : (result.classification === 'pure-reexport-shim' && result.consumerCount === 0)
          ? 'delete'
          : 'retain';
    const header = result.retainHeaderReason
      ? `yes — ${result.retainHeaderReason}`
      : 'no';
    lines.push(
      `| \`${result.path}\` | ${result.classification} | ${result.consumerCount} | ${header} | ${suggestedAction} |`,
    );
  }
  lines.push('');
  lines.push('## Consumers by target');
  lines.push('');

  for (const result of results) {
    lines.push(`### \`${result.path}\``);
    lines.push('');
    lines.push(`- Classification: ${result.classification}`);
    lines.push(`- Consumer count: ${result.consumerCount}`);
    lines.push(`- Retain header: ${result.retainHeaderReason ? `present (${result.retainHeaderReason})` : 'missing'}`);
    if (!result.exists) {
      lines.push('- Notes: target file does not exist in current checkout.');
      lines.push('');
      continue;
    }
    if (result.consumerCount === 0) {
      lines.push('- Consumers: none');
      lines.push('');
      continue;
    }

    lines.push('- Consumers:');
    for (const consumer of result.consumers) {
      lines.push(
        `  - \`${consumer.file}:${consumer.line}\` (${consumer.kind}) via \`${consumer.specifier}\``,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(args: readonly string[]): { writePath: string | null } {
  let writePath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--write' && args[i + 1]) {
      writePath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--write=')) {
      writePath = arg.slice('--write='.length);
    }
  }
  return { writePath };
}

if (!process.env.VITEST) {
  const { writePath } = parseArgs(process.argv.slice(2));
  const results = buildAuditResults();
  const markdown = toMarkdown(results);

  if (writePath) {
    const outputPath = path.resolve(REPO_ROOT, writePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown, 'utf8');
    console.log(`Wrote shim drainage audit: ${normalisePath(path.relative(REPO_ROOT, outputPath))}`);
  } else {
    process.stdout.write(markdown);
  }
}

export { buildAuditResults, toMarkdown };
