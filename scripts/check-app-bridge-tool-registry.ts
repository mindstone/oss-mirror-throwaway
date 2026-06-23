#!/usr/bin/env npx tsx
/**
 * CI Validation: App Bridge Tool Registry Consistency
 *
 * Stage 4 (D27 / R27) — enforces that three independent sources agree on
 * which tools the RebelAppBridge MCP exposes, which capabilities they map
 * to, and which capabilities the protocol understands:
 *
 *   1. `resources/mcp/rebel-app-bridge/tools/index.js` exports
 *      `TOOLS_BY_APP_ID` (grouped by appId, each tool has a `capability`)
 *      and `CAPABILITY_BY_TOOL_NAME` (inverse lookup).
 *   2. The same file exports `ROUTE_BY_TOOL_NAME` — the live lookup the
 *      MCP server uses at runtime.
 *   3. `src/core/appBridge/shared/protocol.ts` exports `CAPABILITY_KEYS` —
 *      the authoritative list of capabilities the protocol supports.
 *
 * Any drift between these three is a latent bug: an MCP tool that points
 * to a capability the bridge has never heard of, or a capability gap where
 * the registry forgets to map a tool. We fail the build loudly rather than
 * discover it at runtime.
 *
 * Run: npx tsx scripts/check-app-bridge-tool-registry.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 4)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(
  ROOT,
  'resources',
  'mcp',
  'rebel-app-bridge',
  'tools',
  'index.js',
);
const PROTOCOL_PATH = path.join(
  ROOT,
  'src',
  'core',
  'appBridge',
  'shared',
  'protocol.ts',
);

function fail(message: string, details?: string[]): never {
  console.error(`\n❌ App Bridge tool-registry consistency check FAILED\n`);
  console.error(`   ${message}\n`);
  if (details && details.length > 0) {
    for (const line of details) console.error(`   - ${line}`);
    console.error('');
  }
  console.error(
    `   Fix: ensure every tool in TOOLS_BY_APP_ID declares a \`capability\``,
  );
  console.error(
    `   that exists in CAPABILITY_KEYS (src/core/appBridge/shared/protocol.ts),`,
  );
  console.error(
    `   and that CAPABILITY_BY_TOOL_NAME covers exactly the same tool names.\n`,
  );
  process.exit(1);
}

function extractCapabilityKeys(source: string, arrayName: string): string[] {
  const regex = new RegExp(`export const ${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`);
  const match = source.match(regex);
  if (!match) {
    fail(
      `Unable to locate \`export const ${arrayName}\` in ${path.relative(ROOT, PROTOCOL_PATH)}`,
    );
  }
  const block = match[1];
  const keys: string[] = [];
  const keyRegex = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(block)) !== null) {
    keys.push(m[1]);
  }
  if (keys.length === 0) {
    fail(`${arrayName} appears empty — refusing to silently validate nothing.`);
  }
  return keys;
}

interface ToolRecord {
  name: string;
  capability: string;
}

interface Registry {
  TOOLS_BY_APP_ID: Record<string, ToolRecord[]>;
  ROUTE_BY_TOOL_NAME: Record<string, { appId: string; capability: string }>;
  CAPABILITY_BY_TOOL_NAME: Record<string, string>;
}

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fail(`Registry file not found: ${path.relative(ROOT, REGISTRY_PATH)}`);
  }
  const req = createRequire(__filename);
  try {
    return req(REGISTRY_PATH) as Registry;
  } catch (err) {
    fail(
      `Failed to require ${path.relative(ROOT, REGISTRY_PATH)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function main(): void {
  console.log('🧭 App Bridge Tool Registry Check');
  console.log('=================================\n');

  const protocolSource = fs.readFileSync(PROTOCOL_PATH, 'utf8');
  const capabilityKeys = extractCapabilityKeys(protocolSource, 'CAPABILITY_KEYS');
  const hostCapabilityKeys = extractCapabilityKeys(protocolSource, 'HOST_CAPABILITY_KEYS');
  const capabilitySet = new Set([...capabilityKeys, ...hostCapabilityKeys]);

  const registry = loadRegistry();
  const { TOOLS_BY_APP_ID, ROUTE_BY_TOOL_NAME, CAPABILITY_BY_TOOL_NAME } = registry;

  if (!TOOLS_BY_APP_ID || typeof TOOLS_BY_APP_ID !== 'object') {
    fail('TOOLS_BY_APP_ID is missing or malformed.');
  }
  if (!ROUTE_BY_TOOL_NAME || typeof ROUTE_BY_TOOL_NAME !== 'object') {
    fail('ROUTE_BY_TOOL_NAME is missing or malformed.');
  }
  if (!CAPABILITY_BY_TOOL_NAME || typeof CAPABILITY_BY_TOOL_NAME !== 'object') {
    fail('CAPABILITY_BY_TOOL_NAME is missing or malformed.');
  }

  // Flatten TOOLS_BY_APP_ID into a canonical [toolName, capability] list.
  const flat: Array<{ appId: string; name: string; capability: string }> = [];
  for (const [appId, tools] of Object.entries(TOOLS_BY_APP_ID)) {
    if (!Array.isArray(tools)) {
      fail(`TOOLS_BY_APP_ID["${appId}"] is not an array.`);
    }
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || typeof tool.capability !== 'string') {
        fail(
          `Tool under appId "${appId}" is missing name/capability: ${JSON.stringify(tool)}`,
        );
      }
      flat.push({ appId, name: tool.name, capability: tool.capability });
    }
  }

  // ---- Check 1: every tool's capability exists in CAPABILITY_KEYS ---------
  const unknownCapability: string[] = [];
  for (const { name, capability } of flat) {
    if (!capabilitySet.has(capability)) {
      unknownCapability.push(`tool=${name} capability=${capability}`);
    }
  }
  if (unknownCapability.length > 0) {
    fail(
      `Tool(s) reference capabilities not in CAPABILITY_KEYS or HOST_CAPABILITY_KEYS:`,
      unknownCapability,
    );
  }

  // ---- Check 2: CAPABILITY_BY_TOOL_NAME covers exactly the same tools ----
  const toolsInFlat = new Set(flat.map((t) => t.name));
  const toolsInMap = new Set(Object.keys(CAPABILITY_BY_TOOL_NAME));
  const onlyInTools: string[] = [];
  const onlyInMap: string[] = [];
  for (const name of toolsInFlat) {
    if (!toolsInMap.has(name)) onlyInTools.push(name);
  }
  for (const name of toolsInMap) {
    if (!toolsInFlat.has(name)) onlyInMap.push(name);
  }
  if (onlyInTools.length > 0 || onlyInMap.length > 0) {
    const details: string[] = [];
    for (const n of onlyInTools) details.push(`in TOOLS_BY_APP_ID but not in CAPABILITY_BY_TOOL_NAME: ${n}`);
    for (const n of onlyInMap) details.push(`in CAPABILITY_BY_TOOL_NAME but not in TOOLS_BY_APP_ID: ${n}`);
    fail('TOOLS_BY_APP_ID and CAPABILITY_BY_TOOL_NAME drifted.', details);
  }

  // ---- Check 3: CAPABILITY_BY_TOOL_NAME capability matches TOOLS_BY_APP_ID
  const capabilityMismatch: string[] = [];
  for (const { name, capability } of flat) {
    const mapped = CAPABILITY_BY_TOOL_NAME[name];
    if (mapped !== capability) {
      capabilityMismatch.push(`tool=${name}: TOOLS_BY_APP_ID=${capability} CAPABILITY_BY_TOOL_NAME=${mapped}`);
    }
  }
  if (capabilityMismatch.length > 0) {
    fail('CAPABILITY_BY_TOOL_NAME values disagree with TOOLS_BY_APP_ID.', capabilityMismatch);
  }

  // ---- Check 4: ROUTE_BY_TOOL_NAME agrees -----------------------------
  const routeMismatch: string[] = [];
  for (const { appId, name, capability } of flat) {
    const route = ROUTE_BY_TOOL_NAME[name];
    if (!route) {
      routeMismatch.push(`tool=${name} missing from ROUTE_BY_TOOL_NAME`);
      continue;
    }
    if (route.appId !== appId || route.capability !== capability) {
      routeMismatch.push(
        `tool=${name}: expected appId=${appId}/capability=${capability} got appId=${route.appId}/capability=${route.capability}`,
      );
    }
  }
  const routeExtras: string[] = [];
  for (const name of Object.keys(ROUTE_BY_TOOL_NAME)) {
    if (!toolsInFlat.has(name)) routeExtras.push(name);
  }
  if (routeMismatch.length > 0 || routeExtras.length > 0) {
    const details = [...routeMismatch];
    for (const n of routeExtras) details.push(`stale entry in ROUTE_BY_TOOL_NAME: ${n}`);
    fail('ROUTE_BY_TOOL_NAME disagrees with TOOLS_BY_APP_ID.', details);
  }

  // ---- Summary --------------------------------------------------------
  const appCount = Object.keys(TOOLS_BY_APP_ID).length;
  const toolCount = flat.length;
  console.log(
    `✅ ${toolCount} tools across ${appCount} app(s) agree with ` +
      `${capabilitySet.size} protocol capabilities.\n`,
  );
}

main();
