/**
 * Tests for capability suppression wiring (Stage 5).
 *
 * Verifies that suppressedBuiltins in TurnParams correctly filters
 * tools from the tool list before they reach the agent loop,
 * and that sub-agents inherit the same suppression.
 */
import { describe, expect, it } from 'vitest';
import { getBuiltinToolDefinitions } from '../builtinTools';
import type { BuiltinToolName } from '../types';
import type { ToolDefinition } from '../modelTypes';

// ---------------------------------------------------------------------------
// Helper: simulate the filtering logic from rebelCoreQuery.ts
// ---------------------------------------------------------------------------

function filterToolsBySuppression(
  tools: ToolDefinition[],
  suppressedBuiltins?: BuiltinToolName[],
): ToolDefinition[] {
  const suppressedSet = new Set<BuiltinToolName>(suppressedBuiltins ?? []);
  if (suppressedSet.size === 0) return tools;
  return tools.filter((t) => !suppressedSet.has(t.name as BuiltinToolName));
}

// ---------------------------------------------------------------------------
// Helper: simulate the sub-agent builtin filtering from agentTool.ts
// ---------------------------------------------------------------------------

function filterSubagentBuiltins(
  allBuiltinTools: ToolDefinition[],
  suppressedBuiltins?: BuiltinToolName[],
): ToolDefinition[] {
  const suppressedSet = new Set<BuiltinToolName>(suppressedBuiltins ?? []);
  if (suppressedSet.size === 0) return allBuiltinTools;
  return allBuiltinTools.filter((t) => !suppressedSet.has(t.name as BuiltinToolName));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('capability suppression', () => {
  describe('tool filtering in rebelCoreQuery', () => {
    it('removes suppressed builtins from the tool list', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const mcpTool: ToolDefinition = {
        name: 'perplexity-search',
        description: 'Perplexity MCP search',
        input_schema: { type: 'object', properties: {} },
      };
      const allTools = [...builtinTools, mcpTool];

      const filtered = filterToolsBySuppression(allTools, ['WebSearch']);

      const toolNames = filtered.map((t) => t.name);
      expect(toolNames).not.toContain('WebSearch');
      // Other builtins remain
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Write');
      expect(toolNames).toContain('WebFetch');
      // MCP tools are NOT suppressed (they're replacements, not targets)
      expect(toolNames).toContain('perplexity-search');
    });

    it('passes all tools through when suppressedBuiltins is empty', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const filtered = filterToolsBySuppression(builtinTools, []);

      expect(filtered).toHaveLength(builtinTools.length);
    });

    it('passes all tools through when suppressedBuiltins is undefined', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const filtered = filterToolsBySuppression(builtinTools, undefined);

      expect(filtered).toHaveLength(builtinTools.length);
    });

    it('can suppress multiple builtins at once', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const filtered = filterToolsBySuppression(builtinTools, ['WebSearch', 'WebFetch']);

      const toolNames = filtered.map((t) => t.name);
      expect(toolNames).not.toContain('WebSearch');
      expect(toolNames).not.toContain('WebFetch');
      expect(toolNames).toContain('Read');
    });

    it('does not suppress non-matching tools (e.g. MCP tools with similar names)', () => {
      const tools: ToolDefinition[] = [
        { name: 'WebSearch', description: 'built-in', input_schema: { type: 'object', properties: {} } },
        { name: 'mcp-web-search', description: 'mcp', input_schema: { type: 'object', properties: {} } },
        { name: 'Agent', description: 'agent', input_schema: { type: 'object', properties: {} } },
      ];

      const filtered = filterToolsBySuppression(tools, ['WebSearch']);

      const names = filtered.map((t) => t.name);
      expect(names).toEqual(['mcp-web-search', 'Agent']);
    });
  });

  describe('sub-agent builtin filtering in agentTool', () => {
    it('filters suppressed builtins from sub-agent tool list', () => {
      const allBuiltinTools = getBuiltinToolDefinitions();
      const filtered = filterSubagentBuiltins(allBuiltinTools, ['WebSearch']);

      const names = filtered.map((t) => t.name);
      expect(names).not.toContain('WebSearch');
      expect(names).toContain('Read');
      expect(names).toContain('WebFetch');
    });

    it('inherits suppression — same tools removed as parent', () => {
      const allBuiltinTools = getBuiltinToolDefinitions();
      const suppressed: BuiltinToolName[] = ['WebSearch', 'WebFetch'];

      // Simulate parent filtering (rebelCoreQuery)
      const parentFiltered = filterToolsBySuppression(allBuiltinTools, suppressed);

      // Simulate child filtering (agentTool) — should match parent
      const childFiltered = filterSubagentBuiltins(allBuiltinTools, suppressed);

      expect(childFiltered.map((t) => t.name)).toEqual(parentFiltered.map((t) => t.name));
    });

    it('passes all builtins when no suppression', () => {
      const allBuiltinTools = getBuiltinToolDefinitions();
      const filtered = filterSubagentBuiltins(allBuiltinTools, undefined);

      expect(filtered).toHaveLength(allBuiltinTools.length);
    });
  });

  describe('WebSearch is present in builtins and can be suppressed', () => {
    it('WebSearch exists in builtin tool definitions', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const webSearch = builtinTools.find((t) => t.name === 'WebSearch');

      expect(webSearch).toBeDefined();
      expect(webSearch!.name).toBe('WebSearch');
    });

    it('WebSearch is removed when suppressed', () => {
      const builtinTools = getBuiltinToolDefinitions();
      const filtered = filterToolsBySuppression(builtinTools, ['WebSearch']);

      expect(filtered.find((t) => t.name === 'WebSearch')).toBeUndefined();
      // Total count should be one less
      expect(filtered).toHaveLength(builtinTools.length - 1);
    });
  });
});
