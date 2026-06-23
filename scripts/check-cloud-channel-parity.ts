#!/usr/bin/env npx tsx
/**
 * CI validation: cloud channel policy ↔ cloud-service route parity.
 *
 * Ensures each channel declared in CLOUD_CHANNEL_POLICIES has cloud-side
 * structural coverage based on transport:
 * - ipc  -> covered by cloud-service/src/routes/ipc.ts (shared allowlist wiring
 *           or explicit channel literal)
 * - rest -> covered by either a direct channel reference in cloud routes, or a
 *           channel→endpoint mapping in cloudRouter plus matching server route
 *           + route handler implementation
 * - ws   -> covered by a direct channel reference, or an endpoint mapping that
 *           appears in cloud-service/src/server.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CloudTransport = 'ipc' | 'rest' | 'ws';

export interface ChannelPolicy {
  channel: string;
  transport: CloudTransport;
}

export interface ChannelEndpointMapping {
  channel: string;
  method: string;
  path: string;
}

export interface CloudChannelParityViolation {
  channel: string;
  transport: CloudTransport | 'unknown';
  reason: string;
}

export interface CloudChannelParityPaths {
  cloudPoliciesFile: string;
  cloudIpcRouteFile: string;
  cloudServerFile: string;
  cloudRoutesDir: string;
  cloudRouterFile: string;
}

export interface FindCloudChannelParityViolationsOptions {
  repoRoot?: string;
  paths?: Partial<CloudChannelParityPaths>;
  readFile?: (absolutePath: string) => string;
  listFiles?: (directory: string) => string[];
  allowlistedChannels?: Set<string>;
}

export interface FindCloudChannelParityViolationsResult {
  policies: ChannelPolicy[];
  violations: CloudChannelParityViolation[];
  warnings: string[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PATHS: CloudChannelParityPaths = {
  cloudPoliciesFile: 'src/shared/cloudChannelPolicies.ts',
  cloudIpcRouteFile: 'cloud-service/src/routes/ipc.ts',
  cloudServerFile: 'cloud-service/src/server.ts',
  cloudRoutesDir: 'cloud-service/src/routes',
  cloudRouterFile: 'src/main/services/cloud/cloudRouter.ts',
};

/**
 * Escape hatch for intentionally non-standard channels.
 *
 * Keep this empty unless a channel is intentionally desktop-only or handled via
 * a cloud path that cannot be represented by this check's structural scans.
 */
const DEFAULT_ALLOWLIST = new Set<string>();

function resolvePaths(
  repoRoot: string,
  overrides?: Partial<CloudChannelParityPaths>,
): CloudChannelParityPaths {
  const merged: CloudChannelParityPaths = { ...DEFAULT_PATHS, ...(overrides ?? {}) };
  return {
    cloudPoliciesFile: resolve(repoRoot, merged.cloudPoliciesFile),
    cloudIpcRouteFile: resolve(repoRoot, merged.cloudIpcRouteFile),
    cloudServerFile: resolve(repoRoot, merged.cloudServerFile),
    cloudRoutesDir: resolve(repoRoot, merged.cloudRoutesDir),
    cloudRouterFile: resolve(repoRoot, merged.cloudRouterFile),
  };
}

function defaultListFiles(directory: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__tests__') continue;
      results.push(...defaultListFiles(absolute));
      continue;
    }
    results.push(absolute);
  }
  return results;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceHasChannelLiteral(source: string, channel: string): boolean {
  const pattern = new RegExp(`['"\`]${escapeRegex(channel)}['"\`]`);
  return pattern.test(source);
}

function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.replace(/(^|[^\\])\/\/.*$/gm, '$1');
}

