import { createScopedLogger } from '@core/logger';
import type { McpCapabilityId } from '@shared/types';
import type { ConnectedPackage } from './promptTemplateService';

const log = createScopedLogger({ service: 'capabilityResolution' });

interface CapabilityRegistryEntry {
  /** Built-in tools to suppress when the capability is active. */
  disallowedTools: readonly string[];
  /** Default prompt guidance when the connector does not provide custom guidance. */
  defaultGuidance: string;
}

const CAPABILITY_REGISTRY: Record<McpCapabilityId, CapabilityRegistryEntry> = {
  'web-search': {
    disallowedTools: ['WebSearch'],
    defaultGuidance:
      'A connected MCP server provides superior web search capabilities. Use MCP search tools instead of built-in web search for richer and cited results.',
  },
};

export interface CapabilityResolution {
  disallowedTools: string[];
  promptGuidance: string[];
  activeCapabilities: Array<{ capabilityId: string; provider: string }>;
}

export const resolveCapabilities = (
  connectedPackages: ConnectedPackage[]
): CapabilityResolution => {
  const disallowedToolsSet = new Set<string>();
  const promptGuidanceSet = new Set<string>();
  const activeCapabilities: CapabilityResolution['activeCapabilities'] = [];

  for (const pkg of connectedPackages) {
    if (!Array.isArray(pkg.capabilities) || pkg.capabilities.length === 0) {
      continue;
    }

    for (const capability of pkg.capabilities) {
      const registryEntry = CAPABILITY_REGISTRY[capability.id as McpCapabilityId];

      if (!registryEntry) {
        log.debug(
          { capabilityId: capability.id, provider: pkg.name },
          'Unknown capability ID — skipping capability entry'
        );
        continue;
      }

      activeCapabilities.push({
        capabilityId: capability.id,
        provider: pkg.name,
      });

      for (const tool of registryEntry.disallowedTools) {
        disallowedToolsSet.add(tool);
      }

      const guidance = capability.promptGuidance || registryEntry.defaultGuidance;
      promptGuidanceSet.add(guidance);
    }
  }

  if (activeCapabilities.length > 0) {
    log.info(
      {
        activeCapabilities,
        disallowedTools: Array.from(disallowedToolsSet),
      },
      'Resolved MCP capabilities'
    );
  }

  return {
    disallowedTools: Array.from(disallowedToolsSet),
    promptGuidance: Array.from(promptGuidanceSet),
    activeCapabilities,
  };
};
