/**
 * Plugin Skill ↔ MCP Server Consistency Test
 *
 * Verifies that plugin tool names referenced in skill files and AGENTS.md
 * match the actual tool names registered in the RebelPlugins MCP server.
 *
 * This catches the exact class of bug where tool names are renamed in the MCP
 * server but skill files still reference the old names, causing the agent to
 * call nonexistent tools.
 *
 * Run: npx vitest run scripts/__tests__/plugin-skill-mcp-consistency.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const REBEL_SYSTEM_DIR = join(PROJECT_ROOT, 'rebel-system');
const hasRebelSystem = existsSync(join(REBEL_SYSTEM_DIR, 'AGENTS.md'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all MCP tool names from the RebelPlugins server source.
 * Looks for the TOOL_NAMES constant object values.
 */
function extractMcpToolNames(): string[] {
  const serverPath = join(PROJECT_ROOT, 'resources', 'mcp', 'rebel-plugins', 'server.cjs');
  const source = readFileSync(serverPath, 'utf-8');

  // Match the TOOL_NAMES object: { key: 'rebel_plugins_xxx', ... }
  const toolNamesMatch = source.match(/const TOOL_NAMES\s*=\s*\{([^}]+)\}/);
  if (!toolNamesMatch) {
    throw new Error('Could not find TOOL_NAMES constant in server.cjs');
  }

  const toolNamesBlock = toolNamesMatch[1];
  const names: string[] = [];
  const valueRegex = /:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = valueRegex.exec(toolNamesBlock)) !== null) {
    names.push(match[1]);
  }

  if (names.length === 0) {
    throw new Error('No tool names extracted from TOOL_NAMES constant');
  }

  return names;
}

/**
 * Extract tool names from the "Available Tools" section of the build-custom-plugin skill.
 * Looks for bold tool names: **rebel_plugins_xxx**
 */
function extractSkillToolNames(skillContent: string): string[] {
  const toolsSection = skillContent.match(/## Available Tools\n([\s\S]*?)(?=\n##|$)/);
  if (!toolsSection) {
    throw new Error('Could not find "## Available Tools" section in skill file');
  }

  const names: string[] = [];
  const toolRegex = /\*\*(\w+)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = toolRegex.exec(toolsSection[1])) !== null) {
    names.push(match[1]);
  }

  return names;
}

/**
 * Extract plugin tool names referenced in the AGENTS.md plugins paragraph.
 * Looks for backtick-wrapped tool names: `rebel_plugins_xxx`
 */
function extractAgentsToolNames(agentsContent: string): string[] {
  // Find the plugins paragraph (contains "rebel_plugins_" or "Plugin" tool references)
  const pluginsLine = agentsContent.split('\n').find(line =>
    line.includes('rebel_plugins_create') || line.includes('CreatePlugin')
  );
  if (!pluginsLine) {
    return [];
  }

  const names: string[] = [];
  const toolRegex = /`(rebel_plugins_\w+)`/g;
  let match: RegExpExecArray | null;
  while ((match = toolRegex.exec(pluginsLine)) !== null) {
    names.push(match[1]);
  }

  return names;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Plugin skill ↔ MCP server consistency', () => {
  const mcpToolNames = extractMcpToolNames();

  it('MCP server registers expected plugin tools', () => {
    expect(mcpToolNames).toContain('rebel_plugins_create');
    expect(mcpToolNames).toContain('rebel_plugins_list');
    expect(mcpToolNames).toContain('rebel_plugins_get_source');
    expect(mcpToolNames).toContain('rebel_plugins_delete');
    expect(mcpToolNames).toContain('rebel_plugins_open');
  });

  it.skipIf(!hasRebelSystem)('build-custom-plugin skill references only valid MCP tool names', () => {
    const skillPath = join(PROJECT_ROOT, 'rebel-system', 'skills', 'system', 'build-custom-plugin', 'SKILL.md');
    const skillContent = readFileSync(skillPath, 'utf-8');
    const skillToolNames = extractSkillToolNames(skillContent);

    expect(skillToolNames.length).toBeGreaterThan(0);

    for (const name of skillToolNames) {
      expect(mcpToolNames, `Skill references tool "${name}" which is not registered in the MCP server`).toContain(name);
    }
  });

  it.skipIf(!hasRebelSystem)('build-custom-plugin skill files do not reference old PascalCase tool names', () => {
    const skillDir = join(PROJECT_ROOT, 'rebel-system', 'skills', 'system', 'build-custom-plugin');
    const oldNames = ['CreatePlugin', 'ListPlugins', 'GetPluginSource', 'DeletePlugin', 'OpenPlugin'];

    // Check SKILL.md and any conflict variants (e.g., SKILL.conflict-cloud.md)
    const { readdirSync } = require('fs');
    const skillFiles = readdirSync(skillDir)
      .filter((f: string) => f.startsWith('SKILL') && f.endsWith('.md'));

    expect(skillFiles.length).toBeGreaterThan(0);

    for (const file of skillFiles) {
      const content = readFileSync(join(skillDir, file), 'utf-8');
      for (const oldName of oldNames) {
        // Check anywhere in file: bold, backtick, or bare word boundary
        const anyRefPattern = new RegExp(`\\b${oldName}\\b`);
        expect(anyRefPattern.test(content), `${file} still references old tool name "${oldName}"`).toBe(false);
      }
    }
  });

  it.skipIf(!hasRebelSystem)('rebel-system/AGENTS.md plugin paragraph references only valid MCP tool names', () => {
    const agentsPath = join(PROJECT_ROOT, 'rebel-system', 'AGENTS.md');
    const agentsContent = readFileSync(agentsPath, 'utf-8');
    const agentsToolNames = extractAgentsToolNames(agentsContent);

    expect(agentsToolNames.length).toBeGreaterThan(0);

    for (const name of agentsToolNames) {
      expect(mcpToolNames, `AGENTS.md references tool "${name}" which is not registered in the MCP server`).toContain(name);
    }
  });

  it.skipIf(!hasRebelSystem)('rebel-system/AGENTS.md does not reference old PascalCase plugin tool names', () => {
    const agentsPath = join(PROJECT_ROOT, 'rebel-system', 'AGENTS.md');
    const agentsContent = readFileSync(agentsPath, 'utf-8');

    // Find the plugins paragraph
    const pluginsLine = agentsContent.split('\n').find(line =>
      line.includes('plugin') && (line.includes('rebel_plugins_') || line.includes('Plugin'))
    );

    if (pluginsLine) {
      const oldNames = ['CreatePlugin', 'ListPlugins', 'GetPluginSource'];
      for (const oldName of oldNames) {
        const backtickPattern = new RegExp(`\`${oldName}\``);
        expect(backtickPattern.test(pluginsLine), `AGENTS.md still references old tool name \`${oldName}\``).toBe(false);
      }
    }
  });
});
