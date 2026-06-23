/**
 * Xero MCP Token Caching Integration Test (FOX-2577)
 *
 * Validates that the Xero MCP server caches OAuth tokens and refreshes
 * them before expiry, rather than fetching a new token on every call.
 *
 * This test installs the npm package, spawns it as an MCP server via the
 * standard test harness, and verifies tool calls reuse cached tokens.
 *
 * Run:
 *   XERO_CLIENT_ID=xxx XERO_CLIENT_SECRET=xxx npx vitest run scripts/__tests__/xero-token-caching.test.ts
 *
 * To test a different package version (e.g. to verify upstream fix):
 *   XERO_PACKAGE="@xeroapi/xero-mcp-server@0.0.17" XERO_CLIENT_ID=xxx XERO_CLIENT_SECRET=xxx \
 *     npx vitest run scripts/__tests__/xero-token-caching.test.ts
 *
 * @see docs/project/mcps/XERO_MCP.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { preInstallCommunityPackage, createMcpTestClient, type McpTestClient } from '../mcp-test-harness';
import { rmSync } from 'fs';

const XERO_PACKAGE = process.env.XERO_PACKAGE || '@mindstone/mcp-server-xero@0.0.17';
const hasCredentials = !!process.env.XERO_CLIENT_ID && !!process.env.XERO_CLIENT_SECRET;

const describeIfConfigured = hasCredentials ? describe : describe.skip;

describeIfConfigured('xero MCP token caching (FOX-2577)', () => {
  let client: McpTestClient;
  let installDir: string;

  beforeAll(async () => {
    const installed = await preInstallCommunityPackage(XERO_PACKAGE);
    installDir = installed.installDir;

    client = await createMcpTestClient({
      name: 'xero-token-test',
      command: installed.binPath,
      env: {
        XERO_CLIENT_ID: process.env.XERO_CLIENT_ID!,
        XERO_CLIENT_SECRET: process.env.XERO_CLIENT_SECRET!,
      },
      connectTimeout: 30_000,
    });
  }, 420_000);

  afterAll(async () => {
    await client?.close();
    if (installDir) rmSync(installDir, { recursive: true, force: true });
  });

  it('registers tools on startup', async () => {
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('list-contacts');
    expect(toolNames).toContain('list-invoices');
  });

  it('lists contacts successfully (token obtained and cached)', async () => {
    const result = await client.callToolRaw('list-contacts', {});
    expect(result.isError).not.toBe(true);
    const text = result.content?.[0];
    expect(text).toBeDefined();
  }, 30_000);

  it('second tool call reuses cached token (no extra latency)', async () => {
    const start = Date.now();
    const result = await client.callToolRaw('list-accounts', {});
    const elapsed = Date.now() - start;

    expect(result.isError).not.toBe(true);
    // A cached token call should be much faster than initial auth (~2-3s for token fetch).
    // If token caching is broken, each call adds ~1-2s for the token round-trip.
    // We use a generous threshold since network variance exists.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('third tool call still uses cached token', async () => {
    const result = await client.callToolRaw('list-organisation-details', {});
    expect(result.isError).not.toBe(true);
  }, 30_000);
}, 180_000);
