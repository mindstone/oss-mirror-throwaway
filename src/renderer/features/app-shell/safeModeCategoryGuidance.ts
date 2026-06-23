import type { SafeModeErrorCategory } from '@shared/types';

export const SAFE_MODE_CATEGORY_GUIDANCE: Record<SafeModeErrorCategory, string> = {
  timeout: 'Tools took too long to start. Safe Mode keeps the app usable while you check Settings → Advanced.',
  port_conflict: 'Another app may be using a connection Rebel needs. Close apps you no longer need, then restart Super-MCP in Settings → Advanced.',
  config_parse: 'A tools configuration file could not be read. Safe Mode keeps the app usable while you check Settings → Advanced.',
  permission: 'Rebel may not have permission to access something its tools need. Check system privacy or security settings, then use Settings → Advanced.',
  network: 'Something may be blocking Rebel from connecting to its local tools runtime. Check firewall, VPN, or security settings, then restart Super-MCP in Settings → Advanced.',
  process_crash: 'Rebel\'s tools runtime stopped unexpectedly. Restart Super-MCP in Settings → Advanced.',
  missing_bundle: 'Part of Rebel\'s bundled tools runtime is missing. Reinstalling or updating Rebel usually fixes this. Safe Mode keeps the app usable while you check Settings → Advanced.',
  spawn_missing_executable: 'Security software may be blocking Rebel\'s tools runtime. Reinstall Rebel or check antivirus/quarantine settings. Safe Mode keeps the app usable while you check Settings → Advanced.',
  fs_exhaustion: 'Your system has too many files open. Close other apps or restart your machine, then try Rebel\'s tools again.',
  health_timeout: 'Tools are taking too long to start. You can restart the connection in Settings → Advanced.',
  unknown: 'The exact cause is not clear yet. Safe Mode keeps the app usable while you check Settings → Advanced.',
};

export const SAFE_MODE_CATEGORY_PROMPT_GUIDANCE: Record<SafeModeErrorCategory, string> = {
  timeout: `Diagnostic hypotheses:
- Slow startup after an update
- Resource pressure during app launch
- Security software scanning the tools runtime
- A startup process stuck before it reports ready`,
  port_conflict: `Diagnostic hypotheses:
- Another app is using the local tools port
- A stale Rebel tools process survived a previous crash
- Orphan cleanup missed a process
- Development tools with similar port requirements`,
  config_parse: `Diagnostic hypotheses:
- Malformed tools configuration
- Partial config write during a crash
- Locked config file
- Sync or backup software interrupting the read`,
  permission: `Diagnostic hypotheses:
- File permission changes
- Security or privacy prompts blocking access
- Quarantined runtime files
- A directory Rebel can no longer access`,
  network: `Diagnostic hypotheses:
- Local firewall rules blocking localhost
- VPN or proxy policy intercepting local traffic
- Security software blocking Rebel's local tools connection
- Loopback networking restrictions`,
  process_crash: `Diagnostic hypotheses:
- A zombie Node process from a previous crash
- File locks from a previous crash
- Antivirus or quarantine scanning the bundled runtime
- A runtime crash during startup`,
  missing_bundle: `Diagnostic hypotheses:
- Incomplete app update or install
- Deleted bundled runtime files
- Quarantined runtime files
- Stale install directory`,
  spawn_missing_executable: `Diagnostic hypotheses:
- Bundled runtime executable missing
- App update or install did not finish cleanly
- Security software quarantined a bundled executable
- Permissions blocking process launch`,
  fs_exhaustion: `Diagnostic hypotheses:
- Too many files open system-wide
- Leaked file handles after a previous crash
- Sync or indexing tools holding handles
- Another process exhausting descriptors`,
  health_timeout: `Diagnostic hypotheses:
- The tools process started but did not become ready
- Security software delayed startup
- A zombie process is blocking readiness
- Local networking is slow`,
  unknown: `Diagnostic hypotheses:
- File locks from a previous crash
- Antivirus or security scanning
- A zombie Node process
- Local port conflicts, config read failures, or resource exhaustion`,
};

export function getSafeModeCategoryGuidance(errorCategory?: SafeModeErrorCategory): string {
  if (!errorCategory) {
    return SAFE_MODE_CATEGORY_GUIDANCE.unknown;
  }
  return SAFE_MODE_CATEGORY_GUIDANCE[errorCategory];
}

export function getSafeModeCategoryPromptGuidance(errorCategory?: SafeModeErrorCategory): string {
  if (!errorCategory) {
    return SAFE_MODE_CATEGORY_PROMPT_GUIDANCE.unknown;
  }
  return SAFE_MODE_CATEGORY_PROMPT_GUIDANCE[errorCategory];
}
