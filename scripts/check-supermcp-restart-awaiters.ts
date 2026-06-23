#!/usr/bin/env npx tsx
/**
 * CI guard: Super-MCP restart execution-awaiting opt-ins must not appear in
 * user-facing IPC (or similar hot paths) unless explicitly allowlisted.
 *
 * Why: postmortem 260610_connector_disconnect_deferred_restart_ipc_hang — awaiting
 * `...AndAwaitExecution` from a renderer-facing handler couples response latency to
 * deferred restart (up to RESTART_DEFERRAL_CEILING_MS while agent turns drain).
 * Stage 3 split detached forms as the default; this guard ratchets the four deliberate
 * awaiters and fails on any new `await ...AndAwaitExecution` or
 * `...AndAwaitExecution(...).then(` outside the allowlist.
 *
 * Prefer `requestRestartForConfigChangeDetached` / `reconfigureSuperMcpWithCacheRefreshDetached`.
 * See docs-private/postmortems/260610_connector_disconnect_deferred_restart_ipc_hang_postmortem.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const POSTMORTEM_PATH =
  'docs-private/postmortems/260610_connector_disconnect_deferred_restart_ipc_hang_postmortem.md';

/** Restart-seam functions that resolve only after (possibly deferred) execution. */
export const RESTART_AWAIT_EXECUTION_FUNCTION_NAMES = [
  'requestRestartForConfigChangeAndAwaitExecution',
  'reconfigureSuperMcpWithCacheRefreshAndAwaitExecution',
  'restartSuperMcpForConfigChangeAndAwaitExecution',
] as const;

export type RestartAwaitExecutionFunctionName = (typeof RESTART_AWAIT_EXECUTION_FUNCTION_NAMES)[number];

export type RestartAwaiterOccurrenceKind = 'await' | 'promise-chain';

export interface SuperMcpRestartAwaiterAllowlistEntry {
  readonly filePath: string;
  /** Stable marker: enclosing function name, IPC channel, or call context string. */
  readonly marker: string;
  readonly kind: RestartAwaiterOccurrenceKind;
  readonly rationale: string;
}

/**
 * Deliberate execution-awaiting opt-ins (Stage 3 audit). File + marker, not line numbers.
 */
export const DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST: readonly SuperMcpRestartAwaiterAllowlistEntry[] = [
  {
    filePath: 'src/main/ipc/settingsHandlers.ts',
    marker: 'upsertMcpServerAndRestart',
    kind: 'await',
    rationale:
      'Settings MCP upsert intentionally waits for restart completion before returning.',
  },
  {
    filePath: 'src/main/ipc/settingsHandlers.ts',
    marker: 'settings:mcp-restart-super-mcp',
    kind: 'await',
    rationale:
      'Settings manual restart IPC response depends on isRunning after the restart completes.',
  },
  {
    filePath: 'src/core/services/inbox/inboxBridgeStateMachine.ts',
    marker: 'restartSuperMcp',
    kind: 'await',
    rationale:
      'Bundled inbox bridge state machine must not advance until the restart has completed.',
  },
  {
    // Extracted from index.ts into the deep-link handler (Stage 2 of the
    // index.ts startup refactor — docs/plans/260623_refactor-index-startup-extract/PLAN.md).
    filePath: 'src/main/startup/deepLinkHandler.ts',
    marker: 'oauth-deep-link-return',
    kind: 'promise-chain',
    rationale:
      'OAuth deep-link return notifies the renderer on completion but must not block the handler on deferred restart.',
  },
];

export const ADDITIONAL_SCAN_ROOTS = ['cloud-service/src'] as const;

export interface SourceInput {
  readonly filePath: string;
  readonly sourceText: string;
}

export type GuardFailureKind =
  | 'unallowlisted_awaiter'
  | 'stale_allowlist_entry'
  | 'duplicate_allowlist_entry';

export interface GuardFailure {
  readonly kind: GuardFailureKind;
  readonly filePath: string;
  readonly detail: string;
  readonly remediation: string;
}

export interface RestartAwaiterOccurrence {
  readonly filePath: string;
  readonly kind: RestartAwaiterOccurrenceKind;
  readonly functionName: RestartAwaitExecutionFunctionName;
  readonly line: number;
  readonly markers: readonly string[];
  readonly matchedAllowlistIndex: number | null;
}

export interface GuardResult {
  readonly failed: boolean;
  readonly failures: readonly GuardFailure[];
  readonly occurrences: readonly RestartAwaiterOccurrence[];
  readonly scannedFiles: number;
}

