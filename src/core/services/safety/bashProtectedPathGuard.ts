/**
 * Bash Protected Path Guard
 *
 * Deterministic pre-spawn guard that blocks Bash commands referencing
 * MCP configuration or credential files. These files contain API keys,
 * OAuth tokens, and other secrets in plaintext. An unrestricted agent
 * can exfiltrate these credentials via Bash (cat, jq, curl --data-binary @,
 * shell variable expansion, etc.) and use them to make unauthorized
 * API calls.
 *
 * **Incident:** REBEL-559 — Agent read Mailchimp API key from MCP config
 * via Bash, then used curl to create ~15 unauthorized campaigns.
 *
 * **Design:** The guard checks whether any protected filename or path
 * segment appears in the raw command string (case-insensitive). This is
 * intentionally broad — a false positive (blocking a legitimate grep for
 * "super-mcp-router" in docs) is vastly preferable to a false negative
 * (allowing credential exfiltration). The guard runs inside
 * `runBashTool` before `spawn()`, making it the last line of defense
 * regardless of upstream safety evaluation, approval bypass, or trusted
 * tool classification.
 *
 * **Limitations:** String inspection cannot catch every obfuscation
 * (base64-encoded paths, variable indirection, symlink traversal).
 * This is an MVP containment — full process sandboxing is the long-term
 * solution.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'bash-protected-path-guard' });

export interface BashProtectedPathResult {
  blocked: boolean;
  /** Which protected pattern matched, for logging. */
  matchedPattern?: string;
  /** Human-readable reason for the block. */
  reason?: string;
}

export interface BashProtectedPathContext {
  // TODO(security): Use homePath to expand ~/… references before matching,
  // so `cat ~/Library/Application Support/mindstone-rebel/mcp/…` triggers
  // the dynamic userDataPath guard. Currently unused — follow-up to REBEL-559.
  homePath?: string;
  /** App's userData directory (e.g. ~/Library/Application Support/mindstone-rebel/). */
  userDataPath?: string;
}

/**
 * Protected filenames — if any of these appear in the command string
 * (case-insensitive), the command is blocked. These are the canonical
 * MCP config and credential filenames that store secrets.
 */
const PROTECTED_FILENAMES: readonly string[] = [
  'super-mcp-router.json',
  'mcp_servers.json',
  'mcp-servers.json',
];

/**
 * Protected path segments — if any of these directory/file patterns
 * appear in the command string (case-insensitive), the command is blocked.
 * Uses forward-slash normalization for cross-platform matching.
 */
const PROTECTED_PATH_SEGMENTS: readonly string[] = [
  // OAuth credential stores
  '.super-mcp/oauth-tokens',
  // MCP connector credential dirs (under userData/mcp/)
  'mcp/google-workspace-mcp',
  'mcp/microsoft-mcp',
  'mcp/hubspot',
  'mcp/salesforce',
  'mcp/zendesk',
  'mcp/slack/config.json',
  'mcp/slack/workspaces',
  // Bridge/inbox config with potential secrets
  'mcp/rebel-inbox-bridge.json',
  'mcp/rebel-app-bridge',
];

/**
 * Additional filename patterns that indicate credential files
 * within MCP connector directories.
 */
const CREDENTIAL_FILE_PATTERNS: readonly RegExp[] = [
  /\baccounts\.json\b/i,
  /\.token\.json\b/i,
  /\b_tokens\.json\b/i,
  /\b_client\.json\b/i,
];

/**
 * Normalize a command string for path matching: replace backslashes with
 * forward slashes (for Windows path compatibility) and lowercase.
 */
function normalizeForMatching(command: string): string {
  return command.replace(/\\/g, '/').toLowerCase();
}

/**
 * Check whether a Bash command references any protected MCP configuration
 * or credential paths. Returns a blocking result if a match is found.
 *
 * This is a deterministic, pre-spawn check — it runs before the shell
 * process is created and cannot be bypassed by approval or safety overrides.
 */
export function detectProtectedMcpConfigAccess(
  command: string,
  context?: BashProtectedPathContext,
): BashProtectedPathResult {
  const normalized = normalizeForMatching(command);

  // Check protected filenames
  for (const filename of PROTECTED_FILENAMES) {
    if (normalized.includes(filename.toLowerCase())) {
      const result: BashProtectedPathResult = {
        blocked: true,
        matchedPattern: filename,
        reason: `Command references protected MCP configuration file: ${filename}`,
      };
      log.warn(
        { matchedPattern: filename, commandLength: command.length },
        'Blocked Bash command — references protected MCP config file',
      );
      return result;
    }
  }

  // Check protected path segments
  for (const segment of PROTECTED_PATH_SEGMENTS) {
    if (normalized.includes(segment.toLowerCase())) {
      const result: BashProtectedPathResult = {
        blocked: true,
        matchedPattern: segment,
        reason: `Command references protected MCP credential path: ${segment}`,
      };
      log.warn(
        { matchedPattern: segment, commandLength: command.length },
        'Blocked Bash command — references protected MCP credential path',
      );
      return result;
    }
  }

  // Check credential file patterns (accounts.json, *.token.json, etc.)
  // Only block if the command also references an MCP-adjacent directory
  // to avoid false positives on unrelated files named accounts.json.
  if (normalized.includes('/mcp/')) {
    for (const pattern of CREDENTIAL_FILE_PATTERNS) {
      if (pattern.test(command)) {
        const result: BashProtectedPathResult = {
          blocked: true,
          matchedPattern: pattern.source,
          reason: 'Command references MCP credential file pattern',
        };
        log.warn(
          { matchedPattern: pattern.source, commandLength: command.length },
          'Blocked Bash command — references MCP credential file pattern',
        );
        return result;
      }
    }
  }

  // Check dynamic paths if context is provided
  if (context?.userDataPath) {
    const normalizedUserData = normalizeForMatching(context.userDataPath);
    const mcpDir = `${normalizedUserData}/mcp`;
    if (normalized.includes(mcpDir)) {
      // Command references the user's MCP config directory directly
      const result: BashProtectedPathResult = {
        blocked: true,
        matchedPattern: `<userDataPath>/mcp`,
        reason: 'Command references the MCP configuration directory',
      };
      log.warn(
        { commandLength: command.length },
        'Blocked Bash command — references MCP config directory via absolute path',
      );
      return result;
    }
  }

  return { blocked: false };
}
