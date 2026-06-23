import type { ToolDefinition } from './modelTypes';
import {
  executeBuiltinTool,
  getBuiltinToolDefinition,
  getBuiltinToolDefinitions,
} from './builtinTools';
import type { BuiltinToolContext, ToolExecutionResult } from './types';

export interface ToolRegistryEntry {
  name: string;
  definition: ToolDefinition;
  execute: (input: unknown, context?: BuiltinToolContext) => Promise<ToolExecutionResult>;
}

const BUILTIN_ENTRIES: ToolRegistryEntry[] = getBuiltinToolDefinitions().map((definition) => ({
  name: definition.name,
  definition,
  execute: (input: unknown, context: BuiltinToolContext = {}) =>
    executeBuiltinTool(definition.name, input, context),
}));

const TOOL_REGISTRY = new Map<string, ToolRegistryEntry>(
  BUILTIN_ENTRIES.map((entry) => [entry.name, entry]),
);

export const listRegisteredTools = (): ToolDefinition[] =>
  Array.from(TOOL_REGISTRY.values(), (entry) => entry.definition);

export const hasRegisteredTool = (toolName: string): boolean => TOOL_REGISTRY.has(toolName);

export const getRegisteredTool = (toolName: string): ToolRegistryEntry | undefined =>
  TOOL_REGISTRY.get(toolName);

export const getRegisteredToolDefinition = (toolName: string): ToolDefinition | undefined =>
  getBuiltinToolDefinition(toolName) ?? TOOL_REGISTRY.get(toolName)?.definition;

export const executeRegisteredTool = async (
  toolName: string,
  input: unknown,
  context: BuiltinToolContext = {},
): Promise<ToolExecutionResult> => {
  const registeredTool = TOOL_REGISTRY.get(toolName);
  if (!registeredTool) {
    return {
      output: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  return registeredTool.execute(input, context);
};
