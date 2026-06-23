import { parseMultiInstanceServer } from './mcpInstanceUtils';

export function getConnectorSectionId(serverName?: string): string | undefined {
  if (!serverName) return undefined;

  const parsed = parseMultiInstanceServer(serverName);
  const baseName = parsed.isInstance && parsed.baseName ? parsed.baseName : serverName;
  return `connector-${baseName.toLowerCase()}`;
}
