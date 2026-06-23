import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillCatalogIds, getMcpServerNames, isServerEnabled } from '../mcpConfigManager';

describe('isServerEnabled', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-config-enabled-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  it('returns true when the server exists and is not disabled', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      configPaths: [],
      mcpServers: {
        RebelOffice: { command: 'node', args: ['office-server.js'] },
      },
    }), 'utf8');

    await expect(isServerEnabled(configPath, 'RebelOffice')).resolves.toBe(true);
  });

  it('returns false when the server exists but is disabled', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      configPaths: [],
      mcpServers: {
        RebelOffice: { command: 'node', args: ['office-server.js'] },
      },
      disabledServers: ['RebelOffice'],
    }), 'utf8');

    await expect(isServerEnabled(configPath, 'RebelOffice')).resolves.toBe(false);
  });

  it('returns false when the server is absent', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      configPaths: [],
      mcpServers: {
        Slack: { command: 'node', args: ['slack-server.js'] },
      },
    }), 'utf8');

    await expect(isServerEnabled(configPath, 'RebelOffice')).resolves.toBe(false);
  });
});

describe('HubSpot legacy catalogId backfill', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-config-hubspot-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `router-${Date.now()}.json`);
  });

  it('preserves HubSpot and HubSpot-<email> mapping for legacy rebel-oss backfill', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      configPaths: [],
      mcpServers: {
        HubSpot: { command: 'node', args: ['hubspot/server.cjs'] },
        'HubSpot-acct1-example-com': { command: 'node', args: ['hubspot/server.cjs'] },
      },
    }, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(2);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { catalogId?: string }>;
    };
    expect(updated.mcpServers.HubSpot.catalogId).toBe('bundled-hubspot');
    expect(updated.mcpServers['HubSpot-acct1-example-com'].catalogId).toBe('bundled-hubspot');
  });
});

describe('malformed super-mcp-router.json backup hardening (F3)', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-malformed-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes the malformed router backup with 0600 permissions', async () => {
    if (process.platform === 'win32') return;
    const configPath = path.join(tempDir, 'super-mcp-router.json');
    // Malformed JSON containing a plaintext secret.
    await fs.writeFile(configPath, '{ "mcpServers": { "X": { "env": { "API_KEY": "fake-secret" } } ', 'utf8');

    // Triggers readConfig() -> backupMalformedConfig() on parse failure.
    await getMcpServerNames(configPath);

    const dirEntries = await fs.readdir(tempDir);
    const backupName = dirEntries.find((name) => name.startsWith('super-mcp-router.json.malformed-'));
    expect(backupName).toBeDefined();
    const backupPath = path.join(tempDir, backupName!);
    const stats = await fs.stat(backupPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
