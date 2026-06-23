export type MultiRebelWorkspaceLike = {
  peerInstanceCount?: unknown;
} | null | undefined;

export function normalizePeerInstanceCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function detectPeerInstanceCount(workspace: MultiRebelWorkspaceLike): number | undefined {
  return normalizePeerInstanceCount(workspace?.peerInstanceCount);
}

export function isMultiRebelWorkspace(workspace: MultiRebelWorkspaceLike): boolean {
  const count = detectPeerInstanceCount(workspace);
  return typeof count === 'number' && count > 1;
}
