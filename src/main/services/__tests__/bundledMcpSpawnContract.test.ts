/**
 * Bridge-state spawn contract — integration-level invariant.
 *
 * For every rebel-* split MCP the host knows how to launch, this test:
 *   1. Builds the spawn payload via the catalog/payload builder.
 *   2. Reads the bundled child script the payload points to (server.cjs).
 *   3. Greps the script for every `process.env.<KEY>` where KEY ends in
 *      `_BRIDGE_STATE` (excluding REBEL_APP_BRIDGE_STATE, which is a
 *      different bridge).
 *   4. Asserts every key the script reads is present in payload.env, with
 *      the same value as the writer's bridge-state path.
 *
 * Catches the May-2026 regression class: writer renames an env var without
 * updating the readers (or vice versa), which manifests at runtime as the
 * bridge call returning undefined, the call silently no-op'ing, and
 * super-mcp surfacing -33004 PACKAGE_UNAVAILABLE.
 *
 * Sibling defenses:
 *   - scripts/check-bridge-state-readers.ts (CI gate, parses the same data
 *     statically without spinning up the manager).
 *   - bridgeStateEnv() retirement checklist in bundledMcpManager.ts.
 *
 * See docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  configureBundledMcpManager,
  buildSplitRebelInboxPayload,
  buildSplitRebelMeetingsPayload,
  buildSplitRebelSearchAndConversationsPayload,
  buildSplitRebelAutomationsPayload,
  buildSplitRebelSpacesPayload,
  buildSplitRebelSettingsPayload,
  buildSplitRebelMcpConnectorsPayload,
  buildSplitRebelPluginsPayload,
} from '../bundledMcpManager';
import type { McpServerUpsertPayload } from '@shared/types';

const APP_BRIDGE_STATE_KEY = 'REBEL_APP_BRIDGE_STATE';
const BRIDGE_STATE_KEY_RE = /process\.env\.([A-Z][A-Z0-9_]*_BRIDGE_STATE)\b/g;

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const realResourcesDir = path.join(repoRoot, 'resources');

interface SpawnCase {
  label: string;
  buildPayload: () => McpServerUpsertPayload;
  /** Directory under resources/mcp/ that the payload's args[0] points to. */
  scriptDir: string;
}

const SPAWN_CASES: SpawnCase[] = [
  { label: 'RebelInbox', buildPayload: buildSplitRebelInboxPayload, scriptDir: 'rebel-inbox' },
  { label: 'RebelMeetings', buildPayload: buildSplitRebelMeetingsPayload, scriptDir: 'rebel-meetings' },
  {
    label: 'RebelSearchAndConversations',
    buildPayload: buildSplitRebelSearchAndConversationsPayload,
    scriptDir: 'rebel-search-and-conversations',
  },
  { label: 'RebelAutomations', buildPayload: buildSplitRebelAutomationsPayload, scriptDir: 'rebel-automations' },
  { label: 'RebelSpaces', buildPayload: buildSplitRebelSpacesPayload, scriptDir: 'rebel-spaces' },
  { label: 'RebelSettings', buildPayload: buildSplitRebelSettingsPayload, scriptDir: 'rebel-settings' },
  {
    label: 'RebelMcpConnectors',
    buildPayload: buildSplitRebelMcpConnectorsPayload,
    scriptDir: 'rebel-mcp-connectors',
  },
  { label: 'RebelPlugins', buildPayload: buildSplitRebelPluginsPayload, scriptDir: 'rebel-plugins' },
];

describe('bundled MCP spawn contract — bridge-state env vars', () => {
  let tempUserData: string;

  beforeAll(async () => {
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-spawn-contract-'));
    configureBundledMcpManager({
      userDataDir: tempUserData,
      resourcesDir: realResourcesDir,
      isPackaged: false,
    });
  });

  afterAll(async () => {
    await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
  });

  for (const testCase of SPAWN_CASES) {
    it(`${testCase.label}: every bridge-state key the child reads is present in the spawn env`, async () => {
      const payload = testCase.buildPayload();
      const scriptPath = payload.args?.[0];
      expect(scriptPath, `${testCase.label} payload missing script path`).toBeTruthy();
      expect(
        scriptPath!.includes(testCase.scriptDir),
        `${testCase.label} script path should include ${testCase.scriptDir}, got ${scriptPath}`
      ).toBe(true);

      const scriptSource = await fs.readFile(scriptPath!, 'utf8');
      const readKeys = new Set<string>();
      for (const m of scriptSource.matchAll(BRIDGE_STATE_KEY_RE)) {
        const key = m[1];
        if (key === APP_BRIDGE_STATE_KEY) continue;
        readKeys.add(key);
      }

      expect(
        readKeys.size,
        `${testCase.label} server.cjs reads no *_BRIDGE_STATE key — split rebel-* MCPs all need bridge access. ` +
          `If this MCP is being retired from the bridge, also remove it from SPAWN_CASES.`
      ).toBeGreaterThan(0);

      const env = payload.env ?? {};
      const expectedPath = env.MCP_HOST_BRIDGE_STATE ?? env.MINDSTONE_REBEL_BRIDGE_STATE;
      expect(
        expectedPath,
        `${testCase.label} payload env carries no bridge-state path at all`
      ).toBeTruthy();

      for (const key of readKeys) {
        expect(
          env[key],
          `${testCase.label} server.cjs reads process.env.${key}, but the spawn payload doesn't set it. ` +
            `Either add ${key} to bridgeStateEnv() in bundledMcpManager.ts (dual-write during transition), ` +
            `or update the child script to read a key the host already emits. See ` +
            `docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md.`
        ).toBeDefined();
        expect(
          env[key],
          `${testCase.label}: env.${key} must equal the canonical bridge-state path (other writer keys point there).`
        ).toBe(expectedPath);
      }
    });
  }
});
