// Regression test for the cloud-merge MCP-config path.
//
// Background: when Klavis was removed, the legacy `klavis.json` file is archived
// by `runKlavisMigration` (see `src/main/startup/klavisMigration.ts`) and any
// `mcpConfigFile` settings pointer that referenced it is rewritten to point at
// the canonical `super-mcp-router.json`.
//
// `readAndMergeMcpConfig` is the cloud-side counterpart that reads the user's
// `mcpConfigFile` (and any `configPaths` it transitively references) to package
// the MCP config for migration to the cloud brain.
//
// This test locks the invariant that `readAndMergeMcpConfig` does NOT have any
// implicit fallback to `klavis.json`: if `mcpConfigFile` is missing, it must
// return null cleanly without reading any default Klavis location, and if
// `mcpConfigFile` points at a Klavis-free config, no Klavis entries should
// appear in the merged output even when a stray `klavis.json` is present
// alongside it on disk.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock electron paths to keep the dynamic import in the SUT happy on Node.
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/mock-user-data',
}));

vi.mock('@main/utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => '/tmp/mock-oauth-tokens',
}));

import { readAndMergeMcpConfig } from '../cloudMigrationService';
import type { AppSettings } from '@shared/types';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/tmp/rebel-core',
    mcpConfigFile: null,
    cloudInstance: { mode: 'local' },
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    userFirstName: 'Test',
    onboardingFirstCompletedAt: 1700000000000,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: false,
    },
    claude: { apiKey: '', model: 'claude-sonnet-4-20250514' },
    diagnostics: { sentryEnabled: false },
    ...overrides,
  } as AppSettings;
}

describe('readAndMergeMcpConfig — never reads klavis.json by default', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-mcp-merge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when mcpConfigFile is null, even if a klavis.json exists alongside', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'klavis.json'),
      JSON.stringify({
        mcpServers: {
          'klavis-strata': { command: 'npx', args: ['-y', '@klavis-ai/strata'] },
        },
      }),
    );

    const settings = makeSettings({ mcpConfigFile: null, coreDirectory: tmpDir });
    const result = await readAndMergeMcpConfig(settings);

    expect(result).toBeNull();
  });

  it('reads only the configured mcpConfigFile and does not implicitly merge a sibling klavis.json', async () => {
    const routerPath = path.join(tmpDir, 'super-mcp-router.json');
    const klavisPath = path.join(tmpDir, 'klavis.json');

    fs.writeFileSync(
      routerPath,
      JSON.stringify({
        mcpServers: {
          GoogleWorkspace: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-google-workspace'],
          },
        },
      }),
    );

    // Stale Klavis config sitting next to the router — must NOT be merged in.
    fs.writeFileSync(
      klavisPath,
      JSON.stringify({
        mcpServers: {
          'klavis-strata': { command: 'npx', args: ['-y', '@klavis-ai/strata'] },
        },
      }),
    );

    const settings = makeSettings({ mcpConfigFile: routerPath, coreDirectory: tmpDir });
    const result = await readAndMergeMcpConfig(settings);

    expect(result).not.toBeNull();
    const serverNames = Object.keys(result!.config.mcpServers);
    expect(serverNames).toContain('GoogleWorkspace');
    expect(serverNames).not.toContain('klavis-strata');
  });
});
