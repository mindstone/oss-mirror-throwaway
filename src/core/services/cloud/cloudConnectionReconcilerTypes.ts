export type ReconcilerWriter =
  | 'startup-health'
  | 'managed-status'
  | 'router-success'
  | 'repair'
  | 'manual-refresh'
  | 'auto-refresh'
  | 'post-drain'
  | 'reconnect'
  | 'focus'
  | 'hourly-tick';
