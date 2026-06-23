export type CloudPressureState = 'ok' | 'warning' | 'critical' | 'unknown';

export type CloudPressureHistoryStatus =
  | 'ok'
  | 'file_missing'
  | 'parse_error'
  | 'write_failed'
  | 'empty_file';

export type CloudPressureBasic = {
  state: CloudPressureState;
  oomRecent: boolean;
  recentRestart: boolean;
};

export type CloudPressureDetailed = CloudPressureBasic & {
  pressure_state: CloudPressureState;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  uptime_sec: number;
  openFdCount: number | null;
  recent_restart: boolean;
  oom_recent: boolean;
  pressure_window_ms: number;
  history_status: CloudPressureHistoryStatus;
  rss_budget_mb: number;
};

export type CloudBootRecord = {
  timestamp: number;
  uptime_sec: number;
  kind: 'self-update' | 'normal' | 'unknown';
};
