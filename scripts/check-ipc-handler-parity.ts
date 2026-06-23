#!/usr/bin/env npx tsx
/**
 * CI validation: IPC contract ↔ handler registration parity.
 *
 * Static analysis only:
 * - Parses `src/shared/ipc/contracts.ts` to discover contract channel groups
 * - Resolves channel strings from `src/shared/ipc/channels/*.ts`
 * - Scans handler files under the public IPC tree plus private/stub IPC trees
 *   (matching `*Handlers.ts` or `*handlers.ts`) for registrations:
 *   registerHandler(...), ipcMain.handle(...), ipcMain.on(...)
 *
 * Reports (both are blocking errors):
 * - contract channel without handler registration
 * - handler registration without contract channel
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

type ChannelGroupMap = Map<string, string>;

export interface IpcHandlerParityPaths {
  contractsFile: string;
  handlersDir?: string;
  handlersDirs?: string[];
}

interface ResolvedIpcHandlerParityPaths {
  contractsFile: string;
  handlersDirs: string[];
}

export interface UnresolvedRegistration {
  file: string;
  expression: string;
}

export interface FindIpcHandlerParityViolationsOptions {
  repoRoot?: string;
  paths?: Partial<IpcHandlerParityPaths>;
  readFile?: (absolutePath: string) => string;
  listFiles?: (directory: string) => string[];
  allowlistedMissingHandlers?: Set<string>;
  allowlistedExtraHandlers?: Set<string>;
}

export interface FindIpcHandlerParityViolationsResult {
  contractChannels: string[];
  handlerChannels: string[];
  missingHandlers: string[];
  handlerWithoutContract: string[];
  unresolvedRegistrations: UnresolvedRegistration[];
  staleAllowlistEntries: StaleAllowlistEntry[];
  warnings: string[];
}

export interface StaleAllowlistEntry {
  channel: string;
  allowlist: 'missingHandler' | 'extraHandler';
}

interface ContractGroupReference {
  localName: string;
  importedName: string;
  sourceFile: string;
}

interface ContractRegistry {
  contractChannels: Set<string>;
  groupsByName: Map<string, ChannelGroupMap>;
  warnings: string[];
}

interface AnalysisScope {
  parent: AnalysisScope | null;
  channelValues: Map<string, string>;
  groupAliases: Map<string, ChannelGroupMap>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PATHS: IpcHandlerParityPaths = {
  contractsFile: 'src/shared/ipc/contracts.ts',
  handlersDirs: [
    'src/main/ipc',
    'private/mindstone/src/ipc',
    'src/main/oss/private-mindstone-stub/ipc',
  ],
};

/**
 * Escape hatch for channels that are intentionally handled via non-standard
 * registration flows outside `*Handlers.ts` static pattern detection.
 */
const DEFAULT_MISSING_HANDLER_ALLOWLIST = new Set<string>([
  // Registered via registerUserQuestionResponseHandler() call in agent handlers.
  'agent:user-question-response',
  // Registered by auto-update service (outside src/main/ipc/*Handlers.ts).
  'check-for-updates',
  'update:acknowledge',
  'update:acknowledge-toast',
  'update:get-pending-downloaded',
  'update:install-now',
  // Sync path wired in src/main/index.ts + cloudRouter listener.
  'sessions:save-sync',
  // OSS startup-time sync read registered in src/main/index.ts (before createWindow).
  // Desktop-only: intentionally excluded from CLOUD_CHANNEL_POLICIES.
  'telemetry-config:sync',
]);

/**
 * Fire-and-forget channels that intentionally bypass the contract system.
 *
 * These 3 emergency channels are registered via `ipcMain.on()` (not `.handle()`)
 * because they must work even when the main process is in a degraded state
 * (e.g. renderer crash recovery, safe-mode relaunch). Adding Zod validation
 * or `registerHandler()` would introduce failure points in the one code path
 * that must never fail.
 *
 * This is the complete and intentional list. If you need to add a new channel,
 * it should go through the contract system (`defineInvokeChannel`) — not here.
 */
const FIRE_AND_FORGET_CHANNELS = new Set<string>([
  'app:emergency-quit-request',
  'app:emergency-relaunch-request',
  'app:emergency-safe-mode-request',
]);

function resolvePaths(
  repoRoot: string,
  overrides?: Partial<IpcHandlerParityPaths>,
): ResolvedIpcHandlerParityPaths {
  const merged: IpcHandlerParityPaths = { ...DEFAULT_PATHS, ...(overrides ?? {}) };
  const handlerRoots = merged.handlersDirs ?? (merged.handlersDir ? [merged.handlersDir] : []);
  return {
    contractsFile: resolve(repoRoot, merged.contractsFile),
    handlersDirs: handlerRoots.map((handlersDir) => resolve(repoRoot, handlersDir)),
  };
}

function defaultListFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.git') continue;
      files.push(...defaultListFiles(absolutePath));
      continue;
    }
    files.push(absolutePath);
  }
  return files;
}

function isTsSource(filePath: string): boolean {
  const extension = extname(filePath);
  return (extension === '.ts' || extension === '.tsx')
    && !filePath.includes('.test.')
    && !filePath.includes('.spec.');
}

function isHandlerFile(filePath: string): boolean {
  if (!isTsSource(filePath)) return false;
  return /handlers\.ts$/i.test(filePath);
}

function createSourceFile(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (true) {
    if (
      ts.isAsExpression(current)
      || ts.isParenthesizedExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (current.kind === ts.SyntaxKind.SatisfiesExpression) {
      current = (current as ts.SatisfiesExpression).expression;
      continue;
    }
    return current;
  }
}

function unwrapToObjectLiteral(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : null;
}

function getPropertyNameKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
  }
  return null;
}

function getBindingElementKey(binding: ts.BindingElement): string | null {
  if (binding.propertyName) {
    if (
      ts.isIdentifier(binding.propertyName)
      || ts.isStringLiteral(binding.propertyName)
      || ts.isNoSubstitutionTemplateLiteral(binding.propertyName)
    ) {
      return binding.propertyName.text;
    }
    return null;
  }
  if (ts.isIdentifier(binding.name)) {
    return binding.name.text;
  }
  return null;
}

function findVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return null;
}

function resolveImportPath(baseFile: string, moduleSpecifier: string): string {
  const absoluteWithoutExtension = resolve(dirname(baseFile), moduleSpecifier);
  const candidates = [
    absoluteWithoutExtension,
    `${absoluteWithoutExtension}.ts`,
    `${absoluteWithoutExtension}.tsx`,
    resolve(absoluteWithoutExtension, 'index.ts'),
  ];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? `${absoluteWithoutExtension}.ts`;
}

export function parseContractGroupReferences(
  contractsSource: string,
  contractsFilePath: string,
): { references: ContractGroupReference[]; warnings: string[] } {
  const sourceFile = createSourceFile(contractsFilePath, contractsSource);
  const importByLocalName = new Map<string, Omit<ContractGroupReference, 'localName'>>();
  const warnings: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.importClause || statement.importClause.isTypeOnly) continue;
    const moduleText = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    if (!moduleText.startsWith('./channels/')) continue;
    if (!statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;

    const resolvedImportFile = resolveImportPath(contractsFilePath, moduleText);
    for (const specifier of statement.importClause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const localName = specifier.name.text;
      const importedName = specifier.propertyName?.text ?? localName;
      importByLocalName.set(localName, {
        importedName,
        sourceFile: resolvedImportFile,
      });
    }
  }

  const ipcContractDeclaration = findVariableDeclaration(sourceFile, 'ipcContract');
  const ipcContractObject = unwrapToObjectLiteral(ipcContractDeclaration?.initializer);
  if (!ipcContractObject) {
    warnings.push('Could not statically parse `ipcContract` object literal from contracts.ts.');
    return { references: [], warnings };
  }

  const references: ContractGroupReference[] = [];
  for (const property of ipcContractObject.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isIdentifier(initializer)) continue;

    const binding = importByLocalName.get(initializer.text);
    if (!binding) {
      warnings.push(
        `ipcContract entry "${initializer.text}" does not map to a ./channels/* import and could not be resolved.`,
      );
      continue;
    }

    references.push({
      localName: initializer.text,
      importedName: binding.importedName,
      sourceFile: binding.sourceFile,
    });
  }

  return { references, warnings };
}

function extractChannelLiteralFromDefinition(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);

  if (ts.isCallExpression(unwrapped)) {
    const firstArgument = unwrapped.arguments[0];
    if (firstArgument) {
      return extractChannelLiteralFromDefinition(firstArgument);
    }
    return null;
  }

  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return null;
  }

  for (const property of unwrapped.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (getPropertyNameKey(property.name) !== 'channel') continue;
    const channelValue = unwrapExpression(property.initializer);
    if (ts.isStringLiteral(channelValue) || ts.isNoSubstitutionTemplateLiteral(channelValue)) {
      return channelValue.text;
    }
  }

  return null;
}

