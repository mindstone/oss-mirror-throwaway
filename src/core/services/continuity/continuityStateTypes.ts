export type CloudRemovalRequestedBy = 'user' | 'retention-policy';

export type CloudRemovalSource = 'desktop' | 'mobile' | 'web' | 'cloud';

export interface CloudRemovalIntent {
  requestedAt: number;
  requestedBy: CloudRemovalRequestedBy;
  source?: CloudRemovalSource;
}

export type ContinuityState = {
  state: 'local_only' | 'cloud_active';
  lastCloudActivityAt?: number;
  cloudPinnedAt?: number;
  cloudRemovalIntent?: CloudRemovalIntent;
};

export interface ContinuityStateMap {
  [sessionId: string]: ContinuityState;
}