function normalizeRelativePath(filePath: string, root = REPO_ROOT): string {
  const normalized = filePath.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (path.isAbsolute(filePath) && normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.replace(/^\.?\//, '');
}

function isProductionTsSource(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized.startsWith('src/') && !normalized.startsWith('cloud-service/src/')) return false;
  if (!/\.(ts|tsx)$/.test(normalized)) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/dist/')) return false;
  if (/(^|\.)(test|spec)\.tsx?$/.test(normalized)) return false;
  return true;
}

function collectScanSources(root: string): SourceInput[] {
  const sources: SourceInput[] = [];

  function walk(current: string, relativeRoot: string): void {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRelativePath(path.join(relativeRoot, entry.name), root);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') continue;
        walk(absolutePath, path.join(relativeRoot, entry.name));
        continue;
      }
      if (!isProductionTsSource(relativePath)) continue;
      sources.push({
        filePath: relativePath,
        sourceText: fs.readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  walk(path.join(root, 'src'), 'src');
  for (const extraRoot of ADDITIONAL_SCAN_ROOTS) {
    walk(path.join(root, extraRoot), extraRoot);
  }

  return sources.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function callExpressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isRestartAwaitExecutionCall(node: ts.CallExpression): RestartAwaitExecutionFunctionName | null {
  const name = callExpressionName(node.expression);
  if (!name) return null;
  return (RESTART_AWAIT_EXECUTION_FUNCTION_NAMES as readonly string[]).includes(name)
    ? (name as RestartAwaitExecutionFunctionName)
    : null;
}

function nameFromBindingName(name: ts.BindingName | ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return nameFromBindingName(current.name);
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) {
        return nameFromBindingName(parent.name);
      }
      if (ts.isPropertyAssignment(parent)) {
        return nameFromBindingName(parent.name);
      }
    }
    current = current.parent;
  }
  return null;
}

function isInsideAndAwaitExecutionImplementation(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    const fnName = enclosingFunctionName(current);
    if (fnName?.endsWith('AndAwaitExecution')) return true;
    current = current.parent;
  }
  return false;
}

function collectRegisterHandlerChannels(node: ts.Node): string[] {
  const channels: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isCallExpression(current)) {
      const calleeName = callExpressionName(current.expression);
      if (calleeName === 'registerHandler' && current.arguments[0]) {
        const firstArg = current.arguments[0];
        if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
          channels.push(firstArg.text);
        }
      }
    }
    current = current.parent;
  }
  return channels;
}

