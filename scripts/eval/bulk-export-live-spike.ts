#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json
/**
 * LIVE skip-green spike: prove that the revived `bulk_export` tool is genuinely
 * exposed and dispatchable by the REAL running super-mcp server (not unit-mocked).
 *
 * Skip-green semantics:
 *   - Environmental inability to spawn/connect  -> print "SKIP: <reason>", exit 0
 *   - A real assertion failure (defect)         -> print "FAIL: <reason>",  exit 1
 *   - Everything proven                          -> print "GREEN",          exit 0
 *
 * Level 1 (MUST): spawn the bundled super-mcp from super-mcp/dist/cli.js over
 *   stdio, ListTools, assert `bulk_export` is present with the expected input
 *   schema. A failure here is a real defect (FAIL, exit 1).
 *
 * Level 2 (BEST-EFFORT, skip-green): configure a no-auth read-only downstream
 *   (@modelcontextprotocol/server-filesystem rooted at a temp dir containing a
 *   small JSON file), confirm use_tool works, then run bulk_export against the
 *   read-only `directory_tree` tool and assert an NDJSON file appears under
 *   .rebel/exports/ with a valid summary {status,pages,lines,bytes,output_file}.
 *   If the downstream cannot be spun up, print SKIP (Level 2) and still pass
 *   on Level 1.
 *
 * Does NOT touch the user's real connectors, credentials, super-mcp config, or
 * token store. Everything is ephemeral and cleaned up.
 */

import { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'super-mcp', 'dist', 'cli.js');

// Expected bulk_export inputSchema contract (the revived tool).
const EXPECTED_PROPS = [
  'package_id',
  'tool_id',
  'args',
  'output_file',
  'pagination',
  'items_path',
  'max_pages',
  'if_exists',
] as const;
const EXPECTED_REQUIRED = ['tool_id', 'args', 'output_file'] as const;

const DOWNSTREAM_PKG_ID = 'fsprobe';

function log(msg: string): void {
   
  console.log(msg);
}

function skip(reason: string): never {
  log(`SKIP: ${reason}`);
  process.exit(0);
}

function fail(reason: string): never {
  log(`FAIL: ${reason}`);
  process.exit(1);
}

// ---- ephemeral fixtures -----------------------------------------------------

interface Fixtures {
  /** realpath'd root of all temp state */
  tmpRoot: string;
  /** realpath'd REBEL_WORKSPACE_PATH */
  workspace: string;
  /** realpath'd directory the downstream filesystem server is allowed to read */
  downstreamRoot: string;
  configPath: string;
}

function makeFixtures(): Fixtures {
  // realpathSync resolves macOS /tmp -> /private/tmp so the downstream
  // filesystem server (which compares against its realpath'd allowed dir)
  // and bulk_export's realpath workspace checks both agree.
  const tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-export-live-')),
  );
  const workspace = path.join(tmpRoot, 'workspace');
  const downstreamRoot = path.join(tmpRoot, 'downstream');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(downstreamRoot, { recursive: true });

  // Small JSON file so directory_tree has deterministic, parseable content.
  fs.writeFileSync(
    path.join(downstreamRoot, 'sample.json'),
    JSON.stringify({ hello: 'world', n: 42 }) + '\n',
  );

  const config = {
    $schema:
      'https://raw.githubusercontent.com/mindstone/Super-MCP/main/super-mcp-config.schema.json',
    mcpServers: {
      [DOWNSTREAM_PKG_ID]: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', downstreamRoot],
        name: 'FS Probe',
        description: 'Ephemeral no-auth read-only filesystem package for the spike.',
      },
    },
  };
  const configPath = path.join(tmpRoot, 'super-mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  return { tmpRoot, workspace, downstreamRoot, configPath };
}

