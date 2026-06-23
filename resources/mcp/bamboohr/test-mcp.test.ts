/**
 * BambooHR MCP Integration Tests
 *
 * Tests for the community @twentytwokhz/bamboohr-mcp package.
 * Integration tests are skipped when BAMBOOHR_API_KEY is not set.
 *
 * Run with real credentials:
 *   BAMBOOHR_API_KEY=... BAMBOOHR_COMPANY_DOMAIN=... npx vitest run resources/mcp/bamboohr/test-mcp.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import {
  createMcpTestClient,
  assertToolReturnsError,
  preInstallCommunityPackage,
  type McpTestClient,
} from '../../../scripts/mcp-test-harness';

const PACKAGE_SPEC = '@twentytwokhz/bamboohr-mcp@1.1.1';
const CONNECT_TIMEOUT = 30_000;

const hasCredentials =
  !!process.env.BAMBOOHR_API_KEY && !!process.env.BAMBOOHR_COMPANY_DOMAIN;

describe('bamboohr MCP integration', () => {
  let binPath: string;
  let installDir: string;

  beforeAll(async () => {
    const result = await preInstallCommunityPackage(PACKAGE_SPEC);
    binPath = result.binPath;
    installDir = result.installDir;
  }, 420_000);

  afterAll(() => {
    if (installDir) {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  // ─── Unconfigured tests (always run) ────────────────────────────
  describe('unconfigured (invalid credentials)', () => {
    let client: McpTestClient;

    beforeAll(async () => {
      client = await createMcpTestClient({
        name: 'bamboohr-unconfigured',
        command: 'node',
        args: [binPath],
        env: {
          // This community MCP refuses to start without both env vars set, so we use
          // placeholder values and assert tool calls fail.
          BAMBOOHR_API_KEY: 'invalid',
          BAMBOOHR_COMPANY_DOMAIN: 'invalid',
        },
        connectTimeout: CONNECT_TIMEOUT,
      });
    }, 60_000);

    afterAll(async () => {
      await client?.close();
    });

    it('lists tools even with invalid credentials', async () => {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('bamboohr_get_employee_directory');
      expect(toolNames).toContain('bamboohr_get_whos_out');
      expect(toolNames).toContain('bamboohr_get_time_off_requests');
      expect(toolNames).toContain('bamboohr_get_employee');
      expect(toolNames).toContain('bamboohr_get_company_info');
    });

    it('returns error when calling tool with invalid credentials', async () => {
      await assertToolReturnsError(client, 'bamboohr_get_employee_directory');
    });
  });

  // ─── Configured tests (skip without credentials) ────────────────
  const describeConfigured = hasCredentials ? describe : describe.skip;

  describeConfigured('configured (with API key)', () => {
    let client: McpTestClient;

    beforeAll(async () => {
      client = await createMcpTestClient({
        name: 'bamboohr-configured',
        command: 'node',
        args: [binPath],
        env: {
          BAMBOOHR_API_KEY: process.env.BAMBOOHR_API_KEY!,
          BAMBOOHR_COMPANY_DOMAIN: process.env.BAMBOOHR_COMPANY_DOMAIN!,
        },
        connectTimeout: CONNECT_TIMEOUT,
      });
    }, 60_000);

    afterAll(async () => {
      await client?.close();
    });

    it('get_employee_directory returns employees', async () => {
      const result = await client.callToolText('bamboohr_get_employee_directory', {});
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

    it('get_whos_out returns data', async () => {
      const result = await client.callToolText('bamboohr_get_whos_out', {});
      expect(result).toBeTruthy();
    });

    it('get_time_off_types returns types', async () => {
      const result = await client.callToolText('bamboohr_get_time_off_types', {});
      expect(result).toBeTruthy();
    });

    it('get_company_info returns company data', async () => {
      const result = await client.callToolText('bamboohr_get_company_info', {});
      expect(result).toBeTruthy();
    });

    it('get_employee with invalid ID returns error', async () => {
      await assertToolReturnsError(client, 'bamboohr_get_employee', {
        employee_id: '999999999',
      });
    });
  });
});