function parseChannelGroupDefinition(
  groupFilePath: string,
  groupName: string,
  readFile: (absolutePath: string) => string,
): { channelsByKey: ChannelGroupMap; warning?: string } {
  const source = readFile(groupFilePath);
  const sourceFile = createSourceFile(groupFilePath, source);
  const declaration = findVariableDeclaration(sourceFile, groupName);
  if (!declaration) {
    return {
      channelsByKey: new Map(),
      warning: `Could not find channel group "${groupName}" in ${groupFilePath}.`,
    };
  }

  const objectLiteral = unwrapToObjectLiteral(declaration.initializer);
  if (!objectLiteral) {
    return {
      channelsByKey: new Map(),
      warning: `Channel group "${groupName}" in ${groupFilePath} is not a statically analyzable object literal.`,
    };
  }

  const channelsByKey: ChannelGroupMap = new Map();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = getPropertyNameKey(property.name);
    if (!key) continue;
    const channel = extractChannelLiteralFromDefinition(property.initializer);
    if (!channel) continue;
    channelsByKey.set(key, channel);
  }

  return { channelsByKey };
}

function buildContractRegistry(params: {
  contractsFile: string;
  readFile: (absolutePath: string) => string;
}): ContractRegistry {
  const contractsSource = params.readFile(params.contractsFile);
  const { references, warnings } = parseContractGroupReferences(contractsSource, params.contractsFile);
  const contractChannels = new Set<string>();
  const groupsByName = new Map<string, ChannelGroupMap>();
  const parsedGroupCache = new Map<string, ChannelGroupMap>();
  const allWarnings = [...warnings];

  for (const reference of references) {
    const cacheKey = `${reference.sourceFile}::${reference.importedName}`;
    let channelsByKey = parsedGroupCache.get(cacheKey);
    if (!channelsByKey) {
      const parsed = parseChannelGroupDefinition(reference.sourceFile, reference.importedName, params.readFile);
      channelsByKey = parsed.channelsByKey;
      parsedGroupCache.set(cacheKey, channelsByKey);
      if (parsed.warning) allWarnings.push(parsed.warning);
    }

    groupsByName.set(reference.importedName, channelsByKey);
    groupsByName.set(reference.localName, channelsByKey);
    for (const channel of channelsByKey.values()) {
      contractChannels.add(channel);
    }
  }

  return { contractChannels, groupsByName, warnings: allWarnings };
}

function createScope(parent: AnalysisScope | null): AnalysisScope {
  return {
    parent,
    channelValues: new Map<string, string>(),
    groupAliases: new Map<string, ChannelGroupMap>(),
  };
}

function getChannelValue(scope: AnalysisScope, name: string): string | undefined {
  for (let current: AnalysisScope | null = scope; current; current = current.parent) {
    const value = current.channelValues.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getGroupAlias(scope: AnalysisScope, name: string): ChannelGroupMap | undefined {
  for (let current: AnalysisScope | null = scope; current; current = current.parent) {
    const value = current.groupAliases.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveGroupAliasExpression(
  expression: ts.Expression,
  scope: AnalysisScope,
): ChannelGroupMap | null {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return null;
  return getGroupAlias(scope, unwrapped.text) ?? null;
}

function resolveElementAccessKey(
  expression: ts.Expression,
  scope: AnalysisScope,
): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isIdentifier(unwrapped)) {
    return getChannelValue(scope, unwrapped.text) ?? null;
  }
  return null;
}

function resolveChannelExpression(
  expression: ts.Expression,
  scope: AnalysisScope,
): string | null {
  const unwrapped = unwrapExpression(expression);

  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }

  if (ts.isIdentifier(unwrapped)) {
    return getChannelValue(scope, unwrapped.text) ?? null;
  }

  if (ts.isElementAccessExpression(unwrapped)) {
    const group = resolveGroupAliasExpression(unwrapped.expression, scope);
    if (!group || !unwrapped.argumentExpression) return null;
    const key = resolveElementAccessKey(unwrapped.argumentExpression, scope);
    if (!key) return null;
    return group.get(key) ?? null;
  }

  if (ts.isPropertyAccessExpression(unwrapped)) {
    if (unwrapped.name.text === 'channel') {
      return resolveChannelExpression(unwrapped.expression, scope);
    }

    const group = resolveGroupAliasExpression(unwrapped.expression, scope);
    if (!group) return null;
    return group.get(unwrapped.name.text) ?? null;
  }

  return null;
}

function registerVariableDeclaration(
  declaration: ts.VariableDeclaration,
  scope: AnalysisScope,
): void {
  if (!declaration.initializer) return;

  if (ts.isIdentifier(declaration.name)) {
    const groupAlias = resolveGroupAliasExpression(declaration.initializer, scope);
    if (groupAlias) {
      scope.groupAliases.set(declaration.name.text, groupAlias);
    }

    const channel = resolveChannelExpression(declaration.initializer, scope);
    if (channel) {
      scope.channelValues.set(declaration.name.text, channel);
    }
    return;
  }

  if (!ts.isObjectBindingPattern(declaration.name)) return;
  const groupAlias = resolveGroupAliasExpression(declaration.initializer, scope);
  if (!groupAlias) return;

  for (const binding of declaration.name.elements) {
    if (binding.dotDotDotToken || !ts.isIdentifier(binding.name)) continue;
    const key = getBindingElementKey(binding);
    if (!key) continue;
    const channel = groupAlias.get(key);
    if (!channel) continue;
    scope.channelValues.set(binding.name.text, channel);
  }
}

function collectImportGroupAliases(
  sourceFile: ts.SourceFile,
  groupsByName: Map<string, ChannelGroupMap>,
): Map<string, ChannelGroupMap> {
  const aliases = new Map<string, ChannelGroupMap>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.importClause || statement.importClause.isTypeOnly) continue;
    if (!statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;

    for (const specifier of statement.importClause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const group = groupsByName.get(importedName);
      if (!group) continue;
      aliases.set(specifier.name.text, group);
    }
  }

  return aliases;
}