export function parseCloudChannelPolicies(source: string): ChannelPolicy[] {
  const policies: ChannelPolicy[] = [];
  const matcher = /['"]([^'"]+)['"]\s*:\s*\{[^{}]*?\btransport\s*:\s*['"](ipc|rest|ws)['"][^{}]*\}/g;

  for (const match of source.matchAll(matcher)) {
    const [, channel, transport] = match;
    policies.push({
      channel,
      transport: transport as CloudTransport,
    });
  }

  return policies;
}

function extractChannelToEndpointBlock(source: string): string | null {
  const match = source.match(/const\s+CHANNEL_TO_ENDPOINT[\s\S]*?=\s*\{([\s\S]*?)\}\s*;/);
  return match ? match[1] : null;
}

export function parseCloudRouterEndpointMappings(source: string): ChannelEndpointMapping[] {
  const block = extractChannelToEndpointBlock(source);
  if (!block) return [];

  const mappings: ChannelEndpointMapping[] = [];
  const entryMatcher = /['"]([^'"]+)['"]\s*:\s*\{([\s\S]*?)\}(?:,|$)/g;

  for (const match of block.matchAll(entryMatcher)) {
    const [, channel, body] = match;
    const methodMatch = body.match(/\bmethod\s*:\s*['"]([A-Z]+)['"]/);
    const pathMatch = body.match(/\bpath\s*:\s*['"]([^'"]+)['"]/);
    if (!methodMatch || !pathMatch) continue;

    mappings.push({
      channel,
      method: methodMatch[1],
      path: pathMatch[1],
    });
  }

  return mappings;
}

function getSharedIpcAllowlistAlias(ipcRouteSource: string): string | null {
  const importsMatcher = /import\s*\{([^}]+)\}\s*from\s*['"]@shared\/cloudChannelPolicies['"]/g;

  for (const match of ipcRouteSource.matchAll(importsMatcher)) {
    const specifiers = match[1]
      .split(',')
      .map((specifier) => specifier.trim())
      .filter(Boolean);

    for (const specifier of specifiers) {
      const aliasMatch = specifier.match(/^CLOUD_IPC_ALLOWLIST(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (aliasMatch) {
        return aliasMatch[1] ?? 'CLOUD_IPC_ALLOWLIST';
      }
    }
  }

  return null;
}

function hasSharedIpcAllowlistWiring(ipcRouteSource: string): boolean {
  const alias = getSharedIpcAllowlistAlias(ipcRouteSource);
  if (!alias) return false;
  const spreadPattern = new RegExp(`\\.\\.\\.${escapeRegex(alias)}\\b`);
  return spreadPattern.test(ipcRouteSource);
}

export function parseServerHandlersByPath(serverSource: string): Map<string, Set<string>> {
  const handlersByPath = new Map<string, Set<string>>();
  const routeMatcher = /route\s*===\s*['"]([^'"]+)['"]/g;

  for (const match of serverSource.matchAll(routeMatcher)) {
    const endpointPath = match[1];
    const start = match.index ?? 0;
    // Route blocks in server.ts are short; this look-ahead is enough to pick
    // up `handleX(...)` calls without attempting full TS parsing.
    const window = serverSource.slice(start, start + 500);
    const handlers = [...window.matchAll(/\b(handle[A-Za-z0-9_]+)\s*\(/g)].map((h) => h[1]);
    if (handlers.length === 0) continue;

    const existing = handlersByPath.get(endpointPath) ?? new Set<string>();
    for (const handler of handlers) existing.add(handler);
    handlersByPath.set(endpointPath, existing);
  }

  return handlersByPath;
}

export function parseExportedRouteHandlers(routeSources: string[]): Set<string> {
  const handlers = new Set<string>();
  const functionMatcher = /export\s+(?:async\s+)?function\s+(handle[A-Za-z0-9_]+)\b/g;
  const constMatcher = /export\s+const\s+(handle[A-Za-z0-9_]+)\s*=/g;

  for (const source of routeSources) {
    for (const match of source.matchAll(functionMatcher)) {
      handlers.add(match[1]);
    }
    for (const match of source.matchAll(constMatcher)) {
      handlers.add(match[1]);
    }
  }

  return handlers;
}

function isTsSource(filePath: string): boolean {
  const extension = extname(filePath);
  return (extension === '.ts' || extension === '.tsx')
    && !filePath.includes('.test.')
    && !filePath.includes('.spec.');
}

function findIpcViolations(params: {
  policies: ChannelPolicy[];
  ipcRouteSource: string;
  allowlistedChannels: Set<string>;
}): CloudChannelParityViolation[] {
  const violations: CloudChannelParityViolation[] = [];
  const ipcRouteCode = stripComments(params.ipcRouteSource);
  const sharedAllowlistWired = hasSharedIpcAllowlistWiring(ipcRouteCode);

  for (const policy of params.policies) {
    if (policy.transport !== 'ipc') continue;
    if (params.allowlistedChannels.has(policy.channel)) continue;

    const hasLiteral = sourceHasChannelLiteral(ipcRouteCode, policy.channel);
    if (hasLiteral || sharedAllowlistWired) continue;

    violations.push({
      channel: policy.channel,
      transport: policy.transport,
      reason: 'Missing IPC coverage in cloud-service/src/routes/ipc.ts (no shared allowlist wiring or explicit channel literal found).',
    });
  }

  return violations;
}

function findRestViolations(params: {
  policies: ChannelPolicy[];
  serverSource: string;
  restRouteSources: string[];
  routeHandlersByPath: Map<string, Set<string>>;
  exportedRouteHandlers: Set<string>;
  endpointMappings: Map<string, ChannelEndpointMapping>;
  allowlistedChannels: Set<string>;
}): CloudChannelParityViolation[] {
  const violations: CloudChannelParityViolation[] = [];
  const serverCode = stripComments(params.serverSource);
  const cloudRouteCorpus = [serverCode, ...params.restRouteSources.map(stripComments)].join('\n');

  for (const policy of params.policies) {
    if (policy.transport !== 'rest') continue;
    if (params.allowlistedChannels.has(policy.channel)) continue;

    // Check server.ts for channel literal (handles non-standard direct-route patterns).
    // Only server.ts counts — a literal in an arbitrary route file doesn't prove the
    // channel is reachable via the HTTP router.
    if (sourceHasChannelLiteral(serverCode, policy.channel)) continue;

    const mapping = params.endpointMappings.get(policy.channel);
    if (!mapping) {
      violations.push({
        channel: policy.channel,
        transport: policy.transport,
        reason: 'Missing REST endpoint mapping in src/main/services/cloud/cloudRouter.ts (CHANNEL_TO_ENDPOINT).',
      });
      continue;
    }

    if (!sourceHasChannelLiteral(serverCode, mapping.path)) {
      violations.push({
        channel: policy.channel,
        transport: policy.transport,
        reason: `Mapped REST endpoint "${mapping.path}" not found in cloud-service/src/server.ts.`,
      });
      continue;
    }

    const candidateHandlers = params.routeHandlersByPath.get(mapping.path);
    if (!candidateHandlers || candidateHandlers.size === 0) {
      violations.push({
        channel: policy.channel,
        transport: policy.transport,
        reason: `No route handler call detected for mapped REST endpoint "${mapping.path}" in cloud-service/src/server.ts.`,
      });
      continue;
    }

    const hasImplementation = [...candidateHandlers].some((handler) => params.exportedRouteHandlers.has(handler));
    if (!hasImplementation) {
      violations.push({
        channel: policy.channel,
        transport: policy.transport,
        reason: `Mapped REST endpoint "${mapping.path}" references handler(s) without route implementation exports under cloud-service/src/routes.`,
      });
    }
  }

  return violations;
}

function findWsViolations(params: {
  policies: ChannelPolicy[];
  serverSource: string;
  routeSources: string[];
  endpointMappings: Map<string, ChannelEndpointMapping>;
  allowlistedChannels: Set<string>;
}): CloudChannelParityViolation[] {
  const violations: CloudChannelParityViolation[] = [];
  const serverCode = stripComments(params.serverSource);
  const cloudRouteCorpus = [serverCode, ...params.routeSources.map(stripComments)].join('\n');

  for (const policy of params.policies) {
    if (policy.transport !== 'ws') continue;
    if (params.allowlistedChannels.has(policy.channel)) continue;

    if (sourceHasChannelLiteral(cloudRouteCorpus, policy.channel)) continue;

    const mapping = params.endpointMappings.get(policy.channel);
    if (mapping && sourceHasChannelLiteral(serverCode, mapping.path)) continue;

    violations.push({
      channel: policy.channel,
      transport: policy.transport,
      reason: 'Missing WebSocket coverage in cloud-service (no channel literal or mapped endpoint reference found).',
    });
  }

  return violations;
}

export function findCloudChannelParityViolations(
  options: FindCloudChannelParityViolationsOptions = {},
): FindCloudChannelParityViolationsResult {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
  const paths = resolvePaths(repoRoot, options.paths);
  const readFile = options.readFile ?? ((absolutePath) => readFileSync(absolutePath, 'utf8'));
  const listFiles = options.listFiles ?? defaultListFiles;
  const allowlistedChannels = options.allowlistedChannels ?? DEFAULT_ALLOWLIST;

  const warnings: string[] = [];
  const violations: CloudChannelParityViolation[] = [];

  const policiesSource = readFile(paths.cloudPoliciesFile);
  const policies = parseCloudChannelPolicies(policiesSource);
  if (policies.length === 0) {
    violations.push({
      channel: '<CLOUD_CHANNEL_POLICIES>',
      transport: 'unknown',
      reason: `No channel policies parsed from ${relative(repoRoot, paths.cloudPoliciesFile)}.`,
    });
    return { policies, violations, warnings };
  }

  const ipcRouteSource = readFile(paths.cloudIpcRouteFile);
  const serverSource = readFile(paths.cloudServerFile);
  const cloudRouterSource = readFile(paths.cloudRouterFile);

  const routeFilePaths = listFiles(paths.cloudRoutesDir)
    .filter(isTsSource)
    .sort();
  const routeFiles = routeFilePaths.map((filePath) => ({
    filePath,
    source: readFile(filePath),
  }));
  const routeSources = routeFiles.map((file) => file.source);
  const restRouteSources = routeFiles
    .filter((file) => basename(file.filePath) !== 'ipc.ts')
    .map((file) => file.source);

  const endpointMappings = parseCloudRouterEndpointMappings(cloudRouterSource);
  if (endpointMappings.length === 0) {
    warnings.push(
      `No static CHANNEL_TO_ENDPOINT mappings parsed from ${relative(repoRoot, paths.cloudRouterFile)}.`,
    );
  }
  const endpointMappingsByChannel = new Map(endpointMappings.map((mapping) => [mapping.channel, mapping]));

  const routeHandlersByPath = parseServerHandlersByPath(serverSource);
  const exportedRouteHandlers = parseExportedRouteHandlers(routeSources);

  violations.push(
    ...findIpcViolations({ policies, ipcRouteSource, allowlistedChannels }),
    ...findRestViolations({
      policies,
      serverSource,
      restRouteSources,
      routeHandlersByPath,
      exportedRouteHandlers,
      endpointMappings: endpointMappingsByChannel,
      allowlistedChannels,
    }),
    ...findWsViolations({
      policies,
      serverSource,
      routeSources,
      endpointMappings: endpointMappingsByChannel,
      allowlistedChannels,
    }),
  );

  violations.sort((a, b) => a.channel.localeCompare(b.channel) || a.reason.localeCompare(b.reason));
  return { policies, violations, warnings };
}

export function main(): void {
  const result = findCloudChannelParityViolations();

  for (const warning of result.warnings) {
    process.stderr.write(`[cloud-channel-parity] warning: ${warning}\n`);
  }

  if (result.violations.length > 0) {
    process.stderr.write(
      `Cloud channel parity check failed (${result.violations.length} violation${result.violations.length === 1 ? '' : 's'}).\n`,
    );
    for (const violation of result.violations) {
      process.stderr.write(
        `  - [${violation.transport}] ${violation.channel}: ${violation.reason}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `Cloud channel parity check passed (${result.policies.length} channel${result.policies.length === 1 ? '' : 's'} scanned).\n`,
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
