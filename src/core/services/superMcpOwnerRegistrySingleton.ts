import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { SuperMcpOwnerRegistry } from './superMcpOwnerRegistry';

const log = createScopedLogger({ service: 'superMcpOwnerRegistrySingleton' });

const DEFAULT_HEARTBEAT_FRESHNESS_MS = 30_000;
const MIN_HEARTBEAT_FRESHNESS_MS = 5_000;
const MAX_HEARTBEAT_FRESHNESS_MS = 600_000;

let ownerRegistrySingleton: SuperMcpOwnerRegistry | null = null;

export function getOwnerRegistry(): SuperMcpOwnerRegistry {
  if (!ownerRegistrySingleton) {
    ownerRegistrySingleton = new SuperMcpOwnerRegistry({
      registryDir: path.join(getDataPath(), 'mcp', 'active-owners'),
      freshnessWindowMs: resolveHeartbeatFreshnessWindowMs(
        process.env.REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS,
      ),
    });
  }
  return ownerRegistrySingleton;
}

function resolveHeartbeatFreshnessWindowMs(rawValue: string | undefined): number {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return DEFAULT_HEARTBEAT_FRESHNESS_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn(
      {
        envVar: 'REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS',
        rawValue,
        fallbackMs: DEFAULT_HEARTBEAT_FRESHNESS_MS,
      },
      'Invalid heartbeat freshness env override; using default',
    );
    return DEFAULT_HEARTBEAT_FRESHNESS_MS;
  }

  if (parsed < MIN_HEARTBEAT_FRESHNESS_MS) {
    return MIN_HEARTBEAT_FRESHNESS_MS;
  }
  if (parsed > MAX_HEARTBEAT_FRESHNESS_MS) {
    return MAX_HEARTBEAT_FRESHNESS_MS;
  }
  return parsed;
}
