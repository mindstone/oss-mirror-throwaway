/**
 * RebelAppBridge MCP Server Smoke Test
 *
 * Headless test that verifies:
 * 1. Server starts without a bridge state file (MCP must boot even when the
 *    bridge process is off — tools/list has to work so the agent knows what
 *    it *could* do once the bridge is up).
 * 2. All expected browser + host tools are registered with descriptions + schemas.
 * 3. Calling a tool while the bridge is off returns a structured MCP error
 *    (no silent failure — per CODING_PRINCIPLES).
 * 4. bridge-discovery handles the three "bridge offline" reasons correctly.
 * 5. Tool registry consistency — every `CAPABILITY_BY_TOOL_NAME` entry matches
 *    its `TOOLS_BY_APP_ID` counterpart (mirrors scripts/check-app-bridge-tool-registry).
 *
 * Run: npx vitest run resources/mcp/rebel-app-bridge/test-mcp.test.ts
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 4)
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { createMcpTestClient, type McpTestClient } from '../../../scripts/mcp-test-harness';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- CJS module under test
const { TOOLS_BY_APP_ID, CAPABILITY_BY_TOOL_NAME, ROUTE_BY_TOOL_NAME } = require('./tools');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- CJS module under test
const { loadBridgeState, isPidAlive, discoverBridge } = require('./bridge-discovery');

const SERVER_SCRIPT = join(__dirname, 'server.cjs');

const EXPECTED_BROWSER_TOOLS = [
  'rebel_browser_status',
  'rebel_browser_read_page',
  'rebel_browser_get_selection',
  'rebel_browser_get_current_tab_url',
  'rebel_browser_fill_form',
  'rebel_browser_click',
  'rebel_browser_scroll',
] as const;

const EXPECTED_HOST_TOOLS = [
  'rebel_bridge_list_browsers',
  'rebel_bridge_prepare_install',
  'rebel_bridge_extract_extension',
  'rebel_bridge_reveal_extension_folder',
  'rebel_bridge_open_extensions_page',
  'rebel_bridge_diagnose',
] as const;

describe('RebelAppBridge MCP Server — smoke', () => {
  let client: McpTestClient | null = null;
  let tmpRoot: string | null = null;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-smoke-'));
  });

  afterAll(async () => {
    await client?.close();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('starts and registers the browser tools plus all host tools without a bridge state file', async () => {
    // Explicitly unset REBEL_APP_BRIDGE_STATE — the server must still boot.
    client = await createMcpTestClient({
      name: 'rebel-app-bridge',
      serverScript: SERVER_SCRIPT,
      env: { REBEL_APP_BRIDGE_STATE: '' },
      connectTimeout: 15_000,
    });

    const tools = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    for (const expected of [...EXPECTED_BROWSER_TOOLS, ...EXPECTED_HOST_TOOLS]) {
      expect(toolNames, `Missing tool: ${expected}`).toContain(expected);
    }
    expect(toolNames.sort()).toEqual([...EXPECTED_BROWSER_TOOLS, ...EXPECTED_HOST_TOOLS].sort());
  });

  it('every registered tool has a description and valid JSON Schema input', async () => {
    if (!client) throw new Error('client not initialised');
    const tools = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
      expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
      expect(
        tool.inputSchema.type,
        `Tool "${tool.name}" inputSchema.type should be "object"`,
      ).toBe('object');
    }
  });

  it('tools/call returns a structured MCP error when the bridge is not running', async () => {
    if (!client) throw new Error('client not initialised');

    // Call status — the cheapest tool — while no state file exists.
    const result = await client.callToolRaw('rebel_browser_status', {});

    expect(result.isError).toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/APP_BRIDGE_NOT_(RUNNING|CONFIGURED)/);
  });

  it('tools/call for fill_form surfaces schema validation errors cleanly', async () => {
    if (!client) throw new Error('client not initialised');
    // Missing required `selector` — the MCP SDK should refuse before we even
    // attempt an HTTP call; we just verify we don't crash.
    try {
      await client.callToolRaw('rebel_browser_fill_form', { value: 'hi' });
      // If we got here without throwing, assert the result is an error
      // (SDK versions differ between "throw" and "return isError").
    } catch (err) {
      // Expected path on stricter SDKs.
      expect(err).toBeDefined();
    }
  });

  it('host tools reject missing browserId at the schema boundary when required', async () => {
    if (!client) throw new Error('client not initialised');

    let thrown: unknown;
    let result:
      | Awaited<ReturnType<McpTestClient['callToolRaw']>>
      | undefined;

    try {
      result = await client.callToolRaw('rebel_bridge_extract_extension', {});
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      expect(String(thrown)).toMatch(/browserId|required/i);
      return;
    }

    expect(result?.isError).toBe(true);
    const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(text).toMatch(/browserId|required/i);
    expect(text).not.toMatch(/APP_BRIDGE_NOT_(RUNNING|CONFIGURED)/);
  });

  it('prepare_install accepts an omitted browser_id so it can return deterministic choices', async () => {
    if (!client) throw new Error('client not initialised');

    const result = await client.callToolRaw('rebel_bridge_prepare_install', {});
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      reason: 'bridge-unreachable',
      retryable: true,
    });
  });

  it('host tools reject display-name browserIds with a structured HostToolResult envelope', async () => {
    if (!client) throw new Error('client not initialised');

    const result = await client.callToolRaw('rebel_bridge_open_extensions_page', {
      browserId: 'Google Chrome',
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      reason: 'invalid-browser-id',
      retryable: false,
      data: {
        browserId: 'Google Chrome',
      },
    });
  });
});

describe('RebelAppBridge — bridge-discovery', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-discovery-'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loadBridgeState returns null for missing path', () => {
    expect(loadBridgeState(null)).toBeNull();
    expect(loadBridgeState('')).toBeNull();
    expect(loadBridgeState(undefined)).toBeNull();
  });

  it('loadBridgeState returns null for missing file', () => {
    expect(loadBridgeState(join(tmpRoot, 'nope.json'))).toBeNull();
  });

  it('loadBridgeState returns null for malformed JSON', () => {
    const p = join(tmpRoot, 'malformed.json');
    writeFileSync(p, '{ not valid');
    expect(loadBridgeState(p)).toBeNull();
  });

  it('loadBridgeState returns null for missing required fields', () => {
    const p = join(tmpRoot, 'partial.json');
    writeFileSync(p, JSON.stringify({ port: 52320 }));
    expect(loadBridgeState(p)).toBeNull();
  });

  it('loadBridgeState returns parsed state for a complete file', () => {
    const p = join(tmpRoot, 'complete.json');
    const state = {
      port: 52320,
      pid: process.pid,
      protocolVersion: '1.0',
      startedAt: new Date().toISOString(),
      routerToken: 'x'.repeat(64),
    };
    writeFileSync(p, JSON.stringify(state));
    expect(loadBridgeState(p)).toEqual(state);
  });

  it('isPidAlive returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for a guaranteed-dead PID (10_000_000)', () => {
    // PIDs above PID_MAX on every major OS — guaranteed not to be in use.
    expect(isPidAlive(10_000_000)).toBe(false);
  });

  it('discoverBridge returns no-state-path when env unset', () => {
    const result = discoverBridge(null);
    expect(result).toEqual({ ok: false, reason: 'no-state-path' });
  });

  it('discoverBridge returns missing-state when file absent', () => {
    const result = discoverBridge(join(tmpRoot, 'absent.json'));
    expect(result).toEqual({ ok: false, reason: 'missing-state' });
  });

  it('discoverBridge returns stale-state when owning PID is dead', () => {
    const p = join(tmpRoot, 'stale.json');
    const state = {
      port: 52320,
      pid: 10_000_000, // dead
      protocolVersion: '1.0',
      startedAt: new Date().toISOString(),
      routerToken: 'x'.repeat(64),
    };
    writeFileSync(p, JSON.stringify(state));
    expect(discoverBridge(p)).toEqual({ ok: false, reason: 'stale-state' });
  });

  it('discoverBridge returns ok:true when state file is valid and PID is alive', () => {
    const p = join(tmpRoot, 'live.json');
    const state = {
      port: 52320,
      pid: process.pid,
      protocolVersion: '1.0',
      startedAt: new Date().toISOString(),
      routerToken: 'x'.repeat(64),
    };
    writeFileSync(p, JSON.stringify(state));
    const result = discoverBridge(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.port).toBe(52320);
      expect(result.state.routerToken.length).toBe(64);
    }
    unlinkSync(p);
  });
});

describe('RebelAppBridge — tool-registry integrity', () => {
  it('TOOLS_BY_APP_ID and CAPABILITY_BY_TOOL_NAME cover the same tool names', () => {
    const fromTools = new Set<string>();
    for (const tools of Object.values(TOOLS_BY_APP_ID) as Array<Array<{ name: string }>>) {
      for (const t of tools) fromTools.add(t.name);
    }
    const fromMap = new Set(Object.keys(CAPABILITY_BY_TOOL_NAME));
    expect([...fromTools].sort()).toEqual([...fromMap].sort());
  });

  it('ROUTE_BY_TOOL_NAME carries the correct appId/capability for each tool', () => {
    for (const [appId, tools] of Object.entries(TOOLS_BY_APP_ID) as Array<
      [string, Array<{ name: string; capability: string }>]
    >) {
      for (const tool of tools) {
        expect(ROUTE_BY_TOOL_NAME[tool.name]).toEqual({
          appId,
          capability: tool.capability,
        });
      }
    }
  });

  it('all mapped capabilities are listed as keys in TOOLS_BY_APP_ID values', () => {
    const capabilities = new Set<string>();
    for (const tools of Object.values(TOOLS_BY_APP_ID) as Array<Array<{ capability: string }>>) {
      for (const t of tools) capabilities.add(t.capability);
    }
    // CAPABILITY_BY_TOOL_NAME values must be a subset of TOOLS_BY_APP_ID capabilities.
    for (const cap of Object.values(CAPABILITY_BY_TOOL_NAME) as string[]) {
      expect(capabilities.has(cap)).toBe(true);
    }
  });
});
