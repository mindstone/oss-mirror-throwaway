import type { OAuthToolResolution, OAuthToolResolver } from '@core/setOAuthToolResolver';
import { parseMultiInstanceServer } from '@shared/utils/mcpInstanceUtils';

const INFRA_SERVER_IDS = new Set(['super-mcp-router', 'mcp']);
const PROVIDER_ALIASES: Array<{ provider: OAuthToolResolution['provider']; aliases: string[] }> = [
  { provider: 'google', aliases: ['google', 'googleworkspace', 'google-workspace'] },
  { provider: 'slack', aliases: ['slack', 'slackworkspace', 'slack-workspace'] },
  { provider: 'hubspot', aliases: ['hubspot', 'hub-spot'] },
  { provider: 'microsoft', aliases: ['microsoft', 'microsoft365', 'office365', 'outlook'] },
];

function extractServerId(toolName: string): string | null {
  if (!toolName) return null;

  if (toolName.startsWith('mcp__') && !toolName.includes('/')) {
    const segments = toolName.split('__');
    if (segments.length >= 3) {
      return segments[1] ?? null;
    }
  }

  if (toolName.includes('/')) {
    const [serverId] = toolName.split('/');
    return serverId ?? null;
  }

  return null;
}

function resolveProvider(serverId: string): OAuthToolResolution['provider'] | null {
  const parsed = parseMultiInstanceServer(serverId);
  const candidateBase = parsed.isInstance && parsed.baseName
    ? parsed.baseName
    : serverId;
  const candidate = candidateBase.toLowerCase();

  for (const entry of PROVIDER_ALIASES) {
    if (entry.aliases.some((alias) => candidate === alias)) {
      return entry.provider;
    }
  }
  return null;
}

export class DesktopOAuthToolResolver implements OAuthToolResolver {
  resolve(toolName: string): OAuthToolResolution | null {
    const serverId = extractServerId(toolName);
    if (!serverId) return null;

    if (INFRA_SERVER_IDS.has(serverId.toLowerCase())) {
      return null;
    }

    const provider = resolveProvider(serverId);
    if (!provider) return null;
    return {
      provider,
      accountKey: serverId,
    };
  }
}
