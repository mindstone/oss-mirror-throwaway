import { describe, expect, it } from 'vitest';
import type { ConnectorCatalogEntry } from '@shared/types/mcp';
import type { ProviderKeys } from '@shared/types/settings';
import {
  resolveProviderKeyMappingsInMcpConfig,
  type McpServersConfig,
} from '../services/mcpEnvResolver';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Stage 0.5 symmetry contract intentionally compares cloud resolver output against the desktop helper.
import { applyProviderKeyMappingToEnv } from '@main/services/bundledMcpManager';

const OPENAI_SPEC = '@mindstone-engineering/mcp-server-openai-image@0.1.0';
const COMMUNITY_SPEC = '@mindstone/community-mcp@0.1.0';

const openAiCatalogEntry = {
  id: 'openai-image-generation',
  provider: 'rebel-oss',
  bundledConfig: {
    providerKeyMapping: {
      OPENAI_API_KEY: 'openai',
    },
  },
  mcpConfig: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', OPENAI_SPEC],
    env: {
      OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
    },
  },
} as unknown as ConnectorCatalogEntry;

const noMappingCatalogEntry = {
  id: 'bundled-community-connector',
  provider: 'rebel-oss',
  mcpConfig: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', COMMUNITY_SPEC],
    env: {
      COMMUNITY_TOKEN: '{{COMMUNITY_TOKEN}}',
    },
  },
} as unknown as ConnectorCatalogEntry;

const baseCatalog = [openAiCatalogEntry, noMappingCatalogEntry] as const;

const createOpenAiConfig = (openAiValue: string): McpServersConfig => ({
  mcpServers: {
    OpenAIImageGeneration: {
      command: 'npx',
      args: ['-y', OPENAI_SPEC],
      env: {
        OPENAI_API_KEY: openAiValue,
      },
    },
  },
});

describe('resolveProviderKeyMappingsInMcpConfig', () => {
  it('resolves {{OPENAI_API_KEY}} placeholder using providerKeys.openai', () => {
    const config = createOpenAiConfig('{{OPENAI_API_KEY}}');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('fake-test');
  });

  it('resolves empty-string OPENAI_API_KEY slots from provider keys', () => {
    const config = createOpenAiConfig('');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('fake-test');
  });

  it('writes an empty string when the provider key is absent', () => {
    const config = createOpenAiConfig('{{OPENAI_API_KEY}}');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: null,
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('');
  });

  it('is idempotent when run multiple times', () => {
    const config = createOpenAiConfig('{{OPENAI_API_KEY}}');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);
    const afterFirstRun = JSON.stringify(config);

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);
    const afterSecondRun = JSON.stringify(config);

    expect(afterSecondRun).toBe(afterFirstRun);
  });

  it('preserves non-exact literal values containing braces', () => {
    const config = createOpenAiConfig('{{OPENAI_API_KEY-REAL}}');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('{{OPENAI_API_KEY-REAL}}');
  });

  it('no-ops for catalog entries without providerKeyMapping', () => {
    const config: McpServersConfig = {
      mcpServers: {
        CommunityConnector: {
          command: 'npx',
          args: ['-y', COMMUNITY_SPEC],
          env: {
            COMMUNITY_TOKEN: '{{COMMUNITY_TOKEN}}',
          },
        },
      },
    };

    resolveProviderKeyMappingsInMcpConfig(config, [noMappingCatalogEntry], {
      openai: 'fake-test',
    } as ProviderKeys);

    expect(config).toEqual({
      mcpServers: {
        CommunityConnector: {
          command: 'npx',
          args: ['-y', COMMUNITY_SPEC],
          env: {
            COMMUNITY_TOKEN: '{{COMMUNITY_TOKEN}}',
          },
        },
      },
    });
  });

  it('trims whitespace from provider key values', () => {
    const config = createOpenAiConfig('{{OPENAI_API_KEY}}');

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: '  fake-test  ',
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('fake-test');
  });

  it('only mutates matching connectors when multiple connectors exist', () => {
    const config: McpServersConfig = {
      mcpServers: {
        OpenAIImageGeneration: {
          command: 'npx',
          args: ['-y', OPENAI_SPEC],
          env: {
            OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
          },
        },
        CommunityConnector: {
          command: 'npx',
          args: ['-y', COMMUNITY_SPEC],
          env: {
            COMMUNITY_TOKEN: '{{COMMUNITY_TOKEN}}',
          },
        },
      },
    };

    resolveProviderKeyMappingsInMcpConfig(config, baseCatalog, {
      openai: 'fake-test',
    } as ProviderKeys);

    expect(config.mcpServers?.OpenAIImageGeneration?.env?.OPENAI_API_KEY).toBe('fake-test');
    expect(config.mcpServers?.CommunityConnector?.env?.COMMUNITY_TOKEN).toBe('{{COMMUNITY_TOKEN}}');
  });
});

describe('Stage 0 ↔ Stage 0.5 cohort symmetry contract', () => {
  it('matches desktop applyProviderKeyMappingToEnv output for credentials-empty inputs', () => {
    const mapping = { OPENAI_API_KEY: 'openai' } as const;
    const scenarios: Array<{ env: Record<string, string>; providerKeys: ProviderKeys | undefined }> = [
      {
        env: { OPENAI_API_KEY: '{{OPENAI_API_KEY}}' },
        providerKeys: { openai: 'fake-test' } as ProviderKeys,
      },
      {
        env: { OPENAI_API_KEY: '' },
        providerKeys: { openai: null } as ProviderKeys,
      },
      {
        env: { OPENAI_API_KEY: '{{OPENAI_API_KEY-REAL}}' },
        providerKeys: { openai: 'fake-test' } as ProviderKeys,
      },
      {
        env: { OPENAI_API_KEY: '{{OPENAI_API_KEY}}' },
        providerKeys: { openai: '  fake-trimmed  ' } as ProviderKeys,
      },
    ];

    for (const { env, providerKeys } of scenarios) {
      const desktopOutput = applyProviderKeyMappingToEnv(
        { ...env },
        mapping,
        providerKeys,
        'preserve',
      );

      const cloudConfig: McpServersConfig = {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', OPENAI_SPEC],
            env: { ...env },
          },
        },
      };
      resolveProviderKeyMappingsInMcpConfig(cloudConfig, [openAiCatalogEntry], providerKeys);
      const cloudOutput = cloudConfig.mcpServers?.OpenAIImageGeneration?.env as Record<string, string>;

      expect(JSON.stringify(cloudOutput)).toBe(JSON.stringify(desktopOutput));
    }
  });
});
