import { probeProviderReachability } from '../providerReachabilitySnapshot';

setInterval(() => {
  probeProviderReachability('anthropic');
}, 30000);

setTimeout(() => {
  probeProviderReachability('openai');
}, 30000);