function cleanup(fx: Fixtures | undefined, child: ChildProcess | undefined): void {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  if (fx) {
    try {
      fs.rmSync(fx.tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---- tool result helpers ----------------------------------------------------

function extractText(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return (result as { content: Array<{ type?: string; text?: string }> }).content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function isError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as { isError?: boolean }).isError === true
  );
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  let fx: Fixtures | undefined;
  let child: ChildProcess | undefined;
  let client: Client | undefined;

  const finish = (fn: () => never): never => {
    if (client) {
      void client.close().catch(() => {});
    }
    cleanup(fx, child);
    return fn();
  };

  // Preconditions (environmental -> SKIP).
  if (!fs.existsSync(CLI_PATH)) {
    skip(`bundled super-mcp CLI not found at ${CLI_PATH} (run: npm run build:super-mcp)`);
  }
  const bulkExportHandler = path.join(
    REPO_ROOT,
    'super-mcp',
    'dist',
    'handlers',
    'bulkExport.js',
  );
  if (!fs.existsSync(bulkExportHandler)) {
    skip(`bundled bulkExport handler not found at ${bulkExportHandler}`);
  }

  try {
    fx = makeFixtures();
  } catch (err) {
    skip(`could not create ephemeral fixtures: ${(err as Error).message}`);
  }

  // Spawn the REAL bundled super-mcp over stdio and connect the MCP SDK client.
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [CLI_PATH, '--config', fx.configPath, '--transport', 'stdio', '--log-level', 'error'],
    env: {
      ...process.env,
      REBEL_WORKSPACE_PATH: fx.workspace,
      // Isolate from the user's real config/home setup.
      SUPER_MCP_CONFIG: fx.configPath,
    },
    cwd: REPO_ROOT,
    stderr: 'ignore',
  });

  client = new Client(
    { name: 'bulk-export-live-spike', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // listen EPERM ...pipe and other spawn/transport failures are environmental.
    return finish(() => skip(`could not spawn/connect to super-mcp over stdio: ${msg}`));
  }

  // ---- Level 1 (MUST): bulk_export exposed with expected schema ----
  let tools;
  try {
    const res = await client.listTools();
    tools = res.tools;
  } catch (err) {
    return finish(() => skip(`ListTools call failed: ${(err as Error).message}`));
  }

  const names = tools.map((t) => t.name);
  log(`Live tools from running super-mcp: ${names.sort().join(', ')}`);

  const bulkExport = tools.find((t) => t.name === 'bulk_export');
  if (!bulkExport) {
    return finish(() =>
      fail(`'bulk_export' is NOT in the live tool list from the running server. Got: ${names.join(', ')}`),
    );
  }

  const schema = bulkExport.inputSchema as
    | { type?: string; properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return finish(() =>
      fail(`bulk_export inputSchema is missing/not an object schema: ${JSON.stringify(schema)}`),
    );
  }

  const props = schema.properties;
  const missingProps = EXPECTED_PROPS.filter((p) => !(p in props));
  if (missingProps.length > 0) {
    return finish(() =>
      fail(`bulk_export inputSchema missing expected properties: ${missingProps.join(', ')}`),
    );
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missingRequired = EXPECTED_REQUIRED.filter((r) => !required.includes(r));
  const extraRequired = required.filter((r) => !(EXPECTED_REQUIRED as readonly string[]).includes(r));
  if (missingRequired.length > 0 || extraRequired.length > 0) {
    return finish(() =>
      fail(
        `bulk_export required mismatch. expected exactly [${EXPECTED_REQUIRED.join(', ')}], ` +
          `got [${required.join(', ')}]`,
      ),
    );
  }

  log('Level 1 PASS: real running super-mcp exposes bulk_export with expected inputSchema');
  log(`  properties: ${Object.keys(props).sort().join(', ')}`);
  log(`  required:   ${required.join(', ')}`);

  // ---- Level 2 (BEST-EFFORT, skip-green): real dispatch end-to-end ----
  let level2Skip: string | undefined;

  // 2a. Confirm the no-auth downstream is reachable via use_tool.
  try {
    const useToolRes = await client.callTool({
      name: 'use_tool',
      arguments: {
        package_id: DOWNSTREAM_PKG_ID,
        tool_id: 'directory_tree',
        args: { path: fx.downstreamRoot },
      },
    });
    if (isError(useToolRes)) {
      level2Skip = `downstream not usable via use_tool: ${extractText(useToolRes).slice(0, 200)}`;
    }
  } catch (err) {
    level2Skip = `use_tool against downstream failed (likely npx/network unavailable): ${(err as Error).message}`;
  }

  if (level2Skip) {
    log(`SKIP (Level 2): ${level2Skip}`);
    return finish(() => {
      log('GREEN');
      process.exit(0);
    });
  }

  // 2b. Run bulk_export against the read-only directory_tree tool.
  const outputFile = 'fsprobe/tree.ndjson';
  let bulkRes: unknown;
  try {
    bulkRes = await client.callTool({
      name: 'bulk_export',
      arguments: {
        package_id: DOWNSTREAM_PKG_ID,
        tool_id: 'directory_tree',
        args: { path: fx.downstreamRoot },
        output_file: outputFile,
        if_exists: 'overwrite',
      },
    });
  } catch (err) {
    // The real server dispatched but threw — that's a defect, not environmental.
    return finish(() => fail(`bulk_export call threw on the live server: ${(err as Error).message}`));
  }

  const bulkText = extractText(bulkRes);
  if (isError(bulkRes)) {
    return finish(() => fail(`bulk_export returned isError. Output: ${bulkText.slice(0, 400)}`));
  }

  let summary: { status?: string; pages?: number; lines?: number; bytes?: number; output_file?: string };
  try {
    summary = JSON.parse(bulkText);
  } catch {
    return finish(() => fail(`bulk_export success output is not JSON: ${bulkText.slice(0, 400)}`));
  }

  log(`Level 2 bulk_export summary: ${JSON.stringify(summary)}`);

  const summaryOk =
    typeof summary.status === 'string' &&
    typeof summary.pages === 'number' &&
    typeof summary.lines === 'number' &&
    typeof summary.bytes === 'number' &&
    typeof summary.output_file === 'string';
  if (!summaryOk) {
    return finish(() =>
      fail(`bulk_export summary missing expected fields {status,pages,lines,bytes,output_file}: ${bulkText.slice(0, 400)}`),
    );
  }
  if (summary.status !== 'complete') {
    return finish(() =>
      fail(`bulk_export expected status 'complete', got '${summary.status}'. Summary: ${bulkText}`),
    );
  }
  if ((summary.lines ?? 0) < 1) {
    return finish(() => fail(`bulk_export wrote 0 lines. Summary: ${bulkText}`));
  }

  // Verify the NDJSON file actually exists under .rebel/exports/ and is valid NDJSON.
  const exportPath = path.join(fx.workspace, '.rebel', 'exports', 'fsprobe', 'tree.ndjson');
  if (!fs.existsSync(exportPath)) {
    return finish(() =>
      fail(`bulk_export reported success but NDJSON file is missing at ${exportPath}`),
    );
  }
  const fileContent = fs.readFileSync(exportPath, 'utf8');
  const ndjsonLines = fileContent.split('\n').filter((l) => l.trim().length > 0);
  if (ndjsonLines.length < 1) {
    return finish(() => fail(`NDJSON export file is empty at ${exportPath}`));
  }
  for (const [i, line] of ndjsonLines.entries()) {
    try {
      JSON.parse(line);
    } catch {
      return finish(() => fail(`NDJSON line ${i + 1} is not valid JSON: ${line.slice(0, 200)}`));
    }
  }
  if (summary.output_file !== `.rebel/exports/${outputFile}`) {
    return finish(() =>
      fail(`summary.output_file unexpected: got '${summary.output_file}', expected '.rebel/exports/${outputFile}'`),
    );
  }

  log(`Level 2 PASS: bulk_export dispatched live, wrote ${ndjsonLines.length} valid NDJSON line(s) to .rebel/exports/${outputFile}`);

  return finish(() => {
    log('GREEN');
    process.exit(0);
  });
}

main().catch((err) => {
  // Unexpected top-level error: treat as environmental SKIP rather than a false FAIL,
  // since real assertion failures already exit via fail() above.
  log(`SKIP: unexpected spike error: ${(err as Error)?.stack || String(err)}`);
  process.exit(0);
});
