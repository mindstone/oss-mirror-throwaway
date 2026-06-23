#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

type SurfaceClassification =
  | 'sync_propagation_requires_conflict_matcher'
  | 'conflict_detection_or_cleanup_consumer'
  | 'manual_conflict_resolution'
  | 'origin_authoring_pending_exempt'
  | 'cloud_internal_state_exempt'
  | 'generic_workspace_filesystem_exempt';

interface FunctionRequirement {
  functionName: string;
  requiredIdentifiers: readonly string[];
}

export interface ConflictMatcherSurfaceEntry {
  filePath: string;
  classification: SurfaceClassification;
  functionRequirements?: readonly FunctionRequirement[];
  requiredIdentifiers?: readonly string[];
  rationale?: string;
}

export interface SourceInput {
  filePath: string;
  sourceText: string;
}

export interface GuardFailure {
  kind:
    | 'missing_registered_file'
    | 'missing_required_function'
    | 'missing_function_guard'
    | 'missing_required_identifier'
    | 'missing_exempt_rationale'
    | 'duplicate_registry_entry'
    | 'unclassified_producer';
  filePath: string;
  detail: string;
  remediation: string;
}

export interface GuardResult {
  failed: boolean;
  failures: GuardFailure[];
  scannedFiles: number;
  producerCandidates: string[];
}

interface ParsedSource {
  filePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
}

