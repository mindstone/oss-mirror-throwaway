import type { ConnectorCatalogEntry } from '@shared/types/mcp';
import type { ProviderKeyId, ProviderKeys } from '@shared/types/settings';

const NPM_SPEC_PATTERN = /^@[^/]+\/[^@]+@[^@]+$/;

type McpServerConfigEntry = {
  command?: unknown;
  args?: unknown;
  env?: Record<string, unknown>;
};

export type McpServersConfig = {
  mcpServers?: Record<string, McpServerConfigEntry>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isUnresolvedProviderKeySlot = (value: unknown, envKey: string): boolean => {
  return value === '' || value === `{{${envKey}}}`;
};

const extractNpxPackageSpec = (command: unknown, args: unknown): string | null => {
  if (command !== 'npx' || !Array.isArray(args)) {
    return null;
  }

  const yesIndex = args.findIndex((arg) => arg === '-y');
  if (yesIndex < 0 || yesIndex + 1 >= args.length) {
    return null;
  }

  const maybeSpec = args[yesIndex + 1];
  if (typeof maybeSpec !== 'string' || !NPM_SPEC_PATTERN.test(maybeSpec)) {
    return null;
  }

  return maybeSpec;
};

const buildRebelOssCatalogLookup = (
  catalog: readonly ConnectorCatalogEntry[],
): Map<string, Partial<Record<string, ProviderKeyId>>> => {
  const lookup = new Map<string, Partial<Record<string, ProviderKeyId>>>();

  for (const entry of catalog) {
    if (entry.provider !== 'rebel-oss') continue;

    const packageSpec = extractNpxPackageSpec(entry.mcpConfig?.command, entry.mcpConfig?.args);
    const providerKeyMapping = entry.bundledConfig?.providerKeyMapping;
    if (!packageSpec || !providerKeyMapping || Object.keys(providerKeyMapping).length === 0) {
      continue;
    }

    lookup.set(packageSpec, providerKeyMapping);
  }

  return lookup;
};

/**
 * Re-resolve provider key mappings for managed rebel-oss MCP entries in a cloud
 * Super-MCP router config.
 *
 * A slot is treated as unresolved iff it is exactly `''` or exactly
 * `'{{' + envKey + '}}'`. Non-empty literals (including `{{...}}` strings that
 * do not exactly match `'{{' + envKey + '}}'`) are preserved.
 *
 * Mutates `mcpServersConfig` in place and returns the number of connector
 * entries where at least one mapped slot was resolved.
 */
export function resolveProviderKeyMappingsInMcpConfig(
  mcpServersConfig: McpServersConfig,
  catalog: readonly ConnectorCatalogEntry[],
  providerKeys: ProviderKeys | undefined,
): number {
  if (!isRecord(mcpServersConfig.mcpServers)) {
    return 0;
  }

  const providerMappingBySpec = buildRebelOssCatalogLookup(catalog);
  if (providerMappingBySpec.size === 0) {
    return 0;
  }

  let resolvedConnectorCount = 0;
  for (const serverEntry of Object.values(mcpServersConfig.mcpServers)) {
    if (!isRecord(serverEntry)) continue;

    const packageSpec = extractNpxPackageSpec(serverEntry.command, serverEntry.args);
    if (!packageSpec) continue;

    const providerKeyMapping = providerMappingBySpec.get(packageSpec);
    if (!providerKeyMapping) continue;

    if (!isRecord(serverEntry.env)) continue;
    const env = serverEntry.env;

    let resolvedThisEntry = false;
    for (const [envKey, providerId] of Object.entries(providerKeyMapping)) {
      if (!providerId || !isUnresolvedProviderKeySlot(env[envKey], envKey)) continue;

      env[envKey] = providerKeys?.[providerId]?.trim() ?? '';
      resolvedThisEntry = true;
    }

    if (resolvedThisEntry) {
      resolvedConnectorCount += 1;
    }
  }

  return resolvedConnectorCount;
}