function collectStringLiteralsInSubtree(node: ts.Node): string[] {
  const literals: string[] = [];
  function visit(current: ts.Node): void {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      literals.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return literals;
}

function occurrenceMarkers(node: ts.Node, call: ts.CallExpression): string[] {
  const markers = new Set<string>();
  const fnName = enclosingFunctionName(node);
  if (fnName) markers.add(fnName);
  for (const channel of collectRegisterHandlerChannels(node)) {
    markers.add(channel);
  }
  for (const literal of collectStringLiteralsInSubtree(call)) {
    markers.add(literal);
  }
  return [...markers];
}

function allowlistMatches(
  entry: SuperMcpRestartAwaiterAllowlistEntry,
  filePath: string,
  kind: RestartAwaiterOccurrenceKind,
  markers: readonly string[],
): boolean {
  if (normalizeRelativePath(entry.filePath) !== normalizeRelativePath(filePath)) return false;
  if (entry.kind !== kind) return false;
  return markers.includes(entry.marker);
}

function findRestartAwaiterOccurrences(
  filePath: string,
  sourceText: string,
): RestartAwaiterOccurrence[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const occurrences: RestartAwaiterOccurrence[] = [];

  function visit(node: ts.Node): void {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const fnName = isRestartAwaitExecutionCall(node.expression);
      if (fnName && !isInsideAndAwaitExecutionImplementation(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        occurrences.push({
          filePath,
          kind: 'await',
          functionName: fnName,
          line: line + 1,
          markers: occurrenceMarkers(node, node.expression),
          matchedAllowlistIndex: null,
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const propertyAccess = node.expression;
      if (
        ts.isPropertyAccessExpression(propertyAccess)
        && propertyAccess.name.text === 'then'
        && ts.isCallExpression(propertyAccess.expression)
      ) {
        const fnName = isRestartAwaitExecutionCall(propertyAccess.expression);
        if (fnName && !isInsideAndAwaitExecutionImplementation(node)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          occurrences.push({
            filePath,
            kind: 'promise-chain',
            functionName: fnName,
            line: line + 1,
            markers: occurrenceMarkers(node, propertyAccess.expression),
            matchedAllowlistIndex: null,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

function ensureAllowlistIntegrity(
  allowlist: readonly SuperMcpRestartAwaiterAllowlistEntry[],
): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const seen = new Set<string>();

  for (const entry of allowlist) {
    const key = `${normalizeRelativePath(entry.filePath)}::${entry.kind}::${entry.marker}`;
    if (seen.has(key)) {
      failures.push({
        kind: 'duplicate_allowlist_entry',
        filePath: normalizeRelativePath(entry.filePath),
        detail: `Allowlist entry "${entry.marker}" (${entry.kind}) is registered more than once.`,
        remediation:
          'Keep exactly one allowlist entry per deliberate awaiter in scripts/check-supermcp-restart-awaiters.ts.',
      });
    }
    seen.add(key);
  }

  return failures;
}

export function checkSuperMcpRestartAwaiters(options: {
  readonly repoRoot?: string;
  readonly allowlist?: readonly SuperMcpRestartAwaiterAllowlistEntry[];
  readonly sourceInputs?: readonly SourceInput[];
} = {}): GuardResult {
  const root = options.repoRoot ?? REPO_ROOT;
  const allowlist = options.allowlist ?? DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST;
  const sourceInputs = options.sourceInputs ?? collectScanSources(root);
  const failures: GuardFailure[] = [...ensureAllowlistIntegrity(allowlist)];

  const allOccurrences: RestartAwaiterOccurrence[] = [];
  const matchedAllowlistIndices = new Set<number>();

  for (const input of sourceInputs) {
    const filePath = normalizeRelativePath(input.filePath, root);
    const fileOccurrences = findRestartAwaiterOccurrences(filePath, input.sourceText);

    for (const occurrence of fileOccurrences) {
      let matchedIndex: number | null = null;
      for (let index = 0; index < allowlist.length; index += 1) {
        if (allowlistMatches(allowlist[index]!, filePath, occurrence.kind, occurrence.markers)) {
          matchedIndex = index;
          matchedAllowlistIndices.add(index);
          break;
        }
      }

      const recorded: RestartAwaiterOccurrence = {
        ...occurrence,
        matchedAllowlistIndex: matchedIndex,
      };
      allOccurrences.push(recorded);

      if (matchedIndex === null) {
        failures.push({
          kind: 'unallowlisted_awaiter',
          filePath,
          detail:
            `Unallowlisted ${occurrence.kind} on ${occurrence.functionName} at line ${occurrence.line} ` +
            `(markers: ${occurrence.markers.join(', ') || 'none'}). ` +
            'Awaiting a deferred Super-MCP restart from user-facing IPC can hang the renderer for up to RESTART_DEFERRAL_CEILING_MS.',
          remediation:
            `Default to the detached restart API (*Detached). If this site genuinely needs execution-awaiting behaviour, ` +
            `add an explicit allowlist entry (file + stable marker) in scripts/check-supermcp-restart-awaiters.ts and document why. ` +
            `See ${POSTMORTEM_PATH}.`,
        });
      }
    }
  }

  for (let index = 0; index < allowlist.length; index += 1) {
    if (!matchedAllowlistIndices.has(index)) {
      const entry = allowlist[index]!;
      failures.push({
        kind: 'stale_allowlist_entry',
        filePath: normalizeRelativePath(entry.filePath),
        detail:
          `Allowlist entry "${entry.marker}" (${entry.kind}) no longer matches any scanned occurrence — ` +
          'the deliberate awaiter was removed or moved.',
        remediation:
          'Remove the stale allowlist entry or update its file/marker to match the live callsite.',
      });
    }
  }

  return {
    failed: failures.length > 0,
    failures,
    occurrences: allOccurrences,
    scannedFiles: sourceInputs.length,
  };
}

export function formatGuardResult(result: GuardResult): string {
  if (!result.failed) {
    const allowlisted = result.occurrences.filter((occurrence) => occurrence.matchedAllowlistIndex !== null);
    return [
      'Super-MCP restart awaiter guard passed.',
      `Scanned ${result.scannedFiles} production TypeScript files.`,
      `Allowlisted execution-awaiting opt-ins: ${allowlisted.length}.`,
    ].join('\n');
  }

  const lines = [
    'Super-MCP restart awaiter guard FAILED.',
    'User-facing paths must not await deferred Super-MCP restarts unless explicitly allowlisted.',
    `Postmortem: ${POSTMORTEM_PATH}`,
    'Default: requestRestartForConfigChangeDetached / reconfigureSuperMcpWithCacheRefreshDetached.',
  ];

  for (const failure of result.failures) {
    lines.push(`✘ ${failure.filePath}: ${failure.detail}`);
    lines.push(`  Fix: ${failure.remediation}`);
  }

  return lines.join('\n');
}

export function runCli(): number {
  const result = checkSuperMcpRestartAwaiters();
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
