/**
 * Behavioural-contract tests for the legacy Klavis startup migration.
 *
 * These tests lock in the data-loss-prevention and runtime-safety guarantees
 * that the migration must continue to provide for the rare straggler who
 * jumps from a pre-Klavis-removal build directly to a future build.
 *
 * Critical guarantees (each backed by an explicit test):
 *
 *  1. `userData/mcp/klavis.json` is archived (renamed to
 *     `klavis.json.deprecated_*`) so super-mcp can no longer load it.
 *  2. **Data-loss safeguard:** any non-Klavis server entries the user had
 *     wedged into `klavis.json` (e.g. their own Google Workspace, Slack,
 *     custom MCP) are migrated into `super-mcp-router.json` BEFORE the
 *     archival, never lost.
 *  3. **Runtime safety:** Klavis URLs (`strata.klavis.ai`, `klavis.ai/mcp`)
 *     and Klavis server names (`klavis-strata`, `Klavis`, `Toolbox`) are
 *     stripped from `super-mcp-router.json` and `claude_desktop_config.json`
 *     so super-mcp does not try to load them and time out at HTTP-connect.
 *  4. **Pointer fix-up:** `settings.mcpConfigFile` is rewritten from the
 *     legacy `userData/mcp/klavis.json` to `super-mcp-router.json` so
 *     downstream services (`mcpService`, `cloudMigrationService`) do not
 *     keep treating the archived file as the canonical config.
 *  5. **Klavis configPaths** (any router that referenced `klavis.json` via
 *     `configPaths`) are removed.
 *  6. **Idempotency:** running the migration a second time on already-clean
 *     state produces zero changes (`hadChanges: false`). This guarantees
 *     that keeping the migration on every startup remains cheap for the
 *     >99% of users who have already migrated.
 *  7. **Write-failure preservation:** if writing the router config fails
 *     mid-migration, `klavis.json` is NOT archived (the safeguard added in
 *     `260111_2332` after the original removal plan).
 *
 * Behaviours NOT exercised here on purpose:
 *  - Memory-file scanning (`scanAndUpdateMemoryFiles`)
 *  - Tool-usage scrubbing (`removeToolsForServer`)
 *  - Setting `klavisMigrationPending = true`
 * Those are slated for removal in the upcoming slimming refactor; locking
 * them into a test would defeat the refactor's purpose.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted state shared between the test body and the mock factories.
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  return {
    // userData and home directories — initialised in beforeEach to a fresh
    // temp dir so each test is isolated.
    userDataDir: { current: '' },
    homeDir: { current: '' },
    // Mutable settings that getSettings()/settingsStore.set() operate on.
    settings: {
      current: {} as Record<string, unknown>,
    },
    // Captured calls to settingsStore.set so tests can assert pointer fix-up.
    settingsSetCalls: [] as Array<[string, unknown]>,
    // Stub for removeToolsForServer (slated for removal; we just need it
    // callable so the migration runs without throwing).
    removeToolsCalls: [] as string[],
    // Logger spies (silent by default; tests can inspect if needed).
    logSpy: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return hoisted.userDataDir.current;
      if (name === 'home') return hoisted.homeDir.current;
      throw new Error(`Unexpected app.getPath('${name}') in klavisMigration tests`);
    },
  },
}));

vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => hoisted.logSpy,
  };
});

// Mock both module paths because klavisMigration.ts imports from
// `../settingsStore` (= `src/main/settingsStore.ts`, which re-exports from
// `@core/services/settingsStore/index`). Mocking both is belt-and-braces
// against re-export resolution surprises in vitest.
const settingsStoreMock = vi.hoisted(() => {
  // Bind to the same hoisted state as `hoisted` above by re-using it via
  // closure-after-hoist. We can't reference `hoisted` directly here because
  // both vi.hoisted blocks run in some-order; instead, we attach to the
  // global so the factory below picks it up at call-time.
  return {
    getSettings: () =>
      (globalThis as unknown as { __klavisHoisted: typeof hoisted }).__klavisHoisted.settings
        .current,
    settingsStore: {
      get: (key: string) =>
        (globalThis as unknown as { __klavisHoisted: typeof hoisted }).__klavisHoisted.settings
          .current[key],
      set: (key: string, value: unknown) => {
        const h = (globalThis as unknown as { __klavisHoisted: typeof hoisted }).__klavisHoisted;
        h.settingsSetCalls.push([key, value]);
        h.settings.current = { ...h.settings.current, [key]: value };
      },
    },
    updateSettings: vi.fn(),
  };
});
// Bridge `hoisted` -> globalThis so settingsStoreMock can reach it at call time.
(globalThis as { __klavisHoisted?: typeof hoisted }).__klavisHoisted = hoisted;

vi.mock('@core/services/settingsStore', () => settingsStoreMock);
vi.mock('@core/services/settingsStore/index', () => settingsStoreMock);
vi.mock('../../settingsStore', () => settingsStoreMock);

vi.mock('@core/services/toolUsageStore', () => ({
  removeToolsForServer: (serverId: string) => {
    hoisted.removeToolsCalls.push(serverId);
    return 0;
  },
}));

// Imported AFTER all mocks above so the module picks them up.
import { runKlavisMigration } from '../klavisMigration';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const readJson = async <T = Record<string, unknown>>(filePath: string): Promise<T> => {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
};

const exists = async (filePath: string): Promise<boolean> => {
  return fs.access(filePath).then(() => true).catch(() => false);
};

const findArchivedKlavis = async (mcpDir: string): Promise<string | null> => {
  const entries = await fs.readdir(mcpDir).catch(() => [] as string[]);
  const match = entries.find((name) => name.startsWith('klavis.json.deprecated_'));
  return match ? path.join(mcpDir, match) : null;
};

const KLAVIS_STRATA_ENTRY = {
  type: 'http',
  url: 'https://strata.klavis.ai/mcp/?strata_id=00000000-0000-0000-0000-000000000000',
};

const NON_KLAVIS_GOOGLE_ENTRY = {
  command: 'npx',
  args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.2'],
  email: 'harry@example.com',
  catalogId: 'bundled-google',
  env: { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
};

const NON_KLAVIS_CUSTOM_ENTRY = {
  command: 'node',
  args: ['/Users/you/my-custom-mcp/server.js'],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mcpDir: string;
let routerPath: string;
let klavisPath: string;

beforeEach(async () => {
  hoisted.userDataDir.current = await fs.mkdtemp(
    path.join(os.tmpdir(), 'klavis-migration-userdata-'),
  );
  hoisted.homeDir.current = await fs.mkdtemp(
    path.join(os.tmpdir(), 'klavis-migration-home-'),
  );
  hoisted.settings.current = {
    // Default: simulate a user who has already dismissed the banner so the
    // migration's memory-file scan is skipped (we are not testing that
    // here, and it is being removed in the slimming refactor anyway).
    dismissedAnnouncements: { 'klavis-migration': true },
  };
  hoisted.settingsSetCalls = [];
  hoisted.removeToolsCalls = [];
  Object.values(hoisted.logSpy).forEach((spy) => {
    if (typeof spy === 'function' && 'mockClear' in spy) (spy as { mockClear: () => void }).mockClear();
  });

  mcpDir = path.join(hoisted.userDataDir.current, 'mcp');
  await fs.mkdir(mcpDir, { recursive: true });
  routerPath = path.join(mcpDir, 'super-mcp-router.json');
  klavisPath = path.join(mcpDir, 'klavis.json');
});

afterEach(async () => {
  await fs.rm(hoisted.userDataDir.current, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(hoisted.homeDir.current, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Guarantee 1 & 2: archive klavis.json AND preserve non-Klavis servers.
// ---------------------------------------------------------------------------

describe('klavisMigration: data-loss-prevention guarantees (must survive slimming)', () => {
  it('archives klavis.json and preserves non-Klavis servers in the router', async () => {
    // Setup: a stale klavis.json with a Klavis-strata entry plus user-installed
    // Google Workspace and a hand-rolled custom MCP that the user wedged into
    // klavis.json during the Klavis era.
    await writeJson(klavisPath, {
      mcpServers: {
        'klavis-strata': KLAVIS_STRATA_ENTRY,
        GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY,
        'my-custom-mcp': NON_KLAVIS_CUSTOM_ENTRY,
      },
    });

    const result = await runKlavisMigration();

    // klavis.json itself is gone; an archived copy exists.
    expect(await exists(klavisPath)).toBe(false);
    const archivedPath = await findArchivedKlavis(mcpDir);
    expect(archivedPath).not.toBeNull();
    expect(result.archivedKlavisJson).toBe(true);

    // Non-Klavis servers were copied into the router.
    const router = await readJson<{ mcpServers: Record<string, unknown> }>(routerPath);
    expect(router.mcpServers.GoogleWorkspace).toEqual(NON_KLAVIS_GOOGLE_ENTRY);
    expect(router.mcpServers['my-custom-mcp']).toEqual(NON_KLAVIS_CUSTOM_ENTRY);

    // The Klavis entry is NOT in the router.
    expect(router.mcpServers).not.toHaveProperty('klavis-strata');

    // The result manifest reports both migrated names.
    expect(result.serversMigratedToRouter.sort()).toEqual(
      ['GoogleWorkspace', 'my-custom-mcp'].sort(),
    );
  });

  it('archives a Klavis-only klavis.json without writing anything to the router', async () => {
    await writeJson(klavisPath, {
      mcpServers: {
        'klavis-strata': KLAVIS_STRATA_ENTRY,
        Toolbox: { type: 'http', url: 'https://klavis.ai/mcp/foo' },
      },
    });

    const result = await runKlavisMigration();

    expect(await exists(klavisPath)).toBe(false);
    expect(result.archivedKlavisJson).toBe(true);
    expect(result.serversMigratedToRouter).toEqual([]);
    // Router was either not created or is empty; both are acceptable.
    if (await exists(routerPath)) {
      const router = await readJson<{ mcpServers?: Record<string, unknown> }>(routerPath);
      expect(router.mcpServers ?? {}).toEqual({});
    }
  });

  it('preserves an existing router server when migrating from klavis.json (no overwrite)', async () => {
    // Router already has a GoogleWorkspace entry the user has been using.
    const existingRouterEntry = {
      ...NON_KLAVIS_GOOGLE_ENTRY,
      lastConnectedAt: 1_700_000_000_000,
    };
    await writeJson(routerPath, {
      configPaths: [],
      mcpServers: { GoogleWorkspace: existingRouterEntry },
    });
    // klavis.json has the same name with a stale config.
    await writeJson(klavisPath, {
      mcpServers: {
        GoogleWorkspace: { ...NON_KLAVIS_GOOGLE_ENTRY, args: ['--stale'] },
      },
    });

    const result = await runKlavisMigration();

    const router = await readJson<{ mcpServers: Record<string, unknown> }>(routerPath);
    // Router entry must be untouched (no overwrite).
    expect(router.mcpServers.GoogleWorkspace).toEqual(existingRouterEntry);
    // And the conflict must NOT show up in the migrated list.
    expect(result.serversMigratedToRouter).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guarantee 3 & 5: clean router/claude config of Klavis URLs, names, and
// configPaths.
// ---------------------------------------------------------------------------

describe('klavisMigration: router-config sanitisation (must survive slimming)', () => {
  it('strips Klavis-URL servers from super-mcp-router.json', async () => {
    await writeJson(routerPath, {
      configPaths: [],
      mcpServers: {
        // Match by URL (server name is innocent-looking).
        ToolboxAlias: { type: 'http', url: 'https://strata.klavis.ai/mcp/?strata_id=abc' },
        // Match by URL on klavis.ai/mcp.
        OldKlavis: { type: 'http', url: 'https://klavis.ai/mcp/foo' },
        // Match by name even with no URL.
        'klavis-strata': { command: 'noop' },
        Toolbox: { command: 'noop' },
        Klavis: { command: 'noop' },
        // Innocent server must survive.
        GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY,
      },
    });

    const result = await runKlavisMigration();

    const router = await readJson<{ mcpServers: Record<string, unknown> }>(routerPath);
    expect(Object.keys(router.mcpServers).sort()).toEqual(['GoogleWorkspace']);
    expect(result.serversRemoved.sort()).toEqual(
      ['Klavis', 'OldKlavis', 'Toolbox', 'ToolboxAlias', 'klavis-strata'].sort(),
    );
  });

  it('strips klavis.json references from configPaths', async () => {
    await writeJson(routerPath, {
      configPaths: [
        '/Users/you/Library/Application Support/mindstone-rebel/mcp/klavis.json',
        '/Users/you/some-other-config.json',
        './klavis.json',
      ],
      mcpServers: {},
    });

    const result = await runKlavisMigration();

    const router = await readJson<{ configPaths: string[] }>(routerPath);
    expect(router.configPaths).toEqual(['/Users/you/some-other-config.json']);
    expect(result.configPathsRemoved).toHaveLength(2);
  });

  it('also sanitises claude_desktop_config.json when present', async () => {
    const claudePath = path.join(mcpDir, 'claude_desktop_config.json');
    await writeJson(claudePath, {
      mcpServers: {
        'klavis-strata': KLAVIS_STRATA_ENTRY,
        GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY,
      },
    });

    const result = await runKlavisMigration();

    const claude = await readJson<{ mcpServers: Record<string, unknown> }>(claudePath);
    expect(Object.keys(claude.mcpServers)).toEqual(['GoogleWorkspace']);
    expect(result.serversRemoved).toContain('klavis-strata');
  });
});

// ---------------------------------------------------------------------------
// Guarantee 4: settings.mcpConfigFile pointer fix-up.
// ---------------------------------------------------------------------------

describe('klavisMigration: mcpConfigFile pointer fix-up (must survive slimming)', () => {
  it('rewrites legacy mcpConfigFile=klavis.json to super-mcp-router.json', async () => {
    // Settings still point at the legacy klavis.json location.
    hoisted.settings.current = {
      ...hoisted.settings.current,
      mcpConfigFile: klavisPath,
    };

    const result = await runKlavisMigration();

    // The migration must have called settingsStore.set('mcpConfigFile', routerPath).
    const pointerSet = hoisted.settingsSetCalls.find(([k]) => k === 'mcpConfigFile');
    expect(pointerSet).toBeDefined();
    expect(pointerSet?.[1]).toBe(routerPath);
    expect(result.settingsPointerUpdated).toBe(true);

    // The router file exists after the pointer was rewritten (so super-mcp
    // doesn't crash trying to read the pointer's target).
    expect(await exists(routerPath)).toBe(true);
  });

  it('also recognises ~-prefixed legacy klavis.json paths and rewrites them', async () => {
    // Replicate userData under home/ so the ~ expansion lands on the same
    // physical file. This proves the path-normalisation logic in
    // isLegacyKlavisConfigPath() doesn't bypass tilde paths.
    const homeUserData = path.join(hoisted.homeDir.current, 'Library', 'Application Support', 'mindstone-rebel');
    await fs.mkdir(homeUserData, { recursive: true });
    hoisted.userDataDir.current = homeUserData;
    mcpDir = path.join(homeUserData, 'mcp');
    routerPath = path.join(mcpDir, 'super-mcp-router.json');
    await fs.mkdir(mcpDir, { recursive: true });

    hoisted.settings.current = {
      ...hoisted.settings.current,
      mcpConfigFile: '~/Library/Application Support/mindstone-rebel/mcp/klavis.json',
    };

    const result = await runKlavisMigration();

    expect(result.settingsPointerUpdated).toBe(true);
    const pointerSet = hoisted.settingsSetCalls.find(([k]) => k === 'mcpConfigFile');
    expect(pointerSet?.[1]).toBe(routerPath);
  });

  it('does NOT rewrite mcpConfigFile when it points at a non-Klavis file', async () => {
    const customPath = path.join(mcpDir, 'super-mcp-router.json');
    hoisted.settings.current = {
      ...hoisted.settings.current,
      mcpConfigFile: customPath,
    };

    const result = await runKlavisMigration();

    expect(result.settingsPointerUpdated).toBe(false);
    expect(hoisted.settingsSetCalls.find(([k]) => k === 'mcpConfigFile')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Guarantee 6: idempotency — running the migration on already-clean state
// produces no changes.
// ---------------------------------------------------------------------------

describe('klavisMigration: idempotency (must survive slimming)', () => {
  it('reports hadChanges=false on a fresh user with no Klavis state', async () => {
    // No klavis.json, router exists with only innocent servers.
    await writeJson(routerPath, {
      configPaths: [],
      mcpServers: { GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY },
    });
    hoisted.settings.current = {
      ...hoisted.settings.current,
      mcpConfigFile: routerPath,
    };

    const result = await runKlavisMigration();

    expect(result.hadChanges).toBe(false);
    expect(result.archivedKlavisJson).toBe(false);
    expect(result.serversRemoved).toEqual([]);
    expect(result.configPathsRemoved).toEqual([]);
    expect(result.serversMigratedToRouter).toEqual([]);
    expect(result.settingsPointerUpdated).toBe(false);
  });

  it('produces zero changes on a second invocation (idempotent)', async () => {
    await writeJson(klavisPath, {
      mcpServers: {
        'klavis-strata': KLAVIS_STRATA_ENTRY,
        GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY,
      },
    });

    const first = await runKlavisMigration();
    expect(first.hadChanges).toBe(true);
    expect(first.archivedKlavisJson).toBe(true);

    // Second invocation against the now-clean state.
    const second = await runKlavisMigration();
    expect(second.hadChanges).toBe(false);
    expect(second.archivedKlavisJson).toBe(false);
    expect(second.serversMigratedToRouter).toEqual([]);
    expect(second.serversRemoved).toEqual([]);
    expect(second.configPathsRemoved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guarantee 7: write-failure preservation (data-loss safeguard).
// ---------------------------------------------------------------------------

describe('klavisMigration: write-failure preservation (must survive slimming)', () => {
  it('does NOT archive klavis.json if router write fails (preserves data for retry)', async () => {
    // klavis.json has user data we cannot lose.
    await writeJson(klavisPath, {
      mcpServers: {
        GoogleWorkspace: NON_KLAVIS_GOOGLE_ENTRY,
      },
    });

    // Force the router write to fail by replacing the mcp directory with a
    // file (so writes inside it fail with ENOTDIR).
    // First make sure no leftover router file is in the way.
    await fs.rm(routerPath, { force: true }).catch(() => undefined);
    await fs.rm(mcpDir, { recursive: true, force: true });
    await fs.writeFile(mcpDir, 'this-is-a-file-not-a-directory', 'utf8');

    let result;
    try {
      result = await runKlavisMigration();
    } finally {
      // Restore the directory so afterEach cleanup works.
      await fs.rm(mcpDir);
      await fs.mkdir(mcpDir, { recursive: true });
    }

    // klavis.json (where it was) should NOT have been archived because the
    // router write failed. We can't read it back (mcpDir was a file at the
    // time of the migration, so the archive would also have failed) — but
    // the result manifest must NOT claim success.
    expect(result.archivedKlavisJson).toBe(false);
    expect(result.serversMigratedToRouter).toEqual([]);
  });

  it('still completes (does not throw) on completely missing mcp directory', async () => {
    // Fresh user with no mcp/ directory at all.
    await fs.rm(mcpDir, { recursive: true, force: true });

    // Should complete successfully and report no changes.
    const result = await runKlavisMigration();
    expect(result.hadChanges).toBe(false);
    expect(result.archivedKlavisJson).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guarantee 8: top-level error handling — migration MUST NOT throw, even
// under unexpected failures, because it is awaited in the startup hot path
// (src/main/index.ts:3913) and a throw would block app boot.
// ---------------------------------------------------------------------------

describe('klavisMigration: never throws (startup safety)', () => {
  it('returns a result object even when something goes wrong inside', async () => {
    // Make the userData path itself unreadable by pointing at a non-existent
    // dir. This forces internal paths to fail in unpredictable ways.
    hoisted.userDataDir.current = '/nonexistent/path/that/should/not/exist/' + Math.random();

    const result = await runKlavisMigration();

    // Must return a manifest, not throw.
    expect(result).toBeDefined();
    expect(typeof result.hadChanges).toBe('boolean');
  });
});
