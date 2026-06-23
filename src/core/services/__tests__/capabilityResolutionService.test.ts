import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInfo, mockWarn, mockDebug } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockDebug: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: vi.fn(),
    debug: mockDebug,
    trace: vi.fn(),
  }),
}));

import { resolveCapabilities } from '../capabilityResolutionService';
import type { ConnectedPackage } from '../promptTemplateService';

describe('capabilityResolutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty resolution for empty connected packages', () => {
    const result = resolveCapabilities([]);

    expect(result).toEqual({
      disallowedTools: [],
      promptGuidance: [],
      activeCapabilities: [],
    });
  });

  it('resolves one capability from a single provider', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'Perplexity',
        description: 'AI-powered search',
        capabilities: [{ id: 'web-search' }],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result.disallowedTools).toEqual(['WebSearch']);
    expect(result.activeCapabilities).toEqual([
      { capabilityId: 'web-search', provider: 'Perplexity' },
    ]);
    expect(result.promptGuidance).toHaveLength(1);
    expect(result.promptGuidance[0]).toContain('MCP');
  });

  it('deduplicates disallowed tools and keeps guidance from all providers for the same capability', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'Perplexity',
        description: 'AI-powered search',
        capabilities: [{ id: 'web-search', promptGuidance: 'Use perplexity_search for fast web search.' }],
      },
      {
        name: 'Tavily',
        description: 'Agent search and extraction',
        capabilities: [{ id: 'web-search', promptGuidance: 'Use tavily-search and tavily-extract for research.' }],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result.disallowedTools).toEqual(['WebSearch']);
    expect(result.promptGuidance).toEqual([
      'Use perplexity_search for fast web search.',
      'Use tavily-search and tavily-extract for research.',
    ]);
    expect(result.activeCapabilities).toEqual([
      { capabilityId: 'web-search', provider: 'Perplexity' },
      { capabilityId: 'web-search', provider: 'Tavily' },
    ]);
  });

  it('unions disallowed tools from all recognized capabilities when mixed capability ids are present', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'Perplexity',
        description: 'AI-powered search',
        capabilities: [{ id: 'web-search' }],
      },
      {
        name: 'CustomResearch',
        description: 'Custom provider',
        capabilities: [{ id: 'unknown-capability' }],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result.disallowedTools).toEqual(['WebSearch']);
    expect(result.activeCapabilities).toEqual([
      { capabilityId: 'web-search', provider: 'Perplexity' },
    ]);
  });

  it('logs a warning and skips unknown capability ids', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'CustomProvider',
        description: 'Unknown MCP',
        capabilities: [{ id: 'something-else' }],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result).toEqual({
      disallowedTools: [],
      promptGuidance: [],
      activeCapabilities: [],
    });

    expect(mockDebug).toHaveBeenCalledTimes(1);
    expect(mockDebug).toHaveBeenCalledWith(
      { capabilityId: 'something-else', provider: 'CustomProvider' },
      'Unknown capability ID — skipping capability entry'
    );
  });

  it('uses custom prompt guidance when provided', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'Perplexity',
        description: 'AI-powered search',
        capabilities: [{ id: 'web-search', promptGuidance: 'Use perplexity_research for deep multi-step research.' }],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result.promptGuidance).toEqual([
      'Use perplexity_research for deep multi-step research.',
    ]);
  });

  it('ignores packages with an empty capabilities array', () => {
    const connectedPackages: ConnectedPackage[] = [
      {
        name: 'NoCapabilitiesProvider',
        description: 'No capability metadata',
        capabilities: [],
      },
    ];

    const result = resolveCapabilities(connectedPackages);

    expect(result).toEqual({
      disallowedTools: [],
      promptGuidance: [],
      activeCapabilities: [],
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
