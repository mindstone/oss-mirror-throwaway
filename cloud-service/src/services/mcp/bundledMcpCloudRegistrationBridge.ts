import type { McpServerUpsertPayload } from '@shared/types';

export async function discoverBundledOAuthMcps(
  dataPath: string,
): Promise<McpServerUpsertPayload[]> {
  const mod = await import('../../../../src/main/services/bundledMcpCloudRegistration');
  return mod.discoverBundledOAuthMcps(dataPath);
}
