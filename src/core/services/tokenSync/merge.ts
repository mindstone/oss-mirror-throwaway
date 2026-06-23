import type { TokenFileMetadata } from './types';

export type MergeDecision = 'adopt_peer' | 'keep_local' | 'tie_cloud_wins';

export function mergeDecision(
  local: TokenFileMetadata | null,
  peer: TokenFileMetadata,
  leniency: number = 1000,
): MergeDecision {
  if (!local) return 'adopt_peer';

  const marginMs = Math.max(0, leniency);
  if (peer.expiryEpochMs > local.expiryEpochMs + marginMs) {
    return 'adopt_peer';
  }
  if (local.expiryEpochMs > peer.expiryEpochMs + marginMs) {
    return 'keep_local';
  }
  return 'tie_cloud_wins';
}
