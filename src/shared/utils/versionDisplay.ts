export type BuildChannel = 'stable' | 'beta' | 'dev';

export function getBuildChannelSuffix(buildChannel?: BuildChannel | null): string {
  if (buildChannel === 'beta') return ' (beta)';
  if (buildChannel === 'dev') return ' (dev)';
  return '';
}

export function formatVersionWithChannel(version: string, buildChannel?: BuildChannel | null): string {
  return `${version}${getBuildChannelSuffix(buildChannel)}`;
}
