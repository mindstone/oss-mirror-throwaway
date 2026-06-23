/**
 * MCP Catalog Schema Validation — Structural correctness checks for connector-catalog.json.
 *
 * Validates that all connectors have required fields, valid enum values, consistent
 * structure, and no duplicates. These are pure structural checks — no network access,
 * no env gates, no MCP server startup.
 *
 * Run: npx vitest run scripts/__tests__/mcp-catalog-schema.test.ts
 *
 * @see resources/connector-catalog.json
 * @see docs/plans/finished/260223_mcp_test_coverage_improvements.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Setup ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(__dirname, '..', '..');
const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');

interface CatalogConnector {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  provider?: string;
  maturity?: string;
  mcpConfig?: {
    transport?: string;
    command?: string;
    args?: string[];
    url?: string;
  };
  setupFields?: Array<{
    id?: string;
    label?: string;
    type?: string;
    [key: string]: unknown;
  }>;
  bundledConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const connectors: CatalogConnector[] = catalog.connectors ?? [];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP Catalog Schema Validation', () => {
  it('should have at least one connector', () => {
    expect(connectors.length).toBeGreaterThan(0);
  });

  it('every connector has required fields (id, name, description, category, provider)', () => {
    const missing: string[] = [];
    for (const c of connectors) {
      const label = c.id ?? c.name ?? '(unknown)';
      if (!c.id) missing.push(`${label}: missing "id"`);
      if (!c.name) missing.push(`${label}: missing "name"`);
      if (!c.description) missing.push(`${label}: missing "description"`);
      if (!c.category) missing.push(`${label}: missing "category"`);
      if (!c.provider) missing.push(`${label}: missing "provider"`);
    }
    expect(missing, `Connectors with missing required fields:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('provider values are valid', () => {
    const validProviders = new Set(['direct', 'community', 'bundled', 'rebel-oss']);
    const invalid: string[] = [];
    for (const c of connectors) {
      if (c.provider && !validProviders.has(c.provider)) {
        invalid.push(`${c.id}: provider "${c.provider}" is not one of ${[...validProviders].join(', ')}`);
      }
    }
    expect(invalid, `Connectors with invalid provider:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('transport values are valid (stdio, http, sse)', () => {
    const validTransports = new Set(['stdio', 'http', 'sse']);
    const invalid: string[] = [];
    for (const c of connectors) {
      if (c.mcpConfig?.transport && !validTransports.has(c.mcpConfig.transport)) {
        invalid.push(`${c.id}: transport "${c.mcpConfig.transport}" is not one of ${[...validTransports].join(', ')}`);
      }
    }
    expect(invalid, `Connectors with invalid transport:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('community stdio MCPs have runnable commands', () => {
    const missing: string[] = [];
    for (const c of connectors) {
      if (c.provider === 'community' && c.mcpConfig?.transport === 'stdio') {
        if (!c.mcpConfig.command) {
          missing.push(`${c.id}: community stdio MCP missing "command"`);
        }
      }
    }
    expect(missing, `Community stdio MCPs without command:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('no duplicate IDs', () => {
    const seen = new Map<string, number>();
    for (const c of connectors) {
      if (c.id) {
        seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
      }
    }
    const dupes = [...seen.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} (×${count})`);
    expect(dupes, `Duplicate connector IDs:\n${dupes.join('\n')}`).toHaveLength(0);
  });

  it('setupFields have required structure (id, label, type)', () => {
    const invalid: string[] = [];
    for (const c of connectors) {
      if (!c.setupFields) continue;
      for (let i = 0; i < c.setupFields.length; i++) {
        const field = c.setupFields[i];
        const fieldLabel = `${c.id}.setupFields[${i}]`;
        if (!field.id) invalid.push(`${fieldLabel}: missing "id"`);
        if (!field.label) invalid.push(`${fieldLabel}: missing "label"`);
        if (!field.type) invalid.push(`${fieldLabel}: missing "type"`);
      }
    }
    expect(invalid, `setupFields with missing required properties:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('community stdio npx MCPs have valid package references', () => {
    // When command is "npx" and args contains "-y", the next arg should look like
    // a valid npm package specifier (e.g., "@scope/name", "name@1.0.0")
    const npmPackagePattern = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(@[\w.^~>=<|-]+)?$/;
    const invalid: string[] = [];
    for (const c of connectors) {
      if (c.provider !== 'community') continue;
      if (c.mcpConfig?.command !== 'npx') continue;
      const args = c.mcpConfig.args ?? [];
      const yIndex = args.indexOf('-y');
      if (yIndex === -1 || yIndex >= args.length - 1) continue;
      const packageArg = args[yIndex + 1];
      if (!npmPackagePattern.test(packageArg)) {
        invalid.push(`${c.id}: package arg "${packageArg}" doesn't match npm package specifier pattern`);
      }
    }
    expect(invalid, `Invalid npm package references:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('rebel-oss stdio npx MCPs have fully-resolved @mindstone or @mindstone-engineering package references', () => {
    // Rebel-OSS connectors are published by the maintainers under the
    // `@mindstone/mcp-server-<name>` scope (with legacy support for
    // `@mindstone-engineering/mcp-server-<name>`) with a concrete pinned
    // semver. We enforce three invariants on every non-hidden rebel-oss entry:
    //   1. Scope must be `@mindstone/mcp-server-<name>` or
    //      `@mindstone-engineering/mcp-server-<name>`.
    //   2. Version must be an exact semver (`@1.2.3` or `@1.2.3-prerelease`),
    //      not a range (`^`, `~`) and not a dist-tag (`latest`, `next`, `beta`).
    //   3. No placeholder sentinels (`TODO`, `TBD`, `PLACEHOLDER`, `x.y.z`).
    // Hidden entries are allowed to use placeholders while awaiting publish —
    // flipping `hidden: false` should be the same PR as pinning the version.
    const invalid: string[] = [];
    const placeholderPattern = /(^|[@:])(todo|tbd|placeholder|xyz|x\.y\.z)([_.-]|$)/i;
    // Strict: `@mindstone/mcp-server-<kebab-name>@<exact-semver>` (legacy
    // `@mindstone-engineering/...` also accepted during transition).
    const scopedExactSemverPattern =
      /^@(?:mindstone|mindstone-engineering)\/mcp-server-[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+(?:-[\w.]+(?:\+[\w.]+)?|\+[\w.]+)?$/;
    for (const c of connectors) {
      if (c.provider !== 'rebel-oss') continue;
      // Strict equality: only the literal `true` boolean exempts an entry.
      if (c.hidden === true) continue;
      if (c.mcpConfig?.command !== 'npx') continue;
      const args = c.mcpConfig.args ?? [];
      const yIndex = args.indexOf('-y');
      if (yIndex === -1 || yIndex >= args.length - 1) continue;
      const packageArg = args[yIndex + 1];
      if (placeholderPattern.test(packageArg)) {
        invalid.push(
          `${c.id}: package arg "${packageArg}" contains a placeholder version — ` +
            `publish the npm package and pin a concrete version, or mark the entry \`hidden: true\` until then`,
        );
        continue;
      }
      if (!scopedExactSemverPattern.test(packageArg)) {
        invalid.push(
          `${c.id}: package arg "${packageArg}" must be "@mindstone/mcp-server-<name>@<exact-semver>" or "@mindstone-engineering/mcp-server-<name>@<exact-semver>" ` +
            `(exact pins only — no ^, ~, or dist-tags like @latest / @next / @beta — these make installs non-reproducible).`,
        );
      }
    }
    expect(invalid, `Invalid rebel-oss package references:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('HTTP/SSE MCPs have a URL (or user-provided URL via setupFields)', () => {
    const missing: string[] = [];
    for (const c of connectors) {
      const transport = c.mcpConfig?.transport;
      if (transport === 'http' || transport === 'sse') {
        const hasUrl = !!c.mcpConfig?.url;
        const hasUrlSetupField = c.setupFields?.some((f: { id: string; type: string }) => f.id === 'url' && f.type === 'url');
        if (!hasUrl && !hasUrlSetupField) {
          missing.push(`${c.id}: ${transport} transport but no "url" in mcpConfig or setupFields`);
        }
      }
    }
    expect(missing, `HTTP/SSE MCPs without URL:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('bundled connectors have bundledConfig', () => {
    const missing: string[] = [];
    for (const c of connectors) {
      if (c.provider === 'bundled' && !c.bundledConfig) {
        missing.push(`${c.id}: bundled provider but no "bundledConfig"`);
      }
    }
    expect(missing, `Bundled connectors without bundledConfig:\n${missing.join('\n')}`).toHaveLength(0);
  });

  it('community stdio commands are from a known set', () => {
    const knownCommands = new Set(['npx', 'uvx', 'uv', 'node', 'docker']);
    const invalid: string[] = [];
    for (const c of connectors) {
      if (c.provider === 'community' && c.mcpConfig?.transport === 'stdio' && c.mcpConfig.command) {
        if (!knownCommands.has(c.mcpConfig.command)) {
          invalid.push(`${c.id}: command "${c.mcpConfig.command}" is not one of ${[...knownCommands].join(', ')}`);
        }
      }
    }
    expect(invalid, `Community MCPs with unknown commands:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('maturity values are valid', () => {
    const validMaturity = new Set(['stable', 'beta', 'deprecated', 'preview']);
    const invalid: string[] = [];
    for (const c of connectors) {
      if (c.maturity && !validMaturity.has(c.maturity)) {
        invalid.push(`${c.id}: maturity "${c.maturity}" is not one of ${[...validMaturity].join(', ')}`);
      }
    }
    expect(invalid, `Connectors with invalid maturity:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('tools entries have valid structure when present', () => {
    const invalid: string[] = [];
    for (const c of connectors) {
      if (!c.tools) continue;
      if (!Array.isArray(c.tools)) {
        invalid.push(`${c.id}: "tools" must be an array`);
        continue;
      }
      for (let i = 0; i < c.tools.length; i++) {
        const tool = c.tools[i] as { name?: unknown; description?: unknown };
        const toolLabel = `${c.id}.tools[${i}]`;
        if (typeof tool.name !== 'string') {
          invalid.push(`${toolLabel}: "name" must be a string`);
        } else {
          const trimmedName = tool.name.trim();
          if (trimmedName.length < 1 || tool.name.length > 200) {
            invalid.push(`${toolLabel}: "name" must be 1-200 characters and non-empty`);
          }
        }
        if (tool.description !== undefined && typeof tool.description !== 'string') {
          invalid.push(`${toolLabel}: "description" must be a string or undefined`);
        }
        if (typeof tool.description === 'string' && tool.description.trim().length === 0) {
          invalid.push(`${toolLabel}: "description" must not be an empty string`);
        }
      }
    }
    expect(invalid, `Connectors with invalid tools structure:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('tools do not contain duplicate names within the same connector', () => {
    const invalid: string[] = [];
    for (const c of connectors) {
      if (!Array.isArray(c.tools) || c.tools.length === 0) continue;
      const seen = new Map<string, number>();
      for (const rawTool of c.tools) {
        const tool = rawTool as { name?: unknown };
        if (typeof tool.name !== 'string') continue;
        const name = tool.name.trim();
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
      const duplicates = new Set(
        [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name),
      );
      if (duplicates.size > 0) {
        invalid.push(`${c.id}: duplicate tool names (${[...duplicates].join(', ')})`);
      }
    }
    expect(invalid, `Connectors with duplicate tool names:\n${invalid.join('\n')}`).toHaveLength(0);
  });

  it('every connector has a tools array', () => {
    const missing = connectors.filter(c => !Array.isArray(c.tools));
    if (missing.length > 0) {
      console.warn(
        `[catalog-schema] ${missing.length} connector(s) missing "tools" array:\n` +
        missing.map(c => `  - ${c.id}`).join('\n'),
      );
    }
    expect(missing, `Connectors missing "tools" array:\n${missing.map(c => c.id).join(', ')}`).toHaveLength(0);
  });

  it('contributors entries have valid structure when present', () => {
    const invalid: string[] = [];
    for (const c of connectors) {
      if (!c.contributors) continue;
      if (!Array.isArray(c.contributors)) {
        invalid.push(`${c.id}: "contributors" must be an array`);
        continue;
      }
      for (let i = 0; i < c.contributors.length; i++) {
        const contributor = c.contributors[i] as { name?: unknown; github?: unknown };
        const label = `${c.id}.contributors[${i}]`;
        if (typeof contributor.name !== 'string' || contributor.name.trim().length === 0) {
          invalid.push(`${label}: "name" must be a non-empty string`);
        }
        if (typeof contributor.github !== 'string' || contributor.github.trim().length === 0) {
          invalid.push(`${label}: "github" must be a non-empty string`);
        }
      }
    }
    expect(invalid, `Connectors with invalid contributors structure:\n${invalid.join('\n')}`).toHaveLength(0);
  });
});