export const DEFAULT_CONFLICT_MATCHER_SURFACE_REGISTRY: readonly ConflictMatcherSurfaceEntry[] = [
  {
    filePath: 'src/main/services/cloud/cloudWorkspaceSync.ts',
    classification: 'sync_propagation_requires_conflict_matcher',
    functionRequirements: [
      {
        functionName: 'buildLocalManifest',
        requiredIdentifiers: ['isSuppressibleConflictCopy', 'isSuppressibleConflictDir'],
      },
      {
        functionName: 'pullChangedFiles',
        requiredIdentifiers: ['isSuppressibleConflictCopy', 'shouldSuppressConflictDirAncestor'],
      },
    ],
  },
  {
    // The gate function BODIES live here now (workspaceSyncPolicy.ts is a thin
    // re-export shim). Shared so the cloud-service manifest builder can reuse
    // the same suppression logic without coupling to @main. See REBEL-62A.
    filePath: 'src/shared/conflictSuppression.ts',
    classification: 'sync_propagation_requires_conflict_matcher',
    functionRequirements: [
      {
        functionName: 'isSuppressibleConflictCopy',
        // Gates on ALL progressively-shallower originals (root included), not just
        // the immediate sibling — see deriveOriginalPathCandidates (REBEL-62A
        // missing-intermediate fail-open fix).
        requiredIdentifiers: ['matchConflictPattern', 'deriveOriginalPathCandidates'],
      },
      {
        functionName: 'isSuppressibleConflictDir',
        requiredIdentifiers: ['matchConflictDirPattern', 'deriveOriginalDirPath'],
      },
      {
        functionName: 'shouldSuppressConflictDirAncestor',
        requiredIdentifiers: ['matchConflictDirPattern', 'deriveOriginalDirPath'],
      },
    ],
  },
  {
    filePath: 'src/main/services/health/checks/conflictingCopies.ts',
    classification: 'conflict_detection_or_cleanup_consumer',
    requiredIdentifiers: ['CONFLICT_PATTERNS'],
  },
  {
    filePath: 'src/core/services/spaceMaintenanceService.ts',
    classification: 'conflict_detection_or_cleanup_consumer',
    requiredIdentifiers: ['CONFLICT_PATTERNS', 'deriveOriginalPath'],
  },
  {
    filePath: 'src/core/services/conflictCopyCleanup.ts',
    classification: 'conflict_detection_or_cleanup_consumer',
    requiredIdentifiers: ['matchConflictPattern', 'deriveOriginalPath'],
  },
  {
    filePath: 'src/main/ipc/cloudHandlers.ts',
    classification: 'manual_conflict_resolution',
    requiredIdentifiers: ['deriveOriginalPath', 'WORKSPACE_CONFLICT_MARKER'],
  },
  {
    filePath: 'src/main/services/safety/cosPendingService.ts',
    classification: 'origin_authoring_pending_exempt',
    rationale:
      'Writes agent-authored pendingDestination paths, not Drive-FS-scanned names; Drive conflict copies arise only at the workspace FS-mirror layer (cloudWorkspaceSync), never here; kept registered so a future scan-derived destination forces re-classification.',
  },
  {
    filePath: 'src/main/services/cloud/cloudStagingBridge.ts',
    classification: 'origin_authoring_pending_exempt',
    rationale:
      'Writes agent-authored pendingDestination paths, not Drive-FS-scanned names; Drive conflict copies arise only at the workspace FS-mirror layer (cloudWorkspaceSync), never here; kept registered so a future scan-derived destination forces re-classification.',
  },
  {
    filePath: 'src/main/services/cloud/cloudContinuityMetadata.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal sync state in sessions/cloud-continuity-meta.json: continuity state, tombstone cursor, pins, and removal intent metadata; not user-authored workspace content; Drive conflict copies never apply.',
  },
  {
    filePath: 'src/main/services/cloud/cloudMigrationService.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal migration bookkeeping in pre-cloud-backup/ snapshots and created-at.txt before upload; workspace migration streams local content to cloud and does not ingest Drive-scanned workspace paths locally; Drive conflict copies never apply.',
  },
  {
    filePath: 'src/main/services/cloud/cloudOutbox.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal sync state in sessions/cloud-outbox.json, corrupt outbox quarantines, and tombstone quarantine snapshots; not user-authored workspace content; Drive conflict copies never apply.',
  },
  {
    filePath: 'src/main/services/cloud/cloudRouter.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal sync state via the continuity-v2-cleanup-done marker and metadata flush orchestration; it routes session/inbox sync through typed stores, not Drive-FS-scanned workspace content; Drive conflict copies never apply.',
  },
  {
    filePath: 'src/main/services/cloud/cloudSyncMetadata.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal sync state in sessions/cloud-sync-meta.json: per-session cloudSyncedAt cursors; not user-authored workspace content; Drive conflict copies never apply.',
  },
  {
    filePath: 'src/main/services/workspaceFileSystem/electronWorkspaceFileSystem.ts',
    classification: 'generic_workspace_filesystem_exempt',
    rationale:
      'Generic workspace filesystem adapter; path-specific cloud ingest filtering belongs at the cloudWorkspaceSync scan/propagation layer before generic filesystem writes are invoked.',
  },
  {
    filePath: 'src/main/services/cloud/cloudAtomicWrite.ts',
    classification: 'generic_workspace_filesystem_exempt',
    rationale:
      'Generic atomic temp-then-rename write primitive (writeFileAtomicInTargetDirSync); it has no cloud-ingest awareness. Conflict-copy suppression/matching is applied by callers at the cloudWorkspaceSync scan/propagation layer BEFORE this primitive is invoked (pull writes, pending-update apply). REBEL-696.',
  },
  {
    filePath: 'src/main/services/cloud/cloudConflictQuarantine.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Parks both-edited cloud bytes OUTSIDE the OS-synced workspace (userData quarantine root) plus a JSON index; it never writes Drive-FS-scanned workspace paths, so Drive conflict copies never arise here. The conflict matching that produces these entries runs upstream in cloudWorkspaceSync.pullChangedFiles. REBEL-696.',
  },
  {
    filePath: 'src/main/services/cloud/cloudPendingUpdateStore.ts',
    classification: 'cloud_internal_state_exempt',
    rationale:
      'Writes Rebel cloud-internal sync state in cloud-pending-updates.json: hash-keyed records of files whose newer version lives only in the cloud (edited on another device). Not user-authored workspace content; the record is produced/cleared by the matcher-aware pull loop. Drive conflict copies never apply. REBEL-696 Stage 5.',
  },
  {
    // Server-side manifest builder — peers sync against this surface; must mirror
    // desktop buildLocalManifest conflict-copy suppression (REBEL-62A).
    filePath: 'cloud-service/src/routes/library.ts',
    classification: 'sync_propagation_requires_conflict_matcher',
    functionRequirements: [
      {
        functionName: 'buildCloudManifest',
        requiredIdentifiers: ['isSuppressibleConflictCopy', 'isSuppressibleConflictDir'],
      },
    ],
  },
];

/** Explicit out-of-`src/` production surfaces registered in the guard. No broad scans. */
export const ADDITIONAL_REGISTERED_SOURCE_PATHS: readonly string[] = [
  'cloud-service/src/routes/library.ts',
];

const CLOUD_INGEST_INDICATORS = [
  'SyncClient',
  'cloudManifest',
  '/api/library/',
  'memory:staging-get-content',
  'pullChangedFiles',
  'buildLocalManifest',
] as const;

const PENDING_DESTINATION_INDICATORS = ['writeToPending', 'pendingDestination'] as const;

