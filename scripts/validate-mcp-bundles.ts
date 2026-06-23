#!/usr/bin/env npx tsx
/**
 * Smoke test for bundled MCP servers.
 * Spawns each server.cjs and verifies it doesn't crash immediately.
 * Run via: npx tsx scripts/validate-mcp-bundles.ts
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Per-MCP overrides for environment variables and CLI args needed during smoke tests.
 */
const MCP_TEST_OVERRIDES: Record<string, { env?: Record<string, string>; args?: string[] }> = {
  // Microsoft MCPs require MS_CONFIG_DIR and MS_CLIENT_ID to start
  'microsoft-mail': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-calendar': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-files': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-teams': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-sharepoint': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  // Google Workspace requires OAuth credentials
  'google-workspace': {
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ACCOUNTS_PATH: '/tmp/smoke-test/accounts.json',
      CREDENTIALS_PATH: '/tmp/smoke-test/credentials',
    },
  },
  // Discourse accepts --site but validates it via network on startup.
  // Omit it in smoke tests to avoid flaky failures from DNS/connectivity issues.
  // The bundle still loads and starts the MCP server without --site.
  // ElevenLabs requires API key (must start with sk_)
  'elevenlabs': { env: { ELEVENLABS_API_KEY: 'sk_test-dummy-key' } },
};

/**
 * Bundled MCPs to smoke test.
 * Source of truth: scripts/mcp-config.json
 */
const mcpConfig = JSON.parse(readFileSync(join(__dirname, 'mcp-config.json'), 'utf8'));
const BUNDLED_MCPS: Array<{ name: string; env?: Record<string, string>; args?: string[] }> =
  (mcpConfig.bundledMcps as string[]).map((name: string) => ({
    name,
    ...MCP_TEST_OVERRIDES[name],
  }));

const MCP_DIR = join(__dirname, '..', 'resources', 'mcp-generated');

const hasBundles = existsSync(MCP_DIR) && BUNDLED_MCPS.some(m => existsSync(join(MCP_DIR, m.name, 'server.cjs')));
if (!hasBundles) {
  console.log('⏭️  MCP Bundle Smoke Test — SKIPPED');
  console.log(`   No built bundles found in ${MCP_DIR} (run scripts/build-bundled-mcps.mjs first)\n`);
  process.exit(0);
}

async function testBundle(mcp: { name: string; env?: Record<string, string>; args?: string[] }): Promise<{ name: string; success: boolean; error?: string }> {
  const serverPath = join(MCP_DIR, mcp.name, 'server.cjs');
  
  if (!existsSync(serverPath)) {
    return { name: mcp.name, success: false, error: 'server.cjs not found' };
  }

  return new Promise((resolve) => {
    const proc = spawn('node', [serverPath, ...(mcp.args || [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', ...(mcp.env || {}) },
      timeout: 5000
    });

    let stderr = '';
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    // Track if process exited early (before timeout)
    let exited = false;

    // MCP servers wait for stdio input, so they should stay running
    // Give it 1 second to crash if it's going to
    const timeout = setTimeout(() => {
      if (!exited) {
        proc.kill('SIGTERM');
        resolve({ name: mcp.name, success: true });
      }
    }, 1000);

    proc.on('error', (err) => {
      exited = true;
      clearTimeout(timeout);
      resolve({ name: mcp.name, success: false, error: err.message });
    });

    proc.on('exit', (code) => {
      if (!exited) {
        exited = true;
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          resolve({ name: mcp.name, success: false, error: `Exit code ${code}: ${stderr.slice(0, 200)}` });
        }
        // If exit code is 0 or null (killed), that's fine
      }
    });
  });
}

async function main() {
  console.log('🔍 MCP Bundle Smoke Test');
  console.log('========================\n');

  const results = await Promise.all(BUNDLED_MCPS.map(testBundle));
  
  let failed = 0;
  for (const result of results) {
    if (result.success) {
      console.log(`  ✅ ${result.name}`);
    } else {
      console.log(`  ❌ ${result.name}: ${result.error}`);
      failed++;
    }
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${results.length - failed}/${results.length} bundles passed\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main();
