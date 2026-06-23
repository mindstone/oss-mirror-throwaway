/**
 * Cloud Provider Registry
 *
 * Simple lookup for registered cloud providers.
 */

import type { CloudProvider, CloudProviderId } from './types';
import { flyProvider } from './flyProvider';
import { digitalOceanProvider } from './digitalOceanProvider';
import { hetznerProvider } from './hetznerProvider';

// Note: 'mindstone' (managed cloud) is not in the registry — it uses the
// handler-direct flow in cloudHandlers.ts, not the provider abstraction.
const providers: Record<string, CloudProvider> = {
  fly: flyProvider,
  digitalocean: digitalOceanProvider,
  hetzner: hetznerProvider,
};

export function getCloudProvider(id: CloudProviderId): CloudProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown cloud provider: ${id}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

export function getCloudProviderOrDefault(id?: string): CloudProvider {
  return getCloudProvider((id as CloudProviderId) ?? 'fly');
}

export { type CloudProvider, type CloudProviderId } from './types';
export type {
  CloudProviderConfig,
  CloudProvisionOptions,
  CloudProvisionStep,
  CloudProvisionResult,
  CloudDeprovisionResult,
  CloudStatusResult,
} from './types';
