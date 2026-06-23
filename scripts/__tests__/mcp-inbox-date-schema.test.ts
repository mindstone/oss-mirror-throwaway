/**
 * MCP Inbox Date Schema — Regression guard for REBEL-13Y.
 *
 * The rebel_inbox date fields (relevantDate / dueBy) accept an ISO date string
 * at runtime (coerced to epoch ms). Previously they were declared with
 * `z.preprocess(coerceEpochMs, z.number())`, which EXPORTS to JSON Schema as a
 * bare `{ type: "number" }`. SuperMCP's AJV validator then rejected
 * `dueBy: "2026-06-15"` with error -33003 *before* the connector's coercion ran
 * — the #1-volume Sentry signature. The tool descriptions even invite the model
 * to send ISO strings, so the exported schema must advertise string acceptance.
 *
 * This test spawns the real server.cjs, lists its tools, and asserts that the
 * exported input schema for relevantDate/dueBy accepts BOTH string and number
 * on add / add_many / update. This is the killed-by-construction guard against
 * regressing the exported schema back to number-only.
 *
 * Run: npx vitest run scripts/__tests__/mcp-inbox-date-schema.test.ts
 *
 * @see resources/mcp/rebel-inbox/server.cjs
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PROJECT_ROOT = join(__dirname, '..', '..');
const SERVER_PATH = join(PROJECT_ROOT, 'resources', 'mcp', 'rebel-inbox', 'server.cjs');
const NODE_MODULES = join(PROJECT_ROOT, 'node_modules');

type JsonSchema = Record<string, any>;

/**
 * Spawn the server, send a JSON-RPC tools/list request over stdio, and resolve
 * with the list of tools. Modeled on scripts/test-mcp-health.js.
 */
function listTools(): Promise<Array<{ name: string; inputSchema: JsonSchema }>> {
  return new Promise((resolve, reject) => {
    // The server requires a bridge-state file to start (it does not need to be
    // valid for tool *registration*, only for tool *execution*).
    const bridgePath = join(tmpdir(), `rebel-inbox-date-schema-test-${process.pid}.json`);
    writeFileSync(bridgePath, JSON.stringify({ port: 1, token: 'test-date-schema' }));

    const child: ChildProcessWithoutNullStreams = spawn('node', [SERVER_PATH], {
      env: {
        ...process.env,
        MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
        NODE_PATH: NODE_MODULES,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;
    let stdout = '';
    let stderr = '';

    const cleanup = () => {
      try { child.kill(); } catch { /* ignore */ }
      if (existsSync(bridgePath)) { try { unlinkSync(bridgePath); } catch { /* ignore */ } }
    };

    const finish = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      fn();
    };

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== 1) continue;
          if (parsed.error) {
            finish(() => reject(new Error(`tools/list error: ${parsed.error.message}`)));
          } else if (parsed.result?.tools) {
            finish(() => resolve(parsed.result.tools));
          }
        } catch {
          // partial JSON line, keep accumulating
        }
      }
    });

    child.on('error', (err) => finish(() => reject(err)));

    // Give the server a moment to boot, then send the request.
    setTimeout(() => {
      if (resolved) return;
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }) + '\n');
      } catch (e) {
        finish(() => reject(e as Error));
      }
    }, 500);

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timeout waiting for tools/list. stderr: ${stderr.slice(0, 500)}`)));
    }, 15000);
  });
}

/**
 * Collect every leaf `type` advertised by a JSON Schema fragment, descending
 * through anyOf/oneOf/allOf wrappers (e.g. from `.optional().or(z.null())`).
 */
function collectTypes(schema: JsonSchema | undefined): Set<string> {
  const out = new Set<string>();
  if (!schema || typeof schema !== 'object') return out;
  const add = (t: unknown) => {
    if (Array.isArray(t)) t.forEach((x) => out.add(String(x)));
    else if (typeof t === 'string') out.add(t);
  };
  add(schema.type);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branch = schema[key];
    if (Array.isArray(branch)) {
      for (const sub of branch) {
        for (const t of collectTypes(sub)) out.add(t);
      }
    }
  }
  return out;
}

describe('MCP Inbox Date Schema (REBEL-13Y exported-schema guard)', () => {
  let tools: Array<{ name: string; inputSchema: JsonSchema }>;

  beforeAll(async () => {
    tools = await listTools();
  }, 20000);

  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `tool ${name} should be registered`).toBeDefined();
    return tool!;
  };

  it('lists the rebel_inbox tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(9);
    for (const name of ['rebel_inbox_add', 'rebel_inbox_add_many', 'rebel_inbox_update']) {
      expect(tools.map((t) => t.name)).toContain(name);
    }
  });

  // add / update expose dueBy & relevantDate at the top level; add_many nests
  // them inside items[].properties.
  const cases: Array<{ tool: string; getProps: (s: JsonSchema) => JsonSchema | undefined }> = [
    { tool: 'rebel_inbox_add', getProps: (s) => s.properties },
    {
      tool: 'rebel_inbox_add_many',
      getProps: (s) => s.properties?.items?.items?.properties,
    },
    { tool: 'rebel_inbox_update', getProps: (s) => s.properties },
  ];

  for (const { tool, getProps } of cases) {
    for (const field of ['dueBy', 'relevantDate']) {
      it(`${tool}.${field} exported schema accepts BOTH string and number`, () => {
        const props = getProps(byName(tool).inputSchema);
        expect(props, `${tool} should expose date-field properties`).toBeDefined();
        const fieldSchema = props![field];
        expect(fieldSchema, `${tool}.${field} should be present in inputSchema`).toBeDefined();
        const types = collectTypes(fieldSchema);
        expect(
          types.has('string'),
          `${tool}.${field} must accept string (was: ${JSON.stringify([...types])}); ` +
            `bare number-only schema is the REBEL-13Y regression`,
        ).toBe(true);
        expect(
          types.has('number'),
          `${tool}.${field} must still accept number (was: ${JSON.stringify([...types])})`,
        ).toBe(true);
      });
    }
  }

  it('rebel_inbox_update.dueBy still permits null (clear semantics preserved)', () => {
    const props = byName('rebel_inbox_update').inputSchema.properties;
    const types = collectTypes(props?.dueBy);
    expect(types.has('null')).toBe(true);
  });
});
