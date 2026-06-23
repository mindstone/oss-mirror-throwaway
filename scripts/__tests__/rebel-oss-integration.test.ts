/**
 * Rebel-OSS MCP Connector Integration Tests
 *
 * Tests migrated connectors via npx (the rebel-oss path).
 * Skipped when API key env vars are not set.
 *
 * Run with keys:
 *   GEMINI_API_KEY=xxx ELEVENLABS_API_KEY=xxx NAPKIN_API_KEY=xxx \
 *     npx vitest run scripts/__tests__/rebel-oss-integration.test.ts
 *
 * Run a single connector:
 *   ELEVENLABS_API_KEY=xxx npx vitest run scripts/__tests__/rebel-oss-integration.test.ts
 *
 * Keys are NEVER saved to disk. They are read from environment at runtime only.
 * This test file is safe to commit — it contains zero credentials.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createMcpTestClient, type McpTestClient } from '../mcp-test-harness';

// ─── Connector Registry ───────────────────────────────────────────────────────

interface RebelOssTestConfig {
  /** Display name */
  name: string;
  /** npm package spec for npx */
  package: string;
  /** Env var name for API key */
  envKey: string;
  /** Expected tool names (subset — just verify these exist) */
  expectedTools: string[];
  /** Optional safe read-only tool to call for smoke test */
  smokeTest?: {
    tool: string;
    args?: Record<string, unknown>;
    /** If true, expect the tool to return an error (e.g., invalid ID check) */
    expectError?: boolean;
  };
}

const REBEL_OSS_CONNECTORS: RebelOssTestConfig[] = [
  {
    name: 'NanoBanana (Gemini)',
    package: '@mindstone-engineering/mcp-server-nano-banana',
    envKey: 'GEMINI_API_KEY',
    expectedTools: ['configure_nano_banana_api_key', 'nano_banana_generate', 'nano_banana_edit'],
  },
  {
    name: 'ElevenLabs',
    package: '@mindstone-engineering/mcp-server-elevenlabs',
    envKey: 'ELEVENLABS_API_KEY',
    expectedTools: ['configure_elevenlabs_api_key', 'list_voices', 'generate_speech', 'generate_sound_effect'],
    smokeTest: {
      tool: 'list_voices',
      args: { page_size: 1 },
    },
  },
  {
    name: 'Napkin AI',
    package: '@mindstone-engineering/mcp-server-napkin',
    envKey: 'NAPKIN_API_KEY',
    expectedTools: ['configure_napkin_api_key', 'napkin_generate_visual', 'napkin_check_status', 'napkin_download_visual'],
    smokeTest: {
      tool: 'napkin_check_status',
      args: { request_id: '00000000-0000-0000-0000-000000000000' },
      expectError: true,
    },
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

for (const config of REBEL_OSS_CONNECTORS) {
  const hasKey = !!process.env[config.envKey];
  const describeFn = hasKey ? describe : describe.skip;

  describeFn(`${config.name} (rebel-oss integration)`, () => {
    let client: McpTestClient;

    beforeAll(async () => {
      client = await createMcpTestClient({
        name: config.name,
        command: 'npx',
        args: ['-y', config.package],
        env: {
          [config.envKey]: process.env[config.envKey]!,
        },
        mockBridgeState: true,
        connectTimeout: 30_000,
      });
    }, 60_000);

    afterAll(async () => {
      await client?.close();
    });

    it('connects and lists tools', async () => {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const toolNames = tools.map((t) => t.name);
      for (const expected of config.expectedTools) {
        expect(toolNames).toContain(expected);
      }
    });

    if (config.smokeTest) {
      it(`smoke test: ${config.smokeTest.tool}`, async () => {
        const result = await client.callToolRaw(
          config.smokeTest!.tool,
          config.smokeTest!.args,
        );
        if (config.smokeTest!.expectError) {
          // Server processed the request (didn't crash) — that's the smoke test
          expect(result.content.length).toBeGreaterThan(0);
        } else {
          expect(result.isError).not.toBe(true);
        }
      });
    }
  });
}
