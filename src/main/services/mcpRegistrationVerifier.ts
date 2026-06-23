import path from 'node:path';
import { getPlatformConfig } from '@core/platform';
import { getMcpServerNames, readMcpServerDetails } from '@core/services/mcpConfigManager';
import { toPortablePath } from '@core/utils/portablePath';

export interface RegistrationVerifierOptions {
  log?: {
    warn: (...args: unknown[]) => void;
  };
}

export type ConnectorRegistrationVerificationResult =
  | { matched: true; matchedName: string; matchKind: 'name' | 'path' }
  | { matched: false };

/**
 * Exported for unit testing. Returns true for both POSIX absolute paths
 * (leading `/`) AND Windows absolute paths (drive letter + `:` + either
 * `/` or `\`). Works on any host OS — Darwin CI can still validate that
 * Windows-style args pass the gate.
 */
export function isAbsoluteCrossPlatformForTests(p: string): boolean {
  return isAbsoluteCrossPlatform(p);
}

function isAbsoluteCrossPlatform(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Collect canonical server paths from an MCP server's args. Iterates every
 * path-style arg (handling `~/` expansion and Windows `C:/...` or `C:\...`).
 */
export function collectServerPathsFromArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const paths: string[] = [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    let expandedArg = arg;
    if (expandedArg.startsWith('~/') || expandedArg.startsWith('~\\')) {
      expandedArg = path.join(getPlatformConfig().homePath, expandedArg.slice(2));
    }
    if (!isAbsoluteCrossPlatform(expandedArg)) continue;
    try {
      const resolved = path.resolve(expandedArg);
      paths.push(toPortablePath(resolved).toLowerCase());
    } catch {
      continue;
    }
  }
  return paths;
}

/**
 * Verify whether any MCP server in the config registers this contribution.
 *
 * Matching rules:
 *   1. If `localServerPath` is present, path match is authoritative.
 *   2. Name-only matching is used only when no path is available.
 */
export async function verifyConnectorRegistration(
  configPath: string,
  connectorName: string,
  localServerPath: string | undefined,
  options?: RegistrationVerifierOptions,
): Promise<ConnectorRegistrationVerificationResult> {
  const serverNames = await getMcpServerNames(configPath);

  if (!localServerPath) {
    if (serverNames.includes(connectorName)) {
      return { matched: true, matchedName: connectorName, matchKind: 'name' };
    }
    return { matched: false };
  }

  const normalizedContribPath = toPortablePath(localServerPath).toLowerCase();
  for (const name of serverNames) {
    let details: Awaited<ReturnType<typeof readMcpServerDetails>>;
    try {
      details = await readMcpServerDetails(configPath, name);
    } catch (err) {
      options?.log?.warn(
        { err, configPath, connectorName: name },
        'MCP registration verifier: readMcpServerDetails threw; skipping this server entry',
      );
      continue;
    }
    const serverPaths = collectServerPathsFromArgs(details.args);
    for (const serverCanonicalPath of serverPaths) {
      if (serverCanonicalPath === normalizedContribPath) {
        return { matched: true, matchedName: name, matchKind: 'path' };
      }
      if (serverCanonicalPath.startsWith(normalizedContribPath + '/')) {
        return { matched: true, matchedName: name, matchKind: 'path' };
      }
    }
  }

  return { matched: false };
}
