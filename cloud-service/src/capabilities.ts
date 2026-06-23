export const CLOUD_CAPABILITIES = [
  'session-event-delta-push',
  'session-metadata-patch',
  'meeting-trigger-detection',
  'session-delta-chunked',
  'session-content-refs',
  'session-reconcile-handshake',
  'cloud-resource-pressure',
] as const;

export function getCloudCapabilities(): string[] {
  return [...CLOUD_CAPABILITIES];
}

export function getCloudCapabilitiesHeader(): string {
  return getCloudCapabilities().join(',');
}