function isRegistrationCall(callExpression: ts.CallExpression): boolean {
  if (ts.isIdentifier(callExpression.expression)) {
    return callExpression.expression.text === 'registerHandler';
  }

  if (
    ts.isPropertyAccessExpression(callExpression.expression)
    && ts.isIdentifier(callExpression.expression.expression)
    && callExpression.expression.expression.text === 'ipcMain'
  ) {
    const method = callExpression.expression.name.text;
    return method === 'handle' || method === 'on';
  }

  return false;
}

function extractFallbackChannelsFromExpressionText(expressionText: string): string[] {
  const channels = new Set<string>();
  const matcher = /['"`]([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)+)['"`]/gi;
  for (const match of expressionText.matchAll(matcher)) {
    channels.add(match[1]);
  }
  return [...channels];
}

function analyzeHandlerFile(params: {
  filePath: string;
  source: string;
  groupsByName: Map<string, ChannelGroupMap>;
}): { channels: Set<string>; unresolved: string[] } {
  const sourceFile = createSourceFile(params.filePath, params.source);
  const rootScope = createScope(null);
  const importAliases = collectImportGroupAliases(sourceFile, params.groupsByName);
  for (const [alias, group] of importAliases) {
    rootScope.groupAliases.set(alias, group);
  }

  const channels = new Set<string>();
  const unresolved: string[] = [];

  const visit = (node: ts.Node, scope: AnalysisScope): void => {
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isConstructorDeclaration(node)
    ) {
      const childScope = createScope(scope);
      ts.forEachChild(node, (child) => visit(child, childScope));
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
      const childScope = createScope(scope);
      ts.forEachChild(node, (child) => visit(child, childScope));
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      registerVariableDeclaration(node, scope);
    }

    if (ts.isCallExpression(node) && isRegistrationCall(node)) {
      const firstArg = node.arguments[0];
      if (firstArg) {
        const resolved = resolveChannelExpression(firstArg, scope);
        if (resolved) {
          channels.add(resolved);
        } else {
          const fallbackChannels = extractFallbackChannelsFromExpressionText(firstArg.getText(sourceFile));
          if (fallbackChannels.length > 0) {
            for (const fallback of fallbackChannels) channels.add(fallback);
          } else {
            unresolved.push(firstArg.getText(sourceFile));
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  };

  visit(sourceFile, rootScope);
  return { channels, unresolved };
}

export function findIpcHandlerParityViolations(
  options: FindIpcHandlerParityViolationsOptions = {},
): FindIpcHandlerParityViolationsResult {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
  const paths = resolvePaths(repoRoot, options.paths);
  const readFile = options.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, 'utf8'));
  const listFiles = options.listFiles ?? defaultListFiles;
  const allowlistedMissingHandlers = options.allowlistedMissingHandlers ?? DEFAULT_MISSING_HANDLER_ALLOWLIST;
  const allowlistedExtraHandlers = options.allowlistedExtraHandlers ?? FIRE_AND_FORGET_CHANNELS;

  const registry = buildContractRegistry({
    contractsFile: paths.contractsFile,
    readFile,
  });

  const handlerFiles = paths.handlersDirs
    .filter((handlersDir) => existsSync(handlersDir))
    .flatMap((handlersDir) => listFiles(handlersDir))
    .filter(isHandlerFile)
    .sort();

  const channelsToFiles = new Map<string, Set<string>>();
  const unresolvedRegistrations: UnresolvedRegistration[] = [];
  const warnings = [...registry.warnings];

  for (const handlerFile of handlerFiles) {
    const source = readFile(handlerFile);
    const analyzed = analyzeHandlerFile({
      filePath: handlerFile,
      source,
      groupsByName: registry.groupsByName,
    });

    const relativePath = relative(repoRoot, handlerFile);
    for (const channel of analyzed.channels) {
      const existing = channelsToFiles.get(channel) ?? new Set<string>();
      existing.add(relativePath);
      channelsToFiles.set(channel, existing);
    }

    for (const expression of analyzed.unresolved) {
      unresolvedRegistrations.push({
        file: relativePath,
        expression,
      });
    }
  }

  if (unresolvedRegistrations.length > 0) {
    warnings.push(
      `${unresolvedRegistrations.length} registration argument(s) could not be statically resolved to a channel string.`,
    );
  }

  const contractChannels = [...registry.contractChannels].sort();
  const handlerChannels = [...channelsToFiles.keys()].sort();

  const missingHandlers = contractChannels
    .filter((channel) => !channelsToFiles.has(channel))
    .filter((channel) => !allowlistedMissingHandlers.has(channel))
    .sort();

  const handlerWithoutContract = handlerChannels
    .filter((channel) => !registry.contractChannels.has(channel))
    .filter((channel) => !allowlistedExtraHandlers.has(channel))
    .sort();

  // Allowlist staleness detection: flag entries that no longer correspond to real channels.
  const staleAllowlistEntries: StaleAllowlistEntry[] = [];
  for (const channel of allowlistedMissingHandlers) {
    if (!registry.contractChannels.has(channel)) {
      staleAllowlistEntries.push({ channel, allowlist: 'missingHandler' });
    }
  }
  for (const channel of allowlistedExtraHandlers) {
    if (!channelsToFiles.has(channel)) {
      staleAllowlistEntries.push({ channel, allowlist: 'extraHandler' });
    }
  }
  staleAllowlistEntries.sort((a, b) => a.channel.localeCompare(b.channel));

  if (staleAllowlistEntries.length > 0) {
    warnings.push(
      `${staleAllowlistEntries.length} allowlist entry/entries are stale (channel no longer exists in source). Remove them from the allowlist.`,
    );
  }

  return {
    contractChannels,
    handlerChannels,
    missingHandlers,
    handlerWithoutContract,
    unresolvedRegistrations: unresolvedRegistrations.sort(
      (a, b) => a.file.localeCompare(b.file) || a.expression.localeCompare(b.expression),
    ),
    staleAllowlistEntries,
    warnings,
  };
}

export function main(): void {
  const result = findIpcHandlerParityViolations();

  for (const warning of result.warnings) {
    process.stderr.write(`[ipc-handler-parity] warning: ${warning}\n`);
  }

  if (result.unresolvedRegistrations.length > 0) {
    process.stderr.write('[ipc-handler-parity] warning: unresolved registration arguments:\n');
    for (const unresolved of result.unresolvedRegistrations) {
      process.stderr.write(`  - ${unresolved.file}: ${unresolved.expression}\n`);
    }
  }

  if (result.staleAllowlistEntries.length > 0) {
    process.stderr.write(
      `[ipc-handler-parity] warning: ${result.staleAllowlistEntries.length} stale allowlist entry/entries (channel no longer in source):\n`,
    );
    for (const entry of result.staleAllowlistEntries) {
      process.stderr.write(`  - ${entry.channel} (in ${entry.allowlist} allowlist)\n`);
    }
  }

  const errors: string[] = [];

  if (result.missingHandlers.length > 0) {
    errors.push(
      `${result.missingHandlers.length} contract channel(s) without handler registration:`,
    );
    for (const channel of result.missingHandlers) {
      errors.push(`  - ${channel}`);
    }
  }

  if (result.handlerWithoutContract.length > 0) {
    errors.push(
      `${result.handlerWithoutContract.length} handler channel(s) not declared in ipcContract (add a contract or add to FIRE_AND_FORGET_CHANNELS):`,
    );
    for (const channel of result.handlerWithoutContract) {
      errors.push(`  - ${channel}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`IPC handler parity check failed.\n`);
    for (const line of errors) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `IPC handler parity check passed (${result.contractChannels.length} contract channel${result.contractChannels.length === 1 ? '' : 's'}, ${result.handlerChannels.length} registered channel${result.handlerChannels.length === 1 ? '' : 's'} scanned).\n`,
  );
  process.exit(0);
}

const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main();
}