const WORKSPACE_WRITE_ARGUMENT_HINTS = [
  'coreDirectory',
  'coreDir',
  'workspace',
  'workspacePath',
  'pendingDestination',
  'destinationPath',
  'relativePath',
  'localPath',
  'absolutePath',
  'tmpPath',
  'finalPath',
  'safePath',
] as const;

const REQUIRED_EXEMPTION_CLASSES = new Set<SurfaceClassification>([
  'origin_authoring_pending_exempt',
  'cloud_internal_state_exempt',
  'generic_workspace_filesystem_exempt',
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalizeRelativePath(filePath: string, root = repoRoot): string {
  const normalized = filePath.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (path.isAbsolute(filePath) && normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.replace(/^\.?\//, '');
}

const ADDITIONAL_REGISTERED_SOURCE_PATH_SET = new Set(ADDITIONAL_REGISTERED_SOURCE_PATHS);

function isProductionTsSource(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized.startsWith('src/')) return false;
  if (!/\.(ts|tsx)$/.test(normalized)) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/dist/')) return false;
  if (/(^|\.)(test|spec)\.tsx?$/.test(normalized)) return false;
  return true;
}

function isGuardScannedSource(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (ADDITIONAL_REGISTERED_SOURCE_PATH_SET.has(normalized)) return true;
  return isProductionTsSource(normalized);
}

function collectProductionSources(root: string): SourceInput[] {
  const srcRoot = path.join(root, 'src');
  const sources: SourceInput[] = [];

  function walk(current: string): void {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRelativePath(absolutePath, root);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'dist') continue;
        walk(absolutePath);
        continue;
      }
      if (!isProductionTsSource(relativePath)) continue;
      sources.push({
        filePath: relativePath,
        sourceText: fs.readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  walk(srcRoot);
  return sources.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function collectAdditionalRegisteredSources(root: string): SourceInput[] {
  const sources: SourceInput[] = [];
  for (const relativePath of ADDITIONAL_REGISTERED_SOURCE_PATHS) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    sources.push({
      filePath: relativePath,
      sourceText: fs.readFileSync(absolutePath, 'utf8'),
    });
  }
  return sources;
}

function collectGuardSources(root: string): SourceInput[] {
  return [
    ...collectProductionSources(root),
    ...collectAdditionalRegisteredSources(root),
  ].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function parseSources(sourceInputs: readonly SourceInput[], root: string): ParsedSource[] {
  return sourceInputs
    .map((input) => {
      const filePath = normalizeRelativePath(input.filePath, root);
      return {
        filePath,
        sourceText: input.sourceText,
        sourceFile: ts.createSourceFile(
          filePath,
          input.sourceText,
          ts.ScriptTarget.Latest,
          true,
          filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      };
    })
    .filter((source) => isGuardScannedSource(source.filePath));
}

function collectIdentifierNames(node: ts.Node): Set<string> {
  const identifiers = new Set<string>();

  function visit(current: ts.Node): void {
    if (ts.isIdentifier(current)) {
      identifiers.add(current.text);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return identifiers;
}

function collectCallNames(node: ts.Node): Set<string> {
  const names = new Set<string>();

  function visit(current: ts.Node): void {
    if (ts.isCallExpression(current)) {
      const name = callName(current.expression);
      if (name) names.add(name);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return names;
}

function nameMatches(nodeName: ts.PropertyName | ts.BindingName | undefined, expected: string): boolean {
  if (!nodeName) return false;
  if (ts.isIdentifier(nodeName) || ts.isStringLiteral(nodeName) || ts.isNumericLiteral(nodeName)) {
    return nodeName.text === expected;
  }
  return false;
}

function blockFromFunctionLike(node: ts.Node): ts.Block | null {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node))
    && node.body
  ) {
    return node.body;
  }
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
    return node.body;
  }
  return null;
}

function findFunctionBody(sourceFile: ts.SourceFile, functionName: string): ts.Block | null {
  let found: ts.Block | null = null;

  function visit(node: ts.Node): void {
    if (found) return;

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      && nameMatches(node.name, functionName)
    ) {
      found = blockFromFunctionLike(node);
      return;
    }

    if (ts.isVariableDeclaration(node) && nameMatches(node.name, functionName) && node.initializer) {
      found = blockFromFunctionLike(node.initializer);
      if (found) return;
    }

    if (ts.isPropertyAssignment(node) && nameMatches(node.name, functionName)) {
      found = blockFromFunctionLike(node.initializer);
      if (found) return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function ensureRegistryIntegrity(
  registry: readonly ConflictMatcherSurfaceEntry[],
): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const seen = new Set<string>();

  for (const entry of registry) {
    const normalizedPath = normalizeRelativePath(entry.filePath);
    if (seen.has(normalizedPath)) {
      failures.push({
        kind: 'duplicate_registry_entry',
        filePath: normalizedPath,
        detail: 'Surface is registered more than once.',
        remediation: 'Keep exactly one registry entry per surface in scripts/check-conflict-matcher-consumer-guard.ts.',
      });
    }
    seen.add(normalizedPath);

    if (
      REQUIRED_EXEMPTION_CLASSES.has(entry.classification)
      && (!entry.rationale || entry.rationale.trim().length === 0)
    ) {
      failures.push({
        kind: 'missing_exempt_rationale',
        filePath: normalizedPath,
        detail: `Exempt surface ${entry.classification} has no rationale.`,
        remediation: 'Add a non-empty rationale explaining why this surface is exempt instead of silently unguarded.',
      });
    }
  }

  return failures;
}

function hasRequiredSourceIdentifiers(
  parsed: ParsedSource,
  requiredIdentifiers: readonly string[] | undefined,
): string[] {
  if (!requiredIdentifiers || requiredIdentifiers.length === 0) return [];
  const identifiers = collectIdentifierNames(parsed.sourceFile);
  return requiredIdentifiers.filter((identifier) => !identifiers.has(identifier));
}

function checkRegisteredEntry(entry: ConflictMatcherSurfaceEntry, parsed: ParsedSource): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const requiredSourceIdentifiers = hasRequiredSourceIdentifiers(parsed, entry.requiredIdentifiers);

  for (const identifier of requiredSourceIdentifiers) {
    failures.push({
      kind: 'missing_required_identifier',
      filePath: parsed.filePath,
      detail: `${entry.classification} surface is missing required conflict matcher symbol \`${identifier}\`.`,
      remediation: 'Restore the conflictPatterns import/use for this registered consumer, or reclassify the surface with a rationale if its role changed.',
    });
  }

  if (entry.classification !== 'sync_propagation_requires_conflict_matcher') {
    return failures;
  }

  for (const requirement of entry.functionRequirements ?? []) {
    const body = findFunctionBody(parsed.sourceFile, requirement.functionName);
    if (!body) {
      failures.push({
        kind: 'missing_required_function',
        filePath: parsed.filePath,
        detail: `Registered sync-propagation function \`${requirement.functionName}\` was not found.`,
        remediation: 'Update the registry if the function was intentionally renamed; otherwise restore the guarded sync function.',
      });
      continue;
    }

    const calledNames = collectCallNames(body);
    for (const requiredIdentifier of requirement.requiredIdentifiers) {
      if (!calledNames.has(requiredIdentifier)) {
        failures.push({
          kind: 'missing_function_guard',
          filePath: parsed.filePath,
          detail: `\`${requirement.functionName}\` does not call required guard \`${requiredIdentifier}\` inside its body.`,
          remediation: 'Add the missing conflict matcher guard call in this function body. A top-level import or another function using the matcher is not sufficient.',
        });
      }
    }
  }

  return failures;
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isCloudServicesSource(filePath: string): boolean {
  return filePath.startsWith('src/main/services/cloud/');
}

function isWorkspaceLikeWriteCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  options: { relaxWriteArgumentHints: boolean },
): boolean {
  const name = callName(node.expression);
  if (!name) return false;

  if (ts.isPropertyAccessExpression(node.expression)) {
    const leftText = node.expression.expression.getText(sourceFile);
    if (leftText === 'manifest' && name === 'set') {
      return true;
    }
  }

  const isWriteOrRename =
    name === 'writeFile'
    || name === 'writeFileSync'
    || name === 'rename'
    || name === 'renameSync'
    || name.startsWith('write');

  if (!isWriteOrRename) return false;
  if (options.relaxWriteArgumentHints) return true;

  const firstArg = node.arguments[0]?.getText(sourceFile) ?? '';
  return WORKSPACE_WRITE_ARGUMENT_HINTS.some((hint) => firstArg.includes(hint));
}

function hasWorkspaceWriteOrPropagation(parsed: ParsedSource): boolean {
  let found = false;
  const relaxWriteArgumentHints = isCloudServicesSource(parsed.filePath);

  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && isWorkspaceLikeWriteCall(node, parsed.sourceFile, { relaxWriteArgumentHints })
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed.sourceFile);
  return found;
}

function isCloudPendingDestinationSurface(filePath: string): boolean {
  return (
    isCloudServicesSource(filePath)
    || filePath === 'src/main/services/safety/cosPendingService.ts'
    || filePath === 'src/main/ipc/cloudHandlers.ts'
  );
}

function hasCloudIngestIndicator(parsed: ParsedSource): boolean {
  if (CLOUD_INGEST_INDICATORS.some((indicator) => parsed.sourceText.includes(indicator))) {
    return true;
  }

  return (
    isCloudPendingDestinationSurface(parsed.filePath)
    && PENDING_DESTINATION_INDICATORS.some((indicator) => parsed.sourceText.includes(indicator))
  );
}

function isProducerCandidate(parsed: ParsedSource): boolean {
  if (isCloudServicesSource(parsed.filePath) && hasWorkspaceWriteOrPropagation(parsed)) {
    return true;
  }
  return hasCloudIngestIndicator(parsed) && hasWorkspaceWriteOrPropagation(parsed);
}

function checkProducerParity(
  parsedSources: readonly ParsedSource[],
  registeredPaths: ReadonlySet<string>,
): { failures: GuardFailure[]; candidates: string[] } {
  const failures: GuardFailure[] = [];
  const candidates: string[] = [];

  for (const parsed of parsedSources) {
    if (!isProducerCandidate(parsed)) continue;
    candidates.push(parsed.filePath);
    if (!registeredPaths.has(parsed.filePath)) {
      failures.push({
        kind: 'unclassified_producer',
        filePath: parsed.filePath,
        detail: 'Production module is a cloud-service writer or combines cloud-ingest indicators with a workspace write/manifest propagation operation but is not in the conflict-matcher consumer registry.',
        remediation: 'Classify this surface in scripts/check-conflict-matcher-consumer-guard.ts as a guarded sync propagation path or an explicit exemption with rationale.',
      });
    }
  }

  return { failures, candidates: candidates.sort((a, b) => a.localeCompare(b)) };
}

export function checkConflictMatcherConsumerGuard(options: {
  repoRoot?: string;
  registry?: readonly ConflictMatcherSurfaceEntry[];
  sourceInputs?: readonly SourceInput[];
} = {}): GuardResult {
  const root = options.repoRoot ?? repoRoot;
  const registry = options.registry ?? DEFAULT_CONFLICT_MATCHER_SURFACE_REGISTRY;
  const sourceInputs = options.sourceInputs ?? collectGuardSources(root);
  const parsedSources = parseSources(sourceInputs, root);
  const parsedByPath = new Map(parsedSources.map((source) => [source.filePath, source]));
  const failures: GuardFailure[] = [];
  failures.push(...ensureRegistryIntegrity(registry));

  const registeredPaths = new Set<string>();
  for (const entry of registry) {
    const normalizedPath = normalizeRelativePath(entry.filePath, root);
    registeredPaths.add(normalizedPath);
    const parsed = parsedByPath.get(normalizedPath);
    if (!parsed) {
      failures.push({
        kind: 'missing_registered_file',
        filePath: normalizedPath,
        detail: 'Registered conflict-matcher consumer surface does not exist in scanned production sources.',
        remediation: 'Restore the file or update the registry if the surface moved.',
      });
      continue;
    }
    failures.push(...checkRegisteredEntry(entry, parsed));
  }

  const parity = checkProducerParity(parsedSources, registeredPaths);
  failures.push(...parity.failures);

  return {
    failed: failures.length > 0,
    failures,
    scannedFiles: parsedSources.length,
    producerCandidates: parity.candidates,
  };
}

export function formatGuardResult(result: GuardResult): string {
  if (!result.failed) {
    return [
      'Conflict-matcher consumer guard passed.',
      `Scanned ${result.scannedFiles} guarded production TypeScript files.`,
      `Classified producer candidates: ${result.producerCandidates.length > 0 ? result.producerCandidates.join(', ') : 'none'}.`,
    ].join('\n');
  }

  const lines = [
    'Conflict-matcher consumer guard FAILED.',
    'Every cloud workspace-sync ingest/propagation path must either call the conflict matcher in the required function body or be explicitly classified with rationale.',
  ];

  for (const failure of result.failures) {
    lines.push(`✘ ${failure.filePath}: ${failure.detail}`);
    lines.push(`  Fix: ${failure.remediation}`);
  }

  return lines.join('\n');
}

export function runCli(): number {
  const result = checkConflictMatcherConsumerGuard();
  const report = formatGuardResult(result);
  if (result.failed) {
    process.stderr.write(`${report}\n`);
    return 1;
  }
  process.stdout.write(`${report}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
