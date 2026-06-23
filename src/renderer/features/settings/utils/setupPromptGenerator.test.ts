import { describe, expect, it } from 'vitest';
import type { ConnectorCatalogEntry } from '@shared/types';
import { generateSetupPrompt } from './setupPromptGenerator';

function createApiKeyConnector(overrides: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return {
    id: 'bundled-fathom',
    name: 'Fathom',
    description: 'Meeting notes and transcripts',
    category: 'meetings',
    icon: 'fathom',
    provider: 'bundled',
    bundledConfig: {
      packageName: '@mindstone/fathom',
      authType: 'api-key',
      setupToolName: 'rebel_fathom_setup',
    },
    ...overrides,
  } as ConnectorCatalogEntry;
}

describe('generateSetupPrompt', () => {
  it('tells the agent to attach the setup URL to AskUserQuestion for API key flows', async () => {
    const prompt = await generateSetupPrompt({
      serverName: 'Fathom',
      catalogEntry: createApiKeyConnector({
        setupUrl: 'https://fathom.video/customize#api-access-header',
      }),
    });

    expect(prompt).toContain('Ask me for my API key using `AskUserQuestion`.');
    expect(prompt).toContain('`requiresInput: true`');
    expect(prompt).toContain('Set that option\'s `url` to https://fathom.video/customize#api-access-header');
  });

  it('tells the agent to attach the setup URL for multi-field credential flows', async () => {
    const prompt = await generateSetupPrompt({
      serverName: 'Example Connector',
      catalogEntry: createApiKeyConnector({
        id: 'bundled-example',
        name: 'Example Connector',
        setupUrl: 'https://example.com/credentials',
        setupFields: [
          { id: 'clientId', label: 'Client ID', type: 'password' },
          { id: 'clientSecret', label: 'Client Secret', type: 'password' },
        ],
      }),
    });

    expect(prompt).toContain('Ask me for my Client ID and Client Secret using `AskUserQuestion`.');
    expect(prompt).toContain('Use option cards with inline input, not just prose.');
    expect(prompt).toContain('set the option `url` to https://example.com/credentials');
  });
});
