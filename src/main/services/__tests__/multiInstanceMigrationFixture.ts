import { expect } from 'vitest';

interface MigrationRecord {
  readonly catalogId: string;
  readonly oldNames: readonly string[];
  readonly newName: string;
}

interface MigrationResult {
  readonly migrated: readonly MigrationRecord[];
}

interface MultiInstanceMigrationFixture {
  readonly catalogId: string;
  readonly configPath: string;
  readonly expectedInstanceIds: readonly string[];
  readonly expectedArgs?: readonly string[];
  readonly collapsedName?: string;
  readonly migrate: (configPath: string) => Promise<MigrationResult>;
  readonly readConfig: (configPath: string) => Promise<Record<string, unknown>>;
  readonly assertInstance?: (instanceId: string, server: Record<string, unknown>) => void;
}

/**
 * Reusable fixture assertion for rebel-oss multi-account/workspace migrations:
 * N legacy instances must remain N distinct `npx` instances after migration.
 */
export async function runMultiInstanceRebelOssMigrationFixture(
  fixture: MultiInstanceMigrationFixture,
): Promise<{
  readonly result: MigrationResult;
  readonly servers: Record<string, Record<string, unknown>>;
}> {
  const result = await fixture.migrate(fixture.configPath);
  const migrations = result.migrated.filter((migration) => migration.catalogId === fixture.catalogId);
  const expectedInstanceIds = [...fixture.expectedInstanceIds].sort();

  expect(migrations).toHaveLength(expectedInstanceIds.length);
  expect(migrations.map((migration) => migration.newName).sort()).toEqual(expectedInstanceIds);

  const config = await fixture.readConfig(fixture.configPath);
  const servers = readMcpServers(config);
  const retainedInstanceIds = expectedInstanceIds.filter((instanceId) => servers[instanceId] !== undefined);

  expect(retainedInstanceIds).toEqual(expectedInstanceIds);
  if (fixture.collapsedName) {
    expect(servers[fixture.collapsedName]).toBeUndefined();
  }

  for (const instanceId of expectedInstanceIds) {
    const server = servers[instanceId];
    expect(server?.command).toBe('npx');
    if (fixture.expectedArgs) {
      expect(server?.args).toEqual(fixture.expectedArgs);
    }
    if (server) {
      fixture.assertInstance?.(instanceId, server);
    }
  }

  return { result, servers };
}

function readMcpServers(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const servers = config.mcpServers;
  expect(isRecord(servers)).toBe(true);
  return servers as Record<string, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
